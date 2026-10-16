# `epistemic-factory`

Gated Build Factory: a standalone **Epistemic Quote & Cache Verifier MCP
server** plus a single-worktree **gated build state machine & CLI** enforcing

```
GRILL -> RESEARCH -> SPEC -> BUILD_TDD_RED -> BUILD_TDD_GREEN
  -> GATE_MUTATION -> QA_DUAL_EVAL -> DONE   (plus HALTED from any state)
```

> **3.0.0 is a ground-up rewrite.** `@heretek-ai/es-core` and
> `@heretek-ai/es-cli` 2.x on npm come from an older, unrelated codebase;
> 3.0.0 replaces them with a breaking, incompatible API. There is no
> migration path from 2.x — pin `^2` if you depend on the old packages. See
> [`CHANGELOG.md`](CHANGELOG.md).

## Install

Requires [Bun](https://bun.sh) (>= 1.1).

```bash
git clone https://github.com/Heretek-AI/epistemic-factory
cd epistemic-factory
bun install
bun test          # all workspace tests
bun run check     # tests + per-package tsc --noEmit + biome check
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

# Informational summary: run id + state + last step, frontier presence +
# rounds count, approvals present, STOP presence. Always exit 0 for a
# readable dir.
es status [--dir <dir>]

# Sign a stage approval with the sealed human key; the record is stored at
# <dir>/.factory/approvals/<STAGE>-<runId>.json and printed as JSON.
# Without --subject, GRILL/SPEC/TRUST sign the hash of the frontier / spec /
# .factory/config.json currently on disk; without --run-id, the current run
# in .factory/run.json is used.
es approve --stage <GRILL|SPEC|WAIVER|TRUST> [--subject <sha256>] [--run-id <id>] \
  [--key-dir <dir>] [--passphrase <pw>] [--dir <dir>] [--timestamp <iso>]

# Advance the persisted run one step (default: next state on the line).
# All gate evidence is computed from disk; evidence flags are refused.
es advance [--to <STATE>] [--dir <dir>]

# Advance as far as the gates allow; exit 0 at DONE, exit 1 with the reason
# at the first refusal.
es run [--dir <dir>]

# Audit research markdown against the sealed source cache.
# Exit 0 when grounded, 1 when any claim is pruned.
es audit-research --markdown <file> --cache-dir <dir> --state-dir <dir>

# Run the mutation gate (85% kill threshold) over --files, executing the
# test command after `--`. Exit 0 on pass, 1 on fail.
es gate-mutation --dir <dir> --files <a.ts,b.ts> -- <testCmd...>

es --help   # usage
```

### Example: end-to-end project pass

The runner (`es advance` / `es run`) persists the run in `.factory/run.json`
and computes every gate's evidence itself: it hashes `frontier.json` and the
spec, verifies the signed approvals in `.factory/approvals/` against
`.factory/keys/human.pub`, runs the configured test command through the gate
engine for RED and GREEN, locks and re-verifies the test manifest, runs the
mutation gate, reads the QA verdicts, and checks `.factory/STOP` and the
spend ledger. Nothing it gates on can be passed in on the command line.

It is configured by `.factory/config.json` (paths relative to the project):

```json
{
  "version": 1,
  "frontierFile": "frontier.json",
  "specFile": "spec.md",
  "research": { "markdown": "research.md", "cacheDir": ".factory/cache", "stateDir": ".factory/state" },
  "testCmd": ["bun", "test"],
  "testDir": "test",
  "mutation": { "targets": ["src/index.ts"] },
  "trustedCommands": [["bun", "test"]],
  "useBwrap": true,
  "ceilingUSD": 25,
  "programmerModel": "<programmer model id>"
}
```

Because the config decides what the gates execute, the human must sign a
`TRUST` approval over `sha256(.factory/config.json)` for the run; editing
the config afterwards voids it. Other inputs: `.factory/qa/functional.json`
and `.factory/qa/adversarial.json` (`{ "verdict": "PASS", "model": "…" }`),
and `.factory/spend.jsonl` (one `{ "usd": <n> }` per line).

```bash
export ES_PASSPHRASE='correct horse battery staple'   # human only
es init --dir ./my-build
es key seal --key-dir ./my-build/.factory/keys
# ... write .factory/config.json, grill the idea into frontier.json ...
es approve --stage TRUST --dir ./my-build --key-dir ./my-build/.factory/keys
es advance --dir ./my-build                 # IDLE -> GRILL
es approve --stage GRILL --dir ./my-build --key-dir ./my-build/.factory/keys
# ... research with [VERIFIED: sha256:<hash> "verbatim quote"] claims, spec ...
es approve --stage SPEC --dir ./my-build --key-dir ./my-build/.factory/keys
es run --dir ./my-build                     # stops at the first refusal
es status --dir ./my-build
```

The GRILL subject is `frontierHash(frontier)` (sha256 over canonical JSON),
the SPEC subject is sha256 of the spec bytes; `es approve` computes both when
`--subject` is omitted, and a refusal message names the expected hash.

Trust boundary: `run.json` and the approval records live in the worktree.
The runner validates `run.json` against its own history and pins the human
key fingerprint per run, but anything with write access to `.factory/` can
still rewrite it — run untrusted agents with `.factory/` read-only to them.

## Gate pipeline: GRILL → PR

1. **GRILL** — the idea is interrogated; decisions accumulate in
   `frontier.json` (append-only; context-only ideas without a concrete
   behavioral delta from HEAD are refused). Advancing requires a human
   Ed25519 approval over `frontierHash(frontier.json)` (`es approve --stage GRILL`).
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
