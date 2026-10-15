# Wave 1 Implementation Report — `@heretek-ai/epistemic-verifier-mcp`

- **Stage ID:** Wave 1 (Quote, Seal, Cache, Auditor & MCP Server)
- **Branch:** `wave-1-epistemic-verifier`
- **Worktree:** `/home/john/Projects/Heretek-AI-Rebuild/epistemic-factory/worktrees/wave-1`
- **Date:** 2026-10-15

## Summary of deliverables

Implemented `packages/epistemic-verifier-mcp` exactly per SPEC §2.1, with zero stubs
and fail-closed behavior throughout:

1. **`src/quote.ts`** — `MIN_QUOTE = 12`; `normalizeForQuote` (NFKC, curly-quote /
   dash / special-space folds via explicit code-point classes, Markdown link-label
   stripping, `**`/`__`/backtick` removal, whitespace collapse + trim);
   `verifyQuote` (splits prose quotes on `...` / `…`, every fragment ≥ 12
   normalized chars, strict sequential order scan); `normalizeWithMap` (per-char
   NFKC + index map with contract `normalizeWithMap(x).text ===
   normalizeForQuote(x)`); `locateQuote` (maps verified fragments back to exact
   `[start, end]` original offsets, self-checks each range normalizes back to its
   fragment, returns `undefined` on any divergence — never a wrong highlight).
2. **`src/seal.ts`** — `ensureEngineKey` (32 random bytes, mode `0o600`,
   `O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW` so planted symlinks fail closed with
   `EEXIST`/`ELOOP` fallback to a no-follow read-back under an advisory lock);
   `readEngineKey` (`O_RDONLY | O_NOFOLLOW`, never creates); `sealMeta`
   (canonical recursively key-sorted JSON, HMAC-SHA256 hex, `seal` excluded);
   `verifyMetaSeal` (constant-time `timingSafeEqual`, fail-closed on missing /
   non-string / truncated seals).
3. **`src/cache.ts`** — `putCachedSource` (sha256 of exact content bytes, atomic
   write of `<sha256>.md` + sealed `<sha256>.json` `{ sha256, url, title,
   fetchedAt, seal }` via `ensureEngineKey`); `getCachedSource` (verifies
   `sha256(content) === address` AND `verifyMetaSeal`, plus regular-file
   `O_NOFOLLOW` assertions; throws `TamperedSourceError` on missing / malformed /
   unsealed / forged / wrong-key entries — never mints a key to verify).
4. **`src/auditor.ts`** — `auditResearchMarkdown` parses `[VERIFIED:
   sha256:<64-hex> "<quote>"]` (straight or curly quotes, depth-matched brackets),
   loads each source via `getCachedSource`, runs `verifyQuote`; `[INFERRED:]`,
   `[HYPOTHESIS:]`, `[NEGATIVE_KNOWLEDGE:]` pass through untouched (counted as
   non-failures, never verified). Failing lines are recorded in `failures` and
   moved to a `## Pruned claims` section; `passed` requires ≥ 1 grounded VERIFIED
   claim and zero failures. Fenced code blocks, headings, and pre-existing prune
   sections are skipped; malformed near-miss `[VERIFIED` spans fail closed.
5. **`src/mcp-server.ts`** — stdio newline-delimited JSON-RPC 2.0 server with no
   external SDK (node builtins only): `initialize`, `ping`, `tools/list`,
   `tools/call` with correct result/error envelopes, notifications ignored;
   4 tools `cache_source`, `verify_quote`, `locate_quote`, `audit_markdown`
   (dirs resolve from args → `EPISTEMIC_CACHE_DIR`/`EPISTEMIC_STATE_DIR` env →
   `./.epistemic-cache`/`./.epistemic-state`).
6. **`src/index.ts`** — re-exports all public symbols (value + type) without side
   effects on import (type-only MCP surface; importing never starts the server).
7. **Tests** (`bun:test`, genuine assertions, zero stubs): `test/quote.test.ts`
   (folding, MIN_QUOTE, ellipsis order incl. reversed/repeated-fragment cases,
   map/text contract battery, offset + self-check asserts), `test/seal-cache.test.ts`
   (0600 creation + key stability, no-mint read, symlink fail-closed, canonical
   round-trip, tamper/wrong-key/missing/malformed → `TamperedSourceError`),
   `test/auditor.test.ts` (pass, ellipsis, typography tolerance, altered-quote /
   missing-source / tampered-entry / malformed / short-quote pruning with
   `## Pruned claims` asserts, passthrough tags, fenced-code ignore).
8. **Acceptance** `scripts/accept/wave-1.sh` (executable): unit tests + package &
   root `tsc --noEmit` + sealed put/get/audit round-trip incl. tamper refusal +
   MCP stdio smoke test; exit 0 only if all pass.
9. **Package config:** `package.json` (`@heretik-ai` → `@heretek-ai/epistemic-verifier-mcp`,
   `type: module`, `exports`, `bin`, `test`/`check` scripts), `tsconfig.json`
   include of `src`+`test`.

Out of scope untouched: `packages/core`, `packages/cli` (Wave 2/3), forbidden
`packages/fleet` / `packages/web` not built.

## Files created / modified

Created:
- `packages/epistemic-verifier-mcp/src/quote.ts`
- `packages/epistemic-verifier-mcp/src/seal.ts`
- `packages/epistemic-verifier-mcp/src/cache.ts`
- `packages/epistemic-verifier-mcp/src/auditor.ts`
- `packages/epistemic-verifier-mcp/src/mcp-server.ts`
- `packages/epistemic-verifier-mcp/src/index.ts`
- `packages/epistemic-verifier-mcp/test/quote.test.ts`
- `packages/epistemic-verifier-mcp/test/seal-cache.test.ts`
- `packages/epistemic-verifier-mcp/test/auditor.test.ts`
- `scripts/accept/wave-1.sh`
- `docs/reports/wave-1.md` (this file)

Modified:
- `packages/epistemic-verifier-mcp/package.json` (name/exports/bin/scripts)
- `packages/epistemic-verifier-mcp/tsconfig.json`
- `package.json`, `tsconfig.json`, `bun.lock` (workspace scaffold alignment)
- import/export ordering fixes via `biome check --write` (no logic changes)

## Test results

- `bun test packages/epistemic-verifier-mcp`: **60 pass, 0 fail** (434 expects, 3 files)
- `bun run check` (`bun test` + `tsc --noEmit` + `biome check .`): **exit 0**
- `bash scripts/accept/wave-1.sh`: **PASSED** (unit tests + typecheck +
  sealed round-trip incl. `TamperedSourceError` on planted bytes + MCP stdio
  smoke: initialize/tools-list/verify_quote) — exit 0
- Stub scan (`TODO|placeholder|not implemented|mock` over src+test): clean

## Self-audit notes / security invariants verified

- `engine.key` created `0o600`, `O_EXCL|O_NOFOLLOW`; planted symlink → both
  `ensureEngineKey` and `readEngineKey` throw (tested).
- `readEngineKey` never mints (missing key → `undefined`, no file created).
- Every cache read enforces content-hash match AND HMAC seal under the state-dir
  key; wrong-key and no-key states throw `TamperedSourceError` (tested).
- Every VERIFIED fragment ≥ 12 normalized chars; one-word alterations fail
  `verifyQuote` (no fuzzy matching); out-of-order ellipsis fails; `locateQuote`
  self-checks ranges (tested).
- Auditor fails closed on malformed hashes/quotes and prunes (never re-tags or
  silently drops); passthrough tags never verify and never fail the audit alone.
- MCP server uses only node builtins; unknown tools/methods return JSON-RPC
  errors, never throw the transport.
