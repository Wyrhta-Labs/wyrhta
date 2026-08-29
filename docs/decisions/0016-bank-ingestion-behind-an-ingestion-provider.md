# 0016 — Bank ingestion behind an ingestion provider; Firefly III is a sidecar, not the ledger

**Status:** accepted 2026-08-28

## Context

Feoh's Phase 5+ growth list opens with "checking accounts for daily life"
(`strategy.md`), and daily life means bank statements. Getting transactions out
of German banks is PSD2 work — Nordigen/GoCardless enrolment, CAMT.053, per-bank
quirks — and it is the one part of the finance domain that is expensive to build
and boring to own.

Firefly III solves exactly that. Its Data Importer ships providers for file
(CSV + CAMT.053), GoCardless/Nordigen, SimpleFIN and Sophtron, and Firefly's own
API exposes what the importer collected. A probe of v6.6.6 confirmed the parts
that matter: Postgres via `DB_CONNECTION=pgsql`, a documented REST API, and
transactions that carry `external_id` with `external_id_is` as a real search
modifier.

The tempting version of this decision is the larger one: let Firefly *be* the
ledger and delete Feoh's finance code. The probe says no, for four reasons that
are properties of Firefly's model, not of its quality.

1. **Envelopes are not budgets.** In Feoh a posting targets `account_id` *or*
   `envelope_id`, and an envelope's balance is the sum of its postings. In
   Firefly a budget is metadata on a split (`budget_id`), never a posting
   target, and its "balance" is limit-minus-spent-in-period. Envelope-to-credit-
   account has no Firefly equivalent. Adopting it is a semantic migration, not a
   data migration.
2. **The occurrence engine would stay anyway.** Firefly bills have no
   per-occurrence amount override, and their `skip` means "every Nth period", not
   "skip this one". `recurring_occurrences`, `cadence.ts` and `occurrences.ts`
   would remain in Heorth, keyed by a Firefly bill id with no foreign key.
3. **No shared administration.** `routes/api.php` has the user-group store, use
   and membership-update routes commented out. One Firefly user is one
   administration. Firefly's web UI has no concept of a household member.
4. **The test fake is the hidden bill.** Feoh is 1350 LOC of production code
   against 1658 LOC of tests running without a container (`wc -l` over
   `src/modules/feoh/*.ts` and `tests/feoh-*.test.ts`). A fake covering
   accounts, budgets, budget-limits, search and summary would have to model
   budget-spent and account-balance semantics — rebuilding, in test code and with
   no upstream to check against, exactly the semantics that were outsourced.

Netting it: roughly 700 LOC would leave and roughly as much would arrive, plus a
second deployable and a permanent semantic dependency. That is the trade ADR 0007
already made against a second deployable; the fact that this one is third-party
does not improve it.

**Timing — this ADR overrides the roadmap, and says so.**
[ADR 0015](0015-feature-work-resumes-before-deployment.md) §5 says Phase 3 resumes
after Weorc with "no new gate, no further feature slice ahead of it", and its
consequences call a second pre-deployment slice "the signal that the roadmap has
stopped being a plan". `strategy.md` puts Phase 3 next and Feoh's checking
accounts in an unordered Phase 5+. This decision contradicts all of that. It is
the second pre-deployment slice, and the honest reading is the one ADR 0015
supplied in advance: the roadmap has stopped sequencing this work.

The reason is preference, not necessity — bank ingestion is what makes the
finance module worth opening daily, and it is being built now because that is
judged worth the delay. The empty-database benefit is real (per ADR 0015's own
corollary these four tables are a drop-and-create, and would not be after first
bring-up) but it is **not** a distinguishing argument: it is equally true of any
feature taken before deployment, which is exactly the trap ADR 0015 named. It is
recorded as a consolation, not a justification. A *third* pre-deployment slice
should be refused.

## Decision

**Firefly III + Data Importer run as an optional sidecar whose only job is
talking to banks. Feoh remains the system of record for every financial fact the
household sees.**

1. **A third provider category: ingestion providers.** Neither ADR 0001 nor
   ADR 0003 fits — the household does not author bank transactions and there is
   no write-back or tenant to OAuth into (so not 0001), and this is not
   read-only world data that gets cached (so not 0003). An ingestion provider is
   one-way inbound and yields raw material that becomes domain data only through
   a decision taken in Heorth.
2. **The interface is two methods and carries no semantics.**
   `listSince(cursor, limit)` — returning a page plus the next watermark — and
   `listAccounts()`, both in Heorth-owned types.
   No `create`, `update` or `delete` — the one-way street is in the type, not
   just the prose. Firefly is therefore replaceable by construction; a CSV or
   other aggregator provider implements the same two methods.
3. **Rules live in Heorth.** A `feoh_import_rules` table (payee pattern →
   envelope) is maintained through Heorth's API and UI. Firefly's rules engine,
   budgets, bills and reconciliation are not used. Firefly's web UI is an
   operator tool for connecting banks, never a household surface — which is how
   the single-user limitation stops mattering.
4. **Rule hit books, miss lands in an inbox.** A matched transaction is booked
   immediately; an unmatched one waits in `feoh_imported_transactions` as
   `pending` until a member assigns an envelope. Booking calls the existing
   `recordTransaction()` — the importer gets no second write path into
   `postings`, so the existing ledger tests remain the guarantee.
5. **Pull, not push.** Heorth polls Firefly on a scheduler tick, following the
   `m365/scheduler` + `m365/sync-runner` pattern (cursor state, classified
   errors, a tick that never throws) rather than reusing that code directly —
   the existing runner is built around per-member connection health, which an
   app-level feed does not have. No inbound route, no shared secret, no
   webhook. Firefly being down pauses the import and nothing else.
6. **One-way and first-read-wins.** Deletions and later edits in Firefly are
   ignored; once imported, the row belongs to Feoh. Rule changes re-evaluate
   `pending` rows only, never booked ones.
7. **Single-currency, and the importer may not change that.** Feoh has no
   currency column and this slice does not add one. A transaction whose currency
   is not the household's stays in the inbox forever rather than being booked at
   face value. Multi-currency in the ledger is its own decision.
8. **Optional per deployment.** `FEOH_IMPORT_ENABLED` follows the M365
   all-or-nothing precedent kept alive by ADR 0007: off means the scheduler does
   not start and the sync trigger returns a classified `provider_unavailable`.
   Reading the inbox, maintaining rules and confirming pending rows keep working
   — they are pure Feoh writes. The sidecar runs in the dev and prod stacks and
   **not** in the demo stack (ADR 0012), which seeds its inbox instead.

## Consequences

- **The expensive part is bought, the valuable part is kept.** PSD2 enrolment
  and statement parsing are outsourced; real foreign keys to `users` and
  `ethel_assets`, one system of record, one API surface and 1658 LOC of existing
  tests are not touched.
- **Finance has no new critical-path dependency.** No Firefly, no finance outage
  — the inverse of what Firefly-as-ledger would have meant.
- **The test fake stays cheap, and that is a consequence of §2.** A two-method
  interface carrying no semantics is faked with an in-memory list, not with a
  model of someone else's budget arithmetic. No PHP container in CI. One
  checked-in response fixture guards against silent drift.
- **The estate gains a third provider taxonomy to hold in mind.** Systems of
  record (0001), reference feeds (0003), ingestion providers (0016). The cost is
  real; the alternative was overloading one of the first two.
- **A second deployable arrives after all** — the thing ADR 0007 deleted. It is
  accepted here because it is optional, outside the critical path, and owns no
  household-visible data. That distinction is what makes it a different decision
  rather than a reversal.
- **Envelopes stay Feoh's.** No semantic migration, no recomputed balances, no
  user-visible change to what a budget means.
- **Firefly's UI is paid for and unused.** Accepted deliberately: the household
  never sees it, so its lack of a member concept never surfaces.
- **The reserved Feoh port slot is spent.** 14001 becomes Firefly in the dev
  stack; the ports table in `AGENTS.md` changes accordingly.
- **Another way to make a member undeletable.** Import rules carry their author
  with `onDelete: restrict`, like `transactions.created_by` and
  `expense_splits.member_id` already do. No new class of problem, but one more
  thing to clear before a member can be hard-deleted.
- **Deleting a booked transaction now returns its bank line to the inbox**
  instead of erasing the household's record that the line existed. A
  consequence of keeping the inbox as the permanent dedup register, and the
  better behaviour — but it means "delete" no longer fully undoes an import.
- **Phase 3 slips again, by the length of this slice.** ADR 0015 §5 asked for
  this to be a conscious decision rather than a drift, and the Context section
  above is that record. A *third* pre-deployment slice should not be taken.
