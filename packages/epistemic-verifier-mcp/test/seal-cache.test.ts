import { beforeEach, describe, expect, it } from "bun:test";
import { Buffer } from "node:buffer";
import { mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	getCachedSource,
	putCachedSource,
	sha256Hex,
	TamperedSourceError,
} from "../src/cache.ts";
import {
	engineKeyPath,
	ensureEngineKey,
	readEngineKey,
	sealMeta,
	verifyMetaSeal,
} from "../src/seal.ts";

let root: string;
let cacheDir: string;
let stateDir: string;

beforeEach(async () => {
	root = await mkdtemp(path.join(tmpdir(), "epis-seal-"));
	cacheDir = path.join(root, "cache");
	stateDir = path.join(root, "state");
});

describe("engine.key lifecycle", () => {
	it("creates engine.key with mode 0600 and 32 bytes, then returns the same key", async () => {
		const first = await ensureEngineKey(stateDir);
		expect(first.length).toBeGreaterThanOrEqual(32);
		const mode = (await stat(engineKeyPath(stateDir))).mode & 0o777;
		expect(mode).toBe(0o600);
		const second = await ensureEngineKey(stateDir);
		expect(second.equals(first)).toBe(true);
	});

	it("readEngineKey returns undefined without creating a key (never mints to verify)", async () => {
		expect(await readEngineKey(stateDir)).toBeUndefined();
		// Still absent afterwards: reading must not create.
		expect(await readEngineKey(stateDir)).toBeUndefined();
		await expect(stat(engineKeyPath(stateDir))).rejects.toThrow();
	});

	it("readEngineKey returns the created key", async () => {
		const created = await ensureEngineKey(stateDir);
		const read = await readEngineKey(stateDir);
		if (read === undefined) throw new Error("test precondition failed: key");
		expect(read.equals(created)).toBe(true);
	});

	it("fails closed on a planted symlink: creation refuses it, reading refuses it", async () => {
		const { mkdir } = await import("node:fs/promises");
		await mkdir(stateDir, { recursive: true, mode: 0o700 });
		const decoy = path.join(root, "decoy.key");
		await writeFile(decoy, Buffer.alloc(32, 7));
		await symlink(decoy, engineKeyPath(stateDir));
		await expect(ensureEngineKey(stateDir)).rejects.toThrow();
		await expect(readEngineKey(stateDir)).rejects.toThrow();
	});
});

describe("sealMeta / verifyMetaSeal", () => {
	it("round-trips and ignores key order (canonical JSON)", async () => {
		const key = await ensureEngineKey(stateDir);
		const a = { b: 2, a: 1, nested: { z: [3, 2], y: "x" } };
		const b = { nested: { y: "x", z: [3, 2] }, a: 1, b: 2 };
		const sealed = { ...a, seal: sealMeta(a, key) };
		expect(verifyMetaSeal(sealed, key)).toBe(true);
		expect(sealMeta(b, key)).toBe(sealed.seal);
	});

	it("rejects a tampered body", async () => {
		const key = await ensureEngineKey(stateDir);
		const meta = { url: "https://a.example", seal: "" };
		meta.seal = sealMeta(meta, key);
		expect(verifyMetaSeal({ ...meta, url: "https://evil.example" }, key)).toBe(
			false,
		);
	});

	it("rejects a missing, non-string, or truncated seal", async () => {
		const key = await ensureEngineKey(stateDir);
		const body = { url: "https://a.example" };
		expect(verifyMetaSeal(body, key)).toBe(false);
		expect(verifyMetaSeal({ ...body, seal: 42 }, key)).toBe(false);
		const good = sealMeta(body, key);
		expect(verifyMetaSeal({ ...body, seal: good.slice(0, 32) }, key)).toBe(
			false,
		);
		expect(verifyMetaSeal({ ...body, seal: "zz" }, key)).toBe(false);
	});

	it("rejects a seal made under a different key", async () => {
		const keyA = await ensureEngineKey(stateDir);
		const otherState = path.join(root, "other-state");
		const keyB = await ensureEngineKey(otherState);
		expect(keyB.equals(keyA)).toBe(false);
		const meta = {
			url: "https://a.example",
			seal: sealMeta({ url: "https://a.example" }, keyB),
		};
		expect(verifyMetaSeal(meta, keyA)).toBe(false);
	});
});

describe("putCachedSource / getCachedSource", () => {
	const input = {
		url: "https://example.com/report",
		title: "Example Report",
		content: "The quick brown fox jumps over the lazy dog near the riverbank.",
		fetchedAt: "2026-10-15T00:00:00.000Z",
	};

	it("round-trips: sha-named files with a valid seal", async () => {
		const put = await putCachedSource(cacheDir, stateDir, input);
		expect(put.sha256).toBe(sha256Hex(input.content));
		expect(put.contentPath).toBe(path.join(cacheDir, `${put.sha256}.md`));
		expect(put.metaPath).toBe(path.join(cacheDir, `${put.sha256}.json`));
		const key = await readEngineKey(stateDir);
		if (key === undefined) throw new Error("test precondition failed: key");
		expect(
			verifyMetaSeal(
				{
					sha256: put.sha256,
					url: input.url,
					title: input.title,
					fetchedAt: input.fetchedAt,
					seal: put.seal,
				},
				key,
			),
		).toBe(true);

		const got = await getCachedSource(cacheDir, stateDir, put.sha256);
		expect(got.content).toBe(input.content);
		expect(got.meta.sha256).toBe(put.sha256);
	});

	it("throws TamperedSourceError when content is modified after sealing", async () => {
		const put = await putCachedSource(cacheDir, stateDir, input);
		await writeFile(put.contentPath, `${input.content} FORGED APPENDIX`);
		const err = await getCachedSource(cacheDir, stateDir, put.sha256).then(
			() => null,
			(e: unknown) => e,
		);
		expect(err).toBeInstanceOf(TamperedSourceError);
	});

	it("throws TamperedSourceError when meta is modified after sealing", async () => {
		const put = await putCachedSource(cacheDir, stateDir, input);
		await writeFile(
			put.metaPath,
			JSON.stringify({
				sha256: put.sha256,
				url: "https://evil.example",
				title: input.title,
				fetchedAt: input.fetchedAt,
				seal: put.seal,
			}),
		);
		await expect(
			getCachedSource(cacheDir, stateDir, put.sha256),
		).rejects.toBeInstanceOf(TamperedSourceError);
	});

	it("throws TamperedSourceError for an unsealed planted entry (seal stripped)", async () => {
		const put = await putCachedSource(cacheDir, stateDir, input);
		await writeFile(
			put.metaPath,
			JSON.stringify({
				sha256: put.sha256,
				url: input.url,
				title: input.title,
				fetchedAt: input.fetchedAt,
			}),
		);
		await expect(
			getCachedSource(cacheDir, stateDir, put.sha256),
		).rejects.toBeInstanceOf(TamperedSourceError);
	});

	it("throws TamperedSourceError when meta is missing", async () => {
		const put = await putCachedSource(cacheDir, stateDir, input);
		await rm(put.metaPath);
		await expect(
			getCachedSource(cacheDir, stateDir, put.sha256),
		).rejects.toBeInstanceOf(TamperedSourceError);
	});

	it("throws TamperedSourceError for a missing entry", async () => {
		await ensureEngineKey(stateDir);
		await expect(
			getCachedSource(cacheDir, stateDir, "0".repeat(64)),
		).rejects.toBeInstanceOf(TamperedSourceError);
	});

	it("throws TamperedSourceError for a malformed address", async () => {
		await expect(
			getCachedSource(cacheDir, stateDir, "not-a-hash"),
		).rejects.toBeInstanceOf(TamperedSourceError);
		await expect(
			getCachedSource(cacheDir, stateDir, "../escape"),
		).rejects.toBeInstanceOf(TamperedSourceError);
	});

	it("throws TamperedSourceError when verified under a different state dir (wrong key)", async () => {
		const put = await putCachedSource(cacheDir, stateDir, input);
		const foreignState = path.join(root, "foreign-state");
		await ensureEngineKey(foreignState);
		await expect(
			getCachedSource(cacheDir, foreignState, put.sha256),
		).rejects.toBeInstanceOf(TamperedSourceError);
	});

	it("throws TamperedSourceError when no engine key exists to verify with", async () => {
		const put = await putCachedSource(cacheDir, stateDir, input);
		const emptyState = path.join(root, "empty-state");
		await expect(
			getCachedSource(cacheDir, emptyState, put.sha256),
		).rejects.toBeInstanceOf(TamperedSourceError);
	});

	it("rejects empty content and missing url/title fail-closed", async () => {
		await expect(
			putCachedSource(cacheDir, stateDir, { ...input, content: "" }),
		).rejects.toThrow();
		await expect(
			putCachedSource(cacheDir, stateDir, { ...input, url: "" }),
		).rejects.toThrow();
	});
});
