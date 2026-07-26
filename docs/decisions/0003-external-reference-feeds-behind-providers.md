# 0003 — External reference feeds behind providers

**Status:** proposed (2026-07-26)

## Context

[ADR 0001](0001-external-systems-of-record-behind-providers.md) abstracts external
**systems of record** — household-*authored* data (calendars, tasks) that already
lives elsewhere. Heorth mirrors it, enriches it with household metadata, and
(phase 2) writes back. That doctrine carries specific machinery: OAuth into the
household's tenant, a sync loop, and conflict handling.

Phase 5+'s **Wyrtgeard** module and its **Ger** subfeature (grow-your-own food)
need weather: forecasts for planting/frost/watering decisions, and observed
history so a crop's record reflects the conditions it actually got.

Weather fails every test of ADR 0001's doctrine — nobody authors or owns the
weather, there is nothing to mirror as the household's own data, there is no
write-back, and there is no tenant to OAuth into. Forcing it under 0001 would
overload a decision that is specifically about *owned* data living elsewhere. Yet
weather wants the same *mechanics*: a pluggable interface so no vendor API types
leak into module domains, and a first-provider-of-many for the 2.0 provider matrix.

## Decision

Introduce a **second provider category: external reference feeds** — read-only
sources of world data that no household member authors and Heorth never writes
back to. Weather is the first instance (`WeatherProvider`); the category also
reserves a slot for future feeds (air-quality, frost-date / hardiness tables, and
energy prices for a future Feoh consumer).

Rules that distinguish reference feeds from ADR 0001 systems of record:

1. **Read-only, no write-back, ever.** No sync loop and no conflict handling —
   just queries against the feed.
2. **No tenant coupling.** Auth is a vendor API key at most; the first weather
   provider SHOULD be **keyless** — Open-Meteo, or **DWD / Bright Sky** for the
   DE-first household — to keep self-hosting friction-free. Contrast ADR 0001's
   structural dependency on an OAuth app registration in the tenant.
3. **Location-anchored.** The interface is keyed to a location, defaulting to the
   home's coordinates (household / The Home config), not per-member.
4. **Split persistence (the crux).**
   - **Forecasts are ephemeral cache** (short TTL) and are never the system of
     record.
   - **Observed past conditions are persisted into Heorth-native storage**, which
     makes **Heorth** the system of record for the historical conditions attached
     to a crop — exactly ADR 0001's own carve-out ("domain knowledge no external
     service models"). Ger's history therefore survives independent of any
     provider's retention policy or continued existence.
5. **Minimal interface, demand-driven.** `forecast(range)` and
   `observations(range)` at minimum; `current()` only if a dashboard concretely
   needs it. No vendor types cross the boundary.
6. **Lives in the consumer (Heorth)**, beside the calendar/task providers — not in
   `@wyrhta/core`, per the same demand-driven rule (core gains nothing until a
   second service needs feeds; energy-prices-in-Feoh would be the trigger to
   reconsider promotion).

## Consequences

- ADR 0001 stays crisp — it remains specifically about mirrored systems of record.
- Ger's crop history is durable and provider-independent by construction.
- Self-hosting stays low-friction: a keyless first provider means no vendor signup
  on the critical path.
- The estate gains a named slot for future world-data feeds without re-litigating
  doctrine each time one appears.
- Cost: a second provider taxonomy to hold in mind, and the persistence split adds
  a small observation-capture write path that pure ephemeral caching would not.
- **Proposed, not accepted.** Nothing is built until Wyrtgeard/Ger reaches the
  roadmap; the interface specifics here are provisional and get ratified — and
  possibly revised — when Ger is designed for real.
