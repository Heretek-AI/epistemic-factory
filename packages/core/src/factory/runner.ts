// Factory runner: the only production caller of the state machine.
//
// `machine.ts` is a pure guard over evidence; this module is where that
// evidence comes from. Every transition recomputes its evidence from disk
// and from persisted run state — callers (and therefore agents) never supply
// `specSignatureValid`, `redExitCode`, `mutationScore`, or any other field
// of `TransitionContext`. The only inputs are the project directory and the
// target state.
//
// Layout under `<dir>/.factory/`:
// - `config.json`   project config (test command, test dir, mutation
//                   targets, trusted command set, ...). It decides what the
//                   gates execute, so it must carry a human TRUST approval
//                   over sha256(config.json) for the current run.
// - `run.json`      persisted run state: run id, current state, pinned human
//                   key fingerprint, approved artefact hashes, the RED-phase
//                   test manifest lock, and an append-only history.
// - `approvals/`    `<STAGE>-<runId>.json` signed records written by
//                   `es approve`, verified with `verifyStageApproval`
//                   against `.factory/keys/human.pub`.
// - `keys/`         the sealed human key (`human.pub` is pinned per run).
// - `qa/functional.json`, `qa/adversarial.json`  `{ verdict, model }`.
// - `spend.jsonl`   one `{ "usd": <number> }` per line (spend ledger).
// - `STOP`          kill-file: forces HALTED from any state.
//
// Per transition the runner computes:
// - GRILL -> RESEARCH: loads + validates the frontier, computes
//   `frontierHash`, verifies the GRILL approval over that hash.
// - RESEARCH -> SPEC: audits the research markdown against the sealed source
//   cache (audit function injected by the caller; absent → refused).
// - SPEC -> BUILD_TDD_RED: reads the spec, hashes it, verifies the SPEC
//   approval over that hash.
// - BUILD_TDD_RED -> BUILD_TDD_GREEN: runs the configured test command
//   through the gate engine (trusted-command check, optional bwrap) and
//   requires it to FAIL; then locks the test manifest into run.json.
// - BUILD_TDD_GREEN -> GATE_MUTATION: re-verifies the locked test manifest
//   and runs the test command, which must pass.
// - GATE_MUTATION -> QA_DUAL_EVAL: re-verifies the manifest and runs the
//   mutation gate over the configured targets.
// - QA_DUAL_EVAL -> DONE: reads both QA verdict files.
// Every transition also checks the STOP file and spend ledger first, the
// TRUST approval over config.json, and that approved artefacts (frontier,
// spec) have not drifted since they were approved.
//
// Trust boundary: run.json and the approval records live in the worktree. The
// runner validates run.json's structure and history chain on every load, but
// an actor with write access to `.factory/` can still rewrite it; deployments
// that run untrusted agents must make `.factory/` read-only to them (for
// example by running agent commands under `bwrap --ro-bind`).
import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SignedApprovalRecord, StageName } from "../approval/ed25519.ts";
import { verifyStageApproval } from "../approval/ed25519.ts";
import {
	commandSetHash,
	type GateCommandResult,
	runGateCommand,
	sha256Hex,
} from "../gates/engine.ts";
import { runMutationGate } from "../gates/mutation.ts";
import type { TestManifest } from "../gates/test-lock.ts";
import {
	lockTestManifest,
	TestTamperingError,
	verifyTestManifestUnchanged,
} from "../gates/test-lock.ts";
import { frontierHash, loadFrontier } from "./frontier.ts";
import type {
	FactoryState,
	TransitionContext,
	TransitionResult,
} from "./machine.ts";
import { canTransition, RedFirstViolationError } from "./machine.ts";

export const FACTORY_DIRNAME = ".factory";
export const RUN_FILE = "run.json";
export const CONFIG_FILE = "config.json";
export const APPROVALS_DIRNAME = "approvals";
export const KEYS_DIRNAME = "keys";
export const STOP_FILENAME = "STOP";
export const SPEND_LEDGER_FILE = "spend.jsonl";
export const QA_DIRNAME = "qa";

/** The factory line in order (HALTED is reachable from anywhere). */
export const FACTORY_LINE: readonly FactoryState[] = [
	"IDLE",
	"GRILL",
	"RESEARCH",
	"SPEC",
	"BUILD_TDD_RED",
	"BUILD_TDD_GREEN",
	"GATE_MUTATION",
	"QA_DUAL_EVAL",
	"DONE",
];

const ALL_STATES: readonly FactoryState[] = [...FACTORY_LINE, "HALTED"];

/** Research audit, injected so core stays free of the verifier package. */
export type ResearchAuditor = (
	markdown: string,
	cacheDir: string,
	stateDir: string,
) => Promise<{ readonly passed: boolean; readonly verifiedCount: number }>;

/** Validated `.factory/config.json`. Paths are relative to the project dir. */
export interface FactoryConfig {
	readonly version: 1;
	readonly frontierFile: string;
	readonly specFile: string;
	readonly research: {
		readonly markdown: string;
		readonly cacheDir: string;
		readonly stateDir: string;
	};
	readonly testCmd: string[];
	readonly testDir: string;
	readonly mutation: {
		readonly targets: string[];
		readonly testCmd: string[];
	};
	readonly trustedCommands: string[][];
	readonly useBwrap: boolean;
	readonly allowUnsandboxed: boolean;
	readonly ceilingUSD?: number;
	readonly programmerModel: string;
}

/** One history entry in run.json. */
export interface RunHistoryEntry {
	readonly at: string;
	readonly from: FactoryState;
	readonly to: FactoryState;
	readonly outcome: "advanced" | "refused" | "halted";
	readonly reason: string;
	readonly evidence?: Record<string, unknown>;
}

/** Persisted run state (`.factory/run.json`). */
export interface RunState {
	readonly version: 1;
	readonly runId: string;
	readonly state: FactoryState;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly humanKeyFingerprint?: string;
	readonly approvedFrontierHash?: string;
	readonly approvedSpecHash?: string;
	readonly testManifest?: TestManifest;
	readonly history: RunHistoryEntry[];
}

/** Outcome of one `advance` call. */
export interface AdvanceOutcome {
	readonly ok: boolean;
	readonly from: FactoryState;
	readonly to: FactoryState;
	readonly state: FactoryState;
	readonly reason: string;
	/** Name of the dedicated violation, when one fired. */
	readonly violation?: "RedFirstViolation" | "TestTampering";
}

export interface RunnerOptions {
	/** Research auditor (the CLI passes `auditResearchMarkdown`). */
	readonly auditResearch?: ResearchAuditor;
	/** Clock override for deterministic tests. */
	readonly now?: () => Date;
}

/** Thrown for anything that refuses a transition with a reason. */
export class RunnerRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RunnerRefusal";
	}
}

function factoryPath(dir: string, ...parts: string[]): string {
	return path.join(path.resolve(dir), FACTORY_DIRNAME, ...parts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.every((entry) => typeof entry === "string" && entry.length > 0)
	);
}

function isState(value: unknown): value is FactoryState {
	return (
		typeof value === "string" &&
		(ALL_STATES as readonly string[]).includes(value)
	);
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

/** Resolve a config-relative path, refusing anything that escapes `dir`. */
export function resolveInside(dir: string, relative: string): string {
	const root = path.resolve(dir);
	if (path.isAbsolute(relative)) {
		throw new RunnerRefusal(
			`config path must be relative to the project dir (got absolute ${relative})`,
		);
	}
	const full = path.resolve(root, relative);
	if (full !== root && !full.startsWith(`${root}${path.sep}`)) {
		throw new RunnerRefusal(`config path escapes the project dir: ${relative}`);
	}
	return full;
}

function requireRelPath(
	record: Record<string, unknown>,
	key: string,
	fallback?: string,
): string {
	const value = record[key] ?? fallback;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new RunnerRefusal(
			`.factory/config.json: "${key}" must be a non-empty relative path`,
		);
	}
	return value;
}

function requireCommand(value: unknown, what: string): string[] {
	if (!isStringArray(value) || value.length === 0) {
		throw new RunnerRefusal(
			`.factory/config.json: ${what} must be a non-empty argv array of strings`,
		);
	}
	return [...value];
}

/** Parse and validate config.json text (fail closed on any shape error). */
export function parseFactoryConfig(raw: string): FactoryConfig {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		throw new RunnerRefusal(".factory/config.json is not valid JSON");
	}
	if (!isRecord(parsed)) {
		throw new RunnerRefusal(".factory/config.json must be a JSON object");
	}
	if (parsed.version !== 1) {
		throw new RunnerRefusal(".factory/config.json: version must be 1");
	}
	const research = parsed.research;
	if (!isRecord(research)) {
		throw new RunnerRefusal(
			'.factory/config.json: "research" must be { markdown, cacheDir, stateDir }',
		);
	}
	const testCmd = requireCommand(parsed.testCmd, '"testCmd"');
	const mutation = parsed.mutation;
	if (!isRecord(mutation) || !isStringArray(mutation.targets)) {
		throw new RunnerRefusal(
			'.factory/config.json: "mutation.targets" must be an array of relative source paths',
		);
	}
	if (mutation.targets.length === 0) {
		throw new RunnerRefusal(
			'.factory/config.json: "mutation.targets" must list at least one source file',
		);
	}
	const mutationCmd =
		mutation.testCmd === undefined
			? testCmd
			: requireCommand(mutation.testCmd, '"mutation.testCmd"');
	const trusted = parsed.trustedCommands;
	if (
		!Array.isArray(trusted) ||
		!trusted.every((cmd) => isStringArray(cmd) && cmd.length > 0)
	) {
		throw new RunnerRefusal(
			'.factory/config.json: "trustedCommands" must be an array of argv arrays',
		);
	}
	if (parsed.useBwrap !== undefined && typeof parsed.useBwrap !== "boolean") {
		throw new RunnerRefusal('.factory/config.json: "useBwrap" must be boolean');
	}
	if (
		parsed.allowUnsandboxed !== undefined &&
		typeof parsed.allowUnsandboxed !== "boolean"
	) {
		throw new RunnerRefusal(
			'.factory/config.json: "allowUnsandboxed" must be boolean',
		);
	}
	if (
		parsed.ceilingUSD !== undefined &&
		(typeof parsed.ceilingUSD !== "number" ||
			!Number.isFinite(parsed.ceilingUSD) ||
			parsed.ceilingUSD < 0)
	) {
		throw new RunnerRefusal(
			'.factory/config.json: "ceilingUSD" must be a non-negative number',
		);
	}
	if (
		typeof parsed.programmerModel !== "string" ||
		parsed.programmerModel.length === 0
	) {
		throw new RunnerRefusal(
			'.factory/config.json: "programmerModel" must be a non-empty string (used for the QA model-diversity check)',
		);
	}
	const config: FactoryConfig = {
		version: 1,
		frontierFile: requireRelPath(parsed, "frontierFile", "frontier.json"),
		specFile: requireRelPath(parsed, "specFile", "spec.md"),
		research: {
			markdown: requireRelPath(research, "markdown"),
			cacheDir: requireRelPath(research, "cacheDir"),
			stateDir: requireRelPath(research, "stateDir"),
		},
		testCmd,
		testDir: requireRelPath(parsed, "testDir"),
		mutation: { targets: [...mutation.targets], testCmd: mutationCmd },
		trustedCommands: (trusted as string[][]).map((cmd) => [...cmd]),
		useBwrap: parsed.useBwrap === true,
		allowUnsandboxed: parsed.allowUnsandboxed === true,
		programmerModel: parsed.programmerModel,
		...(typeof parsed.ceilingUSD === "number"
			? { ceilingUSD: parsed.ceilingUSD }
			: {}),
	};
	return config;
}

/** Load config.json, returning the parsed config and sha256 of its bytes. */
export async function loadFactoryConfig(
	dir: string,
): Promise<{ config: FactoryConfig; hash: string }> {
	const file = factoryPath(dir, CONFIG_FILE);
	let raw: Buffer;
	try {
		raw = await readFile(file);
	} catch {
		throw new RunnerRefusal(
			`missing ${FACTORY_DIRNAME}/${CONFIG_FILE} (the runner needs testCmd, testDir, mutation targets, and a trusted command set)`,
		);
	}
	return {
		config: parseFactoryConfig(raw.toString("utf8")),
		hash: sha256Hex(raw),
	};
}

function validateRunState(value: unknown): RunState {
	if (!isRecord(value)) throw new RunnerRefusal("run.json is not an object");
	if (value.version !== 1)
		throw new RunnerRefusal("run.json: version must be 1");
	if (
		typeof value.runId !== "string" ||
		!/^[A-Za-z0-9._-]+$/.test(value.runId)
	) {
		throw new RunnerRefusal("run.json: runId must match [A-Za-z0-9._-]+");
	}
	if (!isState(value.state)) {
		throw new RunnerRefusal(`run.json: unknown state ${String(value.state)}`);
	}
	if (!Array.isArray(value.history)) {
		throw new RunnerRefusal("run.json: history must be an array");
	}
	// The persisted state must be exactly where the advanced/halted history
	// chain leads: a hand-edited `state` without matching history is refused.
	let cursor: FactoryState = "IDLE";
	for (const entry of value.history as unknown[]) {
		if (!isRecord(entry) || !isState(entry.from) || !isState(entry.to)) {
			throw new RunnerRefusal("run.json: malformed history entry");
		}
		if (entry.outcome === "advanced" || entry.outcome === "halted") {
			if (entry.from !== cursor) {
				throw new RunnerRefusal(
					`run.json: history chain broken (entry from ${entry.from} but run was at ${cursor})`,
				);
			}
			cursor = entry.outcome === "halted" ? "HALTED" : entry.to;
		} else if (entry.outcome !== "refused") {
			throw new RunnerRefusal("run.json: unknown history outcome");
		}
	}
	if (cursor !== value.state) {
		throw new RunnerRefusal(
			`run.json: state ${value.state} does not match its history (history ends at ${cursor})`,
		);
	}
	return value as unknown as RunState;
}

/** Load run.json, or `undefined` when no run has started. */
export async function readRunState(dir: string): Promise<RunState | undefined> {
	const file = factoryPath(dir, RUN_FILE);
	if (!(await exists(file))) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
	} catch {
		throw new RunnerRefusal(`${FACTORY_DIRNAME}/${RUN_FILE} is not valid JSON`);
	}
	return validateRunState(parsed);
}

async function writeRunState(dir: string, run: RunState): Promise<void> {
	const file = factoryPath(dir, RUN_FILE);
	await mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	await writeFile(tmp, `${JSON.stringify(run, null, 2)}\n`);
	await rename(tmp, file);
}

/** Load run.json, creating a fresh IDLE run (new run id) when absent. */
export async function loadOrCreateRun(
	dir: string,
	now: () => Date = () => new Date(),
): Promise<RunState> {
	const existing = await readRunState(dir);
	if (existing !== undefined) return existing;
	const at = now().toISOString();
	const run: RunState = {
		version: 1,
		runId: `run-${at.slice(0, 10)}-${randomBytes(6).toString("hex")}`,
		state: "IDLE",
		createdAt: at,
		updatedAt: at,
		history: [],
	};
	await writeRunState(dir, run);
	return run;
}

/** The next state on the line after `state` (undefined at DONE/HALTED). */
export function nextState(state: FactoryState): FactoryState | undefined {
	const index = FACTORY_LINE.indexOf(state);
	if (index < 0 || index + 1 >= FACTORY_LINE.length) return undefined;
	return FACTORY_LINE[index + 1];
}

function safeRunId(runId: string): string {
	return runId.replace(/[^a-zA-Z0-9._-]+/g, "_");
}

/** Path where `es approve` stores the record for `stage` in run `runId`. */
export function approvalRecordPath(
	dir: string,
	stage: StageName,
	runId: string,
): string {
	return factoryPath(
		dir,
		APPROVALS_DIRNAME,
		`${stage}-${safeRunId(runId)}.json`,
	);
}

async function readHumanFingerprint(dir: string): Promise<string> {
	const pub = factoryPath(dir, KEYS_DIRNAME, "human.pub");
	try {
		const parsed = JSON.parse(await readFile(pub, "utf8")) as unknown;
		if (isRecord(parsed) && typeof parsed.fingerprint === "string") {
			return parsed.fingerprint;
		}
	} catch {
		// fall through
	}
	throw new RunnerRefusal(
		`human public key missing or unreadable at ${FACTORY_DIRNAME}/${KEYS_DIRNAME}/human.pub (run \`es key seal\` as the human operator)`,
	);
}

/**
 * Verify the signed approval for `stage` in this run over `subjectHash`
 * against the human public key. Returns a refusal reason, or `null` when the
 * approval is valid.
 */
async function checkApproval(
	dir: string,
	run: RunState,
	stage: StageName,
	subjectHash: string,
	what: string,
): Promise<string | null> {
	const file = approvalRecordPath(dir, stage, run.runId);
	let record: SignedApprovalRecord;
	try {
		record = JSON.parse(await readFile(file, "utf8")) as SignedApprovalRecord;
	} catch {
		return `missing ${stage} approval for run ${run.runId} (expected ${path.relative(path.resolve(dir), file)}); a human must run: es approve --stage ${stage} --subject ${subjectHash} --run-id ${run.runId}`;
	}
	if (record?.runId !== run.runId) {
		return `${stage} approval was signed for run ${String(record?.runId)}, not ${run.runId}`;
	}
	const valid = await verifyStageApproval(
		factoryPath(dir, KEYS_DIRNAME),
		record,
		stage,
		subjectHash,
	);
	if (!valid) {
		const reason =
			record.subjectHash !== subjectHash
				? `it covers sha256 ${String(record.subjectHash)} but the current ${what} hashes to ${subjectHash}`
				: "the Ed25519 signature or signing key does not verify against the human public key";
		return `${stage} approval invalid: ${reason}`;
	}
	return null;
}

async function readSpend(dir: string): Promise<number> {
	const file = factoryPath(dir, SPEND_LEDGER_FILE);
	if (!(await exists(file))) return 0;
	const raw = await readFile(file, "utf8");
	let total = 0;
	for (const [index, line] of raw.split("\n").entries()) {
		if (line.trim().length === 0) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line) as unknown;
		} catch {
			throw new RunnerRefusal(
				`${FACTORY_DIRNAME}/${SPEND_LEDGER_FILE} line ${index + 1} is not JSON (refusing to guess spend)`,
			);
		}
		if (
			!isRecord(entry) ||
			typeof entry.usd !== "number" ||
			!Number.isFinite(entry.usd) ||
			entry.usd < 0
		) {
			throw new RunnerRefusal(
				`${FACTORY_DIRNAME}/${SPEND_LEDGER_FILE} line ${index + 1} must be { "usd": <non-negative number> }`,
			);
		}
		total += entry.usd;
	}
	return total;
}

async function readQaVerdict(
	dir: string,
	which: "functional" | "adversarial",
): Promise<{ verdict?: string; model?: string }> {
	const file = factoryPath(dir, QA_DIRNAME, `${which}.json`);
	try {
		const parsed = JSON.parse(await readFile(file, "utf8")) as unknown;
		if (!isRecord(parsed)) return {};
		return {
			...(typeof parsed.verdict === "string"
				? { verdict: parsed.verdict }
				: {}),
			...(typeof parsed.model === "string" ? { model: parsed.model } : {}),
		};
	} catch {
		return {};
	}
}

async function runTests(
	dir: string,
	config: FactoryConfig,
): Promise<GateCommandResult> {
	return await runGateCommand({
		cmd: config.testCmd,
		cwd: path.resolve(dir),
		useBwrap: config.useBwrap,
		allowUnsandboxed: config.allowUnsandboxed,
		trustedHashes: trustedHashes(config),
	});
}

function trustedHashes(config: FactoryConfig): Set<string> {
	return new Set(config.trustedCommands.map((cmd) => commandSetHash(cmd)));
}

function tail(text: string, max = 600): string {
	const trimmed = text.trim();
	return trimmed.length <= max ? trimmed : `…${trimmed.slice(-max)}`;
}

interface Evidence {
	readonly ctx: TransitionContext;
	readonly record: Record<string, unknown>;
	readonly runPatch: Partial<RunState>;
	/** Why the evidence is negative, appended to a machine refusal. */
	readonly detail?: string;
}

/**
 * Compute the evidence for `from -> to`. Throws `RunnerRefusal` for
 * prerequisites the machine has no field for (missing config, drifted
 * artefacts, untrusted commands, ...).
 */
async function computeEvidence(
	dir: string,
	run: RunState,
	from: FactoryState,
	to: FactoryState,
	config: FactoryConfig,
	options: RunnerOptions,
): Promise<Evidence> {
	const record: Record<string, unknown> = {};
	const runPatch: Partial<RunState> = {};
	const edge = `${from} -> ${to}`;
	const refuse = (reason: string): never => {
		throw new RunnerRefusal(`${edge} refused: ${reason}`);
	};

	// Approved artefacts must not drift after approval.
	if (run.approvedFrontierHash !== undefined) {
		const current = frontierHash(
			await loadFrontier(resolveInside(dir, config.frontierFile)),
		);
		if (current !== run.approvedFrontierHash) {
			refuse(
				`${config.frontierFile} changed since its GRILL approval (approved ${run.approvedFrontierHash}, now ${current})`,
			);
		}
	}
	if (run.approvedSpecHash !== undefined) {
		const current = sha256Hex(
			await readFile(resolveInside(dir, config.specFile)).catch(() =>
				refuse(`${config.specFile} vanished after its SPEC approval`),
			),
		);
		if (current !== run.approvedSpecHash) {
			refuse(
				`${config.specFile} changed since its SPEC approval (approved ${run.approvedSpecHash}, now ${current})`,
			);
		}
	}

	if (from === "GRILL" && to === "RESEARCH") {
		let frontier: Awaited<ReturnType<typeof loadFrontier>>;
		try {
			frontier = await loadFrontier(resolveInside(dir, config.frontierFile));
		} catch (error) {
			return refuse((error as Error).message);
		}
		const hash = frontierHash(frontier);
		const problem = await checkApproval(dir, run, "GRILL", hash, "frontier");
		record.frontierHash = hash;
		record.frontierApproval = problem ?? "valid";
		Object.assign(runPatch, { approvedFrontierHash: hash });
		return {
			ctx: {
				frontier,
				frontierHash: hash,
				frontierSignatureValid: problem === null,
			},
			record,
			runPatch,
			...(problem !== null ? { detail: problem } : {}),
		};
	}

	if (from === "RESEARCH" && to === "SPEC") {
		if (options.auditResearch === undefined) {
			refuse("no research auditor available (fail closed)");
		}
		const auditor = options.auditResearch as ResearchAuditor;
		const markdownFile = resolveInside(dir, config.research.markdown);
		let markdown: string;
		try {
			markdown = await readFile(markdownFile, "utf8");
		} catch {
			return refuse(`research markdown ${config.research.markdown} is missing`);
		}
		const audit = await auditor(
			markdown,
			resolveInside(dir, config.research.cacheDir),
			resolveInside(dir, config.research.stateDir),
		);
		record.auditPassed = audit.passed;
		record.verifiedCount = audit.verifiedCount;
		return {
			ctx: { auditPassed: audit.passed, verifiedCount: audit.verifiedCount },
			record,
			runPatch,
		};
	}

	if (from === "SPEC" && to === "BUILD_TDD_RED") {
		let specContent: string;
		try {
			specContent = await readFile(resolveInside(dir, config.specFile), "utf8");
		} catch {
			return refuse(`spec file ${config.specFile} is missing`);
		}
		const hash = sha256Hex(specContent);
		const problem = await checkApproval(dir, run, "SPEC", hash, "spec");
		record.specHash = hash;
		record.specApproval = problem ?? "valid";
		Object.assign(runPatch, { approvedSpecHash: hash });
		return {
			ctx: {
				specContent,
				specHash: hash,
				specSignatureValid: problem === null,
			},
			record,
			runPatch,
			...(problem !== null ? { detail: problem } : {}),
		};
	}

	if (from === "BUILD_TDD_RED" && to === "BUILD_TDD_GREEN") {
		const testDir = resolveInside(dir, config.testDir);
		const manifest = await lockTestManifest(testDir).catch((error: Error) =>
			refuse(error.message),
		);
		if (manifest.files.length === 0) {
			refuse(
				`test dir ${config.testDir} holds no test files (nothing can be RED)`,
			);
		}
		const result = await runTests(dir, config);
		record.redExitCode = result.exitCode;
		record.redOutputTail = tail(`${result.stdout}\n${result.stderr}`);
		record.testManifestFiles = manifest.files.length;
		Object.assign(runPatch, { testManifest: manifest });
		return { ctx: { redExitCode: result.exitCode }, record, runPatch };
	}

	if (from === "BUILD_TDD_GREEN" && to === "GATE_MUTATION") {
		if (run.testManifest === undefined) {
			// The machine refuses GREEN without a locked manifest.
			return { ctx: {}, record, runPatch };
		}
		const check = await verifyTestManifestUnchanged(
			resolveInside(dir, config.testDir),
			run.testManifest,
		);
		record.testManifestUnchanged = check.unchanged;
		if (!check.unchanged) {
			// No point running the suite: the machine throws on tampering.
			return {
				ctx: { testManifest: run.testManifest, testManifestCheck: check },
				record,
				runPatch,
			};
		}
		const result = await runTests(dir, config);
		record.greenExitCode = result.exitCode;
		record.greenOutputTail = tail(`${result.stdout}\n${result.stderr}`);
		return {
			ctx: {
				testManifest: run.testManifest,
				testManifestCheck: check,
				greenExitCode: result.exitCode,
			},
			record,
			runPatch,
		};
	}

	if (from === "GATE_MUTATION" && to === "QA_DUAL_EVAL") {
		await assertLockedTestsUnchanged(dir, run, config);
		const trusted = trustedHashes(config);
		if (!trusted.has(commandSetHash(config.mutation.testCmd))) {
			refuse(
				`mutation test command ${JSON.stringify(config.mutation.testCmd)} is not in trustedCommands`,
			);
		}
		for (const target of config.mutation.targets) resolveInside(dir, target);
		const result = await runMutationGate(
			path.resolve(dir),
			config.mutation.targets,
			config.mutation.testCmd,
		);
		record.mutationScore = result.score;
		record.mutantsKilled = result.killed;
		record.mutantsSurvived = result.survived;
		return { ctx: { mutationScore: result.score }, record, runPatch };
	}

	if (from === "QA_DUAL_EVAL" && to === "DONE") {
		await assertLockedTestsUnchanged(dir, run, config);
		const functional = await readQaVerdict(dir, "functional");
		const adversarial = await readQaVerdict(dir, "adversarial");
		record.qaFunctional = functional;
		record.qaAdversarial = adversarial;
		return {
			ctx: {
				...(functional.verdict !== undefined
					? { qaFunctionalVerdict: functional.verdict }
					: {}),
				...(adversarial.verdict !== undefined
					? { qaAdversarialVerdict: adversarial.verdict }
					: {}),
				...(functional.model !== undefined
					? { qaFuncModel: functional.model }
					: {}),
				...(adversarial.model !== undefined
					? { qaAdvModel: adversarial.model }
					: {}),
				programmerModel: config.programmerModel,
			},
			record,
			runPatch,
		};
	}

	return { ctx: {}, record, runPatch };
}

async function assertLockedTestsUnchanged(
	dir: string,
	run: RunState,
	config: FactoryConfig,
): Promise<void> {
	if (run.testManifest === undefined) {
		throw new RunnerRefusal(
			"no locked test manifest in run.json (the RED phase never completed)",
		);
	}
	const check = await verifyTestManifestUnchanged(
		resolveInside(dir, config.testDir),
		run.testManifest,
	);
	if (!check.unchanged) {
		throw new TestTamperingError(
			`test files changed since the RED-phase lock: changed [${check.changed.join(", ")}], missing [${check.missing.join(", ")}], added [${check.added.join(", ")}]`,
		);
	}
}

/**
 * Attempt one transition from the persisted state to `to` (default: the
 * next state on the line), computing all evidence from disk. Persists the
 * new state on success, `HALTED` when the STOP file or spend ceiling forces
 * it, and a `refused` history entry otherwise. Never throws for gate
 * refusals — the outcome carries `ok: false` and the reason.
 */
export async function advance(
	dir: string,
	to?: FactoryState,
	options: RunnerOptions = {},
): Promise<AdvanceOutcome> {
	const now = options.now ?? (() => new Date());
	const run = await loadOrCreateRun(dir, now);
	const from = run.state;
	const target = to ?? nextState(from);
	if (target === undefined) {
		return {
			ok: false,
			from,
			to: from,
			state: from,
			reason: `run ${run.runId} is at ${from}: there is no next state on the line`,
		};
	}

	const persist = async (
		outcome: RunHistoryEntry["outcome"],
		state: FactoryState,
		reason: string,
		evidence: Record<string, unknown>,
		patch: Partial<RunState> = {},
	): Promise<void> => {
		const at = now().toISOString();
		const entry: RunHistoryEntry = {
			at,
			from,
			to: target,
			outcome,
			reason,
			...(Object.keys(evidence).length > 0 ? { evidence } : {}),
		};
		await writeRunState(dir, {
			...run,
			...(outcome === "refused" ? {} : patch),
			state,
			updatedAt: at,
			history: [...run.history, entry],
		});
	};

	// 1. Kill-file, spend ceiling, voluntary halt, and illegal edges need no
	//    computed evidence: no gate command runs once the operator has
	//    pulled the plug.
	const stopFilePresent = await exists(factoryPath(dir, STOP_FILENAME));
	let config: FactoryConfig | undefined;
	let configHash: string | undefined;
	let spendUSD = 0;
	let setupError: string | undefined;
	try {
		({ config, hash: configHash } = await loadFactoryConfig(dir));
		spendUSD = await readSpend(dir);
	} catch (error) {
		setupError = error instanceof Error ? error.message : String(error);
	}
	const guardCtx: TransitionContext = {
		stopFilePresent,
		spendUSD,
		...(config?.ceilingUSD !== undefined
			? { ceilingUSD: config.ceilingUSD }
			: {}),
	};
	const forced = canTransition(from, target, guardCtx);
	if (forced.next === "HALTED") {
		const voluntary = target === "HALTED" && !stopFilePresent;
		await persist("halted", "HALTED", forced.reason, {
			stopFilePresent,
			spendUSD,
		});
		return {
			ok: voluntary,
			from,
			to: target,
			state: "HALTED",
			reason: forced.reason,
		};
	}
	if (!nextIsLegal(from, target)) {
		await persist("refused", from, forced.reason, {});
		return { ok: false, from, to: target, state: from, reason: forced.reason };
	}
	if (
		setupError !== undefined ||
		config === undefined ||
		configHash === undefined
	) {
		const reason = `${from} -> ${target} refused: ${setupError ?? "config unavailable"}`;
		await persist("refused", from, reason, {});
		return { ok: false, from, to: target, state: from, reason };
	}

	// 2. The human key is pinned per run, and the config that decides what
	//    the gates execute must carry a TRUST approval for this run.
	let patch: Partial<RunState> = {};
	let evidence: Evidence;
	try {
		const fingerprint = await readHumanFingerprint(dir);
		if (
			run.humanKeyFingerprint !== undefined &&
			run.humanKeyFingerprint !== fingerprint
		) {
			throw new RunnerRefusal(
				`${from} -> ${target} refused: human public key changed during run ${run.runId} (pinned ${run.humanKeyFingerprint}, found ${fingerprint})`,
			);
		}
		patch = { humanKeyFingerprint: fingerprint };
		const trustProblem = await checkApproval(
			dir,
			run,
			"TRUST",
			configHash,
			`${FACTORY_DIRNAME}/${CONFIG_FILE}`,
		);
		if (trustProblem !== null) {
			throw new RunnerRefusal(
				`${from} -> ${target} refused: ${FACTORY_DIRNAME}/${CONFIG_FILE} is not human-trusted: ${trustProblem}`,
			);
		}
		evidence = await computeEvidence(dir, run, from, target, config, options);
	} catch (error) {
		return await refusal(error);
	}

	// 3. The machine decides on the computed evidence.
	let result: TransitionResult;
	try {
		result = canTransition(from, target, { ...guardCtx, ...evidence.ctx });
	} catch (error) {
		return await refusal(error, evidence.record);
	}
	if (result.next !== target) {
		const reason =
			evidence.detail !== undefined
				? `${result.reason}: ${evidence.detail}`
				: result.reason;
		await persist("refused", from, reason, evidence.record);
		return { ok: false, from, to: target, state: from, reason };
	}
	await persist("advanced", target, result.reason, evidence.record, {
		...patch,
		...evidence.runPatch,
	});
	return { ok: true, from, to: target, state: target, reason: result.reason };

	async function refusal(
		error: unknown,
		record: Record<string, unknown> = {},
	): Promise<AdvanceOutcome> {
		const violation =
			error instanceof RedFirstViolationError
				? ("RedFirstViolation" as const)
				: error instanceof TestTamperingError
					? ("TestTampering" as const)
					: undefined;
		const message = error instanceof Error ? error.message : String(error);
		const reason =
			violation !== undefined
				? `${from} -> ${target} refused: ${violation}: ${message}`
				: message.includes("refused")
					? message
					: `${from} -> ${target} refused: ${message}`;
		await persist("refused", from, reason, record);
		return {
			ok: false,
			from,
			to: target as FactoryState,
			state: from,
			reason,
			...(violation !== undefined ? { violation } : {}),
		};
	}
}

function nextIsLegal(from: FactoryState, to: FactoryState): boolean {
	return nextState(from) === to;
}

/**
 * Advance as far as the gates allow. Stops at DONE, HALTED, or the first
 * refusal, returning every attempted step.
 */
export async function runToCompletion(
	dir: string,
	options: RunnerOptions = {},
): Promise<{ ok: boolean; steps: AdvanceOutcome[]; state: FactoryState }> {
	const steps: AdvanceOutcome[] = [];
	for (;;) {
		const run = await loadOrCreateRun(dir, options.now);
		if (run.state === "DONE" || run.state === "HALTED") {
			return { ok: run.state === "DONE", steps, state: run.state };
		}
		const outcome = await advance(dir, undefined, options);
		steps.push(outcome);
		if (!outcome.ok) return { ok: false, steps, state: outcome.state };
	}
}

/**
 * Subject hash a human must sign for `stage` in the current project state:
 * GRILL → `frontierHash(frontier)`, SPEC → sha256(spec bytes), TRUST →
 * sha256(config.json bytes). Used by `es approve` and `es status`.
 */
export async function expectedApprovalSubject(
	dir: string,
	stage: StageName,
): Promise<string> {
	const { config, hash } = await loadFactoryConfig(dir);
	if (stage === "TRUST") return hash;
	if (stage === "GRILL") {
		return frontierHash(
			await loadFrontier(resolveInside(dir, config.frontierFile)),
		);
	}
	if (stage === "SPEC") {
		return sha256Hex(await readFile(resolveInside(dir, config.specFile)));
	}
	throw new RunnerRefusal(
		`no computable subject for stage ${stage} (pass --subject explicitly)`,
	);
}
