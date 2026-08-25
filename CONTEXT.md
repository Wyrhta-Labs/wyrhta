# Wyrhta Labs

The umbrella context for an interconnected, self-hosted household system built from
independent services. This glossary holds the cross-service language; service-specific
terms live in the service repos.

## Products

**Heorth**:
The flagship self-hosted household system — one deployment per household.
_Avoid_: "the app", "the platform"

**KithLedger**:
API-first personal relationship manager, designed to be embedded/consumed by other
tools rather than used as a standalone app.
_Avoid_: CRM

**Feoh**:
The double-entry personal-finance module — accounts, transactions, and (growing
toward) investments and retirement projections. Extracted from Heorth as of Feoh
v0.1.0 / Heorth v0.2.0 (2026-07-24) into an independent service, then merged back
into Heorth 2026-08-10: merged into Heorth (ADR 0007); repo archived. Gated by
`FEOH_ENABLED` (default off). "Feoh" now names the module/domain inside Heorth,
not a separate service.
_Avoid_: "the finance module" (Feoh is the proper name for it)

**Core** (`@wyrhta/core`):
The shared foundation library (identity, auth, HTTP kit, household, MCP scaffold,
DB conventions), consumed by services as a pinned git-tag dependency.

## Language

**Household**:
The group of people one Heorth deployment serves. Exactly one per deployment
(DB-enforced singleton).
_Avoid_: family, tenant, workspace

**Member**:
A person in the Household, holding a role (admin / adult / child).
_Avoid_: user (reserve "user" for the auth-level account)

**Ethel**:
The physical property as a domain (OE *ēðel*, rune ᛟ — immovable wealth, the
estate; counterpart to Feoh's movable wealth): the building as a tree of
**Places**, the **Assets** in them (appliances, vehicles), the **Facilities** that
serve them, and the upkeep *facts* that belong to a thing (warranty, the stated
service interval). Manuals and other documents are explicitly out of scope here
(the Ethel v1 spec) — they stay in Library until the future **Office** module
exists. The recurring work itself is **Weorc**, which anchors routines here
(ADR 0014); service contacts are KithLedger people referenced from a routine.
_Avoid_: The Home, house profile, inventory

**Asset**:
The Ethel entity: a durable thing the household owns, with its lifecycle and
finance surface (purchase, warranty, decommission, cost links into Feoh). Sits in
at most one **Place**, and may carry at most one detail row — vehicle or facility
— which is the only signal of what kind of thing it is (`category` is free text).
_Avoid_: item, inventory item, product

**Place**:
The Ethel entity for the home itself: a node in a tree (`building`, `floor`,
`room`, `outdoor`, `storage`) with an optional parent. Nesting is conventional,
not enforced — a shed is `outdoor` and holds `storage`. Replaces the old free-text
`location` on an asset; the leftover prose ("behind the boiler") lives on in the
asset's `locationNote`.
_Avoid_: room (as the model name — a room is one kind of place), location, area

**Facility**:
A building system the household maintains but did not buy off a shelf — heating,
water, electrics, PV, ventilation. Modelled as a detail row on an **Asset**, plus
the set of Places it *serves*, which is a different fact from the Place it stands
in. Carries the **stated** service interval as documentation; the routine that
acts on it is **Weorc's** and never reads that field as a trigger (ADR 0014 §4).
_Avoid_: utility (that is a bill in Feoh), system, installation, amenity

**Office** (future):
Document management for the household (insurance policies, contracts, meter
readings). Does not exist yet; until it does, documents stay in Library.

**Provider**:
A pluggable adapter to an external System of Record (e.g. Microsoft 365 calendar,
Microsoft To Do). Heorth modules talk to a provider interface, never to a vendor
API directly.
_Avoid_: integration, connector (Library's "connectors" predate this term and will
converge on it)

**System of Record**:
The external service that owns a data category's truth (e.g. M365 owns calendars,
To Do owns everyday tasks). Heorth mirrors it and adds household metadata; it does
not replace it.

**Task**:
An everyday to-do (owner, due date, maybe recurrence) whose System of Record is an
external task service. Heorth mirrors Tasks; it does not own them.
_Avoid_: todo. ("Chore" is no longer avoided — since ADR 0014 it is the plain
gloss for **Weorc**, not a loose synonym for Task.)

**Weorc**:
The household's own recurring work as a domain (OE *weorc* — work, labour; no
rune, unlike Feoh and Ethel): routine definitions, their completion history, and
the projection of due work outward as Tasks. A peer of Ethel, not a feature of it
(ADR 0014) — most routines (bins, laundry, watering) anchor to nothing at all.
Owns exactly one projection engine for the whole household; Wyrtgeard's planting
calendar will use the same one. **Shipped 2026-08-25** (first slice): schema,
recurrence arithmetic, the three-pass tick engine, `/api/v1/weorc/...` in
Heorth, the `weorc.tsx` web page, and the `weorc.*` tools in heorth-mcp — see
`docs/strategy.md` Phase 4. Shipped-in-repo only; no household runs it yet
(Phase 3 deployment is still ahead), and projection degrades to "not projected"
rather than an error wherever no task provider is configured, which is the
normal state for the seeded demo household.
_Avoid_: chores module (Weorc is the proper name), Maintenance module, recurring
tasks

**Routine**:
The Weorc entity: a recurring definition (schedule or interval) with an optional
**anchor** — an Ethel asset or place, later a Wyrtgeard bed, or nothing. May name
an owning member; carries no points, allowance or rotation mechanics. Two modes
ship: `fixed` (a grid pinned to an anchor date, fast-forwarding over a gap to one
overdue occurrence, never a backlog) and `from_completion` (recurs from when it
was last done, so it drifts by design).
_Avoid_: chore (as a model name), schedule, plan

**Maintenance Plan**:
A Weorc Routine anchored to an Ethel asset or place — recurring upkeep of the
property (interval, completion history). Still projects due work outward as
Tasks in the external task service. Since
ADR 0014 the *definition* lives in Weorc; only the thing it maintains is Ethel's.
Not a separate table or model — same `weorc_routines` row as an unanchored
Routine, distinguished only by `anchorAssetId`/`anchorPlaceId` being set
(ADR 0014's one-kind-of-row claim).
_Avoid_: recurring task (that's a Task concern), "Ethel's maintenance plans" (the
plan is Weorc's, the asset is Ethel's)

**Occurrence**:
One due instance of a Weorc Routine, materialised ahead of its due date by
`leadDays`. Once terminal (completed or skipped) the same row *is* the history
entry — there is no separate history table. At most one open occurrence exists
per routine at a time (ADR 0014 §6): Weorc is not a task list. Carries the link
to its mirrored Task in the provider (`taskFeedKey`/`taskExternalId`) once
projected; `projectionError` stays null when there is simply no provider to
project into.
_Avoid_: instance, todo, task

**Party**:
A person or entity referenced in Feoh's books (who paid, who a split is
between, a payee). Members are parties whose truth lives in Heorth (Feoh caches
only id + display name); external parties may optionally cross-reference a
KithLedger person, never merge with one.
_Avoid_: contact, payee (as a model name)

**Hearth View**:
Heorth's always-on kitchen-touchscreen surface: glanceable week/month with meal
plan beside the family calendar and what's currently due. The primary household
client; the phone PWA is its companion.
_Avoid_: dashboard mode, kiosk mode, wall display

**Acceptance Gate**:
The launch criterion for a phase: the feature set the household's members (the
real product owners) require before adopting the deployment for daily use.
