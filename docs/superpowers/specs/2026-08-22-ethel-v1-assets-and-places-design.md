# Ethel v1 — Assets, Places, Vehicles and Facilities — Design

**Date:** 2026-08-22 (Part C added 2026-08-24)
**Status:** shipped 2026-08-25 in Heorth v0.6.0 — Parts A, B and C
**Decisions:** [ADR 0013 — Ethel absorbs the Inventory module](../../decisions/0013-ethel-absorbs-the-inventory-module.md) ·
[ADR 0014 — Weorc owns recurring household work](../../decisions/0014-weorc-owns-recurring-household-work.md) ·
[ADR 0015 — Feature work resumes before deployment](../../decisions/0015-feature-work-resumes-before-deployment.md)
**Supersedes for the asset register:** Heorth's `docs/superpowers/specs/2026-08-16-feoh-inventory-lifecycle-design.md`, Part 1

## Goal

Turn the shipped Inventory module into **Ethel**, the physical-property domain
(`strategy.md` Phase 4) — the register that Weorc's chores will hang on:

- **A — Domain and naming.** The rename, in three repos, with the migration.
- **B — Assets, places and vehicles.** `location` free text becomes a place
  tree; vehicles get a shape; the existing lifecycle/TCO surface is preserved
  intact.
- **C — Facilities** (added 2026-08-24). The building's own systems — heating,
  water, electrics, PV — as a detail row on an asset, with the places each one
  serves. See the numbering warning below.

Phase 4's other two slices are **out of this spec** and get their own:
**C — Maintenance Plans** (recurring upkeep projected outward as Tasks through
the existing `TaskProvider` seam) and **D — service contacts** (KithLedger
people attached to plans, gated on ADR 0002 Phase B).

**Numbering warning.** This spec's **Part C** (facilities) is not Phase 4's
**slice C** (Weorc's maintenance routine). The two Cs are unrelated; the phase's
slice letters come from `strategy.md`, this spec's part letters from its own
structure.

**Update 2026-08-24 (ADR 0014):** slices C and D are **Weorc's**, not Ethel's.
The routine, its completion history and the `TaskProvider` projection live in
`src/modules/weorc/`, anchored to an Ethel asset or place; service contacts hang
off Weorc routines. Nothing in slices A and B changes — this spec stays as
written — but the slice-C spec belongs to Weorc and must not add
`ethel_maintenance_*` tables.

## Scope boundary

**In:** the rename; `ethel_places` as a tree; `assets.placeId` +
`assets.locationNote`; `ethel_vehicles`; the place/vehicle REST surface; the
descendant-aware asset filter; `ethel_facilities` + `ethel_facility_places` and
their REST surface; the web page rename plus place management, vehicle details
and facility details; the `heorth-mcp` tool rename plus place, vehicle-detail and
facility-detail tools; the schema change; the demo seed.

**Out, deliberately:** Maintenance Plans and every other recurring definition —
Weorc owns those (ADR 0014), and `serviceIntervalMonths` on a vehicle or a
facility is a stated fact, not a schedule; service contacts; photos; documents
(the Office module is deferred — documents stay in Library); barcodes; loan
tracking; quantities; Tier-3 costs (energy, allocated shares — unchanged from
the 2026-08-16 cut); odometer history; **consumables and pantry stock**, which
is a different feature that merely shares the English word "inventory"
(ADR 0013 §7); meter readings and consumption history for a facility (that is the
Office module's ground, and Tier-3 energy costs were already cut).

## What is preserved untouched

The lifecycle and finance surface is *not* being redesigned — only renamed. The
nine descriptive fields, the decommission trio and its two CHECKs, the
reactivation escape hatch, `DISPOSAL_LINK_EXISTS`, `HAS_FINANCE_LINKS`,
`ALREADY_DECOMMISSIONED`, the two-schema validator split (create rejects the
lifecycle trio; update accepts it only as an all-three null), the feoh-side
`feoh_item_costs` / `recurring_bills` links and the TCO computation all carry
over as they are. Ethel v1 adds place, vehicle and naming; it changes no
lifecycle behaviour.

Two existing rules that must survive the rename verbatim:

- **Ethel never imports feoh.** The one sanctioned touchpoint stays a
  table-level raw-SQL existence read (`hasDisposalLink`), now querying
  `feoh_item_costs.asset_id`, and stays covered by a test so a rename breaks
  loudly.
- **No maintenance-admin quarantine on Ethel writes.** That guard is a
  finance-mutation concern; Ethel writes are role-gated only.

---

## Part A — The rename

### Heorth

| Before | After |
|---|---|
| `src/modules/inventory/` | `src/modules/ethel/` |
| `inventoryModule` in `ALL_MODULES` | `ethelModule` |
| table `inventory_items` | table `ethel_assets` |
| `/api/v1/inventory/items` | `/api/v1/ethel/assets` |
| `feoh_item_costs.item_id` | `feoh_item_costs.asset_id` |
| `recurring_bills.inventory_item_id` | `recurring_bills.ethel_asset_id` |
| web route `/inventory`, `pages/inventory.tsx` | `/ethel`, `pages/ethel.tsx` |
| `components/inventory/`, `hooks/use-inventory.ts`, `api/inventory.ts` | `components/ethel/`, `hooks/use-ethel.ts`, `api/ethel.ts` |
| i18n `inventory.*` (both locales) | `ethel.*` |
| `QUERY_KEYS.inventory`, `INVENTORY_PAGE_SIZE` | `QUERY_KEYS.ethel`, `ETHEL_PAGE_SIZE` |
| nav label "Inventory" / "Inventar" | "Ethel" / "Ethel" |

The noun changes with the module: an "item" is an **asset**. `ItemForm` →
`AssetForm`, `item-detail.tsx` → `asset-detail.tsx`, `InventoryItem` →
`EthelAsset` in `web/src/lib/types.ts`.

Schema registration follows the existing rule — both
`src/db/schema/drizzle-schema.ts` (no `.js`) and `src/db/schema/index.ts`
(runtime barrel, `.js` imports).

`AGENTS.md`'s "Module rules" section names `src/modules/inventory/` twice and
describes `hasDisposalLink`; both are part of this change, not follow-up
tidying.

### heorth-mcp

Renamed: `inventory.list_items` → `ethel.list_assets`, `inventory.get_item` →
`ethel.get_asset`, `inventory.record_item` → `ethel.record_asset`,
`inventory.decommission_item` → `ethel.decommission_asset`. `src/tools/
inventory.ts` → `src/tools/ethel.ts`; `src/tools/feoh.ts` references the item
tools and follows. ADR 0008's tool-namespace list (`inventory.*`) is corrected
to `ethel.*` in this repo.

### This repo

`CONTEXT.md` (the Ethel entry gains **Asset**, **Place** and **Facility**;
`_Avoid_: inventory` becomes true rather than aspirational), `strategy.md` Phase 4,
`deploy/seed-demo.mjs`, `deploy/README.md`, ADR 0008's tool list, and this
spec's own status when it lands.

### Schema change — no data migration

**Revised 2026-08-24: there is no live data.** Nothing is deployed (ADR 0015
defers Phase 3), so no database holds household rows this change has to carry
across. That removes the largest part of this spec's original risk, and with it a
page of procedure.

One drizzle migration, generated with
`npm run db:generate -- --name ethel-absorbs-inventory`, then the new tables of
Parts B and C. **Whatever drizzle-kit emits is acceptable** — including
`DROP TABLE` + `CREATE TABLE` where a rename was meant. There is nothing to
preserve, so the emitted SQL is not hand-replaced with `ALTER … RENAME`, the
snapshot is not re-synced by hand, and the rule against hand-editing snapshots is
never approached.

Dropped with it, all of which existed only to protect rows that do not exist:

- the preservation test across the migration (row counts, `location` values,
  `feoh` links still resolving);
- the rehearsal on a dump of the household database;
- the rollback plan — a fresh database is the rollback;
- the place backfill (see Part B).

**The one thing to check before generating.** All of this rests on "no live
data". Verify it rather than assume it: a dev or demo database holding rows is
*disposable* and gets recreated from the seed, but a database holding data
someone wants makes this decision wrong, and the deleted procedure above is what
to restore from git history. Count `inventory_items` in every database reachable
from `deploy/` first, and treat a non-zero count outside the dev and demo stacks
as a stop.

---

## Part B — Places

### Table `ethel_places`

| column | type | notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `createdAt` / `updatedAt` | timestamptz | `now()` |
| `name` | text NOT NULL | |
| `kind` | text NOT NULL | CHECK: `building`, `floor`, `room`, `outdoor`, `storage` |
| `parentId` | uuid NULL → `ethel_places.id` | `ON DELETE RESTRICT` |
| `notes` | text NULL | |

Constraints:

- `CHECK (id <> parent_id)` — the one cycle Postgres *can* declare.
- `UNIQUE NULLS NOT DISTINCT (parent_id, lower(name))` — no two siblings share a
  name, and PG18's `NULLS NOT DISTINCT` makes that hold for roots too. Violation
  surfaces as `409 PLACE_NAME_TAKEN`, classified through `pgErrorCode`
  (**never** by reading `e.code`).

**Nesting is conventional, not enforced.** Any kind may contain any kind: a shed
is `outdoor` and holds `storage`. The kinds exist for display, grouping and
future plan scoping — not as a grammar.

Two invariants Postgres cannot express, enforced in the service:

- **No cycles.** On create/update with a `parentId`, walk the new parent's
  ancestors; if the place being moved appears among them, reject
  `400 PLACE_CYCLE`.
- **Depth cap of 6.** Bounds the recursive queries and keeps the UI picker
  usable. Moving a subtree must account for the subtree's own height, not just
  the new parent's depth: `depth(newParent) + height(moved) <= 6`, else
  `400 PLACE_TOO_DEEP`.

### Assets gain

- `placeId` uuid NULL → `ethel_places.id` **`ON DELETE SET NULL`**. Deliberately
  unlike the module's other destructive paths, which refuse: reorganising a
  house means deleting places that are full, and an unplaced asset is a
  recoverable state (ADR 0013).
- `locationNote` — the renamed `location`, now for detail a tree should not
  swallow ("behind the boiler", "top shelf").

### REST `/api/v1/ethel`

All under `requireAuth`; writes under `requireRole('admin','adult')`.

**Assets** — as today, at the new path, plus:

- `GET /assets?status=&category=&q=&placeId=&includeDescendants=&limit=&offset=`
  - `placeId` alone filters to assets directly in that place.
  - `placeId` + `includeDescendants=true` is the tree's payoff — "everything in
    the garage, shelves included". Implemented as a recursive CTE returning
    place ids, then `inArray(assets.placeId, ids)`, so the row shape stays
    drizzle-typed. Bounded by the depth cap.
  - `includeDescendants` without `placeId` is `400 VALIDATION_ERROR`.
  - **`limit` stays capped at 100 and rejects 101 with 400** rather than
    silently clamping. The service clamps defensively *and* the validator
    rejects; the divergence between those two is what let the web page ask for
    200 and 400 on every load (fixed 2026-08-21 in `fix(web): paginate the
    inventory list…`). The cap is now a tested contract, and the web client
    pages against it.
- `GET /assets/:id` returns the asset **with its vehicle detail row inlined**
  when one exists, so the detail view is one request. The list does not inline
  it.
- The asset payload carries `placeId` only — **no denormalised place name.** The
  card currently shows `category · location`; after the change the client
  resolves the name from the flat `GET /places` set it has already loaded for
  the picker. One source of truth for a place's name, and renaming a place
  needs no asset rows rewritten.

**Places:**

- `GET /places` — all rows, flat, each with `parentId`, sorted by name. This
  endpoint is **deliberately unpaginated**: the client needs the whole set to
  assemble a tree, and a household has tens of places, not thousands.
- `POST /places` — create (201). `400 PLACE_CYCLE` / `400 PLACE_TOO_DEEP` /
  `409 PLACE_NAME_TAKEN`.
- `PATCH /places/:id` — rename, re-kind, reparent. Same three errors.
- `DELETE /places/:id` — `409 PLACE_HAS_CHILDREN` when it has child places
  (reparent or delete them first); assets in it are **unassigned**, not blocked.

**Vehicle detail:**

- `PUT /assets/:id/vehicle` — upsert (201 on create, 200 on update). Body:
  `registration?`, `vin?`, `firstRegisteredOn?`, `odometer?`, `odometerReadAt?`,
  `serviceIntervalMonths?`. `404` unknown asset;
  `409 VEHICLE_REGISTRATION_TAKEN` / `409 VEHICLE_VIN_TAKEN`;
  `409 ASSET_DETAIL_CONFLICT` when the asset already carries a facility detail
  (the mirror of the Part C rule).
- `DELETE /assets/:id/vehicle` — drop the detail row, keep the asset.

A vehicle detail row is **not** implied by `category='vehicle'`: category is
free text and always was, so presence of the detail row is the only signal.

### Table `ethel_vehicles`

| column | type | notes |
|---|---|---|
| `assetId` | uuid PK → `ethel_assets.id` | `ON DELETE CASCADE` — the detail row must not outlive its asset |
| `createdAt` / `updatedAt` | timestamptz | |
| `registration` | text NULL | partial UNIQUE where not null |
| `vin` | text NULL | partial UNIQUE where not null |
| `firstRegisteredOn` | date NULL | |
| `odometer` | integer NULL | `CHECK (odometer >= 0)` |
| `odometerReadAt` | date NULL | `CHECK ((odometer IS NULL) = (odometer_read_at IS NULL))` — a mileage with no reading date is not a fact, in the house style of the decommission pair check |
| `serviceIntervalMonths` | integer NULL | `CHECK (service_interval_months > 0)` — **added 2026-08-24**, reversing ADR 0013 §6 |

No `mot_due`, no odometer history (ADR 0013 §6).

**`serviceIntervalMonths` is on both detail tables, and means the same thing in
each:** the interval the manufacturer states, as documentation. A car's service
interval is as much a fact of the car as a boiler's is of the boiler, and the
asymmetry the first cut left behind would have read as arbitrary on the vehicle
screen. The rule from Part C carries over unchanged — **Weorc never reads it as a
trigger**, only as a default the routine form offers, so exactly one interval
stays authoritative. ADR 0013 §6's "no service intervals" is amended, not
ignored: it was cut for scope, and the field costs one column and one CHECK.

### Web

- The page keeps the card grid and the pagination added on 2026-08-21
  (`ETHEL_PAGE_SIZE`, load-more over `meta.total/limit/offset`, server-side
  search) — none of that is redesigned here.
- **Place picker**: a tree select built from the flat `GET /places` response,
  used on the asset form and as a list filter with an "include contents"
  toggle bound to `includeDescendants`.
- **Place management**: create / rename / re-kind / reparent / delete, in a
  dialog reachable from the Ethel page. Delete surfaces
  `PLACE_HAS_CHILDREN` as a plain-language message and warns that assets will
  be unassigned.
- **Vehicle details**: an "Add vehicle details" action on the asset detail,
  editing the six fields; not tied to `category`.
- i18n: the whole `inventory.*` namespace moves to `ethel.*` in **both**
  locales, plus new keys for places, kinds, vehicle fields and the new errors.
  `catalog-parity.test.ts` enforces en/de parity, so both move together.

### heorth-mcp tools

Renamed asset tools as in Part A, plus:

- `ethel.list_places` — the tree as flat rows.
- `ethel.record_place`, `ethel.update_place`, `ethel.delete_place` — full place
  writes, so first-time setup of a house can be done conversationally
  (ADR 0013 §5). Delete reports the unassignment in its result text so the
  caller cannot be surprised by it.
- `ethel.set_vehicle_details` — recording a plate or a mileage by voice is the
  case that justifies it.
- `ethel.list_assets` gains `placeId` and `includeDescendants`.

These are tools in `heorth-mcp` calling Heorth's REST API. **Heorth gains no
in-process MCP tool** — its dependency tree has no MCP SDK and must not.

### No place backfill

The original spec backfilled each distinct `location` string into a place and
pointed its assets at it. **Dropped 2026-08-24: there are no rows to backfill**
(see Part A). `locationNote` starts empty on every asset, the place tree is built
by hand or through the MCP place tools, and the demo seed writes its tree
directly.

Two consequences ADR 0013 accepted therefore never happen: `Driveway` and `Gone`
do not arrive as rooms needing correction by hand, and no decommissioned asset is
unassigned by deleting a place the backfill invented.

### Demo seed

`seed-demo.mjs` builds a real tree, which is where the tree earns its keep:

```
House (building)
  Ground floor (floor) → Kitchen, Utility room, Study (room)
Outside (outdoor)
  Driveway (outdoor), Shed (outdoor), Garage (outdoor) → Garage shelf (storage)
```

The nine existing assets are placed into it; the Ford Focus gets vehicle details
(registration, VIN, first registered, odometer + reading date, and a
`serviceIntervalMonths`, so that field is exercised on both detail tables). The seed keeps
writing content **as a member, never the admin**, and keeps its natural-key
idempotency.

---

## Part C — Facilities

**Added 2026-08-24.** Not to be confused with Phase 4 **slice C**, which is
Weorc's maintenance routine (ADR 0014). This part is *spec* Part C: the
building's own systems.

A **facility** is a building system — heating, water, electrics, PV, ventilation
— which the household maintains but which is not an appliance you carry from one
house to the next. It is modelled as a **detail row on an asset**, exactly as
Part B models a vehicle: the asset carries the shared surface (warranty, purchase
price, manuals, TCO, decommission, the `feoh` links), and the detail row carries
what is only true of a system.

### Table `ethel_facilities`

| column | type | notes |
|---|---|---|
| `assetId` | uuid PK → `ethel_assets.id` | `ON DELETE CASCADE` — the detail row must not outlive its asset |
| `createdAt` / `updatedAt` | timestamptz | `now()` |
| `kind` | text NOT NULL | CHECK: `heating`, `water`, `electrical`, `solar`, `sewage`, `ventilation`, `network`, `other` |
| `commissionedOn` | date NULL | when the system went into service — not the purchase date, which the asset already holds |
| `serviceIntervalMonths` | integer NULL | `CHECK (service_interval_months > 0)` |

### Table `ethel_facility_places`

| column | type | notes |
|---|---|---|
| `facilityId` | uuid → `ethel_facilities.asset_id` | `ON DELETE CASCADE` |
| `placeId` | uuid → `ethel_places.id` | `ON DELETE CASCADE` |

`PRIMARY KEY (facility_id, place_id)`. Both sides cascade because a row here is a
*link*, not data: deleting a place removes what it was served by, and never
deletes the facility. This is deliberately unlike `assets.placeId`, which is
`ON DELETE SET NULL` because an unplaced asset is a recoverable state.

### Three rules that make the model legible

- **`assets.placeId` is where the system stands; the join table is what it
  serves.** The boiler is *in* the utility room and *heats* the kitchen and the
  study. Both facts are wanted and neither substitutes for the other. A facility
  with no served places is normal (the mains water connection serves the
  building as a whole, and nobody needs to enumerate that).
- **`serviceIntervalMonths` is documentation, not a schedule.** ADR 0014 §4
  assigns "the stated service interval" to Ethel as a fact of the thing. **Weorc
  never reads it as a trigger.** Its only behavioural use is as a *default* the
  routine form offers when you create a Weorc routine anchored to this asset.
  Without that rule the household ends up with two intervals that can silently
  disagree, and no way to tell which one is running.
- **An asset has at most one detail row.** Part B makes "the detail row exists"
  the only signal of what kind of thing an asset is — `category` is free text and
  always was. Allowing an asset to be both a vehicle and a facility would destroy
  that signal, so the upsert rejects it: `409 ASSET_DETAIL_CONFLICT`.

### REST additions

- `PUT /assets/:id/facility` — upsert (201 on create, 200 on update). Body:
  `kind`, `commissionedOn?`, `serviceIntervalMonths?`, `servesPlaceIds[]` (may be
  empty; replaces the set wholesale rather than merging, so removing a served
  place is one call). `404` unknown asset; `400 PLACE_NOT_FOUND` when
  `servesPlaceIds` names an id that does not exist, classified through
  `pgErrorCode` (**never** by reading `e.code`); `409 ASSET_DETAIL_CONFLICT` when
  the asset already carries a vehicle detail.
- `DELETE /assets/:id/facility` — drops the detail row and its links, keeps the
  asset. The links go by cascade, not by a second statement.
- `GET /assets/:id` inlines the facility detail with its `servesPlaceIds`, beside
  the vehicle detail from Part B, so the detail view stays one request. **The
  list does not inline it.**
- Two new filters on `GET /assets`, and no more:
  - `hasFacility=true` — the "systems of the house" screen.
  - `servesPlaceId=<uuid>` — "what serves this room". Direct links only; it does
    **not** walk the place tree, because a system serving a floor is a different
    claim from one serving each room on it, and conflating them would make the
    answer untrustworthy.
  - Both respect the tested `limit` cap of 100 and the existing `limit`/`offset`
    paging. Neither combines with `includeDescendants`, which is a `placeId`
    modifier and unrelated.

Writes are `requireRole('admin','adult')` like the rest of the module. No
maintenance-admin quarantine (that guard is a finance-mutation concern).

### Web

- **Asset detail** gains "Add facility details" beside Part B's "Add vehicle
  details". Once either detail row exists the other action is hidden, which is
  the `409` expressed as UI rather than as an error the member has to read.
- **Served places** is a multi-select assembled from the flat `GET /places`
  response the picker already loads — no extra request, one source of truth for a
  place's name.
- **A Facilities filter** on the Ethel page (`hasFacility`), and on a place in the
  place-management tree, "systems serving this place" (`servesPlaceId`).
- i18n: `ethel.facility.*` in **both** locales, kinds and errors included.
  `catalog-parity.test.ts` forces en/de to move together.

### heorth-mcp

- `ethel.set_facility_details` — mirrors `ethel.set_vehicle_details`; recording
  "the boiler was commissioned in 2019 and wants servicing yearly"
  conversationally is the case that justifies it.
- `ethel.list_assets` gains `hasFacility` and `servesPlaceId`.
- **No separate list tool.** Facilities are assets; a second listing surface for
  a filter would be two ways to ask one question.

### Migration

Two new tables in the same generated migration as Part B's, and **no backfill** —
there are no rows at all (Part A), and even if there were, nothing in them
identifies a facility and guessing from `category` free text would manufacture
data.

### Demo seed

The house gains a gas boiler (asset in `Utility room`, facility `kind='heating'`,
`commissionedOn`, `serviceIntervalMonths=12`, serving `Kitchen` and `Study`) and
a PV inverter (asset in `Garage`, facility `kind='solar'`, serving `House`). Both
the place tree and the serves-link are then exercised end to end by the demo
stack, which is the acceptance check. Written as a member, never the admin, and
idempotent on its natural key like the rest of the seed.

---

## Testing

**Heorth, backend:**

- Places: create/list/patch/delete; `PLACE_CYCLE` on direct and indirect cycles;
  `PLACE_TOO_DEEP` on both a deep create and a subtree move that would exceed
  the cap; `PLACE_NAME_TAKEN` for siblings *and* for two roots (the
  `NULLS NOT DISTINCT` case); `PLACE_HAS_CHILDREN` on delete; assets unassigned
  (not deleted, not blocked) when their place is deleted.
- Assets: `placeId` filter; `includeDescendants` returning a whole subtree;
  `includeDescendants` without `placeId` rejected; the `limit` cap boundary and
  `limit`/`offset` paging (already landed 2026-08-21, carried to the new path).
- Vehicles: upsert 201 then 200; unique registration and VIN; the odometer
  pairing CHECK; the `serviceIntervalMonths > 0` CHECK; `ON DELETE CASCADE`
  removing the detail row with its asset; `GET /assets/:id` inlining the detail.
- Facilities: upsert 201 then 200; the `kind` CHECK and the
  `serviceIntervalMonths > 0` CHECK; `ON DELETE CASCADE` removing the detail row
  with its asset; deleting a served place removing the link row but **not** the
  facility; `PLACE_NOT_FOUND` for an unknown id in `servesPlaceIds`;
  `ASSET_DETAIL_CONFLICT` when the asset already has a vehicle detail (and the
  mirror case, a vehicle upsert onto a facility asset); `servesPlaceIds` replacing
  rather than merging the set; `GET /assets/:id` inlining the detail; the
  `hasFacility` and `servesPlaceId` filters under the `limit` cap and paging;
  `servesPlaceId` **not** walking the place tree.
- The `hasDisposalLink` touchpoint against the renamed column, so a future
  rename breaks loudly.
- Every existing inventory test carried over and passing at the new path.

**Heorth, web:** the contract test added on 2026-08-21 — which replays the
page's real requests through `qs()` against the server's own Zod schema —
extends to the new params (`placeId`, `includeDescendants`, `hasFacility`,
`servesPlaceId`) and to the places endpoint. Place-tree assembly and cycle-safe rendering get unit tests.

**heorth-mcp:** tool-registration test for the renamed and new tools; the place
tools against a stubbed REST layer.

**End to end:** the demo stack, from empty database to seeded household, is the
acceptance check — it is the only configuration that exercises every service
together, and it has already caught one bug this class of change can produce.
With no live data and no preservation tests, it now carries **more** of the
verification weight than it did, not less (ADR 0015 §4).

## Rollout

1. **Heorth** — rename, schema change, new tables and endpoints (places,
   vehicles, facilities), web, tests. Minor bump (pre-1.0: minor may break).
2. **heorth-mcp** — tool rename and the new tools. Rebuilt and deployed
   **together with Heorth**; a skew leaves the tools broken, not degraded.
3. **This repo** — ADRs 0013 and 0014 accepted, ADR 0015 (feature work before
   deployment), `strategy.md` Phase 3 and Phase 4, `CONTEXT.md` glossary
   (**Asset**, **Place**, **Facility**), `seed-demo.mjs`, `deploy/README.md`,
   ADR 0008's tool list.

**Weorc's first slice follows this spec, not inside it.** It gets its own
brainstorm and its own spec once places and assets are real, so its routines can
be designed against an anchor that exists.

Each repo is its own commit. Nothing is staged across repos.

## Open risks

- **"No live data" is an assumption, and the simplified Part A rests entirely on
  it.** If a database anywhere holds rows someone wants, a drop-and-create
  migration destroys them silently and there is no rollback, because the rollback
  plan was deleted with the rest of the procedure. The count check in Part A is
  the only guard, and it is a human step. Restoring the deleted procedure from
  git history is the fix if the assumption proves false.
- **Renamed MCP tools break saved prompts.** Accepted in ADR 0013 §2; worth an
  entry in Heorth's changelog rather than only in an ADR.
- **The depth cap is a guess.** Six levels covers building→floor→room→storage
  with two to spare. If a real house needs more, raising it is a validator
  change and a UI change, not a migration.
- **Place kinds are unenforced by design**, so nothing stops a `building` inside
  a `storage`. If that turns out to matter, the fix is a lint-style warning in
  the UI, not a CHECK constraint.
- **`serviceIntervalMonths` is now duplicated across two detail tables.** Both
  columns are identical in type, CHECK and meaning, which is the usual sign a
  field belongs one level up — on `ethel_assets`, where one column would also
  answer "what needs servicing?" in a single query rather than a union of two.
  Kept on the detail rows deliberately: an interval is only meaningful for a thing
  that *has* a service regime, and hanging it on every asset invites it onto the
  sofa. A third detail table wanting it is the signal to promote it — an additive
  column plus two copies, not a redesign.
- **The stated interval and the Weorc schedule can drift.** The spec forbids
  Weorc from reading the field as a trigger and offers it only as a form default,
  which keeps one interval authoritative — but nothing detects that the routine
  says 24 months where the manual says 12. If that bites, the fix is a warning on
  the asset detail, not a constraint across two modules.
- **`servesPlaceId` not walking the tree will surprise someone.** Asking what
  serves the ground floor will not list the boiler that serves each room on it.
  Chosen because the alternative invents claims the household never made; if the
  narrow answer proves useless, widening it is a recursive CTE like Part B's, and
  a new explicit parameter rather than a change of meaning.
