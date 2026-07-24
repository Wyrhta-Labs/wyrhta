# Wyrhta Labs — Concept & Architecture

The cross-cutting design for an **interconnected, self-hosted household manager**.
This is the thinking layer that sits above the individual service repos.

## The services

- **[`wyrhta-core`](https://github.com/Wyrhta-Labs/wyrhta-core)** — shared foundation
  (identity, auth, HTTP kit, household, MCP scaffold, DB conventions). Consumed by the
  others as a pinned GitHub-tag dependency.
- **[`Heorth`](https://github.com/Wyrhta-Labs/Heorth)** — the flagship self-hosted
  household system.
- **[`KithLedger`](https://github.com/Wyrhta-Labs/KithLedger)** — API-first personal
  relationship manager.

_(`website-v0` is intentionally out of scope for the current concept work.)_

## Structure of these docs

- [`strategy.md`](strategy.md) — the long-term strategy and phased roadmap.
  **Source of truth**; the public website follows it.
- `decisions/` — Architecture Decision Records (ADRs). One file per decision that
  affects more than one service.
- `plans/` — concept plans for upcoming phases, executed in the service repos.
- [`../CONTEXT.md`](../CONTEXT.md) — the cross-service glossary.

## Cross-service conventions

- **Dev port allocation** (so all services run side by side locally):
  Heorth API **3000** / web 5173 · Feoh API **3001** · KithLedger API
  **3002** / web 5174. Postgres: one local cluster on 5432, one database per
  service (`heorth`, `feoh`, `kithledger`). Container-internal API ports stay
  3000; the allocation applies to host/dev ports.

## Settled (see strategy.md and ADRs)

Shared household identity (ADR 0002: service keys now, Heorth-issued SSO later),
external systems of record behind providers (ADR 0001), Feoh's graduation to an
independent service, `@wyrhta/core` release discipline.

## Open questions to work through

- Heorth ↔ KithLedger data flow specifics for Ethel's service contacts (Phase 4).
- The per-plan open questions listed at the end of each file in `plans/`.
- How/when the website correction pass happens (Phase 5+ backlog).
