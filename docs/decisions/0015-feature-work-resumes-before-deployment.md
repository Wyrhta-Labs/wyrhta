# 0015 — Feature work resumes before deployment

**Status:** accepted 2026-08-24

## Context

`strategy.md` Phase 3 ends with a flat rule: **"Feature work does not resume
until deployed."** It was written when the phase order was the whole plan, and it
is a good rule — it exists so that real use, not a roadmap, decides what gets
built next.

Three things have since made it the wrong rule to hold this month.

- **The deployment gate is not code-shaped.** Phase 2 is code-complete and paused
  at its exit criterion, which is spouse acceptance. What is left in
  `docs/manual-todo.md` is human: the `ApplicationAccessPolicy` PowerShell in the
  real tenant, the first-live-run smoke checklist, **buying the Pi and the
  touchscreen**, and secret rotation at deployment. None of it is unblocked by
  waiting, and none of it goes faster because no features are being written.
- **The household story is thin at exactly the point acceptance is judged.** What
  the stack does today is calendars, tasks, meals, library, finance and an asset
  list. The recurring work of running a house — the chores — is the thing a
  household notices the absence of first, and it is unbuilt: Weorc holds a name,
  a glossary entry and no code (ADR 0014). Deploying, then discovering that the
  first request is the one domain that does not exist, spends the acceptance
  window badly.
- **The prerequisite chain runs the other way.** Chores need something to hang
  on: the asset register (still named `inventory`), the place tree, and the
  building's systems. That is Phase 4's Ethel v1 — so the shortest path to a
  household that is worth accepting goes *through* feature work, not after it.

## Decision

**Phase 3 (deployment) is deferred behind Ethel v1 and Weorc's first slice. The
"no feature work until deployed" rule is retired, not suspended.**

1. **Order.** Ethel v1 (Parts A–C: the rename, places, vehicles, facilities) →
   Weorc's first slice (the routine, its completion history, the projection into
   the task provider) → Phase 3 deployment. Phase 4's slice D, service contacts,
   stays gated on ADR 0002 Phase B and is not pulled forward.
2. **The rule is replaced, not merely paused.** The sentence "Feature work does
   not resume until deployed" comes out of `strategy.md`. What survives it is the
   *reason* it was written: **real use reprioritises everything after Phase 3.**
   That claim is untouched — the reordering happens once, before deployment, and
   does not license a second reordering after it.
3. **The human deployment steps are not deferred.** `manual-todo.md` items that
   can be done in parallel — the tenant policy, the Pi purchase — stay open work
   and should be done while the feature work runs. Deferring the phase defers the
   bring-up, not the shopping.
4. **The demo stack carries the validation burden in the meantime.** With no live
   household, `compose.demo.yml` and `seed-demo.mjs` (ADR 0012) are the only
   configuration exercising every service together, so both Ethel v1 and Weorc
   treat the seeded demo household as their acceptance check, and the seed grows
   with each of them.
5. **One re-read of the gate before deployment.** When Weorc's first slice lands,
   Phase 3 resumes from `manual-todo.md` as written — no new gate, no further
   feature slice ahead of it. If a third domain looks necessary at that point,
   that is a new decision and needs its own ADR, precisely because this one is
   the kind that is easy to take twice.

## Consequences

- **The stack ships later, and the learnings arrive later.** Everything Phase 3
  was supposed to teach — what breaks in the homelab, what the household actually
  opens every day, which mirrors are wrong — is postponed by the length of two
  slices. That is the whole cost, and it is a real one.
- **Two domains will be built without real-use evidence.** Ethel v1 has a design
  hardened over two ADRs, so the risk there is small. Weorc's is larger: which
  chores a household wants projected is exactly what ADR 0014 says real use
  should decide, and it will now be decided by one maker guessing. Weorc's first
  slice must therefore stay narrow enough to be cheap to be wrong about.
- **The rule that protected the roadmap is gone.** Retiring "no feature work
  until deployed" removes the mechanism that kept the plan honest about
  sequencing. §5 is the replacement, and it is weaker: a note in an ADR rather
  than a line in the strategy. Anyone reading this later should treat a *second*
  pre-deployment slice as the signal that the roadmap has stopped being a plan.
- **Deployment gets easier, not harder — and that is worth stating.** Two more
  modules and five more tables land before first bring-up, but they land on an
  *empty* database. The Ethel rename was specced with a page of procedure to
  protect live household rows — read the emitted SQL, replace drop-and-create with
  `ALTER … RENAME`, gate it behind a preservation test, rehearse on a dump. With
  deployment moved behind it, none of that is needed and all of it is deleted
  (ADR 0013, Amendments 2). The first deployment carries a longer migration chain
  against a fresh cluster, which is the cheap direction.
- **The corollary is a standing rule for everything that follows.** Any further
  schema change that lands before Phase 3 may be a drop-and-create. The moment the
  household database is real, that stops being true, and the deleted procedure has
  to come back out of git history.
- **The honesty constraint on the website tightens.** Ethel and Weorc will exist
  in the repo before the household runs on them. Anything the site says about
  them stays in the planned column until Phase 3 is done, per the shipped/planned
  rule in `AGENTS.md`.
