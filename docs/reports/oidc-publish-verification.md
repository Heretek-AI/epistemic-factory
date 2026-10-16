# OIDC Trusted-Publishing Workflow — Drift Guard Verification Report

- Worktree: `/home/john/Projects/Heretek-AI-Rebuild/epistemic-factory/worktrees/oidc`
- Branch: `release-oidc-publish`
- Audited file: `.github/workflows/publish.yml` (114 lines, new file)
- Scope ref: `AGENTS.md` §4 (STRICT SCOPE & REFUSAL BOUNDARY)
- Auditor role: read-only. No source, test, config, or workflow file was modified by this audit. This report is the auditor's sole write.
- Date: 2026-10-16 (UTC)

## 1. Diff check (ONLY intended change vs `main`)

Method: `git diff main..HEAD --stat` (committed branch delta) + `git diff main --stat` / `git status --short` (worktree noise) + `git diff main --summary` / `--numstat`.

- [x] Committed delta `main..HEAD` is exactly ONE file:
  - `create mode 100644 .github/workflows/publish.yml` — 114 insertions, 0 deletions.
- [x] Zero changes to `packages/*` source, configs, tests, `Makefile`, `scripts/`, `bundles/`, or any other tracked file in the committed delta.
- [x] No untracked files (`git status --porcelain --untracked-files=all` shows only the single modified path below, no `??` entries).
- [x] No FORBIDDEN-scope additions (`packages/fleet`, `packages/web`, `queereye`, `brainstorm`, `harvest`): none present, none referenced.

### Pre-existing mode-only noise (explicitly identified, NOT part of the branch delta)

- Worktree shows ` M packages/epistemic-verifier-mcp/src/mcp-server.ts` with `git diff main --numstat` of `0 0` and `git diff main --summary` of `mode change 100644 => 100755` — **zero content lines changed**.
- `git ls-files -s` confirms the index still records `100644`; the `100755`/`rwxrwxrwx` mode exists only in the worktree filesystem (permission-bit noise), is unstaged (`git diff --cached` is empty), and is NOT in any commit on this branch (`git log --oneline main..HEAD` = single commit `6f5b1de Add npm trusted-publishing (OIDC) release workflow`, whose own stat is the workflow file alone).
- Disposition: informational noise. Recommendation to coordinator: restore with `git checkout -- packages/epistemic-verifier-mcp/src/mcp-server.ts` (or `chmod 644`) and do NOT commit the mode change. Not counted as a finding against the branch.

## 2. Workflow correctness checklist (`.github/workflows/publish.yml`)

- [x] **Triggers** — `release: types: [published]` (publishes for real, lines 31–32) + `workflow_dispatch` with `dry_run` boolean input defaulting to `true` (lines 33–39). Matches intended spec.
- [x] **Least-privilege permissions** — top-level `permissions: contents: read / id-token: write` only (lines 43–45). No `write-all`, no per-job elevation, no `contents: write`, `packages: write`, `actions: write`, or any other broader scope anywhere in the file (verified via `grep -rn permissions .github/workflows/`).
- [x] **Pinned action versions** — `actions/checkout@v4` (line 52), `oven-sh/setup-bun@v2` (line 58), `actions/setup-node@v4` (line 63). All pinned to major tags; none float to `main`/`master`/unpinned. See Observation O1.
- [x] **npm >= 11.5.1 gate** — step `Ensure npm supports OIDC trusted publishing (>= 11.5.1)` (lines 68–75) runs `npm install -g npm@latest` then `npm --version`. Installing `@latest` guarantees a version ⊇ 11.5.1, and a registry/install failure fails the job closed. See Observation O2 for hardening note.
- [x] **NO long-lived token/secret** — no `NODE_AUTH_TOKEN`, no `NPM_TOKEN`, no `secrets.*`, no `registry-url`-paired auth env. The only matches for token/secret patterns are comments explicitly *forbidding* a token (lines 1, 41–42, 69–72). `setup-node` is given `registry-url` with no auth token attached (lines 63–66) — correct for OIDC.
- [x] **Build + check gate before publish** — `bun install` (78) → `bun run build` (81) → `bun run check` (84) all run unconditionally before any publish step; any non-zero exit halts the job before publishing.
- [x] **Dependency-order publishes with `--provenance --access public`** — all six publish invocations use `npm publish --provenance --access public` (plus `--dry-run` on the dry-run variants, lines 89/94/99/104/109/114), in leaf→root order: `epistemic-verifier-mcp` → `es-core` → `es-cli`. Working directories map correctly (`packages/epistemic-verifier-mcp`, `packages/core`, `packages/cli`).
- [x] **Dry-run path** — `workflow_dispatch` + `dry_run == true` routes to the three `--dry-run` steps (lines 87/97/107); `release` event OR `workflow_dispatch` + `dry_run == false` routes to the three real steps (lines 92/102/112). Mutually exclusive `if:` conditions; no path publishes on default manual dispatch.
- [x] **Header comments' factual claims verified** — `publishConfig.access: public` present in all three `package.json` files (`packages/*/package.json` lines 13–14) and `repository` field present in all three (line 7). The claim that provenance prerequisites are met in-tree is accurate.

## 3. Secret hygiene

- [x] No hardcoded tokens, passwords, API keys, or private keys in the workflow (scanned for `NPM_TOKEN|NODE_AUTH_TOKEN|secrets.[A-Z_]+|ghp_|github_pat_|xox[bpas]-|AKIA` — only benign comment mention of `NODE_AUTH_TOKEN` as prohibited).
- [x] No org/repo secrets referenced (`secrets.*` appears nowhere in any workflow file).
- [x] No `NODE_AUTH_TOKEN`/`NPM_TOKEN` env set for any npm publish step — OIDC short-lived identity via `id-token: write` is the sole auth mechanism.

## 4. Supply-chain

- [x] All three third-party actions are pinned to major release tags (`@v4`, `@v2`, `@v4`); none float to `main`/`master` or omit a ref. See Observation O1 (SHA-pinning note, not a failure per brief).

## FINDINGS

**NONE.** No numbered FAIL findings. Zero stubs, zero scope bleed, zero secret references, zero over-broad permissions, correct gates and publish order.

### Observations (non-blocking, no action required to merge)

- **O1 — Major-tag pins, not SHA pins.** `actions/checkout@v4`, `oven-sh/setup-bun@v2`, `actions/setup-node@v4` are major tags. This matches standard practice and the brief's allowance (observation, not failure). If the repo later adopts a strict-SHA supply-chain policy, pin to immutable SHAs with Dependabot/Renovate follow-ups.
- **O2 — npm version gate is implicit.** The `>= 11.5.1` step enforces freshness by installing `npm@latest` rather than asserting the numeric floor (e.g. `npm --version` compared against `11.5.1`). Fail-closed on install error, and `@latest` satisfies the floor by construction. Optional hardening: add an explicit `node -e` semver assertion for a self-documenting gate.
- **O3 — Worktree mode-bit noise.** Unstaged `100644 => 100755` mode change on `packages/epistemic-verifier-mcp/src/mcp-server.ts`, zero content delta (see §1). Restore before merge; do not commit.

## Auditor write-permission compliance

- Modified nothing outside `docs/reports/*`. No edits to source, tests, workflows, or configs. This file (`docs/reports/oidc-publish-verification.md`) is staged via `git add` only; merge/push/publish left to the coordinator.

## Binding verdict

**`VERDICT: PASS`**
