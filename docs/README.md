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

- `decisions/` — Architecture Decision Records (ADRs). One file per decision that
  affects more than one service.

## Open questions to work through

_To be filled in as the concept develops — e.g. how the services share a household
identity, how data flows between Heorth and KithLedger, how `@wyrhta/core` versioning
is coordinated across consumers._
