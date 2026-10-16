#!/usr/bin/env node
// Post-build bin fixer: guarantees every compiled CLI entrypoint listed on
// the command line (path relative to the caller's cwd) starts with a
// `#!/usr/bin/env node` shebang and is owner-executable. Idempotent: a file
// that already carries the shebang is left byte-identical apart from mode.
//
// Fail-closed: a missing/unreadable target, or anything that is not a
// regular file, exits 1 without touching anything else.
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const SHEBANG = "#!/usr/bin/env node\n";

function usage() {
	process.stderr.write(`usage: fix-dist-bins.mjs <dist-bin.js> [more ...]\n`);
}

/** Ensure one compiled bin has the node shebang + 0755 mode. */
async function fixOne(relativePath) {
	if (typeof relativePath !== "string" || relativePath.length === 0) {
		throw new Error("refusing to fix an empty bin path");
	}
	const file = path.resolve(process.cwd(), relativePath);
	const info = await stat(file).catch((error) => {
		throw new Error(
			`refusing to fix missing bin ${relativePath}: ${error.message}`,
		);
	});
	if (!info.isFile()) {
		throw new Error(`refusing to fix non-file bin ${relativePath}`);
	}
	const raw = await readFile(file, "utf8");
	const withShebang = raw.startsWith("#!")
		? raw.startsWith(SHEBANG)
			? raw
			: SHEBANG + raw.replace(/^#![^\n]*\n/, "")
		: SHEBANG + raw;
	if (withShebang !== raw) {
		await writeFile(file, withShebang);
	}
	await chmod(file, 0o755);
	process.stdout.write(`fix-dist-bins: ${relativePath} ok\n`);
}

const targets = process.argv.slice(2);
if (targets.length === 0) {
	usage();
	process.exit(1);
}
try {
	for (const target of targets) {
		await fixOne(target);
	}
} catch (error) {
	process.stderr.write(
		`fix-dist-bins: error: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exit(1);
}
