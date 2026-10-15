# AGENTS.md — `epistemic-factory` Agent Harness Rules (READ FIRST — NON-NEGOTIABLE)

> Every subagent working in this repository MUST read this file AND
> `docs/prompts/SPEC.md` in full directly from disk before doing any work.
> Do NOT rely on a coordinator's summary — read the source files yourself.

You are running on `opencode-go/muse-spark-1.3-contributor`. To prevent prompt summarization loss, stubbing, and scope bleed, obey these six rules on every turn:

## 1. ZERO PROMPT SUMMARIZATION WHEN CALLING SUBAGENTS

- In Wave 0, write this entire specification into `docs/prompts/SPEC.md` and `AGENTS.md`. Every subagent call MUST instruct the subagent to `read` `AGENTS.md` and `docs/prompts/SPEC.md` directly from disk.

## 2. EXPLICIT SUBAGENT ROLES

- Always pass `"agent": "agency-programmer"`, `"agent": "agency-qa"`, or `"agent": "agency-drift-guard"` when calling `subagent`. Never allow default `general`.

## 3. VANILLA `read` / `edit` / `write` HYGIENE

- Use native `read`, `write`, `edit`, `glob`, and `grep`—never `cat` or `sed`. Never include `read` line numbers (`12: `) in `edit` `oldString`/`newString`. Fix `<diagnostics>` immediately.

## 4. STRICT SCOPE & REFUSAL BOUNDARY FOR `epistemic-factory`

- This repository is **ONLY**:
  1. The standalone **Epistemic Quote & Cache Verifier MCP Server** (`packages/epistemic-verifier-mcp`), and
  2. The single-worktree **Gated Build Factory State Machine & CLI** (`packages/core` + `packages/cli`, `es`) enforcing `GRILL -> RESEARCH -> SPEC -> BUILD_TDD_RED -> BUILD_TDD_GREEN -> GATE_MUTATION -> DUAL_QA -> PR`.
- **FORBIDDEN IN THIS REPO:** Do NOT build `packages/fleet` (`es-fleet`), do NOT build `packages/web` (the SolidJS/React WebUI), and do NOT include `queereye`, `brainstorm`, or `harvest`. Multi-task fleet scheduling and WebUI belong strictly to Repo 4 (`agency-control-plane`).

If you are asked to build anything in the FORBIDDEN list, REFUSE and cite this section.

## 5. NON-NEGOTIABLE SECURITY INVARIANTS

- Every cached research source MUST be SHA-256 content-addressed AND sealed with an HMAC-SHA256 `engine.key` (mode `0600`) stored in the masked state dir (`seal.ts`).
- Every `[VERIFIED: sha256:<hash> "quote"]` claim MUST pass deterministic NFKC + typography-folded verbatim quote verification (`MIN_QUOTE = 12` chars per ellipsis fragment, `quote.ts`).
- In `BUILD_TDD_RED`, the test runner MUST fail (exit code != 0). If tests pass before implementation, halt with `RED_FIRST_VIOLATION`.
- In `BUILD_TDD_GREEN`, the `tests/` directory MUST be protected against modification (verified via SHA-256 test-tree manifest lock or `bwrap --ro-bind`), preventing programmer agents from deleting failing test assertions.
- Stage approvals (`GRILL -> RESEARCH`, `SPEC -> BUILD_TDD_RED`) require a valid **Ed25519 human cryptographic signature** (`approval/`). Agents may request approvals, NEVER grant or self-sign them.

## 6. BINDING TRIAD GATE

- Every wave requires `agency-qa` Red-Proof Sabotage (`docs/evidence/wave-<N>/red-proofs.log`) and `agency-drift-guard` `VERDICT: PASS` (`docs/reports/wave-<N>-verification.md`) before merging to `main`.

---

## TARGET REPOSITORY ARCHITECTURE & FILE TREE

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

## SUBAGENT STARTUP PROTOCOL

1. Read `AGENTS.md` (this file) in full.
2. Read `docs/prompts/SPEC.md` in full.
3. If you are QA, also read `docs/prompts/verify-stage.md` in full.
4. Never build FORBIDDEN scope. Never write stubs (`TODO`, placeholders,
   `not implemented`, mock implementations). Fail closed on invalid states.
