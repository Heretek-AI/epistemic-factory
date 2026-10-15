# verify-stage.md — Binding Triad Gate Checklist for `agency-qa` + `agency-drift-guard`

> QA: read this file in full before verifying any wave.
> No wave merges to `main` without BOTH a QA red-proof log AND a Drift Guard `VERDICT: PASS`.

## 1. QA mechanical verification (must all pass)

- [ ] `make check` exits 0 (bun install + tests + typecheck + lint as available).
- [ ] The wave's accept script exits 0:
  - Wave 1: `bash scripts/accept/wave-1.sh`
  - Wave 2: `bash scripts/accept/wave-2.sh`
  - Wave 3: `bash scripts/accept/wave-3.sh`
  - Full: `make accept` (missing wave scripts are skipped with a warning, never an error, until that wave lands).
- [ ] No stub patterns anywhere in the wave's diff (grep and fail closed):
  - `TODO`, `FIXME`, `XXX`, `HACK`, `placeholder`, `not implemented`,
    `notImplemented`, `throw new Error("TODO")`, dummy `return true`,
    swallowed errors (`catch (e) {}` / `|| true` / `set +e` in scripts).

## 2. QA Red-Proof Sabotage (mandatory; log every step)

Write results to `docs/evidence/wave-<N>/red-proofs.log` (create the directory;
the log must show the sabotage, the observed failure, and the restoration).

Wave 1 (minimum):
- [ ] Tamper with a cached `<sha256>.md` file WITHOUT updating the
  `engine.key` HMAC seal; confirm `getCachedSource` throws
  `TamperedSourceError` (fail-closed read).
- [ ] Alter one word of a verified quote; confirm `verifyQuote` returns
  `{ ok: false }`.
- [ ] Write an unsealed cache entry (no valid `seal`); confirm the sealed
  reader refuses it.

Wave 2 (minimum):
- [ ] Sabotage `machine.ts` to allow `BUILD_TDD_RED -> BUILD_TDD_GREEN`
  when `exitCode === 0`; confirm the test suite catches it
  (`RedFirstViolationError` path covered by a failing-then-restored test).
- [ ] Modify or delete a test file after the RED lock; confirm
  `verifyTestManifestUnchanged` throws `TestTamperingError`.
- [ ] Forge or strip an Ed25519 stage approval; confirm the
  `GRILL -> RESEARCH` / `SPEC -> BUILD_TDD_RED` guards reject it.

Wave 3 (minimum):
- [ ] Point `es audit-research` at markdown with an ungrounded
  `[VERIFIED: ...]` claim; confirm exit code `1` and the claim is pruned.
- [ ] Remove a `.worktreeinclude`-listed secret from the base repo; confirm
  the syncer fails closed (errors, does not silently skip).

## 3. Drift Guard audit (writes `docs/reports/wave-<N>-verification.md`)

- [ ] Scope check: no `packages/fleet`, no `packages/web`, no `queereye`,
  no `brainstorm`, no `harvest` anywhere in the diff — refuse on violation.
- [ ] Spec conformance: every module in `docs/prompts/SPEC.md` §2 for this
  wave is implemented with its exact exported contract.
- [ ] Security invariants checklist (§5 of AGENTS.md): sealed cache reads,
  `MIN_QUOTE = 12` verbatim verification, RED-first enforcement, test-lock,
  Ed25519 approvals (agents never self-sign).
- [ ] Zero-stub grep clean (same pattern list as QA §1).
- [ ] Issue exactly one line `VERDICT: PASS` or `VERDICT: FAIL` with
  reasons; only `VERDICT: PASS` unblocks the merge to `main`.

## 4. Merge precondition

A wave merges to `main` IFF:

1. `docs/evidence/wave-<N>/red-proofs.log` exists and records passing sabotage,
2. `docs/reports/wave-<N>-verification.md` contains `VERDICT: PASS`,
3. `make check && make accept` exits 0 on the wave branch.
