# Wyrhta Labs — Strategy & Roadmap

**Status:** accepted 2026-07-23 · This document is the source of truth. The public
website's roadmap is a downstream rendering of it and gets corrected to match —
never the other way around.

## Doctrine

1. **Own household first.** The primary user for the next 12 months is our own
   household. External self-hosters become a *gate* ("ready for others"), not a
   driver, roughly at the 1.0 mark.
2. **The wife is the acceptance gate.** A release is launch-ready when the
   household's members would actually adopt it — not when tests are green.
3. **External systems of record, provider abstractions** — see
   [ADR 0001](decisions/0001-external-systems-of-record-behind-providers.md).
   M365 owns calendars, To Do owns everyday tasks; Heorth mirrors and enriches.
   Providers are pluggable from day one; multi-provider choice (Google, CalDAV,
   Google Tasks, partner project) is a 2.0 commitment.
4. **Hub and satellites.** Heorth is the household hub. KithLedger and Feoh are
   independent API-first services (own repo, API, MCP) that Heorth consumes via
   their APIs. Feoh graduates from Heorth module to satellite (see Phase 1) and
   grows into a full personal-finance service (checking accounts, investments,
   retirement projections).
5. **Identity: A-then-B** — see
   [ADR 0002](decisions/0002-cross-service-identity-a-then-b.md). Satellites hold
   no member accounts (service API keys only) until they grow real UIs, then they
   accept Heorth-issued member JWTs.
6. **Core discipline (`@wyrhta/core`):**
   - Demand-driven only — features land when a consumer concretely needs them.
   - Every change ships as a semver tag + changelog entry (pre-1.0: minor may
     break, patch is safe). Consumers upgrade by deliberate pin-bump.
   - A README states what core is and is not (no business domains, no UI).
7. **Primary surface is the Hearth View** — the kitchen touchscreen. The weekly
   meal-plan-beside-calendar view is the adoption hook; calendar/task sync is the
   plumbing that makes it truthful. The phone PWA is the companion (shopping
   list, on-the-go capture).

## Roadmap

### Phase 0 — Housekeeping ✅ DONE 2026-07-23/24

Shipped: core v0.1.2 (README, CHANGELOG, version-drift fix), KithLedger v0.2.0
(plus retroactive v0.1.0 tag, stray-tag cleanup), Heorth Library verification.

- KithLedger: tag the implemented-but-unreleased work (web UI, security
  hardening) as **0.2**.
- Heorth: finish the Library module's unchecked verification steps.
- Core: **v0.1.2** — README, CHANGELOG, fix `CORE_VERSION`/package-version drift.

### Phase 1 — Feoh extraction ✅ DONE 2026-07-24 (Feoh v0.1.0, Heorth v0.2.0 + retroactive v0.1.0)

- New repo `Wyrhta-Labs/Feoh`: own API, MCP, own Postgres **database** (shared
  homelab cluster is fine); Heorth keeps the finance UI, its backend proxying to
  Feoh with a service key (ADR 0002 Phase A). Acceptance test: **the household
  cannot tell it happened.**
- Deliberately *before* the acceptance release and any deployment — moved ahead
  of the original post-deployment slot (2026-07-23 reversal) because pre-
  deployment extraction needs **no data migration at all**, Feoh is at its
  smallest, and the `FeohClient` proxy becomes the template for all satellite
  consumption before Phase 2's provider work lands.
- Ships as **Heorth 0.2** ("no functional change") + **Feoh 0.1.0**.
- Details: [Feoh extraction plan](plans/feoh-extraction.md).

### Phase 2 — Acceptance release ✅ CODE DONE 2026-07-24 (Heorth v0.3.0) — awaiting real-tenant smoke + hardware + spouse gate

The smallest set that gets the system adopted at home:

- **Calendar:** read-only mirror of M365 personal + family calendars via a
  `CalendarProvider` interface (Graph is the first provider). No write-back yet.
- **Tasks:** sync with Microsoft To Do via a `TaskProvider` interface. Everyday
  tasks are mirrored; Heorth may create tasks outward.
- **PWA:** installable on iOS homescreen (Android later); responsive.
- **Hearth View:** the headline — week/month with meals + calendar + current
  items, wall-touchscreen-first.

Plans: [M365 integration](plans/m365-integration.md) ·
[Hearth View + PWA](plans/hearth-view-pwa.md)

**Scope added 2026-07-27 — localisation (DE first), pulled forward from
Phase 5+:** the household `locale` setting exists but nothing consumes it —
the UI (incl. the wall display's day/date strings) is hardcoded English
([Heorth#4](https://github.com/Wyrhta-Labs/Heorth/issues/4)). The exit
criterion is spouse acceptance and the acceptance surface speaks the wrong
language; German UI is acceptance polish, not a feature. Hearth View first,
then phone screens, then settings. Post-v0.3.0 work — ships as a 0.3.x before
the gate. **Resolved 2026-07-28** (Heorth#4 closed, i18n layer + en/de
catalogs on main, German Hearth View verified live in the simulated wall
dry-run); shipped as **Heorth v0.3.1** 2026-07-28.

**Exit criterion:** spouse acceptance.

### Phase 3 — Deployment

Homelab deployment (existing HAProxy FQDN → containers, now incl. Feoh), Postgres
with backups, seed the real household, live with it. Learnings from real use
reprioritise everything below. Feature work does not resume until deployed.

### Phase 4 — Ethel v1

The physical property domain (OE *ēðel*, rune ᛟ — immovable wealth, Feoh's
counterpart): assets/appliances **including vehicles**, rooms, Maintenance Plans
(projecting due work into the task provider), and service contacts backed by
KithLedger — the first real cross-service integration.

Prerequisite: **KithLedger's MCP moves from stdio to HTTP transport** (satellite
convention: MCP over HTTP, stdio for local dev only) so it deploys as a satellite
before Ethel consumes it.

### Phase 5+ — toward 2.0

Unordered until Phase 3 learnings land:

- Feoh growth: checking accounts for daily life, investments, retirement
  projection strategies.
- **Wyrtgeard** module (OE "plant-yard" — the Garden): a household **plant
  library** (what's growing, where, care notes) plus **Ger** (futhorc ᛄ,
  "harvest") — the grow-your-own-food subfeature: planting-calendar planning,
  monitoring, per-crop history, and weather-aware timing. Weather enters as a new
  **external reference-feed provider** (`WeatherProvider`, see
  [ADR 0003](decisions/0003-external-reference-feeds-behind-providers.md)).
  Own-household-first:
  scoped to our actual beds/plots, not a generic horticulture app. Sizeable enough
  that it may graduate to its own phase once Phase 3 learnings land.
- Calendar write-back (provider phase 2).
- Provider matrix: Google Calendar, CalDAV; Google Tasks and the partner task
  project.
- **Office** module: household document management (until then, documents stay
  in Library).
- Identity Phase B: Heorth-issued member JWTs; satellite UIs.
- Hearth View device tokens (wall display without login ceremony).
- Android PWA polish. (Localisation moved into Phase 2 scope, 2026-07-27 —
  see above; further languages beyond DE/EN stay here.)
- Website correction pass: align copy with this document (Feoh as satellite is
  now true-in-target; fictional journal personas reviewed against the "one
  maker" honesty principle).

## Out of scope until further notice

Kids'-chores features (children are out of the house), multi-household, plugin
runtime, hosted offering, federation.
