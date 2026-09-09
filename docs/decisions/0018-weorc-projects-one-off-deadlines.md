# 0018 — Weorc projects one-off deadlines; Feoh's subscription dates are the first consumer

**Status:** proposed (2026-09-09)

## Context

Feoh's committed-spend forecast (spec:
[2026-09-09-feoh-committed-spend-forecast-design](../superpowers/specs/2026-09-09-feoh-committed-spend-forecast-design.md))
needs two dates that are not recurring and are not optional:

- **A trial end.** "This is free until 4 October, then it is €13.99 a month."
  The household's money depends on somebody acting *before* that date.
- **A cancel-by date.** A minimum-term contract with three months' notice has a
  date after which the household is committed for another year whether it wants
  to be or not.

Both are the same shape: a dated obligation that exists because of a household
fact, that happens **once**, and that is worthless if nobody is told in time.

[ADR 0014](0014-weorc-owns-recurring-household-work.md) §3 defines a Weorc
routine as "a recurring definition (schedule or interval)", and §6 insists
"Weorc does not become a task system" — the external task service stays the
System of Record for everyday Tasks. A one-off deadline sits exactly on that
line, so it gets decided rather than smuggled in.

Four ways out were considered:

1. **Feoh projects its own reminder into the task provider.** Rejected: a second
   projector into the same provider is the precise thing ADR 0014 exists to
   prevent, and the second one always diverges from the first.
2. **Show it on the Feoh page and nowhere else.** Honest and cheap, and it was
   the first proposal — but a forecast whose most actionable fact ("cancel this
   in three days") lives only on a page nobody opened is a worse product than one
   that reaches the household's task inbox. Rejected on those grounds, which are
   the household's grounds, not the architecture's.
3. **Model the deadline as a routine with a very long interval.** Rejected: it
   is a lie that comes true. A trial that ends once would silently reappear a
   year later, and the row would claim a recurrence the household never agreed
   to.
4. **Weorc gains a one-off mode.** Chosen.

A read of the shipped module says (4) is close to free, which is the argument
that settles it. `weorc_routines` already carries `mode`, `anchorDate`,
`leadDays` and `active`; `weorc_occurrences` already enforces **at most one open
occurrence per routine** with a partial unique index, already has terminal
statuses, and already carries the `taskFeedKey`/`taskExternalId` pair and
`projectionError`. A one-off is a routine whose first occurrence is its last. The
engine's three passes — reconcile, advance, project — need one change, in
`advanceRoutine`.

## Decision

**Weorc gains a one-off mode. A deadline is a routine with exactly one
occurrence, projected through the same engine, and Feoh is its first consumer —
not its owner.**

1. **`mode = 'once'`**, beside `fixed` and `from_completion`. `anchorDate` is the
   due date. `leadDays` keeps its meaning and matters more here than anywhere
   else: a cancel-by date that reaches the task inbox on the morning it expires
   is not a reminder.
2. **The boundary rule, so this door does not keep swinging.** Weorc owns work
   whose **existence is derived from a household fact it holds** — a service
   interval, a trial that started, a contract term — whether that work repeats or
   not. It does not own work a member simply thought of; "buy milk" is authored
   in the task provider and stays there. ADR 0014 §6 is therefore narrowed in
   wording and unchanged in intent: the test was never *recurrence*, it was
   *provenance*, and this ADR says so out loud.
3. **The interval columns become nullable and are null exactly when
   `mode = 'once'`.** `intervalUnit` and `intervalCount` are `NOT NULL` today
   with `count > 0`; a one-off has no interval, and filling those columns with a
   placeholder would leave a value that reads as meaningful. The CHECK becomes
   `(mode = 'once') = (interval_unit IS NULL)`, with the unit and count checks
   applying only when it is set. Relaxing NOT NULL is a migration-safe
   direction.
4. **`advanceRoutine` never advances a `once` routine.** When its occurrence
   goes terminal — completed or skipped — the routine sets `active = false` and
   no successor is materialised. The one-open-occurrence index already makes the
   invariant structural; this makes the engine agree with it.
5. **A new anchor kind: `anchorBillId → recurring_bills.id`, `on delete set
   null`** — the same referential choice the asset and place anchors already
   make, for the same reason ("deleting the boiler must not delete the record of
   having serviced it"). The anchors stay mutually exclusive; the existing CHECK
   grows a term. A deadline therefore says which subscription it came from, and
   survives that subscription's deletion as history.
6. **The dependency direction is Weorc → Feoh, and only that way.** It is the
   same shape as Weorc → Ethel, which ADR 0014 §5 already established: an anchor
   points out of Weorc at another module's row, and nothing points back. Feoh
   holds **no** reference to a routine or an occurrence.
7. **Feoh writes deadlines through one Weorc service call, never through
   `weorc_*` tables.** `upsertDeadline({ anchorBillId, kind, name, dueOn,
   leadDays })` is idempotent on `(anchorBillId, kind)`, so editing a trial-end
   date moves the deadline instead of accumulating them. One writer per table,
   which is what keeps the module seam a seam.
8. **Clearing the fact retracts the deadline.** Removing the trial-end date, or
   marking the subscription cancelled, deactivates the routine and closes its
   open occurrence as `skipped` — which is the existing terminal path, so the
   projection pass handles the Task exactly as it already does for a skipped
   chore. Nothing new about task retraction is decided here; whatever Weorc does
   today for a skipped occurrence is what happens.
9. **No new engine, no new tick, no new provider.** Same `runWeorcTick`, same
   three passes, same single projection into the task provider. That is the whole
   point: this ADR *spends* ADR 0014's engine rather than adding to the estate.

## Consequences

- **ADR 0014 §3's "recurring definition" is widened, once, on purpose.** The
  boundary rule in §2 is what pays for it: without a stated test, the next
  dated thing anyone wants would arrive with the same argument, and Weorc would
  become the task list ADR 0014 refused to build.
- **The extension is not Feoh-specific, which is why it is worth making.**
  Wyrtgeard will want "sow by 15 April" and a frost date — dated, derived from a
  household fact, once. Had this been built as a Feoh reminder, that domain would
  have needed its own, and the estate would hold two.
- **Weorc now depends on a Feoh table.** Both are built-in modules in one
  database, so the cost is ordering inside a single migration rather than a
  cross-service contract — but the direction is now Weorc → Ethel *and*
  Weorc → Feoh, and a reader of `weorc_routines` has to know both.
- **A one-off leaves an inactive row behind forever.** That is the record that
  the trial existed and was dealt with, and it is the same trade Weorc already
  makes for completion history. Nothing prunes it.
- **The forecast page and the task inbox can disagree for one tick.** A date
  edited in Feoh reaches the provider on the next `runWeorcTick`, not on save.
  Acceptable, and the same latency every other Weorc projection has.
- **A member can still delete the Task in the provider**, and reconcile treats it
  as it treats any other vanished Task. This ADR adds no new failure mode there,
  and no new state to explain.
- **The nullable interval columns are one more shape a routine can have.** Every
  read path that assumed an interval exists must now handle its absence — the
  cost of §3 being honest rather than convenient, and the reason the spec's test
  list opens with it.
