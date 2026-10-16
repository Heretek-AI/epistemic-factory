# Changelog

## Unreleased

- `es advance` / `es run`: a persisted factory runner (`.factory/run.json`)
  that computes every gate's evidence from disk instead of accepting it.
- The state machine now checks `frontierHash` / `specHash` against the
  frontier and spec content it is given.
- `runGateCommand` fails closed when a requested `bwrap` sandbox is missing,
  unless `allowUnsandboxed: true` is passed.
- A clean clone passes `make check` without a build step.

## 3.0.0

**Ground-up rewrite; breaking.** `@heretek-ai/es-core` and
`@heretek-ai/es-cli` versions up to 2.5.0 on npm were published from an
older, unrelated codebase. 3.0.0 shares only the package names: the API,
CLI commands, and on-disk formats are new and incompatible with 2.x, and
there is no migration path. Pin `^2` if you depend on the old packages.

- `@heretek-ai/epistemic-verifier-mcp`: NFKC verbatim quote verifier,
  HMAC-sealed content-addressed source cache, research auditor, MCP stdio
  server.
- `@heretek-ai/es-core`: Ed25519 human approvals, append-only frontier,
  gated-build state machine, RED-first test lock, mutation gate, gate
  engine.
- `@heretek-ai/es-cli`: the `es` CLI and `.worktreeinclude` syncer.
