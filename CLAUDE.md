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
| `website-v0/` | `Wyrhta-Labs/website-v0` | **Out of scope — do not touch this session** |

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
- **Never touch `website-v0/`** — explicitly out of scope for now.
- Capture cross-cutting decisions as ADRs in `docs/decisions/`.

## Common commands

There is no build/test here. Git operations against GitHub go through `gh`
(the credential helper), per global instructions.
