import { beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Frontier } from "../src/factory/frontier.ts";
import {
	frontierHash,
	loadFrontier,
	saveFrontier,
} from "../src/factory/frontier.ts";
import type {
	FactoryState,
	TransitionContext,
} from "../src/factory/machine.ts";
import {
	assertModelDiversity,
	canTransition,
	RedFirstViolationError,
	transition,
} from "../src/factory/machine.ts";
import {
	lockTestManifest,
	TestTamperingError,
	verifyTestManifestUnchanged,
} from "../src/gates/test-lock.ts";

/** Narrow `T | undefined` without a non-null assertion (biome forbids `!`). */
function defined<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`test precondition failed: ${what}`);
	return value;
}

function frontier(decisions: Array<{ id: string }> = [{ id: "d1" }]): Frontier {
	return {
		version: 1,
		idea: "gated build factory",
		deltaFromHead: "adds a deterministic GRILL -> DONE state line",
		rounds: [
			{
				round: 1,
				decisions: decisions.map((d) => ({
					id: d.id,
					question: "what?",
					answer: "this.",
				})),
			},
		],
	};
}

const SPEC_CONTENT = "# Spec\n\nBuild the thing.\n";

function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

let greenDir: string;

beforeEach(async () => {
	greenDir = await mkdtemp(path.join(tmpdir(), "es-machine-"));
	await writeFile(
		path.join(greenDir, "a.test.ts"),
		"it('holds', () => { expect(1).toBe(1); });\n",
	);
});

/** A fully-evidenced context that walks the whole line to DONE. */
async function fullContext(): Promise<TransitionContext> {
	const manifest = await lockTestManifest(greenDir);
	const check = await verifyTestManifestUnchanged(greenDir, manifest);
	return {
		frontier: frontier(),
		frontierSignatureValid: true,
		frontierHash: frontierHash(frontier()),
		auditPassed: true,
		verifiedCount: 2,
		specContent: SPEC_CONTENT,
		specSignatureValid: true,
		specHash: sha256(SPEC_CONTENT),
		redExitCode: 1,
		redFailedTests: 3,
		greenExitCode: 0,
		testManifest: manifest,
		testManifestCheck: check,
		mutationScore: 0.92,
		qaFunctionalVerdict: "PASS",
		qaAdversarialVerdict: "PASS",
		programmerModel: "muse-spark",
		qaFuncModel: "qa-judge-a",
		qaAdvModel: "qa-judge-b",
	};
}

describe("frontier", () => {
	it("accepts a first save with a concrete delta", () => {
		expect(() => saveFrontier(undefined, frontier())).not.toThrow();
	});

	it("refuses an empty deltaFromHead", () => {
		const empty = { ...frontier(), deltaFromHead: "   " };
		expect(() => saveFrontier(undefined, empty)).toThrow(
			/concrete behavioral delta/,
		);
	});

	it("refuses deletion of a prior decision id", () => {
		const prev = frontier([{ id: "d1" }, { id: "d2" }]);
		const next: Frontier = {
			...prev,
			rounds: [
				{
					round: 1,
					decisions: [{ id: "d1", question: "q", answer: "a" }],
				},
			],
		};
		expect(() => saveFrontier(prev, next)).toThrow(/d2/);
	});

	it("refuses round number regression and duplicates", () => {
		const prev = frontier();
		const regressed: Frontier = {
			...prev,
			rounds: [...prev.rounds, { round: 1, decisions: [] }],
		};
		expect(() => saveFrontier(prev, regressed)).toThrow(
			/regression|duplicate|increasing/,
		);
		const backwards: Frontier = {
			...prev,
			rounds: [{ round: 0, decisions: [] }],
		};
		expect(() => saveFrontier(prev, backwards)).toThrow(/refused/);
	});

	it("accepts appended rounds and loadFrontier round-trips", async () => {
		const prev = frontier();
		const next: Frontier = {
			...prev,
			rounds: [
				...prev.rounds,
				{ round: 2, decisions: [{ id: "d9", question: "q", answer: "a" }] },
			],
		};
		expect(() => saveFrontier(prev, next)).not.toThrow();
		const file = path.join(greenDir, "frontier.json");
		await writeFile(file, JSON.stringify(next));
		expect(await loadFrontier(file)).toEqual(next);
		expect(frontierHash(next)).toMatch(/^[0-9a-f]{64}$/);
	});

	it("loadFrontier fails closed on missing or invalid files", async () => {
		await expect(
			loadFrontier(path.join(greenDir, "nope.json")),
		).rejects.toThrow(/not found/);
		const bad = path.join(greenDir, "bad.json");
		await writeFile(bad, "{not json");
		await expect(loadFrontier(bad)).rejects.toThrow(/JSON/);
	});
});

describe("factory line", () => {
	const LINE: Array<[FactoryState, FactoryState]> = [
		["IDLE", "GRILL"],
		["GRILL", "RESEARCH"],
		["RESEARCH", "SPEC"],
		["SPEC", "BUILD_TDD_RED"],
		["BUILD_TDD_RED", "BUILD_TDD_GREEN"],
		["BUILD_TDD_GREEN", "GATE_MUTATION"],
		["GATE_MUTATION", "QA_DUAL_EVAL"],
		["QA_DUAL_EVAL", "DONE"],
	];

	it("walks every legal transition with proper evidence", async () => {
		const ctx = await fullContext();
		for (const [from, to] of LINE) {
			const result = canTransition(from, to, ctx);
			expect({ edge: `${from}->${to}`, result }).toEqual({
				edge: `${from}->${to}`,
				result: {
					next: to,
					halted: false,
					reason: `transition ${from} -> ${to} permitted`,
				},
			});
			expect(transition(from, to, ctx)).toBe(to);
		}
	});

	it("rejects illegal edges", async () => {
		const ctx = await fullContext();
		const result = canTransition("IDLE", "DONE", ctx);
		expect(result.halted).toBe(true);
		expect(result.next).toBe("IDLE");
		expect(() => transition("IDLE", "DONE", ctx)).toThrow(/illegal/);
		expect(() => transition("RESEARCH", "GRILL", ctx)).toThrow(/illegal/);
	});

	it("halts GRILL -> RESEARCH without a frontier approval", async () => {
		const ctx = await fullContext();
		const denied: TransitionContext = { ...ctx, frontierSignatureValid: false };
		expect(canTransition("GRILL", "RESEARCH", denied).halted).toBe(true);
		expect(() => transition("GRILL", "RESEARCH", denied)).toThrow(/approval/);
		const { frontier: droppedFrontier, ...noFrontier } = ctx;
		void droppedFrontier;
		expect(canTransition("GRILL", "RESEARCH", noFrontier).halted).toBe(true);
	});

	it("halts RESEARCH -> SPEC on a failed audit or zero verified claims", async () => {
		const ctx = await fullContext();
		expect(
			canTransition("RESEARCH", "SPEC", { ...ctx, auditPassed: false }).halted,
		).toBe(true);
		expect(
			canTransition("RESEARCH", "SPEC", { ...ctx, verifiedCount: 0 }).halted,
		).toBe(true);
	});

	it("halts SPEC -> BUILD_TDD_RED on empty spec or missing approval", async () => {
		const ctx = await fullContext();
		expect(
			canTransition("SPEC", "BUILD_TDD_RED", { ...ctx, specContent: "  " })
				.halted,
		).toBe(true);
		expect(
			canTransition("SPEC", "BUILD_TDD_RED", {
				...ctx,
				specSignatureValid: false,
			}).halted,
		).toBe(true);
	});

	it("refuses SPEC -> BUILD_TDD_RED when specHash does not match the spec content", async () => {
		const ctx = await fullContext();
		const forged = canTransition("SPEC", "BUILD_TDD_RED", {
			...ctx,
			specHash: "b".repeat(64),
		});
		expect(forged.halted).toBe(true);
		expect(forged.next).toBe("SPEC");
		expect(forged.reason).toMatch(/does not match sha256\(specContent\)/);
		// The signature covered the original spec; a swapped spec is refused.
		const swapped = canTransition("SPEC", "BUILD_TDD_RED", {
			...ctx,
			specContent: "# Spec\n\nBuild a different thing.\n",
		});
		expect(swapped.halted).toBe(true);
		expect(swapped.reason).toMatch(/does not match/);
		expect(canTransition("SPEC", "BUILD_TDD_RED", ctx).halted).toBe(false);
	});

	it("refuses GRILL -> RESEARCH when frontierHash does not match the frontier", async () => {
		const ctx = await fullContext();
		const forged = canTransition("GRILL", "RESEARCH", {
			...ctx,
			frontierHash: "a".repeat(64),
		});
		expect(forged.halted).toBe(true);
		expect(forged.reason).toMatch(/does not match the supplied frontier/);
		const edited: Frontier = { ...frontier(), deltaFromHead: "something else" };
		const swapped = canTransition("GRILL", "RESEARCH", {
			...ctx,
			frontier: edited,
		});
		expect(swapped.halted).toBe(true);
		expect(canTransition("GRILL", "RESEARCH", ctx).halted).toBe(false);
	});

	it("throws RedFirstViolationError when RED exits 0", async () => {
		const ctx = await fullContext();
		const green: TransitionContext = { ...ctx, redExitCode: 0 };
		let thrown: unknown;
		try {
			canTransition("BUILD_TDD_RED", "BUILD_TDD_GREEN", green);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(RedFirstViolationError);
		expect(String((thrown as Error).message)).toMatch(/RED_FIRST_VIOLATION/);
		expect(() => transition("BUILD_TDD_RED", "BUILD_TDD_GREEN", green)).toThrow(
			RedFirstViolationError,
		);
	});

	it("throws TestTamperingError when GREEN tests were weakened", async () => {
		const ctx = await fullContext();
		await writeFile(
			path.join(greenDir, "a.test.ts"),
			"it('gutted', () => { expect(1).toBe(1); });\n",
		);
		const check = await verifyTestManifestUnchanged(
			greenDir,
			defined(ctx.testManifest, "locked manifest"),
		);
		expect(check.unchanged).toBe(false);
		const tampered: TransitionContext = { ...ctx, testManifestCheck: check };
		let thrown: unknown;
		try {
			canTransition("BUILD_TDD_GREEN", "GATE_MUTATION", tampered);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(TestTamperingError);
	});

	it("refuses GREEN without manifest evidence and on red tests", async () => {
		const ctx = await fullContext();
		const {
			testManifest: droppedManifest,
			testManifestCheck: droppedCheck,
			...noEvidence
		} = ctx;
		void droppedManifest;
		void droppedCheck;
		expect(
			canTransition("BUILD_TDD_GREEN", "GATE_MUTATION", noEvidence).halted,
		).toBe(true);
		expect(
			canTransition("BUILD_TDD_GREEN", "GATE_MUTATION", {
				...ctx,
				greenExitCode: 2,
			}).halted,
		).toBe(true);
	});

	it("blocks GATE_MUTATION -> QA_DUAL_EVAL below 0.85", async () => {
		const ctx = await fullContext();
		expect(
			canTransition("GATE_MUTATION", "QA_DUAL_EVAL", {
				...ctx,
				mutationScore: 0.84,
			}).halted,
		).toBe(true);
		expect(
			canTransition("GATE_MUTATION", "QA_DUAL_EVAL", {
				...ctx,
				mutationScore: 0.85,
			}).halted,
		).toBe(false);
	});

	it("requires both QA verdicts PASS plus model diversity", async () => {
		const ctx = await fullContext();
		expect(
			canTransition("QA_DUAL_EVAL", "DONE", {
				...ctx,
				qaAdversarialVerdict: "FAIL",
			}).halted,
		).toBe(true);
		const sameModel: TransitionContext = {
			...ctx,
			programmerModel: "same",
			qaFuncModel: "same",
			qaAdvModel: "same",
		};
		expect(() => transition("QA_DUAL_EVAL", "DONE", sameModel)).toThrow(
			/diversity/,
		);
		expect(() =>
			assertModelDiversity("same", "same", "same", true),
		).not.toThrow();
		expect(
			transition("QA_DUAL_EVAL", "DONE", {
				...sameModel,
				modelDiversityOverride: true,
			}),
		).toBe("DONE");
	});

	it("forces HALTED on STOP file or spend over ceiling from any state", async () => {
		const ctx = await fullContext();
		const states: FactoryState[] = [
			"IDLE",
			"GRILL",
			"RESEARCH",
			"SPEC",
			"BUILD_TDD_RED",
			"BUILD_TDD_GREEN",
			"GATE_MUTATION",
			"QA_DUAL_EVAL",
		];
		for (const from of states) {
			const stop = canTransition(from, "DONE", {
				...ctx,
				stopFilePresent: true,
			});
			expect({ from, stop }).toEqual({
				from,
				stop: {
					next: "HALTED",
					halted: true,
					reason:
						".factory/STOP kill-file present: forcing HALTED from any state",
				},
			});
			const spend = canTransition(from, "DONE", {
				...ctx,
				spendUSD: 101,
				ceilingUSD: 100,
			});
			expect(spend.next).toBe("HALTED");
			// At (not over) the ceiling does not halt.
			const atCeiling = canTransition("IDLE", "GRILL", {
				spendUSD: 100,
				ceilingUSD: 100,
			});
			expect(atCeiling.halted).toBe(false);
		}
	});

	it("allows voluntary halt from any state; HALTED is terminal", async () => {
		const ctx = await fullContext();
		expect(transition("GRILL", "HALTED", ctx)).toBe("HALTED");
		expect(canTransition("HALTED", "HALTED", ctx).next).toBe("HALTED");
		expect(() => transition("HALTED", "GRILL", ctx)).toThrow(
			/terminal|illegal/,
		);
		expect(() => transition("DONE", "GRILL", ctx)).toThrow(/illegal/);
	});
});
