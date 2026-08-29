# AGENTS.md — Wyrhta Labs (meta / concept repo)

This is the **umbrella repo** for Wyrhta Labs. It does **not** contain application
code. It holds the cross-cutting concept, architecture, and decision record for an
**interconnected, self-hosted household manager** built from several independent services.

## What lives where

This root folder is a container. Each subfolder is its **own independent git repo**
(hosted separately on GitHub under the `Wyrhta-Labs` org) and is **git-ignored here**:

| Folder | Repo | What it is |
|---|---|---|
| `wyrhta-core/` | `Wyrhta-Labs/wyrhta-core` (public) | Shared foundation lib `@wyrhta/core`: identity, auth, HTTP kit, household, MCP scaffold, DB conventions |
| `Heorth/` | `Wyrhta-Labs/Heorth` | Flagship self-hosted household system |
| `heorth-mcp/` | `Wyrhta-Labs/heorth-mcp` (private) | The household's single MCP server — its own container, a pure REST client of the services (ADR 0008) |
| `KithLedger/` | `Wyrhta-Labs/KithLedger` | API-first personal relationship manager |
| `Feoh/` | `Wyrhta-Labs/Feoh` (private) | Personal-finance service — merged into Heorth (ADR 0007); repo archived |
| `website/` | `Wyrhta-Labs/website` | Public site. **Do not edit site code from here** — the only permitted write is the content-transfer file (see below) |

This repo (`Wyrhta-Labs/wyrhta`) tracks only: this `AGENTS.md` (plus the
`CLAUDE.md` pointer to it), `.claude/`, `.agents/`, `.codex/`, `.opencode/`,
`docs/` (the concept + architecture decision records), and `deploy/`.
The agent-specific folders hold repo-local skill/pointer material; the canonical
skill copy lives under `.agents/skills/`, while runtime-specific skill directories
should contain only discovery stubs that point back to the canonical copy.

## How the services connect

- `Heorth` and `KithLedger` both consume `@wyrhta/core` as a **pinned GitHub-tag
  dependency** (`github:Wyrhta-Labs/wyrhta-core#v0.1.1`) — **not** a workspace/local
  link. This is three independent repos sharing a library by version tag, **not** a
  monorepo. A change in `wyrhta-core` only reaches the consumers when a new tag is
  cut and their `package.json` is bumped.
- **MCP is not a property of a service** (ADR 0008). A service ships a **REST API**;
  `heorth-mcp` is a separate container that turns REST into MCP tools for the whole
  household, over Streamable HTTP, forwarding the caller's `he_` key to Heorth.
  **A new service does not get its own MCP surface** — it gets tools in `heorth-mcp`
  that call its API. The MCP code embedded in `Heorth`, `KithLedger`, and
  `wyrhta-core` is being migrated out; see `heorth-mcp/docs/spec/`.

## Local environments for agents

Use the repo-local skills before operating the shared local stacks:

- **Dev stack:** read `.agents/skills/wyrhta-dev-env/SKILL.md`; use
  `deploy/compose.dev.yml` with `deploy/.env`. It builds sibling checkouts and
  runs real local dev data on `heorth_dev` / `kithledger_dev`. `deploy/dev-up.sh`
  (PowerShell: `deploy\dev-up.ps1`) is the one-command bring-up; it fills only
  blank values in `deploy/.env` and never touches a filled one.
- **Demo stack:** read `.agents/skills/wyrhta-demo/SKILL.md`; use
  `deploy/compose.demo.yml` and `deploy/demo-up.sh` where possible. It is an
  isolated, throwaway, seeded household and must not reach real external systems.

Never substitute the per-service `Heorth/docker-compose.yml` or
`KithLedger/docker-compose.yml` when the user asks for the Wyrhta dev or demo
environment. The shared stack ports are:

| Service | Dev | Demo |
|---|---:|---:|
| Heorth | 14000 | 24000 |
| Firefly III | 14001 | — |
| KithLedger | 14002 | 24002 |
| heorth-mcp | 14003 | 24003 |
| Firefly Data Importer | 14004 | — |
| Postgres | 15432 | 25432 |

Firefly III is the bank-ingestion sidecar (ADR 0016), and it takes the slot the
retired Feoh satellite used to reserve. It runs in **dev and prod only**: the
demo stack reaches no external system (ADR 0012) and `seed-demo.mjs` fills its
import inbox directly instead. Firefly is never a household surface — its web UI
is an operator tool for connecting banks, and Feoh remains the system of record.

Container-internal ports stay conventional (`3000`, `3200`, `5432`, and `8080`
for the two Firefly containers). Tests must
use `_test` databases, never the dev databases. `deploy/.env` and
`deploy/.env.demo` are ignored secret files: do not commit them and do not paste
their contents. Demo scripts may read login values from `.env.demo`, but bearer
tokens are process-local only and must not be saved.

## Working mode for this repo (IMPORTANT)

- **This repo's own content is docs.** Work *on this repo* produces docs under
  `docs/`, plus `deploy/` — the household stack's Docker Compose files
  (`docs/plans/household-stack-compose.md`), the only runnable content this repo
  tracks, because the meta repo is the only place that knows every service exists.
- **Work in the sibling repos may be done from a session here** (changed
  2026-08-19; the previous rule confined a meta session to docs and allowed
  service work only through dispatched subagents). A session in this folder may
  edit, run, and commit inside `wyrhta-core/`, `Heorth/`, `KithLedger/`,
  `heorth-mcp/`, and `website/` — directly or through subagents, whichever fits
  the task. The boundaries that remain are about **repos**, not about who is
  holding the keyboard:
  - **Read the target repo's own `CLAUDE.md` / `AGENTS.md` before touching it**,
    and follow it. Meta-repo conventions do not travel into a service; that repo's
    conventions win inside it.
  - **One change, one repo, one commit.** Each repo's changes are committed in
    that repo. Never stage a sibling folder in the meta repo's index — all five
    are git-ignored here, and a cross-repo change is several commits, not one.
  - **Say which repo you are in.** When a turn touches more than one, report the
    commits per repo.
- Capture cross-cutting decisions as ADRs in `docs/decisions/`.

## Execution log (maintained automatically)

`docs/execution-log.md` is the committed record of what was actually built per phase —
commit ranges, tags, adjudicated deviations, deferred findings. **Do not hand-edit its
phase sections.** They are generated: the execution tooling writes
`.superpowers/sdd/progress.md` (git-ignored) and a `Stop` + `SubagentStop` hook
(`.claude/hooks/sync-execution-log.sh`) syncs those sections into the log after every
turn and every subagent. The log's preamble, above the first `##` heading, is
hand-written and preserved by the sync.

Record progress in the ledger and it reaches the log by itself. Committing is manual —
review the synced diff, then commit.

## Website content workflow (interim)

**`website/docs/website-brief.md` is the standard transfer document for website
content.** Since 2026-08-19 a meta session may also render the site itself (see
"Working mode" above), so the brief is no longer a wall between two sessions — it
stays because it is the artefact that keeps the site's claims traceable to a
decision, and because it is what a later session reads to know what the site was
told.

Direction of flow is one-way: **`docs/strategy.md` (this repo) → `website-brief.md` →
site copy.** `strategy.md` is the source of truth; the site is a downstream rendering and
gets corrected to match, never the reverse.

- **To hand new content to the site:** rewrite `website/docs/website-brief.md` from
  `docs/strategy.md`, the ADRs, `IDEAS.md`, and `manual-todo.md`. Update its
  `Generated:` date. Commit it in the `website` repo (it is a separate repo;
  `/website/` is git-ignored here — never stage it in the meta repo's index).
- **To render it:** work in `website/` with the brief as **read-only input** — from
  a session there or from one here. Rendering does not edit the brief: re-issue it
  from this repo instead, so the site never becomes its own source.
- **If rendering surfaces a strategy change:** make it here as an edit to
  `docs/strategy.md` first, then re-issue the brief, then render. Same order whether
  or not it is the same session.
- **Honesty constraints carry with the brief:** distinguish shipped from planned, keep the
  one-maker framing, and never publish secrets, tenant IDs, mailbox addresses, client IDs,
  or FQDNs from `manual-todo.md`.

## Common commands

There is no build/test here. Git operations against GitHub go through `gh`
(the credential helper), per global instructions.
