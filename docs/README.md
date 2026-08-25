# Wyrhta Labs — Concept & Architecture

The cross-cutting design for an **interconnected, self-hosted household manager**.
This is the thinking layer that sits above the individual service repos.

## The services

- **[`wyrhta-core`](https://github.com/Wyrhta-Labs/wyrhta-core)** — shared foundation
  (identity, auth, HTTP kit, household, DB conventions; the MCP scaffold moves out
  to `heorth-mcp` per ADR 0008). Consumed by the
  others as a pinned GitHub-tag dependency.
- **[`Heorth`](https://github.com/Wyrhta-Labs/Heorth)** — the flagship self-hosted
  household system.
- **[`KithLedger`](https://github.com/Wyrhta-Labs/KithLedger)** — API-first personal
  relationship manager.

_(`website` — the public site. Content reaches it one way, via the transfer document
`website/docs/website-brief.md`; see the workflow section in the root `AGENTS.md`.)_

## Structure of these docs

- [`strategy.md`](strategy.md) — the long-term strategy and phased roadmap.
  **Source of truth**; the public website follows it.
- `decisions/` — Architecture Decision Records (ADRs). One file per decision that
  affects more than one service.
- `plans/` — concept plans for upcoming phases, executed in the service repos.
- [`execution-log.md`](execution-log.md) — the cross-repo record of what was actually
  built per phase: commit ranges, tags, adjudicated deviations, deferred findings.
- [`local-environments.md`](local-environments.md) — how to run the shared local
  dev stack and the isolated seeded demo stack.
- [`../CONTEXT.md`](../CONTEXT.md) — the cross-service glossary.

> Some documents here cite `manual-todo.md` — the operator's log of steps that
> need tenant or hardware access. It is deliberately **not** part of this repo:
> it holds deployment state (tenant identifiers, mailbox addresses, hostnames),
> so it lives only in the maintainer's checkout and is git-ignored. Those
> citations will not resolve for you, and nothing in the architecture depends on
> them.
- [`going-public.md`](going-public.md) — the audit and checklist for making the
  repos public: what leaks, what blocks, what a stranger trips over.
- [`wyrhta-core-review-handoff.md`](wyrhta-core-review-handoff.md) — **closed.**
  The provenance record of the 2026-08-23 `wyrhta-core` code review: which commit
  closed which of the ten findings, and the one residual gap a fix left behind.
  No open work.

## Cross-service conventions

- **Dev port allocation** (so all services run side by side locally):
  Heorth API **14000** / web 5173 · retired Feoh slot **14001** · KithLedger API
  **14002** / web 5174 · heorth-mcp **14003**. Postgres: one local cluster on
  **15432**, one database per service. Container-internal API ports stay 3000
  or 3200; the allocation applies to host/dev ports.

## Settled (see strategy.md and ADRs)

Shared household identity (ADR 0002: service keys now, Heorth-issued SSO later),
external systems of record behind providers (ADR 0001), Feoh's graduation to an
independent service, `@wyrhta/core` release discipline.

## Open questions to work through

- Heorth ↔ KithLedger data flow specifics for service contacts (Phase 4) — which
  hang off **Weorc** routines, not off Ethel assets (ADR 0014).
- The per-plan open questions listed at the end of each file in `plans/`.
- How/when the website correction pass happens (Phase 5+ backlog).
