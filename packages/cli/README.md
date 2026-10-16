# `@heretek-ai/es-cli`

> **3.0.0 is a ground-up rewrite** with a breaking API. Versions up to 2.5.0
> of this package came from an older, unrelated codebase and are not
> compatible; pin `^2` if you depend on them.

The Gated Build Factory CLI (`es`): human key sealing, project scaffolding,
status, signed stage approvals, research audit, mutation gate, and the
`.worktreeinclude` secret syncer.

## Layout

- `src/bin.ts` — `es` subcommands (`main(argv): Promise<number>`, exit 0 on
  success / 1 on gate failure or invalid input). Executable via `bun`
  (`#!/usr/bin/env bun`): `bun ./src/bin.ts …`.
- `src/worktree-include.ts` — parses `.worktreeinclude` (gitignore-style
  patterns like `.env`, `.env.local`, `certs/*.pem`) and copies matching
  untracked files from a base repo into an isolated worktree without git
  staging them. Fail closed on path traversal.
- `src/index.ts` — re-exports the command functions and the syncer (importing
  it never runs the CLI).
- `test/cli.test.ts` — `bun:test` suite (real temp dirs, real core/verifier).
- `test/runner.test.ts` — `es advance` / `es run` end to end against a real
  temp project (real key, approvals, sealed cache, and test command).

## Commands

See the root `README.md` for the full `es` command reference with examples.
