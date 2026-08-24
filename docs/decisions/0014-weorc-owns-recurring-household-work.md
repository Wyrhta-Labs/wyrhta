# 0014 — Weorc owns recurring household work; Ethel owns the property

**Status:** accepted 2026-08-24

## Context

Recurring household work has no name and two half-homes.

`CONTEXT.md` lists **Maintenance Plan** as "a Heorth-native definition of
recurring upkeep for The Home (interval, completion history, links to manuals)"
that "projects due work outward as Tasks", and anchors it in **Ethel** — the
physical property domain. The same glossary tells us to _avoid_ the word
**"chore"** under **Task**, on the grounds that it is ambiguous. So the domain
that a household would call "the chores" is currently expressible only as an
Ethel feature, and the plainest word for it is banned.

That was correct while the only recurring work in view hung off an appliance.
It stops being correct as soon as the rest of the roadmap is read:

- **Most household recurring work has no asset.** Laundry, bins, cleaning,
  watering, changing the bedding. None of these are properties of a boiler, and
  Ethel is — by ADR 0013 — a register of durables and places. Modelling "put the
  bins out" as an asset's maintenance plan would put a row in `ethel_assets`
  for something that is not a thing the household owns.
- **A second projector is already scheduled.** Wyrtgeard's planting calendar
  (`strategy.md` Phase 5+) needs exactly the machinery Maintenance Plans need:
  a definition that recurs, a completion history, and a projection into the task
  provider. Built inside Ethel, that machinery is unreachable from the garden and
  gets written twice.
- **`strategy.md` reads as if the whole domain were out of scope.** The
  out-of-scope list says "Kids'-chores features (children are out of the
  house)". What is out of scope is the *kids* angle — assignment rotation,
  points, allowances. The household's own recurring work is not out of scope;
  it is the thing Maintenance Plans were a first slice of.

Nothing is built yet. ADR 0013 records that nothing named `maintenance` exists
in Heorth's `src/` (the matches are the maintenance-*admin* quarantine), so this
is a naming and boundary decision taken before the code exists, at the cost of
an edit to four documents.

## Decision

**The recurring-work domain is named Weorc, and it is a peer of Ethel, not a
feature of it.**

1. **The name is Weorc** (OE *weorc* — work, labour), following the
   one-Old-English-word convention of Heorth, Feoh, Ethel and Wyrtgeard. It
   carries **no rune**, unlike Feoh ᚠ, Ethel ᛟ and Ger ᛄ: the futhorc has no
   *weorc* rune and asserting one would be decoration dressed as etymology.
   *Dægweorc* ("a day's work", via rune ᛞ *dæg*) and *Nyd* (ᚾ, "necessity") were
   considered and rejected — the first is two syllables longer for no added
   meaning, the second is unguessable from the name.
2. **"Chore" is no longer avoided — it is the gloss.** `CONTEXT.md`'s
   _Avoid: chore_ under **Task** is reversed: "chore" is the plain-English word
   for what Weorc holds, and it is the right word in a sentence explaining the
   module. **Weorc** remains the proper name in code, API paths and UI, shown
   untranslated in both locales, following Feoh and Ethel.
3. **Weorc owns the routine.** One entity — a recurring definition (schedule or
   interval), its completion history, and the projection of the next due
   occurrence into the task provider. **One projection engine for the whole
   household**, not one per consuming domain.
4. **Maintenance Plan becomes a Weorc routine with an Ethel anchor.** Ethel keeps
   the asset and place register and the upkeep *facts* that are properties of a
   thing — manuals, warranty, the stated service interval. The routine that turns
   "yearly" into something a member sees lives in Weorc and references the asset.
   Phase 4's slice C is therefore **Weorc's first slice, delivered during Ethel
   v1**; service contacts (slice D) hang off Weorc routines rather than off
   maintenance plans in Ethel.
5. **The anchor is a nullable reference, not a subtype.** A routine may anchor to
   an Ethel asset, an Ethel place, later a Wyrtgeard bed, or to nothing at all.
   "Descale the kettle" and "put the bins out" are the same kind of row with a
   different anchor, and an unanchored routine is the normal case, not a
   degenerate one.
6. **Weorc does not become a task system.** ADR 0001 stands: the external task
   service remains the System of Record for everyday Tasks. Weorc owns the
   *definition* and the *history* of household-native recurring work; the visible
   instance a member ticks off is a Task in the provider. Weorc reads completions
   back to keep its history, and never becomes the place you look for today's
   list — that is Hearth View, over Tasks.
7. **Kids'-chore mechanics stay out of scope.** No points, no allowances, no
   assignment rotation as a product feature (children are out of the house). A
   routine may name an owning member; that is the whole of it.
8. **Weorc is a built-in Heorth module, never a satellite** — `src/modules/weorc/`,
   `weorc_*` tables, `/api/v1/weorc/...`, and `weorc.*` tools in `heorth-mcp` per
   ADR 0008. It is the domain most entangled with Tasks, Ethel and Hearth View at
   once, which is precisely the shape ADR 0007 says not to extract.

## Consequences

- **A Phase 4 deliverable is renamed before it exists, for free.** No table, no
  route, no tool and no migration changes hands; the cost is this ADR plus edits
  to `strategy.md`, `CONTEXT.md` and `IDEAS.md`. The same rename after slice C
  ships would be ADR 0013 all over again.
- **Weorc will look more real than it is.** It has a name and a glossary entry
  while holding no code, and its first slice ships inside another phase's
  release. Anyone reading the roadmap must take Phase 4 as "Weorc's maintenance
  slice" and Phase 5+ as "the rest of Weorc".
- **One household feature now spans two modules.** Servicing the boiler touches
  Ethel (the asset) and Weorc (the routine), and the seam has to be crossed by
  every maintenance screen. Accepted deliberately: the alternative pays the same
  cost later as a duplicated projection engine in Wyrtgeard, plus a migration.
- **Completion history has exactly one home.** It is in Weorc, including for
  asset upkeep — so "when was the boiler last serviced?" is a Weorc query with an
  Ethel filter, not an Ethel field. Ethel's asset detail view has to call Weorc
  to answer an obvious question about an asset.
- **Older documents need reading through this ADR.** Text that says "Maintenance
  Plans, anchored in Ethel" — including ADR 0013's own consequences section, which
  hangs slice C off assets and places — is superseded on *ownership* only; the
  anchoring it describes is still how a maintenance routine finds its asset.
- **If Weorc never outgrows maintenance plans, the name is overhead.** Cheap to
  collapse back into Ethel while it is unbuilt; expensive once the garden and the
  laundry are in it. The bet is that the unanchored routines — the actual chores —
  are the larger half of the domain.
