// Content-addressed source cache: `<cacheDir>/<sha256>.md` holds the exact
// text a claim may quote; `<cacheDir>/<sha256>.json` holds where it came
// from, sealed with the engine key. Reads refuse anything that is not both
// content-addressed AND sealed: a planted file with a matching name but
// forged bytes, a missing seal, or a seal under the wrong key all throw
// `TamperedSourceError` (fail closed — never served as trusted).
import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
	ensureEngineKey,
	readEngineKey,
	sealMeta,
	verifyMetaSeal,
} from "./seal.ts";

/** Thrown when a cache entry is missing, unsealed, or modified. Fail closed: never served. */
export class TamperedSourceError extends Error {
	constructor(
		message: string,
		readonly sha256: string,
	) {
		super(message);
		this.name = "TamperedSourceError";
	}
}

/** Hex sha256 of a UTF-8 string. */
export function sha256Hex(data: string): string {
	return createHash("sha256").update(data, "utf8").digest("hex");
}

export interface PutCachedSourceInput {
	readonly url: string;
	readonly title: string;
	readonly content: string;
	readonly fetchedAt?: string;
}

export interface PutCachedSourceResult {
	readonly sha256: string;
	readonly seal: string;
	readonly metaPath: string;
	readonly contentPath: string;
}

/** Write via a sibling temp file, fsync, and rename, so readers never see a torn file. */
async function atomicWrite(
	file: string,
	data: string | Uint8Array,
): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	const handle = await open(temp, "w");
	try {
		await handle.writeFile(data);
		await handle.sync();
	} finally {
		await handle.close();
	}
	try {
		await rename(temp, file);
	} catch (error) {
		await rm(temp, { force: true });
		throw error;
	}
}

function contentPathFor(cacheDir: string, sha256: string): string {
	return path.join(cacheDir, `${sha256}.md`);
}

function metaPathFor(cacheDir: string, sha256: string): string {
	return path.join(cacheDir, `${sha256}.json`);
}

/**
 * Store `input.content` under its sha256, with sealed provenance meta.
 * Computes `sha256` of the exact content bytes, writes
 * `<cacheDir>/<sha256>.md` and `<cacheDir>/<sha256>.json` (containing
 * `{ sha256, url, title, fetchedAt, seal }` signed with the engine key from
 * `stateDir`, created when absent).
 */
export async function putCachedSource(
	cacheDir: string,
	stateDir: string,
	input: PutCachedSourceInput,
): Promise<PutCachedSourceResult> {
	if (typeof input.url !== "string" || input.url.length === 0)
		throw new Error("putCachedSource: url is required");
	if (typeof input.title !== "string")
		throw new Error("putCachedSource: title is required");
	if (typeof input.content !== "string" || input.content.length === 0)
		throw new Error("putCachedSource: content must be a non-empty string");
	const sha256 = sha256Hex(input.content);
	const key = await ensureEngineKey(stateDir);
	const body: Record<string, unknown> = {
		sha256,
		url: input.url,
		title: input.title,
		fetchedAt: input.fetchedAt ?? new Date().toISOString(),
	};
	const seal = sealMeta(body, key);
	const meta: Record<string, unknown> = { ...body, seal };
	const contentPath = contentPathFor(cacheDir, sha256);
	const metaPath = metaPathFor(cacheDir, sha256);
	await atomicWrite(contentPath, input.content);
	await atomicWrite(metaPath, `${JSON.stringify(meta, null, 2)}\n`);
	return { sha256, seal, metaPath, contentPath };
}

export interface CachedSource {
	readonly content: string;
	readonly meta: Record<string, unknown>;
}

/**
 * Load and authenticate a cached source. Verifies BOTH that
 * `sha256(content) === sha256` AND that the meta carries a valid engine-key
 * seal. Throws `TamperedSourceError` when the entry is missing, malformed,
 * unsealed, sealed under a different key, or modified after sealing.
 */
export async function getCachedSource(
	cacheDir: string,
	stateDir: string,
	sha256: string,
): Promise<CachedSource> {
	if (!/^[0-9a-f]{64}$/.test(sha256))
		throw new TamperedSourceError(
			`refusing malformed cache address: ${sha256.slice(0, 32)}`,
			sha256,
		);
	let content: string;
	try {
		content = await readFile(contentPathFor(cacheDir, sha256), "utf8");
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
			throw new TamperedSourceError(
				`cached source is missing: ${sha256}`,
				sha256,
			);
		throw error;
	}
	if (sha256Hex(content) !== sha256)
		throw new TamperedSourceError(
			`cached source bytes no longer hash to their address (modified after write): ${sha256}`,
			sha256,
		);
	let meta: Record<string, unknown>;
	try {
		const raw = await readFile(metaPathFor(cacheDir, sha256), "utf8");
		const parsed: unknown = JSON.parse(raw);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
			throw new TamperedSourceError(
				`cached source meta is not an object: ${sha256}`,
				sha256,
			);
		meta = parsed as Record<string, unknown>;
	} catch (error: unknown) {
		if (error instanceof TamperedSourceError) throw error;
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
			throw new TamperedSourceError(
				`cached source meta is missing (unsealed entry refused): ${sha256}`,
				sha256,
			);
		throw new TamperedSourceError(
			`cached source meta is unreadable: ${sha256}: ${(error as Error)?.message ?? error}`,
			sha256,
		);
	}
	// Never mint a key to verify: without the engine's key nothing verifies.
	const key = await readEngineKey(stateDir);
	if (key === undefined)
		throw new TamperedSourceError(
			`no engine key in state dir; cannot authenticate: ${sha256}`,
			sha256,
		);
	if (!verifyMetaSeal(meta, key))
		throw new TamperedSourceError(
			`cached source seal is invalid (unsealed or forged entry refused): ${sha256}`,
			sha256,
		);
	if (meta.sha256 !== undefined && meta.sha256 !== sha256)
		throw new TamperedSourceError(
			`cached source meta addresses a different entry: ${sha256}`,
			sha256,
		);
	// Symlink-planted meta/content that resolves outside cacheDir is refused:
	// entries must be regular files reachable without following planted links
	// at the top level. (Content bytes already verified above; this guards
	// against meta/content being swapped via directory symlinks.)
	await assertRegularFile(contentPathFor(cacheDir, sha256), sha256);
	await assertRegularFile(metaPathFor(cacheDir, sha256), sha256);
	return { content, meta };
}

async function assertRegularFile(file: string, sha256: string): Promise<void> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error: unknown) {
		throw new TamperedSourceError(
			`cached source entry is not a directly readable file: ${sha256}: ${(error as Error)?.message ?? error}`,
			sha256,
		);
	}
	try {
		const info = await handle.stat();
		if (!info.isFile())
			throw new TamperedSourceError(
				`cached source entry is not a regular file: ${sha256}`,
				sha256,
			);
	} finally {
		await handle.close();
	}
}
