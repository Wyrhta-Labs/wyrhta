# Feoh bank ingestion — design

**Date:** 2026-08-28 · **Decision:** [ADR 0016](../../decisions/0016-bank-ingestion-behind-an-ingestion-provider.md)

**Target repos — this is at least two commits**, per `AGENTS.md` ("one change, one
repo, one commit"): the module, schema, tests and migration land in
`Wyrhta-Labs/Heorth`; the Compose services and the ports table land in this meta
repo (`deploy/compose.dev.yml`, `deploy/compose.prod.yml`, `deploy/seed-demo.mjs`,
`AGENTS.md`). Neither repo is ever staged from the other.

Firefly III and its Data Importer run as an optional sidecar that talks to banks.
Heorth pulls normalised transactions from it through an ingestion provider, applies
household-owned rules, and books what it can. Feoh stays the system of record.

## 1. Architecture and seams

Firefly is a dumb pipe. It holds statements until Heorth fetches them and is never
the system of record for anything the household sees. Contact with it is limited to
`GET /api/v1/transactions` and `GET /api/v1/accounts` with a personal access token.
Firefly's budgets, bills, rules engine, reconciliation and users are unused, and its
web UI is an operator tool for connecting banks — never a household surface.

New files in Heorth, following the `src/modules/tasks/provider.ts` seam pattern:

```
src/modules/feoh/import/
  provider.ts       seam: setTransactionSourceProvider() / getTransactionSourceProvider()
  providers/
    types.ts        TransactionSourceProvider, ImportedTransaction, SourceAccount
    firefly.ts      the only implementation
  rules.ts          payee pattern -> envelope_id matching
  sync.ts           one tick: pull from cursor, dedup, apply rules, book or inbox
  service.ts        inbox read/confirm/dismiss, rules CRUD
  routes.ts         REST surface, mounted by the existing feoh module
```

The interface is deliberately minimal and demand-driven (ADR 0003 §5 applies the
same rule to reference feeds):

```ts
export interface SourceAccount {
  sourceAccountId: string;
  name: string;
  currency: string;
}

export interface ImportedTransaction {
  sourceId: string;            // stable per LINE, not per group — see "Splits" below
  sourceAccountId: string;
  date: string;                // ISO calendar date
  payee: string;
  memo: string | null;
  amount: number;              // always positive
  currency: string;            // ISO 4217, as delivered by the provider
  direction: 'in' | 'out';
}

export interface SourcePage {
  items: ImportedTransaction[];
  /** Opaque watermark to pass to the next call. Null means "fully caught up". */
  nextCursor: string | null;
}

export interface TransactionSourceProvider {
  listSince(cursor: string | null, limit: number): Promise<SourcePage>;
  listAccounts(): Promise<SourceAccount[]>;
}
```

No `create`, `update` or `delete`: the one-way street is enforced by the type. No
Firefly type crosses the boundary. A CSV or other aggregator provider implements the
same two methods, which is what makes the sidecar replaceable rather than merely
"abstracted".

**The cursor is the provider's to define, not the caller's.** `listSince` returns the
watermark to use next, mirroring how `m365/sync-runner` persists the token the pull
*returned* rather than one the caller guessed (`FeedPullOutcome.nextToken`). The
provider owes two guarantees: a total, stable sort over the rows it emits, and a
`nextCursor` that never sits in the middle of a group of rows sharing a sort key. For
`firefly.ts` that watermark is the composite `(date, sourceId)` of the last row on the
page — a date alone would let a `limit` cut through same-date rows and skip the
remainder forever.

**Splits.** A Firefly transaction is a *group* containing one or more journal lines
(`transactions[]`), each with its own amount, source and destination. The provider
therefore emits **one `ImportedTransaction` per journal line**, with
`sourceId = "<groupId>:<journalId>"`. A plain bank transaction is simply a group of
one, so there is no special case and no unsupported state — and dedup stays correct
per line rather than per group, which a group-level id could not deliver.

## 2. Data model

Four new tables, all prefixed `feoh_import_`. **None of the eight existing Feoh
tables changes** — no new column on `transactions`, nothing made nullable.

### `feoh_import_accounts`

Source account to Feoh account, maintained explicitly.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `source_account_id` | text | **unique** |
| `account_id` | uuid | -> `accounts.id`, `onDelete: restrict` |
| `created_at` / `updated_at` | timestamptz | |

No auto-creation. An unknown source account never invents a Feoh account and never
guesses an existing one.

### `feoh_import_rules`

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `pattern` | text | matched case-insensitively as a substring of `payee` |
| `envelope_id` | uuid | -> `envelopes.id`, `onDelete: restrict` |
| `priority` | integer | not null, default 0 |
| `enabled` | boolean | not null, default true |
| `created_by` | uuid | -> `users.id`, `onDelete: restrict` |
| `created_at` / `updated_at` | timestamptz | |

Evaluation order is `(priority, id)` and the first enabled match wins — deterministic,
so two rules matching the same payee never produce a coin flip. `restrict` rather than
`set null` on `envelope_id`, because a rule without an envelope would silently become
a non-rule.

### `feoh_imported_transactions`

The inbox and the dedup register in one table.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `source_id` | text | **unique** — the idempotency guarantee |
| `source_account_id` | text | as delivered, even when unmapped |
| `date` | date | |
| `payee` | text | |
| `memo` | text | nullable |
| `amount` | numeric(14,2) | positive |
| `currency` | text | as delivered; see "Currency" below |
| `direction` | text | check in (`in`, `out`) |
| `status` | text | check in (`pending`, `booked`, `dismissed`) |
| `envelope_id` | uuid | nullable, -> `envelopes.id`, `onDelete: set null` |
| `transaction_id` | uuid | nullable, -> `transactions.id`, `onDelete: set null` |
| `applied_rule_id` | uuid | nullable, -> `feoh_import_rules.id`, `onDelete: set null` |
| `created_at` / `updated_at` | timestamptz | |

Rows are **never deleted**, including after booking — that is precisely what makes a
re-import a no-op. Check constraint: `status = 'booked'` implies
`transaction_id IS NOT NULL`; the other two statuses imply `transaction_id IS NULL`.

**Deleting a booked transaction needs an explicit unbooking step.** `deleteTransaction()`
already exists (`src/modules/feoh/service.ts:125`), so a booked import row can outlive
its transaction. `ON DELETE SET NULL` alone would violate the check constraint *during*
the `DELETE` statement — Postgres evaluates the check as the referential action fires,
not at commit. The fix follows the pattern `deleteTransaction()` already uses for
`recurring_occurrences` ("capture the rows BEFORE the delete"): inside the same
`db.transaction`, and **before** the `DELETE`, any import row pointing at this
transaction is moved back to `status = 'pending'` with `transaction_id = NULL` and
`applied_rule_id = NULL`. The FK stays `set null` as a backstop, never as the mechanism.
The statement then finds nothing to null and the constraint holds. Deleting a booked
transaction therefore returns its statement line to the inbox rather than erasing the
household's record that the bank line existed — which is the behaviour you want anyway.

**Currency.** Feoh has no currency column anywhere (`schema.ts` — accounts and
transactions are amounts only), so it is single-currency by construction. The first
slice does not change that. `currency` is carried on the inbox row so the fact is not
lost, and a row whose currency differs from the household currency is **never booked**:
it stays `pending` regardless of rule match, and the inbox shows why. Multi-currency in
the ledger is a separate decision, not something an importer gets to introduce sideways.

### `feoh_import_state`

Cursor and health, mirroring `m365_sync_state`.

| column | type | notes |
|---|---|---|
| `id` | uuid pk | |
| `feed_key` | text | **unique**, e.g. `firefly:transactions` |
| `cursor` | text | nullable — null means "never synced" |
| `last_success_at` | timestamptz | nullable |
| `last_error` | text | nullable, short classified token only |
| `consecutive_failures` | integer | not null, default 0 |
| `created_at` / `updated_at` | timestamptz | |

## 3. Data flow

One scheduler tick:

```
1. read cursor, subtract the overlap window (banks backdate)
2. { items, nextCursor } = provider.listSince(cursor, limit)
3. source_id already known?      -> skip          (the overlap is free)
4. currency != household         -> insert pending, never book
5. resolve account mapping       -> missing: insert pending, no account
6. apply rules                   -> no match: insert pending
7. account and envelope present  -> recordTransaction(...), status = booked
8. every row durably written     -> advance cursor to nextCursor
9. nextCursor non-null           -> loop from 2 within the same tick
```

**The cursor advances only after every row on the page is durably written** (inserted
as `pending` or booked), never mid-page. A tick that dies at row 7 of 50 replays the
whole page next time and re-inserts nothing, because dedup is keyed on `source_id`. A
page consisting entirely of overlap duplicates is normal, not an error: it advances the
cursor and books nothing. `nextCursor === null` means caught up and ends the tick.

**Step 6 calls the existing `recordTransaction()` in `src/modules/feoh/service.ts`.**
The importer gets no second write path into `postings`; it is a caller of the ledger
API like any route handler. This is the single most important invariant in the design
— it is what keeps the existing ledger tests meaningful instead of leaving them to run
alongside an unguarded parallel path.

An import always produces exactly two postings, matching the convention already used
by `deploy/seed-demo.mjs` and `reconcileAccount`:

- `direction: 'out'` — account `credit`, envelope `debit`
- `direction: 'in'` — account `debit`, envelope `credit`

**Attribution.** `transactions.created_by` is `NOT NULL` against `users` with
`restrict`, deliberately hardened by ADR 0007; no system user is invented for it.
An auto-booked transaction is attributed to the member who authored the matching rule
(`feoh_import_rules.created_by`); a transaction confirmed from the inbox is attributed
to the confirming member. Whoever writes the rule owns the booking.

The consequence is worth stating plainly: **a member who has authored an import rule
cannot be hard-deleted** while it exists (`onDelete: restrict`). This adds no new class
of problem — `transactions.created_by` and `expense_splits.member_id` already restrict
in exactly the same way (`schema.ts:36`, `:76`), so any member who has ever recorded a
transaction is already undeletable by design, ADR 0007 having made those keys real on
purpose. Deleting such a member means reassigning or removing their rules first, and
the delete path should say so rather than surfacing a foreign-key error.

`expense_splits` and `feoh_item_costs` are untouched by the importer. A booked import
can acquire them afterwards through the normal routes, like any other transaction.

## 4. Error behaviour

**Kill switch.** `FEOH_IMPORT_ENABLED=false` stops the scheduler from starting and
makes the manual sync-trigger route return a classified `provider_unavailable`
(the `src/modules/tasks/service.ts` pattern). Reading the inbox, maintaining rules
and confirming pending rows keep working, because those are pure Feoh writes that do
not need Firefly — the same reasoning as "reads still work off the mirror" for M365,
one step more generous. Toggling has no data side effect.

**Error classification.** `last_error` stores only a short, safe token:
`no_credentials`, `auth_failed`, `network_error`, `rate_limited`, `bad_response`,
`error`. The Firefly response body is never persisted and never logged — it contains
financial data, and a URL can carry the token.

**Tick isolation.** A tick never throws. `consecutive_failures` increments, the timer
is `unref`'d, and the loop does not start under `VITEST` — the `src/m365/scheduler.ts`
precedent. The cursor advances only after a fully processed page; a half-applied tick
replays harmlessly because dedup is keyed on `source_id`.

**Three things deliberately not done** — the payoff of the sidecar model:

- **Deletions in Firefly are ignored.** Once imported, the row belongs to Feoh. The
  orphan problem that would have forced a `DESTROY_TRANSACTION` webhook under
  Firefly-as-ledger does not exist here, which is why no inbound route is needed.
- **Later edits in Firefly are ignored.** First read wins; otherwise a Firefly edit
  would silently overwrite a manual correction in the household's book.
- **Rule changes do not rebook retroactively.** New or edited rules are re-evaluated
  against `pending` rows (cheap and obviously wanted) and never against booked ones.

## 5. Deployment

| | Dev | Demo | Prod |
|---|---:|---:|---:|
| Firefly III | 14001 | — | yes |
| Data Importer | 14004 | — | yes |

Firefly takes the previously reserved Feoh slot **14001** and its own database
`firefly_dev` in the existing Postgres container; prod is analogous. The demo stack
gets neither container (ADR 0012 — no contact with real external systems);
`deploy/seed-demo.mjs` seeds `feoh_import_rules` plus a handful of `pending` and
`booked` rows so the inbox has content, and runs with `FEOH_IMPORT_ENABLED=false`.

Meta-repo changes: the ports table in `AGENTS.md` (the reserved Feoh slot becomes
Firefly), `deploy/compose.dev.yml` and `deploy/compose.prod.yml`.
`FIREFLY_BASE_URL` and `FIREFLY_PAT` live in `deploy/.env` (git-ignored, never logged).

**No MCP growth in this slice.** Per ADR 0008, an "what is in the import inbox" tool
would be a `heorth-mcp` tool calling Heorth's REST API, not a Firefly surface — and it
is explicitly out of scope for the first slice.

## 6. Testing

The two-method interface carries no semantics — no budget-spent, no account balances,
no booking rules — so the fake is an in-memory list, roughly 40 LOC rather than the
~400 of `tests/fake-graph.ts`. **No PHP container in CI.**

- **Rules** — priority order, case-insensitivity, first match wins, disabled rules
  are skipped.
- **Dedup and cursor** — the same `source_id` twice, the overlap window, replay of a
  half-applied tick, a page of pure duplicates, and the boundary case that motivates
  the composite watermark: more same-date rows than `limit`, which must not lose the
  remainder.
- **Splits** — a Firefly group with three journal lines yields three inbox rows with
  distinct `sourceId`s, and re-importing that group inserts nothing.
- **Currency** — a non-household-currency row stays `pending` even when a rule matches.
- **Unbooking** — deleting a booked transaction returns its import row to `pending`
  and the check constraint survives the delete.
- **Booking** — the two-posting shape, the sign convention, account balance moves by
  exactly the amount, `created_by` attribution from the rule.
- **Inbox lifecycle** — pending to booked, pending to dismissed, the check constraint
  holds against both.
- **Kill switch** — scheduler does not start, sync route is classified, reads and
  confirmations still work.
- **Error classification** — no secret and no response body reaches `last_error`.
- **Fixture contract test** — one real Firefly response, captured from the dev
  instance and checked in as JSON, parsed by `firefly.ts`. For a two-method interface
  a single file is enough to keep the fake from drifting away from Firefly unnoticed.

## Open questions

None blocking. Two things to settle during implementation rather than now:

- The overlap window's length (a week is the starting guess; the right number comes
  from watching how far the household's banks actually backdate).
- Whether the inbox needs bulk-confirm in the first slice, or one row at a time is
  enough until there is real volume.
