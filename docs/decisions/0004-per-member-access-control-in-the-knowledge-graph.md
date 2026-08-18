# 0004 — Per-member access control in the KithLedger knowledge graph

**Status:** **accepted** 2026-08-19 (proposed 2026-07-26) · Ratified when built —
see "Amendments on ratification" at the end for what changed on contact with the
code. · **Tracking:** `Wyrhta-Labs/wyrhta-labs` issue #1 (tasks B4–B9)

## Context

Within one household, not all KithLedger knowledge is shared. A member may want to
keep a specific item private, or scoped to a subset of members — the canonical case
is a note or relationship a member does not want their spouse (or the kids) to see.
Hiding such items only in the UI is not enough: KithLedger is API-first with its own
MCP, so privacy has to be a property of the **data and the query**, not a hub-side
courtesy. In a *knowledge graph* this is sharper than row-hiding — the graph's
*shape* (edges, paths, counts) can leak the existence of hidden items even when the
items themselves are withheld.

This decision depends on [ADR 0002](0002-cross-service-identity-a-then-b.md).
Per-member filtering requires a resolved household-member id at query time, which
only reaches KithLedger once it accepts **Heorth-issued member JWTs** — ADR 0002's
**Phase B**. Until then the model can exist in the schema but enforcement is inert.
This is therefore a Phase B deliverable (or it ships "dark" and flips on with Phase B).

ADR 0002 Phase A also assumed a single service API key as the cross-service caller.
That assumption is insufficient here: an always-on Heorth dashboard has *no*
logged-in member yet still must read the shared slice, while a bare service key must
never become a backdoor to private data. The caller model has to grow accordingly.

## Decision

Enforce access control **inside KithLedger, at the graph layer**, so privacy
survives direct API/MCP access. The model has four parts.

### 1. Visibility is a 3-state property of every node *and* every edge

Every node and every edge/property independently carries an `owner` (a member id)
and a `visibility`:

- **`private`** — owner only.
- **`shared`** — owner **+** an explicit set of member ids (the fine-grained
  "spouse but not the kids" case).
- **`household`** — all **current and future** members.

Visibility on **edges** is independent of the endpoints: a household-visible *person*
can carry an owner-only *note or relationship edge*. This is the common real case and
the reason node-only visibility was rejected.

`household` is an explicit state, **not** a materialized "share list containing every
member." This makes membership changes correct by construction: a new member
automatically sees `household` items, and a `shared` subset does **not** silently
grow to include them.

### 2. The caller resolves to a visibility scope — three kinds of caller

Enforcement always runs against a resolved principal that maps to a scope. There are
three principals, held as **separate credentials** (least privilege):

1. **Member principal** (Phase B member JWT) — personal scope: sees `household`
   items **+** items they own **+** `shared` items whose set includes them.
2. **Household service principal** (the always-on dashboard key) — **`household`
   scope only**, read-only. Sees exactly the items marked `household`; never
   `private`, never `shared`-subset. Member-less by design, so it can be always-on.
3. **Admin / ops service key** — provisioning, migrations, schema, health. **No data
   access at all**; cannot read items or leaking metadata.

Keeping these as distinct credentials means a leaked always-on dashboard key exposes
only household-shared data — never anyone's private items, and never admin ops.

**Consequence for the cross-service pattern:** every Heorth→KithLedger call that
reads *member-scoped data* must carry member context (member JWT), not the bare
service key. The existing "Heorth backend calls satellite with the service key"
pattern (e.g. the Ethel service-contacts integration) must be migrated: service
contacts read on a member's behalf need the member principal; the always-on
dashboard uses the household service principal and sees only the household slice.

### 3. Traversal rules (correctness, non-negotiable)

1. **Invisible = nonexistent.** An item outside your scope is silently absent —
   never an "access denied" signal, which would itself confirm the item exists.
2. **Edge visibility requires visible endpoints.** An edge is returned only if both
   endpoints are visible to you **and** the edge's own visibility includes you. No
   dangling edges to hidden nodes.
3. **No pass-through.** Traversal cannot route *through* an item you cannot see. A
   path `You → [hidden] → Cousin` does not surface Cousin; an independent visible
   path to Cousin still may.
4. **Aggregates respect the filter.** Counts, "N notes", "M connections", search
   totals, and autocomplete are computed over *your* visible subgraph only. A count
   of 5 when you can see 3 is as much a leak as showing the hidden 2. The dashboard's
   aggregates fall out for free — its visible subgraph is just the `household` slice.

### 4. Defaults, mutation, and lifecycle

- **Default on create = `household`.** Shared is the norm for a household manager;
  `private`/`shared`-subset is the deliberate opt-in carve-out.
- **Owner-only mutation; sharing is not transitive.** Only an item's owner may change
  its `visibility`/share set. A member the item was shared *to* can read it but
  cannot re-share it or alter who else sees it.
- **Orphan handling = reassign-on-offboarding.** There is **no standing god-mode** —
  no admin override and no service key can read another member's `private` items.
  When a member is removed, offboarding forces an explicit, one-time "reassign or
  delete this member's owner-only items" step decided *at that moment*. Private items
  never silently outlive access, and no ambient backdoor exists to recover them.

## Consequences

- Privacy is a guarantee of the data, not a UI courtesy: it holds against direct API
  and MCP access.
- The graph's *shape* stops leaking — edges, paths, and counts respect the caller's
  scope, closing the indirect-disclosure holes that plain row-hiding leaves open.
- The always-on dashboard works without a logged-in member and is structurally unable
  to see private or subset data even if its key is compromised.
- `household` as an explicit state keeps membership churn correct with no re-share and
  no accidental exposure to new members.
- **Cost / required migration:** ADR 0002's single-service-key data path is
  superseded for member-scoped reads. Cross-service calls that read member data must
  thread member context; the service key is demoted to ops-only plus a separate
  household-scoped dashboard key. Naive service-key data calls will (correctly) stop
  returning member-scoped data.
- **Cost:** three principal types and per-node/per-edge visibility metadata to hold in
  mind and enforce on every traversal; the reassign-on-offboarding step adds a
  deliberate offboarding flow rather than a silent delete.
- **Hard dependency on ADR 0002 Phase B.** No member-level enforcement is possible
  until member JWTs reach KithLedger. The model may be schema-present but inert until
  then.
- ~~**Proposed, not accepted.**~~ **Ratified 2026-08-19**, built in full rather than
  deferred. The 3-state enum, the three principals and the traversal rules all
  survived implementation; the amendments below record where reality differed.

## Amendments on ratification (2026-08-19)

Implemented across tasks B4–B9 of issue #1. Five things this ADR did not
anticipate, or left ambiguous:

1. **A prerequisite this ADR does not name.** It assumed ADR 0002 Phase B would
   supply "a resolved household-member id at query time" and that enforcement was
   otherwise only inert. In fact **KithLedger had no member concept at all** — no
   ownership column anywhere, exactly one user by construction with no route to
   create a second, and `principal` read in zero places outside `@wyrhta/core`.
   Phase B delivers the id; there was nothing to match it against. Multi-member
   identity had to be built first (B4), with members provisioned **just in time**
   from a verified token so KithLedger never becomes a second source of truth for
   who the household is.

2. **One identity space, not two.** JIT provisioning reuses core's `users` table
   with Heorth's `sub` *as* the local `users.id`. The deciding argument is this
   ADR's own model: the local admin owns items exactly as a member does, so with
   two identity spaces `owner` could not be a foreign key at all — leaving either
   an un-foreign-keyed `owner` on the column the whole model rests on, or a
   polymorphic `(owner_kind, owner_id)` pair threaded through every join in §3.

3. **§3.3 is implemented more strictly than written.** The text says traversal
   must not route *through* an item you cannot see, and its example names a hidden
   **node**. The implementation reads "item" as covering hidden **edges** too: a
   visible person reachable only across an edge you cannot see is not surfaced.

4. **§4's "owner-only mutation" was ambiguous and is now settled.** The bolded
   lead-in reads broadly; the sentence defining it covers only `visibility` and the
   share set. Resolved deliberately, 2026-08-19:

   | state | read | edit content | delete |
   |---|---|---|---|
   | `private` | owner | owner | owner |
   | `shared` | owner + share set | owner + share set | **owner only** |
   | `household` | all members | all members | all members |

   Content edits follow read scope because `household` is the *default* state —
   owner-only editing would make the household's own shared data read-only for
   everyone but whoever typed it first. Deletion of a deliberately-narrowed item
   is not the same right as correcting it, hence owner-only for `private` and
   `shared`. `household` items stay deletable by any member, because an item only
   its owner can remove outlives its usefulness.

5. **`updated_by` added.** This ADR is a disclosure control and specifies no
   provenance. With `shared` real, a member editing or deleting another member's
   item would otherwise leave no trace — the schema recorded `updated_at` but not
   who. Added while the tables were still empty.

**One part is defined but not yet useful.** §2.3's ops principal ("provisioning,
migrations, schema, health") exists as a real credential whose *no-data-access*
half is enforced and tested — but KithLedger has no HTTP surface for any of those
purposes: migrations run at startup, B4 removed the need for a provisioning route,
and `/health` is unauthenticated. It grants nothing an anonymous caller lacks. It
was left as a placeholder with teeth rather than having an ops surface invented to
justify it.

**The cross-service migration in Consequences is done.** Heorth's always-on
reminders feed presented a key backfilled as `member` — reading with the full
personal scope of KithLedger's local admin, and able to write. It now presents a
`household`-kinded credential: the `household` slice only, read-only. The
consequence is visible and intended — reminders someone marked `private` or shared
to a subset no longer appear on the hearth wall, and are absent from its totals.
