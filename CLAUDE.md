# CLAUDE.md — Wyrhta Labs (meta / concept repo)

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
| `KithLedger/` | `Wyrhta-Labs/KithLedger` | API-first personal relationship manager |
| `Feoh/` | `Wyrhta-Labs/Feoh` (private) | Independent personal-finance service (being extracted from Heorth) |
| `website-v0/` | `Wyrhta-Labs/website-v0` | Public site. **Do not edit site code from here** — the only permitted write is the content-transfer file (see below) |

This repo (`Wyrhta-Labs/wyrhta-labs`) tracks only: this `CLAUDE.md`, `.claude/`,
and `docs/` (the concept + architecture decision records).

## How the services connect

- `Heorth` and `KithLedger` both consume `@wyrhta/core` as a **pinned GitHub-tag
  dependency** (`github:Wyrhta-Labs/wyrhta-core#v0.1.1`) — **not** a workspace/local
  link. This is three independent repos sharing a library by version tag, **not** a
  monorepo. A change in `wyrhta-core` only reaches the consumers when a new tag is
  cut and their `package.json` is bumped.

## Working mode for this repo (IMPORTANT)

- **Conceptual / architecture design only.** Work here produces docs under `docs/`.
- **Do not edit code inside `wyrhta-core/`, `Heorth/`, or `KithLedger/`** from this
  repo. Those are separate repos with their own `CLAUDE.md` and conventions; open a
  session in the relevant folder for implementation work.
- **Do not edit site code in `website-v0/`** — the single exception is the website
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

Until there is a proper change workflow, **`website-v0/docs/website-brief.md` is the
standard transfer document for website content.** It is the one file this repo may write
inside `website-v0/`.

Direction of flow is one-way: **`docs/strategy.md` (this repo) → `website-brief.md` →
site copy.** `strategy.md` is the source of truth; the site is a downstream rendering and
gets corrected to match, never the reverse.

- **To hand new content to the site:** from a session in *this* repo, rewrite
  `website-v0/docs/website-brief.md` from `docs/strategy.md`, the ADRs, `IDEAS.md`, and
  `manual-todo.md`. Update its `Generated:` date. Commit it in the `website-v0` repo
  (it is a separate repo; `/website-v0/` is git-ignored here — never stage it in the meta
  repo's index).
- **To render it:** open a session in `website-v0/` and treat the brief as **read-only
  input**. Site sessions do not edit the brief.
- **If the site session wants a strategy change:** bring it back here as an edit to
  `docs/strategy.md` first, then re-issue the brief.
- **Honesty constraints carry with the brief:** distinguish shipped from planned, keep the
  one-maker framing, and never publish secrets, tenant IDs, mailbox addresses, client IDs,
  or FQDNs from `manual-todo.md`.

## Common commands

There is no build/test here. Git operations against GitHub go through `gh`
(the credential helper), per global instructions.
