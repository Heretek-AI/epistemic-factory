#!/usr/bin/env node
// `es` — the Gated Build Factory CLI.
//
// Single-worktree operator console for the factory line
// `GRILL -> RESEARCH -> SPEC -> BUILD_TDD_RED -> BUILD_TDD_GREEN ->
// GATE_MUTATION -> QA_DUAL_EVAL -> DONE` (plus `HALTED`). Every subcommand is
// a thin, fail-closed wrapper over `@heretek-ai/es-core` and
// `@heretek-ai/epistemic-verifier-mcp`: invalid input is rejected with a
// descriptive error on stderr (exit 1), gate/verification failures print
// their evidence on stdout and exit 1, and success exits 0.
//
// Subcommands (see USAGE):
// - `es key seal [--key-dir <dir>] [--passphrase <pw>]`
// - `es init [--dir <dir>] [--force]`
// - `es status [--dir <dir>]`
// - `es approve --stage <GRILL|SPEC|WAIVER|TRUST> --subject <sha256>
//   --run-id <id> [--key-dir <dir>] [--passphrase <pw>] [--dir <dir>]`
// - `es audit-research --markdown <file> --cache-dir <dir> --state-dir <dir>`
// - `es gate-mutation --dir <dir> --files <a,b> -- <testCmd...>`
// - `es advance [--to <STATE>] [--dir <dir>]`
// - `es run [--dir <dir>]`
//
// `advance` and `run` drive the persisted run (`.factory/run.json`) through
// core's runner, which computes every piece of gate evidence itself. They
// accept no evidence flags: any flag other than `--to`/`--dir` is refused.
//
// The human passphrase never touches disk: it arrives via `--passphrase` or
// the `ES_PASSPHRASE` environment variable and lives only in memory.
// Agents may REQUEST approvals via `es approve`; actually signing requires
// the human passphrase, which agents must never hold.
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditResearchMarkdown } from "@heretek-ai/epistemic-verifier-mcp";
import type {
	AdvanceOutcome,
	FactoryState,
	Frontier,
	RunnerOptions,
	StageName,
} from "@heretek-ai/es-core";
import {
	advance,
	expectedApprovalSubject,
	FACTORY_LINE,
	loadOrCreateRun,
	readRunState,
	runMutationGate,
	runToCompletion,
	saveFrontier,
	sealHumanKey,
	signStageApproval,
} from "@heretek-ai/es-core";
import { WORKTREE_INCLUDE_FILE } from "./worktree-include.ts";

/** CLI usage, printed for `--help`/`help` and on unknown commands. */
export const USAGE = `Usage: es <command> [options]

Commands:
  key seal [--key-dir <dir>] [--passphrase <pw>]
      Seal a human Ed25519 approval key (prints publicKeyHex + fingerprint).
      Default --key-dir: <cwd>/.factory/keys
  init [--dir <dir>] [--force]
      Scaffold .worktreeinclude, .factory/, and frontier.json skeleton.
      Refuses to overwrite without --force.
  status [--dir <dir>]
      Print run state (run id, current state, last step), frontier presence
      + rounds count, approvals present, STOP presence. Informational
      (exit 0).
  approve --stage <GRILL|SPEC|WAIVER|TRUST> [--subject <sha256>] [--run-id <id>] [--key-dir <dir>] [--passphrase <pw>] [--dir <dir>] [--timestamp <iso>]
      Sign a stage approval with the sealed human key and store the record
      under <dir>/.factory/approvals/. Without --subject, GRILL/SPEC/TRUST
      sign the hash of the frontier / spec / .factory/config.json on disk;
      without --run-id, the current run in .factory/run.json is used.
  advance [--to <STATE>] [--dir <dir>]
      Advance the persisted run one step (default: the next state on the
      line). Every gate's evidence is computed from disk; evidence flags
      are refused. Exit 0 when advanced, 1 with the reason when refused.
  run [--dir <dir>]
      Advance as far as the gates allow; stop at DONE (exit 0) or at the
      first refusal (exit 1, with the reason).
  audit-research --markdown <file> --cache-dir <dir> --state-dir <dir>
      Audit research markdown against the sealed source cache.
      Exit 0 when grounded, 1 when pruned/failed.
  gate-mutation --dir <dir> --files <a.ts,b.ts> -- <testCmd...>
      Run the mutation gate (85% kill threshold). Exit 0 on pass, 1 on fail.
  help | --help | -h
      Print this usage.

The passphrase may also come from ES_PASSPHRASE. Exit 0 on success,
1 on gate/verification failure or invalid input.`;

/** Default `.worktreeinclude` scaffold written by `es init`. */
export const DEFAULT_WORKTREE_INCLUDE = `# Files copied from the base repo into isolated phase worktrees
# (untracked secrets/config — never git-staged). One pattern per line.
.env
.env.local
certs/*.pem
`;

/** Factory state directory scaffolded by `es init` inside the project dir. */
export const FACTORY_DIR = ".factory";

/** Frontier file name (`es init` writes it at the project root). */
export const FRONTIER_FILE = "frontier.json";

/** Kill-file name: `<dir>/.factory/STOP` forces HALTED from any state. */
export const STOP_FILE = "STOP";

/** Approval records live in `<dir>/.factory/approvals/*.json`. */
export const APPROVALS_DIR = "approvals";

/** Stages a human may approve (kept in sync with core `StageName`). */
export const APPROVABLE_STAGES: readonly string[] = [
	"GRILL",
	"SPEC",
	"WAIVER",
	"TRUST",
];

/** Parsed CLI tail: pre-`--` positionals, `--flag value` flags, post-`--` rest. */
export interface ParsedArgs {
	readonly positional: string[];
	readonly flags: Record<string, string | boolean>;
	readonly rest: string[];
}

/**
 * Parse a command tail. Supports `--flag value`, `--flag=value`, boolean
 * `--flag`, and a `--` separator after which every token lands in `rest`
 * untouched (so test commands keep their own dashes).
 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
	const positional: string[] = [];
	const flags: Record<string, string | boolean> = {};
	let rest: string[] = [];
	let i = 0;
	while (i < argv.length) {
		const token = argv[i] as string;
		if (token === "--") {
			rest = [...argv.slice(i + 1)];
			break;
		}
		if (token.startsWith("--") && token.length > 2) {
			const body = token.slice(2);
			const eq = body.indexOf("=");
			if (eq >= 0) {
				flags[body.slice(0, eq)] = body.slice(eq + 1);
			} else {
				const next = argv[i + 1];
				if (next !== undefined && next !== "--" && !next.startsWith("--")) {
					flags[body] = next;
					i += 1;
				} else {
					flags[body] = true;
				}
			}
		} else {
			positional.push(token);
		}
		i += 1;
	}
	return { positional, flags, rest };
}

/** Read a string flag; absent or boolean flags yield `undefined`. */
function flagValue(
	flags: Record<string, string | boolean>,
	name: string,
): string | undefined {
	const value = flags[name];
	return typeof value === "string" ? value : undefined;
}

/** Passphrase from `--passphrase` or `ES_PASSPHRASE` (never from disk). */
function readPassphrase(
	flags: Record<string, string | boolean>,
): string | undefined {
	return flagValue(flags, "passphrase") ?? process.env.ES_PASSPHRASE;
}

/** True when path exists (any kind); false on any stat failure. */
async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

function defaultKeyDir(): string {
	return path.join(process.cwd(), FACTORY_DIR, "keys");
}

/**
 * `es key seal [--key-dir <dir>] [--passphrase <pw>]`: seal a human Ed25519
 * keypair under the passphrase (core `sealHumanKey`) and print
 * `{ publicKeyHex, fingerprint }` JSON. Throws on missing/empty passphrase.
 */
export async function cmdKeySeal(tail: readonly string[]): Promise<number> {
	const { flags, positional } = parseArgs(tail);
	if (positional.length > 0) {
		throw new Error(
			`es key seal takes no positional arguments (got: ${positional.join(" ")})`,
		);
	}
	const keyDir = flagValue(flags, "key-dir") ?? defaultKeyDir();
	const passphrase = readPassphrase(flags);
	if (passphrase === undefined || passphrase.length === 0) {
		throw new Error(
			"es key seal requires --passphrase <pw> or ES_PASSPHRASE (refusing to seal a human key under an empty passphrase)",
		);
	}
	const { publicKeyHex, fingerprint } = await sealHumanKey(keyDir, passphrase);
	process.stdout.write(`${JSON.stringify({ publicKeyHex, fingerprint })}\n`);
	return 0;
}

/**
 * `es init [--dir <dir>] [--force]`: scaffold `.worktreeinclude` (defaults
 * `.env`, `.env.local`, `certs/*.pem`), `.factory/` (plus `approvals/`), and
 * a `frontier.json` skeleton validated structurally via core `saveFrontier`.
 * Refuses to overwrite either scaffolded file without `--force` (fail closed).
 */
export async function cmdInit(tail: readonly string[]): Promise<number> {
	const { flags, positional } = parseArgs(tail);
	if (positional.length > 0) {
		throw new Error(
			`es init takes no positional arguments (got: ${positional.join(" ")}; want: es init [--dir <dir>] [--force])`,
		);
	}
	const dir = path.resolve(flagValue(flags, "dir") ?? process.cwd());
	const force = flags.force === true;
	const includeFile = path.join(dir, WORKTREE_INCLUDE_FILE);
	const frontierFile = path.join(dir, FRONTIER_FILE);
	const factoryDir = path.join(dir, FACTORY_DIR);
	for (const scaffolded of [includeFile, frontierFile]) {
		if (!force && (await exists(scaffolded))) {
			throw new Error(
				`es init refused: ${scaffolded} already exists (re-run with --force to overwrite)`,
			);
		}
	}
	const skeleton: Frontier = {
		version: 1,
		idea: "TODO: grilled idea — replace during the GRILL stage",
		deltaFromHead:
			"TODO: concrete behavioral delta from HEAD — the GRILL stage must fill this before RESEARCH",
		rounds: [],
	};
	// Structural validation through the core append-only frontier type: a
	// scaffold that cannot validate is never written.
	saveFrontier(undefined, skeleton);
	await mkdir(path.join(factoryDir, APPROVALS_DIR), { recursive: true });
	await writeFile(includeFile, DEFAULT_WORKTREE_INCLUDE);
	await writeFile(frontierFile, `${JSON.stringify(skeleton, null, 2)}\n`);
	process.stdout.write(
		`es init: scaffolded ${includeFile}, ${frontierFile}, ${factoryDir}/\n`,
	);
	return 0;
}

interface StatusFrontier {
	readonly found: boolean;
	readonly file?: string;
	readonly rounds?: number;
	readonly decisions?: number;
	readonly delta?: "set" | "empty";
	readonly invalid?: string;
}

/** Load the frontier for status: project root first, `.factory/` fallback. */
async function loadFrontierForStatus(dir: string): Promise<StatusFrontier> {
	const candidates = [
		path.join(dir, FRONTIER_FILE),
		path.join(dir, FACTORY_DIR, FRONTIER_FILE),
	];
	for (const candidate of candidates) {
		if (!(await exists(candidate))) continue;
		let raw: string;
		try {
			raw = await readFile(candidate, "utf8");
		} catch (error) {
			return {
				found: true,
				file: candidate,
				invalid: `unreadable: ${(error as Error)?.message ?? String(error)}`,
			};
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw) as unknown;
		} catch {
			return { found: true, file: candidate, invalid: "not valid JSON" };
		}
		if (parsed === null || typeof parsed !== "object") {
			return { found: true, file: candidate, invalid: "not an object" };
		}
		const record = parsed as Record<string, unknown>;
		const rounds = Array.isArray(record.rounds)
			? (record.rounds as unknown[])
			: undefined;
		if (rounds === undefined) {
			return {
				found: true,
				file: candidate,
				invalid: "missing rounds array",
			};
		}
		let decisions = 0;
		for (const round of rounds) {
			const entry = (round as { decisions?: unknown })?.decisions;
			if (Array.isArray(entry)) decisions += entry.length;
		}
		return {
			found: true,
			file: candidate,
			rounds: rounds.length,
			decisions,
			delta:
				typeof record.deltaFromHead === "string" &&
				record.deltaFromHead.trim().length > 0
					? "set"
					: "empty",
		};
	}
	return { found: false };
}

/**
 * `es status [--dir <dir>]`: print frontier presence + rounds/decisions
 * count, approvals present, and STOP presence. Informational — exit 0
 * whenever the directory itself is readable (fail closed with a throw only
 * for an unreadable project dir).
 */
export async function cmdStatus(tail: readonly string[]): Promise<number> {
	const { flags, positional } = parseArgs(tail);
	if (positional.length > 0) {
		throw new Error(
			`es status takes no positional arguments (got: ${positional.join(" ")}; want: es status [--dir <dir>])`,
		);
	}
	const dir = path.resolve(flagValue(flags, "dir") ?? process.cwd());
	try {
		await stat(dir);
	} catch {
		throw new Error(`es status refused: project dir is not readable: ${dir}`);
	}
	const frontier = await loadFrontierForStatus(dir);
	let approvals: string[] = [];
	try {
		const entries = await readdir(path.join(dir, FACTORY_DIR, APPROVALS_DIR));
		approvals = entries.filter((name) => name.endsWith(".json")).sort();
	} catch {
		approvals = [];
	}
	const stopPresent = await exists(path.join(dir, FACTORY_DIR, STOP_FILE));
	let runLines: string[];
	try {
		const run = await readRunState(dir);
		if (run === undefined) {
			runLines = ["run: none (es advance starts one)"];
		} else {
			const last = run.history[run.history.length - 1];
			runLines = [
				`run: ${run.runId} state=${run.state}`,
				...(last !== undefined
					? [`last: ${last.outcome} ${last.from} -> ${last.to}: ${last.reason}`]
					: []),
			];
		}
	} catch (error) {
		runLines = [`run: INVALID: ${(error as Error)?.message ?? String(error)}`];
	}
	const frontierLine = !frontier.found
		? "frontier: absent"
		: frontier.invalid !== undefined
			? `frontier: present (${frontier.file}) INVALID: ${frontier.invalid}`
			: `frontier: present (${frontier.file}) rounds=${String(frontier.rounds)} decisions=${String(frontier.decisions)} delta=${frontier.delta}`;
	process.stdout.write(
		`${[`dir: ${dir}`, ...runLines, frontierLine, `approvals: ${approvals.length}${approvals.length > 0 ? ` (${approvals.join(", ")})` : ""}`, `stop: ${stopPresent ? "present (.factory/STOP forces HALTED)" : "absent"}`].join("\n")}\n`,
	);
	return 0;
}

/**
 * `es approve --stage <GRILL|SPEC|WAIVER|TRUST> --subject <sha256> --run-id
 * <id> [--key-dir <dir>] [--passphrase <pw>] [--dir <dir>]`: sign the stage
 * payload with the sealed human key (core `signStageApproval`), persist the
 * record under `<dir>/.factory/approvals/<STAGE>-<runId>.json`, and print it.
 * Throws (exit 1) on bad stage, malformed subject hash, missing run id, or
 * missing/unsealing passphrase — approvals are never self-signed by agents.
 */
export async function cmdApprove(tail: readonly string[]): Promise<number> {
	const { flags, positional } = parseArgs(tail);
	if (positional.length > 0) {
		throw new Error(
			`es approve takes no positional arguments (got: ${positional.join(" ")})`,
		);
	}
	const stage = flagValue(flags, "stage");
	if (stage === undefined || !APPROVABLE_STAGES.includes(stage)) {
		throw new Error(
			`es approve requires --stage <${APPROVABLE_STAGES.join("|")}> (got: ${stage ?? "missing"})`,
		);
	}
	const dir = path.resolve(flagValue(flags, "dir") ?? process.cwd());
	let subject = flagValue(flags, "subject");
	if (subject === undefined && stage !== "WAIVER") {
		subject = await expectedApprovalSubject(dir, stage as StageName);
	}
	if (subject === undefined || !/^[0-9a-fA-F]{64}$/.test(subject)) {
		throw new Error(
			"es approve requires --subject <64-hex sha256 of the gated artefact> (frontier.json or spec.md)",
		);
	}
	let runId = flagValue(flags, "run-id");
	if (runId === undefined) {
		runId = (await loadOrCreateRun(dir)).runId;
	}
	if (runId.length === 0) {
		throw new Error("es approve requires --run-id <id>");
	}
	const keyDir = flagValue(flags, "key-dir") ?? defaultKeyDir();
	const passphrase = readPassphrase(flags);
	if (passphrase === undefined || passphrase.length === 0) {
		throw new Error(
			"es approve requires --passphrase <pw> or ES_PASSPHRASE (agents may request approvals, never grant or self-sign them)",
		);
	}
	const timestamp = flagValue(flags, "timestamp") ?? new Date().toISOString();
	const record = await signStageApproval(keyDir, passphrase, {
		runId,
		stage: stage as StageName,
		subjectHash: subject.toLowerCase(),
		timestamp,
	});
	const approvalsDir = path.join(dir, FACTORY_DIR, APPROVALS_DIR);
	await mkdir(approvalsDir, { recursive: true });
	const safeRunId = runId.replace(/[^a-zA-Z0-9._-]+/g, "_");
	const storedAt = path.join(approvalsDir, `${stage}-${safeRunId}.json`);
	await writeFile(storedAt, `${JSON.stringify(record, null, 2)}\n`);
	process.stdout.write(`${JSON.stringify({ ...record, storedAt })}\n`);
	return 0;
}

/**
 * `es audit-research --markdown <file> --cache-dir <dir> --state-dir <dir>`:
 * audit research markdown against the sealed source cache. Prints
 * `{ passed, verifiedCount, failures }`; exit 0 when grounded, 1 when any
 * claim is pruned (fail closed: ungrounded claims never pass silently).
 */
export async function cmdAuditResearch(
	tail: readonly string[],
): Promise<number> {
	const { flags, positional } = parseArgs(tail);
	if (positional.length > 0) {
		throw new Error(
			`es audit-research takes no positional arguments (got: ${positional.join(" ")})`,
		);
	}
	const markdownFile = flagValue(flags, "markdown");
	const cacheDir = flagValue(flags, "cache-dir");
	const stateDir = flagValue(flags, "state-dir");
	if (markdownFile === undefined) {
		throw new Error("es audit-research requires --markdown <file>");
	}
	if (cacheDir === undefined) {
		throw new Error("es audit-research requires --cache-dir <dir>");
	}
	if (stateDir === undefined) {
		throw new Error("es audit-research requires --state-dir <dir>");
	}
	let markdown: string;
	try {
		markdown = await readFile(markdownFile, "utf8");
	} catch (error) {
		throw new Error(
			`es audit-research refused: cannot read markdown file ${markdownFile}: ${(error as Error)?.message ?? String(error)}`,
		);
	}
	const result = await auditResearchMarkdown(markdown, cacheDir, stateDir);
	process.stdout.write(
		`${JSON.stringify({ passed: result.passed, verifiedCount: result.verifiedCount, failures: result.failures })}\n`,
	);
	return result.passed ? 0 : 1;
}

/**
 * `es gate-mutation --dir <dir> --files <a.ts,b.ts> -- <testCmd...>`: run
 * the core mutation gate (85% kill threshold). Prints
 * `{ score, killed, survived, passed }`; exit 0 on pass, 1 on fail.
 */
export async function cmdGateMutation(
	tail: readonly string[],
): Promise<number> {
	const parsed = parseArgs(tail);
	const { flags, positional, rest } = parsed;
	if (positional.length > 0 && rest.length > 0) {
		throw new Error(
			`es gate-mutation: pass the test command after -- (got stray positionals: ${positional.join(" ")})`,
		);
	}
	const dir = path.resolve(flagValue(flags, "dir") ?? process.cwd());
	const filesRaw = flagValue(flags, "files");
	if (filesRaw === undefined || filesRaw.trim().length === 0) {
		throw new Error(
			"es gate-mutation requires --files <comma-separated paths relative to --dir>",
		);
	}
	const files = filesRaw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry.length > 0);
	if (files.length === 0) {
		throw new Error(
			"es gate-mutation requires --files <comma-separated paths relative to --dir>",
		);
	}
	const testCmd = rest.length > 0 ? [...rest] : [...positional];
	if (testCmd.length === 0) {
		throw new Error(
			"es gate-mutation requires a test command after -- (e.g. es gate-mutation --dir <dir> --files <csv> -- <testCmd...>)",
		);
	}
	const result = await runMutationGate(dir, files, testCmd);
	process.stdout.write(
		`${JSON.stringify({ score: result.score, killed: result.killed, survived: result.survived, passed: result.passed })}\n`,
	);
	return result.passed ? 0 : 1;
}

/** Flags `es advance` / `es run` accept. Everything else is refused. */
const RUNNER_FLAGS: Readonly<Record<string, readonly string[]>> = {
	advance: ["dir", "to"],
	run: ["dir"],
};

function runnerOptions(): RunnerOptions {
	return {
		auditResearch: async (markdown, cacheDir, stateDir) =>
			await auditResearchMarkdown(markdown, cacheDir, stateDir),
	};
}

function parseRunnerTail(
	command: "advance" | "run",
	tail: readonly string[],
): { dir: string; to?: FactoryState } {
	const { flags, positional, rest } = parseArgs(tail);
	if (positional.length > 0 || rest.length > 0) {
		throw new Error(
			`es ${command} takes no positional arguments (got: ${[...positional, ...rest].join(" ")})`,
		);
	}
	const allowed = RUNNER_FLAGS[command] ?? [];
	const unknown = Object.keys(flags).filter((name) => !allowed.includes(name));
	if (unknown.length > 0) {
		throw new Error(
			`es ${command} refused flag(s) ${unknown.map((name) => `--${name}`).join(", ")}: gate evidence is computed by the runner from disk and is never accepted from the caller`,
		);
	}
	const dir = path.resolve(flagValue(flags, "dir") ?? process.cwd());
	const toRaw = flags.to;
	if (toRaw === undefined) return { dir };
	const valid: readonly string[] = [...FACTORY_LINE, "HALTED"];
	if (typeof toRaw !== "string" || !valid.includes(toRaw)) {
		throw new Error(
			`es advance --to requires one of ${valid.join(", ")} (got: ${String(toRaw)})`,
		);
	}
	return { dir, to: toRaw as FactoryState };
}

function printOutcome(outcome: AdvanceOutcome): void {
	const line = outcome.ok
		? `${outcome.from} -> ${outcome.state}: ${outcome.reason}`
		: `REFUSED ${outcome.from} -> ${outcome.to} (state: ${outcome.state}): ${outcome.reason}`;
	process.stdout.write(`${line}\n`);
}

/**
 * `es advance [--to <STATE>] [--dir <dir>]`: one runner step. Exit 0 when
 * the run reached the target, 1 (with the reason) when refused or halted.
 */
export async function cmdAdvance(tail: readonly string[]): Promise<number> {
	const { dir, to } = parseRunnerTail("advance", tail);
	const outcome = await advance(dir, to, runnerOptions());
	printOutcome(outcome);
	return outcome.ok ? 0 : 1;
}

/**
 * `es run [--dir <dir>]`: advance as far as the gates allow. Exit 0 at
 * DONE; exit 1 at the first refusal (or HALTED), printing the reason.
 */
export async function cmdRun(tail: readonly string[]): Promise<number> {
	const { dir } = parseRunnerTail("run", tail);
	const result = await runToCompletion(dir, runnerOptions());
	for (const step of result.steps) printOutcome(step);
	process.stdout.write(`state: ${result.state}\n`);
	return result.ok ? 0 : 1;
}

/**
 * Dispatch `argv` (already minus the program name, i.e.
 * `process.argv.slice(2)`). Prints usage to stdout and returns 0 for
 * `--help`/`-h`/`help`; prints usage to stderr and returns 1 for unknown
 * commands or any thrown (fail-closed) error.
 */
export async function main(argv: readonly string[]): Promise<number> {
	const [command, ...tail] = argv;
	try {
		if (
			command === undefined ||
			command === "--help" ||
			command === "-h" ||
			command === "help"
		) {
			process.stdout.write(`${USAGE}\n`);
			return 0;
		}
		if (command === "key") {
			const [sub, ...keyTail] = tail;
			if (sub === "seal") return await cmdKeySeal(keyTail);
			if (sub === "--help" || sub === "-h" || sub === undefined) {
				process.stdout.write(`${USAGE}\n`);
				return 0;
			}
			throw new Error(`unknown key subcommand "${sub}" (want: es key seal)`);
		}
		switch (command) {
			case "init":
				return await cmdInit(tail);
			case "status":
				return await cmdStatus(tail);
			case "approve":
				return await cmdApprove(tail);
			case "audit-research":
				return await cmdAuditResearch(tail);
			case "gate-mutation":
				return await cmdGateMutation(tail);
			case "advance":
				return await cmdAdvance(tail);
			case "run":
				return await cmdRun(tail);
			default:
				throw new Error(`unknown command "${command}"`);
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`es: error: ${message}\n${USAGE}\n`);
		return 1;
	}
}

/**
 * True when this file is the directly-invoked entrypoint. Bun (and other
 * `import.meta.main` runtimes) answer directly; on plain Node.js the boolean
 * is absent, so fall back to comparing the resolved `node <script>` argv
 * entry against this module's URL (symlink-aware via `realpathSync`, so
 * globally-linked `es` bins still detect). Fail-closed: any uncertainty
 * returns false and the CLI never runs on a bare library import.
 */
function isMain(): boolean {
	const bunMain = (import.meta as ImportMeta & { main?: unknown }).main;
	if (typeof bunMain === "boolean") return bunMain;
	try {
		const entry = process.argv[1];
		if (typeof entry !== "string" || entry.length === 0) return false;
		return realpathSync(entry) === fileURLToPath(import.meta.url);
	} catch {
		return false;
	}
}

if (isMain()) {
	process.exit(await main(process.argv.slice(2)));
}
