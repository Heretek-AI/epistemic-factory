// Sandboxed gate runner: Bubblewrap execution + command trust + secret scan.
//
// - `commandSetHash` / `assertTrustedCommand`: every gate command is hashed
//   (SHA-256 over the JSON of its argv array) and checked against a caller
//   supplied trusted set. Untrusted commands throw before anything spawns
//   (fail closed on untrusted commands).
// - `runGateCommand`: executes the command, optionally under `bwrap`
//   (`--ro-bind / /`, fresh `/tmp`, `/proc` + `/dev`, `--die-with-parent`).
//   When `useBwrap` is set but the `bwrap` binary is missing, execution falls
//   back to direct spawn with a warning prepended to `stderr` — never fail
//   closed on a missing sandbox, but always record it.
// - `scanForSecrets`: reports findings (rule id, offset, redacted match) for
//   AWS key ids, GitHub PATs, PEM private-key headers, live secret keys, and
//   generic `api-key = "…"` assignments. The scanner only reports; the caller
//   decides (block, redact, or annotate) — a scanner that silently dropped
//   output would hide the blast radius.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";

/** SHA-256 hex of a UTF-8 string or buffer. */
export function sha256Hex(data: string | Buffer): string {
	return createHash("sha256").update(data).digest("hex");
}

/** Trust identity of a gate command: SHA-256 over the JSON of its argv. */
export function commandSetHash(cmd: string[]): string {
	return sha256Hex(JSON.stringify(cmd));
}

/**
 * Refuse any gate command whose hash is not in `trustedHashes` (fail
 * closed). Empty commands are refused unconditionally.
 */
export function assertTrustedCommand(
	cmd: string[],
	trustedHashes: Set<string>,
): void {
	if (cmd.length === 0) {
		throw new Error(
			"assertTrustedCommand: refusing empty command (fail closed)",
		);
	}
	const hash = commandSetHash(cmd);
	if (!trustedHashes.has(hash)) {
		throw new Error(
			`assertTrustedCommand: refusing untrusted gate command (sha256:${hash} not in trusted set): ${JSON.stringify(cmd).slice(0, 160)}`,
		);
	}
}

interface SecretPattern {
	readonly id: string;
	readonly pattern: RegExp;
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
	{ id: "aws-access-key-id", pattern: /AKIA[0-9A-Z]{16}/g },
	{ id: "github-personal-access-token", pattern: /ghp_[A-Za-z0-9]{36}/g },
	{
		id: "private-key-block",
		pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g,
	},
	{ id: "live-secret-key", pattern: /sk-live-[A-Za-z0-9]+/g },
	{
		id: "api-key-assignment",
		pattern: /api[_-]?key\s*[:=]\s*['"][^'"]+['"]/gi,
	},
];

function redact(secret: string): string {
	return `${secret.slice(0, 4)}***<redacted>`;
}

/**
 * Scan `text` for secret shapes. Returns one finding per match:
 * `"<rule> at index <offset>: <redacted>"` where the redacted match keeps
 * only its first 4 characters (findings never carry live secrets). Returns
 * `[]` when clean.
 */
export function scanForSecrets(text: string): string[] {
	const findings: string[] = [];
	for (const { id, pattern } of SECRET_PATTERNS) {
		pattern.lastIndex = 0;
		for (const match of text.matchAll(pattern)) {
			findings.push(
				`${id} at index ${match.index ?? 0}: ${redact(match[0] ?? "")}`,
			);
		}
	}
	return findings;
}

export interface GateCommandOptions {
	readonly cmd: string[];
	readonly cwd: string;
	readonly useBwrap?: boolean;
	readonly trustedHashes?: Set<string>;
}

export interface GateCommandResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

/** True when the `bwrap` binary runs (used to decide sandbox vs. fallback). */
function bwrapAvailable(): boolean {
	try {
		return spawnSync("bwrap", ["--version"], { stdio: "ignore" }).status === 0;
	} catch {
		return false;
	}
}

/**
 * Run a gate command and capture its result. When `trustedHashes` is
 * supplied the command is trust-checked first (fail closed). With
 * `useBwrap`, the command runs under a minimal bubblewrap profile
 * (`--ro-bind / / --tmpfs /tmp --proc /proc --dev /dev --die-with-parent`);
 * when `bwrap` is missing, runs directly with a warning in `stderr`.
 * Non-zero exits are data (returned), never thrown — the caller gates on
 * `exitCode`.
 */
export async function runGateCommand(
	opts: GateCommandOptions,
): Promise<GateCommandResult> {
	const { cmd, cwd, useBwrap = false } = opts;
	if (cmd.length === 0) {
		throw new Error("runGateCommand: refusing empty command (fail closed)");
	}
	if (cwd.length === 0) {
		throw new Error("runGateCommand: cwd is required");
	}
	if (opts.trustedHashes !== undefined) {
		assertTrustedCommand(cmd, opts.trustedHashes);
	}
	const dir = path.resolve(cwd);
	let finalCmd = cmd;
	let warnings = "";
	if (useBwrap) {
		if (bwrapAvailable()) {
			finalCmd = [
				"bwrap",
				"--ro-bind",
				"/",
				"/",
				"--tmpfs",
				"/tmp",
				"--proc",
				"/proc",
				"--dev",
				"/dev",
				"--die-with-parent",
				"--chdir",
				dir,
				"--",
				...cmd,
			];
		} else {
			warnings =
				"warning: bwrap sandbox requested but the bwrap binary was not found; executing directly without a sandbox (recorded here, not fatal)\n";
		}
	}
	const [bin, ...args] = finalCmd as [string, ...string[]];
	return await new Promise<GateCommandResult>((resolve, reject) => {
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(bin, args, { cwd: dir });
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		let stdout = "";
		let stderr = warnings;
		if (child.stdout !== null) {
			child.stdout.on("data", (chunk: Buffer) => {
				stdout += chunk.toString("utf8");
			});
		}
		if (child.stderr !== null) {
			child.stderr.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf8");
			});
		}
		child.on("error", (error) => {
			reject(error);
		});
		child.on("close", (code) => {
			resolve({ exitCode: code ?? 1, stdout, stderr });
		});
	});
}
