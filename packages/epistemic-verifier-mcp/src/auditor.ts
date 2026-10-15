// Epistemic auditor for research markdown.
//
// Every claim line carrying a `[VERIFIED: sha256:<hash> "<quote>"]` tag must
// quote its cached source verbatim (after the documented normalisation in
// `quote.ts`). Lines tagged `[INFERRED: ...]`, `[HYPOTHESIS: ...]`, or
// `[NEGATIVE_KNOWLEDGE: ...]` are recognised and pass through untouched —
// they are reasoning, falsification plans, or search records, not verbatim
// claims, so they are counted as pass-through and never verified.
//
// Any `[VERIFIED]` line whose source is missing, unsealed, tampered, or
// fails `verifyQuote` is recorded in `failures` and moved to a
// `## Pruned claims` section at the bottom of `prunedMarkdown`. The auditor
// marks, prunes, and refuses failing claims; it never re-tags a claim.
import { getCachedSource, TamperedSourceError } from "./cache.ts";
import { verifyQuote } from "./quote.ts";

export interface AuditFailure {
	/** 1-based line number in the original markdown. */
	readonly line: number;
	readonly text: string;
	readonly reason: string;
}

export interface AuditResult {
	readonly passed: boolean;
	readonly verifiedCount: number;
	readonly failures: AuditFailure[];
	readonly prunedMarkdown: string;
}

const TAG_NAMES = [
	"VERIFIED",
	"INFERRED",
	"HYPOTHESIS",
	"NEGATIVE_KNOWLEDGE",
] as const;
type TagName = (typeof TAG_NAMES)[number];

interface Tag {
	readonly kind: TagName;
	readonly body: string;
	readonly raw: string;
}

/**
 * Extract epistemic tags from a line. A tag body may hold brackets of its
 * own (a quote citing "[1]"), so brackets are matched by depth. Returns the
 * tags plus any malformed `[VERIFIED:`-looking spans that could not be
 * parsed (fail closed: a near-miss is still a claim attempt, never ignored).
 */
function parseTags(line: string): { tags: Tag[]; malformed: string[] } {
	const tags: Tag[] = [];
	const malformed: string[] = [];
	let i = 0;
	while (i < line.length) {
		const open = line.indexOf("[", i);
		if (open < 0) break;
		const kind = TAG_NAMES.find((name) =>
			line.startsWith(`${name}:`, open + 1),
		);
		if (kind === undefined) {
			// A "[VERIFIED"-ish span that does not parse as a tag is malformed, not invisible.
			if (/^\[VERIFIED\b/i.test(line.slice(open))) {
				malformed.push(line.slice(open, open + 120));
				i = open + 1;
				continue;
			}
			i = open + 1;
			continue;
		}
		// Match brackets by depth: the body may contain brackets of its own.
		let close = -1;
		for (let depth = 1, k = open + 1 + kind.length + 1; k < line.length; k++) {
			if (line[k] === "[") depth++;
			else if (line[k] === "]" && --depth === 0) {
				close = k;
				break;
			}
		}
		if (close < 0) {
			if (kind === "VERIFIED") malformed.push(line.slice(open, open + 120));
			break;
		}
		tags.push({
			kind,
			body: line.slice(open + 1 + kind.length + 1, close).trim(),
			raw: line.slice(open, close + 1),
		});
		i = close + 1;
	}
	return { tags, malformed };
}

const OPEN_QUOTES = ['"', "“", "”"];
const CLOSE_QUOTES = ['"', "“", "”"];

function stripOuterQuotes(text: string): string | undefined {
	const first = text[0];
	const last = text[text.length - 1];
	if (first === undefined || last === undefined) return undefined;
	if (!OPEN_QUOTES.includes(first) || !CLOSE_QUOTES.includes(last))
		return undefined;
	return text.slice(1, -1);
}

interface VerifiedClaim {
	readonly hash: string;
	readonly quote: string;
}

/** Parse `sha256:<64-hex> "<quote>"` (straight or curly quotes). Undefined when malformed. */
function parseVerifiedBody(body: string): VerifiedClaim | undefined {
	const match = /^sha256:([0-9a-fA-F]{64})\s+([\s\S]+)$/.exec(body.trim());
	if (match === null) return undefined;
	const quote = stripOuterQuotes((match[2] as string).trim());
	if (quote === undefined || quote.length === 0) return undefined;
	return { hash: (match[1] as string).toLowerCase(), quote };
}

/** Lines that can carry claims: not blank, not a heading, not inside a fenced code block. */
function isAuditableLine(line: string, fenced: boolean): boolean {
	const text = line.trim();
	if (fenced) return false;
	if (text.length === 0) return false;
	if (/^#{1,6}\s/.test(text)) return false;
	return true;
}

/**
 * Audit research markdown against the sealed source cache.
 *
 * - Each `[VERIFIED: sha256:<hash> "<quote>"]` tag loads `<hash>` via
 *   `getCachedSource` (which throws `TamperedSourceError` for missing,
 *   unsealed, or modified entries) and runs `verifyQuote`. Every tag on a
 *   failing line contributes its reason; the line is pruned.
 * - `[INFERRED:]`, `[HYPOTHESIS:]`, `[NEGATIVE_KNOWLEDGE:]` pass through.
 * - `passed` is true only when at least one VERIFIED claim grounded out and
 *   nothing failed. `prunedMarkdown` removes failing lines and appends a
 *   `## Pruned claims` section; with no failures it is the input unchanged.
 */
export async function auditResearchMarkdown(
	markdown: string,
	cacheDir: string,
	stateDir: string,
): Promise<AuditResult> {
	const failures: AuditFailure[] = [];
	const failedLines = new Set<number>();
	let verifiedCount = 0;
	let fenced = false;
	let inPrunedSection = false;
	const lines = markdown.split("\n");

	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] as string;
		const trimmed = line.trim();
		if (trimmed.startsWith("```")) {
			fenced = !fenced;
			continue;
		}
		if (/^#{1,6}\s+pruned claims\b/i.test(trimmed)) {
			inPrunedSection = true;
			continue;
		} else if (/^#{1,6}\s/.test(trimmed)) {
			inPrunedSection = false;
			continue;
		}
		if (inPrunedSection || !isAuditableLine(line, fenced)) continue;

		const { tags, malformed } = parseTags(line);
		const reasons: string[] = malformed.map(
			(span) => `malformed VERIFIED tag: ${span}`,
		);
		const verifiedTags = tags.filter((tag) => tag.kind === "VERIFIED");
		for (const tag of verifiedTags) {
			const claim = parseVerifiedBody(tag.body);
			if (claim === undefined) {
				reasons.push(
					`malformed VERIFIED tag (want [VERIFIED: sha256:<64-hex> "verbatim quote"]): ${tag.raw.slice(0, 120)}`,
				);
				continue;
			}
			let content: string;
			try {
				({ content } = await getCachedSource(cacheDir, stateDir, claim.hash));
			} catch (error: unknown) {
				reasons.push(
					error instanceof TamperedSourceError
						? `source ${claim.hash.slice(0, 16)}… unusable: ${error.message}`
						: `source ${claim.hash.slice(0, 16)}… load failed: ${(error as Error)?.message ?? error}`,
				);
				continue;
			}
			const check = verifyQuote(content, claim.quote);
			if (!check.ok) {
				reasons.push(`quote failed verification: ${check.reason}`);
				continue;
			}
			verifiedCount++;
		}
		if (reasons.length > 0) {
			const lineNo = index + 1;
			failedLines.add(lineNo);
			failures.push({ line: lineNo, text: line, reason: reasons.join("; ") });
		}
	}

	let prunedMarkdown = markdown;
	if (failures.length > 0) {
		const kept = lines.filter((_, index) => !failedLines.has(index + 1));
		const section = [
			"",
			"## Pruned claims",
			"",
			...failures.flatMap((failure) => [
				`> ${failure.text}`,
				`> — pruned (line ${failure.line}): ${failure.reason}`,
				"",
			]),
		];
		let body = kept.join("\n");
		while (body.endsWith("\n")) body = body.slice(0, -1);
		prunedMarkdown = `${`${body}\n${section.join("\n")}`.trimEnd()}\n`;
	}

	return {
		passed: failures.length === 0 && verifiedCount >= 1,
		verifiedCount,
		failures,
		prunedMarkdown,
	};
}
