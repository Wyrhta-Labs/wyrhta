# 0007 — Feoh returns to Heorth as a built-in optional module

**Status:** accepted 2026-08-10 · **Amended 2026-08-17:** the `FEOH_ENABLED`
kill switch described below was removed; `feohModule` now mounts unconditionally
in every deployment. The precedent it set for *optional* features (env kill
switch + `GET /api/v1/features`) still stands for other modules — Feoh simply
stopped being optional. · **Supersedes:** the Feoh satellite architecture
(plans/feoh-extraction.md, executed as Phase 1) and Heorth's unimplemented
plugin-host design (Heorth docs/superpowers/specs/2026-08-06-plugin-system-design.md).

## Context

Phase 1 extracted Feoh into an independent satellite: own repo, database,
container, API key, MCP surface, reached through an HTTP proxy in Heorth. The
boundary bought an independent lifecycle nobody used — one maker, both repos in
lockstep — and charged continuously: a second deployable, roster sync with a
staleness window, a parties cache, classified-error plumbing. A follow-up
design (2026-08-06) would have kept Feoh's repo but run it in-process as a
runtime-loaded plugin; that trades the operational cost for a permanent
compatibility contract (apiVersion, peer-dependency lockstep, host-run foreign
migrations) maintained for exactly one first-party plugin — and strategy.md
already lists "plugin runtime" as out of scope.

## Decision

Feoh's finance domain moves back into Heorth as an ordinary compile-time
module, present in every build, gated per deployment by `FEOH_ENABLED`
(default off, zero behavioral footprint when off, data untouched by toggling).
The parties boundary is dropped: finance rows FK household members directly
(`ON DELETE RESTRICT` — finance records are audit data). The Feoh repo is
archived after the merge is verified. KithLedger's satellite status is
unchanged — hub-and-satellites remains the doctrine for genuinely independent
services; Feoh simply never was one.

## Consequences

- One container, one database, one API surface, one liveness probe.
- The roster-sync/staleness problem class is deleted, not managed.
- Optional features get a precedent: env kill switch + runtime feature
  endpoint (`GET /api/v1/features`), following the M365 all-or-nothing pattern.
- The `external` payee concept returns only when checking-account features
  land, as its own table.
- Heorth ships this as its next minor with an honest changelog entry.
