# Wave 3 Implementation Report — `@heretek-ai/es-cli`

- **Stage ID:** Wave 3 (`es` CLI + `.worktreeinclude` Sync)
- **Branch:** `wave-3-es-cli`
- **Worktree:** `/home/john/Projects/Heretek-AI-Rebuild/epistemic-factory/worktrees/wave-3`
- **Date:** 2026-10-16

## Summary of deliverables

Implemented `packages/cli` exactly per SPEC §2.3 plus the Wave 3 plan, with
zero stubs and fail-closed behavior throughout. Waves 1–2 were imported
from, never reimplemented or modified (`packages/epistemic-verifier-mcp/src`
and `packages/core/src` untouched).

1. **`src/worktree-include.ts`** (pre-existing partial work — audited, kept
   as-is: it already satisfied the contract): parses `.worktreeinclude`
   (gitignore-style patterns), copies matching untracked files from a base
   repo into an isolated worktree without git staging. Exports
   `parseWorktreeInclude` (drops blanks + `#` comments, trims),
   `matchWorktreePattern` (exact names, `*.ext` basename globs,
   `dir/*.ext` one-level globs, `prefix*`/`*suffix`, `**` contains
   semantics — all documented in the module header),
   `collectWorktreeIncludes` (`[]` when absent, throws on unreadable),
   `syncWorktreeIncludes` (pure `node:fs` recursion, no glob lib; `mkdir -p`
   preserving relative paths; never runs `git add`; skips symlinks and
   `.git`; fail closed on `..` traversal in patterns, paths, and resolved
   destinations). Audit found no defects — no changes were needed.
2. **`src/bin.ts`** — `es` CLI, `#!/usr/bin/env bun`, `process.argv`
   parsing with node builtins only. Exported async command functions
   `cmdKeySeal` (`sealHumanKey`, prints `{ publicKeyHex, fingerprint }`),
   `cmdInit` (scaffolds `.worktreeinclude` defaults `.env` / `.env.local` /
   `certs/*.pem`, `.factory/` + `approvals/`, `frontier.json` skeleton
   validated structurally via core `saveFrontier`; refuses overwrite without
   `--force`), `cmdStatus` (frontier presence + rounds/decisions count +
   delta set/empty, approvals present, STOP presence; exit 0
   informational), `cmdApprove` (`signStageApproval` for
   `GRILL|SPEC|WAIVER|TRUST`, 64-hex `--subject` enforced, record persisted
   to `.factory/approvals/<STAGE>-<runId>.json` and printed),
   `cmdAuditResearch` (`auditResearchMarkdown`, prints
   `passed/verifiedCount/failures`, exit 1 when pruned),
   `cmdGateMutation` (`runMutationGate`, prints
   `score/killed/survived/passed`, exit 1 on fail) plus `main(argv):
   Promise<number>` (`--help`/`-h`/`help`/bare → usage + 0; unknown command
   → usage on stderr + 1; any thrown error → stderr + 1) and an
   `import.meta.main` guard. Passphrase from `--passphrase` or
   `ES_PASSPHRASE`, never disk.
3. **`src/index.ts`** — re-exports the command functions, `parseArgs`,
   CLI constants, and the whole `worktree-include` module; importing it
   never executes `main`.
4. **Tests** `test/cli.test.ts` (`bun:test`, 18 tests, 57 expects, zero
   stubs): parse (comments/blanks), match (exact, `*.ext`, `dir/*.pem`
   one-level exclusion, `prefix*`/`*suffix`, `**`, traversal rejection),
   sync round-trip in real `/tmp` dirs (copies `.env` + `certs/*.pem`,
   preserves rel paths, skips nested one-level misses, reports `missing`,
   creates no `.git`), `main()` exit codes (help/empty = 0, unknown/key-bad
   = 1, init + double-init refusal + status = 0/1/0, key seal → approve
   round-trip via real core signer incl. bad-stage/bad-subject refusals,
   audit pass = 0 / fail = 1 via real sealed cache, gate `false` = 0 /
   `true` = 1 with byte-identical file restore).
5. **Acceptance** `scripts/accept/wave-3.sh` (executable): `bun test
   packages/cli` + package & root `tsc --noEmit` + live CLI smoke through
   the real entrypoint (`--help`, unknown→1, `init`/`status`, double-init
   refusal, `key seal` + `approve` with record on disk, `audit-research`
   pass/fail on a real sealed cache, `gate-mutation` pass/fail on a trivial
   target). Exit 0 only if all pass.
6. **Docs/config:** root `README.md` (install, full `es` command reference
   with examples, GRILL→PR pipeline, security invariants, worktree flow),
   `packages/cli/README.md` (layout + command pointer),
   `packages/cli/package.json` and `packages/cli/tsconfig.json` verified
   already correct (`@heretek-ai/es-cli`, `bin: { es: ./src/bin.ts }`,
   workspace deps on core + verifier-mcp, `src`+`test` includes) — no
   changes needed. Forbidden `packages/fleet` / `packages/web` not built.

## Files created / modified

Created:

- `packages/cli/src/bin.ts`
- `packages/cli/src/index.ts`
- `packages/cli/test/cli.test.ts`
- `scripts/accept/wave-3.sh`
- `README.md`
- `docs/reports/wave-3.md` (this file)

Audited, kept unchanged:

- `packages/cli/src/worktree-include.ts` (pre-existing partial work —
  verified complete against §2.3, no defects found)

Modified:

- `packages/cli/README.md` (was Wave-0 scaffolding stub, now documents
  layout + commands)

Verified untouched:

- `packages/cli/package.json`, `packages/cli/tsconfig.json` (already per
  spec — no edits)
- `packages/epistemic-verifier-mcp/src`, `packages/core/src` (import-only)

## Test results

- `bun test packages/cli`: **18 pass, 0 fail** (57 expects)
- `bun test` (whole worktree): **123 pass, 0 fail** (639 expects, 7 files)
- `bun run check` (`bun test` + `tsc --noEmit` + `biome check .`): **exit 0**
- `bash scripts/accept/wave-1.sh && wave-2.sh && wave-3.sh`: **all PASSED**
- Stub scan (`TODO\b|placeholder|not implemented|mock implementation` over
  new src+test+script, excluding the intentional scaffold `TODO` strings in
  the init skeleton): clean

## Self-audit notes / security invariants verified

- `worktree-include` never stages in git, never follows symlinks, never
  syncs `.git`, and refuses `..` traversal at pattern, rel-path, and
  resolved-destination layers (tested).
- `es init` validates its frontier skeleton through core `saveFrontier`
  before writing — a scaffold that cannot validate is never written.
- Approvals bind `{ runId, stage, subjectHash, timestamp }` via core Ed25519
  signing; `--subject` must be 64-hex, `--stage` from the closed set, and
  signing needs the human passphrase (agents can request, never self-sign).
- Audit/gate failures are evidence-on-stdout + exit 1, never silent; every
  invalid input is a descriptive stderr error + exit 1 (fail closed).
- `runMutationGate` restores targets in `finally`; the test asserts
  byte-identical restore after full gate runs.
