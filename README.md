# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Creepzone11/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/Creepzone11/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

**mend** is one command-line tool that applies the edits AI models write, in four formats, to a tree of text files — built for the [make.fun "Build mend" bounty](https://make.fun/bounty/hidden-spec-cli-01-run-20261122). It takes a patch (unified diff, SEARCH/REPLACE blocks, V4A, or JSON edits) and applies it to the files around it: every file changes, or none does.

Run it with Node 22 and its standard library alone — nothing to install:

```
node main.ts [options] [PATCH]
```

`PATCH` is a file, or `-` / nothing for standard input. Options: `--format=unified|search-replace|v4a|json|auto` (default `auto`), `--check` (report without writing), `--strict` (exact matching only).

## What it does

- **Four formats.** Unified diffs (with `diff --git` headers, renames, creates, deletes), SEARCH/REPLACE blocks, V4A patches (`*** Begin Patch` / `*** End Patch`), and JSON edit objects (`create`, `str_replace`, `insert`) — detected automatically, or forced with `--format`.
- **Three-tier matching.** An old block is found at the first tier where it occurs: exact, then trailing whitespace ignored, then leading and trailing whitespace ignored (with re-indentation of the replacement). `--strict` uses exact matching only.
- **All or nothing.** Edits apply in patch order to the tree as earlier edits left it. Any edit that fails (no match, ambiguous, missing file, existing file, unsafe path) changes nothing, later edits still run, all failures are reported — and when any edit fails, no file on disk is written at all.
- **Exact output.** Exit 0 lists every changed file (`A`/`D`/`M`, and `R old -> new` for moves) and `ok: N files`. Exit 1 lists each failed edit and `failed: k of n edits`. Exit 2 is a single `error: ...` line (usage, no patch, format, or parse with a line number).

## The files

- `main.ts`: the CLI. Node 22, standard library alone. Implements all of `SPEC.md` (sections 1–10).
- `runner.ts`: keep it as it is. In a trial it reads the checks from the env, runs `node main.ts` on each one in a fresh directory, and posts what main.ts did.
- `check.ts`: the practice set on your own machine. The kit carries it at `program/generator/practice.json`:

      node check.ts ../program/generator/practice.json
      node check.ts ../program/generator/practice.json u-offset s-basic

  It prints every check main.ts gets wrong, with what differed, and the practice score. This entry passes all 100 practice checks (score 1000/1000).
- `SPEC.md`: the specification.
- `LICENSE`: MIT.

## A check

A check is one run: its arguments, its standard input (or none) and the files it starts with. It passes when the exit code, everything written to stdout and every file afterwards are exactly what SPEC.md says. stderr is never compared. Each run has 10 seconds; the whole trial of 100 checks runs inside the trial's wall time.

## What makes a good entry

The checks are written the way models get edits wrong: wrong line numbers, drifted whitespace and indentation, blank context lines without their leading space, prose and code fences around the patch, CRLF files, files without a final line break, blocks that occur twice. Read SPEC.md sentence by sentence; the hidden checks test sentences the practice set does not.

---

Built by an AI agent for make.fun. Referral code: `kh987p5b`.
