import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	assertTrustedCommand,
	commandSetHash,
	runGateCommand,
	scanForSecrets,
	sha256Hex,
} from "../src/gates/engine.ts";
import {
	generateSourceMutants,
	MUTATION_THRESHOLD,
	runMutationGate,
} from "../src/gates/mutation.ts";
import {
	assertTestManifestUnchanged,
	lockTestManifest,
	TestTamperingError,
	verifyTestManifestUnchanged,
} from "../src/gates/test-lock.ts";

async function freshDir(prefix: string): Promise<string> {
	return await mkdtemp(path.join(tmpdir(), prefix));
}

describe("generateSourceMutants", () => {
	it("swaps every operator class in source order with stable ids", () => {
		const code = [
			"if (a === b) {",
			"  return x >= y && flag === true || other !== false;",
			"}",
		].join("\n");
		const mutants = generateSourceMutants(code);
		expect(mutants.map((m) => m.id)).toEqual([
			"M1",
			"M2",
			"M3",
			"M4",
			"M5",
			"M6",
			"M7",
			"M8",
		]);
		expect(mutants.map((m) => m.line)).toEqual([1, 2, 2, 2, 2, 2, 2, 2]);
		expect(mutants[0]?.mutated).toBe("if (a !== b) {");
		const mutateds = mutants.map((m) => m.mutated);
		expect(mutateds).toContain(
			"  return x < y && flag === true || other !== false;",
		);
		expect(mutateds).toContain(
			"  return x >= y || flag === true || other !== false;",
		);
		expect(mutateds).toContain(
			"  return x >= y && flag !== true || other !== false;",
		);
		expect(mutateds).toContain(
			"  return x >= y && flag === false || other !== false;",
		);
		expect(mutateds).toContain(
			"  return x >= y && flag === true && other !== false;",
		);
		expect(mutateds).toContain(
			"  return x >= y && flag === true || other === false;",
		);
		expect(mutateds).toContain(
			"  return x >= y && flag === true || other !== true;",
		);
	});

	it("maps >= to < and standalone < to >=", () => {
		const down = generateSourceMutants("if (n >= 3) {\n}\n");
		expect(down).toHaveLength(1);
		expect(down[0]?.mutated).toBe("if (n < 3) {");
		const up = generateSourceMutants("if (n < 3) {\n}\n");
		expect(up).toHaveLength(1);
		expect(up[0]?.mutated).toBe("if (n >= 3) {");
	});

	it("leaves <=, <<, and </ alone", () => {
		expect(generateSourceMutants("if (a <= b) {\n}\n")).toEqual([]);
		expect(generateSourceMutants("const x = a << 2;\n")).toEqual([]);
	});

	it("returns [] for mutation-free code and keeps original lines", () => {
		expect(generateSourceMutants("function id(x) {\n  return x;\n}\n")).toEqual(
			[],
		);
		const mutants = generateSourceMutants("const ok = a === b;\n");
		expect(mutants).toHaveLength(1);
		expect(mutants[0]).toEqual({
			id: "M1",
			line: 1,
			original: "const ok = a === b;",
			mutated: "const ok = a !== b;",
		});
	});
});

describe("lockTestManifest", () => {
	it("locks and re-verifies an unchanged tree", async () => {
		const dir = await freshDir("es-lock-");
		await writeFile(path.join(dir, "a.test.ts"), "A\n");
		const manifest = await lockTestManifest(dir);
		expect(manifest.files.map((f) => f.path)).toEqual(["a.test.ts"]);
		expect(await verifyTestManifestUnchanged(dir, manifest)).toEqual({
			unchanged: true,
			changed: [],
			missing: [],
			added: [],
		});
		await assertTestManifestUnchanged(dir, manifest);
	});

	it("detects modification, deletion, and addition", async () => {
		const dir = await freshDir("es-tamper-");
		await writeFile(path.join(dir, "keep.test.ts"), "KEEP\n");
		await writeFile(path.join(dir, "drop.test.ts"), "DROP\n");
		const manifest = await lockTestManifest(dir);
		await writeFile(path.join(dir, "keep.test.ts"), "GUTTED\n");
		await writeFile(path.join(dir, "new.test.ts"), "NEW\n");
		const { unlink } = await import("node:fs/promises");
		await unlink(path.join(dir, "drop.test.ts"));
		const diff = await verifyTestManifestUnchanged(dir, manifest);
		expect(diff).toEqual({
			unchanged: false,
			changed: ["keep.test.ts"],
			missing: ["drop.test.ts"],
			added: ["new.test.ts"],
		});
		await expect(assertTestManifestUnchanged(dir, manifest)).rejects.toThrow(
			TestTamperingError,
		);
	});

	it("refuses a missing directory", async () => {
		await expect(
			lockTestManifest(path.join(await freshDir("es-x-"), "nope")),
		).rejects.toThrow(/not found/);
	});
});

describe("engine trust + secrets", () => {
	it("hashes command sets deterministically", () => {
		expect(sha256Hex("abc")).toBe(
			"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
		);
		expect(commandSetHash(["bun", "test"])).toBe(
			sha256Hex(JSON.stringify(["bun", "test"])),
		);
		expect(commandSetHash(["bun", "test"])).not.toBe(
			commandSetHash(["bun", "lint"]),
		);
	});

	it("trusts only listed command hashes", () => {
		const cmd = ["bun", "test", "packages/core"];
		expect(() =>
			assertTrustedCommand(cmd, new Set([commandSetHash(cmd)])),
		).not.toThrow();
		expect(() => assertTrustedCommand(cmd, new Set())).toThrow(/untrusted/);
		expect(() => assertTrustedCommand(["bun", "test"], new Set())).toThrow(
			/untrusted/,
		);
	});

	it("flags every secret shape and stays silent on clean text", () => {
		const text = [
			"key AKIAIOSFODNN7EXAMPLE here",
			"token ghp_abcdefghijklmnopqrstuvwxyz0123456789 here",
			"-----BEGIN RSA PRIVATE KEY-----",
			"sk-live-abcDEF123456",
			'config api_key = "hunter2-value" done',
		].join("\n");
		const findings = scanForSecrets(text);
		expect(findings).toHaveLength(5);
		expect(findings.join("\n")).toContain("aws-access-key-id");
		expect(findings.join("\n")).toContain("github-personal-access-token");
		expect(findings.join("\n")).toContain("private-key-block");
		expect(findings.join("\n")).toContain("live-secret-key");
		expect(findings.join("\n")).toContain("api-key-assignment");
		// Findings are redacted: no finding carries a full live secret.
		expect(findings.join("\n")).not.toContain("AKIAIOSFODNN7EXAMPLE");
		expect(findings.join("\n")).not.toContain("sk-live-abcDEF123456");
		expect(scanForSecrets("nothing sensitive, just code")).toEqual([]);
	});

	it("runs gate commands and reports exit codes", async () => {
		const dir = await freshDir("es-gate-");
		const ok = await runGateCommand({ cmd: ["echo", "hello"], cwd: dir });
		expect(ok.exitCode).toBe(0);
		expect(ok.stdout).toBe("hello\n");
		const failing = await runGateCommand({
			cmd: ["sh", "-c", "exit 3"],
			cwd: dir,
		});
		expect(failing.exitCode).toBe(3);
		await expect(
			runGateCommand({
				cmd: ["echo", "hi"],
				cwd: dir,
				trustedHashes: new Set(["deadbeef"]),
			}),
		).rejects.toThrow(/untrusted/);
	});

	it("records a warning when bwrap is requested but missing", async () => {
		const probed = spawnSync("bwrap", ["--version"], { stdio: "ignore" });
		if (probed.status === 0) return; // sandbox present: nothing to assert here
		const dir = await freshDir("es-bwrap-");
		const result = await runGateCommand({
			cmd: ["echo", "hi"],
			cwd: dir,
			useBwrap: true,
		});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toContain("bwrap");
	});
});

describe("runMutationGate", () => {
	const EQ_SRC = "function eq(a, b) {\n  return a === b;\n}\n";
	const EQ_CHECK =
		'import { readFileSync } from "node:fs";\n' +
		'const target = process.argv[2] ?? "";\n' +
		'const src = readFileSync(target, "utf8");\n' +
		// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture script intentionally interpolates src at its own runtime
		"const eq = new Function(`${src}; return eq;`)();\n" +
		"if (eq(1, 1) !== true) process.exit(1);\n" +
		"if (eq(1, 2) !== false) process.exit(1);\n";
	const LOOSE_SRC = "function pick(a, b) {\n  return a && b;\n}\n";
	const LOOSE_CHECK =
		'import { readFileSync } from "node:fs";\n' +
		'const target = process.argv[2] ?? "";\n' +
		'const src = readFileSync(target, "utf8");\n' +
		// biome-ignore lint/suspicious/noTemplateCurlyInString: fixture script intentionally interpolates src at its own runtime
		"const pick = new Function(`${src}; return pick;`)();\n" +
		"if (!pick(1, 1)) process.exit(1);\n";

	it(`kills mutants at threshold ${MUTATION_THRESHOLD}`, async () => {
		const dir = await freshDir("es-mut-kill-");
		await writeFile(path.join(dir, "calc.js"), EQ_SRC);
		await writeFile(path.join(dir, "check-eq.js"), EQ_CHECK);
		const result = await runMutationGate(
			dir,
			["calc.js"],
			["bun", path.join(dir, "check-eq.js"), path.join(dir, "calc.js")],
		);
		expect(result).toEqual({ score: 1, killed: 1, survived: 0, passed: true });
		expect(await readFile(path.join(dir, "calc.js"), "utf8")).toBe(EQ_SRC);
	});

	it("fails the gate when mutants survive", async () => {
		const dir = await freshDir("es-mut-survive-");
		await writeFile(path.join(dir, "pick.js"), LOOSE_SRC);
		await writeFile(path.join(dir, "check-pick.js"), LOOSE_CHECK);
		const result = await runMutationGate(
			dir,
			["pick.js"],
			["bun", path.join(dir, "check-pick.js"), path.join(dir, "pick.js")],
		);
		expect(result.killed).toBe(0);
		expect(result.survived).toBe(1);
		expect(result.score).toBe(0);
		expect(result.passed).toBe(false);
		expect(await readFile(path.join(dir, "pick.js"), "utf8")).toBe(LOOSE_SRC);
	});

	it("passes vacuously (score 1) when there are no mutants", async () => {
		const dir = await freshDir("es-mut-empty-");
		await writeFile(
			path.join(dir, "plain.js"),
			"function id(x) {\n  return x;\n}\n",
		);
		const result = await runMutationGate(dir, ["plain.js"], ["true"]);
		expect(result).toEqual({ score: 1, killed: 0, survived: 0, passed: true });
	});

	it("fails closed on bad inputs", async () => {
		const dir = await freshDir("es-mut-bad-");
		await expect(runMutationGate(dir, [], ["true"])).rejects.toThrow(
			/targetFiles/,
		);
		await writeFile(path.join(dir, "a.js"), "const x = 1;\n");
		await expect(runMutationGate(dir, ["a.js"], [])).rejects.toThrow(/testCmd/);
		await expect(
			runMutationGate(dir, ["missing.js"], ["true"]),
		).rejects.toThrow(/cannot read/);
	});
});
