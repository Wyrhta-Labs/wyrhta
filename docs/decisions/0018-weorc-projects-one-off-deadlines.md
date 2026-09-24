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
   leadDays, nudgeEveryDays, notes })` is idempotent on
   `(anchorBillId, kind)`, so editing a trial-end date moves the deadline
   instead of accumulating them — and the consumer supplies `name` and `notes`,
   which are what the projected task's title and body are, because the money in
   them is Feoh's fact to format and not Weorc's to look up. A second,
   equally narrow call — `completeDeadline(anchorBillId, kind)` — lets a Feoh
   action close a deadline it has just satisfied (the household confirming a
   post-trial price), still through Weorc's service and its invariants. One
   writer per table, which is what keeps the module seam a seam.
8. **Clearing the fact retracts the deadline.** Removing the trial-end date, or
   marking the subscription cancelled, deactivates the routine and closes its
   open occurrence as `skipped` — which is the existing terminal path, so the
   projection pass handles the Task exactly as it already does for a skipped
   chore. Nothing new about task retraction is decided here; whatever Weorc does
   today for a skipped occurrence is what happens.
9. **An ignored deadline keeps nudging, and `skip` is how you stop it.** A
   cancel-by date that goes quiet the moment it passes is worse than no
   reminder, because the household will believe it was handled. So while a
   one-off's occurrence is open and overdue, the tick **re-asserts it** every
   `nudgeEveryDays` — a new field on the routine, `NULL` by default, so every
   routine shipped today keeps its current behaviour and only deadlines opt in.
   The occurrence carries `lastNudgedAt` and `nudgeCount`, which is what makes
   the cadence a cadence rather than an hourly tick spamming a task list.
   Nudging stops on exactly two things: the occurrence goes terminal, or Feoh
   clears the underlying date (§8). **Completing it means it was dealt with;
   skipping it means "stop asking" — and the household needs the second one, or
   the only way to silence a deadline it has decided to ignore is to lie about
   having done it.**
10. **Re-asserting needs one new method on `TaskProvider`, and that is the real
    price of §9.** The interface today is `listAvailableLists`, `pullChanges`,
    `setCompleted` and `createTask` — it can create a task and complete one, and
    it cannot change one. Three ways to nudge without it were considered and
    rejected: creating a second task each round (the inbox fills with
    duplicates); creating a new one and `setCompleted` on the old (it would
    write "done" into the household's task history for work nobody did, and the
    reconcile pass reads a completed task as a completion — so the lie would
    also terminate the deadline); and nudging only inside Heorth's own screens
    (which abandons the reason this ADR exists — the household's inbox is where
    work is seen). So `TaskProvider` gains its first new method since it
    shipped. Graph supports it (`PATCH` on a To Do task); a provider that cannot
    reschedule throws the classified `provider_unavailable` it already has, and
    the nudge degrades to Heorth's own surfaces rather than failing the tick.
    **The method is `amendTask(feedKey, externalId, { dueAt?, title?, notes? })`,
    not a bare reschedule.** Since the interface is growing anyway and the
    provider call is one PATCH either way, it costs nothing to let the amend
    carry text — and it buys the fix for §11's staleness problem, which a
    due-date-only method would have left unsolved.
11. **The nudge is a fourth pass, rate-limited by data rather than by the tick —
    and the same pass keeps a projected task's text true.**
    `runWeorcTick` runs hourly; the pass selects open, **already-projected**
    occurrences and does up to two things to each:
    - **Nudge**, when the occurrence is overdue, its routine sets
      `nudgeEveryDays`, and `lastNudgedAt` is older than that: amend the task's
      `dueAt` to today and stamp `lastNudgedAt` / `nudgeCount`.
    - **Refresh**, when the routine's `updatedAt` is newer than the occurrence's
      new `projectedTextAt`: amend the task's `title` and `notes` to the
      routine's current text and stamp `projectedTextAt`.
    The second half exists because a task is written once at projection and then
    outlives the facts behind it. A trial-end task that says "then €13.99" after
    the price was corrected to €14.99 is worse than one that says nothing —
    the household acts on the number in its inbox. A nudge round sends the
    current text anyway, so the two halves share one call whenever both apply.
    Nothing else about the existing three passes changes.
12. **No new engine, no new tick, no new provider.** Same `runWeorcTick`, same
    projection, same single task provider — one pass and one provider method
    added, both in the existing shapes. That is the whole point: this ADR
    *spends* ADR 0014's engine rather than adding to the estate.

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
- **A provider interface grew, which is a cost ADR 0001 asked us to notice.**
  `amendTask` must exist in every future task provider — Google Tasks,
  CalDAV, the partner project — or that provider silently cannot nudge. It is
  one method, it is PATCH-shaped in every API of this kind, and the degradation
  path is the classified error the interface already carries; but the 2.0
  provider matrix is one method wider than it was.
- **An overdue deadline now writes to the task provider on a schedule.** A
  household that ignores one for a month gets its task's due date moved ten
  times at `nudgeEveryDays = 3`. That is the intended behaviour and also the
  first time Weorc touches a projected task after creating it — so the write
  path that was create-only is now create-and-amend, and a provider outage
  during a nudge round is a classified failure that simply retries next tick.
- **A projected task is no longer written once and forgotten.** Editing a
  routine's name now reaches an already-created task on the next tick, for every
  routine and not only for deadlines — a behaviour change for chores too, and the
  right one: a renamed chore whose task keeps the old title is a bug nobody had
  got round to reporting. The cost is `projectedTextAt` on every occurrence and
  one more reason the tick writes to the provider.
- **`skip` acquires a second meaning, and it is the honest one.** On a chore it
  means "not this time"; on a deadline it means "stop asking me". Both are
  terminal, both keep the row as history, and the UI has to word the button
  differently for a one-off — a small cost for not forcing the household to
  mark undone work as done.
- **The nullable interval columns are one more shape a routine can have.** Every
  read path that assumed an interval exists must now handle its absence — the
  cost of §3 being honest rather than convenient, and the reason the spec's test
  list opens with it.
