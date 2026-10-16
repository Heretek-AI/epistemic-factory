#!/usr/bin/env bash
# Acceptance for Wave 3: @heretek-ai/es-cli (`es` CLI + `.worktreeinclude`).
# Exits 0 only if unit tests, typecheck, and a live CLI smoke test
# (help, init, status, key seal + approve, audit-research pass/fail,
# gate-mutation pass/fail, runner advance/run refusals) all pass; 1 otherwise.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() { echo "wave-3 accept FAILED: $1" >&2; exit 1; }

echo "--- wave-3: unit tests ---"
bun test packages/cli || fail "bun test"

echo "--- wave-3: typecheck ---"
bunx --bun tsc --noEmit -p packages/cli || fail "tsc --noEmit (package)"
bunx --bun tsc --noEmit || fail "tsc --noEmit (root)"

echo "--- wave-3: CLI smoke via the real es entrypoint ---"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ES="bun ./packages/cli/src/bin.ts"

$ES --help > /dev/null || fail "es --help"
if $ES frobnicate > /dev/null 2>&1; then fail "unknown command must exit 1"; fi

$ES init --dir "$TMP/proj" || fail "es init"
test -f "$TMP/proj/.worktreeinclude" || fail "init writes .worktreeinclude"
test -f "$TMP/proj/frontier.json" || fail "init writes frontier.json"
test -d "$TMP/proj/.factory" || fail "init writes .factory/"
if $ES init --dir "$TMP/proj" > /dev/null 2>&1; then fail "second init without --force must exit 1"; fi
$ES status --dir "$TMP/proj" > /dev/null || fail "es status"

echo "--- wave-3: key seal + approve smoke ---"
$ES key seal --key-dir "$TMP/keys" --passphrase "accept-smoke-passphrase" > /dev/null || fail "es key seal"
SUBJECT="$(sha256sum "$TMP/proj/frontier.json" | cut -d' ' -f1)"
$ES approve --stage GRILL --subject "$SUBJECT" --run-id smoke-1 --key-dir "$TMP/keys" --passphrase "accept-smoke-passphrase" --dir "$TMP/proj" > /dev/null || fail "es approve"
test -f "$TMP/proj/.factory/approvals/GRILL-smoke-1.json" || fail "approve stores record"

echo "--- wave-3: audit-research smoke (real sealed cache) ---"
export TMP
bun -e '
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { putCachedSource } from "./packages/epistemic-verifier-mcp/src/cache.ts";
const tmp = process.env.TMP ?? "";
const content = "The quick brown fox jumps over the lazy dog near the riverbank at dawn.";
const put = await putCachedSource(path.join(tmp, "cache"), path.join(tmp, "state"), { url: "https://example.com/fox", title: "Fox", content });
await writeFile(path.join(tmp, "good.md"), `Claim [VERIFIED: sha256:${put.sha256} "quick brown fox jumps"] holds.\n`);
await writeFile(path.join(tmp, "bad.md"), `Claim [VERIFIED: sha256:${put.sha256} "purple elephant parades loudly"] holds.\n`);
console.log("seeded", put.sha256);
' || fail "cache seeding"
$ES audit-research --markdown "$TMP/good.md" --cache-dir "$TMP/cache" --state-dir "$TMP/state" || fail "grounded audit must exit 0"
if $ES audit-research --markdown "$TMP/bad.md" --cache-dir "$TMP/cache" --state-dir "$TMP/state" > /dev/null 2>&1; then fail "ungrounded audit must exit 1"; fi

echo "--- wave-3: gate-mutation smoke (trivial target) ---"
mkdir -p "$TMP/gate"
printf 'export function eq(a: number, b: number): boolean {\n  return a === b;\n}\n' > "$TMP/gate/target.ts"
$ES gate-mutation --dir "$TMP/gate" --files target.ts -- false || fail "killed mutants must exit 0"
if $ES gate-mutation --dir "$TMP/gate" --files target.ts -- true > /dev/null 2>&1; then fail "surviving mutants must exit 1"; fi

echo "--- wave-3: runner smoke (es advance / es run fail closed) ---"
if $ES advance --dir "$TMP/proj" --redExitCode 1 > /dev/null 2>&1; then fail "advance must refuse evidence flags"; fi
if $ES advance --dir "$TMP/proj" > "$TMP/advance.out" 2>&1; then fail "advance without .factory/config.json must exit 1"; fi
grep -q "config.json" "$TMP/advance.out" || fail "advance refusal names the missing config"
if $ES run --dir "$TMP/proj" > /dev/null 2>&1; then fail "run must stop at the first refusal with exit 1"; fi
$ES status --dir "$TMP/proj" | grep -q "state=IDLE" || fail "status shows the persisted run state"
touch "$TMP/proj/.factory/STOP"
if $ES advance --dir "$TMP/proj" > /dev/null 2>&1; then fail "STOP file must force HALTED (exit 1)"; fi
$ES status --dir "$TMP/proj" | grep -q "state=HALTED" || fail "STOP halts the persisted run"

echo "wave-3 accept PASSED"
