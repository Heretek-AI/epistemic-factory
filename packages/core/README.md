# `@heretek-ai/es-core`

Gated Build Factory state machine (Wave 2): Ed25519 human approvals, the
append-only design-decision frontier, the deterministic `GRILL -> RESEARCH ->
SPEC -> BUILD_TDD_RED -> BUILD_TDD_GREEN -> GATE_MUTATION -> QA_DUAL_EVAL ->
DONE` line (plus `HALTED`), the RED-first test-tree lock, the 85% syntactic
mutation gate, and the sandboxed (`bwrap`) gate runner with command-trust
hashing and secret scanning.

## Layout

- `src/approval/ed25519.ts` — `sealHumanKey` (`scrypt` + `aes-256-gcm`,
  `human.key.enc` at `0o600`), `signStageApproval`,
  `verifyStageApproval` (fail-closed `boolean`).
- `src/factory/frontier.ts` — `saveFrontier` (refuses empty
  `deltaFromHead`, decision deletion, round regression), `loadFrontier`,
  `frontierHash`.
- `src/factory/machine.ts` — `canTransition` (pure), `transition`
  (throwing), `RedFirstViolationError`, `assertModelDiversity`
  (`TestTamperingError` re-exported from `gates/test-lock.ts`).
- `src/gates/test-lock.ts` — `lockTestManifest`,
  `verifyTestManifestUnchanged`, `assertTestManifestUnchanged`.
- `src/gates/mutation.ts` — `generateSourceMutants`,
  `runMutationGate` (`MUTATION_THRESHOLD = 0.85`).
- `src/gates/engine.ts` — `sha256Hex`, `commandSetHash`,
  `assertTrustedCommand`, `scanForSecrets`, `runGateCommand`.
- `src/index.ts` — public re-exports.

## Runner contract (how the CLI drives the machine)

1. After the RED run fails, call `lockTestManifest(testDir)` and carry the
   manifest in `ctx.testManifest`.
2. Before leaving GREEN, call `verifyTestManifestUnchanged(testDir,
   manifest)` and pass the diff as `ctx.testManifestCheck` — without it the
   machine refuses to advance; with tampering evidence it throws
   `TestTamperingError`.
3. Gate commands passed to `runGateCommand` should be trust-checked via
   `assertTrustedCommand` (or `trustedHashes`), and their output screened
   with `scanForSecrets` — the scanner reports, the caller decides.
4. `runGateCommand({ useBwrap: true })` fails closed with
   `SandboxUnavailableError` when `bwrap` is missing; only an explicit
   `allowUnsandboxed: true` downgrades to direct execution (recorded as a
   warning in `stderr`).
