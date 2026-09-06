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
4. **Hub and satellites.** Heorth is the household hub. KithLedger is an
   independent API-first service (own repo, own API) that Heorth consumes via
   its API. Services expose **REST only** — MCP is a separate container
   (`heorth-mcp`) that fronts them, see point 6. Feoh — extracted to a satellite
   in Phase 1, merged back 2026-08-10 (ADR 0007) — ships inside Heorth as a
   built-in finance module and grows there (checking accounts, investments,
   retirement projections). The `FEOH_ENABLED` kill switch was removed
   2026-08-17; the module now mounts unconditionally.
5. **Identity: A-then-B** — see
   [ADR 0002](decisions/0002-cross-service-identity-a-then-b.md). Satellites hold
   no member accounts (service API keys only) until they grow real UIs, then they
   accept Heorth-issued member JWTs.
6. **MCP is a container, not a service feature** — see
   [ADR 0008](decisions/0008-mcp-as-a-standalone-container-over-rest.md).
   `heorth-mcp` is the household's single MCP server: one Streamable HTTP
   endpoint, serving Heorth's and KithLedger's tools by calling their public
   REST APIs. It owns no data. A new service ships a REST API and gains tools
   there — it does **not** ship its own MCP surface.
7. **Core discipline (`@wyrhta/core`):**
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
- **2026-08-10:** the satellite was retired and Feoh merged back into Heorth as
  a built-in optional module — see ADR 0007 and plans/feoh-merge.md. This
  section stays as the record of Phase 1 as executed.

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

Homelab deployment (existing HAProxy FQDN → containers), Postgres
with backups, seed the real household, live with it. Learnings from real use
reprioritise everything below.

**Deferred 2026-08-24 (ADR 0015).** This phase now runs **after** Phase 4's
Ethel v1 and Weorc's first slice. The gate on it was never code — it is the human
list in `docs/manual-todo.md` (tenant `ApplicationAccessPolicy`, the first-live-run
smokes, the Pi and touchscreen purchase, secret rotation) — and the household
story is thin exactly where acceptance is judged, because the chores are unbuilt.
The old rule "feature work does not resume until deployed" is **retired**; what
survives it is the sentence above it, that real use reprioritises everything
after this phase. The human items are **not** deferred and should run in
parallel. One slice ahead of deployment, not two: a second would need its own
ADR.

### Phase 4 — Ethel v1

The physical property domain (OE *ēðel*, rune ᛟ — immovable wealth, Feoh's
counterpart): assets/appliances **including vehicles**, the home itself as a tree
of places (building → floor → room, plus outdoor and storage), the building's own
**facilities** (heating, water, electrics, PV — a detail row on an asset, with the
places each serves), Maintenance Plans (projecting due work into the task
provider), and service contacts backed by KithLedger — the first real
cross-service integration.

**Now the phase that runs first (ADR 0015):** Phase 3 deployment is deferred
behind this phase and Weorc's first slice, because chores need assets, places and
facilities to hang on. Design:
[Ethel v1 — Assets, Places, Vehicles and Facilities](superpowers/specs/2026-08-22-ethel-v1-assets-and-places-design.md)
(accepted, Parts A–C).

**Scope clarified 2026-08-24 (ADR 0014):** Maintenance Plans are **Weorc's first
slice**, not an Ethel feature. Ethel keeps the asset and place register and the
upkeep facts that belong to a thing; the recurring definition, its completion
history and the projection into the task provider live in the new **Weorc**
module, anchored to an Ethel asset or place. Service contacts (slice D) hang off
Weorc routines. Nothing about the Phase 4 delivery changes — the phase now ships
two modules, unanchored routines included: ADR 0014's bet that an anchored and
an unanchored Routine are the same kind of row is exactly what Weorc's first
slice ships to prove, not something deferred to Phase 5+.

**Delivery order inside the phase (2026-08-24):** Ethel v1 Parts A–C ship first
as one release; Weorc's first slice gets its own brainstorm and spec afterwards,
so its routines are designed against an anchor that already exists.

**Weorc's first slice shipped 2026-08-25.** Plan:
[2026-08-25-weorc-first-slice](superpowers/plans/2026-08-25-weorc-first-slice.md);
spec:
[Weorc v1 — Routines, Occurrences and the Projection Engine](superpowers/specs/2026-08-25-weorc-first-slice-design.md).
Schema, recurrence arithmetic, the three-pass tick engine, `/api/v1/weorc/...`,
the `weorc.tsx` web page (Heorth) and the `weorc.*` MCP tools (heorth-mcp) are
in-repo and green. The unanchored case shipped with it, not deferred to
Phase 5+ — the demo household seeds two unanchored routines (bins, bedding)
beside two anchored ones (the boiler, the kitchen), which is the acceptance
check ADR 0015 §4 calls for. What is **not** true yet: this is shipped-in-repo,
not deployed — no real household runs it, and the demo stack has no task
provider, so its occurrences stay unprojected (by design, not as a defect).
Phase 3 deployment is next; per ADR 0015 §5, a second pre-deployment feature
slice would need its own ADR before starting.

Prerequisite (revised 2026-08-18, ADR 0008): the old "KithLedger's MCP moves
from stdio to HTTP" item is **dropped**. The transport move happens by the
`kith.*` tools landing in `heorth-mcp` instead; KithLedger deploys as a satellite
with a REST API and no MCP surface of its own.

### Phase 5+ — toward 2.0

Unordered until Phase 3 learnings land:

- Feoh module growth (in Heorth, ADR 0007): checking accounts for daily
  life, investments, retirement projection strategies. Bank ingestion shipped
  2026-09 behind ADR 0016 (Firefly III as an optional sidecar; Feoh remains
  the ledger). Phase 3 deployment is next — ADR 0016 named this the last
  pre-deployment slice.
- **Weorc** module growth (OE *weorc* — work, labour; ADR 0014): further growth
  of the domain beyond what Phase 4's first slice already shipped (anchored
  *and* unanchored **Routines**, their completion history, and the one
  projection engine into the task provider) — more routine kinds and whatever
  real household use asks for, plus Wyrtgeard's planting calendar reusing the
  same projection engine rather than growing a second one. Still explicitly
  **no** points, allowances or rotation mechanics (see Out of scope). Sequenced
  after Phase 3 because which further chores a household actually wants
  projected is exactly the kind of thing real use reprioritises.
- **Wyrtgeard** module (OE "plant-yard" — the Garden): a household **plant
  library** (what's growing, where, care notes) plus **Ger** (futhorc ᛄ,
  "harvest") — the grow-your-own-food subfeature: planting-calendar planning,
  monitoring, per-crop history, and weather-aware timing. Its planting calendar
  projects through **Weorc's** engine (ADR 0014), with a bed as the routine's
  anchor — it does not grow a second projector. Weather enters as a new
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

Kids'-chore **mechanics** — assignment rotation, points, allowances, gamification
(children are out of the house) — multi-household, plugin runtime, hosted
offering, federation.

Note (2026-08-24): recurring household work itself is **not** out of scope; it is
the **Weorc** module above (ADR 0014). Only the kids-and-rewards layer on top of
it is.
