// RED-phase test-tree manifest lock.
//
// After `BUILD_TDD_RED` records its failing run, the gate runner calls
// `lockTestManifest(testDir)` to snapshot SHA-256 hashes of every test file.
// Before leaving `BUILD_TDD_GREEN`, the runner re-scans with
// `verifyTestManifestUnchanged` and the state machine throws
// `TestTamperingError` on any change/missing/added file — the programmer may
// add source files, but never weaken or delete the failing assertions.
//
// This module is the canonical home of `TestTamperingError`
// (`factory/machine.ts` re-exports it) so the gate and the machine share one
// identity without a circular import.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

/** Thrown when a test file changed since the RED-phase lock. Fail closed. */
export class TestTamperingError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "TestTamperingError";
	}
}

/** One locked test file: repo-relative posix path plus SHA-256 hex. */
export interface TestFileEntry {
	readonly path: string;
	readonly sha256: string;
}

/** Snapshot of a test tree taken after the RED run. */
export interface TestManifest {
	readonly files: TestFileEntry[];
	readonly root: string;
}

/** Result of re-verifying a test tree against its locked manifest. */
export interface ManifestDiff {
	readonly unchanged: boolean;
	readonly changed: string[];
	readonly missing: string[];
	readonly added: string[];
}

function toPosix(relative: string): string {
	return relative.split(path.sep).join("/");
}

/** Recursively collect relative posix paths of every regular file. */
async function collectFiles(
	dir: string,
	base: string,
	out: string[],
): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true });
	entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			await collectFiles(full, base, out);
		} else if (entry.isFile()) {
			out.push(toPosix(path.relative(base, full)));
		} else {
			throw new Error(
				`lockTestManifest refused: non-regular entry at ${toPosix(path.relative(base, full))} (symlinks and special files are not hashed; replace with a regular file)`,
			);
		}
	}
}

/**
 * Snapshot every test file under `testDir` (sorted relative posix paths +
 * SHA-256). Throws when `testDir` is missing, is not a directory, or holds
 * a non-regular entry (fail closed).
 */
export async function lockTestManifest(testDir: string): Promise<TestManifest> {
	const root = path.resolve(testDir);
	let info: Awaited<ReturnType<typeof stat>>;
	try {
		info = await stat(root);
	} catch {
		throw new Error(`lockTestManifest: test directory not found: ${testDir}`);
	}
	if (!info.isDirectory()) {
		throw new Error(
			`lockTestManifest: not a directory: ${testDir} (refusing to lock a file as a test tree)`,
		);
	}
	const relatives: string[] = [];
	await collectFiles(root, root, relatives);
	relatives.sort();
	const files: TestFileEntry[] = [];
	for (const relative of relatives) {
		const content = await readFile(path.join(root, relative));
		files.push({
			path: relative,
			sha256: createHash("sha256").update(content).digest("hex"),
		});
	}
	return { files, root };
}

/**
 * Re-scan `testDir` and diff against a locked manifest. A vanished `testDir`
 * is reported as every locked file missing (never thrown — the diff is the
 * evidence the machine halts on). `root` is provenance metadata; comparison
 * is by relative path.
 */
export async function verifyTestManifestUnchanged(
	testDir: string,
	manifest: TestManifest,
): Promise<ManifestDiff> {
	let current: TestManifest;
	try {
		current = await lockTestManifest(testDir);
	} catch {
		const missing = manifest.files.map((entry) => entry.path).sort();
		return { unchanged: missing.length === 0, changed: [], missing, added: [] };
	}
	const locked = new Map(
		manifest.files.map((entry) => [entry.path, entry.sha256]),
	);
	const present = new Map(
		current.files.map((entry) => [entry.path, entry.sha256]),
	);
	const changed: string[] = [];
	const missing: string[] = [];
	const added: string[] = [];
	for (const [relative, hash] of locked) {
		const now = present.get(relative);
		if (now === undefined) missing.push(relative);
		else if (now !== hash) changed.push(relative);
	}
	for (const relative of present.keys()) {
		if (!locked.has(relative)) added.push(relative);
	}
	changed.sort();
	missing.sort();
	added.sort();
	return {
		unchanged:
			changed.length === 0 && missing.length === 0 && added.length === 0,
		changed,
		missing,
		added,
	};
}

/**
 * Throwing helper for the `BUILD_TDD_GREEN -> GATE_MUTATION` guard: throws
 * `TestTamperingError` with full detail on any change/missing/added file.
 */
export async function assertTestManifestUnchanged(
	testDir: string,
	manifest: TestManifest,
): Promise<void> {
	const diff = await verifyTestManifestUnchanged(testDir, manifest);
	if (!diff.unchanged) {
		throw new TestTamperingError(
			`test files changed since the RED-phase lock (refusing to leave BUILD_TDD_GREEN): changed [${diff.changed.join(", ")}], missing [${diff.missing.join(", ")}], added [${diff.added.join(", ")}]`,
		);
	}
}
