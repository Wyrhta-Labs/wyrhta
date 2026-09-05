# Feoh Bank Ingestion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship ADR 0016's first slice — Heorth pulls bank lines from the Firefly III sidecar through a two-method ingestion provider, applies household-owned rules, books what it can through the existing ledger, and parks the rest in an inbox a member clears from the Feoh page.

**Architecture:** A new sub-area `src/modules/feoh/import/` inside the always-on Feoh module. Four `feoh_import_*` tables; none of the eight existing Feoh tables changes. A `TransactionSourceProvider` seam (`listSince`, `listAccounts`) with Firefly as the only implementation and an in-memory fake for tests. One scheduler tick pulls pages, dedups on `source_id`, books through `recordTransaction()` — the importer gets no second write path into `postings` — and advances the cursor only after a whole page is durably written. Firefly is optional per deployment behind `FEOH_IMPORT_ENABLED`; inbox, rules and confirmations work without it.

**Tech Stack:** Node.js 22/24, TypeScript (ESM, `.js` import specifiers), Hono, Drizzle ORM, PostgreSQL 18, Zod, Vitest. Web: React, TanStack Query, i18next. Meta repo: Docker Compose, `deploy/seed-demo.mjs` (plain Node, REST only).

**Spec:** [`docs/superpowers/specs/2026-08-28-feoh-bank-ingestion-design.md`](../specs/2026-08-28-feoh-bank-ingestion-design.md) and [ADR 0016](../../decisions/0016-bank-ingestion-behind-an-ingestion-provider.md) — read both alongside this plan; the plan argues from them.

## Global Constraints

- **Two repos, two commit streams.** `Heorth/` (module, schema, tests, migration, web) and the meta repo (`deploy/`, docs). `Heorth/` is git-ignored in the meta repo. **Never stage a sibling folder in the meta repo's index.** One change, one repo, one commit. Report commits per repo.
- **Read `Heorth/AGENTS.md` before touching Heorth** and follow it; its conventions win inside it.
- **Heorth is REST-only (ADR 0008). No MCP tool, in Heorth or in heorth-mcp, in this slice** (spec §5: "No MCP growth in this slice").
- **Booking goes through `recordTransaction(input, createdBy)` in `src/modules/feoh/service.ts` — always.** No direct insert into `transactions` or `postings` anywhere under `import/`. This is the single most important invariant of the design.
- **One-way.** The provider interface has no create/update/delete. Deletions and edits in Firefly are ignored; first read wins; rule changes re-evaluate `pending` rows only.
- **Never log or persist a Firefly response body, URL with token, or the PAT.** `last_error` holds only one of: `no_credentials`, `auth_failed`, `network_error`, `rate_limited`, `bad_response`, `error`.
- **Cursor advances only after every row of a page is durably written.** Dedup is keyed on `feoh_imported_transactions.source_id` (UNIQUE), so replay is free.
- **Single currency.** A row whose `currency` differs from `config.feohCurrency` is never booked, by the tick or by a member.
- **Schema registration is two places:** `src/db/schema/drizzle-schema.ts` (no `.js`) and `src/db/schema/index.ts` (`.js`). Generate the migration with `npm run db:generate -- --name feoh_import`; never hand-edit snapshots.
- **Never classify a query failure by reading `e.code`.** Use `pgErrorCode` / `isPgError` from `@wyrhta/core/db`, in src and tests.
- **Never derive a date from `toISOString()`.** Firefly's `date` is an ISO datetime with offset; take its first 10 characters (the calendar date Firefly stores). Overlap arithmetic uses `Date.UTC` getters and manual formatting.
- **Tests hit a real Postgres and truncate every table per test.** `DATABASE_URL` MUST end in `_test`. Never call a real external service from a test — install `FakeSource` through `setTransactionSourceProvider`.
- **The scheduler never runs under tests** — guard on `VITEST`; drive ticks via `POST /api/v1/feoh/ingestion/sync` or `runImportTick()`.
- **Finance write gate:** every mutation route under `/api/v1/feoh/ingestion/*` uses the feoh router's `canWrite` (role `admin`/`adult` + maintenance-admin quarantine). Reads are `requireAuth` only (inherited from `feohRouter`).
- **i18n:** every new UI string exists in both `web/src/i18n/locales/en.json` and `de.json` with identical keys and placeholders (`catalog-parity.test.ts` enforces it). "Feoh" and "Firefly III" are proper names, untranslated.
- **Git:** GitHub operations go through `gh`. **Never add a Claude/AI co-author trailer.** Commit messages end with the session trailer the harness supplies.

## Decisions this plan settles (spec left them open or implicit)

1. **Household currency = `FEOH_CURRENCY`** (ISO 4217, default `EUR`). Feoh has no currency column and the household row has only `timezone`/`locale`, so the comparison target has to come from somewhere; an env knob is the cheapest honest answer and is independent of the import group (confirming seeded demo rows needs it with import off).
2. **Env group:** `FEOH_IMPORT_ENABLED` (`true`/`false`, blank = false). When `true`, `FIREFLY_BASE_URL` and `FIREFLY_PAT` are both required — missing either is a startup error. When `false`, `FIREFLY_*` may be set or blank (compose passes defaults). `config.feohImport` is `{ baseUrl, pat } | null`.
3. **Overlap belongs to the provider, and the cursor stays opaque.** Spec §3 step 1 has the *caller* subtract the overlap window, which contradicts "the cursor is the provider's to define". Resolution: `SourcePage` gains a third field, `checkpoint: string` — the watermark to persist once a sweep completes, already re-windowed by the provider (Firefly: last seen date minus 7 days). `nextCursor` keeps its spec meaning (null = sweep complete). The sync persists `nextCursor` mid-sweep and `checkpoint` at the end.
4. **Routes mount under `/api/v1/feoh/ingestion/*`** — `POST /api/v1/feoh/import` is already the CSV import, so the spec's "import" cannot be the path.
5. **Manual inbox lines exist:** `POST /api/v1/feoh/ingestion/inbox` inserts a `pending` row with `source_id = manual:<id>` through the same `ingest()` pipeline (rule hit books it). It is how `seed-demo.mjs` fills the demo inbox over REST (spec §5) and doubles as "type in a paper receipt". No other write into the inbox exists.
6. **Firefly transfers are skipped.** Only `withdrawal` and `deposit` journal lines become inbox rows; a transfer between two of the household's own accounts has no envelope side and is out of scope for the first slice.
7. **Payee/memo mapping:** Firefly has no payee field. `payee` = the counterparty account name (`destination_name` for a withdrawal, `source_name` for a deposit), falling back to `description`; `memo` = `description` when it differs from the payee.
8. **Poll interval reuses `INTEGRATIONS_SYNC_INTERVAL_SECONDS`** (floored at 60s). No new knob.
9. **Overlap window = 7 days, page limit = 100, no bulk confirm** (spec's open questions: start with the guess, one row at a time).
10. **Member hard-delete messaging** (spec §3 "the delete path should say so"): Heorth has no mapped restrict error on member deletion for `transactions.created_by` either, so this slice adds none — consistency over a one-off. Noted as deferred in the CHANGELOG entry.
11. **Booking is one database transaction, and one tick runs at a time** (from Codex's pre-execution review). `recordTransaction()` gains an optional third parameter, a drizzle transaction handle, so `bookRow` can lock the inbox row `FOR UPDATE`, re-check it is still pending, write the ledger and mark the row booked atomically — a crash can never leave a ledger transaction without its inbox link, and two writers on one row cannot double-book. `runImportTick()` refuses to overlap itself in-process (`already_running`, `409 ALREADY_RUNNING` on the route); the scheduler and the manual trigger share that guard. The status route also reports the household currency so the web never hard-codes it.

---

## File Structure

**Heorth (`Heorth/`)**

| File | Responsibility |
|---|---|
| `src/config/env.ts` (modify) | `FEOH_IMPORT_ENABLED`, `FIREFLY_BASE_URL`, `FIREFLY_PAT`, `FEOH_CURRENCY`; `config.feohImport`, `config.feohCurrency` |
| `src/modules/feoh/import/schema.ts` | The four `feoh_import_*` tables |
| `src/modules/feoh/import/providers/types.ts` | `TransactionSourceProvider`, `ImportedTransaction`, `SourceAccount`, `SourcePage`, `SourceProviderError` |
| `src/modules/feoh/import/provider.ts` | Seam: `setTransactionSourceProvider` / `getTransactionSourceProvider` |
| `src/modules/feoh/import/providers/firefly.ts` | The only implementation; pure parsers exported for tests |
| `src/modules/feoh/import/rules.ts` | Pure payee-pattern matching, `(priority, id)` order |
| `src/modules/feoh/import/service.ts` | Account mappings, rules CRUD, inbox read/confirm/dismiss/manual, `ingest()`, booking, `revertBookedRows()` |
| `src/modules/feoh/import/sync.ts` | `runImportTick()`, feed state, error classification |
| `src/modules/feoh/import/validators.ts` | Zod schemas |
| `src/modules/feoh/import/routes.ts` | `createIngestionRouter(canWrite)` |
| `src/modules/feoh/import/scheduler.ts` | The gated ticker |
| `src/modules/feoh/routes.ts` (modify) | Mount the sub-router; map `ENVELOPE_IN_USE` on envelope delete |
| `src/modules/feoh/service.ts` (modify) | `deleteTransaction()` reverts booked import rows first |
| `src/index.ts` (modify) | Start the import scheduler |
| `src/db/schema/drizzle-schema.ts`, `src/db/schema/index.ts` (modify) | Register the schema |
| `src/db/migrations/0028_feoh_import.sql` (generated) | |
| `tests/fake-source.ts` | In-memory `TransactionSourceProvider` |
| `tests/fixtures/firefly-transactions.json`, `tests/fixtures/firefly-accounts.json` | Firefly v6 response fixtures |
| `tests/feoh-import-*.test.ts` | env, schema, rules, service, sync, firefly, routes |
| `README.md`, `AGENTS.md`, `CHANGELOG.md`, `.env.example`, `tests/setup.ts` (modify) | Docs and test hermeticity |

**Heorth web (`Heorth/web/`)**

| File | Responsibility |
|---|---|
| `src/lib/types.ts` (modify) | `ImportedTransaction`, `ImportRule`, `ImportAccountMapping`, `ImportStatus` |
| `src/lib/constants.ts` (modify) | Query keys |
| `src/api/feoh-import.ts` | Typed client for `/feoh/ingestion/*` |
| `src/hooks/use-feoh-import.ts` | Queries and mutations |
| `src/components/feoh/import-inbox.tsx` | Pending rows: book (pick envelope), dismiss |
| `src/components/feoh/import-rules.tsx` | Rules list + add + toggle + delete |
| `src/components/feoh/import-accounts.tsx` | Source account → Feoh account mapping |
| `src/pages/feoh.tsx` (modify) | A "Bank import" card hosting the three |
| `src/i18n/locales/en.json`, `de.json` (modify) | `feoh.import.*` |

**Meta repo**

| File | Responsibility |
|---|---|
| `deploy/compose.prod.yml` (modify) | `firefly`, `firefly-importer` services; Heorth's import env |
| `deploy/compose.dev.yml`, `deploy/compose.demo.yml`, `deploy/.env.example` (modify) | `FEOH_CURRENCY` |
| `deploy/seed-demo.mjs` (modify) | Mapping, rules, manual inbox lines |
| `docs/strategy.md`, `docs/superpowers/specs/2026-08-28-feoh-bank-ingestion-design.md`, `deploy/README.md` (modify) | Mark shipped; record decisions 3–5 |

---

## Task 1: Env group and config

**Files:**
- Modify: `Heorth/src/config/env.ts`, `Heorth/tests/setup.ts`, `Heorth/.env.example`
- Test: `Heorth/tests/feoh-import-env.test.ts`

**Interfaces:**
- Produces: `config.feohImport: { baseUrl: string; pat: string } | null`, `config.feohCurrency: string`

- [ ] **Step 1: Write the failing test**

Create `Heorth/tests/feoh-import-env.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildEnvSchema } from '../src/config/env.js';

const base = {
  DATABASE_URL: 'postgres://u:p@localhost:5432/db',
  JWT_SECRET: 'x'.repeat(32),
  HOUSEHOLD_NAME: 'Home',
  ADMIN_EMAIL: 'a@b.com',
  ADMIN_PASSWORD: 'pw',
};

describe('feoh import env group', () => {
  it('is valid with nothing set — import disabled, currency defaults to EUR', () => {
    const parsed = buildEnvSchema().safeParse(base);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.FEOH_IMPORT_ENABLED).toBeUndefined();
      expect(parsed.data.FEOH_CURRENCY).toBe('EUR');
    }
  });

  it('treats blank FEOH_IMPORT_ENABLED as disabled', () => {
    expect(buildEnvSchema().safeParse({ ...base, FEOH_IMPORT_ENABLED: '' }).success).toBe(true);
  });

  it('allows FIREFLY_* to be present while disabled (compose passes defaults)', () => {
    expect(buildEnvSchema().safeParse({
      ...base, FEOH_IMPORT_ENABLED: 'false', FIREFLY_BASE_URL: 'http://firefly:8080', FIREFLY_PAT: '',
    }).success).toBe(true);
  });

  it('is valid when enabled with both FIREFLY vars', () => {
    expect(buildEnvSchema().safeParse({
      ...base, FEOH_IMPORT_ENABLED: 'true', FIREFLY_BASE_URL: 'http://firefly:8080', FIREFLY_PAT: 'eyJ.x.y',
    }).success).toBe(true);
  });

  it('rejects enabled without a PAT', () => {
    const parsed = buildEnvSchema().safeParse({
      ...base, FEOH_IMPORT_ENABLED: 'true', FIREFLY_BASE_URL: 'http://firefly:8080',
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) expect(parsed.error.issues[0]!.message).toContain('FIREFLY_PAT');
  });

  it('rejects enabled without a base URL', () => {
    expect(buildEnvSchema().safeParse({ ...base, FEOH_IMPORT_ENABLED: 'true', FIREFLY_PAT: 'x' }).success).toBe(false);
  });

  it('rejects a value other than true/false', () => {
    expect(buildEnvSchema().safeParse({ ...base, FEOH_IMPORT_ENABLED: 'yes' }).success).toBe(false);
  });

  it('rejects a non-ISO currency and accepts a valid one', () => {
    expect(buildEnvSchema().safeParse({ ...base, FEOH_CURRENCY: 'euro' }).success).toBe(false);
    const ok = buildEnvSchema().safeParse({ ...base, FEOH_CURRENCY: 'CHF' });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.FEOH_CURRENCY).toBe('CHF');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd Heorth && npx vitest run tests/feoh-import-env.test.ts`
Expected: FAIL — `FEOH_CURRENCY` is `undefined`, and the "rejects enabled without a PAT" case passes parsing.

- [ ] **Step 3: Add the schema fields, the refinement, and the config entries**

In `Heorth/src/config/env.ts`, inside `baseEnvSchema.extend({ ... })`, after the `SATELLITE_AUDIENCES` entry and before the closing `})`:

```ts
    // Bank ingestion (ADR 0016). Firefly III is a one-way ingestion provider,
    // never the ledger. `true` requires BOTH FIREFLY_BASE_URL and FIREFLY_PAT
    // (see superRefine); blank or `false` means the import scheduler never
    // starts and the sync trigger answers PROVIDER_UNAVAILABLE. The inbox,
    // the rules and confirming pending rows keep working either way — they
    // are pure Feoh writes. The FIREFLY_* values may be present while disabled
    // (compose passes defaults); they are simply unused then.
    FEOH_IMPORT_ENABLED: emptyToUndefined(z.enum(['true', 'false'])),
    FIREFLY_BASE_URL: emptyToUndefined(z.string().url()),
    FIREFLY_PAT: emptyToUndefined(z.string().min(1)),
    // The household's ONE currency (Feoh is single-currency by construction —
    // there is no currency column anywhere). An imported line in any other
    // currency stays in the inbox and is never booked. ISO 4217, default EUR.
    FEOH_CURRENCY: emptyToUndefined(z.string().regex(/^[A-Z]{3}$/, 'FEOH_CURRENCY must be an ISO 4217 code such as EUR')),
```

Inside the `.superRefine((env, ctx) => { ... })`, at the end before its closing `});`:

```ts
    if (env.FEOH_IMPORT_ENABLED === 'true') {
      const missing = (['FIREFLY_BASE_URL', 'FIREFLY_PAT'] as const)
        .filter((k) => env[k] === undefined || env[k] === '');
      if (missing.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['FEOH_IMPORT'],
          message:
            `FEOH_IMPORT_ENABLED=true but ${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} blank — ` +
            'set both, or set FEOH_IMPORT_ENABLED=false.',
        });
      }
    }
```

Then make the default apply: change the `FEOH_CURRENCY` line above to include a default by wrapping — Zod's `emptyToUndefined` yields `string | undefined`, so the default lives in `config`, not the schema. In the `export const config = { ... }` object, after the `kith:` entry:

```ts
  // Bank ingestion (ADR 0016) — `null` when FEOH_IMPORT_ENABLED is not `true`.
  // The schema guarantees both Firefly values are present when enabled.
  feohImport:
    parsed.FEOH_IMPORT_ENABLED === 'true'
      ? { baseUrl: parsed.FIREFLY_BASE_URL!, pat: parsed.FIREFLY_PAT! }
      : null,
  // The household's single currency; imported rows in any other currency are
  // never booked (spec §2 "Currency").
  feohCurrency: parsed.FEOH_CURRENCY ?? 'EUR',
```

And fix the first test's expectation to match where the default lives: in `tests/feoh-import-env.test.ts` replace `expect(parsed.data.FEOH_CURRENCY).toBe('EUR');` with `expect(parsed.data.FEOH_CURRENCY).toBeUndefined();` and in the last test keep `toBe('CHF')`.

- [ ] **Step 4: Keep the suite hermetic**

In `Heorth/tests/setup.ts`, extend the blanking loop's array:

```ts
  'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI',
  // Bank ingestion (ADR 0016): the import scheduler must never start under
  // tests and no test may reach a real Firefly. Enabled-path tests install a
  // FakeSource via setTransactionSourceProvider instead.
  'FEOH_IMPORT_ENABLED', 'FIREFLY_BASE_URL', 'FIREFLY_PAT',
```

- [ ] **Step 5: Document in `.env.example`**

Append to `Heorth/.env.example`:

```dotenv

# --- Bank ingestion (ADR 0016) — optional ------------------------------------
# Firefly III is a one-way ingestion sidecar, never the ledger. `true` requires
# both values below; blank/false means no scheduler and PROVIDER_UNAVAILABLE on
# the sync trigger. The inbox, rules and confirmations keep working either way.
FEOH_IMPORT_ENABLED=false
FIREFLY_BASE_URL=http://localhost:14001
FIREFLY_PAT=
# The household's one currency (ISO 4217). Imported lines in any other
# currency stay in the inbox and are never booked. Default EUR.
FEOH_CURRENCY=EUR
```

- [ ] **Step 6: Run the tests**

Run: `cd Heorth && npx vitest run tests/feoh-import-env.test.ts tests/env.test.ts tests/kith-env.test.ts && npm run typecheck`
Expected: PASS, typecheck clean.

- [ ] **Step 7: Commit (Heorth)**

```bash
cd Heorth && git add src/config/env.ts tests/setup.ts tests/feoh-import-env.test.ts .env.example
git commit -m "feat(feoh): FEOH_IMPORT_ENABLED group and FEOH_CURRENCY (ADR 0016)"
```

---

## Task 2: Schema and migration

**Files:**
- Create: `Heorth/src/modules/feoh/import/schema.ts`
- Modify: `Heorth/src/db/schema/drizzle-schema.ts`, `Heorth/src/db/schema/index.ts`
- Generate: `Heorth/src/db/migrations/0028_feoh_import.sql`
- Test: `Heorth/tests/feoh-import-schema.test.ts`

**Interfaces:**
- Consumes: `accounts`, `envelopes`, `transactions` from `../schema.js`; `users` from `@wyrhta/core/identity`
- Produces: `feohImportAccounts`, `feohImportRules`, `feohImportedTransactions`, `feohImportState`; types `ImportAccountMapping`, `ImportRule`, `ImportedTransactionRow`, `ImportState`; const tuples `IMPORT_DIRECTIONS`, `IMPORT_STATUSES`

- [ ] **Step 1: Write the failing test**

Create `Heorth/tests/feoh-import-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { pgErrorCode } from '@wyrhta/core/db';
import { identity } from '../src/wiring.js';
import { accounts, envelopes, transactions } from '../src/modules/feoh/schema.js';
import {
  feohImportAccounts, feohImportRules, feohImportedTransactions, feohImportState,
} from '../src/modules/feoh/import/schema.js';

async function member() {
  return identity.createUser({
    email: 'imp@test.local', handle: 'imp', password: 'pw-import-1',
    role: 'adult', displayName: 'Imp', avatarColor: 'sage',
  });
}

function line(over: Partial<typeof feohImportedTransactions.$inferInsert> = {}) {
  return {
    sourceId: '101:1', sourceAccountId: '7', date: '2026-09-01', payee: 'Rewe',
    memo: null, amount: '42.10', currency: 'EUR', direction: 'out', status: 'pending', ...over,
  };
}

describe('feoh_import_* schema', () => {
  it('inserts a pending line with defaults', async () => {
    const [row] = await db.insert(feohImportedTransactions).values(line()).returning();
    expect(row!.status).toBe('pending');
    expect(row!.transactionId).toBeNull();
    expect(row!.appliedRuleId).toBeNull();
  });

  it('source_id is UNIQUE — the idempotency guarantee (23505)', async () => {
    await db.insert(feohImportedTransactions).values(line());
    await expect(db.insert(feohImportedTransactions).values(line({ payee: 'Again' })))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23505');
  });

  it('rejects a non-positive amount, an unknown direction and an unknown status', async () => {
    await expect(db.insert(feohImportedTransactions).values(line({ amount: '0' }))).rejects.toThrow();
    await expect(db.insert(feohImportedTransactions).values(line({ direction: 'sideways' }))).rejects.toThrow();
    await expect(db.insert(feohImportedTransactions).values(line({ status: 'lost' }))).rejects.toThrow();
  });

  it('booked implies a transaction, and pending/dismissed imply none', async () => {
    await expect(db.insert(feohImportedTransactions).values(line({ status: 'booked' }))).rejects.toThrow();
    const m = await member();
    const [txn] = await db.insert(transactions).values({ date: '2026-09-01', payee: 'Rewe', amount: '42.10', createdBy: m.id }).returning();
    await expect(db.insert(feohImportedTransactions).values(line({ status: 'pending', transactionId: txn!.id }))).rejects.toThrow();
    const [ok] = await db.insert(feohImportedTransactions).values(line({ status: 'booked', transactionId: txn!.id })).returning();
    expect(ok!.status).toBe('booked');
  });

  it('a rule restricts deleting its author and its envelope (23001)', async () => {
    const m = await member();
    const [env] = await db.insert(envelopes).values({ name: 'Groceries', monthlyBudget: '400' }).returning();
    await db.insert(feohImportRules).values({ pattern: 'rewe', envelopeId: env!.id, createdBy: m.id });
    await expect(db.execute(sql`DELETE FROM users WHERE id = ${m.id}`))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23001');
    await expect(db.delete(envelopes)).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23001');
  });

  it('a rule needs a non-empty pattern', async () => {
    const m = await member();
    const [env] = await db.insert(envelopes).values({ name: 'Groceries', monthlyBudget: '400' }).returning();
    await expect(db.insert(feohImportRules).values({ pattern: '', envelopeId: env!.id, createdBy: m.id })).rejects.toThrow();
  });

  it('an account mapping is unique per source account and restricts deleting the Feoh account', async () => {
    const [acc] = await db.insert(accounts).values({ name: 'Joint', kind: 'asset', openingBalance: '0' }).returning();
    await db.insert(feohImportAccounts).values({ sourceAccountId: '7', accountId: acc!.id });
    await expect(db.insert(feohImportAccounts).values({ sourceAccountId: '7', accountId: acc!.id }))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23505');
    await expect(db.delete(accounts)).rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23001');
  });

  it('deleting a rule nulls applied_rule_id on the lines it booked', async () => {
    const m = await member();
    const [env] = await db.insert(envelopes).values({ name: 'Groceries', monthlyBudget: '400' }).returning();
    const [rule] = await db.insert(feohImportRules).values({ pattern: 'rewe', envelopeId: env!.id, createdBy: m.id }).returning();
    const [row] = await db.insert(feohImportedTransactions).values(line({ appliedRuleId: rule!.id })).returning();
    await db.delete(feohImportRules);
    const [after] = await db.select().from(feohImportedTransactions);
    expect(after!.id).toBe(row!.id);
    expect(after!.appliedRuleId).toBeNull();
  });

  it('feed_key is unique in the state table', async () => {
    await db.insert(feohImportState).values({ feedKey: 'firefly:transactions' });
    await expect(db.insert(feohImportState).values({ feedKey: 'firefly:transactions' }))
      .rejects.toSatisfy((e: unknown) => pgErrorCode(e) === '23505');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd Heorth && npx vitest run tests/feoh-import-schema.test.ts`
Expected: FAIL — cannot resolve `../src/modules/feoh/import/schema.js`.

- [ ] **Step 3: Write the schema**

Create `Heorth/src/modules/feoh/import/schema.ts`:

```ts
import { pgTable, text, uuid, timestamp, numeric, date, integer, boolean, check, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { users } from '@wyrhta/core/identity';
import { accounts, envelopes, transactions } from '../schema.js';

export const IMPORT_DIRECTIONS = ['in', 'out'] as const;
export const IMPORT_STATUSES = ['pending', 'booked', 'dismissed'] as const;
export type ImportDirection = (typeof IMPORT_DIRECTIONS)[number];
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

/** Source account -> Feoh account, maintained explicitly (ADR 0016). No
 *  auto-creation: an unknown source account never invents or guesses a Feoh
 *  account. `restrict` so a mapping cannot silently dangle. */
export const feohImportAccounts = pgTable('feoh_import_accounts', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  sourceAccountId: text('source_account_id').notNull(),
  accountId: uuid('account_id').notNull().references(() => accounts.id, { onDelete: 'restrict' }),
}, (t) => [uniqueIndex('feoh_import_accounts_source_unique').on(t.sourceAccountId)]);

/** payee substring (case-insensitive) -> envelope. Evaluated in (priority, id)
 *  order, first enabled match wins. `restrict` on the envelope: a rule without
 *  an envelope would silently become a non-rule. `restrict` on the author: the
 *  rule's author is who an auto-booked transaction is attributed to, the same
 *  way `transactions.created_by` already restricts. */
export const feohImportRules = pgTable('feoh_import_rules', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  pattern: text('pattern').notNull(),
  envelopeId: uuid('envelope_id').notNull().references(() => envelopes.id, { onDelete: 'restrict' }),
  priority: integer('priority').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
}, (t) => [
  check('feoh_import_rules_pattern_check', sql`length(${t.pattern}) > 0`),
  index('feoh_import_rules_created_by_idx').on(t.createdBy),
  index('feoh_import_rules_envelope_idx').on(t.envelopeId),
]);

/** The inbox AND the dedup register. Rows are never deleted, including after
 *  booking — that is what makes a re-import a no-op. `set null` on the
 *  transaction is a BACKSTOP only: `deleteTransaction()` moves booked rows back
 *  to `pending` BEFORE the delete, because the pair check below would otherwise
 *  fail during the referential action. */
export const feohImportedTransactions = pgTable('feoh_imported_transactions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  sourceId: text('source_id').notNull(),
  sourceAccountId: text('source_account_id').notNull(),
  date: date('date').notNull(),
  payee: text('payee').notNull(),
  memo: text('memo'),
  amount: numeric('amount', { precision: 14, scale: 2 }).notNull(),
  currency: text('currency').notNull(),
  direction: text('direction').notNull(),
  status: text('status').notNull().default('pending'),
  envelopeId: uuid('envelope_id').references(() => envelopes.id, { onDelete: 'set null' }),
  transactionId: uuid('transaction_id').references(() => transactions.id, { onDelete: 'set null' }),
  appliedRuleId: uuid('applied_rule_id').references(() => feohImportRules.id, { onDelete: 'set null' }),
}, (t) => [
  uniqueIndex('feoh_imported_transactions_source_unique').on(t.sourceId),
  check('feoh_imported_transactions_amount_check', sql`${t.amount} > 0`),
  check('feoh_imported_transactions_direction_check', sql`${t.direction} IN ('in', 'out')`),
  check('feoh_imported_transactions_status_check', sql`${t.status} IN ('pending', 'booked', 'dismissed')`),
  check('feoh_imported_transactions_booked_pair_check', sql`(${t.status} = 'booked') = (${t.transactionId} IS NOT NULL)`),
  index('feoh_imported_transactions_status_idx').on(t.status),
  index('feoh_imported_transactions_transaction_idx').on(t.transactionId),
]);

/** Cursor and health per feed, mirroring integration_sync_state. `cursor` is
 *  the provider's opaque watermark and is never exposed over the API. */
export const feohImportState = pgTable('feoh_import_state', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().default(sql`now()`),
  feedKey: text('feed_key').notNull(),
  cursor: text('cursor'),
  lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
  lastError: text('last_error'),
  consecutiveFailures: integer('consecutive_failures').notNull().default(0),
}, (t) => [uniqueIndex('feoh_import_state_feed_key_unique').on(t.feedKey)]);

export type ImportAccountMapping = typeof feohImportAccounts.$inferSelect;
export type ImportRule = typeof feohImportRules.$inferSelect;
export type ImportedTransactionRow = typeof feohImportedTransactions.$inferSelect;
export type ImportState = typeof feohImportState.$inferSelect;
```

- [ ] **Step 4: Register the schema in both barrels**

Append to `Heorth/src/db/schema/drizzle-schema.ts`:

```ts
export * from '../../modules/feoh/import/schema';
```

Append to `Heorth/src/db/schema/index.ts`:

```ts
export * from '../../modules/feoh/import/schema.js';
```

- [ ] **Step 5: Generate the migration**

Run: `cd Heorth && npm run db:generate -- --name feoh_import`
Expected: `src/db/migrations/0028_feoh_import.sql` is created and `src/db/migrations/meta/_journal.json` gains `"idx": 28, "tag": "0028_feoh_import"`. Open the SQL and confirm it creates exactly four tables, all `feoh_import_*`, and touches none of the existing eight.

- [ ] **Step 6: Run the tests**

Run: `cd Heorth && npx vitest run tests/feoh-import-schema.test.ts tests/feoh-schema.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit (Heorth)**

```bash
cd Heorth && git add src/modules/feoh/import/schema.ts src/db/schema/ src/db/migrations/ tests/feoh-import-schema.test.ts
git commit -m "feat(feoh): feoh_import_* tables — inbox, rules, account map, feed state (ADR 0016)"
```

---

## Task 3: Provider contract, seam, and the in-memory fake

**Files:**
- Create: `Heorth/src/modules/feoh/import/providers/types.ts`, `Heorth/src/modules/feoh/import/provider.ts`, `Heorth/tests/fake-source.ts`
- Test: `Heorth/tests/feoh-import-provider.test.ts`

**Interfaces:**
- Produces: `TransactionSourceProvider`, `ImportedTransaction`, `SourceAccount`, `SourcePage`, `SourceProviderError`, `SourceErrorReason`; `setTransactionSourceProvider(p)`, `resetTransactionSourceProvider()`, `getTransactionSourceProvider()`; test class `FakeSource` with `rows`, `accounts`, `failWith`, `calls`, helper `fakeLine(over)`

- [ ] **Step 1: Write the failing test**

Create `Heorth/tests/feoh-import-provider.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import {
  getTransactionSourceProvider, setTransactionSourceProvider, resetTransactionSourceProvider,
} from '../src/modules/feoh/import/provider.js';
import { SourceProviderError } from '../src/modules/feoh/import/providers/types.js';
import { FakeSource, fakeLine } from './fake-source.js';

afterEach(() => resetTransactionSourceProvider());

describe('transaction source seam', () => {
  it('resolves to null when import is disabled (the test env blanks the group)', () => {
    expect(getTransactionSourceProvider()).toBeNull();
  });

  it('returns whatever the test installed, including an explicit null', () => {
    const fake = new FakeSource();
    setTransactionSourceProvider(fake);
    expect(getTransactionSourceProvider()).toBe(fake);
    setTransactionSourceProvider(null);
    expect(getTransactionSourceProvider()).toBeNull();
  });
});

describe('FakeSource', () => {
  it('pages in a stable order and reports a checkpoint that replays everything', async () => {
    const fake = new FakeSource();
    fake.rows = [fakeLine({ sourceId: '1:1', date: '2026-09-02' }), fakeLine({ sourceId: '1:2', date: '2026-09-01' }), fakeLine({ sourceId: '2:1', date: '2026-09-02' })];
    const p1 = await fake.listSince(null, 2);
    expect(p1.items.map((i) => i.sourceId)).toEqual(['1:2', '1:1']);
    expect(p1.nextCursor).toBe('2');
    const p2 = await fake.listSince(p1.nextCursor, 2);
    expect(p2.items.map((i) => i.sourceId)).toEqual(['2:1']);
    expect(p2.nextCursor).toBeNull();
    expect(p2.checkpoint).toBe('0');
  });

  it('throws the configured error', async () => {
    const fake = new FakeSource();
    fake.failWith = new SourceProviderError('auth_failed');
    await expect(fake.listSince(null, 10)).rejects.toBeInstanceOf(SourceProviderError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd Heorth && npx vitest run tests/feoh-import-provider.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the contract**

Create `Heorth/src/modules/feoh/import/providers/types.ts`:

```ts
/**
 * Provider-agnostic contract for a bank-line source (ADR 0016 §2). One-way and
 * semantics-free: two read methods, no create/update/delete, no Firefly type
 * crosses this boundary. A CSV or other aggregator implements the same two
 * methods, which is what makes the sidecar replaceable rather than "abstracted".
 */

export interface SourceAccount {
  sourceAccountId: string;
  name: string;
  currency: string;
}

export interface ImportedTransaction {
  /** Stable per LINE, not per group (a Firefly split yields one row per journal line). */
  sourceId: string;
  sourceAccountId: string;
  /** ISO calendar date, YYYY-MM-DD. */
  date: string;
  payee: string;
  memo: string | null;
  /** Always positive. */
  amount: number;
  /** ISO 4217, as delivered. */
  currency: string;
  direction: 'in' | 'out';
}

export interface SourcePage {
  items: ImportedTransaction[];
  /** Opaque watermark for the next call WITHIN this sweep. Null means the sweep is complete. */
  nextCursor: string | null;
  /**
   * Opaque watermark to persist once the sweep completes — where the NEXT sweep
   * starts. The provider re-windows it by its own overlap (banks backdate), so
   * the caller never does date arithmetic on a cursor.
   */
  checkpoint: string;
}

export interface TransactionSourceProvider {
  /**
   * The provider owes a total, stable sort over the rows it emits, and a
   * `nextCursor` that never sits in the middle of rows sharing a sort key.
   */
  listSince(cursor: string | null, limit: number): Promise<SourcePage>;
  listAccounts(): Promise<SourceAccount[]>;
}

/** The ONLY tokens that may reach `feoh_import_state.last_error` or a log line. */
export type SourceErrorReason =
  | 'no_credentials' | 'auth_failed' | 'network_error' | 'rate_limited' | 'bad_response' | 'error';

export class SourceProviderError extends Error {
  constructor(public readonly reason: SourceErrorReason, message?: string) {
    super(message ?? reason);
    this.name = 'SourceProviderError';
  }
}
```

- [ ] **Step 4: Write the seam**

Create `Heorth/src/modules/feoh/import/provider.ts`:

```ts
import type { TransactionSourceProvider } from './providers/types.js';

/**
 * Resolution seam for the bank-line source, following `src/modules/tasks/provider.ts`.
 * Tests install a fake (or an explicit null) through the setter; production
 * resolves from `config.feohImport` (wired in Task 7 once the Firefly provider exists).
 */
let override: TransactionSourceProvider | null | undefined;

export function setTransactionSourceProvider(p: TransactionSourceProvider | null): void {
  override = p;
}

export function resetTransactionSourceProvider(): void {
  override = undefined;
}

export function getTransactionSourceProvider(): TransactionSourceProvider | null {
  if (override !== undefined) return override;
  // Task 7 replaces this line with the config-driven Firefly default.
  return null;
}
```

- [ ] **Step 5: Write the fake**

Create `Heorth/tests/fake-source.ts`:

```ts
import type {
  ImportedTransaction, SourceAccount, SourcePage, TransactionSourceProvider,
} from '../src/modules/feoh/import/providers/types.js';
import { SourceProviderError } from '../src/modules/feoh/import/providers/types.js';

export function fakeLine(over: Partial<ImportedTransaction> = {}): ImportedTransaction {
  return {
    sourceId: '101:1', sourceAccountId: '7', date: '2026-09-01', payee: 'Rewe',
    memo: null, amount: 42.1, currency: 'EUR', direction: 'out', ...over,
  };
}

function key(l: ImportedTransaction): string {
  return `${l.date}|${l.sourceId}`;
}

/**
 * In-memory source. Cursor = index offset into the sorted rows; checkpoint is
 * always '0', which models the overlap window: every sweep replays everything
 * and dedup on source_id has to make that free.
 */
export class FakeSource implements TransactionSourceProvider {
  rows: ImportedTransaction[] = [];
  accounts: SourceAccount[] = [];
  failWith: SourceProviderError | null = null;
  calls = 0;

  async listSince(cursor: string | null, limit: number): Promise<SourcePage> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    const sorted = [...this.rows].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
    const start = cursor ? Number(cursor) : 0;
    const items = sorted.slice(start, start + limit);
    const next = start + items.length;
    return { items, nextCursor: next < sorted.length ? String(next) : null, checkpoint: '0' };
  }

  async listAccounts(): Promise<SourceAccount[]> {
    if (this.failWith) throw this.failWith;
    return this.accounts;
  }
}
```

- [ ] **Step 6: Run the tests**

Run: `cd Heorth && npx vitest run tests/feoh-import-provider.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit (Heorth)**

```bash
cd Heorth && git add src/modules/feoh/import/providers/types.ts src/modules/feoh/import/provider.ts tests/fake-source.ts tests/feoh-import-provider.test.ts
git commit -m "feat(feoh): TransactionSourceProvider contract, seam and test fake (ADR 0016)"
```

---

## Task 4: Rule matching (pure)

**Files:**
- Create: `Heorth/src/modules/feoh/import/rules.ts`
- Test: `Heorth/tests/feoh-import-rules.test.ts`

**Interfaces:**
- Produces: `MatchableRule`, `orderRules(rules)`, `matchRule(payee, rules)`

- [ ] **Step 1: Write the failing test**

Create `Heorth/tests/feoh-import-rules.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { matchRule, orderRules } from '../src/modules/feoh/import/rules.js';

const r = (id: string, pattern: string, priority = 0, enabled = true) => ({ id, pattern, priority, enabled });

describe('import rules', () => {
  it('matches case-insensitively as a substring of the payee', () => {
    expect(matchRule('REWE Markt 123', [r('a', 'rewe')])?.id).toBe('a');
    expect(matchRule('Aldi', [r('a', 'rewe')])).toBeNull();
  });

  it('orders by (priority, id) and the first enabled match wins', () => {
    const rules = [r('b', 'markt', 5), r('a', 'rewe', 5), r('z', 'rewe', 1, false), r('c', 'rewe', 9)];
    expect(orderRules(rules).map((x) => x.id)).toEqual(['z', 'a', 'b', 'c']);
    expect(matchRule('Rewe Markt', rules)?.id).toBe('a');
  });

  it('skips disabled rules entirely', () => {
    expect(matchRule('Rewe', [r('a', 'rewe', 0, false)])).toBeNull();
  });

  it('is deterministic for two rules matching the same payee', () => {
    const rules = [r('2', 'rewe'), r('1', 'rewe')];
    expect(matchRule('rewe', rules)?.id).toBe('1');
    expect(matchRule('rewe', [...rules].reverse())?.id).toBe('1');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd Heorth && npx vitest run tests/feoh-import-rules.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `Heorth/src/modules/feoh/import/rules.ts`:

```ts
/** The subset of a `feoh_import_rules` row the matcher needs. Pure; no DB. */
export interface MatchableRule {
  id: string;
  pattern: string;
  priority: number;
  enabled: boolean;
}

/** `(priority ASC, id ASC)` — deterministic, so two rules matching one payee never coin-flip. */
export function orderRules<T extends MatchableRule>(rules: readonly T[]): T[] {
  return [...rules].sort((a, b) => a.priority - b.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** First ENABLED rule whose pattern is a case-insensitive substring of the payee, or null. */
export function matchRule<T extends MatchableRule>(payee: string, rules: readonly T[]): T | null {
  const hay = payee.toLowerCase();
  for (const rule of orderRules(rules)) {
    if (!rule.enabled) continue;
    if (hay.includes(rule.pattern.toLowerCase())) return rule;
  }
  return null;
}
```

- [ ] **Step 4: Run the tests**

Run: `cd Heorth && npx vitest run tests/feoh-import-rules.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit (Heorth)**

```bash
cd Heorth && git add src/modules/feoh/import/rules.ts tests/feoh-import-rules.test.ts
git commit -m "feat(feoh): import rule matching — (priority, id) order, first enabled match wins"
```

---

## Task 5: Service — mappings, rules, inbox, `ingest()`, booking, unbooking

**Files:**
- Create: `Heorth/src/modules/feoh/import/service.ts`
- Modify: `Heorth/src/modules/feoh/service.ts` (`deleteTransaction`)
- Test: `Heorth/tests/feoh-import-service.test.ts`

**Interfaces:**
- Consumes: `recordTransaction(input, createdBy, tx?)` and `type Tx` from `../service.js` (both amended in Step 4 of this task); `matchRule` (Task 4); schema (Task 2); `ImportedTransaction` (Task 3); `config.feohCurrency` (Task 1)
- Produces (all exported from `import/service.ts`):
  - `listAccountMappings(): Promise<ImportAccountMapping[]>`, `upsertAccountMapping(i: { sourceAccountId: string; accountId: string }): Promise<ImportAccountMapping>`, `deleteAccountMapping(id): Promise<ImportAccountMapping | null>`
  - `listRules(): Promise<ImportRule[]>`, `createRule(i: RuleInput, createdBy): Promise<ImportRule>`, `updateRule(id, patch: Partial<RuleInput>): Promise<ImportRule | null>`, `deleteRule(id): Promise<ImportRule | null>` where `RuleInput = { pattern: string; envelopeId: string; priority?: number; enabled?: boolean }`
  - `listInbox(q: { status?: ImportStatus; limit?: number; offset?: number }): Promise<{ rows; total; limit; offset }>`, `getInboxRow(id)`
  - `ingest(items: ImportedTransaction[]): Promise<IngestResult>` where `IngestResult = { inserted: number; booked: number; skipped: number }`
  - `addManualLine(i: ManualLineInput): Promise<{ row: ImportedTransactionRow; created: boolean }>`
  - `confirmInboxRow(id, i: { envelopeId: string; accountId?: string }, memberId): Promise<ImportedTransactionRow>` — throws `Error('NOT_FOUND' | 'NOT_PENDING' | 'CURRENCY_MISMATCH' | 'ACCOUNT_UNMAPPED')`
  - `dismissInboxRow(id): Promise<ImportedTransactionRow>` — throws `NOT_FOUND | NOT_PENDING`
  - `reapplyRulesToPending(): Promise<number>`
  - `revertBookedRows(tx, transactionId): Promise<number>` — used by `deleteTransaction()`

- [ ] **Step 1: Write the failing test**

Create `Heorth/tests/feoh-import-service.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/index.js';
import { seedTestHousehold } from './helpers.js';
import * as feoh from '../src/modules/feoh/service.js';
import * as imp from '../src/modules/feoh/import/service.js';
import { postings, transactions } from '../src/modules/feoh/schema.js';
import { feohImportedTransactions } from '../src/modules/feoh/import/schema.js';
import { fakeLine } from './fake-source.js';

async function setup() {
  const { adult, admin } = await seedTestHousehold();
  const account = await feoh.createAccount({ name: 'Joint', kind: 'asset', openingBalance: 1000 });
  const groceries = await feoh.createEnvelope({ name: 'Groceries', monthlyBudget: 400 });
  const income = await feoh.createEnvelope({ name: 'Income', monthlyBudget: 0 });
  return { adult, admin, account, groceries, income };
}

async function balance(accountId: string): Promise<number> {
  const rows = await db.select().from(postings).where(eq(postings.accountId, accountId));
  return rows.reduce((s, p) => s + Number(p.debit) - Number(p.credit), 0);
}

describe('ingest()', () => {
  it('inserts unknown lines as pending and skips known source_ids (dedup is free)', async () => {
    await setup();
    const first = await imp.ingest([fakeLine({ sourceId: '1:1' }), fakeLine({ sourceId: '1:2' })]);
    expect(first).toEqual({ inserted: 2, booked: 0, skipped: 0 });
    const again = await imp.ingest([fakeLine({ sourceId: '1:1' }), fakeLine({ sourceId: '1:3' })]);
    expect(again).toEqual({ inserted: 1, booked: 0, skipped: 1 });
    const { total } = await imp.listInbox({});
    expect(total).toBe(3);
  });

  it('a Firefly split of three journal lines yields three rows; re-ingesting inserts nothing', async () => {
    await setup();
    const split = ['9:1', '9:2', '9:3'].map((sourceId) => fakeLine({ sourceId }));
    expect((await imp.ingest(split)).inserted).toBe(3);
    expect((await imp.ingest(split)).inserted).toBe(0);
  });

  it('books a rule hit through recordTransaction: two postings, account credited, attributed to the rule author', async () => {
    const { adult, account, groceries } = await setup();
    await imp.upsertAccountMapping({ sourceAccountId: '7', accountId: account.id });
    await imp.createRule({ pattern: 'rewe', envelopeId: groceries.id }, adult.user.id);
    const r = await imp.ingest([fakeLine({ sourceId: '2:1', amount: 42.1, direction: 'out' })]);
    expect(r.booked).toBe(1);
    const [row] = await db.select().from(feohImportedTransactions);
    expect(row!.status).toBe('booked');
    expect(row!.envelopeId).toBe(groceries.id);
    const txn = await feoh.getTransaction(row!.transactionId!);
    expect(txn!.transaction.createdBy).toBe(adult.user.id);
    expect(txn!.postings).toHaveLength(2);
    const env = txn!.postings.find((p) => p.envelopeId === groceries.id)!;
    const acc = txn!.postings.find((p) => p.accountId === account.id)!;
    expect(Number(env.debit)).toBe(42.1);
    expect(Number(acc.credit)).toBe(42.1);
    expect(await balance(account.id)).toBe(-42.1);
  });

  it('an inbound line debits the account and credits the envelope', async () => {
    const { adult, account, income } = await setup();
    await imp.upsertAccountMapping({ sourceAccountId: '7', accountId: account.id });
    await imp.createRule({ pattern: 'salary', envelopeId: income.id }, adult.user.id);
    await imp.ingest([fakeLine({ sourceId: '3:1', payee: 'ACME Salary', amount: 3000, direction: 'in' })]);
    expect(await balance(account.id)).toBe(3000);
  });

  it('never books a foreign-currency line, even on a rule hit', async () => {
    const { adult, account, groceries } = await setup();
    await imp.upsertAccountMapping({ sourceAccountId: '7', accountId: account.id });
    await imp.createRule({ pattern: 'rewe', envelopeId: groceries.id }, adult.user.id);
    const r = await imp.ingest([fakeLine({ sourceId: '4:1', currency: 'USD' })]);
    expect(r).toEqual({ inserted: 1, booked: 0, skipped: 0 });
    const [row] = await db.select().from(feohImportedTransactions);
    expect(row!.status).toBe('pending');
  });

  it('leaves a line pending when its source account is unmapped or no rule matches', async () => {
    const { adult, account, groceries } = await setup();
    await imp.createRule({ pattern: 'rewe', envelopeId: groceries.id }, adult.user.id);
    expect((await imp.ingest([fakeLine({ sourceId: '5:1' })])).booked).toBe(0); // unmapped
    await imp.upsertAccountMapping({ sourceAccountId: '7', accountId: account.id });
    expect((await imp.ingest([fakeLine({ sourceId: '5:2', payee: 'Aldi' })])).booked).toBe(0); // no rule
  });
});

describe('inbox lifecycle', () => {
  it('confirm books with the confirming member as author and the mapped account', async () => {
    const { adult, account, groceries } = await setup();
    await imp.upsertAccountMapping({ sourceAccountId: '7', accountId: account.id });
    await imp.ingest([fakeLine({ sourceId: '6:1', payee: 'Aldi' })]);
    const [pending] = await db.select().from(feohImportedTransactions);
    const booked = await imp.confirmInboxRow(pending!.id, { envelopeId: groceries.id }, adult.user.id);
    expect(booked.status).toBe('booked');
    expect(booked.appliedRuleId).toBeNull();
    const txn = await feoh.getTransaction(booked.transactionId!);
    expect(txn!.transaction.createdBy).toBe(adult.user.id);
  });

  it('confirm needs an explicit accountId when the source account is unmapped', async () => {
    const { adult, account, groceries } = await setup();
    await imp.ingest([fakeLine({ sourceId: '6:2', payee: 'Aldi' })]);
    const [pending] = await db.select().from(feohImportedTransactions);
    await expect(imp.confirmInboxRow(pending!.id, { envelopeId: groceries.id }, adult.user.id)).rejects.toThrow('ACCOUNT_UNMAPPED');
    const booked = await imp.confirmInboxRow(pending!.id, { envelopeId: groceries.id, accountId: account.id }, adult.user.id);
    expect(booked.status).toBe('booked');
  });

  it('confirm refuses a foreign-currency line and a non-pending line', async () => {
    const { adult, account, groceries } = await setup();
    await imp.upsertAccountMapping({ sourceAccountId: '7', accountId: account.id });
    await imp.ingest([fakeLine({ sourceId: '6:3', currency: 'USD' }), fakeLine({ sourceId: '6:4', payee: 'Aldi' })]);
    const rows = await db.select().from(feohImportedTransactions);
    const usd = rows.find((r) => r.sourceId === '6:3')!;
    const eur = rows.find((r) => r.sourceId === '6:4')!;
    await expect(imp.confirmInboxRow(usd.id, { envelopeId: groceries.id }, adult.user.id)).rejects.toThrow('CURRENCY_MISMATCH');
    await imp.dismissInboxRow(eur.id);
    await expect(imp.confirmInboxRow(eur.id, { envelopeId: groceries.id }, adult.user.id)).rejects.toThrow('NOT_PENDING');
    await expect(imp.dismissInboxRow(eur.id)).rejects.toThrow('NOT_PENDING');
  });

  it('deleting a booked transaction returns the line to pending and the pair check survives', async () => {
    const { adult, account, groceries } = await setup();
    await imp.upsertAccountMapping({ sourceAccountId: '7', accountId: account.id });
    await imp.createRule({ pattern: 'rewe', envelopeId: groceries.id }, adult.user.id);
    await imp.ingest([fakeLine({ sourceId: '7:1' })]);
    const [booked] = await db.select().from(feohImportedTransactions);
    const deleted = await feoh.deleteTransaction(booked!.transactionId!);
    expect(deleted).not.toBeNull();
    const [after] = await db.select().from(feohImportedTransactions);
    expect(after!.status).toBe('pending');
    expect(after!.transactionId).toBeNull();
    expect(after!.appliedRuleId).toBeNull();
    expect(await db.select().from(transactions)).toHaveLength(0);
    // re-import of the same line is still a no-op: the register kept the row
    expect((await imp.ingest([fakeLine({ sourceId: '7:1' })])).inserted).toBe(0);
  });

  it('two concurrent confirms of one line book exactly one transaction', async () => {
    const { adult, account, groceries } = await setup();
    await imp.upsertAccountMapping({ sourceAccountId: '7', accountId: account.id });
    await imp.ingest([fakeLine({ sourceId: '6:5', payee: 'Aldi' })]);
    const [pending] = await db.select().from(feohImportedTransactions);
    const results = await Promise.all([
      imp.confirmInboxRow(pending!.id, { envelopeId: groceries.id }, adult.user.id),
      imp.confirmInboxRow(pending!.id, { envelopeId: groceries.id }, adult.user.id),
    ]);
    expect(results.every((r) => r.status === 'booked')).toBe(true);
    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(await db.select().from(transactions)).toHaveLength(1);
  });

  it('addManualLine goes through ingest — prefixed source_id, rule hit books, repeat is a no-op', async () => {
    const { adult, account, groceries } = await setup();
    await imp.upsertAccountMapping({ sourceAccountId: 'cash', accountId: account.id });
    await imp.createRule({ pattern: 'bakery', envelopeId: groceries.id }, adult.user.id);
    const input = { sourceId: 'demo-1', sourceAccountId: 'cash', date: '2026-09-03', payee: 'Bakery', memo: null, amount: 3.5, direction: 'out' as const };
    const first = await imp.addManualLine(input);
    expect(first.created).toBe(true);
    expect(first.row.sourceId).toBe('manual:demo-1');
    expect(first.row.status).toBe('booked');
    expect(first.row.currency).toBe('EUR');
    const second = await imp.addManualLine(input);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
  });
});

describe('rules re-evaluation', () => {
  it('creating or editing a rule books matching PENDING rows only, never booked ones', async () => {
    const { adult, account, groceries, income } = await setup();
    await imp.upsertAccountMapping({ sourceAccountId: '7', accountId: account.id });
    await imp.ingest([fakeLine({ sourceId: '8:1', payee: 'Rewe' }), fakeLine({ sourceId: '8:2', payee: 'Aldi' })]);
    const rule = await imp.createRule({ pattern: 'rewe', envelopeId: groceries.id }, adult.user.id);
    let rows = await db.select().from(feohImportedTransactions);
    expect(rows.find((r) => r.sourceId === '8:1')!.status).toBe('booked');
    expect(rows.find((r) => r.sourceId === '8:2')!.status).toBe('pending');
    // Editing the rule to also match Aldi books Aldi; the Rewe booking is untouched.
    await imp.updateRule(rule.id, { pattern: 'a', envelopeId: income.id });
    rows = await db.select().from(feohImportedTransactions);
    expect(rows.find((r) => r.sourceId === '8:2')!.status).toBe('booked');
    expect(rows.find((r) => r.sourceId === '8:2')!.envelopeId).toBe(income.id);
    expect(rows.find((r) => r.sourceId === '8:1')!.envelopeId).toBe(groceries.id);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd Heorth && npx vitest run tests/feoh-import-service.test.ts`
Expected: FAIL — `../src/modules/feoh/import/service.js` not found.

- [ ] **Step 3: Write the service**

Create `Heorth/src/modules/feoh/import/service.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { config } from '../../../config/env.js';
import { recordTransaction } from '../service.js';
import { matchRule } from './rules.js';
import {
  feohImportAccounts, feohImportRules, feohImportedTransactions,
  type ImportAccountMapping, type ImportRule, type ImportedTransactionRow, type ImportStatus,
} from './schema.js';
import type { ImportedTransaction } from './providers/types.js';

/** The drizzle transaction handle type, for callers that already hold one. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------------------------------------------------------------- mappings

export function listAccountMappings(): Promise<ImportAccountMapping[]> {
  return db.select().from(feohImportAccounts).orderBy(asc(feohImportAccounts.sourceAccountId));
}

export async function upsertAccountMapping(i: { sourceAccountId: string; accountId: string }): Promise<ImportAccountMapping> {
  const [row] = await db.insert(feohImportAccounts)
    .values({ sourceAccountId: i.sourceAccountId, accountId: i.accountId })
    .onConflictDoUpdate({
      target: feohImportAccounts.sourceAccountId,
      set: { accountId: i.accountId, updatedAt: new Date() },
    })
    .returning();
  return row!;
}

export async function deleteAccountMapping(id: string): Promise<ImportAccountMapping | null> {
  const [row] = await db.delete(feohImportAccounts).where(eq(feohImportAccounts.id, id)).returning();
  return row ?? null;
}

// ------------------------------------------------------------------- rules

export function listRules(): Promise<ImportRule[]> {
  return db.select().from(feohImportRules).orderBy(asc(feohImportRules.priority), asc(feohImportRules.id));
}

export interface RuleInput { pattern: string; envelopeId: string; priority?: number; enabled?: boolean }

export async function createRule(i: RuleInput, createdBy: string): Promise<ImportRule> {
  const [row] = await db.insert(feohImportRules).values({
    pattern: i.pattern, envelopeId: i.envelopeId, priority: i.priority ?? 0, enabled: i.enabled ?? true, createdBy,
  }).returning();
  await reapplyRulesToPending();
  return row!;
}

export async function updateRule(id: string, i: Partial<RuleInput>): Promise<ImportRule | null> {
  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (i.pattern !== undefined) patch['pattern'] = i.pattern;
  if (i.envelopeId !== undefined) patch['envelopeId'] = i.envelopeId;
  if (i.priority !== undefined) patch['priority'] = i.priority;
  if (i.enabled !== undefined) patch['enabled'] = i.enabled;
  const [row] = await db.update(feohImportRules).set(patch).where(eq(feohImportRules.id, id)).returning();
  if (!row) return null;
  await reapplyRulesToPending();
  return row;
}

export async function deleteRule(id: string): Promise<ImportRule | null> {
  const [row] = await db.delete(feohImportRules).where(eq(feohImportRules.id, id)).returning();
  return row ?? null;
}

// ------------------------------------------------------------------- inbox

export async function listInbox(q: { status?: ImportStatus; limit?: number; offset?: number }) {
  const where = q.status ? eq(feohImportedTransactions.status, q.status) : undefined;
  const limit = Math.min(100, Math.max(1, q.limit ?? 50));
  const offset = Math.max(0, q.offset ?? 0);
  const rows = await db.select().from(feohImportedTransactions).where(where)
    .orderBy(desc(feohImportedTransactions.date), desc(feohImportedTransactions.createdAt))
    .limit(limit).offset(offset);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` }).from(feohImportedTransactions).where(where);
  return { rows, total: count, limit, offset };
}

export async function getInboxRow(id: string): Promise<ImportedTransactionRow | null> {
  const [row] = await db.select().from(feohImportedTransactions).where(eq(feohImportedTransactions.id, id)).limit(1);
  return row ?? null;
}

export interface IngestResult { inserted: number; booked: number; skipped: number }

/**
 * The pipeline (spec §3). For every line: known source_id -> skip; else insert
 * `pending`; then try to auto-book (household currency + mapped account + rule
 * hit). Booking goes through `recordTransaction()` — never a direct posting write.
 */
export async function ingest(items: ImportedTransaction[]): Promise<IngestResult> {
  const result: IngestResult = { inserted: 0, booked: 0, skipped: 0 };
  if (items.length === 0) return result;

  const known = new Set((await db.select({ sourceId: feohImportedTransactions.sourceId })
    .from(feohImportedTransactions)
    .where(inArray(feohImportedTransactions.sourceId, items.map((i) => i.sourceId))))
    .map((r) => r.sourceId));
  const [mappings, rules] = await Promise.all([listAccountMappings(), listRules()]);
  const accountFor = new Map(mappings.map((m) => [m.sourceAccountId, m.accountId]));

  for (const item of items) {
    if (known.has(item.sourceId)) { result.skipped++; continue; }
    const [row] = await db.insert(feohImportedTransactions).values({
      sourceId: item.sourceId, sourceAccountId: item.sourceAccountId, date: item.date,
      payee: item.payee, memo: item.memo, amount: item.amount.toFixed(2), currency: item.currency,
      direction: item.direction, status: 'pending',
    }).onConflictDoNothing({ target: feohImportedTransactions.sourceId }).returning();
    if (!row) { result.skipped++; continue; } // raced with a concurrent tick
    result.inserted++;
    known.add(item.sourceId);

    if (row.currency !== config.feohCurrency) continue;
    const accountId = accountFor.get(row.sourceAccountId);
    if (!accountId) continue;
    const rule = matchRule(row.payee, rules);
    if (!rule) continue;
    await bookRow(row, rule.envelopeId, accountId, rule.createdBy, rule.id);
    result.booked++;
  }
  return result;
}

export interface ManualLineInput {
  sourceId?: string;
  sourceAccountId: string;
  date: string;
  payee: string;
  memo?: string | null;
  amount: number;
  currency?: string;
  direction: 'in' | 'out';
}

/** A hand-typed statement line (and how seed-demo.mjs fills the demo inbox). Same pipeline as a provider line. */
export async function addManualLine(i: ManualLineInput): Promise<{ row: ImportedTransactionRow; created: boolean }> {
  const sourceId = `manual:${i.sourceId ?? randomUUID()}`;
  const r = await ingest([{
    sourceId, sourceAccountId: i.sourceAccountId, date: i.date, payee: i.payee, memo: i.memo ?? null,
    amount: i.amount, currency: i.currency ?? config.feohCurrency, direction: i.direction,
  }]);
  const [row] = await db.select().from(feohImportedTransactions).where(eq(feohImportedTransactions.sourceId, sourceId)).limit(1);
  return { row: row!, created: r.inserted === 1 };
}

export async function confirmInboxRow(
  id: string,
  i: { envelopeId: string; accountId?: string },
  memberId: string,
): Promise<ImportedTransactionRow> {
  const row = await getInboxRow(id);
  if (!row) throw new Error('NOT_FOUND');
  if (row.status !== 'pending') throw new Error('NOT_PENDING');
  if (row.currency !== config.feohCurrency) throw new Error('CURRENCY_MISMATCH');
  let accountId = i.accountId;
  if (!accountId) {
    const [m] = await db.select().from(feohImportAccounts)
      .where(eq(feohImportAccounts.sourceAccountId, row.sourceAccountId)).limit(1);
    accountId = m?.accountId;
  }
  if (!accountId) throw new Error('ACCOUNT_UNMAPPED');
  return bookRow(row, i.envelopeId, accountId, memberId, null);
}

export async function dismissInboxRow(id: string): Promise<ImportedTransactionRow> {
  const row = await getInboxRow(id);
  if (!row) throw new Error('NOT_FOUND');
  if (row.status !== 'pending') throw new Error('NOT_PENDING');
  const [updated] = await db.update(feohImportedTransactions)
    .set({ status: 'dismissed', updatedAt: new Date() })
    .where(eq(feohImportedTransactions.id, id)).returning();
  return updated!;
}

/** Re-evaluate PENDING rows against the current rules. Booked rows are never touched (spec §4). */
export async function reapplyRulesToPending(): Promise<number> {
  const [pending, mappings, rules] = await Promise.all([
    db.select().from(feohImportedTransactions).where(eq(feohImportedTransactions.status, 'pending')),
    listAccountMappings(),
    listRules(),
  ]);
  const accountFor = new Map(mappings.map((m) => [m.sourceAccountId, m.accountId]));
  let booked = 0;
  for (const row of pending) {
    if (row.currency !== config.feohCurrency) continue;
    const accountId = accountFor.get(row.sourceAccountId);
    if (!accountId) continue;
    const rule = matchRule(row.payee, rules);
    if (!rule) continue;
    await bookRow(row, rule.envelopeId, accountId, rule.createdBy, rule.id);
    booked++;
  }
  return booked;
}

/**
 * Called by `deleteTransaction()` INSIDE its db.transaction and BEFORE the
 * DELETE: a booked import row goes back to `pending`, so the FK's SET NULL finds
 * nothing to null and the booked-pair check holds during the referential action.
 */
export async function revertBookedRows(tx: Tx, transactionId: string): Promise<number> {
  const rows = await tx.update(feohImportedTransactions)
    .set({ status: 'pending', transactionId: null, appliedRuleId: null, updatedAt: new Date() })
    .where(and(eq(feohImportedTransactions.transactionId, transactionId), eq(feohImportedTransactions.status, 'booked')))
    .returning({ id: feohImportedTransactions.id });
  return rows.length;
}

// ---------------------------------------------------------------- booking

/**
 * The one place an inbox row becomes ledger data — and ONE database
 * transaction: lock the row (`FOR UPDATE`) and re-check it is still pending,
 * write the ledger through `recordTransaction(…, tx)` on the same handle, mark
 * the row booked. All three commit or none do, so a crash can never leave a
 * ledger transaction without its inbox link (which dedup would then never
 * revisit). A concurrent tick or member on the same row blocks on the lock,
 * then sees it is no longer pending and returns it untouched.
 *
 * Exactly two postings, in the convention `reconcileAccount` and
 * `seed-demo.mjs` already use: out = envelope debit / account credit;
 * in = account debit / envelope credit.
 */
async function bookRow(
  row: ImportedTransactionRow,
  envelopeId: string,
  accountId: string,
  createdBy: string,
  appliedRuleId: string | null,
): Promise<ImportedTransactionRow> {
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(feohImportedTransactions)
      .where(eq(feohImportedTransactions.id, row.id)).for('update');
    if (!locked) throw new Error('NOT_FOUND');
    if (locked.status !== 'pending') return locked; // raced: someone else booked or dismissed it
    const amount = Number(locked.amount);
    const postingsFor = locked.direction === 'out'
      ? [
          { envelopeId, accountId: null, debit: amount, credit: 0 },
          { accountId, envelopeId: null, debit: 0, credit: amount },
        ]
      : [
          { accountId, envelopeId: null, debit: amount, credit: 0 },
          { envelopeId, accountId: null, debit: 0, credit: amount },
        ];
    const { transaction } = await recordTransaction({
      date: locked.date, payee: locked.payee, memo: locked.memo, amount, postings: postingsFor, splits: [],
    }, createdBy, tx);
    const [updated] = await tx.update(feohImportedTransactions).set({
      status: 'booked', transactionId: transaction.id, envelopeId, appliedRuleId, updatedAt: new Date(),
    }).where(eq(feohImportedTransactions.id, locked.id)).returning();
    return updated!;
  });
}
```

Replace the local `type Tx = …` line near the top of the file with `import type { Tx } from '../service.js';` — the type is exported from there in Step 4.

If `RecordTransactionInput` (inferred from `recordTransactionSchema`) rejects the literal `null` beside a set id, match its shape exactly (the validator declares both ids `optional().nullable()`, so it should not); do not loosen the validator.

- [ ] **Step 4: Let `recordTransaction()` join a caller's transaction, and unbook inside `deleteTransaction()`**

In `Heorth/src/modules/feoh/service.ts`, add at the top:

```ts
import { revertBookedRows } from './import/service.js';

/** The drizzle transaction handle, for callers that need several ledger steps to commit together. */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
```

Change `recordTransaction` so the body runs on a caller-supplied handle when given one — the validation and the statements are untouched, only the wrapper changes:

```ts
export async function recordTransaction(input: RecordTransactionInput, createdBy: string, tx?: Tx) {
  if (!postingsBalance(input.postings)) {
    throw new Error('UNBALANCED');
  }
  if (input.postings.some((p) => !p.accountId && !p.envelopeId)) {
    throw new Error('ORPHAN_POSTING');
  }
  const run = async (t: Tx) => {
    const [txn] = await t.insert(transactions).values({
      date: input.date, payee: input.payee, memo: input.memo ?? null,
      amount: String(input.amount), createdBy,
    }).returning();

    const postingRows = await t.insert(postings).values(
      input.postings.map((p) => ({
        transactionId: txn!.id,
        accountId: p.accountId ?? null,
        envelopeId: p.envelopeId ?? null,
        debit: String(p.debit),
        credit: String(p.credit),
      })),
    ).returning();

    let splitRows: Array<typeof expenseSplits.$inferSelect> = [];
    if (input.splits && input.splits.length > 0) {
      splitRows = await t.insert(expenseSplits).values(
        input.splits.map((s) => ({ transactionId: txn!.id, memberId: s.memberId, share: String(s.share) })),
      ).returning();
    }

    return { transaction: txn!, postings: postingRows, splits: splitRows };
  };
  // Postgres has no nested transactions: with a handle, join it; without, open one.
  return tx ? run(tx) : db.transaction(run);
}
```

Every existing caller passes two arguments and is unaffected.

and in `deleteTransaction`, immediately after `return db.transaction(async (tx) => {` and before the `touched` query:

```ts
    // ADR 0016: a booked bank line goes back to the inbox rather than losing the
    // record that the line existed. Must run BEFORE the delete — the FK's
    // SET NULL would otherwise violate the booked-pair check mid-statement.
    await revertBookedRows(tx, id);
```

`import/service.ts` imports `recordTransaction` from `../service.js`, and `../service.js` imports `revertBookedRows` from `./import/service.js`. That is a cycle of function references only — nothing at module top level calls across it — so ESM resolves it. Keep both as plain named imports.

- [ ] **Step 5: Run the tests**

Run: `cd Heorth && npx vitest run tests/feoh-import-service.test.ts tests/feoh-transactions.test.ts tests/feoh-occurrences.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit (Heorth)**

```bash
cd Heorth && git add src/modules/feoh/import/service.ts src/modules/feoh/service.ts tests/feoh-import-service.test.ts
git commit -m "feat(feoh): import pipeline - dedup, rules, inbox, booking via recordTransaction, unbooking on delete"
```

---

## Task 6: The sync tick

**Files:**
- Create: `Heorth/src/modules/feoh/import/sync.ts`
- Test: `Heorth/tests/feoh-import-sync.test.ts`

**Interfaces:**
- Consumes: `getTransactionSourceProvider()` (Task 3), `ingest()` (Task 5), `feohImportState` (Task 2), `SourceProviderError`
- Produces: `FEED_KEY = 'firefly:transactions'`, `PAGE_LIMIT = 100`, `runImportTick(): Promise<ImportTickResult>` (answers `error: 'provider_unavailable' | 'already_running'` without touching feed state), `classifySourceError(e): string`, `getImportStatus(): Promise<ImportStatusView>`, `ImportTickResult = { ok: boolean; pages: number; inserted: number; booked: number; skipped: number; error?: string }`, `ImportStatusView = { enabled: boolean; currency: string; pendingCount: number; feed: { feedKey; hasCursor: boolean; lastSuccessAt: string | null; lastError: string | null; consecutiveFailures: number } | null }`

- [ ] **Step 1: Write the failing test**

Create `Heorth/tests/feoh-import-sync.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { db } from '../src/db/index.js';
import { seedTestHousehold } from './helpers.js';
import * as feoh from '../src/modules/feoh/service.js';
import * as imp from '../src/modules/feoh/import/service.js';
import { runImportTick, getImportStatus, FEED_KEY, classifySourceError } from '../src/modules/feoh/import/sync.js';
import { setTransactionSourceProvider, resetTransactionSourceProvider } from '../src/modules/feoh/import/provider.js';
import { SourceProviderError } from '../src/modules/feoh/import/providers/types.js';
import { feohImportState, feohImportedTransactions } from '../src/modules/feoh/import/schema.js';
import { FakeSource, fakeLine } from './fake-source.js';

afterEach(() => resetTransactionSourceProvider());

async function state() {
  const [row] = await db.select().from(feohImportState);
  return row!;
}

describe('runImportTick', () => {
  it('reports provider_unavailable and writes no state when import is disabled', async () => {
    const r = await runImportTick();
    expect(r.ok).toBe(false);
    expect(r.error).toBe('provider_unavailable');
    expect(await db.select().from(feohImportState)).toHaveLength(0);
  });

  it('pulls every page of a sweep, ingests, and persists the checkpoint with a success stamp', async () => {
    await seedTestHousehold();
    const fake = new FakeSource();
    fake.rows = Array.from({ length: 250 }, (_, i) => fakeLine({ sourceId: `1:${i}`, date: '2026-09-01' }));
    setTransactionSourceProvider(fake);
    const r = await runImportTick();
    expect(r).toMatchObject({ ok: true, pages: 3, inserted: 250, booked: 0 });
    expect(fake.calls).toBe(3);
    const s = await state();
    expect(s.feedKey).toBe(FEED_KEY);
    expect(s.cursor).toBe('0'); // the fake's checkpoint
    expect(s.lastSuccessAt).not.toBeNull();
    expect(s.lastError).toBeNull();
    expect(s.consecutiveFailures).toBe(0);
  });

  it('a second sweep over the same rows is a no-op (overlap replay is free)', async () => {
    await seedTestHousehold();
    const fake = new FakeSource();
    fake.rows = [fakeLine({ sourceId: '2:1' }), fakeLine({ sourceId: '2:2' })];
    setTransactionSourceProvider(fake);
    await runImportTick();
    const r = await runImportTick();
    expect(r).toMatchObject({ ok: true, inserted: 0, skipped: 2 });
    expect(await db.select().from(feohImportedTransactions)).toHaveLength(2);
  });

  it('books rule hits during the tick and counts them', async () => {
    const { adult } = await seedTestHousehold();
    const account = await feoh.createAccount({ name: 'Joint', kind: 'asset', openingBalance: 0 });
    const groceries = await feoh.createEnvelope({ name: 'Groceries', monthlyBudget: 400 });
    await imp.upsertAccountMapping({ sourceAccountId: '7', accountId: account.id });
    await imp.createRule({ pattern: 'rewe', envelopeId: groceries.id }, adult.user.id);
    const fake = new FakeSource();
    fake.rows = [fakeLine({ sourceId: '3:1', payee: 'REWE' }), fakeLine({ sourceId: '3:2', payee: 'Aldi' })];
    setTransactionSourceProvider(fake);
    const r = await runImportTick();
    expect(r).toMatchObject({ ok: true, inserted: 2, booked: 1 });
  });

  it('never throws: a provider failure increments consecutive_failures and stores only the token', async () => {
    await seedTestHousehold();
    const fake = new FakeSource();
    fake.failWith = new SourceProviderError('auth_failed', 'HTTP 401 from https://firefly/api?token=SECRET');
    setTransactionSourceProvider(fake);
    const r1 = await runImportTick();
    expect(r1.ok).toBe(false);
    expect(r1.error).toBe('auth_failed');
    const r2 = await runImportTick();
    expect(r2.ok).toBe(false);
    const s = await state();
    expect(s.consecutiveFailures).toBe(2);
    expect(s.lastError).toBe('auth_failed');
    expect(s.lastSuccessAt).toBeNull();
    // a later success clears the failure state
    fake.failWith = null;
    await runImportTick();
    const after = await state();
    expect(after.consecutiveFailures).toBe(0);
    expect(after.lastError).toBeNull();
  });

  it('persists the mid-sweep cursor after each fully written page', async () => {
    await seedTestHousehold();
    const fake = new FakeSource();
    fake.rows = Array.from({ length: 150 }, (_, i) => fakeLine({ sourceId: `4:${i}` }));
    // fail on the second call, after the first page was written
    const original = fake.listSince.bind(fake);
    fake.listSince = async (cursor, limit) => {
      if (fake.calls === 1) { fake.calls++; throw new SourceProviderError('network_error'); }
      return original(cursor, limit);
    };
    setTransactionSourceProvider(fake);
    const r = await runImportTick();
    expect(r.ok).toBe(false);
    expect(r.inserted).toBe(100);
    expect((await state()).cursor).toBe('100');
    // the next tick resumes from that cursor and finishes the sweep
    const r2 = await runImportTick();
    expect(r2).toMatchObject({ ok: true, inserted: 50 });
    expect((await state()).cursor).toBe('0');
  });
});

describe('runImportTick — one at a time', () => {
  it('a second tick while one is running answers already_running and leaves the feed state alone', async () => {
    await seedTestHousehold();
    const fake = new FakeSource();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const original = fake.listSince.bind(fake);
    fake.listSince = async (cursor, limit) => { await gate; return original(cursor, limit); };
    setTransactionSourceProvider(fake);
    const first = runImportTick();
    const second = await runImportTick();
    expect(second.error).toBe('already_running');
    release();
    expect((await first).ok).toBe(true);
    expect((await state()).consecutiveFailures).toBe(0);
    expect((await state()).lastError).toBeNull();
  });
});

describe('classifySourceError', () => {
  it('maps provider reasons, TypeError to network_error, everything else to error', () => {
    expect(classifySourceError(new SourceProviderError('rate_limited'))).toBe('rate_limited');
    expect(classifySourceError(new TypeError('fetch failed'))).toBe('network_error');
    expect(classifySourceError(new Error('boom'))).toBe('error');
  });
});

describe('getImportStatus', () => {
  it('reports disabled + no feed before any tick, and never the cursor text', async () => {
    const before = await getImportStatus();
    expect(before).toEqual({ enabled: false, currency: 'EUR', pendingCount: 0, feed: null });
    await seedTestHousehold();
    const fake = new FakeSource();
    fake.rows = [fakeLine({ sourceId: '5:1' })];
    setTransactionSourceProvider(fake);
    await runImportTick();
    const after = await getImportStatus();
    expect(after.enabled).toBe(true);
    expect(after.pendingCount).toBe(1);
    expect(after.feed).toMatchObject({ feedKey: FEED_KEY, hasCursor: true, consecutiveFailures: 0 });
    expect(JSON.stringify(after)).not.toContain('"cursor"');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd Heorth && npx vitest run tests/feoh-import-sync.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `Heorth/src/modules/feoh/import/sync.ts`:

```ts
import { eq, sql } from 'drizzle-orm';
import { logError } from '@wyrhta/core/lib';
import { db } from '../../../db/index.js';
import { feohImportState, feohImportedTransactions, type ImportState } from './schema.js';
import { getTransactionSourceProvider } from './provider.js';
import { SourceProviderError, type TransactionSourceProvider } from './providers/types.js';
import { ingest } from './service.js';
import { config } from '../../../config/env.js';

export const FEED_KEY = 'firefly:transactions';
export const PAGE_LIMIT = 100;
/** Hard stop against a provider whose nextCursor never reaches null. */
const MAX_PAGES_PER_TICK = 1000;

export interface ImportTickResult {
  ok: boolean;
  pages: number;
  inserted: number;
  booked: number;
  skipped: number;
  error?: string;
}

/** Only ever a short, safe token — never a response body, URL or token material. */
export function classifySourceError(e: unknown): string {
  if (e instanceof SourceProviderError) return e.reason;
  if (e instanceof TypeError) return 'network_error';
  return 'error';
}

async function getOrCreateState(feedKey: string): Promise<ImportState> {
  const [existing] = await db.select().from(feohImportState).where(eq(feohImportState.feedKey, feedKey)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(feohImportState).values({ feedKey })
    .onConflictDoNothing({ target: feohImportState.feedKey }).returning();
  if (created) return created;
  const [raced] = await db.select().from(feohImportState).where(eq(feohImportState.feedKey, feedKey)).limit(1);
  return raced!;
}

async function saveCursor(feedKey: string, cursor: string): Promise<void> {
  await db.update(feohImportState).set({ cursor, updatedAt: new Date() }).where(eq(feohImportState.feedKey, feedKey));
}

async function saveSuccess(feedKey: string, checkpoint: string): Promise<void> {
  await db.update(feohImportState).set({
    cursor: checkpoint, lastSuccessAt: new Date(), lastError: null, consecutiveFailures: 0, updatedAt: new Date(),
  }).where(eq(feohImportState.feedKey, feedKey));
}

async function saveFailure(feedKey: string, reason: string): Promise<void> {
  await db.update(feohImportState).set({
    lastError: reason, consecutiveFailures: sql`${feohImportState.consecutiveFailures} + 1`, updatedAt: new Date(),
  }).where(eq(feohImportState.feedKey, feedKey));
}

/** One tick at a time per process: the scheduler and the manual trigger share this. */
let running = false;

/**
 * One tick (spec §3). Pull pages from the persisted cursor, ingest each page,
 * and advance the cursor ONLY after the whole page is written. A dead tick
 * replays its last page harmlessly (dedup on source_id). Never throws.
 * `already_running` and `provider_unavailable` are answered without touching
 * the feed state — neither is a feed failure.
 */
export async function runImportTick(): Promise<ImportTickResult> {
  const result: ImportTickResult = { ok: false, pages: 0, inserted: 0, booked: 0, skipped: 0 };
  const provider = getTransactionSourceProvider();
  if (!provider) return { ...result, error: 'provider_unavailable' };
  if (running) return { ...result, error: 'already_running' };
  running = true;
  try {
    return await runSweep(provider, result);
  } finally {
    running = false;
  }
}

async function runSweep(provider: TransactionSourceProvider, result: ImportTickResult): Promise<ImportTickResult> {
  const state = await getOrCreateState(FEED_KEY);
  let cursor = state.cursor;
  try {
    for (;;) {
      const page = await provider.listSince(cursor, PAGE_LIMIT);
      const r = await ingest(page.items);
      result.pages++;
      result.inserted += r.inserted;
      result.booked += r.booked;
      result.skipped += r.skipped;
      if (page.nextCursor === null) {
        await saveSuccess(FEED_KEY, page.checkpoint);
        break;
      }
      cursor = page.nextCursor;
      await saveCursor(FEED_KEY, cursor);
      if (result.pages >= MAX_PAGES_PER_TICK) throw new SourceProviderError('bad_response', 'page cap reached');
    }
    result.ok = true;
    return result;
  } catch (e) {
    const reason = classifySourceError(e);
    await saveFailure(FEED_KEY, reason);
    // A SourceProviderError message is provider-authored and body-free, but the
    // log line still carries only the token; anything else is a Heorth bug and
    // deserves its stack.
    logError('feoh import tick failed', e instanceof SourceProviderError ? new Error(reason) : e);
    return { ...result, error: reason };
  }
}

export interface ImportStatusView {
  enabled: boolean;
  /** The household's one currency (`FEOH_CURRENCY`) — the web reads it from here, never hard-codes it. */
  currency: string;
  pendingCount: number;
  feed: {
    feedKey: string;
    hasCursor: boolean;
    lastSuccessAt: string | null;
    lastError: string | null;
    consecutiveFailures: number;
  } | null;
}

/** For `GET /ingestion/status`. The cursor itself is never exposed. */
export async function getImportStatus(): Promise<ImportStatusView> {
  const [feed] = await db.select().from(feohImportState).where(eq(feohImportState.feedKey, FEED_KEY)).limit(1);
  const [{ count }] = await db.select({ count: sql<number>`count(*)::int` })
    .from(feohImportedTransactions).where(eq(feohImportedTransactions.status, 'pending'));
  return {
    enabled: getTransactionSourceProvider() !== null,
    currency: config.feohCurrency,
    pendingCount: count,
    feed: feed
      ? {
          feedKey: feed.feedKey,
          hasCursor: feed.cursor !== null,
          lastSuccessAt: feed.lastSuccessAt ? feed.lastSuccessAt.toISOString() : null,
          lastError: feed.lastError,
          consecutiveFailures: feed.consecutiveFailures,
        }
      : null,
  };
}
```

`toISOString()` on `lastSuccessAt` is an instant, not a date — the AGENTS rule forbids deriving a *calendar date* from it, and this is a timestamp string for the API, the same shape every other `*At` field uses.

- [ ] **Step 4: Run the tests**

Run: `cd Heorth && npx vitest run tests/feoh-import-sync.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit (Heorth)**

```bash
cd Heorth && git add src/modules/feoh/import/sync.ts tests/feoh-import-sync.test.ts
git commit -m "feat(feoh): import tick - page loop, cursor after durable page, classified failures"
```

---

## Task 7: The Firefly provider and its fixture

**Files:**
- Create: `Heorth/src/modules/feoh/import/providers/firefly.ts`, `Heorth/tests/fixtures/firefly-transactions.json`, `Heorth/tests/fixtures/firefly-accounts.json`
- Modify: `Heorth/src/modules/feoh/import/provider.ts` (default resolver)
- Test: `Heorth/tests/feoh-import-firefly.test.ts`

**Interfaces:**
- Produces: `createFireflyProvider(o: FireflyOptions): TransactionSourceProvider` with `FireflyOptions = { baseUrl: string; pat: string; fetchImpl?: typeof fetch; overlapDays?: number; pageSize?: number }`; pure exports `parseTransactionsPage(json: unknown): { lines: FireflyLine[]; totalPages: number }`, `parseAccounts(json: unknown): SourceAccount[]`, `minusDays(isoDate: string, days: number): string`, and `FireflyLine = ImportedTransaction & { key: [string, number, number] }`
- Modifies the seam so `getTransactionSourceProvider()` returns a Firefly provider when `config.feohImport` is set and nothing is overridden.

Firefly III v6 shapes this code relies on (from the probe in ADR 0016 and the v6.6.6 API):

- `GET /api/v1/transactions?limit=N&page=P[&start=YYYY-MM-DD]` → `{ data: [{ type: 'transactions', id: '<groupId>', attributes: { group_title, transactions: [ { transaction_journal_id: '<journalId>', type: 'withdrawal'|'deposit'|'transfer'|..., date: '2026-09-01T00:00:00+02:00', amount: '42.100000000000', currency_code: 'EUR', description, source_id, source_name, destination_id, destination_name, external_id, ... } ] } }], meta: { pagination: { total, count, per_page, current_page, total_pages } } }`
- `GET /api/v1/accounts?type=asset&limit=N&page=P` → `{ data: [{ id, attributes: { name, type: 'asset', currency_code, active, ... } }], meta: { pagination: {...} } }`
- Auth: `Authorization: Bearer <PAT>`, `Accept: application/json`.

- [ ] **Step 1: Write the fixtures**

Create `Heorth/tests/fixtures/firefly-transactions.json` — one page, three groups, four journal lines: a plain withdrawal, a three-line split on the same date as the withdrawal (exercises the composite watermark), and a deposit. Values are the subset of Firefly's attributes the parser reads plus a few it must ignore.

```json
{
  "data": [
    {
      "type": "transactions",
      "id": "101",
      "attributes": {
        "created_at": "2026-09-02T08:00:00+02:00",
        "group_title": null,
        "transactions": [
          {
            "transaction_journal_id": "1001",
            "type": "withdrawal",
            "date": "2026-09-01T00:00:00+02:00",
            "amount": "42.100000000000",
            "currency_code": "EUR",
            "description": "REWE SAGT DANKE 4711",
            "source_id": "7",
            "source_name": "Joint current account",
            "destination_id": "31",
            "destination_name": "REWE",
            "external_id": "bank-ref-0001",
            "budget_id": null,
            "category_name": null
          }
        ]
      }
    },
    {
      "type": "transactions",
      "id": "102",
      "attributes": {
        "created_at": "2026-09-02T08:00:01+02:00",
        "group_title": "Amazon order 302-1",
        "transactions": [
          {
            "transaction_journal_id": "1002",
            "type": "withdrawal",
            "date": "2026-09-01T00:00:00+02:00",
            "amount": "19.990000000000",
            "currency_code": "EUR",
            "description": "Kettle descaler",
            "source_id": "7",
            "source_name": "Joint current account",
            "destination_id": "40",
            "destination_name": "Amazon",
            "external_id": "bank-ref-0002"
          },
          {
            "transaction_journal_id": "1003",
            "type": "withdrawal",
            "date": "2026-09-01T00:00:00+02:00",
            "amount": "8.500000000000",
            "currency_code": "EUR",
            "description": "School pencils",
            "source_id": "7",
            "source_name": "Joint current account",
            "destination_id": "40",
            "destination_name": "Amazon",
            "external_id": "bank-ref-0002"
          },
          {
            "transaction_journal_id": "1004",
            "type": "withdrawal",
            "date": "2026-09-01T00:00:00+02:00",
            "amount": "12.000000000000",
            "currency_code": "USD",
            "description": "Ebook",
            "source_id": "7",
            "source_name": "Joint current account",
            "destination_id": "40",
            "destination_name": "Amazon",
            "external_id": "bank-ref-0002"
          }
        ]
      }
    },
    {
      "type": "transactions",
      "id": "103",
      "attributes": {
        "created_at": "2026-09-03T08:00:00+02:00",
        "group_title": null,
        "transactions": [
          {
            "transaction_journal_id": "1005",
            "type": "deposit",
            "date": "2026-09-03T00:00:00+02:00",
            "amount": "3850.000000000000",
            "currency_code": "EUR",
            "description": "SALARY 09/2026",
            "source_id": "55",
            "source_name": "ACME GmbH",
            "destination_id": "7",
            "destination_name": "Joint current account",
            "external_id": "bank-ref-0003"
          },
          {
            "transaction_journal_id": "1006",
            "type": "transfer",
            "date": "2026-09-03T00:00:00+02:00",
            "amount": "500.000000000000",
            "currency_code": "EUR",
            "description": "To savings",
            "source_id": "7",
            "source_name": "Joint current account",
            "destination_id": "8",
            "destination_name": "Savings"
          }
        ]
      }
    }
  ],
  "meta": {
    "pagination": { "total": 3, "count": 3, "per_page": 100, "current_page": 1, "total_pages": 1 }
  },
  "links": { "self": "https://firefly.invalid/api/v1/transactions?page=1", "first": "https://firefly.invalid/api/v1/transactions?page=1", "last": "https://firefly.invalid/api/v1/transactions?page=1" }
}
```

Create `Heorth/tests/fixtures/firefly-accounts.json`:

```json
{
  "data": [
    { "type": "accounts", "id": "7", "attributes": { "name": "Joint current account", "type": "asset", "account_role": "defaultAsset", "currency_code": "EUR", "active": true } },
    { "type": "accounts", "id": "8", "attributes": { "name": "Savings", "type": "asset", "account_role": "savingAsset", "currency_code": "EUR", "active": true } }
  ],
  "meta": { "pagination": { "total": 2, "count": 2, "per_page": 100, "current_page": 1, "total_pages": 1 } }
}
```

- [ ] **Step 2: Write the failing test**

Create `Heorth/tests/feoh-import-firefly.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  createFireflyProvider, parseTransactionsPage, parseAccounts, minusDays,
} from '../src/modules/feoh/import/providers/firefly.js';
import { SourceProviderError } from '../src/modules/feoh/import/providers/types.js';

const transactionsFixture = JSON.parse(readFileSync(new URL('./fixtures/firefly-transactions.json', import.meta.url), 'utf8')) as unknown;
const accountsFixture = JSON.parse(readFileSync(new URL('./fixtures/firefly-accounts.json', import.meta.url), 'utf8')) as unknown;

/** A fetch that serves the fixtures and records every request. */
function fakeFetch(opts: { status?: number; body?: unknown; throwNetwork?: boolean } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: Object.fromEntries(new Headers(init?.headers).entries()) });
    if (opts.throwNetwork) throw new TypeError('fetch failed');
    const status = opts.status ?? 200;
    const body = opts.body ?? (url.includes('/api/v1/accounts') ? accountsFixture : transactionsFixture);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status, headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { impl, calls };
}

describe('parseTransactionsPage (fixture contract)', () => {
  it('emits one line per withdrawal/deposit journal, skips transfers, keeps split lines distinct', () => {
    const { lines, totalPages } = parseTransactionsPage(transactionsFixture);
    expect(totalPages).toBe(1);
    expect(lines.map((l) => l.sourceId)).toEqual(['101:1001', '102:1002', '102:1003', '102:1004', '103:1005']);
    const rewe = lines[0]!;
    expect(rewe).toMatchObject({ direction: 'out', sourceAccountId: '7', date: '2026-09-01', payee: 'REWE', memo: 'REWE SAGT DANKE 4711', amount: 42.1, currency: 'EUR' });
    const salary = lines[4]!;
    expect(salary).toMatchObject({ direction: 'in', sourceAccountId: '7', payee: 'ACME GmbH', memo: 'SALARY 09/2026', amount: 3850 });
    expect(lines[3]!.currency).toBe('USD');
  });

  it('falls back to the description when the counterparty name is blank, and nulls a memo equal to the payee', () => {
    const { lines } = parseTransactionsPage({
      data: [{ id: '5', attributes: { transactions: [
        { transaction_journal_id: '9', type: 'withdrawal', date: '2026-09-01T00:00:00+02:00', amount: '1.00', currency_code: 'EUR', description: 'Kiosk', source_id: '7', source_name: 'Joint', destination_id: '2', destination_name: '' },
      ] } }],
      meta: { pagination: { total_pages: 1 } },
    });
    expect(lines[0]).toMatchObject({ payee: 'Kiosk', memo: null });
  });

  it('rejects a body that is not a Firefly page, or a journal without ids/currency, with bad_response', () => {
    expect(() => parseTransactionsPage({ hello: 'world' })).toThrow(SourceProviderError);
    try { parseTransactionsPage('<html>'); } catch (e) { expect((e as SourceProviderError).reason).toBe('bad_response'); }
    const journal = { type: 'withdrawal', date: '2026-09-01T00:00:00+02:00', amount: '1.00', currency_code: 'EUR', description: 'x', source_id: '7', destination_id: '2' };
    const page = (id: unknown, j: Record<string, unknown>) => ({ data: [{ id, attributes: { transactions: [j] } }], meta: { pagination: { total_pages: 1 } } });
    expect(() => parseTransactionsPage(page('', { ...journal, transaction_journal_id: '9' }))).toThrow(/ids/);
    expect(() => parseTransactionsPage(page('5', { ...journal, transaction_journal_id: 'abc' }))).toThrow(/ids/);
    expect(() => parseTransactionsPage(page('5', { ...journal, transaction_journal_id: '9', currency_code: '' }))).toThrow(/currency/);
    expect(() => parseTransactionsPage(page('5', { ...journal, transaction_journal_id: '9', source_id: '' }))).toThrow(/account id/);
  });
});

describe('parseAccounts', () => {
  it('maps id, name and currency', () => {
    expect(parseAccounts(accountsFixture)).toEqual([
      { sourceAccountId: '7', name: 'Joint current account', currency: 'EUR' },
      { sourceAccountId: '8', name: 'Savings', currency: 'EUR' },
    ]);
  });
});

describe('minusDays', () => {
  it('does calendar arithmetic without timezone drift', () => {
    expect(minusDays('2026-09-01', 7)).toBe('2026-08-25');
    expect(minusDays('2026-03-01', 1)).toBe('2026-02-28');
    expect(minusDays('2026-01-01', 1)).toBe('2025-12-31');
  });
});

describe('createFireflyProvider', () => {
  it('sends the bearer token, sorts by (date, group, journal), and pages with a composite watermark', async () => {
    const f = fakeFetch();
    const p = createFireflyProvider({ baseUrl: 'https://firefly.invalid/', pat: 'PAT-1', fetchImpl: f.impl, overlapDays: 7 });
    const page1 = await p.listSince(null, 2);
    expect(f.calls[0]!.url).toBe('https://firefly.invalid/api/v1/transactions?limit=200&page=1');
    expect(f.calls[0]!.headers['authorization']).toBe('Bearer PAT-1');
    expect(page1.items.map((i) => i.sourceId)).toEqual(['101:1001', '102:1002']);
    expect(page1.nextCursor).not.toBeNull();
    // the limit cut through four same-date rows; the remainder must not be lost
    const page2 = await p.listSince(page1.nextCursor, 2);
    expect(page2.items.map((i) => i.sourceId)).toEqual(['102:1003', '102:1004']);
    const page3 = await p.listSince(page2.nextCursor, 2);
    expect(page3.items.map((i) => i.sourceId)).toEqual(['103:1005']);
    expect(page3.nextCursor).toBeNull();
    // checkpoint = last seen date minus the overlap, with no `after`
    expect(JSON.parse(page3.checkpoint)).toEqual({ since: '2026-08-27', after: null });
  });

  it('a later sweep starts from the checkpoint date (start= is sent) and re-emits the overlap', async () => {
    const f = fakeFetch();
    const p = createFireflyProvider({ baseUrl: 'https://firefly.invalid', pat: 'x', fetchImpl: f.impl });
    const page = await p.listSince(JSON.stringify({ since: '2026-08-27', after: null }), 100);
    expect(f.calls[0]!.url).toContain('start=2026-08-27');
    expect(page.items).toHaveLength(5);
    expect(page.nextCursor).toBeNull();
  });

  it('an empty Firefly keeps the previous since', async () => {
    const f = fakeFetch({ body: { data: [], meta: { pagination: { total_pages: 1 } } } });
    const p = createFireflyProvider({ baseUrl: 'https://firefly.invalid', pat: 'x', fetchImpl: f.impl });
    const page = await p.listSince(JSON.stringify({ since: '2026-08-01', after: null }), 100);
    expect(page.items).toEqual([]);
    expect(JSON.parse(page.checkpoint)).toEqual({ since: '2026-08-01', after: null });
  });

  it('lists asset accounts', async () => {
    const f = fakeFetch();
    const p = createFireflyProvider({ baseUrl: 'https://firefly.invalid', pat: 'x', fetchImpl: f.impl });
    expect(await p.listAccounts()).toHaveLength(2);
    expect(f.calls[0]!.url).toBe('https://firefly.invalid/api/v1/accounts?type=asset&limit=200&page=1');
  });

  it('classifies failures and never leaks the body or the token into the message', async () => {
    for (const [status, reason] of [[401, 'auth_failed'], [403, 'auth_failed'], [429, 'rate_limited'], [500, 'error']] as const) {
      const f = fakeFetch({ status, body: 'SECRET-BODY' });
      const p = createFireflyProvider({ baseUrl: 'https://firefly.invalid', pat: 'TOKEN-XYZ', fetchImpl: f.impl });
      const e = await p.listSince(null, 10).catch((x: unknown) => x) as SourceProviderError;
      expect(e).toBeInstanceOf(SourceProviderError);
      expect(e.reason).toBe(reason);
      expect(e.message).not.toContain('SECRET-BODY');
      expect(e.message).not.toContain('TOKEN-XYZ');
    }
    const net = fakeFetch({ throwNetwork: true });
    const p = createFireflyProvider({ baseUrl: 'https://firefly.invalid', pat: 'x', fetchImpl: net.impl });
    await expect(p.listSince(null, 10)).rejects.toMatchObject({ reason: 'network_error' });
    const html = fakeFetch({ body: '<html>login</html>' });
    const q = createFireflyProvider({ baseUrl: 'https://firefly.invalid', pat: 'x', fetchImpl: html.impl });
    await expect(q.listSince(null, 10)).rejects.toMatchObject({ reason: 'bad_response' });
  });

  it('refuses to run without a token', async () => {
    const f = fakeFetch();
    const p = createFireflyProvider({ baseUrl: 'https://firefly.invalid', pat: '', fetchImpl: f.impl });
    await expect(p.listSince(null, 10)).rejects.toMatchObject({ reason: 'no_credentials' });
    expect(f.calls).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd Heorth && npx vitest run tests/feoh-import-firefly.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the provider**

Create `Heorth/src/modules/feoh/import/providers/firefly.ts`:

```ts
import {
  SourceProviderError,
  type ImportedTransaction, type SourceAccount, type SourcePage, type TransactionSourceProvider,
} from './types.js';

/**
 * Firefly III as a dumb pipe (ADR 0016 §1). Two GETs with a personal access
 * token; nothing else of Firefly's model is touched. No Firefly type leaves this
 * file: everything crosses the boundary as `ImportedTransaction`.
 *
 * Cursor (opaque to callers): JSON `{ since: 'YYYY-MM-DD' | null, after: [date, groupId, journalId] | null }`.
 * `since` bounds the fetch (Firefly's `start=`); `after` is the composite
 * watermark WITHIN a sweep. Firefly pages by page number and sorts newest first,
 * so a sweep fetches the whole `since` window, sorts it into a total order, and
 * hands it out `limit` rows at a time — a date alone would let a `limit` cut
 * through same-date rows and lose the remainder forever.
 *
 * The checkpoint re-windows `since` by `overlapDays` (banks backdate; dedup on
 * source_id makes the replay free) and clears `after`.
 */

export interface FireflyOptions {
  baseUrl: string;
  pat: string;
  fetchImpl?: typeof fetch;
  overlapDays?: number;
  pageSize?: number;
}

export type LineKey = [string, number, number];
export type FireflyLine = ImportedTransaction & { key: LineKey };

interface Cursor { since: string | null; after: LineKey | null }

const DEFAULT_OVERLAP_DAYS = 7;
const DEFAULT_PAGE_SIZE = 200;

// ---------------------------------------------------------------- parsing

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function totalPagesOf(json: Record<string, unknown>): number {
  const meta = isRecord(json['meta']) ? json['meta'] : null;
  const pag = meta && isRecord(meta['pagination']) ? meta['pagination'] : null;
  const n = pag ? Number(pag['total_pages']) : 1;
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Firefly's `date` is an ISO datetime with offset; the calendar date is its first 10 chars — never `toISOString()`. */
function calendarDate(v: unknown): string {
  const s = str(v);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) throw new SourceProviderError('bad_response', 'journal without a date');
  return s.slice(0, 10);
}

export function parseTransactionsPage(json: unknown): { lines: FireflyLine[]; totalPages: number } {
  if (!isRecord(json) || !Array.isArray(json['data'])) {
    throw new SourceProviderError('bad_response', 'not a Firefly transactions page');
  }
  const lines: FireflyLine[] = [];
  for (const group of json['data']) {
    if (!isRecord(group)) throw new SourceProviderError('bad_response', 'malformed group');
    const groupId = str(group['id']);
    const attrs = isRecord(group['attributes']) ? group['attributes'] : null;
    const journals = attrs && Array.isArray(attrs['transactions']) ? attrs['transactions'] : [];
    for (const j of journals) {
      if (!isRecord(j)) throw new SourceProviderError('bad_response', 'malformed journal');
      const type = str(j['type']);
      if (type !== 'withdrawal' && type !== 'deposit') continue; // transfers etc. are out of scope
      const direction = type === 'withdrawal' ? 'out' : 'in';
      const journalId = str(j['transaction_journal_id']);
      // The identifiers ARE the dedup key and the sort key: a blank or
      // non-numeric one would poison both, so it is a bad response, not a row.
      if (!/^\d+$/.test(groupId) || !/^\d+$/.test(journalId)) {
        throw new SourceProviderError('bad_response', 'journal without numeric group/journal ids');
      }
      const sourceAccountId = str(direction === 'out' ? j['source_id'] : j['destination_id']);
      if (!sourceAccountId) throw new SourceProviderError('bad_response', 'journal without an account id');
      const currency = str(j['currency_code']).trim();
      if (!currency) throw new SourceProviderError('bad_response', 'journal without a currency');
      const counterparty = str(direction === 'out' ? j['destination_name'] : j['source_name']).trim();
      const description = str(j['description']).trim();
      const payee = counterparty || description || 'Unknown payee';
      const amountRaw = Math.abs(Number(j['amount']));
      if (!Number.isFinite(amountRaw) || amountRaw <= 0) throw new SourceProviderError('bad_response', 'journal without an amount');
      const date = calendarDate(j['date']);
      lines.push({
        sourceId: `${groupId}:${journalId}`,
        sourceAccountId,
        date,
        payee,
        memo: description && description !== payee ? description : null,
        amount: Math.round(amountRaw * 100) / 100,
        currency,
        direction,
        key: [date, Number(groupId), Number(journalId)],
      });
    }
  }
  return { lines, totalPages: totalPagesOf(json) };
}

export function parseAccounts(json: unknown): SourceAccount[] {
  if (!isRecord(json) || !Array.isArray(json['data'])) {
    throw new SourceProviderError('bad_response', 'not a Firefly accounts page');
  }
  return json['data'].map((a) => {
    if (!isRecord(a)) throw new SourceProviderError('bad_response', 'malformed account');
    const attrs = isRecord(a['attributes']) ? a['attributes'] : {};
    return { sourceAccountId: str(a['id']), name: str(attrs['name']), currency: str(attrs['currency_code']) };
  });
}

// ------------------------------------------------------------- date maths

export function minusDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d! - days));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

function compareKey(a: LineKey, b: LineKey): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
}

function parseCursor(cursor: string | null): Cursor {
  if (cursor === null) return { since: null, after: null };
  try {
    const c = JSON.parse(cursor) as Partial<Cursor>;
    return { since: typeof c.since === 'string' ? c.since : null, after: Array.isArray(c.after) ? (c.after as LineKey) : null };
  } catch {
    // An unreadable cursor restarts the sweep from scratch; dedup makes that safe.
    return { since: null, after: null };
  }
}

// ---------------------------------------------------------------- provider

export function createFireflyProvider(o: FireflyOptions): TransactionSourceProvider {
  const base = o.baseUrl.replace(/\/+$/, '');
  const fetchImpl = o.fetchImpl ?? fetch;
  const overlapDays = o.overlapDays ?? DEFAULT_OVERLAP_DAYS;
  const pageSize = o.pageSize ?? DEFAULT_PAGE_SIZE;

  async function getJson(path: string): Promise<unknown> {
    if (!o.pat) throw new SourceProviderError('no_credentials', 'FIREFLY_PAT is blank');
    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        headers: { authorization: `Bearer ${o.pat}`, accept: 'application/json' },
      });
    } catch (e) {
      if (e instanceof TypeError) throw new SourceProviderError('network_error', 'Firefly unreachable');
      throw new SourceProviderError('error', 'Firefly request failed');
    }
    // Messages carry the status only — never the body (financial data) and never the URL (could carry a token).
    if (res.status === 401 || res.status === 403) throw new SourceProviderError('auth_failed', `Firefly answered ${res.status}`);
    if (res.status === 429) throw new SourceProviderError('rate_limited', 'Firefly answered 429');
    if (!res.ok) throw new SourceProviderError('error', `Firefly answered ${res.status}`);
    try {
      return await res.json();
    } catch {
      throw new SourceProviderError('bad_response', 'Firefly answered non-JSON');
    }
  }

  async function fetchAllLines(since: string | null): Promise<FireflyLine[]> {
    const lines: FireflyLine[] = [];
    const start = since ? `&start=${since}` : '';
    let page = 1;
    let totalPages = 1;
    do {
      const json = await getJson(`/api/v1/transactions?limit=${pageSize}&page=${page}${start}`);
      const parsed = parseTransactionsPage(json);
      lines.push(...parsed.lines);
      totalPages = parsed.totalPages;
      page++;
    } while (page <= totalPages);
    return lines.sort((a, b) => compareKey(a.key, b.key));
  }

  return {
    async listSince(cursor, limit): Promise<SourcePage> {
      const c = parseCursor(cursor);
      const all = await fetchAllLines(c.since);
      const rest = c.after ? all.filter((l) => compareKey(l.key, c.after!) > 0) : all;
      const items = rest.slice(0, limit).map(({ key: _key, ...line }) => line);
      // Re-window only when rows were seen; an empty Firefly must not walk
      // `since` backwards a week per sweep.
      const checkpoint = JSON.stringify({
        since: all.length > 0 ? minusDays(all[all.length - 1]!.date, overlapDays) : c.since,
        after: null,
      } satisfies Cursor);
      const nextCursor = rest.length > limit
        ? JSON.stringify({ since: c.since, after: rest[limit - 1]!.key } satisfies Cursor)
        : null;
      return { items, nextCursor, checkpoint };
    },

    async listAccounts(): Promise<SourceAccount[]> {
      const out: SourceAccount[] = [];
      let page = 1;
      let totalPages = 1;
      do {
        const json = await getJson(`/api/v1/accounts?type=asset&limit=${pageSize}&page=${page}`);
        out.push(...parseAccounts(json));
        totalPages = isRecord(json) ? totalPagesOf(json) : 1;
        page++;
      } while (page <= totalPages);
      return out;
    },
  };
}
```

- [ ] **Step 5: Wire the default resolver**

Replace the whole of `Heorth/src/modules/feoh/import/provider.ts` with:

```ts
import { config } from '../../../config/env.js';
import { createFireflyProvider } from './providers/firefly.js';
import type { TransactionSourceProvider } from './providers/types.js';

let override: TransactionSourceProvider | null | undefined;
let defaultProvider: TransactionSourceProvider | null | undefined;

export function setTransactionSourceProvider(p: TransactionSourceProvider | null): void {
  override = p;
}

export function resetTransactionSourceProvider(): void {
  override = undefined;
}

/** Tests install a fake (or an explicit null); production resolves Firefly from `config.feohImport`. */
export function getTransactionSourceProvider(): TransactionSourceProvider | null {
  if (override !== undefined) return override;
  if (defaultProvider === undefined) {
    defaultProvider = config.feohImport ? createFireflyProvider(config.feohImport) : null;
  }
  return defaultProvider;
}
```

- [ ] **Step 6: Run the tests**

Run: `cd Heorth && npx vitest run tests/feoh-import-firefly.test.ts tests/feoh-import-provider.test.ts tests/feoh-import-sync.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 7 (optional, dev stack only): confirm the live shape**

If the dev Firefly is up (`docker compose -f deploy/compose.dev.yml --env-file deploy/.env up -d firefly` from the meta root) and `FIREFLY_PAT` is filled in `deploy/.env`, run from the meta root without printing the token:

```bash
set -a; . <(grep -E '^FIREFLY_PAT=' deploy/.env); set +a
curl -fsS -H "Authorization: Bearer $FIREFLY_PAT" -H 'Accept: application/json' \
  'http://localhost:14001/api/v1/transactions?limit=1&page=1' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(Object.keys(j), Object.keys(j.meta.pagination))})"
```

Expected: `[ 'data', 'meta', 'links' ] [ 'total', 'count', 'per_page', 'current_page', 'total_pages' ]`. This checks the envelope the parser depends on; a fresh Firefly has no rows to compare beyond that. Do not paste the output into a commit.

- [ ] **Step 8: Commit (Heorth)**

```bash
cd Heorth && git add src/modules/feoh/import/providers/firefly.ts src/modules/feoh/import/provider.ts tests/fixtures/ tests/feoh-import-firefly.test.ts
git commit -m "feat(feoh): Firefly III ingestion provider with composite watermark and fixture contract test"
```

---

## Task 8: Validators, routes, scheduler, and boot wiring

**Files:**
- Create: `Heorth/src/modules/feoh/import/validators.ts`, `Heorth/src/modules/feoh/import/routes.ts`, `Heorth/src/modules/feoh/import/scheduler.ts`
- Modify: `Heorth/src/modules/feoh/routes.ts`, `Heorth/src/index.ts`
- Test: `Heorth/tests/feoh-import-routes.test.ts`, `Heorth/tests/feoh-import-scheduler.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 5–7
- Produces: `createIngestionRouter(canWrite: MiddlewareHandler): Hono`; `startFeohImportScheduler(): SchedulerHandle | null`, `stopFeohImportScheduler(): void`; the REST surface below (all under `/api/v1/feoh/ingestion`, auth inherited from `feohRouter`):

| Method | Path | Gate | Body / query | Responses |
|---|---|---|---|---|
| GET | `/status` | auth | — | `ImportStatusView` |
| POST | `/sync` | canWrite | — | 200 `ImportTickResult`; 409 `PROVIDER_UNAVAILABLE` / `ALREADY_RUNNING`; 502 `<REASON>` on a failed tick |
| GET | `/accounts` | auth | — | mappings |
| PUT | `/accounts` | canWrite | `{ sourceAccountId, accountId }` | 200 mapping; 400 `INVALID_REFERENCE` |
| DELETE | `/accounts/:id` | canWrite | — | `{ id }`; 404 |
| GET | `/rules` | auth | — | rules |
| POST | `/rules` | canWrite | `{ pattern, envelopeId, priority?, enabled? }` | 201; 400 `INVALID_REFERENCE` |
| PATCH | `/rules/:id` | canWrite | partial | 200; 404; 400 `INVALID_REFERENCE` |
| DELETE | `/rules/:id` | canWrite | — | `{ id }`; 404 |
| GET | `/inbox` | auth | `?status=&limit=&offset=` | rows + `{ total, limit, offset }` meta |
| POST | `/inbox` | canWrite | `ManualLineInput` | 201 when created, 200 when the source_id already existed |
| POST | `/inbox/:id/confirm` | canWrite | `{ envelopeId, accountId? }` | 200 row; 404; 409 `NOT_PENDING` / `CURRENCY_MISMATCH` / `ACCOUNT_UNMAPPED`; 400 `INVALID_REFERENCE` |
| POST | `/inbox/:id/dismiss` | canWrite | — | 200 row; 404; 409 `NOT_PENDING` |

- [ ] **Step 1: Write the failing route tests**

Create `Heorth/tests/feoh-import-routes.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { seedTestHousehold, authHeaders } from './helpers.js';
import * as feoh from '../src/modules/feoh/service.js';
import { createApp } from '../src/app.js';
import { ALL_MODULES } from '../src/modules/index.js';
import { setTransactionSourceProvider, resetTransactionSourceProvider } from '../src/modules/feoh/import/provider.js';
import { FakeSource, fakeLine } from './fake-source.js';

const app = createApp(ALL_MODULES);
const BASE = '/api/v1/feoh/ingestion';

interface Body<T = unknown> { data?: T; meta?: Record<string, unknown>; error?: { code: string; message: string } }
async function json<T = unknown>(res: Response): Promise<Body<T>> { return (await res.json()) as Body<T>; }

afterEach(() => resetTransactionSourceProvider());

async function setup() {
  const { adult, child, admin } = await seedTestHousehold();
  const account = await feoh.createAccount({ name: 'Joint', kind: 'asset', openingBalance: 0 });
  const groceries = await feoh.createEnvelope({ name: 'Groceries', monthlyBudget: 400 });
  return { adult, child, admin, account, groceries };
}

describe('ingestion routes — gates', () => {
  it('requires auth on reads and adult/admin on writes', async () => {
    const { child } = await setup();
    expect((await app.request(`${BASE}/status`)).status).toBe(401);
    expect((await app.request(`${BASE}/status`, { headers: authHeaders(child.jwt) })).status).toBe(200);
    expect((await app.request(`${BASE}/sync`, { method: 'POST', headers: authHeaders(child.jwt) })).status).toBe(403);
    expect((await app.request(`${BASE}/rules`, { method: 'POST', headers: authHeaders(child.jwt), body: '{}' })).status).toBe(403);
  });

  it('refuses the maintenance admin on writes (finance quarantine)', async () => {
    const { admin, groceries } = await setup();
    const res = await app.request(`${BASE}/rules`, {
      method: 'POST', headers: authHeaders(admin.jwt), body: JSON.stringify({ pattern: 'x', envelopeId: groceries.id }),
    });
    expect(res.status).toBe(403);
  });
});

describe('ingestion routes — sync and status', () => {
  it('sync answers 409 PROVIDER_UNAVAILABLE when import is disabled', async () => {
    const { adult } = await setup();
    const res = await app.request(`${BASE}/sync`, { method: 'POST', headers: authHeaders(adult.jwt) });
    expect(res.status).toBe(409);
    expect((await json(res)).error!.code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('sync runs a tick with the installed provider and status reflects it', async () => {
    const { adult } = await setup();
    const fake = new FakeSource();
    fake.rows = [fakeLine({ sourceId: '1:1' })];
    setTransactionSourceProvider(fake);
    const res = await app.request(`${BASE}/sync`, { method: 'POST', headers: authHeaders(adult.jwt) });
    expect(res.status).toBe(200);
    expect((await json<{ inserted: number }>(res)).data!.inserted).toBe(1);
    const status = await json<{ enabled: boolean; pendingCount: number }>(await app.request(`${BASE}/status`, { headers: authHeaders(adult.jwt) }));
    expect(status.data).toMatchObject({ enabled: true, pendingCount: 1 });
  });

  it('a failed tick is a 502 with the classified token as code', async () => {
    const { adult } = await setup();
    const fake = new FakeSource();
    const { SourceProviderError } = await import('../src/modules/feoh/import/providers/types.js');
    fake.failWith = new SourceProviderError('auth_failed');
    setTransactionSourceProvider(fake);
    const res = await app.request(`${BASE}/sync`, { method: 'POST', headers: authHeaders(adult.jwt) });
    expect(res.status).toBe(502);
    expect((await json(res)).error!.code).toBe('AUTH_FAILED');
  });
});

describe('ingestion routes — mappings and rules', () => {
  it('PUT /accounts upserts by source account and rejects an unknown Feoh account', async () => {
    const { adult, account } = await setup();
    const put = (accountId: string) => app.request(`${BASE}/accounts`, {
      method: 'PUT', headers: authHeaders(adult.jwt), body: JSON.stringify({ sourceAccountId: '7', accountId }),
    });
    expect((await put(account.id)).status).toBe(200);
    expect((await put(account.id)).status).toBe(200);
    const list = await json<unknown[]>(await app.request(`${BASE}/accounts`, { headers: authHeaders(adult.jwt) }));
    expect(list.data).toHaveLength(1);
    const bad = await put('00000000-0000-0000-0000-000000000000');
    expect(bad.status).toBe(400);
    expect((await json(bad)).error!.code).toBe('INVALID_REFERENCE');
  });

  it('rules: create 201, patch, list in (priority, id) order, delete; unknown envelope is 400', async () => {
    const { adult, groceries } = await setup();
    const create = (body: Record<string, unknown>) => app.request(`${BASE}/rules`, {
      method: 'POST', headers: authHeaders(adult.jwt), body: JSON.stringify(body),
    });
    const r1 = await json<{ id: string }>(await create({ pattern: 'rewe', envelopeId: groceries.id, priority: 5 }));
    const r2res = await create({ pattern: 'aldi', envelopeId: groceries.id, priority: 1 });
    expect(r2res.status).toBe(201);
    const r2 = await json<{ id: string }>(r2res);
    const list = await json<{ id: string }[]>(await app.request(`${BASE}/rules`, { headers: authHeaders(adult.jwt) }));
    expect(list.data!.map((r) => r.id)).toEqual([r2.data!.id, r1.data!.id]);
    const patched = await app.request(`${BASE}/rules/${r1.data!.id}`, {
      method: 'PATCH', headers: authHeaders(adult.jwt), body: JSON.stringify({ enabled: false }),
    });
    expect(patched.status).toBe(200);
    expect((await json<{ enabled: boolean }>(patched)).data!.enabled).toBe(false);
    expect((await create({ pattern: 'x', envelopeId: '00000000-0000-0000-0000-000000000000' })).status).toBe(400);
    expect((await create({ pattern: '', envelopeId: groceries.id })).status).toBe(400);
    const del = await app.request(`${BASE}/rules/${r2.data!.id}`, { method: 'DELETE', headers: authHeaders(adult.jwt) });
    expect(del.status).toBe(200);
    expect((await app.request(`${BASE}/rules/${r2.data!.id}`, { method: 'DELETE', headers: authHeaders(adult.jwt) })).status).toBe(404);
  });

  it('deleting an envelope a rule points at answers 409 ENVELOPE_IN_USE', async () => {
    const { adult, groceries } = await setup();
    await app.request(`${BASE}/rules`, { method: 'POST', headers: authHeaders(adult.jwt), body: JSON.stringify({ pattern: 'rewe', envelopeId: groceries.id }) });
    const res = await app.request(`/api/v1/feoh/envelopes/${groceries.id}`, { method: 'DELETE', headers: authHeaders(adult.jwt) });
    expect(res.status).toBe(409);
    expect((await json(res)).error!.code).toBe('ENVELOPE_IN_USE');
  });
});

describe('ingestion routes — inbox', () => {
  it('manual line: 201 on create, 200 on repeat, then confirm and dismiss with their conflicts', async () => {
    const { adult, account, groceries } = await setup();
    const line = { sourceId: 'demo-7', sourceAccountId: 'cash', date: '2026-09-03', payee: 'Kiosk', amount: 2.5, direction: 'out' };
    const first = await app.request(`${BASE}/inbox`, { method: 'POST', headers: authHeaders(adult.jwt), body: JSON.stringify(line) });
    expect(first.status).toBe(201);
    const row = (await json<{ id: string; status: string }>(first)).data!;
    expect(row.status).toBe('pending');
    const again = await app.request(`${BASE}/inbox`, { method: 'POST', headers: authHeaders(adult.jwt), body: JSON.stringify(line) });
    expect(again.status).toBe(200);

    const listed = await json<{ id: string }[]>(await app.request(`${BASE}/inbox?status=pending`, { headers: authHeaders(adult.jwt) }));
    expect(listed.data).toHaveLength(1);
    expect(listed.meta).toMatchObject({ total: 1 });

    // unmapped source account without an explicit accountId
    const unmapped = await app.request(`${BASE}/inbox/${row.id}/confirm`, {
      method: 'POST', headers: authHeaders(adult.jwt), body: JSON.stringify({ envelopeId: groceries.id }),
    });
    expect(unmapped.status).toBe(409);
    expect((await json(unmapped)).error!.code).toBe('ACCOUNT_UNMAPPED');

    const booked = await app.request(`${BASE}/inbox/${row.id}/confirm`, {
      method: 'POST', headers: authHeaders(adult.jwt), body: JSON.stringify({ envelopeId: groceries.id, accountId: account.id }),
    });
    expect(booked.status).toBe(200);
    expect((await json<{ status: string }>(booked)).data!.status).toBe('booked');

    const dismiss = await app.request(`${BASE}/inbox/${row.id}/dismiss`, { method: 'POST', headers: authHeaders(adult.jwt) });
    expect(dismiss.status).toBe(409);
    expect((await json(dismiss)).error!.code).toBe('NOT_PENDING');
    expect((await app.request(`${BASE}/inbox/00000000-0000-0000-0000-000000000000/dismiss`, { method: 'POST', headers: authHeaders(adult.jwt) })).status).toBe(404);
  });

  it('a foreign-currency line cannot be confirmed', async () => {
    const { adult, account, groceries } = await setup();
    const res = await app.request(`${BASE}/inbox`, {
      method: 'POST', headers: authHeaders(adult.jwt),
      body: JSON.stringify({ sourceAccountId: 'cash', date: '2026-09-03', payee: 'Ebook', amount: 12, direction: 'out', currency: 'USD' }),
    });
    const row = (await json<{ id: string }>(res)).data!;
    const confirm = await app.request(`${BASE}/inbox/${row.id}/confirm`, {
      method: 'POST', headers: authHeaders(adult.jwt), body: JSON.stringify({ envelopeId: groceries.id, accountId: account.id }),
    });
    expect(confirm.status).toBe(409);
    expect((await json(confirm)).error!.code).toBe('CURRENCY_MISMATCH');
  });
});
```

Create `Heorth/tests/feoh-import-scheduler.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { startFeohImportScheduler, stopFeohImportScheduler } from '../src/modules/feoh/import/scheduler.js';

describe('feoh import scheduler', () => {
  it('never starts under tests (and would not with import disabled either)', () => {
    expect(process.env['VITEST']).toBeDefined();
    expect(startFeohImportScheduler()).toBeNull();
    stopFeohImportScheduler();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd Heorth && npx vitest run tests/feoh-import-routes.test.ts tests/feoh-import-scheduler.test.ts`
Expected: FAIL — 404s for every `/ingestion` route; scheduler module missing.

- [ ] **Step 3: Validators**

Create `Heorth/src/modules/feoh/import/validators.ts`:

```ts
import { z } from 'zod';
import { IMPORT_DIRECTIONS, IMPORT_STATUSES } from './schema.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const upsertAccountMappingSchema = z.object({
  sourceAccountId: z.string().min(1).max(200),
  accountId: z.string().uuid(),
});

export const createRuleSchema = z.object({
  pattern: z.string().min(1).max(200),
  envelopeId: z.string().uuid(),
  priority: z.number().int().default(0),
  enabled: z.boolean().default(true),
});
export const updateRuleSchema = createRuleSchema.partial();

export const listInboxQuerySchema = z.object({
  status: z.enum(IMPORT_STATUSES).optional(),
  limit: z.coerce.number().int().positive().max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export const confirmInboxSchema = z.object({
  envelopeId: z.string().uuid(),
  accountId: z.string().uuid().optional(),
});

/** A hand-typed statement line. `sourceId` is optional and gets the `manual:` prefix server-side. */
export const manualLineSchema = z.object({
  sourceId: z.string().min(1).max(200).optional(),
  sourceAccountId: z.string().min(1).max(200),
  date: isoDate,
  payee: z.string().min(1).max(500),
  memo: z.string().max(2000).optional().nullable(),
  amount: z.number().positive(),
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  direction: z.enum(IMPORT_DIRECTIONS),
});
```

- [ ] **Step 4: Routes**

Create `Heorth/src/modules/feoh/import/routes.ts`:

```ts
import { Hono, type Context, type MiddlewareHandler } from 'hono';
import { ok, err } from '@wyrhta/core/http';
import { pgErrorCode } from '@wyrhta/core/db';
import * as service from './service.js';
import { runImportTick, getImportStatus } from './sync.js';
import {
  upsertAccountMappingSchema, createRuleSchema, updateRuleSchema,
  listInboxQuerySchema, confirmInboxSchema, manualLineSchema,
} from './validators.js';

/**
 * `/api/v1/feoh/ingestion/*` (ADR 0016). Mounted by the feoh router, which
 * already applies `requireAuth` to everything; the write gate is the feoh
 * router's own `canWrite` (role + maintenance-admin quarantine), passed in so
 * finance keeps ONE definition of "may write money".
 */
export function createIngestionRouter(canWrite: MiddlewareHandler): Hono {
  const r = new Hono();

  /** A FK failure on a body-supplied id (envelope, account) is the caller's mistake, not a 500. */
  const referenceError = (c: Context, e: unknown): Response | null =>
    pgErrorCode(e) === '23503' ? err(c, 'INVALID_REFERENCE', 'Referenced envelope or account does not exist', 400) : null;

  const inboxError = (c: Context, e: unknown): Response => {
    if (e instanceof Error) {
      if (e.message === 'NOT_FOUND') return err(c, 'NOT_FOUND', 'Inbox line not found', 404);
      if (e.message === 'NOT_PENDING') return err(c, 'NOT_PENDING', 'Only a pending line can be booked or dismissed', 409);
      if (e.message === 'CURRENCY_MISMATCH') return err(c, 'CURRENCY_MISMATCH', 'This line is not in the household currency and cannot be booked', 409);
      if (e.message === 'ACCOUNT_UNMAPPED') return err(c, 'ACCOUNT_UNMAPPED', 'The source account is not mapped — pass accountId or map it first', 409);
    }
    return referenceError(c, e) ?? (() => { throw e; })();
  };

  // ---- status + sync -------------------------------------------------------
  r.get('/status', async (c) => ok(c, await getImportStatus()));

  r.post('/sync', canWrite, async (c) => {
    const result = await runImportTick();
    if (result.ok) return ok(c, result);
    if (result.error === 'provider_unavailable') {
      return err(c, 'PROVIDER_UNAVAILABLE', 'Bank import is disabled (FEOH_IMPORT_ENABLED)', 409);
    }
    if (result.error === 'already_running') {
      return err(c, 'ALREADY_RUNNING', 'A bank import tick is already running', 409);
    }
    // Upstream failed; the tick already recorded it. 502 like the tasks routes do for provider 5xx.
    return c.json({ error: { code: (result.error ?? 'error').toUpperCase(), message: 'Bank import tick failed' } }, 502);
  });

  // ---- account mappings ----------------------------------------------------
  r.get('/accounts', async (c) => ok(c, await service.listAccountMappings()));
  r.put('/accounts', canWrite, async (c) => {
    const body = upsertAccountMappingSchema.safeParse(await c.req.json());
    if (!body.success) return err(c, 'VALIDATION_ERROR', 'Invalid request body', 400);
    try { return ok(c, await service.upsertAccountMapping(body.data)); }
    catch (e) { return referenceError(c, e) ?? (() => { throw e; })(); }
  });
  r.delete('/accounts/:id', canWrite, async (c) => {
    const row = await service.deleteAccountMapping(c.req.param('id'));
    if (!row) return err(c, 'NOT_FOUND', 'Mapping not found', 404);
    return ok(c, { id: row.id });
  });

  // ---- rules ---------------------------------------------------------------
  r.get('/rules', async (c) => ok(c, await service.listRules()));
  r.post('/rules', canWrite, async (c) => {
    const body = createRuleSchema.safeParse(await c.req.json());
    if (!body.success) return err(c, 'VALIDATION_ERROR', 'Invalid request body', 400);
    try { return ok(c, await service.createRule(body.data, c.get('auth').userId), undefined, 201); }
    catch (e) { return referenceError(c, e) ?? (() => { throw e; })(); }
  });
  r.patch('/rules/:id', canWrite, async (c) => {
    const body = updateRuleSchema.safeParse(await c.req.json());
    if (!body.success) return err(c, 'VALIDATION_ERROR', 'Invalid request body', 400);
    try {
      const row = await service.updateRule(c.req.param('id'), body.data);
      if (!row) return err(c, 'NOT_FOUND', 'Rule not found', 404);
      return ok(c, row);
    } catch (e) { return referenceError(c, e) ?? (() => { throw e; })(); }
  });
  r.delete('/rules/:id', canWrite, async (c) => {
    const row = await service.deleteRule(c.req.param('id'));
    if (!row) return err(c, 'NOT_FOUND', 'Rule not found', 404);
    return ok(c, { id: row.id });
  });

  // ---- inbox ---------------------------------------------------------------
  r.get('/inbox', async (c) => {
    const q = listInboxQuerySchema.safeParse(c.req.query());
    if (!q.success) return err(c, 'VALIDATION_ERROR', 'Invalid query parameters', 400);
    const { rows, total, limit, offset } = await service.listInbox(q.data);
    return ok(c, rows, { total, limit, offset });
  });
  r.post('/inbox', canWrite, async (c) => {
    const body = manualLineSchema.safeParse(await c.req.json());
    if (!body.success) return err(c, 'VALIDATION_ERROR', 'Invalid request body', 400);
    try {
      const { row, created } = await service.addManualLine(body.data);
      return ok(c, row, undefined, created ? 201 : 200);
    } catch (e) { return referenceError(c, e) ?? (() => { throw e; })(); }
  });
  r.post('/inbox/:id/confirm', canWrite, async (c) => {
    const body = confirmInboxSchema.safeParse(await c.req.json());
    if (!body.success) return err(c, 'VALIDATION_ERROR', 'Invalid request body', 400);
    try { return ok(c, await service.confirmInboxRow(c.req.param('id'), body.data, c.get('auth').userId)); }
    catch (e) { return inboxError(c, e); }
  });
  r.post('/inbox/:id/dismiss', canWrite, async (c) => {
    try { return ok(c, await service.dismissInboxRow(c.req.param('id'))); }
    catch (e) { return inboxError(c, e); }
  });

  return r;
}
```

`c.get('auth')` needs the `auth` context key typed the way the feoh router has it; if the compiler complains, type the router as `new Hono<{ Variables: { auth: { userId: string } } }>()` matching whatever `src/wiring.ts` declares for `requireAuth`, and copy that generic onto `createIngestionRouter`'s return type.

- [ ] **Step 5: Mount it and map `ENVELOPE_IN_USE`**

In `Heorth/src/modules/feoh/routes.ts`:

```ts
import { pgErrorCode } from '@wyrhta/core/db';
import { createIngestionRouter } from './import/routes.js';
```

After the `canWrite` definition, before the first route:

```ts
// Bank ingestion (ADR 0016) — its own file, the same write gate.
feohRouter.route('/ingestion', createIngestionRouter(canWrite));
```

Replace the envelope delete handler body:

```ts
feohRouter.delete('/envelopes/:id', canWrite, async (c) => {
  try {
    const row = await service.deleteEnvelope(c.req.param('id'));
    if (!row) return err(c, 'NOT_FOUND', 'Envelope not found', 404);
    return ok(c, { id: row.id });
  } catch (e: unknown) {
    // An import rule restricts its envelope (ADR 0016). Say so instead of a raw 500.
    if (pgErrorCode(e) === '23001') return err(c, 'ENVELOPE_IN_USE', 'An import rule still points at this envelope — delete or re-point the rule first', 409);
    throw e;
  }
});
```

(Find the existing `feohRouter.delete('/envelopes/:id', …)` and replace it; keep its position.)

- [ ] **Step 6: Scheduler and boot**

Create `Heorth/src/modules/feoh/import/scheduler.ts`:

```ts
import { logError } from '@wyrhta/core/lib';
import { config } from '../../../config/env.js';
import { runImportTick } from './sync.js';

/**
 * Poll loop for the bank-line source. Gated on `config.feohImport` (the
 * FEOH_IMPORT_ENABLED kill switch) and never started under tests. Reuses the
 * integrations poll interval; floored at 60s like that scheduler.
 */
export interface SchedulerHandle { stop(): void }

let handle: SchedulerHandle | null = null;

export function startFeohImportScheduler(): SchedulerHandle | null {
  if (process.env['VITEST'] !== undefined) return null;
  if (config.feohImport === null) return null;
  if (handle) return handle;

  const seconds = Math.max(60, config.integrationsSyncIntervalSeconds);
  const tick = () => {
    // runImportTick never rejects; guard anyway so a Heorth bug cannot kill the loop.
    runImportTick().catch((e) => logError('feoh import tick crashed', e));
  };
  const timer = setInterval(tick, seconds * 1000);
  timer.unref?.();
  const kickoff = setTimeout(tick, 5000);
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

export function stopFeohImportScheduler(): void {
  handle?.stop();
}
```

In `Heorth/src/index.ts`, add the import beside the Weorc one and start it at the end of `main()`:

```ts
import { startFeohImportScheduler } from './modules/feoh/import/scheduler.js';
```

```ts
  // Bank ingestion (ADR 0016): a no-op unless FEOH_IMPORT_ENABLED=true.
  startFeohImportScheduler();
```

- [ ] **Step 7: Run the tests**

Run: `cd Heorth && npx vitest run tests/feoh-import-routes.test.ts tests/feoh-import-scheduler.test.ts tests/feoh-accounts.test.ts tests/module-convention.test.ts && npm run typecheck`
Expected: PASS. If `module-convention.test.ts` asserts something about files under `src/modules/*/` (for example that every module directory has an `index.ts`), read its failure and satisfy it the way it asks — `import/` is a sub-folder of `feoh`, not a module, so most likely nothing is needed.

- [ ] **Step 8: Commit (Heorth)**

```bash
cd Heorth && git add src/modules/feoh/import/validators.ts src/modules/feoh/import/routes.ts src/modules/feoh/import/scheduler.ts src/modules/feoh/routes.ts src/index.ts tests/feoh-import-routes.test.ts tests/feoh-import-scheduler.test.ts
git commit -m "feat(feoh): /api/v1/feoh/ingestion routes, import scheduler, ENVELOPE_IN_USE"
```

---

## Task 9: Heorth docs — README, AGENTS.md rules, CHANGELOG

**Files:**
- Modify: `Heorth/README.md`, `Heorth/AGENTS.md`, `Heorth/CHANGELOG.md`

- [ ] **Step 1: README — a "Bank import" subsection under "## Finance"**

Insert after the Finance section's last paragraph (the one ending "there is no separate parties/roster boundary.") and before `## Ethel`:

```markdown
### Bank import (ADR 0016, optional)

Firefly III and its Data Importer run as an optional **ingestion sidecar** whose
only job is talking to banks. Heorth *pulls* normalised statement lines from it
through a two-method, read-only provider (`src/modules/feoh/import/`), applies
household-owned rules, and books what it can through the ordinary ledger call
(`recordTransaction`). Feoh stays the system of record; Firefly's budgets,
bills, rules engine and users are unused, and its web UI is an operator tool
for connecting banks, never a household surface.

**Enable** with `FEOH_IMPORT_ENABLED=true` plus `FIREFLY_BASE_URL` and
`FIREFLY_PAT` (a personal access token minted in Firefly's UI: Profile → OAuth
→ Personal Access Tokens). Blank/`false` means the poll loop never starts and
`POST /api/v1/feoh/ingestion/sync` answers `409 PROVIDER_UNAVAILABLE`; the
inbox, the rules and confirming pending lines keep working, because those are
pure Feoh writes. `FEOH_CURRENCY` (ISO 4217, default `EUR`) is the household's
one currency — a line in any other currency stays in the inbox for ever and is
never booked, by the tick or by a member.

**How a line moves.** Each tick pulls pages from the persisted cursor and, per
line: already known by `source_id` → skipped (the overlap window replays a week
of history on purpose); currency differs → `pending`, never booked; source
account unmapped (`PUT /ingestion/accounts`) → `pending`; no rule matches
(`/ingestion/rules`, case-insensitive payee substring, `(priority, id)` order,
first enabled match wins) → `pending`; otherwise booked as two postings
(out: envelope debit / account credit; in: the reverse), attributed to the
**rule's author**. A member books a pending line with
`POST /ingestion/inbox/:id/confirm { envelopeId, accountId? }` (attributed to
them) or parks it with `.../dismiss`. `POST /ingestion/inbox` adds a hand-typed
line (`source_id = manual:<id>`) through the same pipeline. The cursor advances
only after a whole page is written, so a tick that dies mid-page replays
harmlessly.

**Deliberately not done:** deletions and later edits in Firefly are ignored
(first read wins); rule changes re-evaluate `pending` lines only; transfers
between the household's own Firefly accounts are skipped. **Deleting a booked
transaction returns its line to the inbox** rather than erasing the record that
the bank line existed. `GET /ingestion/status` reports health without ever
exposing the cursor; `last_error` holds a short token only (`auth_failed`,
`network_error`, `rate_limited`, `bad_response`, `no_credentials`, `error`) —
no Firefly response body is ever persisted or logged.
```

- [ ] **Step 2: AGENTS.md — rules that cannot be inferred from the code**

Under "## Module rules", after the Weorc bullets and before the KithLedger bullet, add:

```markdown
- **Feoh bank import** (`src/modules/feoh/import/`, ADR 0016) **has exactly one
  write path into the ledger: `recordTransaction()`.** Never insert into
  `transactions` or `postings` from under `import/`; the existing ledger tests
  are the guarantee only while that holds.
- **The provider contract is one-way and semantics-free** — `listSince` and
  `listAccounts`, nothing else. Do not add create/update/delete, and do not let a
  Firefly type cross `providers/types.ts`. Deletions and edits in Firefly are
  ignored on purpose (first read wins); rule changes touch `pending` rows only.
- **`feoh_imported_transactions` rows are never deleted** — the table is the dedup
  register. `deleteTransaction()` reverts a booked row to `pending` BEFORE the
  delete; the FK's `set null` is a backstop, not the mechanism (the booked-pair
  CHECK would fail mid-statement otherwise).
- **The cursor is the provider's** (opaque JSON for Firefly) and advances only
  after a whole page is written. The overlap re-window happens INSIDE the
  provider (`checkpoint`), never by date arithmetic in `sync.ts`.
- **Never persist or log a Firefly response body, URL, or the PAT.** `last_error`
  and log lines carry only the six `SourceErrorReason` tokens.
- **Single currency:** compare against `config.feohCurrency`; a mismatching line
  is never booked, by the tick or by `confirmInboxRow`.
- **The import scheduler is gated on `config.feohImport`** (the
  `FEOH_IMPORT_ENABLED` kill switch) and on `VITEST`. Inbox reads, rules and
  confirmations are NOT gated — they are pure Feoh writes.
```

Under "## Architecture rules", extend the "Optional integrations are gated as a GROUP" bullet's list of groups: change `` `M365_*`, `KITH_*` and `SATELLITE_SIGNING_*` `` to `` `M365_*`, `GOOGLE_*`, `KITH_*`, `SATELLITE_SIGNING_*` and `FEOH_IMPORT_ENABLED` + `FIREFLY_*` `` and append one sentence: "The Firefly group is the one exception to *partial presence is an error*: `FIREFLY_*` may be present while `FEOH_IMPORT_ENABLED` is not `true` (compose passes defaults), and is simply unused then."

- [ ] **Step 3: CHANGELOG — under `## [Unreleased]`**

```markdown
### Added

- **Bank import (ADR 0016)** — Firefly III as an optional one-way ingestion
  sidecar (`src/modules/feoh/import/`). Four new tables (`feoh_import_accounts`,
  `feoh_import_rules`, `feoh_imported_transactions`, `feoh_import_state`,
  migration `0028`); none of the existing Feoh tables changes. A scheduler tick
  pulls pages through a two-method `TransactionSourceProvider`, dedups on
  `source_id`, books rule hits through `recordTransaction()` attributed to the
  rule's author, and parks the rest in an inbox. New routes under
  `/api/v1/feoh/ingestion/*`: `status`, `sync`, `accounts` (source → Feoh
  account map), `rules`, `inbox` (+ `confirm`, `dismiss`, and a manual line
  `POST`). Env: `FEOH_IMPORT_ENABLED`, `FIREFLY_BASE_URL`, `FIREFLY_PAT`,
  `FEOH_CURRENCY` (default `EUR`). Off by default; the inbox and rules work
  without Firefly.
- **Feoh page: "Bank import" card** — inbox with book/dismiss, import rules,
  and the source-account mapping, in English and German.

### Changed

- **Deleting a booked transaction returns its bank line to the inbox** instead
  of erasing the record that the line existed (ADR 0016 consequence).
- `DELETE /api/v1/feoh/envelopes/:id` answers `409 ENVELOPE_IN_USE` when an
  import rule still points at the envelope (was a raw 500 on the FK restrict).

### Known gaps

- A member who authored an import rule cannot be hard-deleted while it exists
  (`onDelete: restrict`, the same class of key as `transactions.created_by`).
  The member-delete path does not yet explain which rows block it; that is
  true of the existing finance keys too and is deferred together with them.
- Firefly transfers between the household's own accounts are skipped; only
  withdrawals and deposits become inbox lines.
```

Also add `FEOH_IMPORT_ENABLED`, `FIREFLY_BASE_URL`, `FIREFLY_PAT`, `FEOH_CURRENCY` to whichever README table lists environment variables, if one exists (search for `M365_TENANT_ID` in `README.md` to find it) — one row each, same phrasing as the subsection above.

- [ ] **Step 4: Commit (Heorth)**

```bash
cd Heorth && git add README.md AGENTS.md CHANGELOG.md
git commit -m "docs(feoh): document bank import (ADR 0016) - env, routes, invariants"
```

---

## Task 10: Web — types, API client, hooks

**Files:**
- Modify: `Heorth/web/src/lib/types.ts`, `Heorth/web/src/lib/constants.ts`
- Create: `Heorth/web/src/api/feoh-import.ts`, `Heorth/web/src/hooks/use-feoh-import.ts`
- Test: `Heorth/web/src/api/feoh-import.test.ts`

**Interfaces:**
- Produces types `ImportedTransaction`, `ImportRule`, `ImportAccountMapping`, `ImportStatus`; query keys `QUERY_KEYS.importInbox`, `importRules`, `importAccounts`, `importStatus`; API functions and hooks named below.

- [ ] **Step 1: Write the failing client test** (asserts request paths — the gap Heorth issue #8 describes)

Create `Heorth/web/src/api/feoh-import.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';

const apiGet = vi.fn();
const apiPost = vi.fn();
const apiPatch = vi.fn();
const apiPut = vi.fn();
const apiDelete = vi.fn();
vi.mock('./client', async (orig) => ({
  ...(await orig<typeof import('./client')>()),
  apiGet: (...a: unknown[]) => apiGet(...a),
  apiPost: (...a: unknown[]) => apiPost(...a),
  apiPatch: (...a: unknown[]) => apiPatch(...a),
  apiPut: (...a: unknown[]) => apiPut(...a),
  apiDelete: (...a: unknown[]) => apiDelete(...a),
}));

import * as api from './feoh-import';

afterEach(() => vi.clearAllMocks());

describe('feoh-import api client paths', () => {
  it('hits /feoh/ingestion/* with the documented methods', () => {
    api.getImportStatus();
    expect(apiGet).toHaveBeenCalledWith('/feoh/ingestion/status');
    api.triggerSync();
    expect(apiPost).toHaveBeenCalledWith('/feoh/ingestion/sync', {});
    api.listInbox({ status: 'pending', limit: 50 });
    expect(apiGet).toHaveBeenCalledWith('/feoh/ingestion/inbox?status=pending&limit=50');
    api.confirmInboxRow('r1', { envelopeId: 'e1' });
    expect(apiPost).toHaveBeenCalledWith('/feoh/ingestion/inbox/r1/confirm', { envelopeId: 'e1' });
    api.dismissInboxRow('r1');
    expect(apiPost).toHaveBeenCalledWith('/feoh/ingestion/inbox/r1/dismiss', {});
    api.listRules();
    expect(apiGet).toHaveBeenCalledWith('/feoh/ingestion/rules');
    api.createRule({ pattern: 'rewe', envelopeId: 'e1' });
    expect(apiPost).toHaveBeenCalledWith('/feoh/ingestion/rules', { pattern: 'rewe', envelopeId: 'e1' });
    api.updateRule('k1', { enabled: false });
    expect(apiPatch).toHaveBeenCalledWith('/feoh/ingestion/rules/k1', { enabled: false });
    api.deleteRule('k1');
    expect(apiDelete).toHaveBeenCalledWith('/feoh/ingestion/rules/k1');
    api.listAccountMappings();
    expect(apiGet).toHaveBeenCalledWith('/feoh/ingestion/accounts');
    api.upsertAccountMapping({ sourceAccountId: '7', accountId: 'a1' });
    expect(apiPut).toHaveBeenCalledWith('/feoh/ingestion/accounts', { sourceAccountId: '7', accountId: 'a1' });
    api.deleteAccountMapping('m1');
    expect(apiDelete).toHaveBeenCalledWith('/feoh/ingestion/accounts/m1');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd Heorth/web && npx vitest run src/api/feoh-import.test.ts`
Expected: FAIL — `./feoh-import` not found.

- [ ] **Step 3: Types and query keys**

Append to the Feoh block in `Heorth/web/src/lib/types.ts`:

```ts
// ---- Feoh bank import (ADR 0016) ----
export type ImportDirection = 'in' | 'out';
export type ImportRowStatus = 'pending' | 'booked' | 'dismissed';

export interface ImportedTransaction {
  id: string;
  createdAt: string;
  updatedAt: string;
  sourceId: string;
  sourceAccountId: string;
  date: string;             // YYYY-MM-DD
  payee: string;
  memo: string | null;
  amount: string;           // numeric -> string, always positive
  currency: string;
  direction: ImportDirection;
  status: ImportRowStatus;
  envelopeId: string | null;
  transactionId: string | null;
  appliedRuleId: string | null;
}

export interface ImportRule {
  id: string;
  createdAt: string;
  updatedAt: string;
  pattern: string;
  envelopeId: string;
  priority: number;
  enabled: boolean;
  createdBy: string;
}

export interface ImportAccountMapping {
  id: string;
  createdAt: string;
  updatedAt: string;
  sourceAccountId: string;
  accountId: string;
}

export interface ImportStatus {
  enabled: boolean;
  currency: string;
  pendingCount: number;
  feed: {
    feedKey: string;
    hasCursor: boolean;
    lastSuccessAt: string | null;
    lastError: string | null;
    consecutiveFailures: number;
  } | null;
}
```

In `Heorth/web/src/lib/constants.ts`, inside `QUERY_KEYS` after `ledger`:

```ts
  importInbox: ['feoh', 'import', 'inbox'] as const,
  importRules: ['feoh', 'import', 'rules'] as const,
  importAccounts: ['feoh', 'import', 'accounts'] as const,
  importStatus: ['feoh', 'import', 'status'] as const,
```

- [ ] **Step 4: API client**

Create `Heorth/web/src/api/feoh-import.ts`:

```ts
import { apiGet, apiPost, apiPatch, apiPut, apiDelete, qs } from './client';
import type {
  SingleResponse, ListResponse, ImportedTransaction, ImportRule, ImportAccountMapping, ImportStatus, ImportRowStatus,
} from '@/lib/types';

export interface RuleInput { pattern: string; envelopeId: string; priority?: number; enabled?: boolean }
export interface MappingInput { sourceAccountId: string; accountId: string }
export interface ConfirmInput { envelopeId: string; accountId?: string }
export interface SyncResult { ok: boolean; pages: number; inserted: number; booked: number; skipped: number }

export function getImportStatus(): Promise<SingleResponse<ImportStatus>> { return apiGet('/feoh/ingestion/status'); }
export function triggerSync(): Promise<SingleResponse<SyncResult>> { return apiPost('/feoh/ingestion/sync', {}); }

export function listInbox(params: { status?: ImportRowStatus; limit?: number; offset?: number } = {}): Promise<ListResponse<ImportedTransaction>> {
  return apiGet(`/feoh/ingestion/inbox${qs(params)}`);
}
export function confirmInboxRow(id: string, input: ConfirmInput): Promise<SingleResponse<ImportedTransaction>> {
  return apiPost(`/feoh/ingestion/inbox/${id}/confirm`, input);
}
export function dismissInboxRow(id: string): Promise<SingleResponse<ImportedTransaction>> {
  return apiPost(`/feoh/ingestion/inbox/${id}/dismiss`, {});
}

export function listRules(): Promise<SingleResponse<ImportRule[]>> { return apiGet('/feoh/ingestion/rules'); }
export function createRule(input: RuleInput): Promise<SingleResponse<ImportRule>> { return apiPost('/feoh/ingestion/rules', input); }
export function updateRule(id: string, input: Partial<RuleInput>): Promise<SingleResponse<ImportRule>> { return apiPatch(`/feoh/ingestion/rules/${id}`, input); }
export function deleteRule(id: string): Promise<SingleResponse<{ id: string }>> { return apiDelete(`/feoh/ingestion/rules/${id}`); }

export function listAccountMappings(): Promise<SingleResponse<ImportAccountMapping[]>> { return apiGet('/feoh/ingestion/accounts'); }
export function upsertAccountMapping(input: MappingInput): Promise<SingleResponse<ImportAccountMapping>> { return apiPut('/feoh/ingestion/accounts', input); }
export function deleteAccountMapping(id: string): Promise<SingleResponse<{ id: string }>> { return apiDelete(`/feoh/ingestion/accounts/${id}`); }
```

`ListResponse<T>` in `@/lib/types` is `{ data: T[]; meta: ListMeta }` — the same envelope `listTransactions` uses; the inbox route returns `{ total, limit, offset }` as its meta, which `ListMeta` already covers.

- [ ] **Step 5: Hooks**

Create `Heorth/web/src/hooks/use-feoh-import.ts`:

```ts
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { QUERY_KEYS } from '@/lib/constants';
import * as api from '@/api/feoh-import';

export function useImportStatus() { return useQuery({ queryKey: QUERY_KEYS.importStatus, queryFn: () => api.getImportStatus() }); }
export function useImportInbox(params: Parameters<typeof api.listInbox>[0] = { status: 'pending', limit: 50 }) {
  return useQuery({ queryKey: [...QUERY_KEYS.importInbox, params], queryFn: () => api.listInbox(params) });
}
export function useImportRules() { return useQuery({ queryKey: QUERY_KEYS.importRules, queryFn: () => api.listRules() }); }
export function useImportAccounts() { return useQuery({ queryKey: QUERY_KEYS.importAccounts, queryFn: () => api.listAccountMappings() }); }

/** Everything an import write can change: the inbox, the status counts, and the ledger views. */
function useInvalidateImport() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: QUERY_KEYS.importInbox });
    qc.invalidateQueries({ queryKey: QUERY_KEYS.importStatus });
    qc.invalidateQueries({ queryKey: QUERY_KEYS.transactions });
    qc.invalidateQueries({ queryKey: ['summary'] });
    qc.invalidateQueries({ queryKey: ['ledger'] });
  };
}

export function useTriggerSync() {
  const inv = useInvalidateImport();
  return useMutation({ mutationFn: () => api.triggerSync(), onSuccess: inv });
}
export function useConfirmInboxRow() {
  const inv = useInvalidateImport();
  return useMutation({ mutationFn: (v: { id: string; input: api.ConfirmInput }) => api.confirmInboxRow(v.id, v.input), onSuccess: inv });
}
export function useDismissInboxRow() {
  const inv = useInvalidateImport();
  return useMutation({ mutationFn: (id: string) => api.dismissInboxRow(id), onSuccess: inv });
}
export function useCreateRule() {
  const qc = useQueryClient(); const inv = useInvalidateImport();
  return useMutation({ mutationFn: (i: api.RuleInput) => api.createRule(i), onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.importRules }); inv(); } });
}
export function useUpdateRule() {
  const qc = useQueryClient(); const inv = useInvalidateImport();
  return useMutation({ mutationFn: (v: { id: string; input: Partial<api.RuleInput> }) => api.updateRule(v.id, v.input), onSuccess: () => { qc.invalidateQueries({ queryKey: QUERY_KEYS.importRules }); inv(); } });
}
export function useDeleteRule() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.deleteRule(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.importRules }) });
}
export function useUpsertAccountMapping() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (i: api.MappingInput) => api.upsertAccountMapping(i), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.importAccounts }) });
}
export function useDeleteAccountMapping() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.deleteAccountMapping(id), onSuccess: () => qc.invalidateQueries({ queryKey: QUERY_KEYS.importAccounts }) });
}
```

- [ ] **Step 6: Run the tests and typecheck**

Run: `cd Heorth/web && npx vitest run src/api/feoh-import.test.ts && npx tsc --noEmit -p tsconfig.json`
Expected: PASS, no type errors. (If the web has a `typecheck` script in `web/package.json`, use it instead.)

- [ ] **Step 7: Commit (Heorth)**

```bash
cd Heorth && git add web/src/lib/types.ts web/src/lib/constants.ts web/src/api/feoh-import.ts web/src/api/feoh-import.test.ts web/src/hooks/use-feoh-import.ts
git commit -m "feat(web): typed client and hooks for /feoh/ingestion"
```

---

## Task 11: Web — the "Bank import" card on the Feoh page, in English and German

**Files:**
- Create: `Heorth/web/src/components/feoh/import-inbox.tsx`, `import-rules.tsx`, `import-accounts.tsx`, `import-inbox.test.tsx`, `import-rules.test.tsx`
- Modify: `Heorth/web/src/pages/feoh.tsx`, `Heorth/web/src/pages/feoh.test.tsx`, `Heorth/web/src/i18n/locales/en.json`, `Heorth/web/src/i18n/locales/de.json`

**Interfaces:**
- Consumes hooks from Task 10, `useEnvelopes`/`useAccounts` from `@/hooks/use-feoh`, `useFormatters` from `@/hooks/use-formatters`, `Badge`, `Button`, `Input`, `Label`, `Card*` from `@/components/ui/*`.
- Produces default-exported components `ImportInbox`, `ImportRules`, `ImportAccounts`.

- [ ] **Step 1: i18n keys — both files**

In `Heorth/web/src/i18n/locales/en.json`, inside `"feoh"`, add a sibling of `"accounts"`:

```json
  "import": {
    "title": "Bank import",
    "intro": "Statement lines pulled from Firefly III (or typed in) wait here until a rule or a member books them into an envelope.",
    "disabled": "Bank import is off for this household — lines can still be typed in and booked.",
    "syncNow": "Pull now",
    "syncing": "Pulling…",
    "syncDone": "Pulled {{inserted}} new, booked {{booked}}",
    "syncFailed": "Pull failed: {{reason}}",
    "lastSuccess": "Last pull {{when}}",
    "lastError": "Last error: {{reason}}",
    "pending_one": "{{count}} line waiting",
    "pending_other": "{{count}} lines waiting",
    "inbox": {
      "title": "Inbox",
      "empty": "Nothing waiting.",
      "book": "Book",
      "dismiss": "Dismiss",
      "envelope": "Envelope",
      "account": "Account",
      "pickEnvelope": "Pick an envelope",
      "pickAccount": "Pick an account",
      "unmapped": "Source account {{source}} is not mapped — pick the Feoh account",
      "foreignCurrency": "{{currency}} — cannot be booked (household currency is {{household}})",
      "booked": "Booked",
      "dismissed": "Dismissed",
      "in": "in",
      "out": "out"
    },
    "rules": {
      "title": "Rules",
      "intro": "If the payee contains the pattern, the line is booked into the envelope. Lower priority runs first.",
      "empty": "No rules yet.",
      "pattern": "Payee contains",
      "patternPlaceholder": "rewe",
      "envelope": "Envelope",
      "priority": "Priority",
      "add": "Add rule",
      "enabled": "On",
      "disabled": "Off",
      "remove": "Remove"
    },
    "accounts": {
      "title": "Account mapping",
      "intro": "Which Feoh account a bank account's lines belong to. Unmapped lines wait in the inbox.",
      "empty": "No mappings yet.",
      "source": "Source account id",
      "sourcePlaceholder": "7",
      "account": "Feoh account",
      "add": "Map",
      "remove": "Remove"
    }
  }
```

In `Heorth/web/src/i18n/locales/de.json`, the same keys:

```json
  "import": {
    "title": "Bankimport",
    "intro": "Kontoauszugszeilen aus Firefly III (oder von Hand eingetragen) warten hier, bis eine Regel oder ein Mitglied sie auf einen Umschlag bucht.",
    "disabled": "Der Bankimport ist für diesen Haushalt aus – Zeilen lassen sich trotzdem eintragen und buchen.",
    "syncNow": "Jetzt abholen",
    "syncing": "Hole ab…",
    "syncDone": "{{inserted}} neue Zeilen, {{booked}} gebucht",
    "syncFailed": "Abholen fehlgeschlagen: {{reason}}",
    "lastSuccess": "Zuletzt abgeholt {{when}}",
    "lastError": "Letzter Fehler: {{reason}}",
    "pending_one": "{{count}} Zeile wartet",
    "pending_other": "{{count}} Zeilen warten",
    "inbox": {
      "title": "Eingang",
      "empty": "Nichts wartet.",
      "book": "Buchen",
      "dismiss": "Verwerfen",
      "envelope": "Umschlag",
      "account": "Konto",
      "pickEnvelope": "Umschlag wählen",
      "pickAccount": "Konto wählen",
      "unmapped": "Quellkonto {{source}} ist nicht zugeordnet – Feoh-Konto wählen",
      "foreignCurrency": "{{currency}} – nicht buchbar (Haushaltswährung ist {{household}})",
      "booked": "Gebucht",
      "dismissed": "Verworfen",
      "in": "Eingang",
      "out": "Ausgang"
    },
    "rules": {
      "title": "Regeln",
      "intro": "Enthält der Empfänger das Muster, wird die Zeile auf den Umschlag gebucht. Kleinere Priorität läuft zuerst.",
      "empty": "Noch keine Regeln.",
      "pattern": "Empfänger enthält",
      "patternPlaceholder": "rewe",
      "envelope": "Umschlag",
      "priority": "Priorität",
      "add": "Regel anlegen",
      "enabled": "An",
      "disabled": "Aus",
      "remove": "Entfernen"
    },
    "accounts": {
      "title": "Kontozuordnung",
      "intro": "Zu welchem Feoh-Konto die Zeilen eines Bankkontos gehören. Nicht zugeordnete Zeilen warten im Eingang.",
      "empty": "Noch keine Zuordnungen.",
      "source": "Quellkonto-ID",
      "sourcePlaceholder": "7",
      "account": "Feoh-Konto",
      "add": "Zuordnen",
      "remove": "Entfernen"
    }
  }
```

Run `cd Heorth/web && npx vitest run src/i18n/catalog-parity.test.ts` — Expected: PASS.

- [ ] **Step 2: Write the failing component tests**

Create `Heorth/web/src/components/feoh/import-inbox.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ImportedTransaction, Envelope, Account, ImportAccountMapping } from '@/lib/types';

const useImportInbox = vi.fn();
const useImportAccounts = vi.fn();
const confirm = vi.fn();
const dismiss = vi.fn();
vi.mock('@/hooks/use-feoh-import', () => ({
  useImportInbox: (...a: unknown[]) => useImportInbox(...a),
  useImportAccounts: () => useImportAccounts(),
  useConfirmInboxRow: () => ({ mutateAsync: confirm, isPending: false }),
  useDismissInboxRow: () => ({ mutateAsync: dismiss, isPending: false }),
}));
const useEnvelopes = vi.fn();
const useAccounts = vi.fn();
vi.mock('@/hooks/use-feoh', () => ({
  useEnvelopes: () => useEnvelopes(),
  useAccounts: () => useAccounts(),
}));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import ImportInbox from './import-inbox';

const groceries: Envelope = { id: 'e1', createdAt: '', updatedAt: '', name: 'Groceries', monthlyBudget: '400', tone: null };
const joint: Account = { id: 'a1', createdAt: '', updatedAt: '', name: 'Joint', kind: 'asset', openingBalance: '0' };
const mapping: ImportAccountMapping = { id: 'm1', createdAt: '', updatedAt: '', sourceAccountId: '7', accountId: 'a1' };
const row = (over: Partial<ImportedTransaction> = {}): ImportedTransaction => ({
  id: 'r1', createdAt: '', updatedAt: '', sourceId: '101:1', sourceAccountId: '7', date: '2026-09-01',
  payee: 'REWE', memo: 'REWE SAGT DANKE', amount: '42.10', currency: 'EUR', direction: 'out', status: 'pending',
  envelopeId: null, transactionId: null, appliedRuleId: null, ...over,
});
const list = (rows: ImportedTransaction[]) => ({ data: { data: rows, meta: { total: rows.length, limit: 50, offset: 0 } }, isLoading: false, isError: false });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

function arrange(rows: ImportedTransaction[], mappings: ImportAccountMapping[] = [mapping]) {
  useImportInbox.mockReturnValue(list(rows));
  useImportAccounts.mockReturnValue({ data: { data: mappings } });
  useEnvelopes.mockReturnValue({ data: { data: [groceries] } });
  useAccounts.mockReturnValue({ data: { data: [joint] } });
}

describe('ImportInbox', () => {
  it('shows the empty state', () => {
    arrange([]);
    render(<ImportInbox householdCurrency="EUR" />);
    expect(screen.getByText('Nothing waiting.')).toBeInTheDocument();
  });

  it('books a mapped line with the chosen envelope', async () => {
    arrange([row()]);
    confirm.mockResolvedValue({});
    render(<ImportInbox householdCurrency="EUR" />);
    expect(screen.getByText('REWE')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Envelope'), { target: { value: 'e1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith({ id: 'r1', input: { envelopeId: 'e1' } }));
  });

  it('asks for a Feoh account when the source account is unmapped and sends it', async () => {
    arrange([row({ sourceAccountId: '99' })], []);
    confirm.mockResolvedValue({});
    render(<ImportInbox householdCurrency="EUR" />);
    expect(screen.getByText(/not mapped/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Envelope'), { target: { value: 'e1' } });
    fireEvent.change(screen.getByLabelText('Account'), { target: { value: 'a1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Book' }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith({ id: 'r1', input: { envelopeId: 'e1', accountId: 'a1' } }));
  });

  it('cannot book a foreign-currency line, but can dismiss it', async () => {
    arrange([row({ currency: 'USD' })]);
    dismiss.mockResolvedValue({});
    render(<ImportInbox householdCurrency="EUR" />);
    expect(screen.getByText(/cannot be booked/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Book' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(dismiss).toHaveBeenCalledWith('r1'));
  });

  it('judges "foreign" against the household currency it is given, not EUR', () => {
    arrange([row({ currency: 'CHF' })]);
    render(<ImportInbox householdCurrency="CHF" />);
    expect(screen.queryByText(/cannot be booked/)).not.toBeInTheDocument();
    expect(screen.getByText(/CHF/)).toBeInTheDocument(); // the amount renders in the row's own currency
  });
});
```

Create `Heorth/web/src/components/feoh/import-rules.test.tsx`:

```tsx
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import type { ImportRule, Envelope } from '@/lib/types';

const useImportRules = vi.fn();
const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();
vi.mock('@/hooks/use-feoh-import', () => ({
  useImportRules: () => useImportRules(),
  useCreateRule: () => ({ mutateAsync: create, isPending: false }),
  useUpdateRule: () => ({ mutate: update, isPending: false }),
  useDeleteRule: () => ({ mutate: remove, isPending: false }),
}));
const useEnvelopes = vi.fn();
vi.mock('@/hooks/use-feoh', () => ({ useEnvelopes: () => useEnvelopes() }));
vi.mock('@/components/ui/toast', () => ({ useToast: () => ({ toast: vi.fn() }) }));

import ImportRules from './import-rules';

const groceries: Envelope = { id: 'e1', createdAt: '', updatedAt: '', name: 'Groceries', monthlyBudget: '400', tone: null };
const rule: ImportRule = { id: 'k1', createdAt: '', updatedAt: '', pattern: 'rewe', envelopeId: 'e1', priority: 0, enabled: true, createdBy: 'u1' };

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('ImportRules', () => {
  it('lists rules with their envelope name and toggles / removes them', () => {
    useImportRules.mockReturnValue({ data: { data: [rule] } });
    useEnvelopes.mockReturnValue({ data: { data: [groceries] } });
    render(<ImportRules />);
    expect(screen.getByText('rewe')).toBeInTheDocument();
    expect(screen.getByText('Groceries')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'On' }));
    expect(update).toHaveBeenCalledWith({ id: 'k1', input: { enabled: false } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
    expect(remove).toHaveBeenCalledWith('k1');
  });

  it('adds a rule from the form', async () => {
    useImportRules.mockReturnValue({ data: { data: [] } });
    useEnvelopes.mockReturnValue({ data: { data: [groceries] } });
    create.mockResolvedValue({});
    render(<ImportRules />);
    expect(screen.getByText('No rules yet.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Payee contains'), { target: { value: 'Aldi' } });
    fireEvent.change(screen.getByLabelText('Envelope'), { target: { value: 'e1' } });
    fireEvent.change(screen.getByLabelText('Priority'), { target: { value: '3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add rule' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith({ pattern: 'Aldi', envelopeId: 'e1', priority: 3 }));
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `cd Heorth/web && npx vitest run src/components/feoh/import-inbox.test.tsx src/components/feoh/import-rules.test.tsx`
Expected: FAIL — components missing.

- [ ] **Step 4: The inbox component**

Create `Heorth/web/src/components/feoh/import-inbox.tsx`:

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { useFormatters } from '@/hooks/use-formatters';
import { useEnvelopes, useAccounts } from '@/hooks/use-feoh';
import { useImportInbox, useImportAccounts, useConfirmInboxRow, useDismissInboxRow } from '@/hooks/use-feoh-import';
import type { ImportedTransaction } from '@/lib/types';
import { ApiError } from '@/api/client';

const selectClass = 'h-9 w-full rounded-md border border-tan bg-card px-3 text-sm';

/**
 * The shared `formatMoney` is fixed to the household's display currency; an
 * imported line carries ITS OWN currency (that is the whole point of the
 * foreign-currency rule), so format with the row's code and fall back to a
 * plain decimal + code for codes Intl does not know.
 */
export function formatAmount(amount: string | number, currency: string, localeCode: string): string {
  const n = Number(amount);
  try {
    return new Intl.NumberFormat(localeCode, { style: 'currency', currency }).format(n);
  } catch {
    return `${n.toFixed(2)} ${currency}`;
  }
}

interface Props { householdCurrency: string }

function InboxRow({ row, householdCurrency, mappedAccountId }: { row: ImportedTransaction; householdCurrency: string; mappedAccountId: string | undefined }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { formatDate, locale } = useFormatters();
  const localeCode = locale.code ?? 'en-US';
  const envelopes = useEnvelopes().data?.data ?? [];
  const accounts = useAccounts().data?.data ?? [];
  const confirm = useConfirmInboxRow();
  const dismiss = useDismissInboxRow();
  const [envelopeId, setEnvelopeId] = useState('');
  const [accountId, setAccountId] = useState('');

  const foreign = row.currency !== householdCurrency;
  const unmapped = !mappedAccountId;
  const canBook = !foreign && envelopeId !== '' && (!unmapped || accountId !== '');

  const book = async () => {
    try {
      await confirm.mutateAsync({ id: row.id, input: unmapped ? { envelopeId, accountId } : { envelopeId } });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : (e as Error).message, 'error');
    }
  };

  return (
    <li className="rounded-md border border-tan p-3 space-y-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="font-medium">{row.payee}</div>
          <div className="text-xs text-gray-500">{formatDate(row.date)}{row.memo ? ` · ${row.memo}` : ''}</div>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant="outline">{t(`feoh.import.inbox.${row.direction}`)}</Badge>
          <span className="font-mono">{row.direction === 'out' ? '−' : '+'}{formatAmount(row.amount, row.currency, localeCode)}</span>
        </div>
      </div>
      {foreign && (
        <p className="text-sm text-amber-700">{t('feoh.import.inbox.foreignCurrency', { currency: row.currency, household: householdCurrency })}</p>
      )}
      {!foreign && unmapped && (
        <p className="text-sm text-amber-700">{t('feoh.import.inbox.unmapped', { source: row.sourceAccountId })}</p>
      )}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
        <div className="space-y-1">
          <Label htmlFor={`env-${row.id}`}>{t('feoh.import.inbox.envelope')}</Label>
          <select id={`env-${row.id}`} className={selectClass} value={envelopeId} onChange={(e) => setEnvelopeId(e.target.value)} disabled={foreign}>
            <option value="">{t('feoh.import.inbox.pickEnvelope')}</option>
            {envelopes.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
          </select>
        </div>
        {unmapped && !foreign && (
          <div className="space-y-1">
            <Label htmlFor={`acc-${row.id}`}>{t('feoh.import.inbox.account')}</Label>
            <select id={`acc-${row.id}`} className={selectClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
              <option value="">{t('feoh.import.inbox.pickAccount')}</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
        )}
        <div className="flex gap-2">
          <Button size="sm" onClick={book} disabled={!canBook || confirm.isPending}>{t('feoh.import.inbox.book')}</Button>
          <Button size="sm" variant="outline" onClick={() => dismiss.mutateAsync(row.id)} disabled={dismiss.isPending}>{t('feoh.import.inbox.dismiss')}</Button>
        </div>
      </div>
    </li>
  );
}

export default function ImportInbox({ householdCurrency }: Props) {
  const { t } = useTranslation();
  const inbox = useImportInbox({ status: 'pending', limit: 50 });
  const mappings = useImportAccounts().data?.data ?? [];
  const accountFor = new Map(mappings.map((m) => [m.sourceAccountId, m.accountId]));
  const rows = inbox.data?.data ?? [];

  return (
    <div className="space-y-3">
      <h4 className="font-medium">{t('feoh.import.inbox.title')}</h4>
      {rows.length === 0 ? (
        <p className="text-sm text-gray-500">{t('feoh.import.inbox.empty')}</p>
      ) : (
        <ul className="space-y-2">
          {rows.map((row) => (
            <InboxRow key={row.id} row={row} householdCurrency={householdCurrency} mappedAccountId={accountFor.get(row.sourceAccountId)} />
          ))}
        </ul>
      )}
    </div>
  );
}
```

`formatDate` (`web/src/lib/format.ts`) goes through date-fns `parseISO`, which accepts a bare `YYYY-MM-DD`, so `row.date` can be passed as is.

- [ ] **Step 5: The rules component**

Create `Heorth/web/src/components/feoh/import-rules.tsx`:

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useToast } from '@/components/ui/toast';
import { useEnvelopes } from '@/hooks/use-feoh';
import { useImportRules, useCreateRule, useUpdateRule, useDeleteRule } from '@/hooks/use-feoh-import';

const selectClass = 'h-9 w-full rounded-md border border-tan bg-card px-3 text-sm';

export default function ImportRules() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const rules = useImportRules().data?.data ?? [];
  const envelopes = useEnvelopes().data?.data ?? [];
  const envelopeName = new Map(envelopes.map((e) => [e.id, e.name]));
  const create = useCreateRule();
  const update = useUpdateRule();
  const remove = useDeleteRule();
  const [pattern, setPattern] = useState('');
  const [envelopeId, setEnvelopeId] = useState('');
  const [priority, setPriority] = useState('0');

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pattern.trim() || !envelopeId) return;
    try {
      await create.mutateAsync({ pattern: pattern.trim(), envelopeId, priority: Number(priority) || 0 });
      setPattern(''); setPriority('0');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <div className="space-y-3">
      <h4 className="font-medium">{t('feoh.import.rules.title')}</h4>
      <p className="text-sm text-gray-500">{t('feoh.import.rules.intro')}</p>
      {rules.length === 0 ? (
        <p className="text-sm text-gray-500">{t('feoh.import.rules.empty')}</p>
      ) : (
        <ul className="divide-y divide-tan">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <div className="flex items-baseline gap-3">
                <span className="font-mono text-sm">{r.pattern}</span>
                <span className="text-sm">→ {envelopeName.get(r.envelopeId) ?? r.envelopeId}</span>
                <span className="text-xs text-gray-500">{t('feoh.import.rules.priority')} {r.priority}</span>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => update.mutate({ id: r.id, input: { enabled: !r.enabled } })}>
                  {r.enabled ? t('feoh.import.rules.enabled') : t('feoh.import.rules.disabled')}
                </Button>
                <Button size="sm" variant="outline" onClick={() => remove.mutate(r.id)}>{t('feoh.import.rules.remove')}</Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-4 gap-2 items-end">
        <div className="space-y-1">
          <Label htmlFor="rule-pattern">{t('feoh.import.rules.pattern')}</Label>
          <Input id="rule-pattern" value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder={t('feoh.import.rules.patternPlaceholder')} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="rule-envelope">{t('feoh.import.rules.envelope')}</Label>
          <select id="rule-envelope" className={selectClass} value={envelopeId} onChange={(e) => setEnvelopeId(e.target.value)}>
            <option value="">{t('feoh.import.inbox.pickEnvelope')}</option>
            {envelopes.map((en) => <option key={en.id} value={en.id}>{en.name}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <Label htmlFor="rule-priority">{t('feoh.import.rules.priority')}</Label>
          <Input id="rule-priority" type="number" value={priority} onChange={(e) => setPriority(e.target.value)} />
        </div>
        <Button type="submit" size="sm" disabled={!pattern.trim() || !envelopeId || create.isPending}>{t('feoh.import.rules.add')}</Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 6: The account-mapping component**

Create `Heorth/web/src/components/feoh/import-accounts.tsx`:

```tsx
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useAccounts } from '@/hooks/use-feoh';
import { useImportAccounts, useUpsertAccountMapping, useDeleteAccountMapping } from '@/hooks/use-feoh-import';

const selectClass = 'h-9 w-full rounded-md border border-tan bg-card px-3 text-sm';

export default function ImportAccounts() {
  const { t } = useTranslation();
  const mappings = useImportAccounts().data?.data ?? [];
  const accounts = useAccounts().data?.data ?? [];
  const accountName = new Map(accounts.map((a) => [a.id, a.name]));
  const upsert = useUpsertAccountMapping();
  const remove = useDeleteAccountMapping();
  const [source, setSource] = useState('');
  const [accountId, setAccountId] = useState('');

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!source.trim() || !accountId) return;
    await upsert.mutateAsync({ sourceAccountId: source.trim(), accountId });
    setSource('');
  };

  return (
    <div className="space-y-3">
      <h4 className="font-medium">{t('feoh.import.accounts.title')}</h4>
      <p className="text-sm text-gray-500">{t('feoh.import.accounts.intro')}</p>
      {mappings.length === 0 ? (
        <p className="text-sm text-gray-500">{t('feoh.import.accounts.empty')}</p>
      ) : (
        <ul className="divide-y divide-tan">
          {mappings.map((m) => (
            <li key={m.id} className="flex items-center justify-between gap-2 py-2">
              <span className="text-sm"><span className="font-mono">{m.sourceAccountId}</span> → {accountName.get(m.accountId) ?? m.accountId}</span>
              <Button size="sm" variant="outline" onClick={() => remove.mutate(m.id)}>{t('feoh.import.accounts.remove')}</Button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={add} className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
        <div className="space-y-1">
          <Label htmlFor="map-source">{t('feoh.import.accounts.source')}</Label>
          <Input id="map-source" value={source} onChange={(e) => setSource(e.target.value)} placeholder={t('feoh.import.accounts.sourcePlaceholder')} />
        </div>
        <div className="space-y-1">
          <Label htmlFor="map-account">{t('feoh.import.accounts.account')}</Label>
          <select id="map-account" className={selectClass} value={accountId} onChange={(e) => setAccountId(e.target.value)}>
            <option value="">{t('feoh.import.inbox.pickAccount')}</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        </div>
        <Button type="submit" size="sm" disabled={!source.trim() || !accountId || upsert.isPending}>{t('feoh.import.accounts.add')}</Button>
      </form>
    </div>
  );
}
```

- [ ] **Step 7: The card on the Feoh page**

In `Heorth/web/src/pages/feoh.tsx`, add imports:

```tsx
import ImportInbox from '@/components/feoh/import-inbox';
import ImportRules from '@/components/feoh/import-rules';
import ImportAccounts from '@/components/feoh/import-accounts';
import { useImportStatus, useTriggerSync } from '@/hooks/use-feoh-import';
```

Inside `FeohPage`, after `const deleteBill = useDeleteBill();`:

```tsx
  const importStatus = useImportStatus();
  const sync = useTriggerSync();
  const status = importStatus.data?.data;
  const pullNow = async () => {
    try {
      const r = await sync.mutateAsync();
      toast(t('feoh.import.syncDone', { inserted: r.data.inserted, booked: r.data.booked }), 'success');
    } catch (e) {
      toast(t('feoh.import.syncFailed', { reason: e instanceof ApiError ? e.code : (e as Error).message }), 'error');
    }
  };
```

And a new card after the `Import / export` card, before the closing `</>`:

```tsx
          <Card>
            <CardHeader className="pb-3 flex flex-row items-center justify-between gap-2">
              <CardTitle className="text-base">
                {t('feoh.import.title')}
                {status && status.pendingCount > 0 && (
                  <span className="ml-2 text-sm font-normal text-gray-500">{t('feoh.import.pending', { count: status.pendingCount })}</span>
                )}
              </CardTitle>
              {status?.enabled && (
                <Button size="sm" variant="outline" onClick={pullNow} disabled={sync.isPending}>
                  {sync.isPending ? t('feoh.import.syncing') : t('feoh.import.syncNow')}
                </Button>
              )}
            </CardHeader>
            <CardContent className="space-y-6">
              <p className="text-sm text-gray-500">{t('feoh.import.intro')}</p>
              {status && !status.enabled && <p className="text-sm text-gray-500">{t('feoh.import.disabled')}</p>}
              {status?.feed?.lastError && <p className="text-sm text-amber-700">{t('feoh.import.lastError', { reason: status.feed.lastError })}</p>}
              {status && <ImportInbox householdCurrency={status.currency} />}
              <ImportRules />
              <ImportAccounts />
            </CardContent>
          </Card>
```

The household currency comes from `GET /ingestion/status` (`status.currency`, Task 6) — never hard-coded in the web. The server stays the authority (a mismatching line answers `409 CURRENCY_MISMATCH`); the web value only pre-disables the Book button.

- [ ] **Step 8: Extend the page test's mocks**

In `Heorth/web/src/pages/feoh.test.tsx`, add a second `vi.mock` beside the existing one:

```ts
vi.mock('@/hooks/use-feoh-import', () => ({
  useImportStatus: () => ({ data: { data: { enabled: false, currency: 'EUR', pendingCount: 0, feed: null } }, isError: false, isLoading: false }),
  useTriggerSync: () => mutation,
  useImportInbox: () => okList,
  useImportAccounts: () => okList,
  useImportRules: () => okList,
  useConfirmInboxRow: () => mutation,
  useDismissInboxRow: () => mutation,
  useCreateRule: () => mutation,
  useUpdateRule: () => mutation,
  useDeleteRule: () => mutation,
  useUpsertAccountMapping: () => mutation,
  useDeleteAccountMapping: () => mutation,
}));
```

and one assertion in the existing test: `expect(screen.getByText('Bank import')).toBeInTheDocument();`.

- [ ] **Step 9: Run the web suite and build**

Run: `cd Heorth/web && npx vitest run && npm run build`
Expected: all green (previously 62 files / 338 tests, now more), build succeeds.

- [ ] **Step 10: Commit (Heorth)**

```bash
cd Heorth && git add web/src/components/feoh/import-inbox.tsx web/src/components/feoh/import-inbox.test.tsx web/src/components/feoh/import-rules.tsx web/src/components/feoh/import-rules.test.tsx web/src/components/feoh/import-accounts.tsx web/src/pages/feoh.tsx web/src/pages/feoh.test.tsx web/src/i18n/locales/en.json web/src/i18n/locales/de.json
git commit -m "feat(web): Bank import card on the Feoh page - inbox, rules, account mapping (en/de)"
```

---

## Task 12: Meta repo — prod compose, currency knob, demo seed, docs

**Files (meta repo only — never stage `Heorth/`):**
- Modify: `deploy/compose.prod.yml`, `deploy/compose.dev.yml`, `deploy/compose.demo.yml`, `deploy/.env.example`, `deploy/seed-demo.mjs`, `deploy/README.md`, `docs/strategy.md`, `docs/superpowers/specs/2026-08-28-feoh-bank-ingestion-design.md`

- [ ] **Step 1: `FEOH_CURRENCY` everywhere Heorth is configured**

In `deploy/compose.dev.yml`, directly after the `FIREFLY_PAT: ${FIREFLY_PAT:-}` line in the `heorth` service:

```yaml
      # The household's one currency (ISO 4217). Imported lines in any other
      # currency wait in the inbox and are never booked.
      FEOH_CURRENCY: ${FEOH_CURRENCY:-EUR}
```

In `deploy/compose.demo.yml`, directly after `FEOH_IMPORT_ENABLED: "false"` in the `heorth` service:

```yaml
      FEOH_CURRENCY: ${FEOH_CURRENCY:-EUR}
```

In `deploy/.env.example`, directly after the `FEOH_IMPORT_ENABLED=false` line:

```dotenv
# The household's one currency (ISO 4217). Default EUR.
FEOH_CURRENCY=EUR
```

- [ ] **Step 2: Firefly in production**

In `deploy/compose.prod.yml`:

a) In the `db` service `environment`, add `FIREFLY_DB_PASSWORD: ${FIREFLY_DB_PASSWORD:-}` after `KITH_DB_PASSWORD` (initdb creates the `firefly` role and database only when it is non-empty — that guard already exists in `deploy/initdb/10-databases.sh`).

b) In the `heorth` service `environment`, after `KITH_API_KEY_KIND`:

```yaml
      # Bank ingestion (ADR 0016). Firefly III is a one-way ingestion provider,
      # never the ledger. Heorth POLLS the sidecar; no inbound route, no shared
      # secret. DEFAULTS OFF. In production the personal access token is a
      # MANUAL step: log in to Firefly, Profile -> OAuth -> Personal Access
      # Tokens, paste it into deploy/.env as FIREFLY_PAT, set
      # FEOH_IMPORT_ENABLED=true, recreate heorth and firefly-importer.
      FEOH_IMPORT_ENABLED: ${FEOH_IMPORT_ENABLED:-false}
      FIREFLY_BASE_URL: ${FIREFLY_BASE_URL:-http://firefly:8080}
      FIREFLY_PAT: ${FIREFLY_PAT:-}
      FEOH_CURRENCY: ${FEOH_CURRENCY:-EUR}
```

c) Two new services after `heorth-mcp` and before `db-backup` (or at the end of `services:` if there is no backup service), mirroring the dev file with the prod database name and the prod port band (`4000`-series, like `heorth` on 4000 and `kithledger` on 4002):

```yaml
  # Bank-ingestion sidecar (ADR 0016) — optional. Firefly talks to banks and
  # nothing else; Feoh stays the system of record. Its database is NOT in the
  # backup set on purpose: it owns no household-visible data, and a re-import
  # from the banks recreates it.
  firefly:
    image: fireflyiii/core:version-6.6.6
    environment:
      APP_KEY: ${FIREFLY_APP_KEY:?exactly 32 characters, set it in deploy/.env}
      APP_URL: ${FIREFLY_APP_URL:?the URL the operator's browser uses}
      TRUSTED_PROXIES: "**"
      SITE_OWNER: ${HEORTH_ADMIN_EMAIL:?set it in deploy/.env}
      TZ: ${TZ:-Europe/Berlin}
      DB_CONNECTION: pgsql
      DB_HOST: db
      DB_PORT: 5432
      DB_DATABASE: firefly
      DB_USERNAME: firefly
      DB_PASSWORD: ${FIREFLY_DB_PASSWORD:?set it in deploy/.env}
    volumes:
      - firefly_upload:/var/www/html/storage/upload
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "4001:8080"
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://127.0.0.1:8080/health > /dev/null || exit 1"]
      interval: 15s
      timeout: 10s
      retries: 5
      start_period: 120s
    restart: unless-stopped

  firefly-importer:
    image: fireflyiii/data-importer:version-1.9.1
    environment:
      FIREFLY_III_URL: http://firefly:8080
      VANITY_URL: ${FIREFLY_APP_URL:?the URL the operator's browser uses}
      FIREFLY_III_ACCESS_TOKEN: ${FIREFLY_PAT:-}
      TRUSTED_PROXIES: "**"
      TZ: ${TZ:-Europe/Berlin}
    volumes:
      - firefly_importer_config:/var/www/html/storage/configurations
    depends_on:
      firefly:
        condition: service_started
    ports:
      - "4004:8080"
    restart: unless-stopped
```

d) Add `firefly_upload:` and `firefly_importer_config:` to the top-level `volumes:`.

`deploy/initdb/10-databases.sh` already handles this: when `FIREFLY_DB_PASSWORD` is non-empty it creates role `firefly` and database `firefly` (the prod name), and adds `firefly_dev` only when `CREATE_TEST_DATABASES=true` (the dev stack). Nothing to change there.

Validate with a filled throw-away env so `:?` guards do not mask a YAML error: `grep -oE '^[A-Z_]+' deploy/.env.example | sed 's/$/=placeholder/' > "$TMP/prod-check.env"` (use the session scratchpad for `$TMP`), then `docker compose -f deploy/compose.prod.yml --env-file "$TMP/prod-check.env" config --quiet` — expected: silent. Any output is a real error. Also run `docker compose -f deploy/compose.dev.yml --env-file deploy/.env config --quiet` — expected: silent.

- [ ] **Step 3: Seed the demo inbox**

In `deploy/seed-demo.mjs`, inside `seedHeorth()`, directly after the recurring-bills loop closes (the loop ending in `count('bills', verdict);`) — that is the point where `accId`, `envId`, `as` and `token` are all in scope. The finance section sits after the Ethel and Weorc blocks in this file; do not move it:

```js
  // --- feoh: bank import (ADR 0016) ------------------------------------------
  // The demo has no Firefly (ADR 0012: no external systems), so the inbox is
  // filled through the manual-line route, which runs the SAME pipeline a
  // provider page does: a rule hit books, everything else waits. source_ids
  // are fixed so the seed stays idempotent (the server prefixes `manual:`).
  const mappings = [{ sourceAccountId: 'demo-bank:joint', account: 'Joint current account' }];
  const existingMappings = (await heorth('GET', '/api/v1/feoh/ingestion/accounts', { token })) ?? [];
  const mappingBySource = new Map(existingMappings.map((m) => [m.sourceAccountId, m]));
  for (const m of mappings) {
    const [, verdict] = await ensure(
      `import mapping ${m.sourceAccountId}`,
      async () => mappingBySource.get(m.sourceAccountId) ?? null,
      async () => heorth('PUT', '/api/v1/feoh/ingestion/accounts', { ...as, body: { sourceAccountId: m.sourceAccountId, accountId: accId[m.account] } })
    );
    count('import mappings', verdict);
  }

  const rules = [
    { pattern: 'rewe', envelope: 'Groceries', priority: 0 },
    { pattern: 'northern gas', envelope: 'Utilities', priority: 0 },
    { pattern: 'acme', envelope: 'Income', priority: 0 },
  ];
  const existingRules = (await heorth('GET', '/api/v1/feoh/ingestion/rules', { token })) ?? [];
  const ruleByPattern = new Map(existingRules.map((r) => [r.pattern, r]));
  for (const r of rules) {
    const [, verdict] = await ensure(
      `import rule ${r.pattern}`,
      async () => ruleByPattern.get(r.pattern) ?? null,
      async () => heorth('POST', '/api/v1/feoh/ingestion/rules', { ...as, body: { pattern: r.pattern, envelopeId: envId[r.envelope], priority: r.priority } })
    );
    count('import rules', verdict);
  }

  // Five lines: two book by rule (REWE, ACME), one waits for a member (the
  // bakery has no rule), one is unmapped (a cash line), one is USD and waits
  // for ever — the case the single-currency rule exists for.
  const lines = [
    { sourceId: 'demo-0001', sourceAccountId: 'demo-bank:joint', date: day(-3), payee: 'REWE', memo: 'REWE SAGT DANKE 4711', amount: 63.2, direction: 'out' },
    { sourceId: 'demo-0002', sourceAccountId: 'demo-bank:joint', date: day(-2), payee: 'ACME GmbH', memo: 'SALARY', amount: 3850, direction: 'in' },
    { sourceId: 'demo-0003', sourceAccountId: 'demo-bank:joint', date: day(-2), payee: 'Bakery on the corner', memo: null, amount: 7.4, direction: 'out' },
    { sourceId: 'demo-0004', sourceAccountId: 'demo-bank:cash', date: day(-1), payee: 'Market stall', memo: 'Apples', amount: 5.0, direction: 'out' },
    { sourceId: 'demo-0005', sourceAccountId: 'demo-bank:joint', date: day(-1), payee: 'Amazon', memo: 'Ebook', amount: 12.0, direction: 'out', currency: 'USD' },
  ];
  // `heorth()` returns the response's `data` only (never the status), so the
  // natural key is the prefixed source_id in a one-shot listing of the inbox.
  const existingLines = (await heorth('GET', '/api/v1/feoh/ingestion/inbox?limit=100', { token })) ?? [];
  const lineBySource = new Map(existingLines.map((r) => [r.sourceId, r]));
  for (const l of lines) {
    const [, verdict] = await ensure(
      `import line ${l.sourceId}`,
      async () => lineBySource.get(`manual:${l.sourceId}`) ?? null,
      async () => heorth('POST', '/api/v1/feoh/ingestion/inbox', { ...as, body: l })
    );
    count('import lines', verdict);
  }
```

`ensure()` returns `[record, 'created' | 'existing']` and `count()` tallies exactly those two verdicts; `day(n)` is `monday + n` days via `setUTCDate`, so negative offsets work. Place the block right after `count('bills', verdict);`'s loop closes.

- [ ] **Step 4: Run the demo end to end**

From the meta root: `bash deploy/demo-up.sh --fresh` (see `.agents/skills/wyrhta-demo/SKILL.md` first). Expected in the seed output: 1 import mapping, 3 import rules, 5 import lines. Then, as a demo adult (login values from `.env.demo`, never printed):

```bash
curl -fsS -H "Authorization: Bearer $TOKEN" 'http://localhost:24000/api/v1/feoh/ingestion/status'
curl -fsS -H "Authorization: Bearer $TOKEN" 'http://localhost:24000/api/v1/feoh/ingestion/inbox?status=pending' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.meta.total, j.data.map(r=>r.payee+' '+r.currency))})"
```

Expected: `status.enabled === false`, `pendingCount === 3`; the pending list is the bakery (EUR, mapped, no rule), the market stall (EUR, unmapped), and Amazon (USD). Run `demo-up.sh` a second time without `--fresh` and confirm it reports the lines as already present. Open `http://localhost:24002`'s sibling Heorth UI at `http://localhost:24000/feoh` and book the bakery line into Groceries; the transaction appears in the ledger.

- [ ] **Step 5: Docs**

`deploy/README.md`: in the Firefly section (search "Firefly III and its Data Importer are an **optional** sidecar"), append one paragraph:

```markdown
**Prod.** `compose.prod.yml` runs the same two containers (`4001` and `4004`)
against a `firefly` database in the shared cluster; `FIREFLY_DB_PASSWORD`,
`FIREFLY_APP_KEY` and `FIREFLY_APP_URL` must be set in `deploy/.env`. The token
is a manual step there (Profile → OAuth → Personal Access Tokens). `FEOH_CURRENCY`
(default `EUR`) is the household's one currency in every stack; a line in any
other currency waits in the inbox and is never booked.
```

`docs/superpowers/specs/2026-08-28-feoh-bank-ingestion-design.md`: add, under the header block, a status line and the settled decisions:

```markdown
**Status:** shipped 2026-09-XX (Heorth v0.8.0). Implementation plan:
[2026-09-05-feoh-bank-ingestion](../plans/2026-09-05-feoh-bank-ingestion.md).
Three things settled at implementation time: the routes live under
`/api/v1/feoh/ingestion/*` (`/feoh/import` was already the CSV import); the
overlap re-window happens inside the provider via a third `SourcePage` field,
`checkpoint`, so the cursor stays opaque; and the household currency is
`FEOH_CURRENCY` (default `EUR`). `POST /ingestion/inbox` adds a manual line and
is how the demo seed fills the inbox.
```

(Replace `XX` and the version with the real release once Task 13 is done.)

`docs/strategy.md`: in Phase 5+ where "checking accounts for daily life" is listed, add a sentence: "Bank ingestion shipped 2026-09 behind ADR 0016 (Firefly III as an optional sidecar; Feoh remains the ledger). Phase 3 deployment is next — ADR 0016 named this the last pre-deployment slice."

- [ ] **Step 6: Commit (meta)**

```bash
git add deploy/compose.prod.yml deploy/compose.dev.yml deploy/compose.demo.yml deploy/.env.example deploy/seed-demo.mjs deploy/README.md docs/strategy.md docs/superpowers/specs/2026-08-28-feoh-bank-ingestion-design.md
git status --short   # must show ONLY those files — never Heorth/
git commit -m "feat(deploy): Firefly in prod, FEOH_CURRENCY, and a seeded demo import inbox (ADR 0016)"
```

---

## Task 13: Release Heorth

- [ ] **Step 1: Full verification**

```bash
cd Heorth && npm run typecheck && npx vitest run && npm run build && cd web && npx vitest run && npm run build
```

Expected: every suite green, both builds clean. Backend tests need `DATABASE_URL` pointing at `heorth_test` on the dev cluster (see `tests/setup.ts`; the password lives in `deploy/.env` as `HEORTH_DB_PASSWORD` — export it, never print it).

- [ ] **Step 2: Cut v0.8.0**

In `Heorth/CHANGELOG.md`, insert `## [0.8.0] - <today>` under `## [Unreleased]` (leave an empty Unreleased above it). Then:

```bash
cd Heorth && npm version 0.8.0 --no-git-tag-version
git add CHANGELOG.md package.json package-lock.json
git commit -m "chore(release): v0.8.0"
git tag -a v0.8.0 -m "v0.8.0"
git push origin main && git push origin v0.8.0
gh run list --limit 3
```

Expected: `tests` and `Build & Push Container Image` runs succeed for both `main` and the tag. Then fill in the date/version placeholder in the spec's status line (meta repo) and commit that as `docs: record the bank-ingestion slice as shipped`.

---

## Final verification (both repos)

- [ ] Heorth: `npm run typecheck && npx vitest run` green; `web`: `npx vitest run && npm run build` green; `gh run list` green after the push.
- [ ] `grep -rn "insert(transactions)\|insert(postings)" Heorth/src/modules/feoh/import/` returns nothing — the single-write-path invariant.
- [ ] `grep -rn "toISOString" Heorth/src/modules/feoh/import/` returns only the `lastSuccessAt` line in `sync.ts`.
- [ ] Demo stack: `demo-up.sh --fresh` seeds 1 mapping, 3 rules, 5 lines; `status.pendingCount === 3`; a second run adds nothing.
- [ ] Dev stack with `FEOH_IMPORT_ENABLED=true` and the minted PAT: `POST /api/v1/feoh/ingestion/sync` returns `ok: true` (with zero rows on a bank-less Firefly) and `status.feed.lastSuccessAt` is set; `last_error` stays null.
- [ ] Meta: `git status --short` never lists `Heorth/`.
- [ ] Execution ledger (`.superpowers/sdd/progress.md`) records the slice; the Stop hook syncs it into `docs/execution-log.md`; review the synced diff and commit it.
