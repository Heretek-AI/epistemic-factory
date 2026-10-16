# Wave 3 Drift Guard Verification — `@heretek-ai/es-cli` (`es` CLI + `.worktreeinclude`)

- **Stage:** Wave 3 (§2.3: `packages/cli/src/worktree-include.ts`, `src/bin.ts`, `src/index.ts`, `test/cli.test.ts`, `scripts/accept/wave-3.sh`, `README.md`, `packages/cli/package.json`)
- **Branch:** `wave-3-es-cli`
- **Worktree:** `/home/john/Projects/Heretek-AI-Rebuild/epistemic-factory/worktrees/wave-3`
- **Date (UTC):** 2026-10-16
- **Auditor model:** muse-spark-1.3-contributor (agency-drift-guard)
- **Inputs read in full from disk:** `AGENTS.md`, `docs/prompts/SPEC.md`, `docs/prompts/verify-stage.md`, `MASTER_BUILD_PROMPT.md`, `docs/reports/wave-3.md`, `docs/evidence/wave-3/red-proofs.log`, plus every Wave 3 deliverable file listed below.
- **Write constraint honored:** production source untouched (read-only); only this report written. (One self-inflicted note: an early independent probe ran without its env var exported and dropped `bad.md`/`cache/`/`state/` into the worktree root; all three were removed immediately. `git status` confirms only `docs/evidence/wave-3/red-proofs.log` (QA, staged) plus this report are added.)

## 1. Contract checklist (SPEC §2.3 + Wave 3 plan)

- [x] `src/worktree-include.ts` — parses `.worktreeinclude` (`parseWorktreeInclude` drops blanks/`#` comments, trims: lines 53–62); matching covers exact basenames, `*.ext`, `dir/*.ext` one-level, `prefix*`/`*suffix`, `**` contains, `?` single-char (lines 132–150); `collectWorktreeIncludes` returns `[]` when absent and throws on unreadable (lines 157–169); `syncWorktreeIncludes` uses pure `node:fs` recursion, `mkdir -p` preserving rel paths, never runs `git add`/`git stage` (only mentions are comments, lines 8/206), skips symlinks and `.git` (lines 182/186), fail-closed on `..` at pattern, rel-path, and resolved-destination layers (lines 139–140, 236). **Contract met.**
- [x] `src/bin.ts` — `es key seal` (lines 172–189), `es init` (197–233, refuses overwrite without `--force`, lines 209–215), `es status` (308–339, informational exit 0), `es approve` for `GRILL|SPEC|WAIVER|TRUST` with 64-hex `--subject` enforced (lines 356–367) and record persisted to `.factory/approvals/<STAGE>-<runId>.json` (lines 387–392), `es audit-research` exit 0/1 on `passed` (line 435), `es gate-mutation` exit 0/1 on `passed` (line 479), testable exported `cmd*` fns + `main(argv): Promise<number>` (lines 488–528: help/bare → usage + 0, unknown → stderr + 1, any throw → stderr + 1). `#!/usr/bin/env bun` present (line 1). **Contract met.**
- [x] `src/index.ts` — re-exports only; no `import.meta.main`, no `process.exit`, no `main()` call; comment states importing never executes (lines 1–3). **No auto-execute confirmed by grep.**
- [x] `test/cli.test.ts` — 18 tests against real `/tmp` dirs and real `@heretek-ai/es-core` + `@heretek-ai/epistemic-verifier-mcp` imports (lines 10–17): parse/match/sync incl. traversal rejection (lines 76–82), round-trip copy with rel-path preservation and no `.git` (lines 91–120), `missing` reporting (122–129), `main()` exit codes incl. key-seal→approve round-trip via the real core signer and bad-stage/bad-subject refusals (160–236), audit 0/1 via real sealed cache (238–280), gate `false`=0/`true`=1 with byte-identical restore (282–311). **Real tests, zero stubs.**
- [x] `scripts/accept/wave-3.sh` — executable (`-rwxr-xr-x`), `set -euo pipefail` (line 6, no `set +e`/`|| true` anywhere), unit tests + package & root `tsc --noEmit` + live smoke through the real entrypoint (help, unknown→1, init/status, double-init refusal, key seal + approve with record on disk, audit pass/fail on a real sealed cache, gate pass/fail). **Executable, fail-closed.**
- [x] Root `README.md` — documents install, all six subcommand signatures (lines 39–61) with end-to-end examples (lines 70–81), GRILL→PR pipeline, security invariants, worktree flow, and an explicit out-of-scope notice (lines 156–157). **Docs present.**
- [x] `packages/cli/package.json` — `@heretek-ai/es-cli`, `bin: { es: ./src/bin.ts }`, workspace deps on core + verifier-mcp. **Correct, untouched.**
- [x] Waves 1–2 untouched — `git diff --name-only main...HEAD` shows no paths under `packages/core/src` or `packages/epistemic-verifier-mcp/src`; diff touches only `README.md`, `bun.lock`, `docs/reports/wave-3.md`, `packages/cli/*`, `scripts/accept/wave-3.sh`. **No regression surface.**

## 2. Zero-stub / scope-boundary checklist

- [x] Stub grep over `packages/cli/src` + `packages/cli/test` + `scripts/accept/wave-3.sh` for `cmd: "true"`, `echo "pass"`, `FIXME|XXX|HACK|placeholder|not implemented|notImplemented|throw new Error("TODO")|return true // dummy|\|\| true|set +e|catch (...) {}`: **zero matches**.
- [x] `TODO`: exactly 2 matches, both inside the `es init` frontier-skeleton string literals (`bin.ts:218,220`, `"TODO: grilled idea …"`, `"TODO: concrete behavioral delta …"`). These are generated-file default contents the GRILL stage must replace — not unimplemented code paths; every exported function is implemented and covered. Same disposition as QA §1e. **Not a stub failure.**
- [x] Scope: `ls packages/` → `cli core epistemic-verifier-mcp` only. Grep over `packages/cli` (src+test), `scripts/accept/wave-3.sh`, `README.md` for `fleet|queereye|brainstorm|harvest|packages/web`: **no matches** (only README's out-of-scope notice naming them as forbidden). **Boundary intact per AGENTS.md §4.**

## 3. Security-invariants checklist

- [x] Passphrase arrives via `--passphrase` or `ES_PASSPHRASE` only (`bin.ts:146–151`); required non-empty for `key seal` (181–185) and `approve` (373–378); never written to disk; grep confirms no passphrase logging.
- [x] No secret logging (grep for passphrase-adjacent stdout/log writes: clean).
- [x] Traversal blocked at three layers (`matchWorktreePattern` `..`-segment reject; `isStrictlyWithin` on src and dest); symlinks never followed/copied; `.git` never synced; `syncWorktreeIncludes` refuses `base === worktree` (lines 216–220).
- [x] `es init` no-overwrite without `--force` (throws, writes nothing after the check: validation via core `saveFrontier` runs before any write, lines 225–228).
- [x] Audit/mutation gates exit 1 fail-closed with evidence on stdout (`bin.ts:435,479`); invalid inputs are descriptive stderr errors + exit 1 throughout.
- [x] Agents never self-sign: signing requires the human passphrase, which agents must never hold (documented `bin.ts:21–24` and enforced by the passphrase requirement).

## 4. QA evidence cross-check (`docs/evidence/wave-3/red-proofs.log`)

- [x] Acceptance chain plausible and reproduced: `bun run check` exit 0 (independently re-run: **REAL_CHECK_EXIT=0**, 123 pass / 0 fail / 639 expects, biome clean); wave-1/2/3 accept scripts all exit 0 (wave-3.sh independently re-run: **ACCEPT_EXIT=0**).
- [x] Sabotage A (ungrounded VERIFIED → exit 1 + pruned): plausible; independently reproduced — seeded real sealed cache, `audit-research` on `"purple elephant parades loudly"` → `{"passed":false,...}` **exit 1**. **Fail-closed confirmed.**
- [x] Sabotage B (weak tests → gate exit 1): plausible. QA's correction note is accurate per SPEC §2.2 (mutant killed iff testCmd exits non-zero, so `-- false` killing all mutants → exit 0 is contract-correct, and `-- true` surviving → exit 1 is the true fail-closed property, matching the accept script). **Semantics match spec; no finding.**
- [x] Sabotage C (`../evil` traversal → contained, `missing`, no escape, payload intact): plausible and consistent with the three-layer guard in source; independently reproduced (`copied=[".env"]`, `missing=["../evil"]`, `evil-intact=true`). **Contained confirmed.**
- [x] Sabotage D (double `init` without `--force` → exit 1, `frontier.json` byte-identical): plausible and consistent with `cmdInit` lines 209–215. **Refusal confirmed.**
- [x] QA honored the no-source-modification constraint (runtime-only under `/tmp/qa-*`); pre-log `git status` clean.

## 5. FINDINGS

**NONE.** No numbered findings. Every checked contract, invariant, scope, and evidence item holds; the two independently re-proven fail-closed assertions (audit exit-1 on ungrounded claims; traversal containment) both confirm the implementation.

---

`VERDICT: PASS`
