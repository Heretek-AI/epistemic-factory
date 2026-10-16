// `.worktreeinclude` syncer: copies untracked secret/config files from a base
// repository into an isolated phase worktree without ever staging them in git.
//
// A `.worktreeinclude` file lives at the base repository root and lists one
// gitignore-style pattern per line (e.g. `.env`, `.env.local`, `certs/*.pem`).
// `syncWorktreeIncludes` copies every matching file into the worktree,
// preserving relative paths and creating parent directories (`mkdir -p`). It
// never runs `git add` / `git stage`: the copied files arrive as untracked
// worktree content, exactly like Cline's worktree helper.
//
// Pattern semantics (documented contract — gitignore-inspired, deliberately
// narrow so matching stays deterministic and auditable):
// - Empty lines and lines starting with `#` are comments/blank and ignored.
// - Leading `./` or `/` is stripped: patterns are always relative to the
//   base root. Absolute patterns are not supported.
// - A pattern containing `..` as a path segment never matches anything, and
//   a relative file path containing `..` is never matched (fail closed on
//   path traversal).
// - `**` means "any run of path segments, including none" (contains
//   semantics): `certs/**` matches everything under `certs/` at any depth,
//   `**.pem` matches any `.pem` file anywhere.
// - A pattern WITHOUT any `/` matches against the file BASENAME at any depth:
//   `.env` matches `.env` in the root or in any subdirectory; `*.ext`
//   matches any basename ending in `.ext`; `prefix*` / `*suffix` match
//   basename prefix/suffix globs; `?` matches exactly one non-`/` character.
// - A pattern WITH a `/` but no `**` (e.g. `certs/*.pem`) matches against the
//   whole relative path, where `*` spans within a single segment only (it
//   never crosses `/`) and `?` matches one non-`/` character. So
//   `certs/*.pem` is a ONE-LEVEL glob: it matches `certs/a.pem` but NOT
//   `certs/nested/a.pem` and NOT `other/a.pem`.
// - Matching is purely textual over `/`-separated relative paths. Symlinks
//   are never followed and never copied (fail closed: a planted link cannot
//   smuggle outside bytes into the worktree), and `.git/` internals are never
//   synced.
import { copyFile, mkdir, readdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Basename of the include file read from the base repository root. */
export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

/** Result of syncing includes into a worktree. */
export interface WorktreeSyncResult {
	/** Relative (posix) paths copied into the worktree, sorted, deduplicated. */
	readonly copied: string[];
	/** Patterns that matched zero files (informational — not an error). */
	readonly missing: string[];
}

/**
 * Split `.worktreeinclude` content into patterns: trim each line, drop empty
 * lines and `#` comments.
 */
export function parseWorktreeInclude(content: string): string[] {
	const patterns: string[] = [];
	for (const line of content.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		if (trimmed.startsWith("#")) continue;
		patterns.push(trimmed);
	}
	return patterns;
}

/** Escape one literal character for RegExp (glob `*`/`?` handled by caller). */
function escapeRegExpChar(ch: string): string {
	return ch.replace(/[.+^${}()|[\]\\]/, "\\$&");
}

/**
 * Translate a glob (no `**`) into a RegExp: `*` becomes `[^/]*` (never
 * crosses `/`), `?` becomes `[^/]`, everything else is literal.
 */
function globSegmentToRegExp(glob: string): RegExp {
	let out = "";
	for (const ch of glob) {
		if (ch === "*") out += "[^/]*";
		else if (ch === "?") out += "[^/]";
		else out += escapeRegExpChar(ch);
	}
	return new RegExp(`^${out}$`);
}

/**
 * Translate a full pattern that may contain `**` into a RegExp: each `**`
 * pair becomes `.*` (crosses `/` — contains semantics), a lone `*` becomes
 * `[^/]*`, `?` becomes `[^/]`, everything else is literal.
 */
function globToRegExp(pattern: string): RegExp {
	let out = "";
	let i = 0;
	while (i < pattern.length) {
		const ch = pattern[i];
		if (ch === undefined) break;
		if (ch === "*") {
			if (pattern[i + 1] === "*") {
				out += ".*";
				i += 2;
			} else {
				out += "[^/]*";
				i += 1;
			}
		} else if (ch === "?") {
			out += "[^/]";
			i += 1;
		} else {
			out += escapeRegExpChar(ch);
			i += 1;
		}
	}
	return new RegExp(`^${out}$`);
}

/** Normalize a pattern or path: forward slashes, no leading `./` or `/`. */
function normalizeEntry(value: string): string {
	return value
		.trim()
		.replace(/\\/g, "/")
		.replace(/^\.\//, "")
		.replace(/^\//, "");
}

/** True when any `/`-separated segment is exactly `..` (traversal attempt). */
function hasDotDotSegment(value: string): boolean {
	return value.split("/").includes("..");
}

/**
 * Test whether `relPath` (a `/`-separated path relative to the base root) is
 * selected by `pattern`, per the semantics documented at the top of this
 * module. Returns `false` on any traversal shape (fail closed).
 */
export function matchWorktreePattern(
	pattern: string,
	relPath: string,
): boolean {
	const cleanPattern = normalizeEntry(pattern);
	const cleanRel = normalizeEntry(relPath);
	if (cleanPattern.length === 0 || cleanRel.length === 0) return false;
	if (hasDotDotSegment(cleanPattern) || hasDotDotSegment(cleanRel))
		return false;
	if (!cleanPattern.includes("/")) {
		// Slash-free patterns match the basename at any depth.
		const segments = cleanRel.split("/");
		const base = segments[segments.length - 1] ?? "";
		if (base.length === 0) return false;
		return globSegmentToRegExp(cleanPattern).test(base);
	}
	// Patterns with `/` match the whole relative path (`**` crosses segments).
	return globToRegExp(cleanPattern).test(cleanRel);
}

/**
 * Read `.worktreeinclude` from `baseDir` and parse it. Returns `[]` when the
 * file is absent (nothing to sync). Throws on any other read failure (fail
 * closed: an unreadable include file is surfaced, never silently ignored).
 */
export async function collectWorktreeIncludes(
	baseDir: string,
): Promise<string[]> {
	const file = path.join(path.resolve(baseDir), WORKTREE_INCLUDE_FILE);
	let raw: string;
	try {
		raw = await readFile(file, "utf8");
	} catch (error: unknown) {
		if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return [];
		throw error;
	}
	return parseWorktreeInclude(raw);
}

/** Recursively list regular files under `root` as `/`-separated rel paths. */
async function listFilesRecursive(root: string): Promise<string[]> {
	const out: string[] = [];
	async function walk(dir: string, rel: string): Promise<void> {
		const entries = await readdir(dir, { withFileTypes: true });
		const sorted = [...entries].sort((a, b) =>
			a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
		);
		for (const entry of sorted) {
			// Never follow or copy symlinks: a planted link could otherwise
			// smuggle outside bytes into the worktree.
			if (entry.isSymbolicLink()) continue;
			const entryRel = rel.length === 0 ? entry.name : `${rel}/${entry.name}`;
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === ".git") continue;
				await walk(full, entryRel);
			} else if (entry.isFile()) {
				out.push(entryRel);
			}
		}
	}
	await walk(root, "");
	return out;
}

/** True when `candidate` (resolved) lies strictly inside `root` (resolved). */
function isStrictlyWithin(root: string, candidate: string): boolean {
	const rel = path.relative(root, candidate);
	return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Copy every `.worktreeinclude`-matched file from `baseDir` into
 * `worktreeDir`, preserving relative paths (`mkdir -p` for parents). Never
 * runs `git add` / `git stage`. Entries that would resolve outside either
 * root are skipped (fail closed on traversal). Returns the sorted copied
 * paths plus the patterns that matched nothing.
 */
export async function syncWorktreeIncludes(
	baseDir: string,
	worktreeDir: string,
): Promise<WorktreeSyncResult> {
	const base = path.resolve(baseDir);
	const worktree = path.resolve(worktreeDir);
	if (base === worktree) {
		throw new Error(
			"syncWorktreeIncludes: baseDir and worktreeDir must differ (refusing to copy a tree onto itself)",
		);
	}
	const patterns = await collectWorktreeIncludes(base);
	const allFiles = await listFilesRecursive(base);
	const copiedSet = new Set<string>();
	const missing: string[] = [];
	for (const pattern of patterns) {
		const matches = allFiles.filter((rel) =>
			matchWorktreePattern(pattern, rel),
		);
		if (matches.length === 0) {
			missing.push(pattern);
			continue;
		}
		for (const rel of matches) {
			const src = path.resolve(base, rel);
			const dest = path.resolve(worktree, rel);
			if (!isStrictlyWithin(base, src) || !isStrictlyWithin(worktree, dest)) {
				continue;
			}
			await mkdir(path.dirname(dest), { recursive: true });
			await copyFile(src, dest);
			copiedSet.add(rel);
		}
	}
	return { copied: [...copiedSet].sort(), missing };
}
