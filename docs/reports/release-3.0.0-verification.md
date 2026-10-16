# Release 3.0.0 — Drift Guard Verification Report

Branch: `release-3.0.0` | Worktree: `worktrees/release-3` | Date: 2026-10-16 UTC
Auditor: agency-drift-guard (Muse Spark 1.3 Contributor, adversarial).
Scope read in full from disk: `AGENTS.md`, `docs/reports/release-3.0.0.md`,
`docs/evidence/release-3/red-proofs.log`.
Write discipline: production source untouched (read-only); this report is the
only file written by the auditor.

## 1. Packaging-diff audit (vs `main`) — PASS

- `git diff main --stat`: 19 files. New: `LICENSE` ×4, `biome.json`,
  `docs/evidence/release-3/red-proofs.log` (QA), `docs/reports/release-3.0.0.md`,
  per-package `tsconfig.build.json` ×3, `scripts/fix-dist-bins.mjs`.
  Modified: root `package.json` (+`build` script only), 3 package.json
  (publish metadata), `bun.lock` (version/bin-path refresh),
  `packages/cli/src/bin.ts`, `packages/cli/src/index.ts` (comment only),
  `packages/epistemic-verifier-mcp/src/mcp-server.ts`.
- `git diff main -- <src files>`: ONLY (a) shebang `bun`→`node` in
  `cli/src/bin.ts`, added `#!/usr/bin/env node` in `mcp-server.ts`;
  (b) dual-runtime `isMain()` guards in both entrypoints;
  (c) `SERVER_VERSION` `"0.0.0"`→`"3.0.0"`; (d) one guard comment in
  `cli/src/index.ts`. NO gate/auditor/quote/seal/cache/frontier/machine
  logic changes. Accept scripts and `Makefile` byte-identical to `main`.
- No `packages/fleet`, `packages/web`, `queereye`, `brainstorm`, `harvest`
  exist or were added (`ls packages/` → `cli core epistemic-verifier-mcp`).

## 2. Security invariants intact — PASS

| Invariant | Evidence (file:line) | Status |
|---|---|---|
| 0600 `engine.key`, `O_EXCL`/`O_NOFOLLOW` create+read | `packages/epistemic-verifier-mcp/src/seal.ts:83-84,102,112,138` | HOLD |
| HMAC-SHA256 + `timingSafeEqual` seal verify | `seal.ts:8,177,195` | HOLD |
| NFKC + typography fold, `MIN_QUOTE = 12` | `packages/epistemic-verifier-mcp/src/quote.ts:12,64-65,113-122` | HOLD |
| RED-first throw | `packages/core/src/factory/machine.ts:364` (`RED_FIRST_VIOLATION`) | HOLD |
| SHA-256 test-tree manifest lock | `packages/core/src/gates/test-lock.ts:13,97,111-124` | HOLD |
| 0.85 mutation threshold | `packages/core/src/gates/mutation.ts:26` (`MUTATION_THRESHOLD = 0.85`) | HOLD |
| Ed25519 `verify` approval check | `packages/core/src/approval/ed25519.ts:326-381` | HOLD |

- `isMain()` guards are fail-closed (`catch { return false; }` in both
  entrypoints); `node dist/bin.js` library import verified side-effect free.
- `scripts/fix-dist-bins.mjs` is fail-closed (refuses empty/non-file bins,
  `process.exit(1)` paths at lines 48, 58).
- Stub scan: zero `TODO`/`FIXME`/`not implemented`/placeholder/`cmd:"true"`/
  `echo "pass"` in shipped source; the only `TODO` strings are the
  pre-existing intentional `es init` frontier.json scaffold contents
  (`packages/cli/src/bin.ts:220,222`), documented and out of the pack path.

## 3. Publish metadata — PASS

- `"version": "3.0.0"` ×3, no `"private"` field in any package (grep exit 1).
- `"license": "Apache-2.0"` ×3; `LICENSE` present at root + per package,
  byte-identical (sha256 `01529830…6043497` ×4).
- `"publishConfig": { "access": "public", "provenance": true }` ×3.
- `"files": ["dist", "README.md", "LICENSE*"]` ×3; independent
  `npm pack --dry-run` (cli) → 9 files, 14.9 kB, dist+README+LICENSE+
  package.json only — matches QA's recorded lists for all three.
- No `workspace:*` remains (grep exit 1); cli sibling deps `^3.0.0` ×2.
- `bin` → `./dist/bin.js` / `./dist/mcp-server.js`, both `#!/usr/bin/env node`
  + mode `755` in built dist.

## 4. License mirroring claim — PLAUSIBLE

- Referenced origin `/home/john/Projects/IUMBTEMS/LICENSE` exists, header
  reads Apache License Version 2.0 (4 `Apache License` hits). Full text not
  reproduced here. Human confirmation before `npm publish` still requested
  per programmer report §6 (not an audit failure).

## 5. QA evidence cross-check — PASS

- `bun run check` re-run by auditor → exit 0 (123 pass / 0 fail / 639 expects;
  `tsc --noEmit` clean; biome 38 files clean). Matches red-proofs.log §1.
- Plain-`node` smoke re-run: 3 dist imports clean (26/23/20 exports);
  `bin.js --help` exit 0; `bin.js frobnicate` exit 1; MCP `initialize` →
  `serverInfo: { name: "epistemic-verifier", version: "3.0.0" }`.
- Registry slots: QA recorded 404 (free) for all three 3.0.0 names;
  no publish/push/merge performed (no tags at HEAD, branch unpushed).
- Independent sabotage replication against built dist (plain `node`):
  - A: ungrounded VERIFIED claim → `{passed:false, verifiedCount:0,
    pruned:true}` — FAIL-CLOSED, not vacuous.
  - B: genuine quote → `{ok:true, index:31}`; 1-word mutant →
    `{ok:false, reason:'not found verbatim…'}` — control holds.
  Both QA red-proofs independently confirmed.

## FINDINGS

NONE. Zero stubs, zero scope bleed, zero invariant regressions, zero
metadata defects.

## Binding verdict

`VERDICT: PASS`
