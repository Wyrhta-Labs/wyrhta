# Weorc v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship Weorc's first slice — recurring household routines, their completion history, and one projection engine into the task provider — across Heorth, heorth-mcp and the demo seed.

**Architecture:** A new always-on Heorth module `src/modules/weorc/` with two tables. `weorc_routines` holds the definition (two recurrence modes, a nullable anchor to an Ethel asset or place); `weorc_occurrences` holds at most one open due instance per routine and, once terminal, *is* the history row. A scheduler tick ungated on M365 runs three passes — reconcile completions off `task_mirror`, materialise the next occurrence, project it outward through the existing `TaskProvider` seam. A missing provider is a normal state, not an error.

**Tech Stack:** Node.js 22, TypeScript (ESM, `.js` import specifiers), Hono, Drizzle ORM, PostgreSQL 18, Zod, Vitest. Web: React, TanStack Router, i18next. heorth-mcp: its own TypeScript service, a pure REST client.

**Spec:** [`docs/superpowers/specs/2026-08-25-weorc-first-slice-design.md`](../specs/2026-08-25-weorc-first-slice-design.md) — read it alongside this plan; the plan argues from it.

## Global Constraints

- **Three repos, three commit streams.** `Heorth/`, `heorth-mcp/` and the meta repo are independent git repos; the first two are git-ignored in the meta repo. **Never stage a sibling folder in the meta repo's index.** One change, one repo, one commit. Report commits per repo.
- **Read the target repo's own `AGENTS.md` before touching it** and follow it; its conventions win inside it.
- **Heorth is REST-only (ADR 0008). Never add an in-process MCP tool to Heorth.** `@modelcontextprotocol/sdk` is not in its dependency tree.
- **Schema registration is two places:** `src/db/schema/drizzle-schema.ts` (drizzle-kit; imports carry no `.js`) and `src/db/schema/index.ts` (runtime barrel; re-exports carry `.js`). Generate migrations with `npm run db:generate -- --name <name>`; never hand-edit snapshots.
- **Never classify a query failure by reading `e.code`.** Use `pgErrorCode` / `isPgError` from `@wyrhta/core/db`, in src *and* in tests.
- **Never derive a date from `toISOString()`.** Weorc's "today" is `localDateOf(new Date(), await getHouseholdTimeZone())`; a due instant is `zonedMidnightUtc(dueOn, zone)`. Both from `src/lib/local-date.ts` + `src/household/timezone.ts`. **Do not use `localTodayIso()`** — it is server-local.
- **Store absolute UTC instants.** `completedAt` is `timestamptz`; `dueOn` is a calendar `date`.
- **Tests hit a real Postgres and truncate every table per test**, so `DATABASE_URL` MUST name a database ending in `_test`. Default `postgres://heorth:changeme@localhost:5432/heorth_test`.
- **Never call a real external service from a test.** Install fakes through `setTaskProvider`.
- **The scheduler must never run under tests** — guard on `VITEST`, and drive it explicitly via `POST /api/v1/weorc/run`.
- **Weorc writes are role-gated `requireRole('admin','adult')` with NO maintenance-admin quarantine** — that guard is a finance-mutation concern.
- **Naming:** `Weorc` is a proper name, untranslated in both locales. "Chore" is the plain-English gloss in explanatory copy, never a model name.
- **Git:** GitHub operations go through `gh`. **Never add a Claude/AI co-author trailer to a commit message.**

---

## File Structure

**Heorth (`Heorth/`)**

| File | Responsibility |
|---|---|
| `src/modules/weorc/schema.ts` | The two tables, their CHECKs and indexes |
| `src/modules/weorc/dates.ts` | `householdToday()` / `householdMidnightUtc()` — the household-zone seam |
| `src/modules/weorc/recurrence.ts` | Pure date arithmetic: interval addition, grid slots, next due date. No DB |
| `src/modules/weorc/store.ts` | All Drizzle access for both tables |
| `src/modules/weorc/service.ts` | Routine CRUD + occurrence completion/skip, orchestrating store + engine |
| `src/modules/weorc/engine.ts` | The three passes, projection, relink-by-marker |
| `src/modules/weorc/validators.ts` | Zod schemas for body and query |
| `src/modules/weorc/routes.ts` | The Hono router and error-code mapping |
| `src/modules/weorc/scheduler.ts` | The ungated ticker |
| `src/modules/weorc/index.ts` | `HeorthModule` registration |
| `src/modules/tasks/service.ts` (modify) | Two additions Weorc needs; existing exports untouched |
| `src/modules/tasks/store.ts` (modify) | Two lookups by stable key |

**Heorth web (`Heorth/web/`)**

| File | Responsibility |
|---|---|
| `src/api/weorc.ts` | Typed client for `/weorc/...` |
| `src/api/weorc-query.ts` | Zod mirror of the server's query contract |
| `src/pages/weorc.tsx` | Due now / Coming up / Routines / History |
| `src/components/weorc/routine-form.tsx` | Create and edit a routine |
| `src/components/weorc/occurrence-list.tsx` | Tick and skip |

**heorth-mcp (`heorth-mcp/`)**

| File | Responsibility |
|---|---|
| `src/tools/weorc.ts` | The seven `weorc.*` tools |
| `src/tools/index.ts` (modify) | Register them |
| `docs/spec/tool-surface.md` (modify) | Document them |

**Meta repo**

| File | Responsibility |
|---|---|
| `deploy/seed-demo.mjs` (modify) | Four seeded routines + some history |
| `docs/strategy.md`, `CONTEXT.md`, `docs/IDEAS.md` (modify) | Mark the slice shipped |

---

## Task 1: Schema and migration

**Files:**
- Create: `Heorth/src/modules/weorc/schema.ts`
- Modify: `Heorth/src/db/schema/drizzle-schema.ts`, `Heorth/src/db/schema/index.ts`
- Test: `Heorth/tests/weorc-schema.test.ts`

**Interfaces:**
- Consumes: `ethelAssets`, `ethelPlaces` from `../ethel/schema.js`; `users` from `@wyrhta/core/identity`
- Produces: `weorcRoutines`, `weorcOccurrences`, types `WeorcRoutine`, `WeorcOccurrence`, and the const tuples `ROUTINE_MODES`, `INTERVAL_UNITS`, `OCCURRENCE_STATUSES`

- [ ] **Step 1: Write the failing test**

Create `Heorth/tests/weorc-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { db } from '../src/db/index.js';
import { weorcRoutines, weorcOccurrences } from '../src/modules/weorc/schema.js';
import { ethelAssets, ethelPlaces } from '../src/modules/ethel/schema.js';

async function routine(over: Partial<typeof weorcRoutines.$inferInsert> = {}) {
  const [row] = await db.insert(weorcRoutines).values({
    name: 'Put the bins out', mode: 'fixed', intervalUnit: 'week',
    intervalCount: 1, anchorDate: '2026-09-01', ...over,
  }).returning();
  return row!;
}

describe('weorc_routines schema', () => {
  it('inserts an unanchored routine — the normal case', async () => {
    const r = await routine();
    expect(r.anchorAssetId).toBeNull();
    expect(r.anchorPlaceId).toBeNull();
    expect(r.active).toBe(true);
    expect(r.leadDays).toBe(0);
  });

  it('rejects an unknown mode', async () => {
    await expect(routine({ mode: 'whenever' as never })).rejects.toThrow();
  });

  it('rejects a non-positive interval', async () => {
    await expect(routine({ intervalCount: 0 })).rejects.toThrow();
  });

  it('rejects negative leadDays', async () => {
    await expect(routine({ leadDays: -1 })).rejects.toThrow();
  });

  it('rejects two anchors at once', async () => {
    const [a] = await db.insert(ethelAssets).values({ name: 'Boiler' }).returning();
    const [p] = await db.insert(ethelPlaces).values({ name: 'Utility', kind: 'room' }).returning();
    await expect(routine({ anchorAssetId: a!.id, anchorPlaceId: p!.id })).rejects.toThrow();
  });

  it('keeps the routine when its anchor asset is deleted', async () => {
    const [a] = await db.insert(ethelAssets).values({ name: 'Kettle' }).returning();
    const r = await routine({ anchorAssetId: a!.id });
    await db.delete(ethelAssets);
    const [after] = await db.select().from(weorcRoutines);
    expect(after!.id).toBe(r.id);
    expect(after!.anchorAssetId).toBeNull();
  });
});

describe('weorc_occurrences schema', () => {
  it('allows only ONE open occurrence per routine', async () => {
    const r = await routine();
    await db.insert(weorcOccurrences).values({ routineId: r.id, dueOn: '2026-09-01' });
    await expect(
      db.insert(weorcOccurrences).values({ routineId: r.id, dueOn: '2026-09-08' }),
    ).rejects.toThrow();
  });

  it('allows many TERMINAL occurrences per routine', async () => {
    const r = await routine();
    await db.insert(weorcOccurrences).values({
      routineId: r.id, dueOn: '2026-09-01', status: 'completed', completedAt: new Date(),
    });
    await db.insert(weorcOccurrences).values({ routineId: r.id, dueOn: '2026-09-08', status: 'skipped' });
    const rows = await db.select().from(weorcOccurrences);
    expect(rows).toHaveLength(2);
  });

  it('rejects the same dueOn twice for one routine', async () => {
    const r = await routine();
    await db.insert(weorcOccurrences).values({ routineId: r.id, dueOn: '2026-09-01', status: 'skipped' });
    await expect(
      db.insert(weorcOccurrences).values({ routineId: r.id, dueOn: '2026-09-01', status: 'skipped' }),
    ).rejects.toThrow();
  });

  it('rejects completed without completedAt, and skipped WITH it', async () => {
    const r = await routine();
    await expect(
      db.insert(weorcOccurrences).values({ routineId: r.id, dueOn: '2026-10-01', status: 'completed' }),
    ).rejects.toThrow();
    await expect(
      db.insert(weorcOccurrences).values({
        routineId: r.id, dueOn: '2026-10-02', status: 'skipped', completedAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('rejects half a task link', async () => {
    const r = await routine();
    await expect(
      db.insert(weorcOccurrences).values({ routineId: r.id, dueOn: '2026-11-01', taskFeedKey: 'todo:member:x:y' }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd Heorth
export DATABASE_URL=postgres://heorth:changeme@localhost:5432/heorth_test
npx vitest run tests/weorc-schema.test.ts
```

Expected: FAIL — `Cannot find module '../src/modules/weorc/schema.js'`.

- [ ] **Step 3: Write the schema**

Create `Heorth/src/modules/weorc/schema.ts`:

```ts
import { pgTable, text, uuid, timestamp, date, integer, boolean, check, index, unique, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '@wyrhta/core/identity';
import { ethelAssets, ethelPlaces } from '../ethel/schema.js';

export const ROUTINE_MODES = ['from_completion', 'fixed'] as const;
export const INTERVAL_UNITS = ['day', 'week', 'month'] as const;
export const OCCURRENCE_STATUSES = ['due', 'completed', 'skipped'] as const;

export type RoutineMode = (typeof ROUTINE_MODES)[number];
export type IntervalUnit = (typeof INTERVAL_UNITS)[number];
export type OccurrenceStatus = (typeof OCCURRENCE_STATUSES)[number];

/** One recurring definition (ADR 0014). The anchor is NULLABLE and unanchored
 *  is the normal case: "put the bins out" and "service the boiler" are the same
 *  kind of row. Two real FKs rather than a polymorphic pair — Wyrtgeard adds a
 *  third column later, and referential integrity is worth more than a column. */
export const weorcRoutines = pgTable('weorc_routines', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  name: text('name').notNull(),
  notes: text('notes'),
  mode: text('mode').notNull(),
  intervalUnit: text('interval_unit').notNull(),
  intervalCount: integer('interval_count').notNull(),
  // `fixed`: the grid origin. `from_completion`: the first due date.
  anchorDate: date('anchor_date').notNull(),
  // How far ahead an occurrence is materialised and projected. A yearly boiler
  // service that reaches To Do on the morning it is due is useless.
  leadDays: integer('lead_days').notNull().default(0),
  // A name, never an assignment mechanic (ADR 0014 §7).
  ownerMemberId: uuid('owner_member_id').references(() => users.id, { onDelete: 'set null' }),
  // SET NULL, like ethel_assets.placeId: deleting the boiler must not delete
  // the record of having serviced it.
  anchorAssetId: uuid('anchor_asset_id').references(() => ethelAssets.id, { onDelete: 'set null' }),
  anchorPlaceId: uuid('anchor_place_id').references(() => ethelPlaces.id, { onDelete: 'set null' }),
  active: boolean('active').notNull().default(true),
}, (t) => [
  check('weorc_routines_mode_check', sql`${t.mode} IN ('from_completion', 'fixed')`),
  check('weorc_routines_unit_check', sql`${t.intervalUnit} IN ('day', 'week', 'month')`),
  check('weorc_routines_count_check', sql`${t.intervalCount} > 0`),
  check('weorc_routines_lead_check', sql`${t.leadDays} >= 0`),
  check('weorc_routines_anchor_check', sql`${t.anchorAssetId} IS NULL OR ${t.anchorPlaceId} IS NULL`),
  index('weorc_routines_active_idx').on(t.active),
  index('weorc_routines_anchor_asset_idx').on(t.anchorAssetId),
  index('weorc_routines_anchor_place_idx').on(t.anchorPlaceId),
]);

/** One due instance. Once terminal it IS the history row — same table, different
 *  status. The task link is (feedKey, externalId), NEVER task_mirror.id: a full
 *  resync deletes and re-inserts a feed's mirror rows, so the uuid is not stable
 *  across a 410 recovery. */
export const weorcOccurrences = pgTable('weorc_occurrences', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  routineId: uuid('routine_id').notNull().references(() => weorcRoutines.id, { onDelete: 'cascade' }),
  dueOn: date('due_on').notNull(),
  status: text('status').notNull().default('due'),
  completedAt: timestamp('completed_at', { withTimezone: true }),
  completedByMemberId: uuid('completed_by_member_id').references(() => users.id, { onDelete: 'set null' }),
  note: text('note'),
  taskFeedKey: text('task_feed_key'),
  taskExternalId: text('task_external_id'),
  projectionError: text('projection_error'),
}, (t) => [
  check('weorc_occurrences_status_check', sql`${t.status} IN ('due', 'completed', 'skipped')`),
  check('weorc_occurrences_completed_pair_check', sql`(${t.status} = 'completed') = (${t.completedAt} IS NOT NULL)`),
  check('weorc_occurrences_task_pair_check', sql`(${t.taskFeedKey} IS NULL) = (${t.taskExternalId} IS NULL)`),
  unique('weorc_occurrences_routine_due_unique').on(t.routineId, t.dueOn),
  // At most one OPEN occurrence per routine, ever — the structural expression
  // of "Weorc is not a task list" (ADR 0014 §6).
  uniqueIndex('weorc_occurrences_one_open_idx').on(t.routineId).where(sql`${t.status} = 'due'`),
  index('weorc_occurrences_status_due_idx').on(t.status, t.dueOn),
]);

export type WeorcRoutine = typeof weorcRoutines.$inferSelect;
export type NewWeorcRoutine = typeof weorcRoutines.$inferInsert;
export type WeorcOccurrence = typeof weorcOccurrences.$inferSelect;
```

- [ ] **Step 4: Register the schema in both places**

In `Heorth/src/db/schema/drizzle-schema.ts` add (matching the file's existing style, **no** `.js`):

```ts
export * from '../../modules/weorc/schema';
```

In `Heorth/src/db/schema/index.ts` add (**with** `.js`):

```ts
export * from '../../modules/weorc/schema.js';
```

- [ ] **Step 5: Generate the migration**

```bash
cd Heorth
npm run db:generate -- --name weorc_v1
```

Open the generated SQL and confirm it contains `CREATE TABLE "weorc_routines"`, `CREATE TABLE "weorc_occurrences"`, the six CHECK constraints, and the partial `CREATE UNIQUE INDEX ... WHERE "status" = 'due'`. **Do not edit the snapshot JSON.** If the partial index is missing from the emitted SQL, append it as a raw statement to the migration file (the precedent is `ethel_places_parent_name_unique`).

- [ ] **Step 6: Run the tests and watch them pass**

```bash
npx vitest run tests/weorc-schema.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 7: Commit**

```bash
cd Heorth
git add src/modules/weorc/schema.ts src/db/schema/ src/db/migrations/ tests/weorc-schema.test.ts
git commit -m "feat(weorc): the two tables

weorc_routines with a nullable anchor - unanchored is the normal case
(ADR 0014 §5) - and weorc_occurrences, where a terminal row IS the history
row. The partial unique index enforces at most one open occurrence per
routine, which is what keeps Weorc from becoming a task list."
```

---

## Task 2: Recurrence arithmetic (pure)

**Files:**
- Create: `Heorth/src/modules/weorc/recurrence.ts`, `Heorth/src/modules/weorc/dates.ts`
- Test: `Heorth/tests/weorc-recurrence.test.ts`

**Interfaces:**
- Consumes: `localDateOf`, `zonedMidnightUtc` from `../../lib/local-date.js`; `getHouseholdTimeZone` from `../../household/timezone.js`; the types from Task 1
- Produces:
  - `addInterval(date: string, unit: IntervalUnit, count: number): string`
  - `nextDueOn(spec: RecurrenceSpec, lastTerminalDate: string | null, today: string): string`
  - `RecurrenceSpec = { mode, intervalUnit, intervalCount, anchorDate }`
  - `householdToday(): Promise<string>`, `householdMidnightUtc(dueOn: string): Promise<Date>`
  - `addDays(date: string, days: number): string`

- [ ] **Step 1: Write the failing test**

Create `Heorth/tests/weorc-recurrence.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { addInterval, addDays, nextDueOn, type RecurrenceSpec } from '../src/modules/weorc/recurrence.js';

const fixed = (over: Partial<RecurrenceSpec> = {}): RecurrenceSpec => ({
  mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: '2026-09-01', ...over,
});
const fromCompletion = (over: Partial<RecurrenceSpec> = {}): RecurrenceSpec => ({
  mode: 'from_completion', intervalUnit: 'month', intervalCount: 12, anchorDate: '2026-09-01', ...over,
});

describe('addInterval', () => {
  it('adds days and weeks', () => {
    expect(addInterval('2026-09-01', 'day', 3)).toBe('2026-09-04');
    expect(addInterval('2026-09-01', 'week', 2)).toBe('2026-09-15');
  });

  it('crosses a year boundary', () => {
    expect(addInterval('2026-12-30', 'day', 3)).toBe('2027-01-02');
  });

  it('clamps a month addition into the shorter target month', () => {
    expect(addInterval('2026-01-31', 'month', 1)).toBe('2026-02-28');
    expect(addInterval('2028-01-31', 'month', 1)).toBe('2028-02-29');
    expect(addInterval('2026-08-31', 'month', 1)).toBe('2026-09-30');
  });
});

describe('addDays', () => {
  it('is DST-proof — pure calendar arithmetic', () => {
    // 2026-03-29 is the European spring-forward. A naive +24h would land on the
    // 29th twice or skip it; calendar arithmetic just counts days.
    expect(addDays('2026-03-28', 1)).toBe('2026-03-29');
    expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
  });
});

describe('nextDueOn — from_completion', () => {
  it('uses anchorDate when nothing has ever been done', () => {
    expect(nextDueOn(fromCompletion(), null, '2026-09-20')).toBe('2026-09-01');
  });

  it('recurs from the last terminal date, not from a grid', () => {
    expect(nextDueOn(fromCompletion(), '2026-09-15', '2026-09-20')).toBe('2027-09-15');
  });

  it('DRIFTS deliberately: the completion becomes the new origin', () => {
    const monthly = fromCompletion({ intervalCount: 1 });
    expect(nextDueOn(monthly, '2026-01-31', '2026-02-01')).toBe('2026-02-28');
    // and from there it stays on the 28th — it recurs from when you last did it
    expect(nextDueOn(monthly, '2026-02-28', '2026-03-01')).toBe('2026-03-28');
  });

  it('does NOT fast-forward — a long-neglected routine stays one item overdue', () => {
    expect(nextDueOn(fromCompletion(), '2020-01-01', '2026-09-20')).toBe('2021-01-01');
  });
});

describe('nextDueOn — fixed grid', () => {
  it('uses anchorDate when nothing has ever been done', () => {
    expect(nextDueOn(fixed(), null, '2026-09-01')).toBe('2026-09-01');
  });

  it('takes the next slot after the last terminal occurrence', () => {
    expect(nextDueOn(fixed(), '2026-09-01', '2026-09-02')).toBe('2026-09-08');
  });

  it('fast-forwards over a gap instead of building a backlog', () => {
    // Away three weeks: last done 08-11 (a Tuesday grid), today 08-25.
    // Slots are 08-18 and 08-25; the rule leaves the latest whose SUCCESSOR is
    // still future, i.e. 08-25 — one chore today, not one on the 18th that
    // immediately breeds another.
    const weekly = fixed({ anchorDate: '2026-08-04' });
    expect(nextDueOn(weekly, '2026-08-11', '2026-08-25')).toBe('2026-08-25');
  });

  it('leaves exactly one overdue item after a long absence', () => {
    const weekly = fixed({ anchorDate: '2026-08-04' });
    expect(nextDueOn(weekly, '2026-08-11', '2026-10-01')).toBe('2026-09-29');
  });

  it('does NOT drift on month-end: every slot is computed from the origin', () => {
    const monthly = fixed({ intervalUnit: 'month', intervalCount: 1, anchorDate: '2026-01-31' });
    expect(nextDueOn(monthly, '2026-01-31', '2026-02-01')).toBe('2026-02-28');
    // the crux: the NEXT one returns to the 31st, because it is anchor + 2
    // months, not (clamped February) + 1 month
    expect(nextDueOn(monthly, '2026-02-28', '2026-03-01')).toBe('2026-03-31');
  });

  it('never returns a slot on or before the last terminal occurrence', () => {
    const weekly = fixed({ anchorDate: '2026-08-04' });
    expect(nextDueOn(weekly, '2026-08-25', '2026-08-25') > '2026-08-25').toBe(true);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd Heorth
npx vitest run tests/weorc-recurrence.test.ts
```

Expected: FAIL — `Cannot find module '../src/modules/weorc/recurrence.js'`.

- [ ] **Step 3: Write the pure module**

Create `Heorth/src/modules/weorc/recurrence.ts`:

```ts
import type { IntervalUnit, RoutineMode } from './schema.js';

/**
 * Pure calendar arithmetic for Weorc routines. No database, no clock, no
 * timezone: every function takes and returns `YYYY-MM-DD` strings, so the
 * awkward cases (month-end clamping, the fixed-grid fast-forward) are testable
 * without a Postgres round-trip or a frozen clock.
 *
 * "Today" is supplied by the caller and comes from the HOUSEHOLD's zone — see
 * dates.ts. Nothing here reads `new Date()`.
 */

export interface RecurrenceSpec {
  mode: RoutineMode;
  intervalUnit: IntervalUnit;
  intervalCount: number;
  anchorDate: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parse(date: string): { y: number; m: number; d: number } {
  if (!DATE_RE.test(date)) throw new Error(`weorc/recurrence: malformed date (want YYYY-MM-DD): ${date}`);
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return { y, m, d };
}

function fmt(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** Add whole days. Pure calendar arithmetic via UTC — never a local-time
 *  `Date`, whose DST transitions would make a "+1 day" step 23 or 25 hours. */
export function addDays(date: string, days: number): string {
  const { y, m, d } = parse(date);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + days);
  return fmt(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}

/** Add whole months, CLAMPING into the target month: 31 Jan + 1 month is
 *  28 Feb (29 in a leap year). Callers that must not drift compute every step
 *  from a fixed origin rather than from the previous result. */
export function addMonths(date: string, months: number): string {
  const { y, m, d } = parse(date);
  const total = (y * 12) + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return fmt(ny, nm, Math.min(d, daysInMonth(ny, nm)));
}

export function addInterval(date: string, unit: IntervalUnit, count: number): string {
  switch (unit) {
    case 'day': return addDays(date, count);
    case 'week': return addDays(date, count * 7);
    case 'month': return addMonths(date, count);
  }
}

/** The k-th grid slot, ALWAYS computed from the origin so month-end clamping
 *  cannot accumulate: 31 Jan yields 28 Feb then 31 Mar, not 28 Mar. */
function slotAt(spec: RecurrenceSpec, k: number): string {
  return addInterval(spec.anchorDate, spec.intervalUnit, spec.intervalCount * k);
}

/** A cheap starting guess for k, corrected by the loop in `nextDueOn`. Only an
 *  estimate — correctness comes from the correction, not from this. */
function estimateK(spec: RecurrenceSpec, target: string): number {
  const a = parse(spec.anchorDate);
  const t = parse(target);
  if (spec.intervalUnit === 'month') {
    const months = ((t.y - a.y) * 12) + (t.m - a.m);
    return Math.floor(months / spec.intervalCount);
  }
  const perStep = spec.intervalUnit === 'week' ? 7 * spec.intervalCount : spec.intervalCount;
  const days = Math.round(
    (Date.UTC(t.y, t.m - 1, t.d) - Date.UTC(a.y, a.m - 1, a.d)) / 86_400_000,
  );
  return Math.floor(days / perStep);
}

/**
 * The next date this routine is due.
 *
 * `from_completion` recurs from when you last did it and therefore drifts, by
 * design. `fixed` recurs on a grid pinned to `anchorDate` and does not drift —
 * but fast-forwards over a gap so a fortnight away yields ONE overdue chore,
 * never a backlog (spec Part B).
 *
 * `lastTerminalDate` is the last completed or skipped occurrence's date
 * (a completion's household-local date; a skip's `dueOn`), or null if the
 * routine has never run.
 */
export function nextDueOn(
  spec: RecurrenceSpec, lastTerminalDate: string | null, today: string,
): string {
  if (spec.mode === 'from_completion') {
    if (lastTerminalDate === null) return spec.anchorDate;
    return addInterval(lastTerminalDate, spec.intervalUnit, spec.intervalCount);
  }

  // fixed: the first slot strictly after history (or the origin itself).
  if (lastTerminalDate === null && spec.anchorDate >= today) return spec.anchorDate;
  const after = lastTerminalDate ?? addDays(spec.anchorDate, -1);

  let k = Math.max(0, estimateK(spec, after));
  // Correct the estimate in both directions — a handful of steps at most.
  while (k > 0 && slotAt(spec, k - 1) > after) k -= 1;
  while (slotAt(spec, k) <= after) k += 1;

  // Fast-forward: leave the latest slot whose SUCCESSOR is still in the future.
  while (slotAt(spec, k + 1) <= today) k += 1;

  return slotAt(spec, k);
}
```

Create `Heorth/src/modules/weorc/dates.ts`:

```ts
import { localDateOf, zonedMidnightUtc } from '../../lib/local-date.js';
import { getHouseholdTimeZone } from '../../household/timezone.js';

/**
 * Weorc's only clock. Chores are day-grained and the day that matters is the
 * HOUSEHOLD's, not the server's — Heorth may run on a UTC host while the
 * household lives in Europe/Berlin, and every date boundary would then be a day
 * out for half the evening.
 *
 * Deliberately NOT `localTodayIso()` (src/modules/feoh/dates.ts): that helper is
 * server-local, which is only accidentally the household's zone.
 */

/** Today's calendar date as the household reckons it (`YYYY-MM-DD`). */
export async function householdToday(): Promise<string> {
  return localDateOf(new Date(), await getHouseholdTimeZone());
}

/** The UTC instant of household-local midnight of `dueOn` — DST-correct,
 *  matching `MirroredTask.dueAt`'s stated semantics. */
export async function householdMidnightUtc(dueOn: string): Promise<Date> {
  return zonedMidnightUtc(dueOn, await getHouseholdTimeZone());
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npx vitest run tests/weorc-recurrence.test.ts
```

Expected: PASS, 14 tests. If `fast-forwards over a gap` fails, the bug is the
correction loop, not the fast-forward — check `slotAt(spec, k) <= after`.

- [ ] **Step 5: Add a household-zone test**

Append to `Heorth/tests/weorc-recurrence.test.ts`:

```ts
import { db } from '../src/db/index.js';
import { householdToday, householdMidnightUtc } from '../src/modules/weorc/dates.js';
import { householdCore } from '../src/wiring.js';

describe('household zone, not server zone', () => {
  it('resolves midnight in the household zone', async () => {
    await householdCore.seedHousehold({ name: 'Test Household' });
    await db.execute(sqlSetZone);
    const instant = await householdMidnightUtc('2026-07-01');
    // Europe/Berlin is UTC+2 in July, so local midnight is 22:00 UTC the day before.
    expect(instant.toISOString()).toBe('2026-06-30T22:00:00.000Z');
    expect(await householdToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
```

with, at the top of the file:

```ts
import { sql } from 'drizzle-orm';
const sqlSetZone = sql`UPDATE households SET timezone = 'Europe/Berlin'`;
```

Run it. If the households table or column is named differently, read
`src/household/service.ts` and use the real name — do not invent one.

- [ ] **Step 6: Commit**

```bash
cd Heorth
git add src/modules/weorc/recurrence.ts src/modules/weorc/dates.ts tests/weorc-recurrence.test.ts
git commit -m "feat(weorc): recurrence arithmetic and the household clock

Two modes: from_completion recurs from when you last did it and drifts by
design; fixed recurs on a grid pinned to the anchor date, computing every slot
from the origin so month-end clamping cannot accumulate, and fast-forwards over
a gap so three weeks away leaves ONE overdue chore rather than three.

Dates come from the household's zone via lib/local-date, never localTodayIso -
that one is server-local."
```

---

## Task 3: The store

**Files:**
- Create: `Heorth/src/modules/weorc/store.ts`
- Test: `Heorth/tests/weorc-store.test.ts`

**Interfaces:**
- Consumes: Task 1's tables
- Produces:
  - `listRoutines(q): Promise<{ rows: WeorcRoutine[]; total: number; limit: number; offset: number }>`
  - `getRoutine(id): Promise<WeorcRoutine | null>`
  - `createRoutine(input: NewWeorcRoutine): Promise<WeorcRoutine>`
  - `updateRoutine(id, patch): Promise<WeorcRoutine | null>`
  - `deleteRoutine(id): Promise<boolean>`
  - `hasTerminalOccurrence(routineId): Promise<boolean>`
  - `getOpenOccurrence(routineId): Promise<WeorcOccurrence | null>`
  - `lastTerminalOccurrence(routineId): Promise<WeorcOccurrence | null>`
  - `insertOccurrence(routineId, dueOn): Promise<WeorcOccurrence>`
  - `getOccurrence(id): Promise<WeorcOccurrence | null>`
  - `listOccurrences(q): Promise<WeorcOccurrence[]>`
  - `terminateOccurrence(id, status, completedAt, memberId, note): Promise<WeorcOccurrence | null>`
  - `setProjection(id, feedKey, externalId): Promise<void>`
  - `setProjectionError(id, reason: string | null): Promise<void>`
  - `activeRoutinesWithoutOpenOccurrence(): Promise<WeorcRoutine[]>`
  - `openOccurrencesWithLink(): Promise<WeorcOccurrence[]>`
  - `openOccurrencesWithoutLink(): Promise<WeorcOccurrence[]>`

- [ ] **Step 1: Write the failing test**

Create `Heorth/tests/weorc-store.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as store from '../src/modules/weorc/store.js';

async function aRoutine(over = {}) {
  return store.createRoutine({
    name: 'Bins', mode: 'fixed', intervalUnit: 'week',
    intervalCount: 1, anchorDate: '2026-09-01', ...over,
  });
}

describe('weorc store', () => {
  it('inserting the same due date twice yields ONE row and does not throw', async () => {
    const r = await aRoutine();
    const first = await store.insertOccurrence(r.id, '2026-09-01');
    const second = await store.insertOccurrence(r.id, '2026-09-01');
    expect(second.id).toBe(first.id);
    expect(await store.listOccurrences({ routineId: r.id })).toHaveLength(1);
  });

  it('a second OPEN occurrence at a different date also does not throw', async () => {
    const r = await aRoutine();
    const first = await store.insertOccurrence(r.id, '2026-09-01');
    const second = await store.insertOccurrence(r.id, '2026-09-08');
    // The partial unique index refuses it; the store swallows the conflict and
    // returns the occurrence that IS open, so a racing tick is a no-op.
    expect(second.id).toBe(first.id);
  });

  it('finds active routines with no open occurrence', async () => {
    const a = await aRoutine({ name: 'Open' });
    const b = await aRoutine({ name: 'None' });
    await aRoutine({ name: 'Inactive', active: false });
    await store.insertOccurrence(a.id, '2026-09-01');
    const rows = await store.activeRoutinesWithoutOpenOccurrence();
    expect(rows.map((r) => r.name)).toEqual(['None']);
    expect(b.name).toBe('None');
  });

  it('terminating an occurrence records who and when', async () => {
    const r = await aRoutine();
    const occ = await store.insertOccurrence(r.id, '2026-09-01');
    const at = new Date('2026-09-01T09:00:00Z');
    const done = await store.terminateOccurrence(occ.id, 'completed', at, null, 'took two bags');
    expect(done!.status).toBe('completed');
    expect(done!.completedAt!.toISOString()).toBe(at.toISOString());
    expect(done!.note).toBe('took two bags');
    expect(await store.hasTerminalOccurrence(r.id)).toBe(true);
  });

  it('skipping records no completedAt', async () => {
    const r = await aRoutine();
    const occ = await store.insertOccurrence(r.id, '2026-09-01');
    const skipped = await store.terminateOccurrence(occ.id, 'skipped', null, null, 'away');
    expect(skipped!.status).toBe('skipped');
    expect(skipped!.completedAt).toBeNull();
  });

  it('lastTerminalOccurrence returns the newest by dueOn', async () => {
    const r = await aRoutine();
    const one = await store.insertOccurrence(r.id, '2026-09-01');
    await store.terminateOccurrence(one.id, 'skipped', null, null, null);
    const two = await store.insertOccurrence(r.id, '2026-09-08');
    await store.terminateOccurrence(two.id, 'skipped', null, null, null);
    expect((await store.lastTerminalOccurrence(r.id))!.dueOn).toBe('2026-09-08');
  });

  it('refuses nothing at the store layer — delete is a plain delete', async () => {
    const r = await aRoutine();
    expect(await store.deleteRoutine(r.id)).toBe(true);
    expect(await store.getRoutine(r.id)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd Heorth
npx vitest run tests/weorc-store.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the store**

Create `Heorth/src/modules/weorc/store.ts`:

```ts
import { and, asc, desc, eq, isNull, isNotNull, lte, sql, count } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  weorcRoutines, weorcOccurrences,
  type WeorcRoutine, type NewWeorcRoutine, type WeorcOccurrence, type OccurrenceStatus,
} from './schema.js';

export interface ListRoutinesQuery {
  active?: boolean;
  anchorAssetId?: string;
  anchorPlaceId?: string;
  ownerMemberId?: string;
  limit?: number;
  offset?: number;
}

export async function listRoutines(q: ListRoutinesQuery = {}): Promise<{
  rows: WeorcRoutine[]; total: number; limit: number; offset: number;
}> {
  const conditions = [];
  if (q.active !== undefined) conditions.push(eq(weorcRoutines.active, q.active));
  if (q.anchorAssetId) conditions.push(eq(weorcRoutines.anchorAssetId, q.anchorAssetId));
  if (q.anchorPlaceId) conditions.push(eq(weorcRoutines.anchorPlaceId, q.anchorPlaceId));
  if (q.ownerMemberId) conditions.push(eq(weorcRoutines.ownerMemberId, q.ownerMemberId));
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  const limit = q.limit ?? 50;
  const offset = q.offset ?? 0;
  const rows = await db.select().from(weorcRoutines).where(where)
    .orderBy(asc(weorcRoutines.name)).limit(limit).offset(offset);
  const [tally] = await db.select({ n: count() }).from(weorcRoutines).where(where);
  return { rows, total: Number(tally?.n ?? 0), limit, offset };
}

export async function getRoutine(id: string): Promise<WeorcRoutine | null> {
  const [row] = await db.select().from(weorcRoutines).where(eq(weorcRoutines.id, id));
  return row ?? null;
}

export async function createRoutine(input: NewWeorcRoutine): Promise<WeorcRoutine> {
  const [row] = await db.insert(weorcRoutines).values(input).returning();
  return row!;
}

export async function updateRoutine(
  id: string, patch: Partial<NewWeorcRoutine>,
): Promise<WeorcRoutine | null> {
  const [row] = await db.update(weorcRoutines)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(weorcRoutines.id, id)).returning();
  return row ?? null;
}

export async function deleteRoutine(id: string): Promise<boolean> {
  const rows = await db.delete(weorcRoutines).where(eq(weorcRoutines.id, id)).returning();
  return rows.length > 0;
}

export async function hasTerminalOccurrence(routineId: string): Promise<boolean> {
  const [row] = await db.select({ n: count() }).from(weorcOccurrences)
    .where(and(eq(weorcOccurrences.routineId, routineId), sql`${weorcOccurrences.status} <> 'due'`));
  return Number(row?.n ?? 0) > 0;
}

export async function getOpenOccurrence(routineId: string): Promise<WeorcOccurrence | null> {
  const [row] = await db.select().from(weorcOccurrences)
    .where(and(eq(weorcOccurrences.routineId, routineId), eq(weorcOccurrences.status, 'due')));
  return row ?? null;
}

export async function lastTerminalOccurrence(routineId: string): Promise<WeorcOccurrence | null> {
  const [row] = await db.select().from(weorcOccurrences)
    .where(and(eq(weorcOccurrences.routineId, routineId), sql`${weorcOccurrences.status} <> 'due'`))
    .orderBy(desc(weorcOccurrences.dueOn)).limit(1);
  return row ?? null;
}

/**
 * Materialise one occurrence. `ON CONFLICT DO NOTHING` because the scheduler
 * tick and a REST completion can race: the unique constraints stop a duplicate
 * ROW, but a bare INSERT would still turn the loser into a 500. On conflict we
 * re-read whatever occurrence is currently open for the routine and return
 * that, so both callers see the same row and neither errors.
 */
export async function insertOccurrence(routineId: string, dueOn: string): Promise<WeorcOccurrence> {
  const [row] = await db.insert(weorcOccurrences)
    .values({ routineId, dueOn })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const open = await getOpenOccurrence(routineId);
  if (open) return open;
  // The conflict was on (routineId, dueOn) against a TERMINAL row — that date
  // has already been dealt with. Hand it back so the caller can advance.
  const [existing] = await db.select().from(weorcOccurrences)
    .where(and(eq(weorcOccurrences.routineId, routineId), eq(weorcOccurrences.dueOn, dueOn)));
  return existing!;
}

export async function getOccurrence(id: string): Promise<WeorcOccurrence | null> {
  const [row] = await db.select().from(weorcOccurrences).where(eq(weorcOccurrences.id, id));
  return row ?? null;
}

export interface ListOccurrencesQuery {
  status?: OccurrenceStatus;
  routineId?: string;
  dueTo?: string;
  limit?: number;
}

export async function listOccurrences(q: ListOccurrencesQuery = {}): Promise<WeorcOccurrence[]> {
  const conditions = [];
  if (q.status) conditions.push(eq(weorcOccurrences.status, q.status));
  if (q.routineId) conditions.push(eq(weorcOccurrences.routineId, q.routineId));
  if (q.dueTo) conditions.push(lte(weorcOccurrences.dueOn, q.dueTo));
  return db.select().from(weorcOccurrences)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(asc(weorcOccurrences.dueOn))
    .limit(q.limit ?? 200);
}

export async function terminateOccurrence(
  id: string, status: 'completed' | 'skipped',
  completedAt: Date | null, memberId: string | null, note: string | null,
): Promise<WeorcOccurrence | null> {
  const [row] = await db.update(weorcOccurrences).set({
    status,
    completedAt: status === 'completed' ? (completedAt ?? new Date()) : null,
    completedByMemberId: memberId,
    note,
    updatedAt: new Date(),
  }).where(eq(weorcOccurrences.id, id)).returning();
  return row ?? null;
}

export async function setProjection(id: string, feedKey: string, externalId: string): Promise<void> {
  await db.update(weorcOccurrences)
    .set({ taskFeedKey: feedKey, taskExternalId: externalId, projectionError: null, updatedAt: new Date() })
    .where(eq(weorcOccurrences.id, id));
}

export async function setProjectionError(id: string, reason: string | null): Promise<void> {
  await db.update(weorcOccurrences)
    .set({ projectionError: reason, updatedAt: new Date() })
    .where(eq(weorcOccurrences.id, id));
}

/** Active routines with nothing currently open — the materialise pass's input. */
export async function activeRoutinesWithoutOpenOccurrence(): Promise<WeorcRoutine[]> {
  const open = db.select({ id: weorcOccurrences.routineId }).from(weorcOccurrences)
    .where(eq(weorcOccurrences.status, 'due'));
  return db.select().from(weorcRoutines)
    .where(and(eq(weorcRoutines.active, true), sql`${weorcRoutines.id} NOT IN ${open}`));
}

/** Open occurrences that ARE projected — the reconcile pass's input. */
export async function openOccurrencesWithLink(): Promise<WeorcOccurrence[]> {
  return db.select().from(weorcOccurrences)
    .where(and(eq(weorcOccurrences.status, 'due'), isNotNull(weorcOccurrences.taskExternalId)));
}

/** Open occurrences that are NOT projected — the project pass's input. */
export async function openOccurrencesWithoutLink(): Promise<WeorcOccurrence[]> {
  return db.select().from(weorcOccurrences)
    .where(and(eq(weorcOccurrences.status, 'due'), isNull(weorcOccurrences.taskExternalId)));
}
```

- [ ] **Step 4: Run the tests and watch them pass**

```bash
npx vitest run tests/weorc-store.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd Heorth
git add src/modules/weorc/store.ts tests/weorc-store.test.ts
git commit -m "feat(weorc): the store

Materialising inserts are ON CONFLICT DO NOTHING and re-read the open row, so
the scheduler tick and a REST completion racing on the same successor produce
one occurrence and neither caller errors."
```

---

## Task 4: The two tasks-module additions

**Files:**
- Modify: `Heorth/src/modules/tasks/store.ts`, `Heorth/src/modules/tasks/service.ts`
- Test: `Heorth/tests/weorc-task-seam.test.ts`

**Interfaces:**
- Consumes: `getTaskProvider`, `getSharedListName` from `./provider.js`; `feedKeys` from `../../m365/feed-keys.js`
- Produces (all from `tasks/service.ts`):
  - `createHouseholdTask(input: CreateTaskInput, preferMemberId: string | null): Promise<TaskMirrorRow>`
  - `completeProjectedTask(feedKey: string, externalId: string, completed: boolean): Promise<void>`
  - `findTaskByFeedRef(feedKey: string, externalId: string): Promise<TaskMirrorRow | null>`
  - `findTaskByNotesMarker(marker: string): Promise<TaskMirrorRow | null>`

**Why:** `tasks.createTask` demands an acting principal (a 3am ticker has none) and `tasks.completeTask` keys on `task_mirror.id` — the identifier Weorc deliberately does not store, because a full resync invalidates it. Without these two, spec Part C cannot be implemented.

- [ ] **Step 1: Write the failing test**

Create `Heorth/tests/weorc-task-seam.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/db/index.js';
import { taskMirror, todoListAllowlist } from '../src/modules/tasks/schema.js';
import { setTaskProvider } from '../src/modules/tasks/provider.js';
import * as tasks from '../src/modules/tasks/service.js';
import { TaskProviderError, type TaskProvider, type MirroredTask } from '../src/modules/tasks/providers/types.js';
import { seedTestHousehold } from './helpers.js';

function fakeProvider(over: Partial<TaskProvider> = {}): TaskProvider & { created: unknown[]; completed: unknown[] } {
  const created: unknown[] = [];
  const completed: unknown[] = [];
  const provider = {
    source: 'm365',
    created, completed,
    async listAvailableLists() { return [{ id: 'list-1', name: 'Household' }]; },
    async pullChanges() { return { upserts: [], deletions: [], nextToken: null, fullResync: false }; },
    async setCompleted(feedKey: string, externalId: string, value: boolean) {
      completed.push({ feedKey, externalId, value });
    },
    async createTask(feedKey: string, input: { title: string; notes?: string | null; dueAt?: string | null }): Promise<MirroredTask> {
      created.push({ feedKey, input });
      return {
        externalId: `ext-${created.length}`, title: input.title, notes: input.notes ?? null,
        dueAt: input.dueAt ?? null, completedAt: null, status: 'open',
        listId: 'list-1', listName: 'Household', memberId: feedKey.split(':')[2]!,
      };
    },
    ...over,
  } as TaskProvider & { created: unknown[]; completed: unknown[] };
  return provider;
}

describe('the tasks seam Weorc needs', () => {
  beforeEach(() => setTaskProvider(null));

  it('createHouseholdTask works with NO acting principal', async () => {
    const { adult } = await seedTestHousehold();
    await db.insert(todoListAllowlist).values({ memberId: adult.user.id, listId: 'list-1', listName: 'Household' });
    const provider = fakeProvider();
    setTaskProvider(provider, 'Household');

    const row = await tasks.createHouseholdTask({ title: 'Put the bins out' }, null);
    expect(row.title).toBe('Put the bins out');
    expect(provider.created).toHaveLength(1);
  });

  it('createHouseholdTask prefers the named member when they have the list', async () => {
    const { admin, adult } = await seedTestHousehold();
    await db.insert(todoListAllowlist).values([
      { memberId: admin.user.id, listId: 'list-1', listName: 'Household' },
      { memberId: adult.user.id, listId: 'list-1', listName: 'Household' },
    ]);
    const provider = fakeProvider();
    setTaskProvider(provider, 'Household');

    const row = await tasks.createHouseholdTask({ title: 'Descale the kettle' }, adult.user.id);
    expect(row.memberId).toBe(adult.user.id);
  });

  it('createHouseholdTask throws a CLASSIFIED error when no provider is installed', async () => {
    await expect(tasks.createHouseholdTask({ title: 'Bins' }, null))
      .rejects.toBeInstanceOf(TaskProviderError);
  });

  it('completeProjectedTask keys on (feedKey, externalId), not the mirror uuid', async () => {
    const { adult } = await seedTestHousehold();
    const feedKey = `todo:member:${adult.user.id}:list-1`;
    await db.insert(taskMirror).values({
      source: 'm365', feedKey, externalId: 'ext-9', memberId: adult.user.id,
      listId: 'list-1', listName: 'Household', title: 'Bins', status: 'open',
    });
    const provider = fakeProvider();
    setTaskProvider(provider, 'Household');

    await tasks.completeProjectedTask(feedKey, 'ext-9', true);
    expect(provider.completed).toEqual([{ feedKey, externalId: 'ext-9', value: true }]);
    const [row] = await db.select().from(taskMirror);
    expect(row!.status).toBe('completed');
  });

  it('completeProjectedTask still calls the provider when NO mirror row exists', async () => {
    const provider = fakeProvider();
    setTaskProvider(provider, 'Household');
    await tasks.completeProjectedTask('todo:member:x:list-1', 'ext-gone', true);
    expect(provider.completed).toHaveLength(1);
  });

  it('finds a mirrored task by a notes marker', async () => {
    const { adult } = await seedTestHousehold();
    await db.insert(taskMirror).values({
      source: 'm365', feedKey: `todo:member:${adult.user.id}:list-1`, externalId: 'ext-3',
      memberId: adult.user.id, listId: 'list-1', title: 'Bins',
      notes: 'Kitchen\n\nweorc-occurrence:11111111-1111-1111-1111-111111111111', status: 'open',
    });
    const found = await tasks.findTaskByNotesMarker('weorc-occurrence:11111111-1111-1111-1111-111111111111');
    expect(found!.externalId).toBe('ext-3');
    expect(await tasks.findTaskByNotesMarker('weorc-occurrence:22222222-2222-2222-2222-222222222222')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd Heorth
npx vitest run tests/weorc-task-seam.test.ts
```

Expected: FAIL — `tasks.createHouseholdTask is not a function`.

- [ ] **Step 3: Add the two store lookups**

Append to `Heorth/src/modules/tasks/store.ts`:

```ts
/** One mirrored task by the STABLE key. `task_mirror.id` is not stable across a
 *  full resync (which deletes and re-inserts a feed's rows); `(feedKey,
 *  externalId)` is — it is the table's own unique constraint. */
export async function getTaskByFeedRef(feedKey: string, externalId: string): Promise<TaskMirrorRow | null> {
  const [row] = await db.select().from(taskMirror)
    .where(and(eq(taskMirror.feedKey, feedKey), eq(taskMirror.externalId, externalId)));
  return row ?? null;
}

/** One mirrored task whose notes carry `marker`. Weorc stamps a marker into the
 *  tasks it projects so it can relink after a crash between the outward create
 *  and storing the link — without it, that window is a duplicate factory. */
export async function getTaskByNotesMarker(marker: string): Promise<TaskMirrorRow | null> {
  const [row] = await db.select().from(taskMirror)
    .where(sql`${taskMirror.notes} LIKE ${'%' + marker + '%'}`)
    .limit(1);
  return row ?? null;
}
```

Make sure `and`, `eq` and `sql` are in that file's imports from `drizzle-orm`; add whichever is missing.

- [ ] **Step 4: Add the two service functions**

In `Heorth/src/modules/tasks/service.ts`, replace the body of `createTask` and add the new exports:

```ts
/**
 * Create a task into the shared household list with NO acting principal —
 * the shared feed is resolved through a *preferred* member when one is given,
 * else any connected member that has the list. This is the path Weorc's
 * scheduler tick uses: a 3am ticker has no acting member, so it cannot go
 * through `createTask`'s maintenance-admin assertion.
 */
export async function createHouseholdTask(
  input: CreateTaskInput, preferMemberId: string | null,
): Promise<TaskMirrorRow> {
  const provider = requireProvider();
  const feed = await resolveSharedFeed(preferMemberId);
  const created = await provider.createTask(feed.feedKey, input); // throws TaskProviderError
  return store.upsertMirroredTask(provider.source, feed, created);
}

/**
 * Complete/uncomplete a task identified by the STABLE key. `completeTask` takes
 * a `task_mirror.id`, which Weorc deliberately does not store because a full
 * resync invalidates it. The provider write happens either way; the local
 * mirror is updated only if a row is currently present (a de-allowlisted or
 * mid-resync feed legitimately has none).
 */
export async function completeProjectedTask(
  feedKey: string, externalId: string, completed: boolean,
): Promise<void> {
  const provider = requireProvider();
  await provider.setCompleted(feedKey, externalId, completed); // throws TaskProviderError
  const row = await store.getTaskByFeedRef(feedKey, externalId);
  if (row) await store.setTaskCompletedLocal(row.id, completed);
}

export async function findTaskByFeedRef(feedKey: string, externalId: string): Promise<TaskMirrorRow | null> {
  return store.getTaskByFeedRef(feedKey, externalId);
}

export async function findTaskByNotesMarker(marker: string): Promise<TaskMirrorRow | null> {
  return store.getTaskByNotesMarker(marker);
}
```

Then change the existing `createTask` to delegate, keeping its signature and its
quarantine assertion:

```ts
export async function createTask(input: CreateTaskInput, actingMemberId: string): Promise<TaskMirrorRow> {
  await assertNotMaintenanceAdmin(actingMemberId);
  return createHouseholdTask(input, actingMemberId);
}
```

and widen `resolveSharedFeed` to accept a nullable preference:

```ts
async function resolveSharedFeed(preferMemberId: string | null): Promise<TaskFeed> {
```

leaving its body unchanged except the final selection:

```ts
  const chosen = entries.find((e) => e.memberId === preferMemberId) ?? entries[0]!;
```

- [ ] **Step 5: Run the new test AND the existing tasks tests**

```bash
npx vitest run tests/weorc-task-seam.test.ts tests/m365-tasks-sync.test.ts tests/m365-routes.test.ts
```

Expected: PASS. The existing task tests must be untouched — if any fails, the
delegation changed `createTask`'s behaviour and that is a regression, not an
acceptable adjustment.

- [ ] **Step 6: Commit**

```bash
cd Heorth
git add src/modules/tasks/service.ts src/modules/tasks/store.ts tests/weorc-task-seam.test.ts
git commit -m "feat(tasks): a principal-free create and a stable-key completion

Weorc's ticker has no acting member, and it stores (feedKey, externalId) rather
than task_mirror.id because a full resync invalidates the uuid. Both existing
entry points keep their signatures and delegate."
```

---

## Task 5: The engine

**Files:**
- Create: `Heorth/src/modules/weorc/engine.ts`
- Test: `Heorth/tests/weorc-engine.test.ts`
- Test: `Heorth/tests/weorc-projection.test.ts`

**Interfaces:**
- Consumes: Tasks 2–4
- Produces:
  - `runWeorcTick(): Promise<WeorcTickResult>` where `WeorcTickResult = { reconciled: number; materialised: number; projected: number; projectionFailures: number }`
  - `advanceRoutine(routineId: string, today: string): Promise<WeorcOccurrence | null>`
  - `projectOccurrence(occ: WeorcOccurrence): Promise<ProjectionOutcome>` where `ProjectionOutcome = { ok: boolean; reason?: string }`
  - `occurrenceMarker(occurrenceId: string): string`

- [ ] **Step 1: Write the failing engine test**

Create `Heorth/tests/weorc-engine.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/db/index.js';
import { taskMirror } from '../src/modules/tasks/schema.js';
import { setTaskProvider } from '../src/modules/tasks/provider.js';
import * as store from '../src/modules/weorc/store.js';
import { runWeorcTick } from '../src/modules/weorc/engine.js';
import { householdToday } from '../src/modules/weorc/dates.js';
import { seedTestHousehold } from './helpers.js';
import { addDays } from '../src/modules/weorc/recurrence.js';

describe('the tick with NO provider — the demo stack, permanently', () => {
  beforeEach(() => setTaskProvider(null));

  it('materialises a due occurrence and records NO projection error', async () => {
    const today = await householdToday();
    const r = await store.createRoutine({
      name: 'Bins', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: today,
    });
    const result = await runWeorcTick();
    expect(result.materialised).toBe(1);
    expect(result.projected).toBe(0);
    expect(result.projectionFailures).toBe(0);

    const open = await store.getOpenOccurrence(r.id);
    expect(open!.dueOn).toBe(today);
    // Absent is not an error: nothing to see, nothing to alarm the household.
    expect(open!.projectionError).toBeNull();
  });

  it('does NOT materialise beyond the lead horizon', async () => {
    const today = await householdToday();
    const r = await store.createRoutine({
      name: 'Boiler', mode: 'from_completion', intervalUnit: 'month', intervalCount: 12,
      anchorDate: addDays(today, 30), leadDays: 14,
    });
    await runWeorcTick();
    expect(await store.getOpenOccurrence(r.id)).toBeNull();
  });

  it('DOES materialise inside the lead horizon', async () => {
    const today = await householdToday();
    const r = await store.createRoutine({
      name: 'Boiler', mode: 'from_completion', intervalUnit: 'month', intervalCount: 12,
      anchorDate: addDays(today, 10), leadDays: 14,
    });
    await runWeorcTick();
    expect((await store.getOpenOccurrence(r.id))!.dueOn).toBe(addDays(today, 10));
  });

  it('skips inactive routines', async () => {
    const today = await householdToday();
    const r = await store.createRoutine({
      name: 'Off', mode: 'fixed', intervalUnit: 'week', intervalCount: 1,
      anchorDate: today, active: false,
    });
    await runWeorcTick();
    expect(await store.getOpenOccurrence(r.id)).toBeNull();
  });

  it('is idempotent — a second tick changes nothing', async () => {
    const today = await householdToday();
    await store.createRoutine({
      name: 'Bins', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: today,
    });
    await runWeorcTick();
    const second = await runWeorcTick();
    expect(second.materialised).toBe(0);
  });
});

describe('the reconcile pass', () => {
  beforeEach(() => setTaskProvider(null));

  it('completes an occurrence when its task completes upstream, and advances', async () => {
    const { adult } = await seedTestHousehold();
    const today = await householdToday();
    const r = await store.createRoutine({
      name: 'Bins', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: today,
    });
    const occ = await store.insertOccurrence(r.id, today);
    const feedKey = `todo:member:${adult.user.id}:list-1`;
    await store.setProjection(occ.id, feedKey, 'ext-1');
    const completedAt = new Date();
    await db.insert(taskMirror).values({
      source: 'm365', feedKey, externalId: 'ext-1', memberId: adult.user.id,
      listId: 'list-1', title: 'Bins', status: 'completed', completedAt,
    });

    const result = await runWeorcTick();
    expect(result.reconciled).toBe(1);

    const done = await store.getOccurrence(occ.id);
    expect(done!.status).toBe('completed');
    // Reconcile runs FIRST, so the successor appears in the SAME tick.
    const next = await store.getOpenOccurrence(r.id);
    expect(next!.dueOn).toBe(addDays(today, 7));
  });

  it('does NOTHING when the mirror row is absent — that is not a deletion', async () => {
    const today = await householdToday();
    const r = await store.createRoutine({
      name: 'Bins', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: today,
    });
    const occ = await store.insertOccurrence(r.id, today);
    await store.setProjection(occ.id, 'todo:member:gone:list-1', 'ext-vanished');

    const result = await runWeorcTick();
    expect(result.reconciled).toBe(0);

    // De-allowlisting a list drops a whole feed's mirror rows. Treating that as
    // "deleted upstream" would clear the link and spawn a duplicate task for
    // every projected occurrence at once.
    const still = await store.getOccurrence(occ.id);
    expect(still!.status).toBe('due');
    expect(still!.taskExternalId).toBe('ext-vanished');
  });
});
```

- [ ] **Step 2: Write the failing projection test**

Create `Heorth/tests/weorc-projection.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/db/index.js';
import { taskMirror, todoListAllowlist } from '../src/modules/tasks/schema.js';
import { setTaskProvider } from '../src/modules/tasks/provider.js';
import { TaskProviderError, type TaskProvider, type MirroredTask } from '../src/modules/tasks/providers/types.js';
import * as store from '../src/modules/weorc/store.js';
import { ethelAssets } from '../src/modules/ethel/schema.js';
import { runWeorcTick, occurrenceMarker } from '../src/modules/weorc/engine.js';
import { householdToday } from '../src/modules/weorc/dates.js';
import { seedTestHousehold } from './helpers.js';

function provider(createTask: TaskProvider['createTask']): TaskProvider {
  return {
    source: 'm365',
    async listAvailableLists() { return [{ id: 'list-1', name: 'Household' }]; },
    async pullChanges() { return { upserts: [], deletions: [], nextToken: null, fullResync: false }; },
    async setCompleted() { /* not used here */ },
    createTask,
  };
}

async function allowlistedMember() {
  const { adult } = await seedTestHousehold();
  await db.insert(todoListAllowlist).values({ memberId: adult.user.id, listId: 'list-1', listName: 'Household' });
  return adult.user.id;
}

describe('the project pass', () => {
  beforeEach(() => setTaskProvider(null));

  it('projects an open occurrence and stores the STABLE link', async () => {
    const memberId = await allowlistedMember();
    const today = await householdToday();
    const seen: Array<{ title: string; notes?: string | null; dueAt?: string | null }> = [];
    setTaskProvider(provider(async (feedKey, input): Promise<MirroredTask> => {
      seen.push(input);
      return {
        externalId: 'ext-1', title: input.title, notes: input.notes ?? null,
        dueAt: input.dueAt ?? null, completedAt: null, status: 'open',
        listId: 'list-1', listName: 'Household', memberId,
      };
    }), 'Household');

    const [asset] = await db.insert(ethelAssets).values({ name: 'Boiler' }).returning();
    const r = await store.createRoutine({
      name: 'Service the boiler', mode: 'fixed', intervalUnit: 'month', intervalCount: 12,
      anchorDate: today, anchorAssetId: asset!.id, notes: 'Book the plumber',
    });

    const result = await runWeorcTick();
    expect(result.projected).toBe(1);

    const open = await store.getOpenOccurrence(r.id);
    expect(open!.taskExternalId).toBe('ext-1');
    expect(open!.taskFeedKey).toBe(`todo:member:${memberId}:list-1`);
    expect(open!.projectionError).toBeNull();

    expect(seen[0]!.title).toBe('Service the boiler');
    expect(seen[0]!.notes).toContain('Boiler');
    expect(seen[0]!.notes).toContain('Book the plumber');
    expect(seen[0]!.notes).toContain(occurrenceMarker(open!.id));
  });

  it('RELINKS instead of creating a second task when the marker is already out there', async () => {
    const memberId = await allowlistedMember();
    const today = await householdToday();
    const r = await store.createRoutine({
      name: 'Bins', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: today,
    });
    const occ = await store.insertOccurrence(r.id, today);
    // Simulate the crash window: Graph accepted the create and the sync
    // mirrored it, but Weorc died before storing the link.
    const feedKey = `todo:member:${memberId}:list-1`;
    await db.insert(taskMirror).values({
      source: 'm365', feedKey, externalId: 'ext-orphan', memberId,
      listId: 'list-1', title: 'Bins', notes: occurrenceMarker(occ.id), status: 'open',
    });

    let creates = 0;
    setTaskProvider(provider(async () => { creates += 1; throw new Error('must not create'); }), 'Household');

    const result = await runWeorcTick();
    expect(creates).toBe(0);
    expect(result.projected).toBe(1);
    expect((await store.getOccurrence(occ.id))!.taskExternalId).toBe('ext-orphan');
  });

  it('records a CLASSIFIED reason on failure, leaves the occurrence due, and retries next tick', async () => {
    await allowlistedMember();
    const today = await householdToday();
    const r = await store.createRoutine({
      name: 'Bins', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: today,
    });
    setTaskProvider(provider(async () => { throw new TaskProviderError('needs_reauth'); }), 'Household');

    const result = await runWeorcTick();
    expect(result.projected).toBe(0);
    expect(result.projectionFailures).toBe(1);

    const open = await store.getOpenOccurrence(r.id);
    expect(open!.status).toBe('due');
    expect(open!.projectionError).toBe('needs_reauth');
    expect(open!.taskExternalId).toBeNull();
  });

  it('one dead feed does not stop the pass', async () => {
    await allowlistedMember();
    const today = await householdToday();
    await store.createRoutine({ name: 'A', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: today });
    await store.createRoutine({ name: 'B', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: today });

    let n = 0;
    setTaskProvider(provider(async (feedKey, input): Promise<MirroredTask> => {
      n += 1;
      if (n === 1) throw new TaskProviderError('graph_500');
      return {
        externalId: 'ext-ok', title: input.title, notes: input.notes ?? null, dueAt: null,
        completedAt: null, status: 'open', listId: 'list-1', listName: 'Household',
        memberId: feedKey.split(':')[2]!,
      };
    }), 'Household');

    const result = await runWeorcTick();
    expect(result.projectionFailures).toBe(1);
    expect(result.projected).toBe(1);
  });
});
```

- [ ] **Step 3: Run both and watch them fail**

```bash
cd Heorth
npx vitest run tests/weorc-engine.test.ts tests/weorc-projection.test.ts
```

Expected: FAIL — `Cannot find module '../src/modules/weorc/engine.js'`.

- [ ] **Step 4: Write the engine**

Create `Heorth/src/modules/weorc/engine.ts`:

```ts
import { logError } from '@wyrhta/core/lib';
import * as tasks from '../tasks/service.js';
import { TaskProviderError } from '../tasks/providers/types.js';
import { getTaskProvider } from '../tasks/provider.js';
import { anchorName } from './anchors.js';
import * as store from './store.js';
import { householdToday, householdMidnightUtc } from './dates.js';
import { localDateOf } from '../../lib/local-date.js';
import { getHouseholdTimeZone } from '../../household/timezone.js';
import { nextDueOn, addDays } from './recurrence.js';
import type { WeorcOccurrence, WeorcRoutine } from './schema.js';

/**
 * Weorc's projection engine (spec Part C). One tick, three passes, in this
 * order — reconcile FIRST, so a completion detected in this tick yields its
 * successor in the same tick rather than the next one.
 *
 * The whole engine is written so that NO PROVIDER IS A NORMAL STATE. The demo
 * household (ADR 0015 §4) has no Microsoft 365 and never will: materialising
 * due work and keeping its history are Heorth-native, and only the projection
 * pass degrades — to "not projected", never to an error.
 */

export interface WeorcTickResult {
  reconciled: number;
  materialised: number;
  projected: number;
  projectionFailures: number;
}

export interface ProjectionOutcome {
  ok: boolean;
  reason?: string;
}

/** The stamp Weorc puts in a projected task's notes so it can find that task
 *  again — after a crash between the outward create and storing the link, or
 *  after a full resync renumbered every mirror row. */
export function occurrenceMarker(occurrenceId: string): string {
  return `weorc-occurrence:${occurrenceId}`;
}

/**
 * The household-local date a terminal occurrence counts as having happened: a
 * completion's own instant rendered in the household's zone, a skip's `dueOn`
 * (nothing happened, so the slot itself is the base).
 */
export async function terminalDateOf(occ: WeorcOccurrence): Promise<string> {
  if (occ.status === 'completed' && occ.completedAt) {
    return localDateOf(occ.completedAt, await getHouseholdTimeZone());
  }
  return occ.dueOn;
}

/**
 * Materialise the routine's next occurrence if it falls inside the lead
 * horizon. Returns the open occurrence, or null when the next one is still
 * beyond the horizon (in which case nothing is stored and the date is computed
 * on read instead).
 */
export async function advanceRoutine(routineId: string, today: string): Promise<WeorcOccurrence | null> {
  const routine = await store.getRoutine(routineId);
  if (!routine || !routine.active) return null;
  const existing = await store.getOpenOccurrence(routineId);
  if (existing) return existing;

  const last = await store.lastTerminalOccurrence(routineId);
  const due = nextDueOn(
    {
      mode: routine.mode as WeorcRoutine['mode'],
      intervalUnit: routine.intervalUnit as never,
      intervalCount: routine.intervalCount,
      anchorDate: routine.anchorDate,
    },
    last ? await terminalDateOf(last) : null,
    today,
  );

  if (due > addDays(today, routine.leadDays)) return null;
  const occ = await store.insertOccurrence(routineId, due);
  return occ.status === 'due' ? occ : null;
}

/** Compose the projected task's notes: the anchor, the routine's own notes, and
 *  the marker on its own last line. */
async function composeNotes(routine: WeorcRoutine, occurrenceId: string): Promise<string> {
  const parts: string[] = [];
  const anchor = await anchorName(routine);
  if (anchor) parts.push(anchor);
  if (routine.notes) parts.push(routine.notes);
  parts.push(occurrenceMarker(occurrenceId));
  return parts.join('\n\n');
}

/**
 * Project one occurrence outward. Relinks by marker BEFORE creating: the window
 * between "the provider accepted the create" and "Weorc stored the link" is
 * otherwise a duplicate factory.
 */
export async function projectOccurrence(occ: WeorcOccurrence): Promise<ProjectionOutcome> {
  if (!getTaskProvider()) return { ok: false };
  const routine = await store.getRoutine(occ.routineId);
  if (!routine) return { ok: false };

  const existing = await tasks.findTaskByNotesMarker(occurrenceMarker(occ.id));
  if (existing) {
    await store.setProjection(occ.id, existing.feedKey, existing.externalId);
    return { ok: true };
  }

  try {
    const created = await tasks.createHouseholdTask({
      title: routine.name,
      notes: await composeNotes(routine, occ.id),
      dueAt: (await householdMidnightUtc(occ.dueOn)).toISOString(),
    }, routine.ownerMemberId);
    await store.setProjection(occ.id, created.feedKey, created.externalId);
    return { ok: true };
  } catch (e: unknown) {
    if (e instanceof TaskProviderError) {
      await store.setProjectionError(occ.id, e.reason);
      return { ok: false, reason: e.reason };
    }
    throw e;
  }
}

/** One tick. Never rejects for a per-item failure. */
export async function runWeorcTick(): Promise<WeorcTickResult> {
  const today = await householdToday();
  const result: WeorcTickResult = { reconciled: 0, materialised: 0, projected: 0, projectionFailures: 0 };

  // 1. Reconcile: a completion that arrived through the task sync.
  for (const occ of await store.openOccurrencesWithLink()) {
    const mirrored = await tasks.findTaskByFeedRef(occ.taskFeedKey!, occ.taskExternalId!);
    // An ABSENT mirror row is NOT a deletion — de-allowlisting a list drops a
    // whole feed's rows. Leave the link and the occurrence exactly as they are.
    if (!mirrored) continue;
    if (mirrored.status !== 'completed') continue;
    await store.terminateOccurrence(occ.id, 'completed', mirrored.completedAt ?? new Date(), null, occ.note);
    result.reconciled += 1;
  }

  // 2. Materialise.
  for (const routine of await store.activeRoutinesWithoutOpenOccurrence()) {
    const created = await advanceRoutine(routine.id, today);
    if (created) result.materialised += 1;
  }

  // 3. Project. A provider that is absent writes no error and is not counted.
  if (getTaskProvider()) {
    for (const occ of await store.openOccurrencesWithoutLink()) {
      try {
        const outcome = await projectOccurrence(occ);
        if (outcome.ok) result.projected += 1;
        else if (outcome.reason) result.projectionFailures += 1;
      } catch (e: unknown) {
        // An unclassified error must not stop the pass or crash the tick.
        logError('weorc projection failed', e);
        result.projectionFailures += 1;
      }
    }
  }

  return result;
}
```

Create `Heorth/src/modules/weorc/anchors.ts`:

```ts
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { ethelAssets, ethelPlaces } from '../ethel/schema.js';
import type { WeorcRoutine } from './schema.js';

/**
 * The display name of a routine's anchor, or null when it has none — which is
 * the normal case (ADR 0014 §5). Weorc reads Ethel's tables directly for a
 * single name rather than importing its service: the dependency runs
 * Weorc → Ethel and stays a read.
 */
export async function anchorName(routine: WeorcRoutine): Promise<string | null> {
  if (routine.anchorAssetId) {
    const [row] = await db.select({ name: ethelAssets.name }).from(ethelAssets)
      .where(eq(ethelAssets.id, routine.anchorAssetId));
    return row?.name ?? null;
  }
  if (routine.anchorPlaceId) {
    const [row] = await db.select({ name: ethelPlaces.name }).from(ethelPlaces)
      .where(eq(ethelPlaces.id, routine.anchorPlaceId));
    return row?.name ?? null;
  }
  return null;
}
```

- [ ] **Step 5: Run both tests and watch them pass**

```bash
npx vitest run tests/weorc-engine.test.ts tests/weorc-projection.test.ts
```

Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
cd Heorth
git add src/modules/weorc/engine.ts src/modules/weorc/anchors.ts tests/weorc-engine.test.ts tests/weorc-projection.test.ts
git commit -m "feat(weorc): the three-pass tick

Reconcile first so a completion yields its successor in the same tick. An
absent mirror row is NOT a deletion - de-allowlisting a list drops a whole
feed's rows, and treating that as upstream deletion would spawn a duplicate
task per projected occurrence. Projection relinks by marker before creating,
closing the crash window between the Graph write and storing the link. No
provider writes no error: that is the demo stack's permanent state."
```

---

## Task 6: Validators, service and routes

**Files:**
- Create: `Heorth/src/modules/weorc/validators.ts`, `Heorth/src/modules/weorc/service.ts`, `Heorth/src/modules/weorc/routes.ts`, `Heorth/src/modules/weorc/index.ts`
- Modify: `Heorth/src/modules/index.ts`
- Test: `Heorth/tests/weorc-routes.test.ts`

**Interfaces:**
- Consumes: Tasks 3 and 5
- Produces: `weorcModule` (a `HeorthModule` named `weorc`, mounting `/api/v1/weorc`); from `service.ts`: `listRoutines`, `getRoutineDetail`, `createRoutine`, `updateRoutine`, `deleteRoutine`, `completeOccurrence`, `skipOccurrence`, and the error classes `AnchorConflictError`, `AnchorNotFoundError`, `RoutineHasHistoryError`, `AlreadyTerminalError`

- [ ] **Step 1: Write the failing route test**

Create `Heorth/tests/weorc-routes.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db } from '../src/db/index.js';
import { ethelAssets, ethelPlaces } from '../src/modules/ethel/schema.js';
import { setTaskProvider } from '../src/modules/tasks/provider.js';
import * as store from '../src/modules/weorc/store.js';
import { householdToday } from '../src/modules/weorc/dates.js';
import { addDays } from '../src/modules/weorc/recurrence.js';
import { seedTestHousehold, authHeaders } from './helpers.js';
import { createApp } from '../src/app.js';
import { ALL_MODULES } from '../src/modules/index.js';

const app = createApp(ALL_MODULES);

const body = (over = {}) => JSON.stringify({
  name: 'Put the bins out', mode: 'fixed', intervalUnit: 'week',
  intervalCount: 1, anchorDate: '2026-09-01', ...over,
});

describe('weorc routes', () => {
  beforeEach(() => setTaskProvider(null));

  it('creates an UNANCHORED routine — the normal case', async () => {
    const { adult } = await seedTestHousehold();
    const res = await app.request('/api/v1/weorc/routines', {
      method: 'POST', headers: authHeaders(adult.jwt), body: body(),
    });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.data.anchorAssetId).toBeNull();
  });

  it('refuses two anchors with ANCHOR_CONFLICT', async () => {
    const { adult } = await seedTestHousehold();
    const [a] = await db.insert(ethelAssets).values({ name: 'Boiler' }).returning();
    const [p] = await db.insert(ethelPlaces).values({ name: 'Utility', kind: 'room' }).returning();
    const res = await app.request('/api/v1/weorc/routines', {
      method: 'POST', headers: authHeaders(adult.jwt),
      body: body({ anchorAssetId: a!.id, anchorPlaceId: p!.id }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('ANCHOR_CONFLICT');
  });

  it('refuses an unknown anchor with ASSET_NOT_FOUND', async () => {
    const { adult } = await seedTestHousehold();
    const res = await app.request('/api/v1/weorc/routines', {
      method: 'POST', headers: authHeaders(adult.jwt),
      body: body({ anchorAssetId: '11111111-1111-1111-1111-111111111111' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe('ASSET_NOT_FOUND');
  });

  it('refuses a child (role gate), allows an adult', async () => {
    const { child } = await seedTestHousehold();
    const res = await app.request('/api/v1/weorc/routines', {
      method: 'POST', headers: authHeaders(child.jwt), body: body(),
    });
    expect(res.status).toBe(403);
  });

  it('lists routines with the computed next due date', async () => {
    const { adult } = await seedTestHousehold();
    const today = await householdToday();
    await store.createRoutine({
      name: 'Bins', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: today,
    });
    const res = await app.request('/api/v1/weorc/routines', { headers: authHeaders(adult.jwt) });
    const json = await res.json();
    expect(json.meta.total).toBe(1);
    expect(json.data[0].nextDueOn).toBe(today);
    expect(json.data[0].openOccurrence).toBeNull();
  });

  it('refuses to DELETE a routine with history, and says why', async () => {
    const { adult } = await seedTestHousehold();
    const r = await store.createRoutine({
      name: 'Bins', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: '2026-09-01',
    });
    const occ = await store.insertOccurrence(r.id, '2026-09-01');
    await store.terminateOccurrence(occ.id, 'skipped', null, null, null);
    const res = await app.request(`/api/v1/weorc/routines/${r.id}`, {
      method: 'DELETE', headers: authHeaders(adult.jwt),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('ROUTINE_HAS_HISTORY');
  });

  it('DELETEs a routine that never ran', async () => {
    const { adult } = await seedTestHousehold();
    const r = await store.createRoutine({
      name: 'Oops', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: '2026-09-01',
    });
    const res = await app.request(`/api/v1/weorc/routines/${r.id}`, {
      method: 'DELETE', headers: authHeaders(adult.jwt),
    });
    expect(res.status).toBe(200);
  });

  it('completes an occurrence, advances, and reports the projection outcome', async () => {
    const { adult } = await seedTestHousehold();
    const today = await householdToday();
    const r = await store.createRoutine({
      name: 'Bins', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: today,
    });
    const occ = await store.insertOccurrence(r.id, today);
    const res = await app.request(`/api/v1/weorc/occurrences/${occ.id}/complete`, {
      method: 'POST', headers: authHeaders(adult.jwt), body: JSON.stringify({ note: 'two bags' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.occurrence.status).toBe('completed');
    expect(json.data.occurrence.completedByMemberId).toBe(adult.user.id);
    expect(json.data.next.dueOn).toBe(addDays(today, 7));
    // No provider is installed: nothing was projected and that is not a failure.
    expect(json.data.projection).toEqual({ ok: false });
  });

  it('refuses to complete an already-terminal occurrence', async () => {
    const { adult } = await seedTestHousehold();
    const r = await store.createRoutine({
      name: 'Bins', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: '2026-09-01',
    });
    const occ = await store.insertOccurrence(r.id, '2026-09-01');
    await store.terminateOccurrence(occ.id, 'skipped', null, null, null);
    const res = await app.request(`/api/v1/weorc/occurrences/${occ.id}/complete`, {
      method: 'POST', headers: authHeaders(adult.jwt), body: JSON.stringify({}),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe('ALREADY_TERMINAL');
  });

  it('skips WITHOUT claiming it was done', async () => {
    const { adult } = await seedTestHousehold();
    const r = await store.createRoutine({
      name: 'Bins', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: '2026-09-01',
    });
    const occ = await store.insertOccurrence(r.id, '2026-09-01');
    const res = await app.request(`/api/v1/weorc/occurrences/${occ.id}/skip`, {
      method: 'POST', headers: authHeaders(adult.jwt), body: JSON.stringify({ note: 'away' }),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.occurrence.status).toBe('skipped');
    expect(json.data.occurrence.completedAt).toBeNull();
  });

  it('leaves a PROJECTED open occurrence alone when the routine is edited', async () => {
    const { adult } = await seedTestHousehold();
    const today = await householdToday();
    const r = await store.createRoutine({
      name: 'Bins', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: today,
    });
    const occ = await store.insertOccurrence(r.id, today);
    await store.setProjection(occ.id, 'todo:member:x:list-1', 'ext-1');

    const res = await app.request(`/api/v1/weorc/routines/${r.id}`, {
      method: 'PATCH', headers: authHeaders(adult.jwt),
      body: JSON.stringify({ intervalCount: 2 }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.openOccurrenceUnchanged).toBe(true);
    // TaskProvider has no update method, so silently moving dueOn here would
    // leave a To Do task showing the old date with nothing to explain it.
    expect((await store.getOccurrence(occ.id))!.dueOn).toBe(today);
  });

  it('DOES move an UNPROJECTED open occurrence when the routine is edited', async () => {
    const { adult } = await seedTestHousehold();
    const today = await householdToday();
    const r = await store.createRoutine({
      name: 'Bins', mode: 'from_completion', intervalUnit: 'day', intervalCount: 1, anchorDate: today,
    });
    await store.insertOccurrence(r.id, today);
    const res = await app.request(`/api/v1/weorc/routines/${r.id}`, {
      method: 'PATCH', headers: authHeaders(adult.jwt),
      body: JSON.stringify({ anchorDate: addDays(today, 1) }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.openOccurrenceUnchanged).toBe(false);
    expect((await store.getOpenOccurrence(r.id))!.dueOn).toBe(addDays(today, 1));
  });

  it('runs a tick on demand', async () => {
    const { adult } = await seedTestHousehold();
    const today = await householdToday();
    await store.createRoutine({
      name: 'Bins', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, anchorDate: today,
    });
    const res = await app.request('/api/v1/weorc/run', {
      method: 'POST', headers: authHeaders(adult.jwt),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.materialised).toBe(1);
  });

  it('requires auth', async () => {
    const res = await app.request('/api/v1/weorc/routines');
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd Heorth
npx vitest run tests/weorc-routes.test.ts
```

Expected: FAIL — 404 on every route (the module is not registered yet).

- [ ] **Step 3: Write the validators**

Create `Heorth/src/modules/weorc/validators.ts`:

```ts
import { z } from 'zod';
import { ROUTINE_MODES, INTERVAL_UNITS, OCCURRENCE_STATUSES } from './schema.js';

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const baseRoutine = z.object({
  name: z.string().min(1),
  notes: z.string().optional().nullable(),
  mode: z.enum(ROUTINE_MODES),
  intervalUnit: z.enum(INTERVAL_UNITS),
  intervalCount: z.number().int().positive(),
  anchorDate: dateStr,
  leadDays: z.number().int().min(0).optional(),
  ownerMemberId: z.string().uuid().optional().nullable(),
  anchorAssetId: z.string().uuid().optional().nullable(),
  anchorPlaceId: z.string().uuid().optional().nullable(),
});

export const createRoutineSchema = baseRoutine;
export const updateRoutineSchema = baseRoutine.partial().extend({
  active: z.boolean().optional(),
});

export const listRoutinesQuerySchema = z.object({
  active: z.enum(['true', 'false']).optional(),
  anchor_asset_id: z.string().uuid().optional(),
  anchor_place_id: z.string().uuid().optional(),
  owner_member_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const listOccurrencesQuerySchema = z.object({
  status: z.enum(OCCURRENCE_STATUSES).optional(),
  routine_id: z.string().uuid().optional(),
  due_to: dateStr.optional(),
});

export const completeSchema = z.object({
  completedAt: z.string().datetime().optional(),
  note: z.string().optional().nullable(),
});

export const skipSchema = z.object({
  note: z.string().optional().nullable(),
});

export type CreateRoutineInput = z.infer<typeof createRoutineSchema>;
export type UpdateRoutineInput = z.infer<typeof updateRoutineSchema>;
```

- [ ] **Step 4: Write the service**

Create `Heorth/src/modules/weorc/service.ts`:

```ts
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { ethelAssets, ethelPlaces } from '../ethel/schema.js';
import * as tasks from '../tasks/service.js';
import { TaskProviderError } from '../tasks/providers/types.js';
import { getTaskProvider } from '../tasks/provider.js';
import * as store from './store.js';
import { advanceRoutine, projectOccurrence, terminalDateOf, type ProjectionOutcome } from './engine.js';
import { householdToday } from './dates.js';
import { nextDueOn } from './recurrence.js';
import type { WeorcOccurrence, WeorcRoutine } from './schema.js';
import type { CreateRoutineInput, UpdateRoutineInput } from './validators.js';

export class AnchorConflictError extends Error {}
export class AnchorNotFoundError extends Error {
  constructor(public readonly kind: 'asset' | 'place') { super(`${kind} not found`); }
}
export class RoutineHasHistoryError extends Error {}
export class AlreadyTerminalError extends Error {}

/** A routine as the API returns it: the row plus what a caller needs to render
 *  it without a second request. */
export interface RoutineView extends WeorcRoutine {
  nextDueOn: string;
  openOccurrence: WeorcOccurrence | null;
}

async function assertAnchor(input: { anchorAssetId?: string | null; anchorPlaceId?: string | null }): Promise<void> {
  if (input.anchorAssetId && input.anchorPlaceId) throw new AnchorConflictError();
  if (input.anchorAssetId) {
    const [row] = await db.select({ id: ethelAssets.id }).from(ethelAssets)
      .where(eq(ethelAssets.id, input.anchorAssetId));
    if (!row) throw new AnchorNotFoundError('asset');
  }
  if (input.anchorPlaceId) {
    const [row] = await db.select({ id: ethelPlaces.id }).from(ethelPlaces)
      .where(eq(ethelPlaces.id, input.anchorPlaceId));
    if (!row) throw new AnchorNotFoundError('place');
  }
}

/** Decorate a routine with its open occurrence and its next due date. Beyond the
 *  lead horizon nothing is materialised, so the date is computed here. */
async function view(routine: WeorcRoutine, today: string): Promise<RoutineView> {
  const open = await store.getOpenOccurrence(routine.id);
  if (open) return { ...routine, nextDueOn: open.dueOn, openOccurrence: open };
  const last = await store.lastTerminalOccurrence(routine.id);
  const due = nextDueOn(
    {
      mode: routine.mode as WeorcRoutine['mode'],
      intervalUnit: routine.intervalUnit as never,
      intervalCount: routine.intervalCount,
      anchorDate: routine.anchorDate,
    },
    last ? await terminalDateOf(last) : null,
    today,
  );
  return { ...routine, nextDueOn: due, openOccurrence: null };
}

export async function listRoutines(q: store.ListRoutinesQuery): Promise<{
  rows: RoutineView[]; total: number; limit: number; offset: number;
}> {
  const { rows, total, limit, offset } = await store.listRoutines(q);
  const today = await householdToday();
  return { rows: await Promise.all(rows.map((r) => view(r, today))), total, limit, offset };
}

export interface RoutineDetail extends RoutineView {
  history: WeorcOccurrence[];
}

export async function getRoutineDetail(id: string): Promise<RoutineDetail | null> {
  const routine = await store.getRoutine(id);
  if (!routine) return null;
  const today = await householdToday();
  const base = await view(routine, today);
  const all = await store.listOccurrences({ routineId: id });
  return { ...base, history: all.filter((o) => o.status !== 'due').reverse() };
}

export async function createRoutine(input: CreateRoutineInput): Promise<RoutineView> {
  await assertAnchor(input);
  const routine = await store.createRoutine(input);
  const today = await householdToday();
  await advanceRoutine(routine.id, today);
  return view((await store.getRoutine(routine.id))!, today);
}

export interface UpdateResult extends RoutineView {
  /** True when the open occurrence was left alone because it is already
   *  projected — the change applies from the next cycle instead. */
  openOccurrenceUnchanged: boolean;
}

export async function updateRoutine(id: string, patch: UpdateRoutineInput): Promise<UpdateResult | null> {
  const before = await store.getRoutine(id);
  if (!before) return null;
  await assertAnchor({ ...before, ...patch });
  const routine = await store.updateRoutine(id, patch);
  if (!routine) return null;

  const today = await householdToday();
  const open = await store.getOpenOccurrence(id);
  let unchanged = false;
  if (open) {
    if (open.taskExternalId) {
      // Projected: leave it. The TaskProvider contract has no update method, so
      // moving dueOn locally would leave the To Do task on the old date with
      // nothing to explain it (spec Part D).
      unchanged = true;
    } else {
      const last = await store.lastTerminalOccurrence(id);
      const due = nextDueOn(
        {
          mode: routine.mode as WeorcRoutine['mode'],
          intervalUnit: routine.intervalUnit as never,
          intervalCount: routine.intervalCount,
          anchorDate: routine.anchorDate,
        },
        last ? await terminalDateOf(last) : null,
        today,
      );
      if (due !== open.dueOn) await store.moveOccurrence(open.id, due);
    }
  }
  return { ...(await view((await store.getRoutine(id))!, today)), openOccurrenceUnchanged: unchanged };
}

export async function deleteRoutine(id: string): Promise<boolean> {
  const routine = await store.getRoutine(id);
  if (!routine) return false;
  if (await store.hasTerminalOccurrence(id)) throw new RoutineHasHistoryError();
  return store.deleteRoutine(id);
}

export interface TerminateResult {
  occurrence: WeorcOccurrence;
  next: WeorcOccurrence | null;
  projection: ProjectionOutcome;
}

/**
 * Complete an occurrence. The local record is written FIRST and the provider
 * write-back never fails the request: a dead Graph connection must not stop the
 * household recording that the bins went out (spec Part C).
 */
export async function completeOccurrence(
  id: string, input: { completedAt?: string; note?: string | null }, actingMemberId: string,
): Promise<TerminateResult | null> {
  return terminate(id, 'completed', input.completedAt ? new Date(input.completedAt) : new Date(),
    actingMemberId, input.note ?? null);
}

export async function skipOccurrence(
  id: string, input: { note?: string | null }, actingMemberId: string,
): Promise<TerminateResult | null> {
  return terminate(id, 'skipped', null, actingMemberId, input.note ?? null);
}

async function terminate(
  id: string, status: 'completed' | 'skipped', at: Date | null,
  memberId: string, note: string | null,
): Promise<TerminateResult | null> {
  const occ = await store.getOccurrence(id);
  if (!occ) return null;
  if (occ.status !== 'due') throw new AlreadyTerminalError();

  const terminated = (await store.terminateOccurrence(id, status, at, memberId, note))!;

  let projection: ProjectionOutcome = { ok: false };
  if (status === 'completed' && occ.taskFeedKey && occ.taskExternalId && getTaskProvider()) {
    try {
      await tasks.completeProjectedTask(occ.taskFeedKey, occ.taskExternalId, true);
      projection = { ok: true };
    } catch (e: unknown) {
      if (e instanceof TaskProviderError) projection = { ok: false, reason: e.reason };
      else throw e;
    }
  }

  const today = await householdToday();
  const next = await advanceRoutine(occ.routineId, today);
  if (next && getTaskProvider()) await projectOccurrence(next);

  return { occurrence: terminated, next: next ? await store.getOccurrence(next.id) : null, projection };
}
```

Add the one store function this needs — append to `Heorth/src/modules/weorc/store.ts`:

```ts
/** Move an OPEN occurrence's due date (an unprojected routine was edited). */
export async function moveOccurrence(id: string, dueOn: string): Promise<void> {
  await db.update(weorcOccurrences)
    .set({ dueOn, updatedAt: new Date() })
    .where(eq(weorcOccurrences.id, id));
}
```

- [ ] **Step 5: Write the routes and the module**

Create `Heorth/src/modules/weorc/routes.ts`:

```ts
import { Hono } from 'hono';
import { ok, err } from '@wyrhta/core/http';
import { requireAuth, requireRole } from '../../wiring.js';
import * as service from './service.js';
import * as store from './store.js';
import { runWeorcTick } from './engine.js';
import {
  createRoutineSchema, updateRoutineSchema, listRoutinesQuerySchema,
  listOccurrencesQuerySchema, completeSchema, skipSchema,
} from './validators.js';

export const weorcRouter = new Hono();
weorcRouter.use('*', requireAuth);
// Role-gated only — no maintenance-admin quarantine, which is a
// finance-mutation concern (the same call Ethel made).
const canWrite = requireRole('admin', 'adult');

weorcRouter.get('/routines', async (c) => {
  const q = listRoutinesQuerySchema.safeParse(c.req.query());
  if (!q.success) return err(c, 'VALIDATION_ERROR', 'Invalid query parameters', 400);
  const { rows, total, limit, offset } = await service.listRoutines({
    active: q.data.active === undefined ? undefined : q.data.active === 'true',
    anchorAssetId: q.data.anchor_asset_id,
    anchorPlaceId: q.data.anchor_place_id,
    ownerMemberId: q.data.owner_member_id,
    limit: q.data.limit,
    offset: q.data.offset,
  });
  return ok(c, rows, { total, limit, offset });
});

weorcRouter.post('/routines', canWrite, async (c) => {
  const body = createRoutineSchema.safeParse(await c.req.json());
  if (!body.success) return err(c, 'VALIDATION_ERROR', 'Invalid request body', 400);
  try {
    return ok(c, await service.createRoutine(body.data), undefined, 201);
  } catch (e: unknown) {
    return anchorError(c, e);
  }
});

weorcRouter.get('/routines/:id', async (c) => {
  const row = await service.getRoutineDetail(c.req.param('id'));
  if (!row) return err(c, 'NOT_FOUND', 'Routine not found', 404);
  return ok(c, row);
});

weorcRouter.patch('/routines/:id', canWrite, async (c) => {
  const body = updateRoutineSchema.safeParse(await c.req.json());
  if (!body.success) return err(c, 'VALIDATION_ERROR', 'Invalid request body', 400);
  try {
    const row = await service.updateRoutine(c.req.param('id'), body.data);
    if (!row) return err(c, 'NOT_FOUND', 'Routine not found', 404);
    return ok(c, row);
  } catch (e: unknown) {
    return anchorError(c, e);
  }
});

weorcRouter.delete('/routines/:id', canWrite, async (c) => {
  try {
    const gone = await service.deleteRoutine(c.req.param('id'));
    if (!gone) return err(c, 'NOT_FOUND', 'Routine not found', 404);
    return ok(c, { deleted: true });
  } catch (e: unknown) {
    if (e instanceof service.RoutineHasHistoryError) {
      return err(c, 'ROUTINE_HAS_HISTORY', 'This routine has completion history — deactivate it instead', 409);
    }
    throw e;
  }
});

weorcRouter.get('/occurrences', async (c) => {
  const q = listOccurrencesQuerySchema.safeParse(c.req.query());
  if (!q.success) return err(c, 'VALIDATION_ERROR', 'Invalid query parameters', 400);
  const rows = await store.listOccurrences({
    status: q.data.status, routineId: q.data.routine_id, dueTo: q.data.due_to,
  });
  return ok(c, rows, { total: rows.length });
});

weorcRouter.post('/occurrences/:id/complete', canWrite, async (c) => {
  const body = completeSchema.safeParse(await c.req.json());
  if (!body.success) return err(c, 'VALIDATION_ERROR', 'Invalid request body', 400);
  return terminate(c, () => service.completeOccurrence(c.req.param('id'), body.data, c.get('auth').userId));
});

weorcRouter.post('/occurrences/:id/skip', canWrite, async (c) => {
  const body = skipSchema.safeParse(await c.req.json());
  if (!body.success) return err(c, 'VALIDATION_ERROR', 'Invalid request body', 400);
  return terminate(c, () => service.skipOccurrence(c.req.param('id'), body.data, c.get('auth').userId));
});

weorcRouter.post('/run', canWrite, async (c) => ok(c, await runWeorcTick()));

type Ctx = Parameters<Parameters<typeof weorcRouter.get>[1]>[0];

async function terminate(c: Ctx, run: () => Promise<service.TerminateResult | null>) {
  try {
    const result = await run();
    if (!result) return err(c, 'NOT_FOUND', 'Occurrence not found', 404);
    return ok(c, result);
  } catch (e: unknown) {
    if (e instanceof service.AlreadyTerminalError) {
      return err(c, 'ALREADY_TERMINAL', 'That occurrence is already completed or skipped', 409);
    }
    throw e;
  }
}

function anchorError(c: Ctx, e: unknown) {
  if (e instanceof service.AnchorConflictError) {
    return err(c, 'ANCHOR_CONFLICT', 'A routine anchors to an asset or a place, not both', 400);
  }
  if (e instanceof service.AnchorNotFoundError) {
    return e.kind === 'asset'
      ? err(c, 'ASSET_NOT_FOUND', 'That asset does not exist', 400)
      : err(c, 'PLACE_NOT_FOUND', 'That place does not exist', 400);
  }
  throw e;
}
```

Create `Heorth/src/modules/weorc/index.ts`:

```ts
import type { Hono } from 'hono';
import type { HeorthModule } from '../registry.js';
import { weorcRouter } from './routes.js';

/** Weorc — the household's own recurring work (ADR 0014). A built-in module,
 *  never a satellite: it is the domain most entangled with Tasks, Ethel and
 *  Hearth View at once, which is exactly the shape ADR 0007 says not to
 *  extract. Always on, like Feoh and Ethel. */
export const weorcModule: HeorthModule = {
  name: 'weorc',
  register(app: Hono): void {
    app.route('/api/v1/weorc', weorcRouter);
  },
};
```

In `Heorth/src/modules/index.ts`, import it and add to `ALL_MODULES` after `ethelModule`:

```ts
import { weorcModule } from './weorc/index.js';
```

```ts
  // Weorc: recurring household work — routines, their history, and the one
  // projection engine into the task provider (ADR 0014). Always on.
  weorcModule,
```

- [ ] **Step 6: Run the route tests and watch them pass**

```bash
npx vitest run tests/weorc-routes.test.ts
```

Expected: PASS, 14 tests.

- [ ] **Step 7: Run the whole backend suite**

```bash
npx vitest run
```

Expected: PASS. `tests/module-convention.test.ts` may assert the module list —
if it fails, add `weorc` to its expectation; that is the test doing its job.

- [ ] **Step 8: Commit**

```bash
cd Heorth
git add src/modules/weorc/ src/modules/index.ts tests/weorc-routes.test.ts
git commit -m "feat(weorc): validators, service, routes, module registration

Completion records locally first and never fails on a dead provider - the task
is a projection of the record, not the record. Editing a routine whose open
occurrence is already projected applies from the next cycle and says so, since
TaskProvider has no update method."
```

---

## Task 7: The scheduler

**Files:**
- Create: `Heorth/src/modules/weorc/scheduler.ts`
- Modify: `Heorth/src/index.ts`
- Test: `Heorth/tests/weorc-scheduler.test.ts`

**Interfaces:**
- Produces: `startWeorcScheduler(): SchedulerHandle | null`, `stopWeorcScheduler(): void`

- [ ] **Step 1: Write the failing test**

Create `Heorth/tests/weorc-scheduler.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { startWeorcScheduler, stopWeorcScheduler } from '../src/modules/weorc/scheduler.js';

describe('weorc scheduler', () => {
  it('never starts under tests', () => {
    expect(process.env['VITEST']).toBeDefined();
    expect(startWeorcScheduler()).toBeNull();
    stopWeorcScheduler(); // idempotent, must not throw
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd Heorth
npx vitest run tests/weorc-scheduler.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the scheduler**

Create `Heorth/src/modules/weorc/scheduler.ts`:

```ts
import { logError } from '@wyrhta/core/lib';
import { runWeorcTick } from './engine.js';

/**
 * Weorc's poll loop. Unlike the M365 scheduler this is **NOT gated on
 * `isM365Enabled()`** — materialising due work, completing it and keeping its
 * history are Heorth-native and must run in a household that has no task
 * provider at all (which is every household before Phase 3, and the demo stack
 * permanently).
 *
 * Started from `main()` in `src/index.ts`, which does not run under Vitest;
 * guarded on `VITEST` as well. Tests drive the engine via `runWeorcTick` or
 * `POST /api/v1/weorc/run`.
 *
 * Hourly is deliberate: a chore is day-grained, so a tick that lands within the
 * hour is indistinguishable to a household from one that lands within a second.
 */
const INTERVAL_SECONDS = 3600;

export interface SchedulerHandle {
  stop(): void;
}

let handle: SchedulerHandle | null = null;

export function startWeorcScheduler(): SchedulerHandle | null {
  if (process.env['VITEST'] !== undefined) return null;
  if (handle) return handle; // idempotent

  const tick = () => {
    runWeorcTick().catch((e) => logError('weorc tick failed', e));
  };

  const timer = setInterval(tick, INTERVAL_SECONDS * 1000);
  timer.unref?.();
  const kickoff = setTimeout(tick, 3000);
  kickoff.unref?.();

  handle = {
    stop() {
      clearInterval(timer);
      clearTimeout(kickoff);
      handle = null;
    },
  };
  return handle;
}

export function stopWeorcScheduler(): void {
  handle?.stop();
}
```

- [ ] **Step 4: Wire it into boot**

In `Heorth/src/index.ts`, add the import beside the M365 one:

```ts
import { startWeorcScheduler } from './modules/weorc/scheduler.js';
```

and, in `main()`, immediately after `startM365Scheduler();`:

```ts
  // Weorc's tick. Deliberately NOT gated on the M365 integration: due work is
  // Heorth-native and must keep moving with no task provider attached.
  startWeorcScheduler();
```

- [ ] **Step 5: Run the test and the bootstrap test**

```bash
npx vitest run tests/weorc-scheduler.test.ts tests/bootstrap.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd Heorth
git add src/modules/weorc/scheduler.ts src/index.ts tests/weorc-scheduler.test.ts
git commit -m "feat(weorc): the ungated ticker

Guarded on VITEST only, never on isM365Enabled - due work must keep moving in a
household with no task provider, which is every household before Phase 3."
```

---

## Task 8: Heorth docs

**Files:**
- Modify: `Heorth/AGENTS.md`, `Heorth/README.md`, `Heorth/CHANGELOG.md`

**Why:** the spec (Part E) requires the Weorc↔tasks dependency to be written down as a rule. Ethel's rule is that it never imports feoh; Weorc's is the opposite, by design. Without this, the next reader applies Ethel's rule here and is wrong.

- [ ] **Step 1: Add the module rule**

In `Heorth/AGENTS.md`, under "## Module rules", after the Ethel bullet, add:

```markdown
- **Weorc** (`src/modules/weorc/`, ADR 0014) is **always on** and — unlike Ethel
  — **deliberately depends on other modules.** It imports `tasks`' service
  (`createHouseholdTask`, `completeProjectedTask`, the two lookups) and reads
  Ethel's tables for an anchor's display name. **Do not "fix" this by applying
  Ethel's no-cross-module rule:** Weorc is the domain most entangled with Tasks,
  Ethel and Hearth View at once, which is exactly why ADR 0014 §8 makes it a
  built-in module rather than a satellite. The dependency runs one way —
  Weorc → tasks and Weorc → ethel, never the reverse.
- **Weorc's scheduler is NOT gated on the M365 integration.** `startWeorcScheduler`
  guards on `VITEST` only. Materialising due work, completing it and keeping its
  history are Heorth-native; only the projection pass degrades when no provider
  is installed, and **an absent provider writes no `projectionError`** — it is a
  normal state, not a failure.
- **A missing `task_mirror` row is NOT an upstream deletion.** Weorc's reconcile
  pass leaves an occurrence and its link untouched when the mirrored task cannot
  be found: `setAllowlist` deletes a whole feed's rows, and treating that as a
  deletion would re-project every projected occurrence into a duplicate task.
- **Weorc stores `(taskFeedKey, taskExternalId)`, never `task_mirror.id`** — a
  full resync deletes and re-inserts a feed's rows, so the uuid does not survive
  a 410 recovery.
- **Weorc's "today" is the HOUSEHOLD's**, via `householdToday()`
  (`src/modules/weorc/dates.ts`) → `localDateOf` + `getHouseholdTimeZone`.
  **Not `localTodayIso()`**, which is server-local.
```

- [ ] **Step 2: Document the endpoints in the README**

In `Heorth/README.md`, in the endpoint section, following the format already used
for `/api/v1/ethel`, add a `/api/v1/weorc` block listing the nine routes from
spec Part D with their error codes, plus one paragraph explaining `leadDays` and
the two recurrence modes in household language.

- [ ] **Step 3: Add a CHANGELOG entry**

Follow the file's existing format; note the new module, the two tables, the
ungated scheduler, and the two additions to the tasks service.

- [ ] **Step 4: Commit**

```bash
cd Heorth
git add AGENTS.md README.md CHANGELOG.md
git commit -m "docs(weorc): write down the rules a reader would otherwise get wrong

Weorc depends on tasks and ethel on purpose; its scheduler is ungated; an
absent mirror row is not a deletion; the link is the stable pair, not the uuid;
and its today is the household's, not the server's."
```

---

## Task 9: Web API client

**Files:**
- Create: `Heorth/web/src/api/weorc.ts`, `Heorth/web/src/api/weorc-query.ts`
- Modify: `Heorth/web/src/lib/types.ts`
- Test: `Heorth/web/src/pages/weorc.contract.test.tsx` (written in Task 10)

**Interfaces:**
- Produces: `listRoutines`, `createRoutine`, `getRoutine`, `updateRoutine`, `deleteRoutine`, `listOccurrences`, `completeOccurrence`, `skipOccurrence`, `runWeorc`; types `WeorcRoutine`, `WeorcOccurrence`, `RoutineView`, `RoutineInput`

- [ ] **Step 1: Add the shared types**

In `Heorth/web/src/lib/types.ts`, following the existing Ethel type block:

```ts
export type RoutineMode = 'from_completion' | 'fixed';
export type IntervalUnit = 'day' | 'week' | 'month';
export type OccurrenceStatus = 'due' | 'completed' | 'skipped';

export interface WeorcOccurrence {
  id: string;
  routineId: string;
  dueOn: string;
  status: OccurrenceStatus;
  completedAt: string | null;
  completedByMemberId: string | null;
  note: string | null;
  taskFeedKey: string | null;
  taskExternalId: string | null;
  projectionError: string | null;
}

export interface WeorcRoutine {
  id: string;
  name: string;
  notes: string | null;
  mode: RoutineMode;
  intervalUnit: IntervalUnit;
  intervalCount: number;
  anchorDate: string;
  leadDays: number;
  ownerMemberId: string | null;
  anchorAssetId: string | null;
  anchorPlaceId: string | null;
  active: boolean;
  /** Computed server-side — beyond the lead horizon nothing is materialised. */
  nextDueOn: string;
  openOccurrence: WeorcOccurrence | null;
}

export interface WeorcRoutineDetail extends WeorcRoutine {
  history: WeorcOccurrence[];
}

export interface ProjectionOutcome { ok: boolean; reason?: string }

export interface TerminateResult {
  occurrence: WeorcOccurrence;
  next: WeorcOccurrence | null;
  projection: ProjectionOutcome;
}
```

- [ ] **Step 2: Write the query mirror**

Create `Heorth/web/src/api/weorc-query.ts`:

```ts
import { z } from 'zod';

/**
 * Mirror of the server's query contract for GET /api/v1/weorc/routines and
 * /occurrences — `listRoutinesQuerySchema` / `listOccurrencesQuerySchema` in
 * `src/modules/weorc/validators.ts`.
 *
 * web/ and the backend are independent dependency trees, so the contract cannot
 * be imported across that boundary. It is stated on both sides and pinned on
 * both. Change one side, change both.
 */
export const listRoutinesQuerySchema = z.object({
  active: z.enum(['true', 'false']).optional(),
  anchor_asset_id: z.string().uuid().optional(),
  anchor_place_id: z.string().uuid().optional(),
  owner_member_id: z.string().uuid().optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const listOccurrencesQuerySchema = z.object({
  status: z.enum(['due', 'completed', 'skipped']).optional(),
  routine_id: z.string().uuid().optional(),
  due_to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
```

- [ ] **Step 3: Write the client**

Create `Heorth/web/src/api/weorc.ts`:

```ts
import { apiGet, apiPost, apiPatch, apiDelete, qs } from './client';
import type {
  ListResponse, SingleResponse, WeorcRoutine, WeorcRoutineDetail,
  WeorcOccurrence, TerminateResult, RoutineMode, IntervalUnit, OccurrenceStatus,
} from '@/lib/types';

export interface RoutineInput {
  name: string;
  notes?: string | null;
  mode: RoutineMode;
  intervalUnit: IntervalUnit;
  intervalCount: number;
  anchorDate: string;
  leadDays?: number;
  ownerMemberId?: string | null;
  anchorAssetId?: string | null;
  anchorPlaceId?: string | null;
}

/** Query keys are snake_case on the wire, as the tasks module's already are. */
export function listRoutines(
  params: {
    active?: 'true' | 'false';
    anchor_asset_id?: string;
    anchor_place_id?: string;
    owner_member_id?: string;
    limit?: number;
    offset?: number;
  } = {},
): Promise<ListResponse<WeorcRoutine>> {
  return apiGet(`/weorc/routines${qs(params)}`);
}

export function createRoutine(input: RoutineInput): Promise<SingleResponse<WeorcRoutine>> {
  return apiPost('/weorc/routines', input);
}

export function getRoutine(id: string): Promise<SingleResponse<WeorcRoutineDetail>> {
  return apiGet(`/weorc/routines/${id}`);
}

export function updateRoutine(
  id: string, input: Partial<RoutineInput> & { active?: boolean },
): Promise<SingleResponse<WeorcRoutine & { openOccurrenceUnchanged: boolean }>> {
  return apiPatch(`/weorc/routines/${id}`, input);
}

export function deleteRoutine(id: string): Promise<SingleResponse<{ deleted: boolean }>> {
  return apiDelete(`/weorc/routines/${id}`);
}

/** `due_to=<today>` is how the page asks for what is ACTUALLY due, as opposed
 *  to everything open — which, inside a lead window, includes work due later. */
export function listOccurrences(
  params: { status?: OccurrenceStatus; routine_id?: string; due_to?: string } = {},
): Promise<ListResponse<WeorcOccurrence>> {
  return apiGet(`/weorc/occurrences${qs(params)}`);
}

export function completeOccurrence(
  id: string, input: { completedAt?: string; note?: string | null } = {},
): Promise<SingleResponse<TerminateResult>> {
  return apiPost(`/weorc/occurrences/${id}/complete`, input);
}

export function skipOccurrence(
  id: string, input: { note?: string | null } = {},
): Promise<SingleResponse<TerminateResult>> {
  return apiPost(`/weorc/occurrences/${id}/skip`, input);
}
```

- [ ] **Step 4: Typecheck**

```bash
cd Heorth/web
npm run typecheck
```

Expected: clean. If `apiDelete` or `qs` are named differently, read
`web/src/api/client.ts` and use the real names.

- [ ] **Step 5: Commit**

```bash
cd Heorth
git add web/src/api/weorc.ts web/src/api/weorc-query.ts web/src/lib/types.ts
git commit -m "feat(web): weorc API client and its query mirror"
```

---

## Task 10: The web page

**Files:**
- Create: `Heorth/web/src/pages/weorc.tsx`, `Heorth/web/src/components/weorc/routine-form.tsx`, `Heorth/web/src/components/weorc/occurrence-list.tsx`
- Create: `Heorth/web/src/pages/weorc.test.tsx`, `Heorth/web/src/pages/weorc.de.test.tsx`, `Heorth/web/src/pages/weorc.contract.test.tsx`
- Modify: `Heorth/web/src/app.tsx`, `Heorth/web/src/i18n/locales/en.json`, `Heorth/web/src/i18n/locales/de.json`, the nav component under `web/src/components/layout/`

**Interfaces:**
- Consumes: Task 9's client; `listAssets` / `listPlaces` from `@/api/ethel` for the anchor picker

- [ ] **Step 1: Read two existing pages first**

Read `Heorth/web/src/pages/ethel.tsx` and `Heorth/web/src/pages/ethel.test.tsx`
end to end before writing anything. Match their structure, their data-fetching
idiom, their loading/error handling and their test idiom exactly. Do not
introduce a new state-management or fetching pattern.

- [ ] **Step 2: Add both locale catalogues**

Add a `weorc` block to `en.json` and the mirrored block to `de.json`. **Weorc
stays untranslated in both**, following Feoh and Ethel; "chore"/"Hausarbeit" is
the gloss in explanatory copy only.

`en.json`:

```json
"weorc": {
  "title": "Weorc",
  "subtitle": "The household's recurring work — the chores.",
  "dueNow": "Due now",
  "comingUp": "Coming up",
  "routines": "Routines",
  "history": "History",
  "nothingDue": "Nothing is due.",
  "complete": "Done",
  "skip": "Skip",
  "skipped": "Skipped",
  "completedOn": "Done {{date}}",
  "nextDue": "Next due {{date}}",
  "anchorNone": "Not tied to a thing",
  "anchorAsset": "Asset",
  "anchorPlace": "Place",
  "modeFromCompletion": "Every {{count}} {{unit}} after it was last done",
  "modeFixed": "Every {{count}} {{unit}}, on a fixed schedule",
  "leadDays": "Show it this many days early",
  "deactivate": "Deactivate",
  "inactive": "Inactive",
  "editAppliesNextCycle": "This routine is already in your task list, so the change applies from the next time it comes round.",
  "projectionProblem": "Couldn't reach your task list — the chore is still recorded here.",
  "hasHistory": "This routine has history. Deactivate it instead of deleting it.",
  "anchorMissing": "The thing this was tied to is gone. Pick another."
}
```

`de.json`:

```json
"weorc": {
  "title": "Weorc",
  "subtitle": "Die wiederkehrende Arbeit im Haushalt — die Hausarbeit.",
  "dueNow": "Jetzt fällig",
  "comingUp": "Demnächst",
  "routines": "Routinen",
  "history": "Verlauf",
  "nothingDue": "Nichts fällig.",
  "complete": "Erledigt",
  "skip": "Überspringen",
  "skipped": "Übersprungen",
  "completedOn": "Erledigt am {{date}}",
  "nextDue": "Nächste Fälligkeit {{date}}",
  "anchorNone": "Nicht an eine Sache gebunden",
  "anchorAsset": "Gegenstand",
  "anchorPlace": "Ort",
  "modeFromCompletion": "Alle {{count}} {{unit}} nach der letzten Erledigung",
  "modeFixed": "Alle {{count}} {{unit}}, nach festem Plan",
  "leadDays": "So viele Tage vorher anzeigen",
  "deactivate": "Deaktivieren",
  "inactive": "Inaktiv",
  "editAppliesNextCycle": "Diese Routine steht schon in der Aufgabenliste — die Änderung gilt ab dem nächsten Durchlauf.",
  "projectionProblem": "Die Aufgabenliste war nicht erreichbar — hier ist die Erledigung trotzdem vermerkt.",
  "hasHistory": "Diese Routine hat einen Verlauf. Deaktiviere sie, statt sie zu löschen.",
  "anchorMissing": "Die zugehörige Sache existiert nicht mehr. Bitte neu zuordnen."
}
```

- [ ] **Step 3: Write the failing page test**

Create `Heorth/web/src/pages/weorc.test.tsx`. Take the mocking idiom from
`ethel.test.tsx` — the same `vi.mock` of the api module and the same render
helper (call it `renderWeorc()` here). The eight cases below are the required
coverage; write every one, in full.

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as api from '@/api/weorc';

vi.mock('@/api/weorc');

const TODAY = '2026-08-25';
const routine = (over = {}) => ({
  id: 'r1', name: 'Put the bins out', notes: null, mode: 'fixed',
  intervalUnit: 'week', intervalCount: 1, anchorDate: TODAY, leadDays: 0,
  ownerMemberId: null, anchorAssetId: null, anchorPlaceId: null, active: true,
  nextDueOn: TODAY, openOccurrence: null, ...over,
});
const occurrence = (over = {}) => ({
  id: 'o1', routineId: 'r1', dueOn: TODAY, status: 'due', completedAt: null,
  completedByMemberId: null, note: null, taskFeedKey: null,
  taskExternalId: null, projectionError: null, ...over,
});
const listing = (...rows: unknown[]) => ({ data: rows, meta: { total: rows.length } });

describe('the Weorc page', () => {
  beforeEach(() => vi.resetAllMocks());

  it('shows work due today under "Due now"', async () => {
    vi.mocked(api.listRoutines).mockResolvedValue(listing(routine({ openOccurrence: occurrence() })) as never);
    renderWeorc();
    await screen.findByText('Put the bins out');
    expect(within(screen.getByTestId('due-now')).getByText('Put the bins out')).toBeInTheDocument();
  });

  it('puts lead-window work under "Coming up", NOT under "Due now"', async () => {
    // A boiler service materialised 14 days early is not due today. Showing it
    // as due is the exact failure this test exists to prevent.
    const later = occurrence({ id: 'o2', dueOn: '2026-09-08' });
    vi.mocked(api.listRoutines).mockResolvedValue(listing(routine({ name: 'Service the boiler', openOccurrence: later })) as never);
    renderWeorc();
    await screen.findByText('Service the boiler');
    expect(within(screen.getByTestId('coming-up')).getByText('Service the boiler')).toBeInTheDocument();
    expect(within(screen.getByTestId('due-now')).queryByText('Service the boiler')).toBeNull();
  });

  it('ticking one calls completeOccurrence and clears it from Due now', async () => {
    vi.mocked(api.listRoutines).mockResolvedValue(listing(routine({ openOccurrence: occurrence() })) as never);
    vi.mocked(api.completeOccurrence).mockResolvedValue({
      data: {
        occurrence: occurrence({ status: 'completed', completedAt: '2026-08-25T09:00:00Z' }),
        next: null, projection: { ok: true },
      },
    } as never);
    renderWeorc();
    await userEvent.click(await screen.findByRole('button', { name: /done/i }));
    expect(api.completeOccurrence).toHaveBeenCalledWith('o1', expect.anything());
    await waitFor(() => {
      expect(within(screen.getByTestId('due-now')).queryByText('Put the bins out')).toBeNull();
    });
  });

  it('skipping calls skipOccurrence', async () => {
    vi.mocked(api.listRoutines).mockResolvedValue(listing(routine({ openOccurrence: occurrence() })) as never);
    vi.mocked(api.skipOccurrence).mockResolvedValue({
      data: { occurrence: occurrence({ status: 'skipped' }), next: null, projection: { ok: false } },
    } as never);
    renderWeorc();
    await userEvent.click(await screen.findByRole('button', { name: /skip/i }));
    expect(api.skipOccurrence).toHaveBeenCalledWith('o1', expect.anything());
  });

  it('renders an UNPROJECTED occurrence plainly — no error styling anywhere', async () => {
    // In the demo stack EVERY occurrence is unprojected, permanently. Treating
    // that as a fault would make the whole page look broken.
    vi.mocked(api.listRoutines).mockResolvedValue(listing(routine({ openOccurrence: occurrence() })) as never);
    renderWeorc();
    await screen.findByText('Put the bins out');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText(/couldn't reach your task list/i)).toBeNull();
  });

  it('surfaces a projection problem quietly, and still shows the chore as due', async () => {
    const failed = occurrence({ projectionError: 'needs_reauth' });
    vi.mocked(api.listRoutines).mockResolvedValue(listing(routine({ openOccurrence: failed })) as never);
    renderWeorc();
    expect(await screen.findByText(/couldn't reach your task list/i)).toBeInTheDocument();
    expect(within(screen.getByTestId('due-now')).getByText('Put the bins out')).toBeInTheDocument();
  });

  it('creates a routine with NO anchor — the normal case', async () => {
    vi.mocked(api.listRoutines).mockResolvedValue(listing() as never);
    vi.mocked(api.createRoutine).mockResolvedValue({ data: routine() } as never);
    renderWeorc();
    await userEvent.click(await screen.findByRole('button', { name: /new routine/i }));
    await userEvent.type(screen.getByLabelText(/name/i), 'Change the bedding');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(api.createRoutine).toHaveBeenCalled());
    expect(vi.mocked(api.createRoutine).mock.calls[0]![0]).toMatchObject({
      name: 'Change the bedding', anchorAssetId: null, anchorPlaceId: null,
    });
  });

  it('tells the maker when an edit only applies from the next cycle', async () => {
    const projected = occurrence({ taskFeedKey: 'todo:member:m:l', taskExternalId: 'ext-1' });
    vi.mocked(api.listRoutines).mockResolvedValue(listing(routine({ openOccurrence: projected })) as never);
    vi.mocked(api.updateRoutine).mockResolvedValue({
      data: { ...routine(), openOccurrenceUnchanged: true },
    } as never);
    renderWeorc();
    await userEvent.click(await screen.findByRole('button', { name: /edit/i }));
    await userEvent.clear(screen.getByLabelText(/every/i));
    await userEvent.type(screen.getByLabelText(/every/i), '2');
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    expect(await screen.findByText(/applies from the next time it comes round/i)).toBeInTheDocument();
  });
});
```

The page must therefore expose `data-testid="due-now"` and
`data-testid="coming-up"` on those two sections — the split is the behaviour
being pinned, and querying by heading text alone would not survive translation.

**One decision to take while building the page.** The `anchorMissing` string in
both catalogues has no test above, because a routine cannot distinguish "never
had an anchor" from "its anchor was deleted" out of these columns alone. Take
the cheap honest option: **delete `anchorMissing` from both locale catalogues**
rather than shipping a string no code can render. Recording which routines used
to have an anchor is a schema change and is out of scope for this slice.



- [ ] **Step 4: Run it and watch it fail**

```bash
cd Heorth/web
npx vitest run src/pages/weorc.test.tsx
```

Expected: FAIL — page module not found.

- [ ] **Step 5: Build the page and its two components**

`weorc.tsx` renders, in order: **Due now** (open occurrences with `dueOn <= today`),
**Coming up** (open occurrences with `dueOn > today`), **Routines** (create,
edit, deactivate), and per-routine **History**.

`routine-form.tsx`: name, notes, mode, interval unit + count, anchor date,
`leadDays`, optional owner, and an optional anchor picker offering Ethel assets
and places (mutually exclusive — the form must not let both be set, since the
server answers `ANCHOR_CONFLICT`).

**When the chosen anchor is an asset carrying `serviceIntervalMonths`, prefill
the interval with it** (mode `from_completion`, unit `month`). It is a default
the maker can overwrite — never a trigger. This is the whole point of ADR 0013
keeping that field as documentation. Read it from `getAsset(id)`, whose
single-asset response inlines `vehicle` and `facility`.

`occurrence-list.tsx`: rows with tick and skip, the overdue/today distinction,
and the quiet projection notice.

- [ ] **Step 6: Register the route and the nav entry**

In `web/src/app.tsx`, beside `ethelRoute`:

```ts
const weorcRoute = createRoute({ getParentRoute: () => authRoute, path: '/weorc', component: WeorcPage });
```

Import `WeorcPage from '@/pages/weorc'` and add `weorcRoute` to
`authRoute.addChildren([...])`. Add the nav entry beside Ethel's in the layout
nav component.

- [ ] **Step 7: Write the German and contract tests**

`weorc.de.test.tsx` mirrors `ethel.de.test.tsx`: render under the `de` locale
and assert the German strings appear and that **"Weorc" is NOT translated**.

`weorc.contract.test.tsx` mirrors `ethel.contract.test.tsx`: capture the page's
real requests and validate their query strings against `weorc-query.ts`.

- [ ] **Step 8: Run the whole web suite**

```bash
cd Heorth/web
npm test
```

Expected: PASS, including `src/i18n/catalog-parity.test.ts` — it will fail if
the two catalogues disagree, which is it doing its job.

- [ ] **Step 9: Commit**

```bash
cd Heorth
git add web/src/pages/weorc.tsx web/src/pages/weorc.test.tsx web/src/pages/weorc.de.test.tsx web/src/pages/weorc.contract.test.tsx web/src/components/weorc/ web/src/app.tsx web/src/components/layout/ web/src/i18n/locales/
git commit -m "feat(web): the Weorc page

Due now is dueOn <= today; work materialised inside a lead window sits under
Coming up rather than pretending to be due. An unprojected occurrence renders
plainly - in the demo stack that is every occurrence, permanently."
```

---

## Task 11: heorth-mcp tools

**Repo: `heorth-mcp/` — a separate repo and a separate commit.**

**Files:**
- Create: `heorth-mcp/src/tools/weorc.ts`
- Modify: `heorth-mcp/src/tools/index.ts`, `heorth-mcp/docs/spec/tool-surface.md`
- Test: `heorth-mcp/tests/tools.weorc.test.ts`

**Interfaces:**
- Produces: `weorcTools: McpTool[]` — exactly seven tools, in this order: `weorc.list_routines`, `weorc.record_routine`, `weorc.update_routine`, `weorc.delete_routine`, `weorc.list_due`, `weorc.complete_occurrence`, `weorc.skip_occurrence`

- [ ] **Step 1: Read the repo's rules and the ethel tool file**

Read `heorth-mcp/AGENTS.md` (and `CLAUDE.md`) and `src/tools/ethel.ts` in full.
Match them: a pure REST client, **no re-implemented validation**, no role gate
(the REST routes gate themselves and `McpPrincipal.userId` is only a key
fingerprint), upstream error codes passed through unchanged.

- [ ] **Step 2: Write the failing test**

Create `heorth-mcp/tests/tools.weorc.test.ts`, reusing the harness from
`tests/tools.ethel.test.ts` verbatim — the `tool()` and `call()` helpers and
`createFakeUpstream` — with `weorcTools` swapped in for `ethelTools`.

```ts
import { describe, it, expect } from 'vitest';
import { weorcTools } from '../src/tools/weorc.js';
import { HeorthClient } from '../src/upstream/heorth.js';
import type { McpTool, McpToolContext } from '../src/mcp/types.js';
import { createFakeUpstream, type ScriptedResponse } from './helpers/fake-upstream.js';

const CALLER = 'Bearer he_test';

function tool(name: string): McpTool {
  const found = weorcTools.find((t) => t.name === name);
  if (!found) throw new Error(`no such tool: ${name}`);
  return found;
}

async function call(
  name: string,
  input: Record<string, unknown>,
  ...script: ScriptedResponse[]
) {
  const fake = createFakeUpstream(...script);
  const heorth = new HeorthClient({ baseUrl: 'http://heorth.test', authorization: CALLER, fetch: fake.fetch });
  const ctx: McpToolContext = { principal: { userId: 'fingerprint' }, requestId: 'req-1', upstreams: { heorth } };
  const res = await tool(name).handler(ctx, input);
  const request = fake.requests[0];
  return {
    request,
    text: res.content[0]?.text ?? '',
    body: request?.body ? JSON.parse(request.body) : undefined,
  };
}

describe('weorc tool registry', () => {
  it('exposes the seven frozen tool names, in order', () => {
    expect(weorcTools.map((t) => t.name)).toEqual([
      'weorc.list_routines',
      'weorc.record_routine',
      'weorc.update_routine',
      'weorc.delete_routine',
      'weorc.list_due',
      'weorc.complete_occurrence',
      'weorc.skip_occurrence',
    ]);
  });
});

describe('weorc tools', () => {
  it('sends `active` as the STRING true/false', async () => {
    // Heorth reads z.enum(['true','false']), never a coerced boolean, because
    // Boolean('false') is true.
    const { request } = await call('weorc.list_routines', { active: false },
      { status: 200, body: { data: [], meta: { total: 0 } } });
    expect(request!.url).toContain('active=false');
  });

  it('POSTs a routine body through unchanged', async () => {
    const input = {
      name: 'Put the bins out', mode: 'fixed', intervalUnit: 'week',
      intervalCount: 1, anchorDate: '2026-09-01',
    };
    const { request, body } = await call('weorc.record_routine', input,
      { status: 201, body: { data: { id: 'r1', ...input } } });
    expect(request!.method).toBe('POST');
    expect(request!.url).toContain('/weorc/routines');
    expect(body).toMatchObject(input);
  });

  it('list_due asks for open occurrences', async () => {
    const { request } = await call('weorc.list_due', {},
      { status: 200, body: { data: [], meta: { total: 0 } } });
    expect(request!.url).toContain('/weorc/occurrences');
    expect(request!.url).toContain('status=due');
  });

  it('complete_occurrence REPORTS the projection outcome', async () => {
    // A conversational caller has no other way to learn that the completion was
    // recorded but the write-back to To Do failed.
    const { text } = await call('weorc.complete_occurrence', { id: 'o1' }, {
      status: 200,
      body: {
        data: {
          occurrence: { id: 'o1', status: 'completed' },
          next: { id: 'o2', dueOn: '2026-09-08' },
          projection: { ok: false, reason: 'needs_reauth' },
        },
      },
    });
    expect(text).toContain('needs_reauth');
  });

  it('passes an upstream ROUTINE_HAS_HISTORY through unchanged', async () => {
    const { text } = await call('weorc.delete_routine', { id: 'r1' }, {
      status: 409,
      body: { error: { code: 'ROUTINE_HAS_HISTORY', message: 'This routine has completion history' } },
    });
    expect(text).toContain('ROUTINE_HAS_HISTORY');
  });

  it('passes an upstream ANCHOR_CONFLICT through unchanged', async () => {
    const { text } = await call('weorc.record_routine', {
      name: 'Bad', mode: 'fixed', intervalUnit: 'week', intervalCount: 1,
      anchorDate: '2026-09-01', anchorAssetId: '11111111-1111-1111-1111-111111111111',
      anchorPlaceId: '22222222-2222-2222-2222-222222222222',
    }, {
      status: 400,
      body: { error: { code: 'ANCHOR_CONFLICT', message: 'A routine anchors to an asset or a place, not both' } },
    });
    expect(text).toContain('ANCHOR_CONFLICT');
  });
});
```

If `createFakeUpstream`'s scripted-response shape or the error-propagation idiom
differs from the above, **follow `tools.ethel.test.ts`** — it is the authority
here, not this plan.

- [ ] **Step 3: Run it and watch it fail**

```bash
cd heorth-mcp
npx vitest run tests/tools.weorc.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 4: Write the tools**

Create `heorth-mcp/src/tools/weorc.ts` following `ethel.ts` exactly: the local
`result()`, `Envelope<T>`, `heorth()` and `flag()` helpers, the mirrored const
tuples with a comment naming their Heorth source, and one entry per tool.

Two descriptions must carry a specific note, because an agent will otherwise
infer the opposite:

```ts
/** Two things an agent must not infer. Weorc holds the DEFINITION and the
 *  history; the thing a member ticks off day to day is a Task in the external
 *  task service (ADR 0001), so this is not where you look for today's list. And
 *  an occurrence that is not projected is NORMAL — a household with no task
 *  provider still has chores. */
const NOT_A_TASK_LIST_NOTE =
  'Weorc holds recurring definitions and their history. The day-to-day list a member works from is Tasks, not this.';

const UNPROJECTED_NOTE =
  'An occurrence with no linked task is normal: the household may have no task provider connected. It is still due and still completable here.';
```

- [ ] **Step 5: Register them**

In `heorth-mcp/src/tools/index.ts`, import `weorcTools` and add
`...weorcTools,` to the `config.heorth` branch after `...ethelTools`. Update the
counting comment in that file's docblock (43 Heorth tools becomes 50).

- [ ] **Step 6: Run the full mcp suite**

```bash
cd heorth-mcp
npx vitest run
```

Expected: PASS. `tests/mcp.server.test.ts` may assert a total tool count — if it
fails, update the expectation; that is the test doing its job.

- [ ] **Step 7: Document the surface**

Add a `### weorc (7) — mounted at /api/v1/weorc` section to
`heorth-mcp/docs/spec/tool-surface.md`, in the same table format as the `ethel`
section: tool, verified REST, params, notes with the exact error codes.

- [ ] **Step 8: Commit (in heorth-mcp)**

```bash
cd heorth-mcp
git add src/tools/weorc.ts src/tools/index.ts tests/tools.weorc.test.ts docs/spec/tool-surface.md
git commit -m "feat(weorc): seven weorc.* tools

Pure REST client per ADR 0008 - upstream codes pass through unchanged and no
validation is re-implemented. complete_occurrence reports the projection
outcome, because a conversational caller has no other way to learn the
completion was recorded but the write-back to To Do failed."
```

---

## Task 12: Demo seed and meta-repo docs

**Repo: the meta repo (`Wyrhta/`) — a separate commit. Never stage `Heorth/` or `heorth-mcp/` here; both are git-ignored.**

**Files:**
- Modify: `deploy/seed-demo.mjs`, `docs/strategy.md`, `CONTEXT.md`, `docs/IDEAS.md`

- [ ] **Step 1: Read the seed's existing idiom**

Read the `--- ethel: places ---` through `--- ethel: detail rows ---` blocks in
`deploy/seed-demo.mjs`. Match the idempotence pattern exactly: read what exists,
create only what is missing, count the verdict.

- [ ] **Step 2: Add the Weorc block**

After the ethel detail-rows block, seed four routines:

```js
  // --- weorc: routines -----------------------------------------------------
  // ADR 0015 §4 makes the seeded demo household this slice's acceptance check,
  // so the seed must show the ANCHORED and UNANCHORED cases side by side: that
  // one-kind-of-row claim is the whole bet of ADR 0014.
  const routines = [
    { name: 'Put the bins out', mode: 'fixed', intervalUnit: 'week', intervalCount: 1, leadDays: 0, anchor: null },
    { name: 'Change the bedding', mode: 'fixed', intervalUnit: 'week', intervalCount: 2, leadDays: 0, anchor: null },
    { name: 'Service the boiler', mode: 'from_completion', intervalUnit: 'month', intervalCount: 12, leadDays: 14, anchor: { asset: 'Gas boiler' } },
    { name: 'Descale the kettle', mode: 'from_completion', intervalUnit: 'month', intervalCount: 2, leadDays: 0, anchor: { place: 'Kitchen' } },
  ];
```

Use the real seeded asset and place names from the ethel blocks above — read
them, do not guess. Resolve each anchor to its id, POST to
`/api/v1/weorc/routines`, then `POST /api/v1/weorc/run` once so the occurrences
materialise. Complete one bins occurrence via
`POST /api/v1/weorc/occurrences/:id/complete` so the history is not empty on
first look.

- [ ] **Step 3: Run the demo stack end to end**

```bash
cd deploy
./demo-up.sh
node seed-demo.mjs
node seed-demo.mjs   # twice — it must be idempotent
```

Expected: the second run reports no new creations. Open the web UI, go to
**Weorc**, and confirm: the bins chore is due, the boiler is anchored to the
facility, one bins occurrence is in the history, and **nothing shows an error**
despite there being no task provider anywhere in the demo stack.

- [ ] **Step 4: Update the three docs**

- `docs/strategy.md` Phase 4: mark Weorc's first slice **shipped**, link this
  plan and the spec, and confirm Phase 3 deployment is now the next thing —
  per ADR 0015 §5 there is **no second pre-deployment slice** without a new ADR.
- `CONTEXT.md`: update **Weorc**, **Routine** and **Maintenance Plan** from
  "holds a name and no code" to what actually shipped; add **Occurrence** as an
  entry (_Avoid_: instance, todo, task).
- `docs/IDEAS.md`: update the ADR 0014 bullet — it currently ends "No `plans/`
  doc and no code yet."

- [ ] **Step 5: Commit (in the meta repo)**

```bash
cd /c/Users/ChristianFoellmann/projects/Wyrhta
git add deploy/seed-demo.mjs docs/strategy.md CONTEXT.md docs/IDEAS.md
git commit -m "feat(demo): seed Weorc routines, and record the slice as shipped

Two unanchored chores beside two anchored ones, because the one-kind-of-row
claim is the whole bet of ADR 0014 and the demo household is this slice's
acceptance check (ADR 0015 §4). Phase 3 deployment is next: per ADR 0015 §5 a
second pre-deployment slice would need its own ADR."
```

- [ ] **Step 6: Report the commits per repo**

State plainly which commits landed in `Heorth`, which in `heorth-mcp`, and which
in the meta repo. Three repos, three streams — never one commit.

---

## Final verification

- [ ] **Backend suite green**

```bash
cd Heorth
export DATABASE_URL=postgres://heorth:changeme@localhost:5432/heorth_test
npm run typecheck && npm run build && npx vitest run
```

- [ ] **Web suite green**

```bash
cd Heorth/web && npm run typecheck && npm test
```

- [ ] **MCP suite green**

```bash
cd heorth-mcp && npm run typecheck && npx vitest run
```

- [ ] **Demo stack seeded twice, idempotently, and inspected in the browser**

- [ ] **Paste actual command output for each** before claiming completion. A
  suite you did not run is not a suite that passed.
