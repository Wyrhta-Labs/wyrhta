# 0013 — Ethel absorbs the Inventory module

**Status:** accepted 2026-08-24

## Context

Two names are in production for one domain, and the glossary already says so.

`CONTEXT.md` defines **Ethel** — the physical property as a domain (OE *ēðel*,
rune ᛟ: immovable wealth, Feoh's counterpart) — as "the building, rooms, assets/
appliances, vehicles, and their upkeep", and lists **"inventory"** under
_Avoid_. `strategy.md` schedules **Ethel v1** for Phase 4. Meanwhile Heorth has
shipped `src/modules/inventory/` since 2026-08-16: one `inventory_items` table,
`/api/v1/inventory/items`, four `inventory.*` MCP tools, a web page, and
feoh-side cost links producing a total cost of ownership per item. Its category
enum already carries `vehicle`.

So the module that exists *is* Ethel's first slice, wearing the name its own
glossary forbids. The 2026-08-16 spec is explicit that it cut "room hierarchy"
and shipped a "lean item model" — the cut was deliberate and correctly scoped
for that release, but it is the same cut Phase 4 exists to undo. Nothing named
`room` or `maintenance` exists in `src/` today (the `maintenance` hits are all
the maintenance-*admin* quarantine), so everything else in Ethel v1 is
greenfield; only the asset register has a table to absorb.

Two observations forced the decision now rather than at the start of Phase 4:

- **`location` is free text doing four unrelated jobs.** In the demo household
  the values are `Kitchen` (a room), `Driveway` (not a room), `Garage shelf` (a
  place inside a place) and, on the decommissioned TV, `Gone` — a *status*
  written into a location field because the schema offered nowhere else to put
  it. A typed model is not a refinement here; the field is carrying data it
  cannot represent.
- **Recurring upkeep is already leaking into `notes`.** The demo's Ford Focus
  carries `notes: 'MOT due each spring.'`, and the boiler `'Serviced annually'`.
  Maintenance Plans are the Phase 4 feature those strings are asking for.

Deferring the rename until after rooms and plans were built was considered and
rejected: it would mean designing `ethel_*` tables that reference
`inventory_items`, and shipping the confusion into three more repos.

## Decision

**Ethel absorbs the Inventory module. One domain, one name, a breaking rename
with no alias window.**

1. **The rename is total.** `src/modules/inventory/` → `src/modules/ethel/`;
   `inventory_items` → `ethel_assets`; `/api/v1/inventory/items` →
   `/api/v1/ethel/assets`; web route `/inventory` → `/ethel` with the i18n
   namespace `inventory.*` → `ethel.*`; the noun **"item" becomes "asset"**
   throughout. The nav label is **"Ethel"**, untranslated in both locales —
   following Feoh, which already shows as "Feoh" in English *and* German.
2. **No deprecation aliases.** Heorth is pre-1.0 and serves one household per
   deployment; a compatibility layer would outlive its usefulness and be the
   thing a later reader has to reason about. The cost is real and accepted: the
   four MCP tools are renamed (`ethel.list_assets`, `ethel.get_asset`,
   `ethel.record_asset`, `ethel.decommission_asset`), which breaks any saved
   agent prompt naming the old ones.
3. **Feoh's dependency direction is unchanged.** Finance still points at the
   asset register and never the reverse (`feoh_item_costs.item_id` →
   `asset_id`, `recurring_bills.inventory_item_id` → `ethel_asset_id`); the one
   sanctioned raw-SQL touchpoint, `hasDisposalLink`, follows the column rename
   and stays a table-level read with no module import.
4. **Places are a tree from the start, not a flat list.** `ethel_places` carries
   a self-referencing `parentId`, because the data already demands it — `Garage
   shelf` is a place inside a place. Nesting is **conventional, not enforced**:
   a shed is `outdoor` and contains `storage`, so a rigid building→floor→room
   ladder would be wrong within a week. Cycle rejection and a depth cap live in
   the service, since Postgres can declare neither.
5. **Places may be written through MCP.** `heorth-mcp` gets place tools
   alongside the asset tools, so first-time setup of a house can be done
   conversationally. Per ADR 0008 these are tools in `heorth-mcp` calling
   Heorth's REST API — **Heorth gains no MCP surface of its own.**
6. **Vehicles are an asset plus a detail row**, `ethel_vehicles(assetId PK →
   ethel_assets.id)`, not a parallel entity and not columns on the asset table.
   One asset table stays the spine, so TCO and both feoh links keep working
   untouched. No `mot_due` column: recurring inspections are Maintenance Plans
   (Phase 4 slice C), and a column here would compete with them.
   **Amended 2026-08-24 — see Amendments (1):** the vehicle row *does* carry
   `serviceIntervalMonths`.
7. **Ethel is durables only.** Consumable stock — pantry and supplies,
   quantities, restock, feeding the shopping list — is the *other* meaning of
   "inventory" and is **not** part of this domain. If it is built, it is its own
   feature with its own name.

The design detail for the first two slices lives in
[`../superpowers/specs/2026-08-22-ethel-v1-assets-and-places-design.md`](../superpowers/specs/2026-08-22-ethel-v1-assets-and-places-design.md).

## Consequences

- **One change, three repos, in order.** Heorth (rename + migration) →
  `heorth-mcp` (tool rename + place tools) → this repo (this ADR,
  `strategy.md`, `CONTEXT.md`, `seed-demo.mjs`, `deploy/README.md`). Because
  `heorth-mcp` is a pure REST client that owns no data, a version skew between
  the two containers is not degraded service — the tools are simply broken until
  both are rebuilt. They ship together.
- **Superseded 2026-08-24 — see Amendments (2).** ~~The riskiest line in the
  whole change is `ALTER TABLE … RENAME TO`.~~ The three consequences below
  describe a data migration that no longer happens.
- **The riskiest line in the whole change is `ALTER TABLE … RENAME TO`.**
  Postgres preserves data, FKs and indexes across a rename, but `db:generate`
  may emit a drop-and-create, and Heorth forbids hand-editing migration
  snapshots. The generated SQL must be read, not trusted, and gated behind a
  test asserting row counts and location values survive — proven against a dump
  of the household database before it runs on the household database.
- **Assets arrive pre-placed, with wrong kinds on day one.** The migration
  creates one place per distinct `location` string as `kind='room'` and links
  the assets, so nothing starts unplaced; `Driveway` and `Gone` therefore begin
  life mislabelled as rooms and get reparented and re-kinded by hand. This was
  chosen over a lossless no-guess migration (place unset, string kept as a note)
  because a household reorganising a dozen places is cheaper than a household
  re-entering a hundred locations, and over a kind-guessing heuristic because a
  guess baked into a migration is indistinguishable later from a decision.
- **Deleting a place unassigns its assets rather than refusing.** `ON DELETE SET
  NULL`, deliberately unlike the module's other destructive paths, which refuse
  (`HAS_FINANCE_LINKS`, `DISPOSAL_LINK_EXISTS`). Reorganising a house means
  deleting places that are full, and an asset with no place is a recoverable
  state; the cost is that the previous location is not recorded anywhere after
  the delete.
- **`Gone` stops being expressible, and that is the point.** The decommission
  trio already records that the TV left the house. After the migration it is a
  place named `Gone` that the household deletes — which, under `SET NULL`,
  simply unassigns the TV.
- **Ethel is now the anchor Phase 4 needs.** Maintenance Plans (slice C) hang off
  assets and places, and service contacts (slice D) hang off plans — so the
  KithLedger integration lands on a domain that already has somewhere to put it,
  rather than on a flat item list.

## Amendments

**1 — `serviceIntervalMonths` on vehicles (2026-08-24).** Decision §6 said no
service intervals on the vehicle row, on the grounds that a column there would
compete with Maintenance Plans. Half of that reasoning survived ADR 0014 and half
did not: the *routine* is Weorc's and must not be duplicated here, but the
manufacturer's **stated** interval is a fact of the thing, which ADR 0014 §4 puts
in Ethel. `ethel_vehicles` and `ethel_facilities` therefore both carry
`serviceIntervalMonths integer NULL CHECK (> 0)`, as documentation only — Weorc
never reads it as a trigger, only as a default the routine form offers. The
`mot_due` refusal stands: a *due date* is a projection, and that is Weorc's.

**2 — No data migration, no place backfill (2026-08-24).** Three consequences
above are struck: the `ALTER TABLE … RENAME` risk, "assets arrive pre-placed with
wrong kinds on day one", and "`Gone` stops being expressible". All three assumed a
live database. Nothing is deployed — ADR 0015 defers Phase 3 behind this work — so
there are no rows to carry across. The rename may be emitted as drop-and-create,
the preservation test and the rehearsal on a dump are dropped, and the place
backfill is dropped with them: the tree is built by hand or through the MCP place
tools, and `Driveway`, `Gone` and the mislabelling they would have caused never
exist. `ON DELETE SET NULL` on `assets.placeId` is unaffected and still stands on
its own reasoning.

**This amendment is only true while no database holds rows anyone wants.** The
deleted procedure is in this repo's git history, and the spec's Part A carries the
count check that must pass before the migration is generated.
