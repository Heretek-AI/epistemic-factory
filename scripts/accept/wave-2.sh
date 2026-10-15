#!/usr/bin/env bash
# Acceptance for Wave 2: @heretek-ai/es-core.
# Exits 0 only if unit tests, typecheck, a RED-first guard demo
# (RedFirstViolationError), and a test-tamper demo (TestTamperingError)
# all pass; 1 otherwise.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

fail() { echo "wave-2 accept FAILED: $1" >&2; exit 1; }

echo "--- wave-2: unit tests ---"
bun test packages/core || fail "bun test"

echo "--- wave-2: typecheck ---"
bunx --bun tsc --noEmit -p packages/core || fail "tsc --noEmit (package)"
bunx --bun tsc --noEmit || fail "tsc --noEmit (root)"

echo "--- wave-2: RED-first demo (exitCode 0 must throw RedFirstViolationError) ---"
bun -e '
import { canTransition, RedFirstViolationError } from "./packages/core/src/factory/machine.ts";

const assert = (cond, msg) => { if (!cond) { console.error(`RED-FIRST DEMO FAIL: ${msg}`); process.exit(1); } };

// A pre-implementation run that GPASSES must never advance the line.
let threw = null;
try {
  canTransition("BUILD_TDD_RED", "BUILD_TDD_GREEN", { redExitCode: 0, redFailedTests: 0 });
} catch (e) { threw = e; }
assert(threw instanceof RedFirstViolationError, "exitCode 0 throws RedFirstViolationError");
assert(/RED_FIRST_VIOLATION/.test(threw.message), "violation names RED_FIRST_VIOLATION");

// A genuinely failing run advances.
const ok = canTransition("BUILD_TDD_RED", "BUILD_TDD_GREEN", { redExitCode: 1, redFailedTests: 2 });
assert(ok.next === "BUILD_TDD_GREEN" && !ok.halted, "failing RED run advances to GREEN");
console.log("RED-first demo OK");
' || fail "RED-first demo"

echo "--- wave-2: tamper demo (modified test file must throw TestTamperingError) ---"
bun -e '
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { canTransition, TestTamperingError } from "./packages/core/src/factory/machine.ts";
import { lockTestManifest, verifyTestManifestUnchanged } from "./packages/core/src/gates/test-lock.ts";

const assert = (cond, msg) => { if (!cond) { console.error(`TAMPER DEMO FAIL: ${msg}`); process.exit(1); } };
const dir = await mkdtemp(path.join(tmpdir(), "wave2-accept-"));
await writeFile(path.join(dir, "spec.test.ts"), "it(\"holds\", () => { expect(1).toBe(1); });\n");
const manifest = await lockTestManifest(dir);

// Programmer weakens the assertion after the RED lock.
await writeFile(path.join(dir, "spec.test.ts"), "it(\"gutted\", () => { expect(1).toBe(1); });\n");
const check = await verifyTestManifestUnchanged(dir, manifest);
assert(!check.unchanged && check.changed.includes("spec.test.ts"), "modification is detected");

let threw = null;
try {
  canTransition("BUILD_TDD_GREEN", "GATE_MUTATION", {
    greenExitCode: 0,
    testManifest: manifest,
    testManifestCheck: check,
  });
} catch (e) { threw = e; }
assert(threw instanceof TestTamperingError, "tampered tests throw TestTamperingError");

// Untouched tree + green run advances.
await writeFile(path.join(dir, "spec.test.ts"), "it(\"holds\", () => { expect(1).toBe(1); });\n");
const clean = await verifyTestManifestUnchanged(dir, manifest);
const ok = canTransition("BUILD_TDD_GREEN", "GATE_MUTATION", {
  greenExitCode: 0,
  testManifest: manifest,
  testManifestCheck: clean,
});
assert(ok.next === "GATE_MUTATION" && !ok.halted, "clean GREEN run advances to GATE_MUTATION");
console.log("tamper demo OK");
' || fail "tamper demo"

echo "wave-2 accept PASSED"
