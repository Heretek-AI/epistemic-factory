# Wave 2 Implementation Report — `@heretek-ai/es-core`

- **Stage ID:** Wave 2 (State Machine, Ed25519 Approvals, Red/Green & Mutation Gates)
- **Branch:** `wave-2-factory-core`
- **Worktree:** `/home/john/Projects/Heretek-AI-Rebuild/epistemic-factory/worktrees/wave-2`
- **Date:** 2026-10-15

## Summary of deliverables

Implemented `packages/core` exactly per SPEC §2.2, with zero stubs and
fail-closed behavior throughout. Wave 1 code was imported from, never
reimplemented or modified.

1. **`src/approval/ed25519.ts`** — `node:crypto` throughout
   (`generateKeyPairSync("ed25519")`, `scryptSync`, `createCipheriv`
   `"aes-256-gcm"`, `sign`, `verify`). `sealHumanKey` seals the PKCS#8
   private key under the passphrase (`scrypt` N=16384/r=8/p=1 + random
   salt/iv, auth-tagged envelope JSON) and writes `human.key.enc` (mode
   `0o600`, enforced by `chmod` even over a pre-existing file) plus
   `human.pub` (`{ publicKeyHex, fingerprint }`). `signStageApproval`
   signs canonical (recursively key-sorted) JSON of `{ runId, stage,
   subjectHash, timestamp }` over stages `GRILL | SPEC | WAIVER | TRUST`.
   `verifyStageApproval` returns `false` — never throws — on any mismatch:
   wrong stage, wrong subject hash, record identity not bound to
   `human.pub`, recomputed fingerprint divergence, or bad signature.
   Exports `StageName`, `ApprovalPayload`, `SignedApprovalRecord`.
2. **`src/factory/frontier.ts`** — `Frontier` / `FrontierRound` /
   `FrontierDecision` over `frontier.json` (`version: 1`).
   `saveFrontier(prev, next)` throws on empty `deltaFromHead` (message
   contains "concrete behavioral delta"), on deletion of any prior decision
   ID, on duplicate decision IDs, on round regression/duplicates, and on
   deletion of prior rounds. Also exports `loadFrontier` (missing /
   unparsable / invalid / empty-delta all throw) and `frontierHash`
   (sha256 of canonical JSON, the approval binding).
3. **`src/factory/machine.ts`** — deterministic line `IDLE -> GRILL ->
   RESEARCH -> SPEC -> BUILD_TDD_RED -> BUILD_TDD_GREEN -> GATE_MUTATION ->
   QA_DUAL_EVAL -> DONE` plus `HALTED` from any state. `canTransition`
   (pure) returns `{ next, halted, reason }` for ordinary refusals and
   throws only `RedFirstViolationError` (RED `exitCode === 0`) and
   `TestTamperingError`; `transition` throws `Error(reason)` whenever the
   machine does not reach `to`. Every guard from the contract is enforced:
   frontier + `frontierHash` + Ed25519 validity; `auditPassed &&
   verifiedCount >= 1`; non-empty spec + `specHash` + Ed25519 validity;
   RED requires `exitCode !== 0` (+ consistency with `redFailedTests`);
   GREEN requires locked manifest + re-verification evidence (`testManifest`
   / `testManifestCheck` — documented runner contract, fail closed when
   absent) + `greenExitCode === 0`; `mutationScore >= 0.85` (single source
   of truth via `MUTATION_THRESHOLD`); dual `PASS` + `assertModelDiversity`
   (throws on identical judge/programmer models unless
   `modelDiversityOverride` is set). `STOP` kill-file and `spendUSD >
   ceilingUSD` force `HALTED` first, from any state. `TestTamperingError`
   is re-exported from its canonical home `gates/test-lock.ts` (no
   circular import).
4. **`src/gates/test-lock.ts`** — `lockTestManifest` (recursive, sorted
   relative posix paths + SHA-256; refuses non-regular entries such as
   symlinks), `verifyTestManifestUnchanged` (returns `{ unchanged,
   changed, missing, added }`; a vanished dir reports all-locked-missing),
   `assertTestManifestUnchanged` (throws `TestTamperingError` with full
   detail).
5. **`src/gates/mutation.ts`** — `generateSourceMutants` (deterministic,
   source order, stable `M1…` ids, 1-based lines; `===` ↔ `!==`, `>=` →
   `<` / standalone `<` → `>=` with `<=`/`<<`/`</`/`<!` guards, `true` ↔
   `false`, `&&` ↔ `||`, leftmost-first overlap resolution).
   `runMutationGate` applies one mutant at a time, kills on non-zero exit
   or timeout (Stryker convention, 120 s), restores the original in
   `finally` plus a final per-file restore; `score >= 0.85` passes.
   Zero-mutant edge: `score = 1`, `passed = true` (recorded choice —
   mutation-free code never blocks). `MUTATION_THRESHOLD = 0.85` exported.
6. **`src/gates/engine.ts`** — `sha256Hex`, `commandSetHash` (sha256 over
   JSON argv), `assertTrustedCommand` (throws on untrusted/empty),
   `scanForSecrets` (`AKIA…`, `ghp_…`, PEM private-key headers,
   `sk-live-…`, `api[_-]?key = "…"`; findings carry rule id + offset +
   first-4-chars redaction, never live secrets), `runGateCommand`
   (trust-check first when `trustedHashes` given; `bwrap --ro-bind / /
   --tmpfs /tmp --proc /proc --dev /dev --die-with-parent` profile, with a
   recorded `stderr` warning + direct fallback when `bwrap` is missing;
   non-zero exits returned, never thrown).
7. **`src/index.ts`** — re-exports all six modules (`TestTamperingError`
   via `machine.ts`; test-lock values imported explicitly to avoid
   `export *` ambiguity).
8. **Tests** (`bun:test`, genuine assertions, zero stubs):
   `test/approval.test.ts` (seal→sign→verify round-trip, wrong passphrase,
   tampered hash/stage/signature, re-sealed key mismatch, missing dir fail
   closed, 0600 perms, bad stage refused), `test/machine.test.ts`
   (frontier append-only rules + load round-trip; full legal walk; every
   guard refusal; RED-0 throws `RedFirstViolationError`; tampered GREEN
   throws `TestTamperingError`; 0.84 blocked / 0.85 passes; dual-PASS +
   diversity incl. override; STOP/spend HALTED from all states; voluntary
   halt; HALTED terminal), `test/gates.test.ts` (mutant swaps incl. id/line
   stability and `<=`/`<<` exclusion; lock detects
   modification/deletion/addition; engine hash/trust/secrets/runner incl.
   bwrap-fallback; live `runMutationGate` kill/survive/vacuous/fail-closed
   cases with fixtures restored byte-identical).
9. **Acceptance** `scripts/accept/wave-2.sh` (executable): `bun test
   packages/core` + package & root `tsc --noEmit` + RED-first demo
   (`RedFirstViolationError` on `exitCode 0`, failing run advances) +
   tamper demo (modified temp test file → `TestTamperingError`, clean tree
   advances); exit 0 only if all pass.
10. **Package config:** `package.json` (`@heretek-ai/es-core`, description,
    `exports`, `test`/`check` scripts), `tsconfig.json` (`src`+`test`
    includes, `allowImportingTsExtensions`, `bun-types`/`node`), `README.md`
    (layout + runner contract).

Out of scope untouched: `packages/epistemic-verifier-mcp` (import-only),
`packages/cli` (Wave 3), forbidden `packages/fleet` / `packages/web` not
built.

## Files created / modified

Created:

- `packages/core/src/approval/ed25519.ts`
- `packages/core/src/factory/frontier.ts`
- `packages/core/src/factory/machine.ts`
- `packages/core/src/gates/test-lock.ts`
- `packages/core/src/gates/mutation.ts`
- `packages/core/src/gates/engine.ts`
- `packages/core/src/index.ts`
- `packages/core/test/approval.test.ts`
- `packages/core/test/machine.test.ts`
- `packages/core/test/gates.test.ts`
- `scripts/accept/wave-2.sh`
- `docs/reports/wave-2.md` (this file)

Modified:

- `packages/core/package.json` (name/description/exports/scripts)
- `packages/core/tsconfig.json` (`src`+`test` includes, ts-extension imports)
- `packages/core/README.md` (was Wave-0 scaffolding stub, now documents layout + runner contract)
- import/format normalization via `biome check --write` (no logic changes)

## Test results

- `bun test packages/core`: **45 pass, 0 fail** (148 expects, 3 files)
- `bun test` (whole worktree): **105 pass, 0 fail** (582 expects, 6 files)
- `bun run check` (`bun test` + `tsc --noEmit` + `biome check .`): **exit 0**
- `bash scripts/accept/wave-2.sh`: **PASSED** (unit tests + typecheck +
  RED-first demo + tamper demo) — exit 0
- Stub scan (`TODO\b|placeholder|not implemented|mock implementation` over
  new src+test+script): clean

## Self-audit notes / security invariants verified

- Sealed human keys never touch disk unencrypted; `human.key.enc` is
  `0o600` (tested via `stat`); empty passphrases refused at seal and sign;
  wrong passphrases / tampered envelopes throw auth-tag failures (tested).
- Approvals bind `{ runId, stage, subjectHash, timestamp }` canonically;
  stage and subject hash are both equality-checked before signature
  verification, and verification is total (`boolean`, never throws).
- RED-first is a throwing error, not a returned flag — a sabotaged machine
  that returned "permitted" on `exitCode 0` cannot satisfy the
  `RedFirstViolationError` assertion (QA can verify by deleting the throw).
- GREEN requires positive re-verification evidence, not just the absence of
  a diff: no manifest or no check halts the line; tampering throws.
- `runMutationGate` restores every target file even on runner exceptions
  (per-mutant `finally` + per-file `finally`); fixtures assert
  byte-identical restore (tested).
- `runGateCommand` trust-checks before spawning when a trusted set is
  given; secret findings are redacted by construction; the bwrap fallback
  warns in-band rather than failing or going silent.
