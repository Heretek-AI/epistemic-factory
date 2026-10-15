// Engine seal for cached sources. Before the factory dir exists, an
// unsandboxed writer could pre-seed the content-addressed source cache with
// forged entries (the file name is its own sha256, so a bare content-hash
// check passes). Every entry the engine writes is therefore sealed with an
// HMAC under a key kept in the masked state dir (`engine.key`), and sealed
// readers refuse entries without a valid seal. Agents can neither read the
// state dir (sandbox mask) nor forge the seal.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const ENGINE_KEY_FILE = "engine.key";
const ENGINE_KEY_BYTES = 32;

/** Where the engine key lives in a state dir. */
export const engineKeyPath = (stateDir: string): string =>
	path.join(stateDir, ENGINE_KEY_FILE);

/**
 * Exclusive advisory lock at `${target}.lock` (a directory, created
 * atomically by mkdir). The owner file records pid/host so a dead holder's
 * lock can be reclaimed instead of wedging key creation forever.
 */
async function withLock<T>(target: string, fn: () => Promise<T>): Promise<T> {
	const lock = `${target}.lock`;
	const deadline = Date.now() + 10_000;
	await mkdir(path.dirname(lock), { recursive: true });
	for (;;) {
		try {
			await mkdir(lock);
			await writeFile(
				path.join(lock, "owner"),
				JSON.stringify({ pid: process.pid, host: hostname(), at: Date.now() }),
			);
			break;
		} catch (error: unknown) {
			if ((error as NodeJS.ErrnoException)?.code !== "EEXIST") throw error;
			let stale = false;
			try {
				const owner = JSON.parse(
					await readFile(path.join(lock, "owner"), "utf8"),
				) as {
					pid: number;
					host: string;
					at: number;
				};
				const alive = (() => {
					try {
						process.kill(owner.pid, 0);
						return true;
					} catch (err: unknown) {
						return (err as NodeJS.ErrnoException)?.code === "EPERM";
					}
				})();
				if (
					(owner.host === hostname() && !alive) ||
					Date.now() - owner.at > 30_000
				)
					stale = true;
			} catch {
				stale = false;
			}
			if (stale) {
				await rm(lock, { recursive: true, force: true });
				continue;
			}
			if (Date.now() > deadline)
				throw new Error(`Timed out waiting for lock ${lock}`);
			await sleep(25);
		}
	}
	try {
		return await fn();
	} finally {
		await rm(lock, { recursive: true, force: true });
	}
}

/**
 * Read the engine key, creating it (0600) when absent. Create-first (no
 * check-then-act): O_EXCL refuses an existing file and O_NOFOLLOW refuses a
 * planted symlink, so a pre-seeded path can neither divert nor capture the
 * new key. Creation runs under the key lock: without it a loser could read
 * the winner's still-empty file between its create and its write and mistake
 * it for corruption. The losing creator reads the winner's key back, also
 * without following symlinks.
 */
export async function ensureEngineKey(stateDir: string): Promise<Buffer> {
	await mkdir(stateDir, { recursive: true, mode: 0o700 });
	const file = engineKeyPath(stateDir);
	return withLock(file, async () => {
		const key = randomBytes(ENGINE_KEY_BYTES);
		try {
			const handle = await open(
				file,
				constants.O_CREAT |
					constants.O_EXCL |
					constants.O_WRONLY |
					constants.O_NOFOLLOW,
				0o600,
			);
			await handle.writeFile(key);
			await handle.close();
			return key;
		} catch (error: unknown) {
			const code = (error as NodeJS.ErrnoException)?.code;
			if (code !== "EEXIST" && code !== "ELOOP") throw error;
		}
		const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const raced = await handle.readFile();
			if (raced.length >= ENGINE_KEY_BYTES) return raced;
			throw new Error(
				`${ENGINE_KEY_FILE} exists but is shorter than 32 bytes; remove it and retry`,
			);
		} finally {
			await handle.close();
		}
	});
}

/**
 * Read the engine key without ever creating it: verifiers use this, so a
 * caller that cannot see the real key (a sandbox masks the state dir, or the
 * state dir points elsewhere) reports a missing key instead of minting a
 * throwaway one and calling every signed file forged.
 */
export async function readEngineKey(
	stateDir: string,
): Promise<Buffer | undefined> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(
			engineKeyPath(stateDir),
			constants.O_RDONLY | constants.O_NOFOLLOW,
		);
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
		throw error;
	}
	try {
		const key: Buffer = await handle.readFile();
		if (key.length < ENGINE_KEY_BYTES)
			throw new Error(
				`${ENGINE_KEY_FILE} exists but is shorter than 32 bytes; remove it and retry`,
			);
		return key;
	} finally {
		await handle.close();
	}
}

/** Stable JSON: object keys sorted recursively, so equal values seal equally. */
export function canonicalJson(value: unknown): string {
	return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const item = (value as Record<string, unknown>)[key];
			if (item !== undefined) out[key] = sortKeys(item);
		}
		return out;
	}
	return value;
}

/** HMAC-SHA256 over the canonical meta (minus any previous seal), hex. */
export function sealMeta(meta: Record<string, unknown>, key: Buffer): string {
	const { seal: _seal, ...body } = meta;
	return createHmac("sha256", key).update(canonicalJson(body)).digest("hex");
}

/** Whether `meta.seal` is a valid seal by `key` over the rest of `meta`. Fail-closed: anything malformed is false. */
export function verifyMetaSeal(
	meta: Record<string, unknown>,
	key: Buffer,
): boolean {
	if (typeof meta.seal !== "string") return false;
	let presented: Buffer;
	try {
		presented = Buffer.from(meta.seal, "hex");
	} catch {
		return false;
	}
	if (presented.length === 0) return false;
	const expected = Buffer.from(sealMeta(meta, key), "hex");
	return (
		presented.length === expected.length && timingSafeEqual(presented, expected)
	);
}
