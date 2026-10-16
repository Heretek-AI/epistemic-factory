// Deterministic gated-build state machine.
//
// Line: `IDLE -> GRILL -> RESEARCH -> SPEC -> BUILD_TDD_RED ->
// BUILD_TDD_GREEN -> GATE_MUTATION -> QA_DUAL_EVAL -> DONE`, plus `HALTED`
// reachable from any state (voluntary halt, `.factory/STOP` kill-file, or
// spend over ceiling).
//
// `canTransition(from, to, ctx)` is pure: it returns a `TransitionResult`
// (`{ next, halted, reason }`) for ordinary guard failures, and throws only
// the two unforgivable violations — `RedFirstViolationError` (tests passed
// before implementation) and `TestTamperingError` (the RED-phase test tree
// was weakened). `transition(from, to, ctx)` wraps it and throws an `Error`
// carrying the halt reason whenever the machine does not reach `to`.
//
// Hash binding: `frontierHash` must equal `frontierHash(ctx.frontier)` (the
// canonical-JSON sha256 from `frontier.ts`) and `specHash` must equal
// sha256(ctx.specContent); the guards recompute both and refuse on mismatch,
// so a signature over one artefact can never advance a different one.
//
// `runner.ts` is the only production caller: it computes every piece of
// evidence itself from disk and persisted run state.
//
// Integration notes for the gate runner:
// - `BUILD_TDD_RED -> BUILD_TDD_GREEN`: after the failing run, the runner
//   calls `lockTestManifest(testDir)` and carries the manifest forward in
//   `ctx.testManifest`. The machine itself never touches the filesystem.
// - `BUILD_TDD_GREEN -> GATE_MUTATION`: the runner re-scans with
//   `verifyTestManifestUnchanged(testDir, manifest)` and passes the diff as
//   `ctx.testManifestCheck`. Without that evidence the machine refuses to
//   leave GREEN (fail closed); with evidence of tampering it throws
//   `TestTamperingError`.
// - `QA_DUAL_EVAL -> DONE`: model identities must be pairwise reported; set
//   `modelDiversityOverride: true` only for an explicit, logged human waiver.

import { createHash } from "node:crypto";
import { MUTATION_THRESHOLD } from "../gates/mutation.ts";
import type { ManifestDiff, TestManifest } from "../gates/test-lock.ts";
import { TestTamperingError } from "../gates/test-lock.ts";
import type { Frontier } from "./frontier.ts";
import { frontierHash as computeFrontierHash } from "./frontier.ts";

export { TestTamperingError };

/** Thrown when tests pass before implementation (RED-first violation). */
export class RedFirstViolationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RedFirstViolationError";
	}
}

/** Every factory state. `HALTED` is terminal. */
export type FactoryState =
	| "IDLE"
	| "GRILL"
	| "RESEARCH"
	| "SPEC"
	| "BUILD_TDD_RED"
	| "BUILD_TDD_GREEN"
	| "GATE_MUTATION"
	| "QA_DUAL_EVAL"
	| "DONE"
	| "HALTED";

/** Mechanical evidence consumed by the transition guards. */
export interface TransitionContext {
	readonly frontier?: Frontier;
	readonly frontierSignatureValid?: boolean;
	readonly frontierHash?: string;
	readonly auditPassed?: boolean;
	readonly verifiedCount?: number;
	readonly specContent?: string;
	readonly specSignatureValid?: boolean;
	readonly specHash?: string;
	readonly redExitCode?: number;
	readonly redFailedTests?: number;
	readonly greenExitCode?: number;
	readonly testManifest?: TestManifest;
	readonly testManifestCheck?: ManifestDiff;
	readonly mutationScore?: number;
	readonly qaFunctionalVerdict?: string;
	readonly qaAdversarialVerdict?: string;
	readonly programmerModel?: string;
	readonly qaFuncModel?: string;
	readonly qaAdvModel?: string;
	readonly modelDiversityOverride?: boolean;
	readonly stopFilePresent?: boolean;
	readonly spendUSD?: number;
	readonly ceilingUSD?: number;
}

/** Outcome of a transition attempt. `halted` with `next !== to` = refused. */
export interface TransitionResult {
	readonly next: FactoryState;
	readonly halted: boolean;
	readonly reason: string;
}

const LEGAL_NEXT: Record<FactoryState, readonly FactoryState[]> = {
	IDLE: ["GRILL", "HALTED"],
	GRILL: ["RESEARCH", "HALTED"],
	RESEARCH: ["SPEC", "HALTED"],
	SPEC: ["BUILD_TDD_RED", "HALTED"],
	BUILD_TDD_RED: ["BUILD_TDD_GREEN", "HALTED"],
	BUILD_TDD_GREEN: ["GATE_MUTATION", "HALTED"],
	GATE_MUTATION: ["QA_DUAL_EVAL", "HALTED"],
	QA_DUAL_EVAL: ["DONE", "HALTED"],
	DONE: ["HALTED"],
	HALTED: ["HALTED"],
};

function halted(from: FactoryState, reason: string): TransitionResult {
	return { next: from, halted: true, reason };
}

function permitted(from: FactoryState, to: FactoryState): TransitionResult {
	return {
		next: to,
		halted: false,
		reason: `transition ${from} -> ${to} permitted`,
	};
}

function isHex64(value: unknown): value is string {
	return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

/**
 * Refuse when the functional judge, adversarial judge, and programmer all
 * report the identical model string without an explicit diversity override.
 * Throws (fail closed); the machine surfaces it as a refused transition.
 */
export function assertModelDiversity(
	qaFuncModel: string | undefined,
	qaAdvModel: string | undefined,
	programmerModel: string | undefined,
	override = false,
): void {
	if (override) return;
	if (
		typeof qaFuncModel !== "string" ||
		qaFuncModel.length === 0 ||
		typeof qaAdvModel !== "string" ||
		qaAdvModel.length === 0 ||
		typeof programmerModel !== "string" ||
		programmerModel.length === 0
	) {
		throw new Error(
			"model diversity violation: cannot establish judge independence (qaFuncModel, qaAdvModel, and programmerModel must all be reported)",
		);
	}
	if (qaFuncModel === qaAdvModel && qaAdvModel === programmerModel) {
		throw new Error(
			`model diversity violation: functional judge, adversarial judge, and programmer all report "${programmerModel}" with no diversity override (refusing single-model self-review; set modelDiversityOverride for an explicit logged waiver)`,
		);
	}
}

function guardGrillToResearch(
	ctx: TransitionContext,
	from: FactoryState,
): TransitionResult | null {
	if (ctx.frontier === undefined) {
		return halted(
			from,
			"GRILL -> RESEARCH refused: missing frontier (a valid frontier.json is required)",
		);
	}
	if (ctx.frontier.deltaFromHead.trim().length === 0) {
		return halted(
			from,
			"GRILL -> RESEARCH refused: frontier carries no concrete behavioral delta from HEAD (context-only grills may not advance)",
		);
	}
	if (!isHex64(ctx.frontierHash)) {
		return halted(
			from,
			"GRILL -> RESEARCH refused: missing or malformed frontierHash (sha256 of frontier.json is required to bind the human approval)",
		);
	}
	const computedFrontierHash = computeFrontierHash(ctx.frontier);
	if (computedFrontierHash !== ctx.frontierHash) {
		return halted(
			from,
			`GRILL -> RESEARCH refused: frontierHash ${ctx.frontierHash} does not match the supplied frontier (computed sha256 ${computedFrontierHash}); the approval must bind the frontier actually being advanced`,
		);
	}
	if (ctx.frontierSignatureValid !== true) {
		return halted(
			from,
			"GRILL -> RESEARCH refused: human Ed25519 approval over sha256(frontier.json) is missing or invalid (frontierSignatureValid !== true)",
		);
	}
	return null;
}

function guardResearchToSpec(
	ctx: TransitionContext,
	from: FactoryState,
): TransitionResult | null {
	if (ctx.auditPassed !== true) {
		return halted(
			from,
			"RESEARCH -> SPEC refused: research audit did not pass (auditResearchMarkdown passed !== true)",
		);
	}
	if ((ctx.verifiedCount ?? 0) < 1) {
		return halted(
			from,
			`RESEARCH -> SPEC refused: verifiedCount ${String(ctx.verifiedCount)} < 1 (at least one grounded VERIFIED claim is required)`,
		);
	}
	return null;
}

function guardSpecToRed(
	ctx: TransitionContext,
	from: FactoryState,
): TransitionResult | null {
	if (ctx.specContent === undefined || ctx.specContent.trim().length === 0) {
		return halted(
			from,
			"SPEC -> BUILD_TDD_RED refused: spec file is missing or empty (a non-empty spec is required)",
		);
	}
	if (!isHex64(ctx.specHash)) {
		return halted(
			from,
			"SPEC -> BUILD_TDD_RED refused: missing or malformed specHash (sha256 of spec.md is required to bind the human approval)",
		);
	}
	const computedSpecHash = createHash("sha256")
		.update(ctx.specContent, "utf8")
		.digest("hex");
	if (computedSpecHash !== ctx.specHash) {
		return halted(
			from,
			`SPEC -> BUILD_TDD_RED refused: specHash ${ctx.specHash} does not match sha256(specContent) ${computedSpecHash}; the approval must bind the spec actually being advanced`,
		);
	}
	if (ctx.specSignatureValid !== true) {
		return halted(
			from,
			"SPEC -> BUILD_TDD_RED refused: human Ed25519 approval over sha256(spec.md) is missing or invalid (specSignatureValid !== true)",
		);
	}
	return null;
}

function guardGreenToMutation(
	ctx: TransitionContext,
	from: FactoryState,
): TransitionResult | null {
	if (ctx.testManifest === undefined) {
		return halted(
			from,
			"BUILD_TDD_GREEN -> GATE_MUTATION refused: no locked test manifest from the RED phase (lockTestManifest is required before leaving GREEN)",
		);
	}
	if (ctx.testManifestCheck === undefined) {
		return halted(
			from,
			"BUILD_TDD_GREEN -> GATE_MUTATION refused: missing test-manifest re-verification evidence (verifyTestManifestUnchanged is required; refusing without proof the tests are unchanged)",
		);
	}
	const check = ctx.testManifestCheck;
	if (!check.unchanged) {
		throw new TestTamperingError(
			`test files changed since the RED-phase lock (refusing to leave BUILD_TDD_GREEN): changed [${check.changed.join(", ")}], missing [${check.missing.join(", ")}], added [${check.added.join(", ")}]`,
		);
	}
	if (ctx.greenExitCode === undefined) {
		return halted(
			from,
			"BUILD_TDD_GREEN -> GATE_MUTATION refused: missing GREEN test evidence (greenExitCode is required)",
		);
	}
	if (ctx.greenExitCode !== 0) {
		return halted(
			from,
			`BUILD_TDD_GREEN -> GATE_MUTATION refused: tests are not green (greenExitCode ${ctx.greenExitCode} !== 0)`,
		);
	}
	return null;
}

function guardMutationToQa(
	ctx: TransitionContext,
	from: FactoryState,
): TransitionResult | null {
	if (ctx.mutationScore === undefined) {
		return halted(
			from,
			"GATE_MUTATION -> QA_DUAL_EVAL refused: missing mutationScore (run the mutation gate first)",
		);
	}
	if (!(ctx.mutationScore >= MUTATION_THRESHOLD)) {
		return halted(
			from,
			`GATE_MUTATION -> QA_DUAL_EVAL refused: mutation score ${ctx.mutationScore} below threshold ${MUTATION_THRESHOLD} (85% of mutants must be killed)`,
		);
	}
	return null;
}

function guardQaToDone(
	ctx: TransitionContext,
	from: FactoryState,
): TransitionResult | null {
	if (
		ctx.qaFunctionalVerdict !== "PASS" ||
		ctx.qaAdversarialVerdict !== "PASS"
	) {
		return halted(
			from,
			`QA_DUAL_EVAL -> DONE refused: dual QA did not pass (functional=${String(ctx.qaFunctionalVerdict)}, adversarial=${String(ctx.qaAdversarialVerdict)}; both must be PASS)`,
		);
	}
	assertModelDiversity(
		ctx.qaFuncModel,
		ctx.qaAdvModel,
		ctx.programmerModel,
		ctx.modelDiversityOverride ?? false,
	);
	return null;
}

/**
 * Pure transition check. The `.factory/STOP` kill-file (`stopFilePresent`)
 * or spend over ceiling forces ANY state to `HALTED` first; illegal edges
 * return halted; per-edge guards return halted with a descriptive reason —
 * except RED-first (`RedFirstViolationError`) and test tampering
 * (`TestTamperingError`), which throw.
 */
export function canTransition(
	from: FactoryState,
	to: FactoryState,
	ctx: TransitionContext = {},
): TransitionResult {
	if (ctx.stopFilePresent === true) {
		return {
			next: "HALTED",
			halted: true,
			reason: ".factory/STOP kill-file present: forcing HALTED from any state",
		};
	}
	if (
		typeof ctx.spendUSD === "number" &&
		typeof ctx.ceilingUSD === "number" &&
		ctx.spendUSD > ctx.ceilingUSD
	) {
		return {
			next: "HALTED",
			halted: true,
			reason: `spend USD ${ctx.spendUSD} exceeds ceiling USD ${ctx.ceilingUSD}: forcing HALTED from any state`,
		};
	}
	if (!LEGAL_NEXT[from].includes(to)) {
		return halted(
			from,
			`illegal transition ${from} -> ${to} (not on the factory line)`,
		);
	}
	if (to === "HALTED") {
		return {
			next: "HALTED",
			halted: true,
			reason: `voluntary halt from ${from}`,
		};
	}
	if (from === "IDLE" && to === "GRILL") return permitted(from, to);
	if (from === "GRILL" && to === "RESEARCH") {
		return guardGrillToResearch(ctx, from) ?? permitted(from, to);
	}
	if (from === "RESEARCH" && to === "SPEC") {
		return guardResearchToSpec(ctx, from) ?? permitted(from, to);
	}
	if (from === "SPEC" && to === "BUILD_TDD_RED") {
		return guardSpecToRed(ctx, from) ?? permitted(from, to);
	}
	if (from === "BUILD_TDD_RED" && to === "BUILD_TDD_GREEN") {
		if (ctx.redExitCode === undefined) {
			return halted(
				from,
				"BUILD_TDD_RED -> BUILD_TDD_GREEN refused: missing RED test evidence (redExitCode is required)",
			);
		}
		if (ctx.redExitCode === 0) {
			throw new RedFirstViolationError(
				"RED_FIRST_VIOLATION: tests passed (exitCode 0) before implementation — refusing BUILD_TDD_RED -> BUILD_TDD_GREEN (a failing run with failedTests >= 1 is required first)",
			);
		}
		if (ctx.redFailedTests !== undefined && ctx.redFailedTests < 1) {
			return halted(
				from,
				`BUILD_TDD_RED -> BUILD_TDD_GREEN refused: exitCode ${ctx.redExitCode} is non-zero but redFailedTests ${ctx.redFailedTests} < 1 (inconsistent RED evidence)`,
			);
		}
		return permitted(from, to);
	}
	if (from === "BUILD_TDD_GREEN" && to === "GATE_MUTATION") {
		return guardGreenToMutation(ctx, from) ?? permitted(from, to);
	}
	if (from === "GATE_MUTATION" && to === "QA_DUAL_EVAL") {
		return guardMutationToQa(ctx, from) ?? permitted(from, to);
	}
	if (from === "QA_DUAL_EVAL" && to === "DONE") {
		return guardQaToDone(ctx, from) ?? permitted(from, to);
	}
	return halted(
		from,
		`illegal transition ${from} -> ${to} (not on the factory line)`,
	);
}

/**
 * Execute a transition, throwing on anything that does not reach `to`:
 * illegal edges and refused guards throw `Error` carrying the halt reason,
 * while RED-first and test-tampering violations throw their dedicated
 * error classes. Returns the next state on success.
 */
export function transition(
	from: FactoryState,
	to: FactoryState,
	ctx: TransitionContext = {},
): FactoryState {
	const result = canTransition(from, to, ctx);
	if (result.next !== to) {
		throw new Error(result.reason);
	}
	return result.next;
}
