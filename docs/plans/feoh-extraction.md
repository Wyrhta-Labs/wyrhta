# Plan — Feoh extraction

**Phase:** 1 · **Governing decisions:** ADR 0002 (identity Phase A), strategy §4
(hub and satellites) · **Questions resolved by grilling 2026-07-23.**
**Level:** concept plan. Implementation spans the new Feoh repo and the Heorth
repo; this captures the cross-cutting design.

## Goal

Feoh graduates from Heorth module to independent satellite: own repo, API, MCP,
database. Acceptance test: **the household cannot tell it happened** — same
pages, same behavior, but the finance truth lives in its own service.

## Sequencing (a deliberate reversal)

Extraction happens **now — before the acceptance release and before any
deployment.** This reverses the original post-deployment slot because
pre-deployment extraction needs **no data migration at all** (no live rows, no
trial-balance verification), Feoh is at its smallest, and the proxy client
becomes the template for all satellite consumption before the Phase 2 provider
work lands. Cost accepted: the acceptance release slips by the extraction's
duration.

## Shape

- **UI stays in Heorth.** The existing Feoh pages in Heorth's SPA are unchanged;
  Heorth's backend proxies their requests to Feoh's API with a service key,
  stamping the acting member. Feoh is headless for humans (ADR 0002 Phase A) —
  its own UI arrives only when investments/retirement features outgrow the
  household surface, and *that* moment (not extraction) triggers identity
  Phase B.
- **`FeohClient` in Heorth** (service key, timeouts, error mapping) is written
  as a reusable pattern — the prototype for how Heorth consumes every satellite,
  KithLedger included. Core candidate later, demand-driven.
- **Own Postgres database** (`feoh`), shared homelab cluster is fine. Own
  migrations, own backup cadence. Never a shared schema — separate DB is what
  makes "own service" true.

## Members and parties

Feoh holds no member accounts. People appear as a minimal **`parties` table** —
`(party_id, display_name, kind)` — a **cache, not a source**: members carry
their Heorth member ID and a cached display name, maintained by Heorth through
Feoh's API. `kind` is `member` now; `external` (landlord, employer, payees)
becomes possible with checking-account features without touching the member
model.

**Flag:** a party MAY carry an optional cross-reference to a KithLedger person
(the split-a-trip-with-a-friend case). Never a merge — a payee is an accounting
label, not a relationship; everyday payees must not pollute KithLedger.

## Repo bootstrap: code-move, not rewrite

Bootstrap from the existing service conventions (Hono + Drizzle + `@wyrhta/core`
wiring, KithLedger-shaped minus the web UI), then transplant `modules/feoh/`
nearly verbatim — schema, service, routes, validators, mcp, and the double-entry
tests move with it (tested money-handling code is not rewritten). Two deliberate
additions during the move, not after:

1. the `parties` table (member references are rewritten at the boundary anyway);
2. `/api/v1` + `fe_` API-key prefix + core identity wiring, copied from
   KithLedger's proven setup.

Keep Heorth's 6-file **module convention inside Feoh** (envelopes/budgeting as
the first internal module) so checking accounts, investments, and retirement
projections later land as sibling modules, not a restructure. No speculative
big-Feoh architecture now — growth is demand-driven.

## MCP

**HTTP transport** (mounted route, like Heorth's `/mcp`), auth via `fe_` API
keys. System convention recorded here: **satellite services expose MCP over
HTTP; stdio is for local dev only.** Consequence: KithLedger's stdio-only MCP
gets migrated to HTTP as a Phase 4 prerequisite (it must be deployable as a
satellite before Ethel's service contacts consume it).

## Versioning

- Extraction ships as **Heorth 0.2** ("Feoh extracted, no functional change" —
  an honest changelog entry, per the same discipline core follows).
- **Feoh starts at 0.1.0.**
- The acceptance release becomes **Heorth 0.3**.

## Non-goals

Feoh member UI / SSO (identity Phase B), new finance features during the move,
bank ingest (CSV import already exists; CAMT.053/FinTS land later as — again —
providers), data migration tooling (nothing is deployed).
