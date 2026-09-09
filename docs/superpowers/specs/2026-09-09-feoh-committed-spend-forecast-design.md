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
- **Every recurring bill, not only the subscription-shaped ones** — rent,
  insurance and the mortgage are commitments too, and a forecast that omits them
  answers a smaller question than the household asked. Narrowing is the reader's
  job, not the engine's: the forecast takes a **multiselect category filter**
  (§5).
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
- **No live FX** (§6). **No income, no salary, no variable-cost estimation.**
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
  noticeCount   integer                    -- notice period, e.g. 3
  noticeUnit    text                       -- 'day' | 'week' | 'month'
  cancelledOn   date                       -- set when the household cancelled
  notes         text
```

**`cancelByOn` is not a column — it is derived** (resolved 2026-09-09):
`cancelBy = shift(termEndsOn, −noticeCount, noticeUnit)`, using the same
day-of-month clamping `cadence.ts` already applies. That clamp is what makes the
common German contract come out right without a special case: a term ending
**31 December** with **3 months'** notice derives **30 September**, because
September has thirty days. Storing the date instead would let it fall out of
step with the term end the moment a contract is extended.

Constraints:

- CHECK: `(billedCurrency IS NULL) = (billedAmount IS NULL)` and
  `(billedAmount IS NULL) OR (fxRate IS NOT NULL)` — a foreign amount without a
  rate cannot be forecast, so the schema refuses it rather than guessing 1.0.
- CHECK: `billedAmount > 0`, `fxRate > 0`, `noticeCount > 0`.
- CHECK: `(noticeCount IS NULL) = (noticeUnit IS NULL)`, and a notice period
  requires `termEndsOn` — a notice with nothing to count back from derives
  nothing, so the schema refuses the pair rather than storing a dead fact.
- **The limitation, stated rather than discovered later:** a notice rule that is
  not "term end minus a period" — "by the 15th of the preceding month", notice
  tied to a quarter end — cannot be expressed. The household sets a notice
  period that makes the derived date land on or before the real one and records
  the actual wording in `notes`. An explicit override column would fix it and is
  deferred (§10), because one date entered by hand is exactly what deriving was
  chosen over.
- **Where the arithmetic lives:** `shift(date, count, unit)` for `day | week |
  month` with `cadence.ts`'s clamping rule. Weorc's `recurrence.ts` already has
  equivalent month arithmetic, so at implementation time this either imports
  that or both move to `src/lib/` — **it is not copied**. A second month-clamping
  implementation in the same database is how two modules start disagreeing about
  what "three months before 31 March" means.
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
  committed: number;          // sum of expected amounts due in the month, AFTER the filter
  householdCommitted: number; // the same month unfiltered — see §5
  estimated: boolean;         // true if any line is an FX estimate (§6)
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
6. **The horizon is the caller's `to`, capped at 24 months, and 24 months is
   also the default** (resolved 2026-09-09). A yearly bill appears twice, which
   is what makes an annual commitment legible beside a monthly one — the reason
   to prefer it over twelve. Two consequences follow and are handled rather than
   discovered: the default now equals the cap, so the cap only ever bites a
   caller asking for more (and still answers, capped, rather than erroring); and
   twenty-four bars need a chart that survives a phone, so the page offers a
   12/24 toggle with 24 selected (§9). `listOccurrences` keeps its own 6-month
   default for its own callers — this default belongs to the forecast, not to the
   engine underneath it.
7. **Cents, not floats, for every sum**, following `ledger.ts`'s `toCents`.

## 5. The category filter (multiselect)

**The category is the envelope.** Feoh already groups spending into `envelopes`
(name, monthly budget, tone) and `recurring_bills.envelopeId` already points at
one. A `category` column on a bill would be a second taxonomy that starts
agreeing with the envelope and stops within a month — so there is none, and
"select categories" means "select envelopes".

The rules, because a filter that quietly changes what a total means is worse
than no filter:

1. **Absent means all.** No filter parameter is the default, and the default is
   every recurring bill — subscriptions, rent, insurance, the mortgage. This is
   the household's answer to what a forecast is *for*.
2. **The parameter is one comma-separated list**, `envelopes=<uuid>,<uuid>,none`,
   where the sentinel **`none` selects bills with no envelope**. An unbudgeted
   bill is exactly the kind a household forgets, so it must be selectable rather
   than invisible.
3. **An empty list is rejected** (`400`), never silently read as "all" or as
   "nothing". `envelopes=` is a bug in the caller, and guessing which of the two
   opposite meanings was intended is how a wrong number reaches a wall display.
4. **Every bucket carries both totals.** `committed` is filtered;
   `householdCommitted` is the same month with no filter applied. A filtered
   view can therefore always say "€180 of €412", and no screen can accidentally
   present a partial number as the household's whole commitment.
5. **`unforecastable` respects the filter too**, so the count beside a filtered
   total describes the filtered set.
6. **The filter matches the *bill's* envelope, always — including for booked
   occurrences.** A member who books a charge against a different envelope by
   hand makes the ledger and the forecast disagree for that line, and the
   forecast follows the bill. Accepted deliberately: the forecast is about the
   *commitment*, which is the bill's fact, and following postings instead would
   make a line enter and leave the filter depending on how somebody booked it.
   The ledger remains the truth about what happened; this view is about what is
   owed.
7. **Filtering and grouping are independent.** `groupBy=envelope` on a filtered
   forecast groups what survived the filter; neither implies the other.
8. **The selection lives in the URL, not on the server.** It is a query
   parameter the web page keeps in its route (and in the client only), so a
   filtered forecast is bookmarkable and can be pinned on the wall display.
   Server-side saved views are deferred (§10) — they need a settings table and
   nothing yet earns it.
9. **The Hearth View tile always uses the unfiltered total.** A glanceable
   number that silently excludes the mortgage is a lie by omission. Filtering is
   a thing you do while looking at the Feoh page on purpose.

## 6. Currency

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

## 7. Deadlines through Weorc

Per ADR 0018, Feoh does not project anything itself. On create and on every edit
of a subscription, Feoh calls `upsertDeadline` once per date it wants surfaced:

| Date | Deadline kind | Name | `leadDays` | `nudgeEveryDays` |
|---|---|---|---|---|
| `trialEndsOn` | `trial_end` | "Decide on <payee> — trial ends" | 7 | 2 |
| derived cancel-by (§3) | `cancel_by` | "Cancel <payee> or it renews" | 21 | 3 |

- Idempotent on `(anchorBillId, kind)`: editing a date moves the routine's
  `anchorDate`, it does not add a second one. **The derived cancel-by moves when
  either `termEndsOn` or the notice period changes** — deriving the date means
  Feoh must re-upsert on both edits, which is a save-path detail worth a test
  rather than a comment.
- `termEndsOn` projects **nothing** of its own — it is a fact about the
  contract, and the actionable date derived from it is the cancel-by. One
  actionable date, one deadline.
- Clearing a date, or setting `cancelledOn`, deactivates the routine and closes
  its open occurrence as skipped (ADR 0018 §8).
- **Ignoring one does not silence it** (ADR 0018 §9): while the occurrence is
  open and overdue, the tick moves its task's due date to today every
  `nudgeEveryDays`. The nudge is tighter for a trial (2 days) than for a
  cancel-by (3), because a trial that converts costs money on a date nobody can
  move, while a missed cancel-by has usually already cost the year. It stops
  when the occurrence is completed or **skipped** — skipping is the household's
  "stop asking", and the Feoh page must offer it in those words, not as "done".
- The routine's anchor is the bill (`anchorBillId`), so Weorc's own views can
  say where the deadline came from.

## 8. REST surface

```
GET    /api/v1/feoh/forecast?from=&to=&groupBy=month|envelope|payee
                             &envelopes=<uuid>,<uuid>,none
                                                  # buckets, filtered + household
                                                  #   totals, lines,
                                                  #   unforecastable count (§5)
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

## 9. Surfaces

- **Feoh web page, new "Forecast" tab:** committed total for the next **24
  months** as a monthly bar, with a 12/24 toggle (24 default, §4.6), the per-month breakdown by envelope, and a bill list sorted
  by monthly equivalent — which is the screen that answers "what am I paying for
  that I forgot about". Above it, an **envelope multiselect** (§5) with an
  *Unbudgeted* entry for `none`, all selected by default, showing "€180 of €412"
  whenever the selection is partial so the filtered number is never mistaken for
  the whole.
- **Hearth View tile:** "€412 committed in the next 30 days", and any deadline
  inside its lead window ("Netflix trial ends in 3 days"). An **overdue**
  deadline escalates its treatment the longer it is ignored — `nudgeCount` is
  on the occurrence for exactly this, so the wall display can get louder without
  computing anything. The Hearth View reads the forecast; it does not compute
  one.
- **MCP (`heorth-mcp`, ADR 0008):** `feoh.forecast`,
  `feoh.list_subscriptions`, `feoh.record_subscription`,
  `feoh.record_price_change`. No new MCP surface in Heorth.
- **i18n:** both locales, per the Phase 2 precedent. "Forecast" and
  "Subscription" are translated; "Feoh" stays untranslated.

## 10. Deferred

- **Balance projection and runway**, once expected income exists (§1).
- **An `FxProvider` reference feed** (§6), with its own ADR.
- **Subscription detection from the ingestion inbox** — `feoh_imported_transactions`
  holds a payee and a date, so a repeated payee at a regular interval is a
  candidate subscription. Genuinely valuable, and a rules-and-suggestions feature
  in its own right (ADR 0016 §3's pattern); it must not be smuggled into a
  forecast slice.
- **Price-change history as an audit trail** — today's model holds *announced
  future* changes; it does not record what a bill used to cost before someone
  edited it.
- **An explicit cancel-by override** (§3), for a contract whose notice rule is
  not "term end minus a period". Additive: a nullable date column that wins over
  the derivation when set. Not built, because it is precisely the hand-entered
  date deriving was chosen over, and one real contract that needs it is a better
  reason than a hypothetical.
- **Server-side saved forecast views** (§5.8) — a named envelope selection
  shared across members and devices. Needs a settings table; the URL carries the
  selection until something concretely needs more.
- **A "subscriptions only" filter.** Trivially expressible once §5 exists (the
  detail row is the predicate), and deliberately not added as a second axis
  until somebody wants it.
- **Per-member attribution of a subscription** (§1).

## 11. Testing

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
- `cadenceUnknown` bills appear in `unforecastable` and not in any total, and
  the count follows the filter.
- **The derived cancel-by**: 31 December with 3 months' notice derives
  30 September (the clamp, §3); 6 weeks' notice derives by weeks; a notice
  period without `termEndsOn` is rejected at the database; changing *either*
  `termEndsOn` or the notice period moves the deadline routine.
- **The default horizon is 24 months** with no `to`, and `to` beyond 24 is
  capped rather than rejected.
- **Nudges**: an overdue deadline reschedules its task after `nudgeEveryDays`
  and not before; `lastNudgedAt`/`nudgeCount` advance once per round, not once
  per hourly tick; **skip stops the nudges** and completion stops them; a
  provider without `rescheduleTask` degrades to `provider_unavailable` and the
  tick still succeeds (ADR 0018 §10).
- The filter: an absent parameter returns every bill; `envelopes=` is a 400;
  `none` returns exactly the bills with no envelope; `committed` reflects the
  selection while `householdCommitted` does not move; a booked occurrence whose
  transaction was re-enveloped by hand still filters by its **bill's** envelope
  (§5.6).
- Currency: a foreign-billed future occurrence is `estimated: true`; the same
  occurrence once booked is `estimated: false` and equals the transaction amount.
- Deadline upsert is idempotent across two edits; clearing the date skips the
  open occurrence; deleting the bill leaves the routine with a null anchor.
- Horizon: `to` beyond 24 months is capped, and a touched occurrence outside the
  horizon still appears (the existing off-schedule rule).

## Open questions

1. ~~Does the household want the forecast to include `recurring_bills` that are
   not subscriptions?~~ **Resolved 2026-09-09: all of them, with a multiselect
   category filter.** Rent, insurance and the mortgage are commitments and the
   forecast covers them by default; the reader narrows by **envelope** — the
   category Feoh already has, so no `category` column is added (§5). The Hearth
   View number is therefore the household's whole commitment, which is the point
   of it, and every filtered response carries the unfiltered total beside the
   filtered one so a partial view cannot masquerade as the total.
2. ~~Default forecast horizon: 12 or 24 months?~~ **Resolved 2026-09-09: 24,
   and it is also the cap.** A yearly bill shows up twice, which is what makes
   an annual commitment legible beside a monthly one. The chart pays for it with
   a 12/24 toggle (§4.6, §9).
3. ~~Should `cancelByOn` be derived from `termEndsOn` plus a notice period?~~
   **Resolved 2026-09-09: derived.** The subscription stores a notice period
   (`noticeCount`, `noticeUnit`) and the cancel-by date is computed, so it cannot
   fall out of step with an extended term. The known gap — notice rules that are
   not "term end minus a period" — is handled by choosing a period that lands on
   or before the real date and writing the wording into `notes`; an override
   column is deferred (§10).
4. ~~What happens to a deadline when the household ignores it?~~ **Resolved
   2026-09-09: the nudges come back.** While the occurrence is open and overdue,
   the tick reschedules its task every `nudgeEveryDays` (2 for a trial end, 3
   for a cancel-by) and the Hearth View escalates on `nudgeCount`. It ends on
   completion or on **skip**, which is the household's "stop asking" and must be
   worded that way — ADR 0018 §9. The cost is real and recorded there: the task
   provider interface gains `rescheduleTask`, its first new method since it
   shipped, because the shipped interface can create a task and complete one but
   not change one.
5. **Does the trial-end deadline need to know what happens after it?** A trial
   that converts changes the bill's amount, and the household will want the
   forecast to be right the day after. Nothing here updates an amount
   automatically, and nothing should guess one; the open part is whether the
   trial-end task's wording should carry the future price ("becomes €13.99/mo on
   4 Oct") so the member can act on it without opening Heorth. Cheap, and worth
   deciding with the page in front of us.
