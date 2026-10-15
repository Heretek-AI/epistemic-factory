import { beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { auditResearchMarkdown } from "../src/auditor.ts";
import { putCachedSource } from "../src/cache.ts";

/** Narrow `T | undefined` without a non-null assertion (biome forbids `!`). */
function defined<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`test precondition failed: ${what}`);
	return value;
}

let cacheDir: string;
let stateDir: string;

const SOURCE =
	"The quick brown fox jumps over the lazy dog near the riverbank at dawn.";

beforeEach(async () => {
	const root = await mkdtemp(path.join(tmpdir(), "epis-audit-"));
	cacheDir = path.join(root, "cache");
	stateDir = path.join(root, "state");
});

async function seedSource(content: string = SOURCE): Promise<string> {
	const put = await putCachedSource(cacheDir, stateDir, {
		url: "https://example.com/fox",
		title: "Fox Report",
		content,
	});
	return put.sha256;
}

describe("auditResearchMarkdown", () => {
	it("passes a VERIFIED claim with an exact quote; output is untouched", async () => {
		const hash = await seedSource();
		const markdown = `# Findings\n\nThe fox was fast [VERIFIED: sha256:${hash} "quick brown fox jumps over"] today.\n`;
		const result = await auditResearchMarkdown(markdown, cacheDir, stateDir);
		expect(result.passed).toBe(true);
		expect(result.verifiedCount).toBe(1);
		expect(result.failures).toEqual([]);
		expect(result.prunedMarkdown).toBe(markdown);
	});

	it("passes multi-fragment ellipsis quotes", async () => {
		const hash = await seedSource();
		const markdown = `Claim [VERIFIED: sha256:${hash} "quick brown fox ... lazy dog near"] holds.\n`;
		const result = await auditResearchMarkdown(markdown, cacheDir, stateDir);
		expect(result.passed).toBe(true);
		expect(result.verifiedCount).toBe(1);
	});

	it("tolerates typography differences (curly quotes in source, straight in claim)", async () => {
		const hash = await seedSource(
			"The “quick brown” fox—it’s remarkably fast today indeed",
		);
		const markdown = `Claim [VERIFIED: sha256:${hash} ""quick brown" fox-it's remarkably fast"] ok.\n`;
		const result = await auditResearchMarkdown(markdown, cacheDir, stateDir);
		expect(result.passed).toBe(true);
	});

	it("prunes a VERIFIED line with an altered quote and records the failure", async () => {
		const hash = await seedSource();
		const badLine = `The fox was slow [VERIFIED: sha256:${hash} "quick brown cat jumps over"] indeed.`;
		const markdown = `# Findings\n\n${badLine}\n\nAnother paragraph here.\n`;
		const result = await auditResearchMarkdown(markdown, cacheDir, stateDir);
		expect(result.passed).toBe(false);
		expect(result.verifiedCount).toBe(0);
		expect(result.failures.length).toBe(1);
		const failure = defined(result.failures[0], "failure");
		expect(failure.line).toBe(3);
		expect(failure.text).toBe(badLine);
		expect(failure.reason).toMatch(/not found verbatim/);
		expect(result.prunedMarkdown).toContain("## Pruned claims");
		// The failing line is moved out of the body (it survives only as a quoted prune record).
		const head = result.prunedMarkdown.split("## Pruned claims")[0] as string;
		expect(head).not.toContain(badLine);
		expect(result.prunedMarkdown).toContain(badLine);
		expect(result.prunedMarkdown).toContain("Another paragraph here.");
	});

	it("prunes a VERIFIED line whose source is missing from the cache", async () => {
		const hash = "f".repeat(64);
		const markdown = `Claim [VERIFIED: sha256:${hash} "quick brown fox jumps over"] floats.\n`;
		const result = await auditResearchMarkdown(markdown, cacheDir, stateDir);
		expect(result.passed).toBe(false);
		expect(result.failures.length).toBe(1);
		expect(defined(result.failures[0], "failure").reason).toMatch(
			/unusable|load failed/,
		);
		expect(result.prunedMarkdown).toContain("## Pruned claims");
	});

	it("prunes a VERIFIED line whose cached entry was tampered (seal broken)", async () => {
		const hash = await seedSource();
		const { writeFile } = await import("node:fs/promises");
		await writeFile(
			path.join(cacheDir, `${hash}.md`),
			"FORGED REPLACEMENT CONTENT PLANTED",
		);
		const markdown = `Claim [VERIFIED: sha256:${hash} "quick brown fox jumps over"] floats.\n`;
		const result = await auditResearchMarkdown(markdown, cacheDir, stateDir);
		expect(result.passed).toBe(false);
		expect(result.failures.length).toBe(1);
		expect(result.prunedMarkdown).toContain("## Pruned claims");
	});

	it("prunes malformed VERIFIED tags (bad hash, missing quote) fail-closed", async () => {
		const markdown =
			`Bad hash [VERIFIED: sha256:xyz "quick brown fox jumps over"] here.\n` +
			`No quote [VERIFIED: sha256:${"a".repeat(64)}] here.\n`;
		const result = await auditResearchMarkdown(markdown, cacheDir, stateDir);
		expect(result.passed).toBe(false);
		expect(result.failures.length).toBe(2);
		expect(result.prunedMarkdown).toContain("## Pruned claims");
	});

	it("prunes quotes shorter than MIN_QUOTE", async () => {
		const hash = await seedSource();
		const markdown = `Claim [VERIFIED: sha256:${hash} "quick brown"] tiny.\n`;
		const result = await auditResearchMarkdown(markdown, cacheDir, stateDir);
		expect(result.passed).toBe(false);
		expect(result.failures.length).toBe(1);
		expect(defined(result.failures[0], "failure").reason).toMatch(/too short/);
	});

	it("passes INFERRED / HYPOTHESIS / NEGATIVE_KNOWLEDGE through untouched", async () => {
		const hash = await seedSource();
		const markdown =
			`Grounded [VERIFIED: sha256:${hash} "quick brown fox jumps over"] yes.\n` +
			`Reasoning [INFERRED: the fox outran the dog, so it is faster] ok.\n` +
			`Test [HYPOTHESIS: time the fox over 100m to falsify the speed claim] ok.\n` +
			`Searched [NEGATIVE_KNOWLEDGE: no other predators appear in the report] ok.\n`;
		const result = await auditResearchMarkdown(markdown, cacheDir, stateDir);
		expect(result.passed).toBe(true);
		expect(result.verifiedCount).toBe(1);
		expect(result.failures).toEqual([]);
		expect(result.prunedMarkdown).toBe(markdown);
	});

	it("keeps a passing doc passing when only passthrough tags are present... except verifiedCount is 0", async () => {
		const markdown = `Reasoning [INFERRED: the fox outran the dog, so it is faster] ok.\n`;
		const result = await auditResearchMarkdown(markdown, cacheDir, stateDir);
		// No failures, nothing pruned — but nothing VERIFIED either, so not passed.
		expect(result.failures).toEqual([]);
		expect(result.verifiedCount).toBe(0);
		expect(result.passed).toBe(false);
		expect(result.prunedMarkdown).toBe(markdown);
	});

	it("ignores VERIFIED-looking text inside fenced code blocks", async () => {
		const hash = await seedSource();
		const markdown =
			`Grounded [VERIFIED: sha256:${hash} "quick brown fox jumps over"] yes.\n` +
			"```\n" +
			`[VERIFIED: sha256:${hash} "example format"]\n` +
			"```\n";
		const result = await auditResearchMarkdown(markdown, cacheDir, stateDir);
		expect(result.passed).toBe(true);
		expect(result.prunedMarkdown).toBe(markdown);
	});

	it("one failing line does not sink the verifiedCount of passing lines, but fails the audit", async () => {
		const hash = await seedSource();
		const markdown =
			`Good [VERIFIED: sha256:${hash} "quick brown fox jumps over"] yes.\n` +
			`Bad [VERIFIED: sha256:${hash} "purple elephant parades loudly"] no.\n`;
		const result = await auditResearchMarkdown(markdown, cacheDir, stateDir);
		expect(result.verifiedCount).toBe(1);
		expect(result.passed).toBe(false);
		expect(result.failures.length).toBe(1);
		expect(defined(result.failures[0], "failure").line).toBe(2);
	});
});
