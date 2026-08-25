# Weorc v1 — Routines, Occurrences and the Projection Engine

**Status:** accepted 2026-08-25
**Phase:** 4, slice C (ADR 0014) — the slice ADR 0015 puts ahead of Phase 3 deployment
**Decisions this rests on:**
[ADR 0014](../../decisions/0014-weorc-owns-recurring-household-work.md) (Weorc owns
recurring work; Ethel owns the property),
[ADR 0015](../../decisions/0015-feature-work-resumes-before-deployment.md) (feature
work resumes before deployment),
[ADR 0008](../../decisions/0008-mcp-as-a-standalone-container-over-rest.md) (MCP as a
standalone container over REST),
[ADR 0001](../../decisions/0001-external-systems-of-record-behind-providers.md)
(external systems of record behind providers),
[ADR 0013](../../decisions/0013-ethel-absorbs-the-inventory-module.md) (Ethel absorbs
the inventory module).

## What this is

The first code in `src/modules/weorc/`. It delivers the whole shape of the
domain — a recurring definition, its completion history, and one projection
engine into the task provider — and nothing beyond it.

A **Routine** is a recurring definition with an optional **anchor**: an Ethel
asset, an Ethel place, or nothing. "Service the boiler" and "put the bins out"
are the same kind of row (ADR 0014 §5), and the unanchored case ships in this
slice rather than waiting for Phase 5+. An **Occurrence** is one due instance of
a routine; once terminal it *is* the history row.

Weorc does not become a task system (ADR 0014 §6). The visible instance a member
ticks off is a Task in the provider wherever a provider exists; the occurrence is
definition-side bookkeeping and is never the place you look for today's list.

## Scope boundary

**In:** `weorc_routines` and `weorc_occurrences`; the recurrence arithmetic; the
three-pass tick and its ungated scheduler; `/api/v1/weorc/...`; the write-back to
the task provider; the `weorc.tsx` web page in both locales; the `weorc.*` tools
in `heorth-mcp`; demo seed rows; the two supporting changes named in Part E.

**Out, deliberately:** service contacts (Phase 4 slice D, still gated on ADR 0002
Phase B); Hearth View integration — "what's currently due" stays a Tasks view, so
in the demo stack the chores live on the Weorc page only; per-occurrence
assignment beyond a routine-level `ownerMemberId`; points, allowances and
rotation (ADR 0014 §7); Wyrtgeard bed anchors (a third nullable column, later);
RRULE-grade recurrence; notification or reminder delivery of any kind.

## The constraint that shapes everything

`tasks.createTask` resolves the shared To Do list through a **connected member's
allowlist** and throws `provider_unavailable` when the M365 integration is off.
The demo household — which ADR 0015 §4 makes this slice's acceptance check — has
no M365 and never will. **Therefore no part of Weorc may depend on a provider
being present.** Materialising due work, completing it and keeping its history
are Heorth-native and must work with the seam empty; projection is the one pass
that degrades, and it degrades to "this occurrence is not projected", never to an
error.

---

## Part A — Data model

Schema lives in `src/modules/weorc/schema.ts` and is registered in **both**
`src/db/schema/drizzle-schema.ts` (drizzle-kit; imports without `.js`) and
`src/db/schema/index.ts` (the runtime barrel, whose re-exports carry the `.js`
ESM extension), per the house rule. `AGENTS.md` calls the second one
`index.js` — that is the import specifier, not the filename.

The migration is generated with `npm run db:generate -- --name weorc_v1`;
snapshots are never hand-edited.

Per ADR 0015's corollary, this lands on an empty database and may be a plain
create — no preservation procedure, no rehearsal on a dump.

### `weorc_routines`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | `gen_random_uuid()` |
| `createdAt` / `updatedAt` | timestamptz | house default |
| `name` | text not null | the chore, in the household's words |
| `notes` | text | |
| `mode` | text not null | CHECK in (`from_completion`, `fixed`) |
| `intervalUnit` | text not null | CHECK in (`day`, `week`, `month`) |
| `intervalCount` | integer not null | CHECK `> 0` |
| `anchorDate` | date not null | `fixed`: the grid origin. `from_completion`: the first due date |
| `leadDays` | integer not null default 0 | CHECK `>= 0`; how far ahead the occurrence is materialised and projected |
| `ownerMemberId` | uuid | → `users.id`, ON DELETE SET NULL. A name, not an assignment mechanic |
| `anchorAssetId` | uuid | → `ethel_assets.id`, ON DELETE SET NULL |
| `anchorPlaceId` | uuid | → `ethel_places.id`, ON DELETE SET NULL |
| `active` | boolean not null default true | |

CHECK `weorc_routines_anchor_check`: at most one of `anchorAssetId`,
`anchorPlaceId` is non-null.

**Two real FKs, not a polymorphic `(anchorType, anchorId)` pair.** Wyrtgeard adds
a third nullable column when it arrives. Referential integrity is worth more than
a column count, and the house style already reaches for real FKs
(`ethel_facility_places`).

**ON DELETE SET NULL on the anchor**, matching `ethel_assets.placeId`'s own
precedent: deleting the boiler must not silently delete the record of having
serviced it. The routine survives unanchored, and the page shows it as one
needing a new anchor.

### `weorc_occurrences`

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `createdAt` / `updatedAt` | timestamptz | |
| `routineId` | uuid not null | → `weorc_routines.id`, ON DELETE CASCADE |
| `dueOn` | date not null | a household-local calendar date; chores are day-grained |
| `status` | text not null default `'due'` | CHECK in (`due`, `completed`, `skipped`) |
| `completedAt` | timestamptz | absolute UTC instant (house rule) |
| `completedByMemberId` | uuid | → `users.id`, ON DELETE SET NULL |
| `note` | text | |
| `taskFeedKey` | text | the projected task's feed |
| `taskExternalId` | text | the projected task's id within that feed |
| `projectionError` | text | last classified `TaskProviderError.reason`, or null |

- UNIQUE `(routineId, dueOn)` — materialisation is idempotent; a tick that runs
  twice cannot double-insert.
- UNIQUE `(routineId) WHERE status = 'due'` (partial index) — **at most one open
  occurrence per routine, ever.** This is the structural expression of "Weorc is
  not a task list".
- CHECK `weorc_occurrences_completed_pair_check`:
  `(status = 'completed') = (completedAt IS NOT NULL)`. A `skipped` row carries
  no `completedAt` — it did not happen.
- CHECK `weorc_occurrences_task_pair_check`:
  `(taskFeedKey IS NULL) = (taskExternalId IS NULL)`.
- INDEX on `(status, dueOn)` for the due-work read.

**The projection link is `(feedKey, externalId)`, never `task_mirror.id`.** A
full resync (410 recovery or the periodic one) replaces a feed's mirror rows, so
the uuid is not stable across it; `task_mirror_feed_ext_unique` is. Storing the
uuid would work in every test and rot in the first 410.

### Deleting a routine

`DELETE /routines/:id` refuses with `409 ROUTINE_HAS_HISTORY` when any terminal
occurrence exists — deactivate instead (`PATCH { active: false }`). The cascade
therefore only ever removes the single open occurrence of a routine created by
mistake. This is Ethel's decommission-don't-delete shape, for the same reason:
the history is the thing worth keeping.

---

## Part B — Recurrence arithmetic

A pure module, `src/modules/weorc/recurrence.ts`, with no database access, so the
awkward cases are unit-testable without a Postgres round-trip.

### Which "today", and in whose zone

**`today` is the household's calendar date, not the server's.** It is
`localDateOf(new Date(), await getHouseholdTimeZone())` — `src/lib/local-date.ts`
and `src/household/timezone.ts`, the same pair the M365 task provider already
uses. **Never** `toISOString()` (that is UTC), and **not** `localTodayIso()`
either: that helper is *server*-local, which is only accidentally the household's
zone and is wrong the moment Heorth runs on a UTC host.

Everywhere the spec says "household-local midnight of `dueOn`", the implementation
is `zonedMidnightUtc(dueOn, zone)` from the same module — it is DST-correct,
including the spring-forward day where local midnight does not exist.

A routine's dates are therefore stable under a server move and shift only if the
household itself changes zone, which is the correct behaviour.

### Next due date

Given a routine and its last **terminal** occurrence (completed or skipped):

- **`from_completion`** — the base is the last terminal occurrence's date
  (`completedAt` rendered as a household-local date for `completed`; `dueOn` for
  `skipped`), plus `intervalCount` units. With no terminal occurrence ever, the
  next due date is `anchorDate`.
- **`fixed`** — the next grid slot `anchorDate + k × interval` strictly after the
  last terminal occurrence's `dueOn`; with none ever, `anchorDate` itself. Then
  fast-forward, by exactly this rule:

  ```
  while (slot + interval <= today) slot += interval
  ```

  The loop leaves the latest slot whose *successor* is still in the future — so
  the routine is at most one interval overdue and never accumulates a backlog.
  Worked: weekly, last terminal `dueOn` 2026-08-11, today 2026-08-25. The first
  slot after history is 08-18; `08-18 + 7d = 08-25 <= today`, so it advances to
  08-25; `09-01 > today`, so it stops. One chore, due today — not one on the 18th
  that immediately breeds another on the 25th.

### Month arithmetic

The two modes clamp differently, and conflating them is the easy mistake:

- **`fixed` monthly** slots are always `anchorDate + k months`, each computed
  from the **origin** and clamped into its own month. Origin 31 January gives
  28 February (29 in a leap year) and then 31 March — the grid does not drift
  down to the 28th permanently, because no slot is ever computed from the
  previous slot.
- **`from_completion` monthly** intervals take the terminal date as a **new
  origin** each cycle and therefore *do* drift, by design: completed 28 February
  means next due 28 March. What it recurs from is when you last did it.

### The materialisation horizon

An occurrence row is written only when `dueOn <= today + leadDays`. Beyond that,
nothing is stored and `GET /routines` computes the next date for display. This
keeps the table proportional to work actually in view, and it is what makes
`leadDays` meaningful: a 12-month boiler service with `leadDays: 14` becomes a
real task a fortnight out, which is when you can still book a plumber. Bins stay
at 0.

---

## Part C — The engine

`src/modules/weorc/engine.ts` exports `runWeorcTick()`, returning per-pass
counts. `src/modules/weorc/scheduler.ts` exports `startWeorcScheduler()` /
`stopWeorcScheduler()`, called from `main()` in `src/index.ts` beside
`startM365Scheduler()`.

**The scheduler is guarded on `VITEST` only — never on `isM365Enabled()`.**
Materialising and completing due work is Heorth-native. The timer is `unref`'d
and a tick never rejects, matching the M365 scheduler's shape.

The three passes run in this order — reconcile first, so a completion detected in
this tick yields its successor in the same tick rather than the next one.

### 1. Reconcile

For each `due` occurrence carrying a task link, read `task_mirror` by
`(feedKey, externalId)`:

- mirror row `completed` → complete the occurrence at the mirror's `completedAt`;
- otherwise → leave it.

Reconciliation is a **mirror query, not provider work**. The task sync runner
already writes completions into `task_mirror`; Weorc reads what is there and
never calls Graph to find out.

**An absent mirror row does NOT mean the task was deleted, and must never
trigger a re-projection.** Mirror rows are deleted wholesale for reasons that
have nothing to do with the task: `setAllowlist` drops every row of a
de-allowlisted feed (`tasks/store.ts`), and a full resync deletes and re-inserts
a feed inside one transaction. Treating absence as deletion means a member
un-ticking a To Do list silently spawns a duplicate external task for every
projected occurrence at once.

So: absence leaves the link **and the occurrence** exactly as they are. The
occurrence stays open, is still completable from Weorc's own side, and is simply
no longer tracked against a live mirror row. Re-projection happens only through
the explicit relink in pass 3.

### 2. Materialise

For each active routine with no open occurrence, compute the next `dueOn` per
Part B and insert it when inside the horizon. The partial unique index makes a
concurrent double-tick a no-op rather than a duplicate.

### 3. Project

For each open occurrence with no task link, **when a provider is installed**:

- `title` = the routine's name;
- `notes` = the anchor's name (asset or place), the routine's notes when either
  exists, and — on its own last line — the marker `weorc-occurrence:<occurrence
  uuid>`;
- `dueAt` = `zonedMidnightUtc(dueOn, householdZone)`, matching
  `MirroredTask.dueAt`'s stated semantics;
- the shared feed is resolved **preferring `ownerMemberId`** when the routine
  names one.

**Relink before creating.** Projection first looks for a mirror row whose notes
carry this occurrence's marker; if one exists, it adopts that row's
`(feedKey, externalId)` instead of creating anything. Without this, the window
between "Graph accepted the create" and "Weorc stored the link" is a duplicate
factory: a crash, a restart or a request timeout in that window leaves a real
To Do task with nothing pointing at it, and the next tick makes a second one.
The marker is also what lets a task the household moved between lists be found
again after a full resync.

The marker is deliberately ugly and deliberately in the body: To Do has no custom
metadata field the provider contract exposes, and inventing one would mean a
Graph type crossing into the tasks module, which `AGENTS.md` forbids.

On success, store `(feedKey, externalId)` and clear `projectionError`. On
`TaskProviderError`, store `reason` in `projectionError` and continue to the next
occurrence — one dead connection never stops the pass. **A provider that is
absent is not an error and writes no `projectionError`:** the occurrence is
simply unprojected, which is the demo stack's permanent and correct state.

### Concurrency

The scheduler tick and a REST write can both try to materialise the same
successor. The unique constraints stop a duplicate **row**, but a bare `INSERT`
would still turn the loser into a 500. **Every materialising insert is
`ON CONFLICT DO NOTHING`**, and re-reads the winning row. Any DB error that does
survive is classified through `pgErrorCode` / `isPgError` — never by reading
`e.code`, which is `undefined` on a `DrizzleQueryError`.

### Completing from Weorc's own side

`POST /occurrences/:id/complete` (web, MCP) records the completion locally
**first**, then writes back through the provider when a link exists, then
materialises and projects the successor so the caller sees the new due date in
the same response.

**A provider failure never fails a Weorc write.** The response reports the
outcome — `projection: { ok: false, reason: 'needs_reauth' }` — and the
completion stands. This diverges deliberately from `tasks.completeTask`, which
writes back first and refuses on failure: there the external task *is* the
record, here it is a projection of one. A dead Graph connection must not stop the
household recording that the bins went out.

---

## Part D — REST surface

Mounted at `/api/v1/weorc`. `requireAuth` on all routes;
`canWrite = requireRole('admin','adult')` on writes. **No maintenance-admin
quarantine** — that guard is a finance-mutation concern, the same call Ethel
made. Responses use `ok`/`err` from `@wyrhta/core/http`.

| Route | Behaviour |
|---|---|
| `GET /routines` | Filters `active`, `anchor_asset_id`, `anchor_place_id`, `owner_member_id`, plus `limit` / `offset` as Ethel's list does. Each row carries its computed `nextDueOn` and its open occurrence, so one call feeds the page. `{ data, meta: { total, limit, offset } }`. |
| `POST /routines` | 201. `400 ANCHOR_CONFLICT` (both anchors given), `400 ASSET_NOT_FOUND`, `400 PLACE_NOT_FOUND`, `400 VALIDATION_ERROR`. |
| `GET /routines/:id` | Routine + open occurrence + recent history. `404 NOT_FOUND`. |
| `PATCH /routines/:id` | Includes `active`. Terminal occurrences are never rewritten. Changing `mode`, the interval or `anchorDate` recomputes the open occurrence's `dueOn` in place **only while that occurrence is unprojected**; once it carries a task link the edit applies from the *next* occurrence onward and the open one is left alone (see below). Same four codes plus `404`. |
| `DELETE /routines/:id` | `409 ROUTINE_HAS_HISTORY`, `404 NOT_FOUND`; otherwise cascades the single open occurrence. |
| `GET /occurrences` | Filters `status`, `routine_id`, `due_to`. The due-work read. **`due_to` is how a caller asks for "actually due now" (`due_to=<today>`) as opposed to everything open**, which within a lead window includes work due up to `leadDays` from now. |
| `POST /occurrences/:id/complete` | Body `completedAt?`, `note?`. `409 ALREADY_TERMINAL`, `404 NOT_FOUND`. Returns the completed occurrence, the newly materialised successor (or null, outside the horizon), and the `projection` outcome. |
| `POST /occurrences/:id/skip` | Body `note?`. Same codes. Records that a slot passed **without claiming it was done**, so the history does not lie. |
| `POST /run` | One tick, returning per-pass counts. The deterministic driver for tests and the demo, exactly as `POST /api/v1/m365/sync` is for sync. |

Query keys are snake_case on the wire, as the tasks module's already are.

### Editing a routine that is already projected

An open occurrence carrying a task link has a counterpart in Microsoft To Do,
and the `TaskProvider` contract has **no update method** — only
`createTask`, `setCompleted` and the pull/discovery pair. Recomputing `dueOn`
locally would therefore leave the household looking at a To Do task with the old
date and no indication it had moved.

This slice resolves that by **not editing a projected occurrence at all**: the
change takes effect from the next cycle. The response says so explicitly
(`openOccurrenceUnchanged: true`) so the web page can tell the maker rather than
appearing to ignore the edit. Someone who wants the change now completes or skips
the open occurrence, and the successor is materialised under the new definition.

Adding `updateTask` to the provider contract is the alternative, and it is
deliberately not taken here: it is a new method on a shared interface, a second
Graph write path and a new class of partial-failure, for an edit that is rare on
a routine that recurs. It is the obvious Phase 5+ follow-up if real use disagrees.

---

## Part E — Supporting changes

Two additions to `tasks/service.ts`. Both are in Heorth and belong in the same
commit range. **Nothing moves out of feoh** — `localTodayIso()` stays exactly
where it is, because Weorc does not want a server-local date at all (Part B).

1. **A household-level create** that takes a *preferred* member id rather than an
   acting principal, and skips the maintenance-admin assertion because a 3am
   ticker has no acting principal. `createTask` keeps its current signature and
   delegates to it, so the shared-feed resolution is not duplicated.
2. **A completion helper keyed on `(feedKey, externalId)`.** The existing
   `tasks.completeTask` takes a `task_mirror.id` and looks the row up by uuid —
   which is precisely the identifier Part A refuses to store, because a full
   resync invalidates it. Weorc therefore needs
   `completeProjectedTask(feedKey, externalId, completed)`, which calls the
   provider by the stable key and updates the mirror row **if one is currently
   present**. `completeTask` is left untouched; the two share the provider call.

Without the second one, the write-back in Part C cannot be implemented as
described — it is not a convenience.

### A module rule to write down

Weorc **imports the tasks module's service and reads `task_mirror`.** Ethel's
rule is that it never imports feoh; Weorc's is the opposite by design — ADR 0014
§8 calls it "the domain most entangled with Tasks, Ethel and Hearth View at
once", which is precisely why it is a built-in module and not a satellite.

That asymmetry goes into `Heorth/AGENTS.md` as a module rule **in this slice**,
or the next reader applies Ethel's rule here and is wrong.

---

## Part F — Web page

`Heorth/web/src/pages/weorc.tsx`, beside `ethel.tsx`, following its structure.

- **Due now**, at the top: open occurrences with `dueOn <= today`, each with tick
  and skip. This is the only place the demo household can see a chore at all,
  since there is no provider there.
- **Coming up**, below it: open occurrences with `dueOn > today` — the lead
  window. A boiler service materialised a fortnight early is *not* due today and
  must not be shown as though it were; it is listed so the maker knows a task has
  gone out to To Do.
- **Routines** below: create, edit, deactivate. The anchor picker reads Ethel's
  assets and places.
- **History** per routine: terminal occurrences, newest first.

When the chosen anchor is an asset carrying `serviceIntervalMonths`, the form
**offers it as the default interval** — that is the entire point of ADR 0013
Amendments 1 keeping the field as documentation. It is a default the maker can
overwrite, never a trigger.

Both locales, with page tests in the style of `ethel.test.tsx` and
`ethel.de.test.tsx`. **Weorc** stays untranslated in both, following Feoh and
Ethel; "chore" is the gloss in explanatory copy (ADR 0014 §2).

An unprojected occurrence is shown as due, plainly, with no error styling. A
`projectionError` is surfaced quietly on the routine — it means the household's
To Do connection needs attention, not that the chore is broken.

---

## Part G — `heorth-mcp` tools

A separate repo, a separate commit (ADR 0008; the meta repo's one-change-one-repo
rule). Pure REST client, upstream codes passed through unchanged, **no
re-implemented validation** — the same discipline the `ethel.*` tools follow.

| Tool | REST |
|---|---|
| `weorc.list_routines` | `GET /weorc/routines` |
| `weorc.record_routine` | `POST /weorc/routines` |
| `weorc.update_routine` | `PATCH /weorc/routines/:id` |
| `weorc.delete_routine` | `DELETE /weorc/routines/:id` |
| `weorc.list_due` | `GET /weorc/occurrences?status=due` |
| `weorc.complete_occurrence` | `POST /weorc/occurrences/:id/complete` |
| `weorc.skip_occurrence` | `POST /weorc/occurrences/:id/skip` |

`weorc.complete_occurrence` reports the projection outcome in its result text: a
conversational caller has no other way to learn that the completion was recorded
but the write-back to To Do failed.

`docs/spec/tool-surface.md` is updated in that repo, including the note that
`serviceIntervalMonths` is a form default here and still schedules nothing.

---

## Part H — Demo seed

`deploy/seed-demo.mjs` grows a Weorc block, idempotent like every other block in
that file:

- **Put the bins out** — `fixed`, weekly, anchored to no thing at all, `leadDays: 0`.
- **Service the boiler** — `from_completion`, 12 months, anchored to the seeded
  heating facility asset, `leadDays: 14`.
- **Descale the kettle** — `from_completion`, 2 months, anchored to the kitchen place.
- **Change the bedding** — `fixed`, 2 weeks, unanchored.

Plus a completed occurrence or two, so the history is not empty on first look.

Per ADR 0015 §4 the seeded demo household **is** this slice's acceptance check.
The seed must show the unanchored and anchored cases side by side, because that
one-kind-of-row claim is the whole bet of ADR 0014.

---

## Testing

Backend tests hit a real Postgres and truncate per test; `DATABASE_URL` must name
a database ending in `_test`.

- **`recurrence.ts` pure tests, no database**: month-end clamping, the fixed-grid
  fast-forward, the horizon boundary, `from_completion` with and without history,
  skipped-as-base.
- **Engine tests through the three provider states**, installed via
  `setTaskProvider`: a fake provider that succeeds; **the seam left null**
  (occurrences materialise and complete, nothing is projected, no
  `projectionError` is written); a fake that throws a classified
  `TaskProviderError` (reason recorded, pass continues, next tick retries).
  **No test calls a real external service.**
- **Reconciliation**: a completion appearing in `task_mirror` completes the
  occurrence and materialises the successor in one tick. **And the inverse, which
  is the one that bites**: a vanished mirror row (de-allowlisted feed) changes
  nothing and creates no second task.
- **Projection idempotence**: a mirror row already carrying an occurrence's
  marker is adopted, not duplicated — the crash-window case.
- **The partial unique index**: a double tick inserts one occurrence and neither
  writer errors (`ON CONFLICT DO NOTHING`).
- **Editing a projected routine** leaves the open occurrence's `dueOn` alone and
  says so in the response; editing an unprojected one moves it.
- **Household zone**: with `TZ` set to something other than the household zone,
  `today` and `dueAt` still resolve to the household's day — the test that would
  have caught the `localTodayIso()` mistake.
- **Route tests** for every code in Part D, including `ROUTINE_HAS_HISTORY` and
  `ANCHOR_CONFLICT`.
- **A test that a completion survives a failing provider** — the divergence in
  Part C is the kind of thing a later refactor "corrects" back to writing through
  first, so it is pinned by a test that says why.
- Query failures are classified through `pgErrorCode` / `isPgError`, never by
  reading `e.code`, in src *and* in tests.

## Open risks

- **Which chores a household actually wants projected is a guess.** ADR 0015 says
  so plainly: this is the one domain being built with no real-use evidence, by one
  maker. The mitigation is that a routine is cheap to delete and the recurrence
  model is two integers and an enum — being wrong costs a row, not a migration.
- **Turning M365 on later projects a backlog in one tick.** Every routine that
  has been running unprojected has an open occurrence, and the first tick after
  the integration is enabled creates a task for each. That is bounded by the
  number of routines, not by elapsed time — the one-open-occurrence index is what
  makes it a handful of tasks rather than a year of them — so it is accepted as
  correct rather than throttled.
- **The unprojected state is untested by reality.** Every household that runs this
  before Phase 3 has an empty provider seam, so the *projecting* half of the engine
  ships exercised only by fakes. First bring-up is where it is really tested, and
  the `projectionError` column exists so that failure is legible when it happens.
- **`leadDays` may be the wrong knob.** If real use shows every routine wants the
  same lead, it collapses to a constant; if it shows chores want a time of day, it
  was the wrong shape entirely. It is one integer either way.
