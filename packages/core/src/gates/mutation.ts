// Syntactic mutation gate (85% kill threshold).
//
// `generateSourceMutants` produces deterministic single-token mutants in
// source order (stable ids `M1`, `M2`, … with 1-based line numbers) by
// swapping `===` ↔ `!==`, `>=` ↔ `<`, `true` ↔ `false`, and `&&` ↔ `||`.
// `runMutationGate` applies each mutant to its file one at a time, runs the
// test command, counts the mutant `killed` when the command exits non-zero
// (a timeout also counts as killed, following the Stryker convention: the
// suite cannot go green), and restores the original file immediately in a
// `finally` (plus a final restore per file).
//
// Edge decisions (documented, deterministic):
// - Zero mutants (mutation-free code): `score = 1`, `passed = true`, so code
//   with no mutable tokens never blocks the gate; the choice is recorded in
//   the result the caller logs.
// - Standalone `<` avoids `<=`, `<<`, `</`, `<!` shapes (lookahead/lookbehind
//   guards) so mutants stay syntactic rather than lexical noise; `<=` itself
//   is not in the SPEC operator set and is left alone.
// - Matching is purely textual (comments and string literals can mutate):
//   over-mutation fails safe — extra mutants only demand stronger tests.
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** Minimum killed-mutant fraction required to pass the gate. */
export const MUTATION_THRESHOLD = 0.85;

/** Per-mutant timeout: a hanging suite counts the mutant as killed. */
const MUTANT_TIMEOUT_MS = 120_000;

/** One deterministic syntactic mutant (full original/mutated source lines). */
export interface SourceMutant {
	readonly id: string;
	readonly line: number;
	readonly original: string;
	readonly mutated: string;
}

/** Gate outcome. `score = killed / total` (`1` when there are no mutants). */
export interface MutationGateResult {
	readonly score: number;
	readonly killed: number;
	readonly survived: number;
	readonly passed: boolean;
}

interface Replacement {
	readonly index: number;
	readonly length: number;
	readonly replacement: string;
}

/** All single-token replacements on one line (unsorted, may overlap). */
function replacementsForLine(line: string): Replacement[] {
	const out: Replacement[] = [];
	const push = (index: number, length: number, replacement: string): void => {
		if (index >= 0) out.push({ index, length, replacement });
	};
	for (let i = line.indexOf("!=="); i >= 0; i = line.indexOf("!==", i + 1)) {
		push(i, 3, "===");
	}
	for (let i = line.indexOf("==="); i >= 0; i = line.indexOf("===", i + 1)) {
		push(i, 3, "!==");
	}
	for (let i = line.indexOf(">="); i >= 0; i = line.indexOf(">=", i + 1)) {
		push(i, 2, "<");
	}
	for (let i = line.indexOf("<"); i >= 0; i = line.indexOf("<", i + 1)) {
		const prev = i > 0 ? (line[i - 1] as string) : "";
		const next = i + 1 < line.length ? (line[i + 1] as string) : "";
		if (prev === "<" || prev === "=" || prev === "!") continue;
		if (next === "<" || next === "=" || next === "/" || next === "!") continue;
		push(i, 1, ">=");
	}
	for (const match of line.matchAll(/&&/g)) {
		if (match.index !== undefined) push(match.index, 2, "||");
	}
	for (const match of line.matchAll(/\|\|/g)) {
		if (match.index !== undefined) push(match.index, 2, "&&");
	}
	for (const match of line.matchAll(/\btrue\b/g)) {
		if (match.index !== undefined) push(match.index, 4, "false");
	}
	for (const match of line.matchAll(/\bfalse\b/g)) {
		if (match.index !== undefined) push(match.index, 5, "true");
	}
	return out;
}

/**
 * Generate deterministic syntactic mutants for `code`, in source order
 * (line-major, column-minor). Ids are stable (`M1`, `M2`, …) and line
 * numbers are 1-based. Overlapping candidates resolve leftmost-first.
 */
export function generateSourceMutants(code: string): SourceMutant[] {
	const mutants: SourceMutant[] = [];
	const lines = code.split("\n");
	let counter = 1;
	for (const [lineIndex, line] of lines.entries()) {
		const candidates = replacementsForLine(line as string).sort(
			(a, b) => a.index - b.index,
		);
		let lastEnd = 0;
		for (const candidate of candidates) {
			if (candidate.index < lastEnd) continue;
			lastEnd = candidate.index + candidate.length;
			const source = line as string;
			const mutated = `${source.slice(0, candidate.index)}${candidate.replacement}${source.slice(candidate.index + candidate.length)}`;
			mutants.push({
				id: `M${counter++}`,
				line: lineIndex + 1,
				original: source,
				mutated,
			});
		}
	}
	return mutants;
}

interface TestRun {
	readonly exitCode: number;
	readonly timedOut: boolean;
}

/** Run the test command once, capturing only its exit (output is ignored). */
function runTestCommand(cmd: string[], cwd: string): Promise<TestRun> {
	return new Promise<TestRun>((resolve, reject) => {
		if (cmd.length === 0) {
			reject(new Error("runMutationGate: testCmd must be non-empty"));
			return;
		}
		const [bin, ...args] = cmd as [string, ...string[]];
		let child: ReturnType<typeof spawn>;
		try {
			child = spawn(bin, args, { cwd, stdio: "ignore" });
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
			return;
		}
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			child.kill("SIGKILL");
			resolve({ exitCode: -1, timedOut: true });
		}, MUTANT_TIMEOUT_MS);
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({ exitCode: code ?? 1, timedOut: false });
		});
	});
}

/**
 * Run the mutation gate: for every mutant of every target file (paths
 * relative to `worktreeDir`), write the mutated file, run `testCmd`, count
 * the mutant killed when the command exits non-zero or times out, and
 * restore the original file immediately in a `finally`. Passes only when
 * `score >= MUTATION_THRESHOLD` (0.85). No mutants → `score = 1`,
 * `passed = true` (recorded choice: mutation-free code never blocks).
 */
export async function runMutationGate(
	worktreeDir: string,
	targetFiles: string[],
	testCmd: string[],
): Promise<MutationGateResult> {
	if (targetFiles.length === 0) {
		throw new Error(
			"runMutationGate: targetFiles must list at least one source file",
		);
	}
	if (testCmd.length === 0) {
		throw new Error(
			"runMutationGate: testCmd must be a non-empty command array",
		);
	}
	const root = path.resolve(worktreeDir);
	let killed = 0;
	let total = 0;
	for (const relative of targetFiles) {
		const file = path.join(root, relative);
		let original: string;
		try {
			original = await readFile(file, "utf8");
		} catch {
			throw new Error(
				`runMutationGate: cannot read target file ${relative} under ${worktreeDir}`,
			);
		}
		try {
			for (const mutant of generateSourceMutants(original)) {
				const lines = original.split("\n");
				const index = mutant.line - 1;
				if (index < 0 || index >= lines.length) {
					throw new Error(
						`runMutationGate: mutant ${mutant.id} points at line ${mutant.line} outside ${relative}`,
					);
				}
				lines[index] = mutant.mutated;
				await writeFile(file, lines.join("\n"));
				let run: TestRun;
				try {
					run = await runTestCommand(testCmd, root);
				} finally {
					await writeFile(file, original);
				}
				total += 1;
				if (run.timedOut || run.exitCode !== 0) killed += 1;
			}
		} finally {
			await writeFile(file, original);
		}
	}
	const score = total === 0 ? 1 : killed / total;
	return {
		score,
		killed,
		survived: total - killed,
		passed: score >= MUTATION_THRESHOLD,
	};
}
