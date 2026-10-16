// Wave 3 CLI tests (`bun:test`, zero stubs): `.worktreeinclude` parsing /
// matching / syncing plus `es` CLI `main()` exit codes, all against real temp
// dirs and real `@heretek-ai/es-core` + `@heretek-ai/epistemic-verifier-mcp`
// imports.
import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { putCachedSource } from "@heretek-ai/epistemic-verifier-mcp";
import { main } from "../src/bin.ts";
import {
	collectWorktreeIncludes,
	matchWorktreePattern,
	parseWorktreeInclude,
	syncWorktreeIncludes,
} from "../src/worktree-include.ts";

async function fileExists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

describe("parseWorktreeInclude", () => {
	it("ignores comments and blank lines and trims entries", () => {
		expect(
			parseWorktreeInclude(
				"# secrets\n\n.env\n   .env.local  \n\t\n# certs\ncerts/*.pem\n",
			),
		).toEqual([".env", ".env.local", "certs/*.pem"]);
	});

	it("returns [] for empty or comment-only content", () => {
		expect(parseWorktreeInclude("")).toEqual([]);
		expect(parseWorktreeInclude("  \n# nothing\n   \n")).toEqual([]);
	});
});

describe("matchWorktreePattern", () => {
	it("matches exact names at any depth", () => {
		expect(matchWorktreePattern(".env", ".env")).toBe(true);
		expect(matchWorktreePattern(".env", "nested/.env")).toBe(true);
		expect(matchWorktreePattern(".env", ".env.local")).toBe(false);
		expect(matchWorktreePattern(".env", "src/index.ts")).toBe(false);
	});

	it("matches *.ext basename globs", () => {
		expect(matchWorktreePattern("*.pem", "a.pem")).toBe(true);
		expect(matchWorktreePattern("*.pem", "nested/dir/a.pem")).toBe(true);
		expect(matchWorktreePattern("*.pem", "a.key")).toBe(false);
	});

	it("treats dir/*.ext as a one-level glob", () => {
		expect(matchWorktreePattern("certs/*.pem", "certs/a.pem")).toBe(true);
		expect(matchWorktreePattern("certs/*.pem", "certs/nested/a.pem")).toBe(
			false,
		);
		expect(matchWorktreePattern("certs/*.pem", "other/a.pem")).toBe(false);
	});

	it("supports prefix* and *suffix globs", () => {
		expect(matchWorktreePattern(".env*", ".env.local")).toBe(true);
		expect(matchWorktreePattern("*.local", "nested/.env.local")).toBe(true);
		expect(matchWorktreePattern(".env*", ".en")).toBe(false);
	});

	it("gives ** contains semantics", () => {
		expect(matchWorktreePattern("certs/**", "certs/a/b/c.pem")).toBe(true);
		expect(matchWorktreePattern("**.pem", "deep/nested/a.pem")).toBe(true);
	});

	it("fails closed on path traversal shapes", () => {
		expect(matchWorktreePattern("../secret", "../secret")).toBe(false);
		expect(matchWorktreePattern(".env", "../evil/.env")).toBe(false);
		expect(matchWorktreePattern("a/../../b", "a/b")).toBe(false);
		expect(matchWorktreePattern("", ".env")).toBe(false);
		expect(matchWorktreePattern(".env", "")).toBe(false);
	});
});

describe("collectWorktreeIncludes + syncWorktreeIncludes", () => {
	it("returns [] when .worktreeinclude is absent", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "cli-includes-absent-"));
		expect(await collectWorktreeIncludes(base)).toEqual([]);
	});

	it("copies matches preserving relative paths and never stages in git", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "cli-sync-base-"));
		const worktree = await mkdtemp(path.join(tmpdir(), "cli-sync-tree-"));
		await writeFile(path.join(base, ".worktreeinclude"), ".env\ncerts/*.pem\n");
		await writeFile(path.join(base, ".env"), "SECRET=1\n");
		await mkdir(path.join(base, "certs", "nested"), { recursive: true });
		await writeFile(path.join(base, "certs", "a.pem"), "PEM-A\n");
		await writeFile(path.join(base, "certs", "nested", "b.pem"), "PEM-B\n");
		await mkdir(path.join(base, "src"), { recursive: true });
		await writeFile(path.join(base, "src", "index.ts"), "export {};\n");

		const result = await syncWorktreeIncludes(base, worktree);
		expect(result.copied).toEqual([".env", "certs/a.pem"]);
		expect(result.missing).toEqual([]);
		expect(await readFile(path.join(worktree, ".env"), "utf8")).toBe(
			"SECRET=1\n",
		);
		expect(await readFile(path.join(worktree, "certs", "a.pem"), "utf8")).toBe(
			"PEM-A\n",
		);
		// One-level glob: nested certs stay behind; unrelated sources stay behind.
		expect(
			await fileExists(path.join(worktree, "certs", "nested", "b.pem")),
		).toBe(false);
		expect(await fileExists(path.join(worktree, "src", "index.ts"))).toBe(
			false,
		);
		// No git staging side effects: sync never runs git and creates no .git.
		expect(await fileExists(path.join(worktree, ".git"))).toBe(false);
	});

	it("reports patterns that match nothing as missing", async () => {
		const base = await mkdtemp(path.join(tmpdir(), "cli-sync-missing-"));
		const worktree = await mkdtemp(path.join(tmpdir(), "cli-sync-missing-t-"));
		await writeFile(path.join(base, ".worktreeinclude"), ".env\ncerts/*.pem\n");
		const result = await syncWorktreeIncludes(base, worktree);
		expect(result.copied).toEqual([]);
		expect(result.missing).toEqual([".env", "certs/*.pem"]);
	});
});

describe("es main() exit codes", () => {
	it("help exits 0", async () => {
		expect(await main(["--help"])).toBe(0);
		expect(await main(["help"])).toBe(0);
		expect(await main([])).toBe(0);
	});

	it("unknown commands exit 1", async () => {
		expect(await main(["frobnicate"])).toBe(1);
		expect(await main(["key", "unseal"])).toBe(1);
	});

	it("init scaffolds and refuses to overwrite without --force; status is informational", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "cli-init-"));
		expect(await main(["init", "--dir", dir])).toBe(0);
		expect(await fileExists(path.join(dir, ".worktreeinclude"))).toBe(true);
		expect(await fileExists(path.join(dir, "frontier.json"))).toBe(true);
		expect(await fileExists(path.join(dir, ".factory"))).toBe(true);
		// Second init without --force refuses (exit 1).
		expect(await main(["init", "--dir", dir])).toBe(1);
		expect(await main(["status", "--dir", dir])).toBe(0);
	});

	it("status exits 0 even when no frontier exists", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "cli-status-"));
		expect(await main(["status", "--dir", dir])).toBe(0);
	});

	it("key seal + approve round-trip with the real core signer", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "cli-approve-"));
		expect(await main(["init", "--dir", dir])).toBe(0);
		const keyDir = path.join(dir, ".factory", "keys");
		expect(
			await main([
				"key",
				"seal",
				"--key-dir",
				keyDir,
				"--passphrase",
				"correct horse battery staple",
			]),
		).toBe(0);
		const frontierRaw = await readFile(path.join(dir, "frontier.json"), "utf8");
		const subject = createHash("sha256")
			.update(frontierRaw, "utf8")
			.digest("hex");
		expect(
			await main([
				"approve",
				"--stage",
				"GRILL",
				"--subject",
				subject,
				"--run-id",
				"run-1",
				"--key-dir",
				keyDir,
				"--passphrase",
				"correct horse battery staple",
				"--dir",
				dir,
			]),
		).toBe(0);
		expect(
			await fileExists(
				path.join(dir, ".factory", "approvals", "GRILL-run-1.json"),
			),
		).toBe(true);
		expect(await main(["status", "--dir", dir])).toBe(0);
		// Fail closed: bad stage, bad subject, missing passphrase all exit 1.
		expect(
			await main([
				"approve",
				"--stage",
				"NOPE",
				"--subject",
				subject,
				"--run-id",
				"run-1",
				"--key-dir",
				keyDir,
				"--passphrase",
				"correct horse battery staple",
				"--dir",
				dir,
			]),
		).toBe(1);
		expect(
			await main([
				"approve",
				"--stage",
				"GRILL",
				"--subject",
				"not-a-hash",
				"--run-id",
				"run-1",
				"--key-dir",
				keyDir,
				"--passphrase",
				"correct horse battery staple",
				"--dir",
				dir,
			]),
		).toBe(1);
	});

	it("audit-research exits 0 when grounded and 1 when pruned", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "cli-audit-"));
		const cacheDir = path.join(root, "cache");
		const stateDir = path.join(root, "state");
		const mdFile = path.join(root, "research.md");
		const content =
			"The quick brown fox jumps over the lazy dog near the riverbank at dawn.";
		const put = await putCachedSource(cacheDir, stateDir, {
			url: "https://example.com/fox",
			title: "Fox",
			content,
		});
		await writeFile(
			mdFile,
			`Finding [VERIFIED: sha256:${put.sha256} "quick brown fox jumps"] noted.\n`,
		);
		expect(
			await main([
				"audit-research",
				"--markdown",
				mdFile,
				"--cache-dir",
				cacheDir,
				"--state-dir",
				stateDir,
			]),
		).toBe(0);
		await writeFile(
			mdFile,
			`Bogus [VERIFIED: sha256:${put.sha256} "purple elephant parades loudly"] noted.\n`,
		);
		expect(
			await main([
				"audit-research",
				"--markdown",
				mdFile,
				"--cache-dir",
				cacheDir,
				"--state-dir",
				stateDir,
			]),
		).toBe(1);
	});

	it("gate-mutation exits 0 on killed mutants (false) and 1 on survivors (true)", async () => {
		const dir = await mkdtemp(path.join(tmpdir(), "cli-gate-"));
		const target = path.join(dir, "target.ts");
		const original = `export function eq(a: number, b: number): boolean {\n  return a === b;\n}\n`;
		await writeFile(target, original);
		expect(
			await main([
				"gate-mutation",
				"--dir",
				dir,
				"--files",
				"target.ts",
				"--",
				"false",
			]),
		).toBe(0);
		expect(
			await main([
				"gate-mutation",
				"--dir",
				dir,
				"--files",
				"target.ts",
				"--",
				"true",
			]),
		).toBe(1);
		// The gate restores every target file even after a full run.
		expect(await readFile(target, "utf8")).toBe(original);
	});
});
