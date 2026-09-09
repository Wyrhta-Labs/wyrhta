# Feoh committed-spend forecast (subscriptions) — design

**Date:** 2026-09-09 · **Decision:**
[ADR 0018](../../decisions/0018-weorc-projects-one-off-deadlines.md) (proposed)
· **Roadmap:** [`strategy.md`](../../strategy.md) Phase 5+, Feoh module growth

**Status:** proposed, not started. Per ADR 0015 §5 and ADR 0016, Phase 3
deployment comes first: nothing here begins before a real household is running
Heorth. Prior art the household asked for is the iOS app **Subtrack** — a
subscription tracker with a normalised per-month cost, an upcoming-payments
timeline, category statistics, trial and renewal reminders, and multi-currency.
**The App Store listing was not reachable from the authoring session** (network
egress blocked), so its feature set here is from the household's description and
from familiarity, not from a read of the page. Anything in §1 attributed to
Subtrack should be confirmed before it is treated as a requirement.

**Target repos — two commits, per `AGENTS.md`:** the Feoh module, the Weorc
one-off mode, schema, migration and tests land in `Wyrhta-Labs/Heorth`; this
spec, the ADR and the roadmap edits are this meta repo's. No `deploy/` change —
the household currency already exists as `FEOH_CURRENCY`, and no new service is
added.

## 1. What this is

The household can see **what it has already committed to spend**, forward, and
be told in time about the dates where that commitment changes.

In scope:

- A **normalised monthly cost** per recurring bill — "€13.99/month" and
  "€139/year" comparable on one screen.
- A **forward timeline** of what falls due, by month, with a total per month and
  a breakdown by envelope.
- **Subscription facts** a bill does not carry today: the service's URL, its
  billed currency, a trial end, a minimum-term end, a cancel-by date, whether it
  has been cancelled.
- **Announced price changes** — a dated future amount, so a forecast that spans
  the change is right rather than merely arithmetic.
- **Deadlines that reach the task inbox** through Weorc (ADR 0018), for the trial
  end and the cancel-by date.

Out of scope, decided rather than forgotten:

- **No balance projection and no runway.** This forecast says what leaves, not
  what remains. Projecting an account balance needs expected *income* modelled,
  and a projection missing income is not conservative, it is wrong. The engine in
  §4 is written so an income row kind is an addition, not a rewrite.
- **No live FX** (§5). **No income, no salary, no variable-cost estimation.**
- **No auto-detection of subscriptions** from imported bank lines — a real
  temptation given ADR 0016's inbox, and deferred to §9.
- **No per-member split of a subscription.** `expense_splits` exists for booked
  transactions and is not part of the forecast.

## 2. Where it sits in what already exists

Feoh already holds the engine this feature needs, and the first design rule is
to spend it rather than to add a second one:

- `recurring_bills` — payee, amount, cadence, `nextDue`, envelope, optional
  `ethelAssetId`.
- `recurring_occurrences` — a materialised due date per bill, with
  `overrideAmount`, `skipped`, and the link to the booked `transactionId`.
- `cadence.ts` — `CADENCES` (`weekly | monthly | quarterly | semiannual |
  yearly`), `addPeriods`, `projectDueDates(anchor, cadence, toInclusive)`, with
  month-family dates derived from the **anchor's** day-of-month and clamped per
  month (Jan 31 → Feb 28 → Mar 31, never drifting).
- `occurrences.ts` — `listOccurrences({from,to,billId,status})` returning
  `planned | paid | overdue | skipped | unknown` with `expectedAmount`,
  `overrideAmount`, `offSchedule` and `cadenceUnknown`, a 6-month default horizon
  capped at 24 months, and the rule that persisted (touched) rows always appear
  even outside the horizon.

**The forecast is a fold over `listOccurrences`, not a second projector.** Every
precedence question — an override beats the bill amount, a skip removes the
charge, a booked occurrence is truth rather than estimate, an off-schedule row
still counts — is already answered there, and answering it twice is how the two
answers start to differ. This is ADR 0014's one-engine discipline applied inside
Feoh.

## 3. Data model

### `feoh_subscriptions` — a detail row on a bill

The Ethel pattern (ADR 0013 §6: a vehicle is an asset plus a detail row), for
the same reason: a subscription **is** a recurring bill, and a parallel entity
would fork the cadence engine, the envelope link and the TCO link.

```
feoh_subscriptions
  billId        uuid pk → recurring_bills.id  on delete cascade
  createdAt     timestamptz not null default now()
  updatedAt     timestamptz not null default now()
  url           text                       -- where you go to cancel it
  billedCurrency  text                     -- ISO 4217; null = household currency
  billedAmount    numeric(14,2)            -- amount in billedCurrency
  fxRate          numeric(14,6)            -- hand-maintained, billed → household
  fxRateAsOf      date
  trialEndsOn   date
  termEndsOn    date                       -- minimum term / contract end
  cancelByOn    date                       -- last day notice can be given
  cancelledOn   date                       -- set when the household cancelled
  notes         text
```

Constraints:

- CHECK: `(billedCurrency IS NULL) = (billedAmount IS NULL)` and
  `(billedAmount IS NULL) OR (fxRate IS NOT NULL)` — a foreign amount without a
  rate cannot be forecast, so the schema refuses it rather than guessing 1.0.
- CHECK: `billedAmount > 0`, `fxRate > 0`.
- No `status` column. Status is derived: `cancelledOn` set → cancelled;
  `trialEndsOn` in the future → in trial; otherwise active. A stored status
  would be a second truth that drifts against the dates.

### `feoh_bill_price_changes` — an announced future amount

```
feoh_bill_price_changes
  id            uuid pk
  billId        uuid not null → recurring_bills.id  on delete cascade
  effectiveFrom date not null
  amount        numeric(14,2) not null
  note          text
  createdBy     uuid not null → users.id  on delete restrict
  unique (billId, effectiveFrom)
```

The bill's own `amount` remains the current amount. For a due date `d`, the
expected amount is the newest price change with `effectiveFrom <= d`, else the
bill's `amount` — and an occurrence's `overrideAmount` still beats both, because
an override is a statement about one charge and a price change is a statement
about a period. This is one table and one lookup, and it is the difference
between a forecast and a multiplication.

## 4. The forecast engine

A new pure module, `src/modules/feoh/forecast.ts`, with no database access of
its own beyond the reads it is handed:

```ts
export const PERIODS_PER_YEAR = {
  weekly: 52, monthly: 12, quarterly: 4, semiannual: 2, yearly: 1,
} as const;

/** Normalised monthly equivalent. weekly uses 52/12, NOT 4 — a weekly bill
 *  costs 4.333 monthly payments, and rounding it to four understates the year
 *  by a month. Rounded to cents for display only; sums use cents. */
export function monthlyEquivalent(amount: number, cadence: Cadence): number;

export interface ForecastBucket {
  month: string;              // YYYY-MM
  committed: number;          // sum of expected amounts due in the month
  estimated: boolean;         // true if any line is an FX estimate (§5)
  byEnvelope: { envelopeId: string | null; name: string; amount: number }[];
  lines: ForecastLine[];      // one per occurrence
}

export interface ForecastLine {
  billId: string; payee: string; dueDate: string; amount: number;
  source: 'booked' | 'override' | 'price_change' | 'bill';
  currency: string; estimated: boolean; status: OccurrenceStatus;
}
```

Rules:

1. **Input is `listOccurrences({ from, to })`.** The forecast never calls
   `projectDueDates` itself.
2. **`paid` occurrences use the booked transaction's amount** (`source:
   'booked'`) — the past is truth, not estimate, so a month that has already
   happened reconciles against the ledger.
3. **`skipped` occurrences contribute nothing** but stay visible in `lines`, so
   a member can see why a month is cheap.
4. **`overdue` counts as committed** in its own month and is flagged; a bill
   nobody paid is still owed.
5. **`cadenceUnknown` bills are listed and excluded from the total**, with an
   explicit `unforecastable` count in the response. Silently dropping them would
   understate the commitment; silently counting one occurrence would invent a
   cadence.
6. **The horizon is the caller's `to`, capped at 24 months**, reusing the
   existing cap rather than inventing a second one. Default 12 months (the
   forecast's natural unit is a year; `listOccurrences` keeps its own 6-month
   default for its own callers).
7. **Cents, not floats, for every sum**, following `ledger.ts`'s `toCents`.

## 5. Currency

Feoh has no currency column and this feature does not add one to the ledger —
ADR 0016 §7 stands. What it adds is a **declared foreign price and a
hand-maintained rate on the subscription**, used for display and forecasting
only:

- A future occurrence of a foreign-billed subscription is forecast at
  `billedAmount × fxRate`, and every line and bucket carrying such a value is
  flagged `estimated: true`. The UI says *estimate*; it does not pretend.
- A **booked** occurrence uses the transaction's household-currency amount, so
  the moment a charge lands, the estimate is replaced by what actually left the
  account. Past months are exact, future months are marked.
- `fxRateAsOf` is displayed beside the estimate, because a rate from March is a
  worse estimate in December and the household should be able to see that.
- The ledger, `recordTransaction()`, `postings` and every existing test are
  untouched. Nothing multi-currency enters the double-entry side.
- An `FxProvider` reference feed (ADR 0003's category, which already reserves a
  slot for a Feoh consumer) would replace the hand-maintained rate. It is not
  built here and needs its own ADR; the `fxRate`/`fxRateAsOf` pair is exactly
  what such a provider would later fill in, which is why it is shaped that way.

## 6. Deadlines through Weorc

Per ADR 0018, Feoh does not project anything itself. On create and on every edit
of a subscription, Feoh calls `upsertDeadline` once per date it wants surfaced:

| Subscription field | Deadline kind | Name | Default `leadDays` |
|---|---|---|---|
| `trialEndsOn` | `trial_end` | "Decide on <payee> — trial ends" | 7 |
| `cancelByOn` | `cancel_by` | "Cancel <payee> or it renews" | 21 |

- Idempotent on `(anchorBillId, kind)`: editing a date moves the routine's
  `anchorDate`, it does not add a second one.
- `termEndsOn` projects **nothing** — it is a fact about the contract, and the
  actionable date derived from it is `cancelByOn`. One date, one deadline.
- Clearing a date, or setting `cancelledOn`, deactivates the routine and closes
  its open occurrence as skipped (ADR 0018 §8).
- The routine's anchor is the bill (`anchorBillId`), so Weorc's own views can
  say where the deadline came from.

## 7. REST surface

```
GET    /api/v1/feoh/forecast?from=&to=&groupBy=month|envelope|payee
                                                  # buckets, totals, lines,
                                                  #   unforecastable count
GET    /api/v1/feoh/subscriptions                 # bill + subscription detail, with
                                                  #   monthlyEquivalent and derived status
POST   /api/v1/feoh/bills/:id/subscription        # attach/replace the detail row
DELETE /api/v1/feoh/bills/:id/subscription
GET    /api/v1/feoh/bills/:id/price-changes
POST   /api/v1/feoh/bills/:id/price-changes
DELETE /api/v1/feoh/price-changes/:id
```

`/subscriptions` is a *view over bills*, not a second collection: creating a
subscription means creating a bill and attaching a detail row, exactly as
recording a vehicle means recording an asset. `POST /feoh/bills` is unchanged.

## 8. Surfaces

- **Feoh web page, new "Forecast" tab:** committed total for the next 12 months
  as a monthly bar, the per-month breakdown by envelope, and a subscription list
  sorted by monthly equivalent — which is the screen that answers "what am I
  paying for that I forgot about".
- **Hearth View tile:** "€412 committed in the next 30 days", and any deadline
  inside its lead window ("Netflix trial ends in 3 days"). The Hearth View reads
  the forecast; it does not compute one.
- **MCP (`heorth-mcp`, ADR 0008):** `feoh.forecast`,
  `feoh.list_subscriptions`, `feoh.record_subscription`,
  `feoh.record_price_change`. No new MCP surface in Heorth.
- **i18n:** both locales, per the Phase 2 precedent. "Forecast" and
  "Subscription" are translated; "Feoh" stays untranslated.

## 9. Deferred

- **Balance projection and runway**, once expected income exists (§1).
- **An `FxProvider` reference feed** (§5), with its own ADR.
- **Subscription detection from the ingestion inbox** — `feoh_imported_transactions`
  holds a payee and a date, so a repeated payee at a regular interval is a
  candidate subscription. Genuinely valuable, and a rules-and-suggestions feature
  in its own right (ADR 0016 §3's pattern); it must not be smuggled into a
  forecast slice.
- **Price-change history as an audit trail** — today's model holds *announced
  future* changes; it does not record what a bill used to cost before someone
  edited it.
- **Per-member attribution of a subscription** (§1).

## 10. Testing

- **The nullable interval columns first** (ADR 0018 §3): every existing Weorc
  read path handles `intervalUnit IS NULL`, and a `once` routine with an interval
  set is rejected at the database.
- `advanceRoutine` on a terminal `once` occurrence: routine deactivated, no
  successor row, one-open-occurrence index never contended.
- `monthlyEquivalent`: weekly uses 52/12 and a year of weekly bills sums to
  52 payments, not 48.
- Precedence: `overrideAmount` beats a price change, which beats the bill amount;
  a booked occurrence beats all three.
- Price-change boundary: an occurrence *on* `effectiveFrom` uses the new amount.
- Month-end clamping is `cadence.ts`'s and is asserted through the forecast for a
  bill anchored on the 31st.
- A skipped occurrence contributes zero and is still listed; an overdue one
  counts in its own month.
- `cadenceUnknown` bills appear in `unforecastable` and not in any total.
- Currency: a foreign-billed future occurrence is `estimated: true`; the same
  occurrence once booked is `estimated: false` and equals the transaction amount.
- Deadline upsert is idempotent across two edits; clearing the date skips the
  open occurrence; deleting the bill leaves the routine with a null anchor.
- Horizon: `to` beyond 24 months is capped, and a touched occurrence outside the
  horizon still appears (the existing off-schedule rule).

## Open questions

1. **Does the household want the forecast to include `recurring_bills` that are
   not subscriptions** — rent, insurance, the mortgage — or only the
   subscription-shaped ones? The engine treats every bill alike, which is the
   more useful answer ("what am I committed to") and makes the Hearth View number
   large. A filter is trivial; the *default* is a product decision.
2. **Default forecast horizon: 12 or 24 months?** 12 is proposed. A yearly bill
   makes 24 more informative and the bar chart harder to read.
3. **Should `cancelByOn` be derived from `termEndsOn` plus a notice period**
   rather than entered? Deriving it is friendlier and encodes a rule the contract
   states; entering it is honest about the fact that notice rules are weirder
   than "three months". Proposed: enter it, and revisit once a few real contracts
   are in.
4. **What happens to a deadline when the household ignores it?** The occurrence
   goes overdue and stays open — Weorc's normal behaviour — but for a trial that
   already converted, the useful thing is to close it and update the bill amount.
   That is a Feoh action on a Weorc row, which ADR 0018 §6 forbids in that
   direction. Likely answer: Feoh clears its own date, and the retraction path in
   ADR 0018 §8 does the rest. Confirm when the page is designed.
