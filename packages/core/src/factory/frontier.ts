// Append-only design decision frontier (`frontier.json`).
//
// The frontier records the grilled idea and every design decision taken per
// round: `{ version: 1, idea, deltaFromHead, rounds: [{ round, decisions:
// [{ id, question, answer }] }] }`. `saveFrontier` enforces append-only
// evolution and fails closed:
// - an empty `deltaFromHead` is refused ("Context-only ideas without a
//   concrete behavioral delta from HEAD are refused" — a grill that produced
//   only context may not advance the factory);
// - deleting any prior decision ID is refused (history is never rewritten);
// - round numbers must be appended in strictly increasing order with no
//   duplicates and no deletion of prior rounds.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

/** A single grilled design decision. */
export interface FrontierDecision {
	readonly id: string;
	readonly question: string;
	readonly answer: string;
}

/** All decisions taken in one grill round. */
export interface FrontierRound {
	readonly round: number;
	readonly decisions: FrontierDecision[];
}

/** The design decision frontier (versioned for forward compatibility). */
export interface Frontier {
	readonly version: 1;
	readonly idea: string;
	readonly deltaFromHead: string;
	readonly rounds: FrontierRound[];
}

/** Canonical JSON: recursively lexicographically sorted keys, no whitespace. */
function canonicalJson(value: unknown): string {
	if (value === null || typeof value !== "object") {
		return JSON.stringify(value) ?? "null";
	}
	if (Array.isArray(value)) {
		return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	}
	const entries = Object.entries(value as Record<string, unknown>).sort(
		([a], [b]) => (a < b ? -1 : a > b ? 1 : 0),
	);
	return `{${entries
		.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
		.join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Validate an unknown value as a Frontier; throws a descriptive Error. */
function validateFrontier(
	value: unknown,
	what: string,
): asserts value is Frontier {
	if (!isRecord(value)) {
		throw new Error(`${what}: frontier must be an object`);
	}
	if (value.version !== 1) {
		throw new Error(
			`${what}: unsupported frontier version ${JSON.stringify(value.version)} (want 1)`,
		);
	}
	if (typeof value.idea !== "string") {
		throw new Error(`${what}: frontier.idea must be a string`);
	}
	if (typeof value.deltaFromHead !== "string") {
		throw new Error(`${what}: frontier.deltaFromHead must be a string`);
	}
	if (!Array.isArray(value.rounds)) {
		throw new Error(`${what}: frontier.rounds must be an array`);
	}
	for (const [index, round] of value.rounds.entries()) {
		if (!isRecord(round)) {
			throw new Error(`${what}: frontier.rounds[${index}] must be an object`);
		}
		if (!Number.isInteger(round.round)) {
			throw new Error(
				`${what}: frontier.rounds[${index}].round must be an integer`,
			);
		}
		if (!Array.isArray(round.decisions)) {
			throw new Error(
				`${what}: frontier.rounds[${index}].decisions must be an array`,
			);
		}
		for (const [dIndex, decision] of (round.decisions as unknown[]).entries()) {
			if (!isRecord(decision)) {
				throw new Error(
					`${what}: frontier.rounds[${index}].decisions[${dIndex}] must be an object`,
				);
			}
			if (
				typeof decision.id !== "string" ||
				typeof decision.question !== "string" ||
				typeof decision.answer !== "string"
			) {
				throw new Error(
					`${what}: frontier.rounds[${index}].decisions[${dIndex}] must have string { id, question, answer }`,
				);
			}
			if (decision.id.length === 0) {
				throw new Error(
					`${what}: frontier.rounds[${index}].decisions[${dIndex}].id must be non-empty`,
				);
			}
		}
	}
}

function decisionIds(frontier: Frontier): Set<string> {
	const ids = new Set<string>();
	for (const round of frontier.rounds) {
		for (const decision of round.decisions) {
			ids.add(decision.id);
		}
	}
	return ids;
}

/**
 * Accept an evolved frontier over a previous one. Refuses (throws) when:
 * - `next.deltaFromHead` is empty/blank — context-only ideas without a
 *   concrete behavioral delta from HEAD are refused;
 * - any prior decision ID was deleted (the frontier is append-only);
 * - any prior round number is missing, or `next` rounds are not strictly
 *   increasing (round regression / duplicate round numbers).
 * Returns void on success. `prev` may be `undefined` for the first save.
 */
export function saveFrontier(prev: Frontier | undefined, next: Frontier): void {
	validateFrontier(next, "saveFrontier(next)");
	if (next.deltaFromHead.trim().length === 0) {
		throw new Error(
			"saveFrontier refused: frontier carries no concrete behavioral delta from HEAD (deltaFromHead is empty) — context-only ideas without a concrete behavioral delta from HEAD are refused",
		);
	}
	const seen = new Set<string>();
	for (const round of next.rounds) {
		for (const decision of round.decisions) {
			if (seen.has(decision.id)) {
				throw new Error(
					`saveFrontier refused: duplicate decision id "${decision.id}" (decision ids must be unique)`,
				);
			}
			seen.add(decision.id);
		}
	}
	let last = -Infinity;
	for (const round of next.rounds) {
		if (!Number.isFinite(round.round) || round.round <= last) {
			throw new Error(
				`saveFrontier refused: round number regression or duplicate (round ${round.round} follows ${last === -Infinity ? "nothing" : last}; rounds must be appended in strictly increasing order)`,
			);
		}
		last = round.round;
	}
	if (prev === undefined) return;
	validateFrontier(prev, "saveFrontier(prev)");
	const nextIds = decisionIds(next);
	for (const id of decisionIds(prev)) {
		if (!nextIds.has(id)) {
			throw new Error(
				`saveFrontier refused: frontier is append-only and refuses to delete prior decision "${id}"`,
			);
		}
	}
	const nextRounds = new Set(next.rounds.map((round) => round.round));
	for (const round of prev.rounds) {
		if (!nextRounds.has(round.round)) {
			throw new Error(
				`saveFrontier refused: frontier is append-only and refuses to delete prior round ${round.round}`,
			);
		}
	}
}

/**
 * Load and validate `frontier.json` from disk. Throws a descriptive Error
 * when the file is missing, unparsable, or fails validation (fail closed).
 */
export async function loadFrontier(filePath: string): Promise<Frontier> {
	let raw: string;
	try {
		raw = await readFile(filePath, "utf8");
	} catch {
		throw new Error(`loadFrontier: frontier file not found: ${filePath}`);
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		throw new Error(
			`loadFrontier: frontier file is not valid JSON: ${filePath}`,
		);
	}
	validateFrontier(parsed, `loadFrontier(${filePath})`);
	if (parsed.deltaFromHead.trim().length === 0) {
		throw new Error(
			`loadFrontier refused: ${filePath} carries no concrete behavioral delta from HEAD (deltaFromHead is empty)`,
		);
	}
	return parsed;
}

/** SHA-256 hex of the canonical JSON of a frontier (approval binding). */
export function frontierHash(frontier: Frontier): string {
	return createHash("sha256")
		.update(canonicalJson(frontier), "utf8")
		.digest("hex");
}
