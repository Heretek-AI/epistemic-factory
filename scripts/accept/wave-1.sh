#!/usr/bin/env bash
# Acceptance for Wave 1: @heretek-ai/epistemic-verifier-mcp.
# Exits 0 only if unit tests, typecheck, and a sealed put/get/audit
# round-trip (including tamper refusal) all pass; 1 otherwise.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() { echo "wave-1 accept FAILED: $1" >&2; exit 1; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
export TMP

echo "--- wave-1: unit tests ---"
bun test packages/epistemic-verifier-mcp || fail "bun test"

echo "--- wave-1: typecheck ---"
bunx --bun tsc --noEmit -p packages/epistemic-verifier-mcp || fail "tsc --noEmit (package)"
bunx --bun tsc --noEmit || fail "tsc --noEmit (root)"

echo "--- wave-1: sealed put/get/audit round-trip ---"
bun -e '
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditResearchMarkdown } from "./packages/epistemic-verifier-mcp/src/auditor.ts";
import { getCachedSource, putCachedSource, TamperedSourceError } from "./packages/epistemic-verifier-mcp/src/cache.ts";
import { verifyQuote } from "./packages/epistemic-verifier-mcp/src/quote.ts";

const assert = (cond, msg) => { if (!cond) { console.error(`ROUNDTRIP FAIL: ${msg}`); process.exit(1); } };
const root = await mkdtemp(path.join(tmpdir(), "wave1-accept-"));
const cacheDir = path.join(root, "cache");
const stateDir = path.join(root, "state");
const content = "The quick brown fox jumps over the lazy dog near the riverbank at dawn.";

const put = await putCachedSource(cacheDir, stateDir, { url: "https://example.com/fox", title: "Fox", content });
assert(typeof put.sha256 === "string" && put.sha256.length === 64, "put returns sha256");
const got = await getCachedSource(cacheDir, stateDir, put.sha256);
assert(got.content === content, "get returns exact content");
assert(verifyQuote(got.content, "quick brown fox jumps").ok, "verifyQuote passes");

const good = await auditResearchMarkdown(`Claim [VERIFIED: sha256:${put.sha256} "quick brown fox jumps"] yes.`, cacheDir, stateDir);
assert(good.passed && good.verifiedCount === 1, "audit passes grounded doc");

const bad = await auditResearchMarkdown(`Claim [VERIFIED: sha256:${put.sha256} "purple elephant parades"] no.`, cacheDir, stateDir);
assert(!bad.passed && bad.failures.length === 1 && bad.prunedMarkdown.includes("## Pruned claims"), "audit prunes ungrounded claim");

// Tamper with the cached bytes without touching the seal: reads must refuse.
const { writeFile } = await import("node:fs/promises");
await writeFile(put.contentPath, "FORGED CONTENT PLANTED WITHOUT A SEAL");
let threw = null;
try { await getCachedSource(cacheDir, stateDir, put.sha256); } catch (e) { threw = e; }
assert(threw instanceof TamperedSourceError, "tampered entry throws TamperedSourceError");
console.log("round-trip OK");
' || fail "sealed round-trip"

echo "--- wave-1: MCP stdio smoke test ---"
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"verify_quote","arguments":{"source":"The quick brown fox jumps over","quote":"quick brown fox jumps"}}}' \
  | bun ./packages/epistemic-verifier-mcp/src/mcp-server.ts > "$TMP/wave1-mcp-out.jsonl" || fail "mcp server run"
bun -e '
import { readFileSync } from "node:fs";
const lines = readFileSync(`${process.env.TMP}/wave1-mcp-out.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const assert = (cond, msg) => { if (!cond) { console.error(`MCP FAIL: ${msg}`); process.exit(1); } };
assert(lines.length === 3, `expected 3 responses, got ${lines.length}`);
assert(lines[0].result.serverInfo.name === "epistemic-verifier", "initialize serverInfo");
assert(lines[1].result.tools.map((t) => t.name).join(",") === "cache_source,verify_quote,locate_quote,audit_markdown", "4 tools listed");
const payload = JSON.parse(lines[2].result.content[0].text);
assert(payload.ok === true, "verify_quote tool call ok");
console.log("mcp smoke OK");
' || fail "mcp smoke assertions"

echo "wave-1 accept PASSED"
