# Ethel v1 — Assets, Places and Vehicles — Design

**Date:** 2026-08-22
**Status:** proposed
**Decision:** [ADR 0013 — Ethel absorbs the Inventory module](../../decisions/0013-ethel-absorbs-the-inventory-module.md)
**Supersedes for the asset register:** Heorth's `docs/superpowers/specs/2026-08-16-feoh-inventory-lifecycle-design.md`, Part 1

## Goal

Turn the shipped Inventory module into the first two slices of **Ethel**, the
physical-property domain (`strategy.md` Phase 4):

- **A — Domain and naming.** The rename, in three repos, with the migration.
- **B — Assets, places and vehicles.** `location` free text becomes a place
  tree; vehicles get a shape; the existing lifecycle/TCO surface is preserved
  intact.

Phase 4's other two slices are **out of this spec** and get their own:
**C — Maintenance Plans** (recurring upkeep projected outward as Tasks through
the existing `TaskProvider` seam) and **D — service contacts** (KithLedger
people attached to plans, gated on ADR 0002 Phase B).

**Update 2026-08-24 (ADR 0014):** slices C and D are **Weorc's**, not Ethel's.
The routine, its completion history and the `TaskProvider` projection live in
`src/modules/weorc/`, anchored to an Ethel asset or place; service contacts hang
off Weorc routines. Nothing in slices A and B changes — this spec stays as
written — but the slice-C spec belongs to Weorc and must not add
`ethel_maintenance_*` tables.

## Scope boundary

**In:** the rename; `ethel_places` as a tree; `assets.placeId` +
`assets.locationNote`; `ethel_vehicles`; the place/vehicle REST surface; the
descendant-aware asset filter; the web page rename plus place management and
vehicle details; the `heorth-mcp` tool rename plus place and vehicle-detail
tools; the data migration; the demo seed.

**Out, deliberately:** Maintenance Plans; service contacts; photos; documents
(the Office module is deferred — documents stay in Library); barcodes; loan
tracking; quantities; Tier-3 costs (energy, allocated shares — unchanged from
the 2026-08-16 cut); odometer history; **consumables and pantry stock**, which
is a different feature that merely shares the English word "inventory"
(ADR 0013 §7).

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

`CONTEXT.md` (the Ethel entry gains **Asset** and **Place**; `_Avoid_:
inventory` becomes true rather than aspirational), `strategy.md` Phase 4,
`deploy/seed-demo.mjs`, `deploy/README.md`, ADR 0008's tool list, and this
spec's own status when it lands.

### Migration

One migration, generated with `npm run db:generate -- --name ethel-absorbs-inventory`.

```sql
ALTER TABLE inventory_items RENAME TO ethel_assets;
ALTER TABLE ethel_assets RENAME COLUMN location TO location_note;
ALTER TABLE feoh_item_costs RENAME COLUMN item_id TO asset_id;
ALTER TABLE recurring_bills RENAME COLUMN inventory_item_id TO ethel_asset_id;
-- constraint hygiene: inventory_reason_check, inventory_decommission_pair_check
ALTER TABLE ethel_assets RENAME CONSTRAINT inventory_reason_check TO ethel_assets_reason_check;
ALTER TABLE ethel_assets RENAME CONSTRAINT inventory_decommission_pair_check TO ethel_assets_decommission_pair_check;
```

Then the new tables (Part B), then the place backfill.

**This is the riskiest part of the change.** `db:generate` may emit
`DROP TABLE` + `CREATE TABLE` for what is semantically a rename, and this repo
forbids hand-editing snapshots. Procedure:

1. Generate, then **read the emitted SQL** before running anything.
2. If it emits drop-and-create, replace the migration body with the `ALTER`
   statements above and re-sync the snapshot through drizzle-kit rather than by
   hand.
3. Gate it behind a test that asserts, across the migration: `ethel_assets` row
   count equals the pre-migration `inventory_items` count; every
   `location_note` equals the old `location`; every `feoh_item_costs` and
   `recurring_bills` link still resolves to its asset. **This assertion belongs
   to the rename step, before the place backfill runs** — the backfill later
   moves those strings into `places.name` and clears `location_note`, so a test
   spanning both steps would contradict itself. The backfill has its own
   assertion: every string that was in `location` is now a place name, and every
   asset that had one has a `placeId`.
4. Rehearse on a **dump of the household database** before running it on the
   household database.

**Rollback** is the inverse renames plus dropping the two new tables; it loses
only the place tree, since no asset data is destroyed at any point.

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

- `PUT /assets/:id/vehicle` — upsert (201 on create, 200 on update).
  `404` unknown asset; `409 VEHICLE_REGISTRATION_TAKEN` /
  `409 VEHICLE_VIN_TAKEN`.
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

No `mot_due`, no service intervals, no odometer history (ADR 0013 §6).

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
  editing the five fields; not tied to `category`.
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

### The place backfill

Runs after the new tables exist:

1. For each distinct non-null `location_note`, create a place with that name and
   `kind='room'`, `parentId` NULL.
2. Set each asset's `placeId` to the place matching its `location_note`.
3. Clear `location_note` where it was consumed, so the string is not duplicated
   in two fields. The value survives as `places.name` — nothing is lost.

Consequences accepted in ADR 0013: `Driveway` and `Gone` arrive as rooms and get
corrected by hand. Deleting the `Gone` place unassigns the decommissioned TV,
which is the right outcome — the decommission trio already records that it left.

The backfill must be **idempotent** (guarded by a lookup on place name), so a
re-run after a partial failure repairs rather than duplicates — the same rule the
demo seed follows.

### Demo seed

`seed-demo.mjs` builds a real tree, which is where the tree earns its keep:

```
House (building)
  Ground floor (floor) → Kitchen, Utility room, Study (room)
Outside (outdoor)
  Driveway (outdoor), Shed (outdoor), Garage (outdoor) → Garage shelf (storage)
```

The nine existing assets are placed into it; the Ford Focus gets vehicle details
(registration, VIN, first registered, odometer + reading date). The seed keeps
writing content **as a member, never the admin**, and keeps its natural-key
idempotency.

---

## Testing

**Heorth, backend:**

- Migration: row counts preserved, `location` → `location_note` values
  preserved, every feoh link still resolves (Part A, step 3).
- Places: create/list/patch/delete; `PLACE_CYCLE` on direct and indirect cycles;
  `PLACE_TOO_DEEP` on both a deep create and a subtree move that would exceed
  the cap; `PLACE_NAME_TAKEN` for siblings *and* for two roots (the
  `NULLS NOT DISTINCT` case); `PLACE_HAS_CHILDREN` on delete; assets unassigned
  (not deleted, not blocked) when their place is deleted.
- Assets: `placeId` filter; `includeDescendants` returning a whole subtree;
  `includeDescendants` without `placeId` rejected; the `limit` cap boundary and
  `limit`/`offset` paging (already landed 2026-08-21, carried to the new path).
- Vehicles: upsert 201 then 200; unique registration and VIN; the odometer
  pairing CHECK; `ON DELETE CASCADE` removing the detail row with its asset;
  `GET /assets/:id` inlining the detail.
- The `hasDisposalLink` touchpoint against the renamed column, so a future
  rename breaks loudly.
- Every existing inventory test carried over and passing at the new path.

**Heorth, web:** the contract test added on 2026-08-21 — which replays the
page's real requests through `qs()` against the server's own Zod schema —
extends to the new params (`placeId`, `includeDescendants`) and to the places
endpoint. Place-tree assembly and cycle-safe rendering get unit tests.

**heorth-mcp:** tool-registration test for the renamed and new tools; the place
tools against a stubbed REST layer.

**End to end:** the demo stack, from empty database to seeded household, is the
acceptance check — it is the only configuration that exercises every service
together, and it has already caught one bug this class of change can produce.

## Rollout

1. **Heorth** — rename, migration, new tables and endpoints, web, tests. Minor
   bump (pre-1.0: minor may break).
2. **heorth-mcp** — tool rename and the new tools. Rebuilt and deployed
   **together with Heorth**; a skew leaves the tools broken, not degraded.
3. **This repo** — ADR 0013 accepted, `strategy.md` Phase 4 rewritten to name
   slices B/C/D, `CONTEXT.md` glossary, `seed-demo.mjs`, `deploy/README.md`,
   ADR 0008's tool list.

Each repo is its own commit. Nothing is staged across repos.

## Open risks

- **The generated rename migration** (Part A) is the one step that can lose
  data. Mitigated by reading the SQL, the preservation test, and a rehearsal on
  a dump — not by trusting drizzle-kit.
- **Renamed MCP tools break saved prompts.** Accepted in ADR 0013 §2; worth an
  entry in Heorth's changelog rather than only in an ADR.
- **The depth cap is a guess.** Six levels covers building→floor→room→storage
  with two to spare. If a real house needs more, raising it is a validator
  change and a UI change, not a migration.
- **Place kinds are unenforced by design**, so nothing stops a `building` inside
  a `storage`. If that turns out to matter, the fix is a lint-style warning in
  the UI, not a CHECK constraint.
