# Release 3.0.0 — Packaging Report (branch `release-3.0.0`, NOT merged/pushed/published)

## 1. Scope

Release packaging only, on worktree `worktrees/release-3` (branch `release-3.0.0`,
from `main` @ `48ca586`). In-scope packages: `packages/epistemic-verifier-mcp`,
`packages/core`, `packages/cli`. No `fleet`/`web`/`queereye`/`brainstorm`/`harvest`
exists or was added. No production logic, gates, or accept scripts were modified in
behavior; all changes are packaging/build metadata plus a runtime-compatible
entrypoint guard (see §3).

## 2. License decision — NO FLAG NEEDED, but human to confirm before publish

- IUMBTEMS `package.json` declares `"license": "Apache-2.0"` and
  `/home/john/Projects/IUMBTEMS/LICENSE` exists with the full Apache-2.0 text
  (Appendix copyright: `Copyright 2026 Heretek AI`).
- Decision: mirrored as `"license": "Apache-2.0"` in all three package.json files.
- `LICENSE` copied byte-identical (sha256
  `01529830fea42e5eb0f676a8c0939f73dc032790e0ec028c57a68cf2e6043497`)
  to repo root AND to each package directory (npm `files` patterns are
  package-relative, so per-package copies are what actually land in the
  tarballs per Apache-2.0 §4(a)). Verified present in all three tarballs.
- Human confirmation requested: approve Apache-2.0 for these three public
  packages before `npm publish`.

## 3. Packaging changes per package (all three)

- `"version": "3.0.0"`, removed `"private": true`.
- `"repository": { "type": "git", "url": "git+https://github.com/Heretek-AI/epistemic-factory.git", "directory": "packages/<dir>" }`,
  `"homepage": "https://github.com/Heretek-AI/epistemic-factory#readme"`.
- `"publishConfig": { "access": "public", "provenance": true }`.
- `"files": ["dist", "README.md", "LICENSE*"]`.
- `"main": "./dist/index.js"`, `"types": "./dist/index.d.ts"`,
  `"exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } }`
  (ESM, `"type": "module"` retained).
- `bin` retargeted to compiled output: `epistemic-verifier-mcp →
  ./dist/mcp-server.js`, `es → ./dist/bin.js`.
- `cli` sibling deps changed from `"workspace:*"` to `"^3.0.0"` (both).
- Each package: `"build": "tsc -b tsconfig.build.json[ && fix-bins…]"`,
  `"prepublishOnly": "npm run build"`.
- `packages/epistemic-verifier-mcp/src/mcp-server.ts`: `SERVER_VERSION`
  `"0.0.0"` → `"3.0.0"` (reported in MCP `serverInfo`).

## 4. Build design (node-compatible dist, `bun run check` untouched)

- New per-package `tsconfig.build.json` extending the package tsconfig:
  `outDir: dist`, `rootDir: src`, `sourceMap: false`,
  `rewriteRelativeImportExtensions: true` (sources use `.ts`-suffixed
  relative imports under `allowImportingTsExtensions`; the rewrite emits
  node-resolvable `.js` specifiers), `include: ["src"]` only (tests stay out
  of dist). `cli` build config adds `references` to the two sibling build
  configs so `tsc -b` orders the build.
- Root `package.json` gains only a `build` script:
  `tsc -b <three build configs> && node scripts/fix-dist-bins.mjs <both bins>`.
  `check`/`accept`/Makefile/`scripts/accept/*` are behavior-UNCHANGED.
- Shebang/entrypoint: `cli/src/bin.ts` shebang `bun` → `node`
  (`bun src/bin.ts` still works — bun ignores shebangs). `mcp-server.ts` had
  no shebang — added `#!/usr/bin/env node`. tsc preserves the shebang into
  dist; `scripts/fix-dist-bins.mjs` (idempotent, fail-closed) guarantees the
  shebang + `0755` mode after every build, since tsc emits `0644` and dist is
  gitignored (mode must be set at build/pack time, and npm pack preserves it —
  verified in §5).
- `import.meta.main` is bun-only (undefined under node ⇒ bins would silently
  do nothing). Both entrypoints now use a dual-runtime `isMain()` guard:
  honor the boolean when present (bun), else compare
  `realpathSync(process.argv[1])` against `fileURLToPath(import.meta.url)`
  (symlink-aware for globally linked bins); any uncertainty returns false so a
  bare library import never executes. Verified: node entry runs, node/bun
  library imports are side-effect free.
- New `biome.json`: `{ "files": { "includes": ["**", "!**/dist"] } }` so the
  linter ignores generated `dist/` output (no `biome.json` existed; defaults
  otherwise unchanged). `.gitignore` already covered `dist/`.

## 5. Verification outputs (all recorded 2026-10-15, node v26.10.0 / npm 11.19.1 / bun 1.4.2 / tsc 5.9.3)

- `bun install && bun run build` → exit 0. `dist/` emitted for all three
  packages: 16 `.js` + 16 `.d.ts`, zero `.ts` specifiers remaining in emitted
  JS, both bins `#!/usr/bin/env node` + `-rwxr-xr-x`.
- `bun run check` → exit 0 (123 pass / 0 fail / 639 expects across 7 files;
  `tsc --noEmit` clean; biome 38 files clean). `make check` → exit 0.
- `bash scripts/accept/wave-{1,2,3}.sh` → all exit 0, scripts unmodified.
- `npm pack --dry-run` per package: each tarball = `dist/` + `README.md` +
  `LICENSE` + `package.json` only; grep for `src/`, `test`, `.env` → 0 hits.
  Sizes: verifier 18.9 kB / 15 files, core 21.1 kB / 17 files, cli 14.9 kB /
  9 files.
- Real (unpublished, local) `npm pack` for both bin packages, tarball
  extracted: `dist/bin.js` and `dist/mcp-server.js` retain node shebang +
  exec bit.
- Plain-`node` smoke (NOT bun): all three `dist/index.js` import cleanly;
  `node ./packages/cli/dist/bin.js --help` → exit 0 with usage;
  `node .../bin.js frobnicate` → exit 1; `initialize` JSON-RPC frame into
  `node dist/mcp-server.js` → `{"protocolVersion":"2024-11-05",…,
  "serverInfo":{"name":"epistemic-verifier","version":"3.0.0"}}`, exit 0.
- Stub scan: no `TODO`/`FIXME`/`not implemented`/placeholder code (the only
  `TODO` strings are the pre-existing intentional `es init` frontier.json
  scaffold contents). Scope scan: `packages/` contains only
  `cli core epistemic-verifier-mcp`; no `workspace:*` remains.

## 6. Pre-publish checklist state (NOT done — human runs these)

- [x] Version/license/repo/publishConfig/files/main/types/exports/bin wired.
- [x] `dist/` builds reproducibly; bins executable with node shebang.
- [x] Pack file lists verified (dry-run + real local pack inspection).
- [x] Node-compat smoke passed on node v26.10.0.
- [ ] Human confirms Apache-2.0 + public publish for the three names.
- [ ] `npm login` + provenance-capable CI (provenance needs trusted publishing).
- [ ] `npm publish` per package (order: verifier-mcp, core, then cli) — NEVER
  run from this task; no publish was performed.
- [ ] After publish: `npm view @heretek-ai/<pkg>@3.0.0 dist.tarball` sanity +
  install-from-registry smoke.

## 7. Files created / modified

- Created: `LICENSE`, `biome.json`, `scripts/fix-dist-bins.mjs`,
  `packages/{epistemic-verifier-mcp,core,cli}/LICENSE`,
  `packages/{epistemic-verifier-mcp,core,cli}/tsconfig.build.json`,
  `docs/reports/release-3.0.0.md`.
- Modified: `package.json` (+`build` script only),
  `packages/{epistemic-verifier-mcp,core,cli}/package.json` (publish metadata),
  `packages/cli/src/bin.ts` (node shebang, `node:fs`/`node:url` imports,
  `isMain()` guard), `packages/cli/src/index.ts` (guard comment),
  `packages/epistemic-verifier-mcp/src/mcp-server.ts` (shebang, imports,
  `SERVER_VERSION`, `isMain()` guard), `bun.lock` (version/bin-path refresh
  from install).
- NOT merged, NOT pushed, NOT published. Commit on `release-3.0.0` follows.
