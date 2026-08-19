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
`CLAUDE.md` pointer to it), `.claude/`, and `docs/` (the concept + architecture
decision records).

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

## Working mode for this repo (IMPORTANT)

- **Conceptual / architecture design only.** Work here produces docs under `docs/`.
  **One exception: `deploy/`** holds the household stack's Docker Compose files
  (`docs/plans/household-stack-compose.md`). It is the only runnable, non-docs
  content this repo tracks, because the meta repo is the only place that knows
  every service exists. This carve-out does not license editing code inside the
  service folders — that rule is unchanged.
- **Do not edit code inside `wyrhta-core/`, `Heorth/`, `KithLedger/`, or
  `heorth-mcp/` directly from a session in this repo.** Those are separate repos with
  their own agent instructions and conventions.
  **Exception — orchestrated implementation (added 2026-08-18):** a session here may
  *dispatch subagents* that work inside a service folder, for cross-repo programmes
  the meta repo is coordinating (the ADR 0008 MCP migration is the first).
  Conditions, all of them:
  - The subagent's working directory is the **service folder**, and it reads and
    follows that repo's own `CLAUDE.md` / `AGENTS.md` — meta-repo conventions do not
    travel with it.
  - It changes **only** that one repo, and commits in that repo.
  - The orchestrating session still writes no service code with its own hands.
  - Ad-hoc edits outside such a programme remain forbidden: open a session in the
    relevant folder.
- **Do not edit site code in `website/`** — the single exception is the website
  content-transfer document described below.
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

Until there is a proper change workflow, **`website/docs/website-brief.md` is the
standard transfer document for website content.** It is the one file this repo may write
inside `website/`.

Direction of flow is one-way: **`docs/strategy.md` (this repo) → `website-brief.md` →
site copy.** `strategy.md` is the source of truth; the site is a downstream rendering and
gets corrected to match, never the reverse.

- **To hand new content to the site:** from a session in *this* repo, rewrite
  `website/docs/website-brief.md` from `docs/strategy.md`, the ADRs, `IDEAS.md`, and
  `manual-todo.md`. Update its `Generated:` date. Commit it in the `website` repo
  (it is a separate repo; `/website/` is git-ignored here — never stage it in the meta
  repo's index).
- **To render it:** open a session in `website/` and treat the brief as **read-only
  input**. Site sessions do not edit the brief.
- **If the site session wants a strategy change:** bring it back here as an edit to
  `docs/strategy.md` first, then re-issue the brief.
- **Honesty constraints carry with the brief:** distinguish shipped from planned, keep the
  one-maker framing, and never publish secrets, tenant IDs, mailbox addresses, client IDs,
  or FQDNs from `manual-todo.md`.

## Common commands

There is no build/test here. Git operations against GitHub go through `gh`
(the credential helper), per global instructions.
