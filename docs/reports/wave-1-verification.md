# Wave 1 Drift Guard Verification — `packages/epistemic-verifier-mcp`

- **Stage:** Wave 1 (Quote, Seal, Cache, Auditor & MCP Server)
- **Branch:** `wave-1-epistemic-verifier`
- **Worktree:** `/home/john/Projects/Heretek-AI-Rebuild/epistemic-factory/worktrees/wave-1`
- **Auditor:** agency-drift-guard (Muse Spark 1.3 Contributor)
- **Date (UTC):** 2026-10-15
- **Specs read in full from disk:** `AGENTS.md`, `docs/prompts/SPEC.md`, `docs/prompts/verify-stage.md`, `MASTER_BUILD_PROMPT.md`, `docs/reports/wave-1.md`, `docs/evidence/wave-1/red-proofs.log`
- **Method:** read-only audit of production source; wrote ONLY this report. Ran `bun run check`, `bash scripts/accept/wave-1.sh`, grep scans, and an independent fail-closed sabotage script in `/tmp` (no repo files touched).

## 1. Scope audited

- `packages/epistemic-verifier-mcp/src/{quote,seal,cache,auditor,mcp-server,index}.ts`
- `packages/epistemic-verifier-mcp/test/{quote,seal-cache,auditor}.test.ts`
- `scripts/accept/wave-1.sh`, `docs/reports/wave-1.md`, `docs/evidence/wave-1/red-proofs.log`
- Scope boundary: `packages/core`, `packages/cli` contain only scaffold (`package.json` + `README.md` + `tsconfig.json`, no implementation) — allowed Wave 2/3 placeholders. No `packages/fleet`, no `packages/web`.

## 2. Contracts checklist (SPEC §2.1)

- [x] **quote.ts** — `export const MIN_QUOTE = 12` (quote.ts:12). `normalizeForQuote` does NFKC (line 65), curly-quote/dash/special-space folds via explicit code-point classes (lines 27–62), Markdown link-label strip (lines 74–92), `**`/`__`/backtick removal (line 69), whitespace collapse + trim (line 70). `verifyQuote` splits on `...`/`…` (line 104), enforces every fragment `>= MIN_QUOTE` (lines 113–123), strict sequential `indexOf` order scan (lines 125–136), returns `{ ok, index?, reason? }` (lines 94–99, 109–138). `normalizeWithMap` (line 174) with documented `text === normalizeForQuote(x)` contract; `locateQuote` (line 249) returns `Array<{start,end}> | undefined`, self-checks each range normalizes back (lines 276–281), returns `undefined` on divergence.
- [x] **seal.ts** — `ensureEngineKey` uses `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW` with mode `0o600` (seal.ts:97–104), 32 random bytes, lock-guarded create-first with no-follow read-back on `EEXIST`/`ELOOP` (lines 108–122). `readEngineKey` uses `O_RDONLY | O_NOFOLLOW`, never creates (`ENOENT → undefined`, lines 131–143). `sealMeta` canonical recursively-sorted-JSON HMAC-SHA256 hex excluding `seal` (lines 157–178). `verifyMetaSeal` constant-time `timingSafeEqual` with length check, fail-closed on missing/non-string/empty seal (lines 181–197).
- [x] **cache.ts** — `putCachedSource` computes sha256 of exact content bytes, atomic-writes `<sha>.md` + sealed `<sha>.json { sha256, url, title, fetchedAt, seal }` via `ensureEngineKey` (lines 85–111). `getCachedSource` verifies `sha256(content) === address` AND `verifyMetaSeal` under `readEngineKey` (never mints, lines 172–178), plus `O_NOFOLLOW` regular-file assertions; throws `TamperedSourceError` on malformed/missing/unsealed/forged/wrong-key entries (lines 124–196). `TamperedSourceError` exported with `sha256` field (lines 19–27).
- [x] **auditor.ts** — `auditResearchMarkdown` (line 141) parses `[VERIFIED: sha256:<64-hex> "quote"]` (straight or curly quotes, depth-matched brackets, lines 51–118), loads via `getCachedSource`, runs `verifyQuote`; `[INFERRED]/[HYPOTHESIS]/[NEGATIVE_KNOWLEDGE]` pass through untouched; failures recorded with 1-based line numbers and moved to appended `## Pruned claims` section; `passed = failures==0 && verifiedCount>=1`. Fenced code, headings, pre-existing prune sections skipped; malformed near-miss `[VERIFIED` spans fail closed (lines 62–67, 80–82, 170–172).
- [x] **mcp-server.ts** — stdio newline-delimited JSON-RPC 2.0 server, node builtins only: `initialize`, `ping`, `tools/list`, `tools/call` (lines 246–296), notifications ignored, parse errors → `-32700`, unknown methods → `-32601`, unknown tools → `-32602`, tool exceptions → `isError` result envelopes (never throw transport). Exactly 4 tools: `cache_source`, `verify_quote`, `locate_quote`, `audit_markdown` (lines 27–113). Dir resolution args → env → `./.epistemic-cache`/`./.epistemic-state` (lines 115–131). Importing `index.ts` never starts the server (`import.meta.main` guard, lines 355–357).
- [x] **index.ts** — re-exports all public value + type symbols (auditor, cache, mcp-server, quote, seal), type-only MCP surface, no side effects.

## 3. Stub scan

- `grep -rn -E 'TODO|FIXME|XXX|HACK|placeholder|not implemented|notImplemented|mock|cmd:.*true|echo .pass.|exit 0|\|\| true|set \+e|catch \([^)]*\) \{\}'` over `src + test + scripts/accept/wave-1.sh`: **no matches (exit 1, clean)**.
- Case-insensitive `mock` grep: **no matches**.
- Vacuous-assert grep (`1 === 1`, `expect(true).toBe(true)`): **no matches**.
- Tests are genuine: 60 tests / 434 `expect()` calls across 3 files (44 + 43 + 35 `expect(` occurrences); suite asserts folding, MIN_QUOTE, order, offsets, seal round-trips, tamper refusal, prune sections.
- Accept script `scripts/accept/wave-1.sh` runs real unit tests + `tsc --noEmit` + sealed round-trip + MCP stdio smoke; exits 0 only if all pass (independently re-run: PASSED, exit 0).

## 4. Scope scan

- `ls packages/`: `cli core epistemic-verifier-mcp`. `packages/fleet`: absent. `packages/web`: absent.
- `grep -riE 'queereye|brainstorm|harvest|es-fleet'` over src/test/accept/Makefile: **no matches (exit 1, clean)**.
- `packages/core`, `packages/cli` contain only `package.json`/`README.md`/`tsconfig.json` scaffold — Wave 2/3 placeholders, no implementation, no forbidden content.
- **SCOPE CLEAN.**

## 5. Security invariant checks

- [x] `engine.key` created `0o600` — independently verified live `stat` mode `0600` (DRIFT_D_MODE: PASS).
- [x] `O_NOFOLLOW` symlink fail-closed — planted symlink: both `ensureEngineKey` and `readEngineKey` throw (DRIFT_C_SYMLINK / DRIFT_C_READ_SYMLINK: PASS). Matches `seal-cache.test.ts` symlink coverage.
- [x] Seal verification on every read; reader never mints a key (`readEngineKey`, missing key → `TamperedSourceError`) — confirmed in code (cache.ts:172–178) and by QA bonus sabotage.
- [x] NFKC + typography-folded verbatim verification; `MIN_QUOTE = 12` enforced per fragment (quote.ts:12,118) — independently confirmed `MIN_QUOTE === 12`.
- [x] Independent tamper re-proof: overwrote `<sha>.md` with planted bytes → `getCachedSource` threw `TamperedSourceError` (DRIFT_A_TAMPER: PASS fail-closed).
- [x] Independent quote-mutation re-proof: 1-word alteration → `{ ok: false }`, good quote → `{ ok: true }` (DRIFT_B_QUOTE: PASS).
- [x] `bun run check` (bun test + tsc + biome): **exit 0** (60 pass, 0 fail, 434 expects). `bash scripts/accept/wave-1.sh`: **PASSED, exit 0**.

## 6. QA evidence cross-check (`docs/evidence/wave-1/red-proofs.log`)

- Sabotage A (seal tamper → `TamperedSourceError: cached source bytes no longer hash…`): **plausible** — message matches `cache.ts:146` verbatim; independently reproduced same throw class.
- Sabotage B (1-word quote mutation → `{ ok: false, reason: 'not found verbatim…' }`): **plausible** — reason matches `quote.ts:132`; independently reproduced.
- Sabotage C (missing source → `passed=false`, 1 failure, `## Pruned claims` present): **plausible** — matches `auditor.ts:186–191, 207–223` paths.
- Sabotage D (short fragment → "need at least 12 characters"): **plausible** — matches `quote.ts:116`.
- Bonus (unsealed entry, fresh stateDir → `TamperedSourceError: no engine key…`): **plausible** — matches `cache.ts:175–178`.
- Accept outputs recorded (60 pass / 434 expects / check exit 0) match my independent re-runs exactly. QA touched only the log file; `git status` shows `A docs/evidence/wave-1/red-proofs.log`, production source untouched. **QA evidence credible.**
- Note: QA §1d accurately reports core/cli scaffold as allowed — confirmed.

## 7. FINDINGS

No blocking findings. Zero stubs, zero scope violations, all §2.1 contracts present with exact names/signatures, all security invariants hold under independent re-proof, QA red-proofs plausible and reproduced.

Non-blocking observations (no action required):
1. `seal.ts` lock uses a mkdir-based advisory lock with stale-owner reclaim — adequate for single-host key creation; not a Wave 1 gate issue.
2. `normalizeWithMap` uses per-character NFKC (documented as differing from whole-string NFKC only for exotic compositions) with the `text === normalizeForQuote(x)` contract tested and a `locateQuote` self-check backstop — fail-safe degradation to `undefined`, never wrong highlights.

## 8. Binding verdict

`VERDICT: PASS`
