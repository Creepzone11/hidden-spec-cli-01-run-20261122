// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** (old, new) pairs from move edits that succeeded, for the R output lines (SPEC section 2). */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

/** A file's lines, its line break, and whether it ends with one (SPEC section 3). */
function splitFile(text: string): { lines: string[]; br: string; final: boolean } {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function leadingWS(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function stripBoth(s: string): string {
  return s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

type Tier = 0 | 1 | 2;

function normAt(tier: Tier): (s: string) => string {
  return tier === 0 ? (s) => s : tier === 1 ? stripTrail : stripBoth;
}

/** Positions where O occurs in file at one tier (SPEC section 5). */
function occurrences(file: string[], O: string[], tier: Tier): number[] {
  const norm = normAt(tier);
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = 0; i + O.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (norm(O[j]!) !== norm(file[i + j]!)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** First tier at which O occurs at least once, with its occurrences. */
function findTier(file: string[], O: string[], strict: boolean): { tier: Tier; occ: number[] } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(file, O, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** First tier at which O occurs at or after `from`, with its first such occurrence. */
function findTierFrom(file: string[], O: string[], strict: boolean, from: number): { tier: Tier; pos: number } | null {
  const tiers: Tier[] = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(file, O, t);
    for (const p of occ) {
      if (p >= from) return { tier: t, pos: p };
    }
  }
  return null;
}

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

/** O (context + old) and N (context + new) of a hunk/chunk body, in order (`\` lines ignored). */
function bodyON(body: BodyLine[]): { O: string[]; N: string[] } {
  const O: string[] = [];
  const N: string[] = [];
  for (const bl of body) {
    if (bl.kind === ' ') {
      O.push(bl.text);
      N.push(bl.text);
    } else if (bl.kind === '-') O.push(bl.text);
    else if (bl.kind === '+') N.push(bl.text);
  }
  return { O, N };
}

/**
 * Replace file[at .. at+O.length) with the body's N lines (SPEC section 5): a context line is written as the
 * file's own matched line; at tier 2 every other N line is re-indented (P of O's first line replaced by F of the
 * file's first matched line); at tiers 0 and 1 N is written as it is.
 */
function applyBody(file: string[], at: number, O: string[], body: BodyLine[], tier: Tier): string[] {
  const F = leadingWS(file[at] ?? '');
  const P = leadingWS(O[0] ?? '');
  const out: string[] = [];
  let oi = 0;
  for (const bl of body) {
    if (bl.kind === ' ') {
      out.push(file[at + oi]!);
      oi++;
    } else if (bl.kind === '-') {
      oi++;
    } else if (bl.kind === '+') {
      let t = bl.text;
      if (tier === 2 && t !== '' && t.trim() !== '' && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
    // '\' lines are markers only; they add no line.
  }
  return [...file.slice(0, at), ...out, ...file.slice(at + O.length)];
}

/** One SEARCH/REPLACE block (SPEC section 7). */
function srEdit(path: string, old: string[], nw: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (old.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, nw.length === 0 ? '' : nw.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new Fail('missing', path);
    const f = splitFile(cur);
    const found = findTier(f.lines, old, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const body: BodyLine[] = [
      ...old.map((t) => ({ kind: '-' as const, text: t })),
      ...nw.map((t) => ({ kind: '+' as const, text: t })),
    ];
    tree.now.set(path, joinFile(applyBody(f.lines, found.occ[0]!, old, body, found.tier), f.br, f.final));
  };
}

function srEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  for (;;) {
    let s = -1;
    for (let j = prevEnd; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    let eq = -1;
    let rep = -1;
    for (let j = s + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '<<<<<<< SEARCH') break;
      if (eq < 0 && t === '=======') {
        eq = j;
        continue;
      }
      if (eq >= 0 && t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep), strict));
    prevPath = path;
    prevEnd = rep + 1;
  }
  return edits;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

interface Hunk {
  A: number;
  body: BodyLine[];
  noeol: boolean;
}

interface Section {
  hasPair: boolean;
  pairOld: string | null;
  pairNew: string | null;
  renameOld: string | null;
  renameNew: string | null;
  gitOld: string | null;
  gitNew: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

function parseDiffGit(line: string): [string, string] | null {
  if (!line.startsWith('diff --git a/')) return null;
  const rest = line.slice('diff --git a/'.length);
  const idx = rest.indexOf(' b/');
  if (idx <= 0) return null;
  const x = rest.slice(0, idx);
  const y = rest.slice(idx + 3);
  if (x === '' || y === '') return null;
  return [x, y];
}

function parseHunkHeader(line: string): number | null {
  const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  return m ? Number(m[1]) : null;
}

/** Path after `--- `/`+++ `: up to the first tab, surrounding spaces removed, leading a/ or b/ removed. */
function diffPath(raw: string): string | null {
  const p0 = raw.split('\t')[0]!.trim();
  if (p0 === '/dev/null') return null;
  if (p0.startsWith('a/') || p0.startsWith('b/')) return p0.slice(2);
  return p0;
}

function sectionPaths(sec: Section): { oldPath: string | null; newPath: string | null } {
  if (sec.hasPair) return { oldPath: sec.pairOld, newPath: sec.pairNew };
  if (sec.renameOld !== null || sec.renameNew !== null) return { oldPath: sec.renameOld, newPath: sec.renameNew };
  return { oldPath: sec.gitOld, newPath: sec.gitNew };
}

function parseUnified(lines: string[]): Section[] {
  const sections: Section[] = [];
  const newSection = (): Section => ({
    hasPair: false,
    pairOld: null,
    pairNew: null,
    renameOld: null,
    renameNew: null,
    gitOld: null,
    gitNew: null,
    isCreate: false,
    isDelete: false,
    hunks: [],
  });
  let cur: Section | null = null;
  let state: 'outside' | 'header' | 'body' | 'after' = 'outside';
  let curHunk: Hunk | null = null;
  let body: BodyLine[] = [];

  const finishHunk = (): void => {
    if (curHunk === null) return;
    while (body.length > 0) {
      const last = body[body.length - 1]!;
      if (last.kind === ' ' && last.text === '') body.pop();
      else break;
    }
    let noeol = false;
    for (let k = body.length - 1; k >= 0; k--) {
      const bl = body[k]!;
      if (bl.kind === ' ' || bl.kind === '+') {
        if (k + 1 < body.length && body[k + 1]!.kind === '\\') noeol = true;
        break;
      }
    }
    curHunk.noeol = noeol;
    curHunk.body = body;
    body = [];
    curHunk = null;
  };

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const dg = parseDiffGit(line);
      if (dg === null) throw new Exit2(`error: parse ${i + 1}`);
      finishHunk();
      cur = newSection();
      cur.gitOld = dg[0];
      cur.gitNew = dg[1];
      sections.push(cur);
      state = 'header';
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      finishHunk();
      if (state === 'header' && cur !== null && !cur.hasPair) {
        cur.hasPair = true;
        cur.pairOld = diffPath(line.slice(4));
        cur.pairNew = diffPath(lines[i + 1]!.slice(4));
      } else {
        cur = newSection();
        cur.hasPair = true;
        cur.pairOld = diffPath(line.slice(4));
        cur.pairNew = diffPath(lines[i + 1]!.slice(4));
        sections.push(cur);
        state = 'header';
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (state === 'header') throw new Exit2(`error: parse ${i + 2}`);
      if (state === 'body') {
        body.push({ kind: '-', text: line.slice(1) });
        i++;
        continue;
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const A = parseHunkHeader(line);
      if (A === null) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      finishHunk();
      curHunk = { A, body: [], noeol: false };
      cur.hunks.push(curHunk);
      state = 'body';
      i++;
      continue;
    }
    if (state === 'body') {
      if (line === '' || line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\')) {
        if (line === '') body.push({ kind: ' ', text: '' });
        else if (line.startsWith(' ')) body.push({ kind: ' ', text: line.slice(1) });
        else if (line.startsWith('-')) body.push({ kind: '-', text: line.slice(1) });
        else if (line.startsWith('+')) body.push({ kind: '+', text: line.slice(1) });
        else body.push({ kind: '\\', text: line.slice(1) });
        i++;
        continue;
      }
      finishHunk();
      state = 'after';
      i++;
      continue;
    }
    if (state === 'header' && cur !== null) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line === 'new file mode' || line.startsWith('new file mode ')) cur.isCreate = true;
      else if (line === 'deleted file mode' || line.startsWith('deleted file mode ')) cur.isDelete = true;
      i++;
      continue;
    }
    i++;
  }
  finishHunk();
  return sections;
}

/** Apply a section's hunks in order to a file's text (SPEC section 6). */
function applyHunks(text: string, hunks: Hunk[], strict: boolean, path: string): string {
  const f = splitFile(text);
  let lines = f.lines;
  let final = f.final;
  let d = 0;
  for (const h of hunks) {
    const { O, N } = bodyON(h.body);
    if (O.length === 0) {
      const oldLen = lines.length;
      const pos = Math.min(h.A + d, oldLen);
      lines = [...lines.slice(0, pos), ...N, ...lines.slice(pos)];
      if (pos === oldLen) final = !h.noeol;
      d += N.length;
    } else {
      const found = findTier(lines, O, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.A - 1 + d;
      let best = found.occ[0]!;
      let bestDist = Math.abs(best - target);
      for (const o of found.occ) {
        const dist = Math.abs(o - target);
        if (dist < bestDist) {
          best = o;
          bestDist = dist;
        }
      }
      const at = best;
      const runsToEnd = at + O.length === lines.length;
      lines = applyBody(lines, at, O, h.body, found.tier);
      if (runsToEnd) final = !h.noeol;
      d += N.length - O.length;
    }
  }
  return joinFile(lines, f.br, final);
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const { oldPath, newPath } = sectionPaths(sec);
  let kind: 'create' | 'delete' | 'move' | 'change';
  if (oldPath === null || sec.isCreate) kind = 'create';
  else if (newPath === null || sec.isDelete) kind = 'delete';
  else if (oldPath !== newPath) kind = 'move';
  else kind = 'change';
  return (tree) => {
    if (kind === 'create') {
      const p = newPath ?? '';
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let noeol = false;
      for (const h of sec.hunks) {
        for (let k = 0; k < h.body.length; k++) {
          const bl = h.body[k]!;
          if (bl.kind === '+') {
            plus.push(bl.text);
            noeol = k + 1 < h.body.length && h.body[k + 1]!.kind === '\\';
          }
        }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (noeol ? '' : '\n'));
      return;
    }
    if (kind === 'delete') {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (kind === 'move') {
      const op = oldPath!;
      const np = newPath!;
      if (!safe(op)) throw new Fail('unsafe', op);
      if (!safe(np)) throw new Fail('unsafe', np);
      const cur = tree.get(op);
      if (cur === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const result = applyHunks(cur, sec.hunks, strict, op);
      tree.now.set(np, result);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
      return;
    }
    const p = oldPath!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new Fail('missing', p);
    tree.now.set(p, applyHunks(cur, sec.hunks, strict, p));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => unifiedEdit(sec, strict));
}

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  type: 'add' | 'delete' | 'update';
  path: string;
  headerLine: number;
  addLines: string[];
  moveTo: string | null;
  chunks: VChunk[];
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const sections: VSection[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let type: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      type = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      type = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      type = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else throw new Exit2(`error: parse ${i + 1}`);
    const headerLine = i + 1;
    i++;
    const body: Array<{ idx: number; text: string }> = [];
    while (i < last) {
      const l2 = lines[i]!;
      if (l2.startsWith('*** Add File: ') || l2.startsWith('*** Delete File: ') || l2.startsWith('*** Update File: ')) break;
      body.push({ idx: i, text: l2 });
      i++;
    }
    while (body.length > 0 && blank(body[0]!.text)) body.shift();
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    const sec: VSection = { type, path, headerLine, addLines: [], moveTo: null, chunks: [] };
    if (type === 'add') {
      for (const { idx, text } of body) {
        if (text === '') sec.addLines.push('');
        else if (text.startsWith('+')) sec.addLines.push(text.slice(1));
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
    } else if (type === 'delete') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.idx + 1}`);
    } else {
      let j = 0;
      if (j < body.length && body[j]!.text.startsWith('*** Move to: ')) {
        sec.moveTo = body[j]!.text.slice('*** Move to: '.length).trim();
        j++;
        while (j < body.length && blank(body[j]!.text)) j++;
      }
      let cur: VChunk | null = null;
      let firstChunk = true;
      for (; j < body.length; j++) {
        const { idx, text } = body[j]!;
        if (text.startsWith('@@')) {
          if (cur !== null) sec.chunks.push(cur);
          const anchor = text.slice(2).trim();
          cur = { anchor: anchor === '' ? null : anchor, eof: false, body: [] };
          firstChunk = false;
        } else if (text === '*** End of File') {
          if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
          cur.eof = true;
          sec.chunks.push(cur);
          cur = null;
          firstChunk = false;
        } else if (text === '' || text.startsWith(' ') || text.startsWith('-') || text.startsWith('+')) {
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${idx + 1}`);
            cur = { anchor: null, eof: false, body: [] };
            firstChunk = false;
          }
          if (text === '') cur.body.push({ kind: ' ', text: '' });
          else if (text.startsWith(' ')) cur.body.push({ kind: ' ', text: text.slice(1) });
          else if (text.startsWith('-')) cur.body.push({ kind: '-', text: text.slice(1) });
          else cur.body.push({ kind: '+', text: text.slice(1) });
        } else throw new Exit2(`error: parse ${idx + 1}`);
      }
      if (cur !== null) sec.chunks.push(cur);
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${headerLine}`);
    }
    sections.push(sec);
  }
  return sections.map((sec) => v4aEdit(sec, strict));
}

function v4aEdit(sec: VSection, strict: boolean): Edit {
  return (tree) => {
    if (sec.type === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.addLines.length === 0 ? '' : sec.addLines.join('\n') + '\n');
      return;
    }
    if (sec.type === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const cur = tree.get(sec.path);
    if (cur === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const f = splitFile(cur);
    let lines = f.lines;
    let cursor = 0;
    for (const ch of sec.chunks) {
      if (ch.anchor !== null) {
        const found = findTierFrom(lines, [ch.anchor], strict, cursor);
        if (found === null) throw new Fail('no-match', sec.path);
        cursor = found.pos + 1;
      }
      const { O, N } = bodyON(ch.body);
      if (O.length === 0) {
        const pos = ch.eof ? lines.length : cursor;
        lines = [...lines.slice(0, pos), ...N, ...lines.slice(pos)];
        cursor = pos + N.length;
      } else {
        const found = findTierFrom(lines, O, strict, cursor);
        if (found === null) throw new Fail('no-match', sec.path);
        let at: number;
        if (ch.eof) {
          const endPos = lines.length - O.length;
          if (endPos < cursor) throw new Fail('no-match', sec.path);
          if (!occurrences(lines, O, found.tier).includes(endPos)) throw new Fail('no-match', sec.path);
          at = endPos;
        } else {
          at = found.pos;
        }
        lines = applyBody(lines, at, O, ch.body, found.tier);
        cursor = at + N.length;
      }
    }
    const result = joinFile(lines, f.br, f.final);
    if (sec.moveTo !== null) {
      tree.now.set(sec.moveTo, result);
      tree.now.set(sec.path, null);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, result);
    }
  };
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? srEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const rows: Array<{ key: string; text: string }> = [];
  const movedOld = new Set<string>();
  const movedNew = new Map<string, string>();
  for (const [op, np] of tree.moves) {
    if (tree.original(op) !== null && tree.get(op) === null && tree.original(np) === null && tree.get(np) !== null) {
      movedOld.add(op);
      movedNew.set(np, op);
      rows.push({ key: np, text: `R ${op} -> ${np}` });
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
