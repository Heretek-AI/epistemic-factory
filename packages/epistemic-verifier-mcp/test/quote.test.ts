import { describe, expect, it } from "bun:test";
import {
	locateQuote,
	MIN_QUOTE,
	normalizeForQuote,
	normalizeWithMap,
	verifyQuote,
} from "../src/quote.ts";

/** Narrow `T | undefined` without a non-null assertion (biome forbids `!`). */
function defined<T>(value: T | undefined, what: string): T {
	if (value === undefined) throw new Error(`test precondition failed: ${what}`);
	return value;
}

describe("normalizeForQuote", () => {
	it("folds curly single quotes to ASCII apostrophe", () => {
		expect(normalizeForQuote("it‘s‚‛′")).toBe("it's'''");
	});

	it("folds curly double quotes to ASCII quote", () => {
		expect(normalizeForQuote("a“b”c")).toBe('a"b"c');
		expect(normalizeForQuote("„x‟")).toBe('"x"');
	});

	it("folds dashes (hyphen, non-breaking hyphen, en/em dash, bar, minus) to hyphen", () => {
		expect(normalizeForQuote("a‐b‑c–d—e―f−g")).toBe("a-b-c-d-e-f-g");
	});

	it("folds NBSP and special spaces to plain spaces, then collapses", () => {
		expect(normalizeForQuote("a b c　d")).toBe("a b c d");
	});

	it("strips markdown links to their label", () => {
		expect(normalizeForQuote("See [the docs](https://example.com/x) now")).toBe(
			"See the docs now",
		);
	});

	it("strips markdown emphasis markers", () => {
		expect(normalizeForQuote("**bold** and __u__ and `code`")).toBe(
			"bold and u and code",
		);
	});

	it("collapses whitespace runs and trims", () => {
		expect(normalizeForQuote("  a \t\n b  ")).toBe("a b");
	});

	it("applies NFKC (ligatures decompose)", () => {
		expect(normalizeForQuote("ﬁle")).toBe("file");
	});

	it("leaves a non-link bracketed span alone", () => {
		expect(normalizeForQuote("[1] cited here")).toBe("[1] cited here");
	});
});

describe("verifyQuote", () => {
	const source =
		"The quick brown fox jumps over the lazy dog near the riverbank at dawn.";

	it("accepts an exact long quote and reports its normalised index", () => {
		const check = verifyQuote(source, "quick brown fox jumps");
		expect(check.ok).toBe(true);
		expect(check.index).toBe(
			normalizeForQuote(source).indexOf("quick brown fox jumps"),
		);
	});

	it("rejects quotes shorter than MIN_QUOTE (12)", () => {
		expect(MIN_QUOTE).toBe(12);
		const check = verifyQuote(source, "quick brown");
		expect(check.ok).toBe(false);
		expect(check.reason).toMatch(/at least 12/);
	});

	it("rejects an empty quote", () => {
		expect(verifyQuote(source, "   ").ok).toBe(false);
	});

	it("splits on ... and requires fragments in strict sequential order", () => {
		expect(verifyQuote(source, "quick brown fox ... lazy dog near").ok).toBe(
			true,
		);
		// Reversed order is not evidence: the second fragment never follows the first.
		const reversed = verifyQuote(source, "lazy dog near ... quick brown fox");
		expect(reversed.ok).toBe(false);
		expect(reversed.reason).toMatch(/not found verbatim/);
	});

	it("splits on the unicode ellipsis …", () => {
		expect(verifyQuote(source, "quick brown fox … lazy dog near").ok).toBe(
			true,
		);
	});

	it("rejects any ellipsis fragment shorter than MIN_QUOTE", () => {
		const check = verifyQuote(source, "quick brown fox jumps ... dog");
		expect(check.ok).toBe(false);
		expect(check.reason).toMatch(/fragment too short/);
	});

	it("rejects a one-word alteration (no fuzzy matching)", () => {
		const check = verifyQuote(source, "quick brown cat jumps over");
		expect(check.ok).toBe(false);
		expect(check.reason).toMatch(/not found verbatim/);
	});

	it("is order-sensitive when a fragment repeats (strict forward scan)", () => {
		const hay = "alpha beta gamma alpha beta gamma delta epsilon zeta eta";
		// Second fragment must occur AFTER the first match, not anywhere.
		expect(
			verifyQuote(hay, "alpha beta gamma ... alpha beta gamma delta").ok,
		).toBe(true);
		expect(
			verifyQuote(hay, "alpha beta gamma delta ... alpha beta gamma").ok,
		).toBe(false);
	});

	it("tolerates typography differences between source and quote", () => {
		const curly = "The “quick brown” fox—it’s fast";
		expect(verifyQuote(curly, '"quick brown" fox-it\'s fast').ok).toBe(true);
	});

	it("quotes rendered markdown link text", () => {
		const md = "Read [the manual](https://example.com/manual) carefully today";
		expect(verifyQuote(md, "Read the manual carefully").ok).toBe(true);
	});
});

describe("normalizeWithMap", () => {
	const battery = [
		"plain text here",
		"It’s “quoted” — with—dashes and spaces",
		"See [label](https://x.example/y) plus **bold** and `code`",
		"  padded \t\n whitespace  ",
		`ﬁ ligature plus caf${String.fromCharCode(0xe9)} precomposed`,
		"[not a link] but [yes](https://t.example)",
	];
	for (const input of battery) {
		it(`maps exactly like normalizeForQuote: ${JSON.stringify(input).slice(0, 40)}`, () => {
			const mapped = normalizeWithMap(input);
			expect(mapped.text).toBe(normalizeForQuote(input));
			expect(mapped.map.length).toBe(mapped.text.length);
			// Every mapped offset lands on a real character of the input.
			for (const offset of mapped.map) {
				expect(offset).toBeGreaterThanOrEqual(0);
				expect(offset).toBeLessThan(input.length);
			}
		});
	}
});

describe("locateQuote", () => {
	it("returns exact original offsets that slice back to the fragment", () => {
		const source = "Before the quick brown fox jumps over, after.";
		const ranges = defined(
			locateQuote(source, "quick brown fox jumps"),
			"locateQuote ranges",
		);
		expect(ranges).toHaveLength(1);
		const first = defined(ranges[0], "first range");
		expect(source.slice(first.start, first.end)).toBe("quick brown fox jumps");
		expect(first.start).toBe(source.indexOf("quick brown fox jumps"));
	});

	it("returns one range per ellipsis fragment in order", () => {
		const source =
			"The quick brown fox jumps over the lazy dog near the riverbank.";
		const ranges = defined(
			locateQuote(source, "quick brown fox ... lazy dog near"),
			"locateQuote ranges",
		);
		expect(ranges).toHaveLength(2);
		const first = defined(ranges[0], "first range");
		const second = defined(ranges[1], "second range");
		expect(source.slice(first.start, first.end)).toBe("quick brown fox");
		expect(source.slice(second.start, second.end)).toBe("lazy dog near");
	});

	it("self-checks: every range normalises back to its fragment", () => {
		const source =
			"See [the manual](https://example.com/m) carefully today please";
		const ranges = defined(
			locateQuote(source, "See the manual carefully"),
			"locateQuote ranges",
		);
		for (const range of ranges) {
			expect(range.start).toBeLessThan(range.end);
		}
		const back = ranges
			.map((r) => normalizeForQuote(source.slice(r.start, r.end)))
			.join(" ");
		expect(back).toContain("the manual");
	});

	it("returns undefined for a quote that does not verify", () => {
		expect(
			locateQuote("some source text here", "totally absent phrase here"),
		).toBeUndefined();
		expect(locateQuote("some source text here", "short")).toBeUndefined();
	});

	it("returns undefined for an out-of-order ellipsis quote", () => {
		const source =
			"The quick brown fox jumps over the lazy dog near the riverbank.";
		expect(
			locateQuote(source, "lazy dog near ... quick brown fox"),
		).toBeUndefined();
	});
});
