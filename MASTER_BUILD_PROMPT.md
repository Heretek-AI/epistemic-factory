# MASTER COORDINATOR BUILD PROMPT: REPO 2 — `epistemic-factory`
**Target Repository:** `/home/john/Projects/Heretek-AI-Rebuild/epistemic-factory`  
**GitHub Remote:** `https://github.com/Heretek-AI/epistemic-factory`  
**Package Names:** `@heretek-ai/epistemic-verifier-mcp`, `@heretek-ai/es-core`, `@heretek-ai/es-cli`  
**Primary Session Agent:** `agency-coordinator` (`opencode-go/muse-spark-1.3-contributor`)  
**Required Triad Subagents:** `agency-programmer`, `agency-qa`, `agency-drift-guard`

---

## 0. CRITICAL MUSE 1.3 HARNESS SUPPLEMENT (READ FIRST — NON-NEGOTIABLE)

You are running on `opencode-go/muse-spark-1.3-contributor`. To prevent prompt summarization loss, stubbing, and scope bleed, obey these six rules on every turn:

1. **ZERO PROMPT SUMMARIZATION WHEN CALLING SUBAGENTS:**
   - In Wave 0, write this entire specification into `docs/prompts/SPEC.md` and `AGENTS.md`. Every subagent call MUST instruct the subagent to `read` `AGENTS.md` and `docs/prompts/SPEC.md` directly from disk.
2. **EXPLICIT SUBAGENT ROLES:**
   - Always pass `"agent": "agency-programmer"`, `"agent": "agency-qa"`, or `"agent": "agency-drift-guard"` when calling `subagent`. Never allow default `general`.
3. **VANILLA `read` / `edit` / `write` HYGIENE:**
   - Use native `read`, `write`, `edit`, `glob`, and `grep`—never `cat` or `sed`. Never include `read` line numbers (`12: `) in `edit` `oldString`/`newString`. Fix `<diagnostics>` immediately.
4. **STRICT SCOPE & REFUSAL BOUNDARY FOR `epistemic-factory`:**
   - This repository is **ONLY**:
     1. The standalone **Epistemic Quote & Cache Verifier MCP Server** (`packages/epistemic-verifier-mcp`), and
     2. The single-worktree **Gated Build Factory State Machine & CLI** (`packages/core` + `packages/cli`, `es`) enforcing `GRILL -> RESEARCH -> SPEC -> BUILD_TDD_RED -> BUILD_TDD_GREEN -> GATE_MUTATION -> DUAL_QA -> PR`.
   - **FORBIDDEN IN THIS REPO:** Do NOT build `packages/fleet` (`es-fleet`), do NOT build `packages/web` (the SolidJS/React WebUI), and do NOT include `queereye`, `brainstorm`, or `harvest`. Multi-task fleet scheduling and WebUI belong strictly to Repo 4 (`agency-control-plane`).
5. **NON-NEGOTIABLE SECURITY INVARIANTS:**
   - Every cached research source MUST be SHA-256 content-addressed AND sealed with an HMAC-SHA256 `engine.key` (mode `0600`) stored in the masked state dir (`seal.ts`).
   - Every `[VERIFIED: sha256:<hash> "quote"]` claim MUST pass deterministic NFKC + typography-folded verbatim quote verification (`MIN_QUOTE = 12` chars per ellipsis fragment, `quote.ts`).
   - In `BUILD_TDD_RED`, the test runner MUST fail (exit code != 0). If tests pass before implementation, halt with `RED_FIRST_VIOLATION`.
   - In `BUILD_TDD_GREEN`, the `tests/` directory MUST be protected against modification (verified via SHA-256 test-tree manifest lock or `bwrap --ro-bind`), preventing programmer agents from deleting failing test assertions.
   - Stage approvals (`GRILL -> RESEARCH`, `SPEC -> BUILD_TDD_RED`) require a valid **Ed25519 human cryptographic signature** (`approval/`). Agents may request approvals, NEVER grant or self-sign them.
6. **BINDING TRIAD GATE:**
   - Every wave requires `agency-qa` Red-Proof Sabotage (`docs/evidence/wave-<N>/red-proofs.log`) and `agency-drift-guard` `VERDICT: PASS` (`docs/reports/wave-<N>-verification.md`) before merging to `main`.

---

## 1. TARGET REPOSITORY ARCHITECTURE & FILE TREE

```text
/home/john/Projects/Heretek-AI-Rebuild/epistemic-factory/
├── AGENTS.md
├── Makefile
├── .pre-commit-config.yaml         # Tier-1 fast hook config for j178/prek (biome, gitleaks)
├── package.json                    # Bun workspace root: ["packages/*"]
├── tsconfig.json
├── bundles/                        # Spec-Kit style declarative gate overlays (Report 02a)
│   ├── default.bundle.json
│   └── strict-security.bundle.json
├── docs/
│   ├── prompts/
│   │   ├── SPEC.md
│   │   └── verify-stage.md
│   ├── reports/
│   └── evidence/
├── scripts/
│   └── accept/
│       ├── wave-1.sh
│       ├── wave-2.sh
│       └── wave-3.sh
└── packages/
    ├── epistemic-verifier-mcp/     # Wave 1: Standalone Quote/Cache/Seal Verifier & MCP Server
    │   ├── package.json            # @heretek-ai/epistemic-verifier-mcp
    │   ├── src/
    │   │   ├── quote.ts            # Verbatim NFKC quote verifier + locateQuote index map
    │   │   ├── seal.ts             # O_CREAT|O_EXCL|O_NOFOLLOW 0600 engine.key + HMAC-SHA256 sealMeta/verifyMetaSeal
    │   │   ├── cache.ts            # SHA-256 content-addressed source cache with seal verification on read
    │   │   ├── auditor.ts          # Parses [VERIFIED: sha256:... "..."], [INFERRED], [HYPOTHESIS], [NEGATIVE_KNOWLEDGE] & prunes ungrounded claims
    │   │   ├── mcp-server.ts       # Stdio JSON-RPC MCP server exposing cache_source, verify_quote, locate_quote, audit_markdown
    │   │   └── index.ts
    │   └── test/
    │       ├── quote.test.ts
    │       ├── seal-cache.test.ts
    │       └── auditor.test.ts
    ├── core/                       # Wave 2: Factory State Machine, Ed25519 Approvals, Red/Green + Mutation Gate Engine
    │   ├── package.json            # @heretek-ai/es-core
    │   ├── src/
    │   │   ├── approval/
    │   │   │   └── ed25519.ts      # scrypt + AES-256-GCM sealed Ed25519 human keypair (`sealHumanKey`, `signApproval`, `verifyApproval`)
    │   │   ├── factory/
    │   │   │   ├── frontier.ts     # Append-only design decision tree (refuses node deletion or round regression)
    │   │   │   └── machine.ts      # Deterministic state machine: IDLE -> GRILL -> RESEARCH -> SPEC -> BUILD_TDD_RED -> BUILD_TDD_GREEN -> GATE_MUTATION -> QA_DUAL_EVAL -> DONE
    │   │   ├── gates/
    │   │   │   ├── test-lock.ts    # Computes SHA-256 manifest of test files after RED phase; refuses GREEN phase if any test file was deleted/weakened
    │   │   │   ├── mutation.ts     # AST/token mutation gate (85% minimum killed mutant score threshold + Stryker/cargo-mutants adapter)
    │   │   │   └── engine.ts       # Bubblewrap (`bwrap`) gate runner + SHA-256 commandSetHash trust check + secret scanner
    │   │   └── index.ts
    │   └── test/
    │       ├── approval.test.ts
    │       ├── machine.test.ts
    │       └── gates.test.ts
    └── cli/                        # Wave 3: `es` CLI + `.worktreeinclude` helper
        ├── package.json            # @heretek-ai/es-cli (bin: { "es": "./src/bin.ts" })
        ├── src/
        │   ├── worktree-include.ts # Cline-style .worktreeinclude syncer (copies untracked .env/certs into phase worktrees)
        │   ├── bin.ts              # CLI commands: es key seal, es init, es status, es approve, es research audit, es gates
        │   └── index.ts
        └── test/
            └── cli.test.ts
```

---

## 2. EXACT MODULE SPECIFICATIONS (WRITE TO `docs/prompts/SPEC.md` IN WAVE 0)

### 2.1 Wave 1 Specification: `packages/epistemic-verifier-mcp`
Salvage directly from `/home/john/Projects/IUMBTEMS/packages/core/src/research/{quote,seal,cache,auditor}.ts` (or implement the exact contract below):

1. **`src/quote.ts`:**
   - `export const MIN_QUOTE = 12`
   - `export function normalizeForQuote(text: string): string` — Unicode `NFKC`, folds curly quotes (`‘’‚‛′` $\rightarrow$ `'`, `“”„‟″` $\rightarrow$ `"`), dashes (`‐-―−` $\rightarrow$ `-`), special spaces (`\u00A0\u2000-\u200B\u202F\u205F\u3000` $\rightarrow$ `" "`), strips Markdown links `[label](url)` $\rightarrow$ `label` and `**`, `__`, `` ` ``, collapses whitespace runs to single space, and trims.
   - `export function verifyQuote(source: string, quote: string): { ok: boolean; index?: number; reason?: string }` — Splits prose quotes on `...` or `…`. Every fragment must be `>= MIN_QUOTE` (12) normalized characters and appear in `normalizeForQuote(source)` in strict sequential order.
   - `export function normalizeWithMap(text: string): { text: string; map: readonly number[] }` and `export function locateQuote(source: string, quote: string): Array<{ start: number; end: number }> | undefined` — Maps normalized quote fragments back to exact character offsets `[start, end]` in the original `source` and self-checks that `source.slice(start, end)` normalizes back to the fragment.
2. **`src/seal.ts`:**
   - `export async function ensureEngineKey(stateDir: string): Promise<Buffer>` — Creates `engine.key` (32 random bytes, mode `0o600`) using `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW` so planted symlinks fail closed.
   - `export async function readEngineKey(stateDir: string): Promise<Buffer | undefined>` — Reads `engine.key` without creating it (`O_RDONLY | O_NOFOLLOW`).
   - `export function sealMeta(meta: Record<string, unknown>, key: Buffer): string` — Canonical JSON (lexicographically sorted keys) HMAC-SHA256 hex digest over `meta` (excluding `seal`).
   - `export function verifyMetaSeal(meta: Record<string, unknown>, key: Buffer): boolean` — Constant-time `timingSafeEqual` verification of `meta.seal`.
3. **`src/cache.ts`:**
   - `export async function putCachedSource(cacheDir: string, stateDir: string, input: { url: string; title: string; content: string; fetchedAt?: string }): Promise<{ sha256: string; seal: string; metaPath: string; contentPath: string }>`:
     - Computes `sha256` of `input.content`. Writes `<cacheDir>/<sha256>.md` and `<cacheDir>/<sha256>.json` containing `{ sha256, url, title, fetchedAt, seal }` signed with `ensureEngineKey(stateDir)`.
   - `export async function getCachedSource(cacheDir: string, stateDir: string, sha256: string): Promise<{ content: string; meta: Record<string, unknown> }>`:
     - Verifies that `sha256(content) === sha256` AND `verifyMetaSeal(meta, key) === true`. Throws `TamperedSourceError` if an unsealed or modified file was planted in `cacheDir`!
4. **`src/auditor.ts`:**
   - Audits markdown lines containing claims:
     - `[VERIFIED: sha256:<64-hex> "<quote>"]`: Loads `<64-hex>` via `getCachedSource` and runs `verifyQuote(source.content, quote)`.
     - `[INFERRED: <reasoning>]`, `[HYPOTHESIS: <falsification>]`, `[NEGATIVE_KNOWLEDGE: <query>]`.
   - `export async function auditResearchMarkdown(markdown: string, cacheDir: string, stateDir: string): Promise<{ passed: boolean; verifiedCount: number; failures: Array<{ line: number; text: string; reason: string }>; prunedMarkdown: string }>`:
     - Any `[VERIFIED]` line whose source is missing, unsealed, or fails `verifyQuote` is recorded in `failures` and moved to a `## Pruned claims` section at the bottom of `prunedMarkdown`.
5. **`src/mcp-server.ts`:**
   - Standard MCP stdio JSON-RPC 2.0 server (`initialize`, `tools/list`, `tools/call`) exposing 4 tools: `cache_source`, `verify_quote`, `locate_quote`, and `audit_markdown`.

---

### 2.2 Wave 2 Specification: `packages/core` (State Machine, Ed25519 Approvals, Red/Green & Mutation Gates)

1. **`src/approval/ed25519.ts`:**
   - Uses `node:crypto` (`generateKeyPairSync("ed25519")`, `scryptSync`, `createCipheriv("aes-256-gcm")`, `sign`, `verify`).
   - `sealHumanKey(keyDir: string, passphrase: string): Promise<{ publicKeyHex: string; fingerprint: string }>` — Encrypts private key with `scrypt` + `aes-256-gcm` using passphrase; writes `human.key.enc` (`0o600`) and `human.pub`.
   - `signStageApproval(keyDir: string, passphrase: string, payload: { runId: string; stage: "GRILL" | "SPEC" | "WAIVER" | "TRUST"; subjectHash: string; timestamp: string }): Promise<SignedApprovalRecord>`
   - `verifyStageApproval(keyDir: string, record: SignedApprovalRecord, expectedStage: string, expectedSubjectHash: string): boolean` — Verifies Ed25519 signature against `human.pub` and checks `subjectHash === expectedSubjectHash`.
2. **`src/factory/frontier.ts`:**
   - Manages `frontier.json` (`{ version: 1, idea: string, deltaFromHead: string, rounds: Array<{ round: number; decisions: Array<{ id: string; question: string; answer: string }> }> }`).
   - `saveFrontier(prev: Frontier | undefined, next: Frontier)` — Refuses empty `deltaFromHead` (*"Context-only ideas without a concrete behavioral delta from HEAD are refused"*), refuses deletion of any prior decision ID, and refuses round number regression.
3. **`src/factory/machine.ts`:**
   - Deterministic state machine over states:
     `IDLE` $\rightarrow$ `GRILL` $\rightarrow$ `RESEARCH` $\rightarrow$ `SPEC` $\rightarrow$ `BUILD_TDD_RED` $\rightarrow$ `BUILD_TDD_GREEN` $\rightarrow$ `GATE_MUTATION` $\rightarrow$ `QA_DUAL_EVAL` $\rightarrow$ `DONE` (plus `HALTED`).
   - Hard transition guards:
     - `GRILL -> RESEARCH`: Requires valid `frontier.json` AND human Ed25519 signature over `sha256(frontier.json)`.
     - `RESEARCH -> SPEC`: Requires `auditResearchMarkdown` `passed === true` with `verifiedCount >= 1`.
     - `SPEC -> BUILD_TDD_RED`: Requires non-empty spec file AND human Ed25519 signature over `sha256(spec.md)`.
     - `BUILD_TDD_RED -> BUILD_TDD_GREEN`: Requires mechanical test execution result with `exitCode !== 0` (`failedTests >= 1`). If `exitCode === 0`, throws `RedFirstViolationError`! Records the SHA-256 manifest of all test files (`lockTestManifest`).
     - `BUILD_TDD_GREEN -> GATE_MUTATION`: Verifies `verifyTestManifestUnchanged` (throws `TestTamperingError` if programmer modified or deleted any test file from the RED phase!) AND requires mechanical test execution `exitCode === 0`.
     - `GATE_MUTATION -> QA_DUAL_EVAL`: Requires `mutationScore >= 0.85` (85% mutants killed).
     - `QA_DUAL_EVAL -> DONE`: Requires both `qaFunctionalVerdict === "PASS"` and `qaAdversarialVerdict === "PASS"`, plus `assertModelDiversity(qaFuncModel, qaAdvModel, programmerModel)` (refuses if QA judges and programmer all use the identical model string without diversity override).
     - `.factory/STOP` kill-file presence or `spendUSD > ceilingUSD` immediately transitions any state to `HALTED`.
4. **`src/gates/mutation.ts` & `src/gates/engine.ts`:**
   - `generateSourceMutants(code: string): Array<{ id: string; line: number; original: string; mutated: string }>` — Generates deterministic syntactic mutants (swapping `===` $\leftrightarrow$ `!==`, `>=` $\leftrightarrow$ `<`, `true` $\leftrightarrow$ `false`, `&&` $\leftrightarrow$ `||`).
   - `runMutationGate(worktreeDir: string, targetFiles: string[], testCmd: string[]): Promise<{ score: number; killed: number; survived: number; passed: boolean }>` — Applies each mutant one at a time, runs `testCmd`, counts mutant as `killed` if `testCmd` exits non-zero, restores original file immediately in `finally`, and passes only if `score >= 0.85`.

---

### 2.3 Wave 3 Specification: `packages/cli` (`es` CLI & `.worktreeinclude`)
- `src/worktree-include.ts`: Parses `.worktreeinclude` (gitignore-style patterns like `.env`, `.env.local`, `certs/*.pem`) and copies matching untracked files from a base repo into an isolated worktree without git staging them.
- `src/bin.ts`: Implements `es` CLI subcommands (`es key seal`, `es init`, `es status`, `es approve`, `es audit-research`, `es gate-mutation`) with exit code `0` on success and `1` on gate/verification failure.

---

## 3. WAVE-BY-WAVE TRIAD EXECUTION PLAN FOR `agency-coordinator`

### Step 0 (Coordinator Bootstrap on `main`)
1. Write `AGENTS.md`, `docs/prompts/SPEC.md`, `docs/prompts/verify-stage.md`, `.pre-commit-config.yaml`, `bundles/default.bundle.json`, `Makefile`, root `package.json`, and `tsconfig.json`.
2. Commit baseline scaffolding to `main`.

### Wave 1: `packages/epistemic-verifier-mcp` (Quote, Seal, Cache, Auditor & MCP Server)
1. Create worktree: `git worktree add -b wave-1-epistemic-verifier worktrees/wave-1 main`
2. Dispatch **Programmer (`agency-programmer`)**:
```json
{
  "agent": "agency-programmer",
  "description": "Wave 1 Programmer: Implement @heretek-ai/epistemic-verifier-mcp",
  "prompt": "You are the Programmer Agent for Wave 1 in `/home/john/Projects/Heretek-AI-Rebuild/epistemic-factory/worktrees/wave-1` on branch `wave-1-epistemic-verifier`.\n\nFIRST: Read `AGENTS.md` and `docs/prompts/SPEC.md` in full.\nSECOND: Implement `packages/epistemic-verifier-mcp`:\n1. `src/quote.ts` (`MIN_QUOTE = 12`, `normalizeForQuote`, `verifyQuote`, `normalizeWithMap`, `locateQuote`).\n2. `src/seal.ts` (`ensureEngineKey` with `O_CREAT|O_EXCL|O_NOFOLLOW`, `readEngineKey`, `sealMeta`, `verifyMetaSeal` with `timingSafeEqual`).\n3. `src/cache.ts` (`putCachedSource`, `getCachedSource` refusing unsealed or tampered files).\n4. `src/auditor.ts` (`auditResearchMarkdown` verifying `[VERIFIED: sha256:... \"...\"]` and pruning ungrounded claims).\n5. `src/mcp-server.ts` (stdio JSON-RPC 2.0 MCP server exposing `cache_source`, `verify_quote`, `locate_quote`, `audit_markdown`).\n6. Write full unit tests in `packages/epistemic-verifier-mcp/test/` and acceptance script `scripts/accept/wave-1.sh`.\n7. Write `docs/reports/wave-1.md`, verify `bun test` and `bun run check` pass, and commit."
}
```
3. Dispatch **QA (`agency-qa`)** to run `make check`, `bash scripts/accept/wave-1.sh`, and perform Red-Proof Sabotage (tamper with a cached `.md` file without updating `engine.key` HMAC seal, verify `getCachedSource` throws, and test that a 1-word altered quote fails `verifyQuote`). Log to `docs/evidence/wave-1/red-proofs.log`.
4. Dispatch **Drift Guard (`agency-drift-guard`)** to audit Wave 1 and write `docs/reports/wave-1-verification.md` (`VERDICT: PASS`).
5. Merge `wave-1-epistemic-verifier` to `main` and remove worktree.

### Wave 2: `packages/core` (Ed25519 Approvals, Frontier Graph, State Machine, Red-First Lock & Mutation Gate)
1. Create worktree: `git worktree add -b wave-2-factory-core worktrees/wave-2 main`
2. Dispatch **Programmer (`agency-programmer`)** to implement `packages/core/src/approval/ed25519.ts`, `src/factory/frontier.ts`, `src/factory/machine.ts`, `src/gates/test-lock.ts`, `src/gates/mutation.ts`, `src/gates/engine.ts`, full unit tests in `packages/core/test/`, `scripts/accept/wave-2.sh`, and `docs/reports/wave-2.md`.
3. Dispatch **QA (`agency-qa`)** to verify and red-proof Wave 2 (sabotage `machine.ts` to allow `BUILD_TDD_RED -> BUILD_TDD_GREEN` when `exitCode === 0` and confirm tests catch it; sabotage a test file during `BUILD_TDD_GREEN` and confirm `TestTamperingError` fires). Log to `docs/evidence/wave-2/red-proofs.log`.
4. Dispatch **Drift Guard (`agency-drift-guard`)** to audit Wave 2 and issue `VERDICT: PASS` in `docs/reports/wave-2-verification.md`.
5. Merge `wave-2-factory-core` to `main` and remove worktree.

### Wave 3: `packages/cli` (`es` CLI + `.worktreeinclude` Sync) & End-to-End Dogfood Verification
1. Create worktree: `git worktree add -b wave-3-es-cli worktrees/wave-3 main`
2. Dispatch **Programmer (`agency-programmer`)** to implement `packages/cli/src/worktree-include.ts`, `packages/cli/src/bin.ts`, `packages/cli/test/cli.test.ts`, `scripts/accept/wave-3.sh`, `README.md`, and `docs/reports/wave-3.md`.
3. Dispatch **QA (`agency-qa`)** and **Drift Guard (`agency-drift-guard`)** to verify and red-proof Wave 3 (`VERDICT: PASS`).
4. Merge `wave-3-es-cli` to `main`, remove worktree, and verify `make check && make accept` exits 0 on `main`.
