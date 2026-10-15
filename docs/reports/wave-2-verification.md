# Wave 2 Drift Guard Verification — `@heretek-ai/es-core`

- **Stage:** Wave 2 (State Machine, Ed25519 Approvals, Red/Green & Mutation Gates)
- **Branch:** `wave-2-factory-core`
- **Worktree:** `/home/john/Projects/Heretek-AI-Rebuild/epistemic-factory/worktrees/wave-2`
- **Auditor:** `agency-drift-guard` (read-only to source; wrote only this file)
- **Date (UTC):** 2026-10-15
- **Spec:** `docs/prompts/SPEC.md` §2.2, `AGENTS.md` §§4–6, `docs/prompts/verify-stage.md` §§1–3

## 1. Contract checklist (SPEC §2.2)

- [x] **`src/approval/ed25519.ts`** — `node:crypto` `generateKeyPairSync("ed25519")` (L134), `scryptSync` (L145, L227), `createCipheriv("aes-256-gcm")` (L151) / `createDecipheriv` (L234), `sign` (L300) / `verify` (L381). `sealHumanKey` writes `human.key.enc` mode `0o600` on create (L170) + enforced `chmod 0600` over pre-existing files (L173), refuses empty passphrase (L129). `signStageApproval` covers canonical JSON `{runId,stage,subjectHash,timestamp}` for stages `GRILL|SPEC|WAIVER|TRUST` (L30, L253, L276). `verifyStageApproval` checks stage + subjectHash equality (L354), binds record identity to `human.pub` (L362), recomputes fingerprint (L369), verifies Ed25519 signature, returns `false` (never throws) on any mismatch (L319–L390). NOTE (observation, not a finding): `verifyStageApproval` is `async` (`Promise<boolean>`) because it reads `human.pub` from disk; the fail-closed boolean semantic holds.
- [x] **`src/factory/frontier.ts`** — `frontier.json` shape `{version:1, idea, deltaFromHead, rounds[]}` (L30–L35). `saveFrontier` refuses empty `deltaFromHead` with "concrete behavioral delta" message (L138–L142), refuses prior decision-ID deletion (L166–L172), refuses duplicate IDs (L146–L152), refuses round regression/duplicates (L154–L162) and prior-round deletion (L173–L180). `loadFrontier` fails closed on missing/unparsable/invalid/empty-delta (L187–L209). `frontierHash` = sha256 canonical JSON (L212–L216).
- [x] **`src/factory/machine.ts`** — deterministic line `IDLE→GRILL→RESEARCH→SPEC→BUILD_TDD_RED→BUILD_TDD_GREEN→GATE_MUTATION→QA_DUAL_EVAL→DONE` in `LEGAL_NEXT` (L89–L100) plus `HALTED` reachable from every state incl. `DONE`/`HALTED` self-edge. Guards verified: GRILL→RESEARCH frontier+delta+hex64 hash+`frontierSignatureValid` (L149–L178); RESEARCH→SPEC `auditPassed===true && verifiedCount>=1` (L180–L197); SPEC→RED non-empty spec+hex64 hash+`specSignatureValid` (L199–L222); RED→GREEN requires `redExitCode!==0`, throws `RedFirstViolationError` on `exitCode===0` (L355–L373); GREEN→MUTATION requires locked manifest + re-verification evidence (fails closed when absent, L228–L239), throws `TestTamperingError` on diff (L241–L245), requires `greenExitCode===0` (L246–L257); MUTATION→QA requires `mutationScore >= MUTATION_THRESHOLD (0.85)` single-sourced from `gates/mutation.ts` (L261–L278); QA→DONE requires dual `PASS` + `assertModelDiversity` throw on identical triple without override (L280–L300, L123–L147); STOP kill-file / `spendUSD>ceilingUSD` force `HALTED` from any state first (L314–L331). `TestTamperingError` re-exported from canonical `gates/test-lock.ts`, no circular import (L29–L32).
- [x] **`src/gates/test-lock.ts`** — `lockTestManifest` recursive sorted posix paths + SHA-256, refuses non-regular entries incl. symlinks (L49–L101); `verifyTestManifestUnchanged` returns `{unchanged,changed,missing,added}`, vanished dir → all-locked-missing (L109–L147); `assertTestManifestUnchanged` throws `TestTamperingError` with detail (L153–L163).
- [x] **`src/gates/mutation.ts`** — `generateSourceMutants` deterministic source-order stable `M1…` ids, 1-based lines, `===↔!==`, `>=→<`/standalone `<→>=` with `<=`/`<<`/`</`/`<!` guards, `true↔false`, `&&↔||`, leftmost-first overlap (L53–L118). `runMutationGate` one-mutant-at-a-time, kill on non-zero exit or 120 s timeout, per-mutant `finally` restore + per-file final restore (L198–L221), passes iff `score >= 0.85` via exported `MUTATION_THRESHOLD` (L26, L227). Zero-mutant edge `score=1, passed=true` is documented/recorded, deterministic, and fail-safe in the strict direction (more mutants only demand stronger tests).
- [x] **`src/gates/engine.ts`** — `sha256Hex` (L22), `commandSetHash` over JSON argv (L27), `assertTrustedCommand` throws on empty/untrusted (L35–L50), `scanForSecrets` with rule id + offset + first-4 redaction, never live secrets (L57–L92), `runGateCommand` trust-checks before spawn (L135), `bwrap --ro-bind / / --tmpfs /tmp --proc /proc --dev /dev --die-with-parent` profile (L143–L159) with recorded in-`stderr` warning + direct fallback when `bwrap` missing (L161–L163), non-zero exits returned not thrown (L189–L191).

## 2. Zero-stub / scope / security checklist

- [x] Zero stubs: `TODO|FIXME|XXX|HACK|placeholder|not implemented|notImplemented` over `packages/core/src + test + scripts/accept/wave-2.sh` → **no matches (grep exit 1)**. Swallowed-error patterns (`|| true`, `set +e`, `catch (e) {}`) → **no matches**. Accept script uses `set -euo pipefail` (fail-closed, not `set +e`).
- [x] Scope boundary: `ls packages/` → `cli core epistemic-verifier-mcp` only; `packages/fleet`, `packages/web` absent; `fleet|queereye|brainstorm|harvest` in `packages/core/src+test` → **no matches**. `git diff --stat HEAD -- packages/epistemic-verifier-mcp/` → **empty (Wave 1 untouched, import-only)**.
- [x] Security invariants: sealed `human.key.enc` `0600` + `chmod` enforcement + empty-passphrase refusal at seal and sign; approval equality checks precede signature verification and verification is total; RED-first is a throwing error class; GREEN requires positive re-verification evidence, not mere absence of diff; mutation restores in `finally` (byte-identical restore tested); gate trust-check precedes spawn; secret findings redacted by construction.
- [x] Tests are genuine: `approval.test.ts` 18 expects, `gates.test.ts` 57 expects, `machine.test.ts` 46 expects; no vacuous `assert(1===1)` / existence-only assertions found.

## 3. Mechanical verification (auditor re-ran)

- [x] `bun run check` (`bun test` + `tsc --noEmit` + `biome check .`) → **exit 0** (105 pass, 0 fail, 582 expects, 6 files; biome 29 files clean).
- [x] `bash scripts/accept/wave-2.sh` → **exit 0** (45 core pass; typecheck; RED-first demo OK; tamper demo OK; `wave-2 accept PASSED`).

## 4. QA evidence cross-check (`docs/evidence/wave-2/red-proofs.log`)

- [x] Log exists; method runtime-only sabotage in `/tmp/opencode/qa-wave2/`, `git status` clean before/after — plausible and stronger than in-tree sabotage for guard-throw proofs.
- [x] Sabotage A (RED bypass, exitCode 0 → `RedFirstViolationError`; control advances) — **plausible, PASS**.
- [x] Sabotage B (modify + delete after RED lock → `verifyTestManifestUnchanged` diff + `TestTamperingError` at helper and machine level) — **plausible, PASS**.
- [x] Sabotage C (sign X verify Y → `true` control, `false` on wrong hash/stage) — **plausible, PASS**.
- [x] Sabotage D (mutation 0.5 refused; 0.84 refused / 0.85 permitted boundary) — **plausible, PASS**.
- [x] Sabotage E (identical triple without override throws diversity violation; diverse + override controls pass; exit-1 note correctly attributed to unguarded probe script, guarded re-run exit 0) — **plausible, PASS**.
- [x] Zero-stub grep, scope check, Wave-1 regression (`wave-1.sh` exit 0) all recorded exit 0. `QA_VERDICT: PASS` present.

## 5. Independent fail-closed spot probes (auditor-executed)

- [x] PROBE 1: `canTransition(BUILD_TDD_RED→BUILD_TDD_GREEN, {redExitCode:0})` throws `RedFirstViolationError` (not a halt-return) — **OK**.
- [x] PROBE 2: `lockTestManifest` → delete file → `assertTestManifestUnchanged` throws `TestTamperingError` — **OK**.

## FINDINGS

NONE. No stubs, no scope violations, no contract deviations, no vacuous assertions, no Wave-1 modifications. All fail-closed guards throw or refuse as specified; QA sabotage claims reproduce under independent probing.

## Binding verdict

`VERDICT: PASS`
