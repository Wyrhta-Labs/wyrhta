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
estate; counterpart to Feoh's movable wealth): the building, rooms, assets/
appliances, vehicles, and their upkeep. Anchor for Maintenance Plans; service
contacts are KithLedger people referenced from here.
_Avoid_: The Home, house profile, inventory

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
_Avoid_: chore (ambiguous), todo

**Maintenance Plan**:
A Heorth-native definition of recurring upkeep for The Home (interval, completion
history, links to manuals). Projects due work outward as Tasks in the external
task service.
_Avoid_: recurring task (that's a Task concern)

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
