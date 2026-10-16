# `epistemic-factory`

Gated Build Factory: a standalone **Epistemic Quote & Cache Verifier MCP
server** plus a single-worktree **gated build state machine & CLI** enforcing

```
GRILL -> RESEARCH -> SPEC -> BUILD_TDD_RED -> BUILD_TDD_GREEN
  -> GATE_MUTATION -> QA_DUAL_EVAL -> DONE   (plus HALTED from any state)
```

## Install

Requires [Bun](https://bun.sh) (>= 1.1).

```bash
git clone https://github.com/Heretek-AI/epistemic-factory
cd epistemic-factory
bun install
bun test          # all workspace tests
bun run check     # tests + tsc --noEmit + biome check
bash scripts/accept/wave-1.sh && bash scripts/accept/wave-2.sh && bash scripts/accept/wave-3.sh
```

The CLI needs no build step — run it directly:

```bash
bun ./packages/cli/src/bin.ts --help
# or, once linked/packaged, as `es`
```

## `es` command reference

All commands exit `0` on success and `1` on gate/verification failure or
invalid input. The human passphrase arrives via `--passphrase` or the
`ES_PASSPHRASE` environment variable and is never written to disk.

```bash
# Seal a human Ed25519 approval key (prints { publicKeyHex, fingerprint }).
es key seal [--key-dir <dir>] [--passphrase <pw>]
# Default --key-dir: <cwd>/.factory/keys

# Scaffold a project: .worktreeinclude, .factory/, frontier.json skeleton.
# Refuses to overwrite without --force.
es init [--dir <dir>] [--force]

# Informational summary: frontier presence + rounds count, approvals
# present, STOP presence. Always exit 0 for a readable dir.
es status [--dir <dir>]

# Sign a stage approval with the sealed human key; the record is stored at
# <dir>/.factory/approvals/<STAGE>-<runId>.json and printed as JSON.
es approve --stage <GRILL|SPEC|WAIVER|TRUST> --subject <sha256> --run-id <id> \
  [--key-dir <dir>] [--passphrase <pw>] [--dir <dir>] [--timestamp <iso>]

# Audit research markdown against the sealed source cache.
# Exit 0 when grounded, 1 when any claim is pruned.
es audit-research --markdown <file> --cache-dir <dir> --state-dir <dir>

# Run the mutation gate (85% kill threshold) over --files, executing the
# test command after `--`. Exit 0 on pass, 1 on fail.
es gate-mutation --dir <dir> --files <a.ts,b.ts> -- <testCmd...>

es --help   # usage
```

### Example: end-to-end project pass

```bash
export ES_PASSPHRASE='correct horse battery staple'
es init --dir ./my-build
es key seal --key-dir ./my-build/.factory/keys
# ... grill the idea, fill frontier.json ...
es approve --stage GRILL \
  --subject "$(sha256sum ./my-build/frontier.json | cut -d' ' -f1)" \
  --run-id run-1 --key-dir ./my-build/.factory/keys --dir ./my-build
# ... research with [VERIFIED: sha256:<hash> "verbatim quote"] claims ...
es audit-research --markdown ./my-build/research.md \
  --cache-dir ./my-build/.cache --state-dir ./my-build/.state
es status --dir ./my-build
# ... red (must fail), green (must pass, tests locked), mutation gate ...
es gate-mutation --dir ./my-build --files src/index.ts -- bun test
```

## Gate pipeline: GRILL → PR

1. **GRILL** — the idea is interrogated; decisions accumulate in
   `frontier.json` (append-only; context-only ideas without a concrete
   behavioral delta from HEAD are refused). Advancing requires a human
   Ed25519 approval over `sha256(frontier.json)` (`es approve --stage GRILL`).
2. **RESEARCH** — sources are cached content-addressed + HMAC-sealed; every
   `[VERIFIED: sha256:<hash> "quote"]` claim must quote its source verbatim
   (NFKC + typography folding, ≥12 chars per ellipsis fragment).
   `es audit-research` must pass with `verifiedCount >= 1`.
3. **SPEC** — a non-empty spec plus a human approval over `sha256(spec.md)`
   (`es approve --stage SPEC`).
4. **BUILD_TDD_RED** — the test suite must FAIL (`exitCode !== 0`); a green
   run here throws `RED_FIRST_VIOLATION`. The test tree is SHA-256-locked.
5. **BUILD_TDD_GREEN** — implementation lands; the suite must go green AND
   the test manifest must verify unchanged (`TestTamperingError` otherwise).
6. **GATE_MUTATION** — syntactic mutants must be killed at ≥85%
   (`es gate-mutation`).
7. **QA_DUAL_EVAL → DONE → PR** — functional + adversarial judges must both
   `PASS` with model diversity from the programmer (or a logged override).

`.factory/STOP` (kill-file) or spend over ceiling forces `HALTED` from any
state. See `docs/prompts/SPEC.md` §2.2 for the exact guard table.

## Security invariants (non-negotiable)

- Every cached research source is SHA-256 content-addressed AND sealed with
  an HMAC-SHA256 `engine.key` (mode `0600`); unsealed or modified entries
  throw `TamperedSourceError` — never served.
- Every `[VERIFIED]` claim passes deterministic verbatim quote verification;
  ungrounded claims are pruned, never passed.
- RED-first: tests must fail before implementation (`RED_FIRST_VIOLATION`
  otherwise); the GREEN-phase test tree is manifest-locked
  (`TestTamperingError` on tampering).
- Stage approvals require a valid Ed25519 **human** signature. Agents may
  request approvals, NEVER grant or self-sign them.
- The CLI fails closed everywhere: bad stages, malformed hashes, missing
  passphrases, unreadable files, and unknown commands all exit 1 with a
  descriptive error; gate failures exit 1 with their evidence on stdout.

## Worktree flow

Phase worktrees stay isolated but still need untracked secrets (`.env`,
certs). List them once in the base repo's `.worktreeinclude`:

```
.env
.env.local
certs/*.pem
```

Pattern semantics: empty lines and `#` comments ignored; slash-free patterns
match basenames at any depth (`*.pem`, `.env`); `dir/*.ext` is a one-level
glob; `**` crosses segments (`certs/**`); `..` segments never match (fail
closed). Sync (programmatic API; used by phase runners):

```ts
import { syncWorktreeIncludes } from "@heretek-ai/es-cli";
const { copied, missing } = await syncWorktreeIncludes(baseDir, worktreeDir);
```

Copies preserve relative paths (`mkdir -p`), never follow symlinks, never
touch `.git`, and never run `git add` — files arrive untracked.

## Packages

| Package | Contents |
|---|---|
| `@heretek-ai/epistemic-verifier-mcp` | Quote verifier, HMAC seal, sealed cache, research auditor, MCP stdio server |
| `@heretek-ai/es-core` | Ed25519 approvals, append-only frontier, factory state machine, test-lock + mutation + sandboxed gate runner |
| `@heretek-ai/es-cli` | `es` CLI + `.worktreeinclude` syncer (this wave) |

Out of scope by design (see `AGENTS.md` §4): `packages/fleet`
(`es-fleet`), `packages/web`, `queereye`/`brainstorm`/`harvest` — fleet
scheduling and WebUI belong to Repo 4 (`agency-control-plane`).
