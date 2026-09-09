# 0017 — Paperless-ngx is the document system of record; Gewrit stores links, never bytes

**Status:** proposed (2026-09-09)

## Context

`CONTEXT.md` has said since the beginning that documents "stay in Library until
the future **Office** module exists". That sentence is not true, and a read of
Heorth confirms it: `src/modules/library/` is a **media** collection — two tables
(`library_connections`, `library_items`), `MEDIA_TYPES` of
`book | ebook | movie | series`, and connectors to Trakt and LibraryThing. There
is no document in it, and no document anywhere else either: a grep for
`attachment`, `receipt`, `invoice` and `manual` over every
`src/modules/*/schema.ts` returns nothing. Household documents have no home at
all, and never did.

Every domain that wants one has been working around the hole:

- **Ethel v1's** spec puts manuals *explicitly* out of scope ("they stay in
  Library until the future Office module exists") — the one Ethel fact an
  appliance obviously has, and the module ships without it.
- **Feoh** books a transaction with no way to keep the invoice that justifies it.
  The bank-ingestion slice (ADR 0016) made this sharper, not softer: a line
  arrives from the bank, gets an envelope, and the paper that explains it stays
  in a drawer.
- **Weorc** records that the boiler was serviced and has nowhere to put the
  service report.

Building document management inside Heorth means OCR, a file store,
thumbnailing, full-text indexing, dedupe by checksum, and a retention policy.
That is the same shape of work ADR 0016 declined to build for bank statements —
expensive, boring to own, and already solved by a self-hostable project the
household can run beside Heorth.

**What was probed.** Paperless-ngx **v3.1.3** (source read at commit
`b989b74`, 2026-09-08) — its documented API, filter set and models, **not** a
live instance. The parts this decision leans on:

- **Auth** is a header, `Authorization: Token <token>`, with tokens mintable in
  the UI or from `POST /api/token/`. No tenant, no app registration, no OAuth
  dance.
- **The API is versioned and says so**: `Accept: application/json; version=10`,
  supported versions `9` and `10`, every authenticated response carrying
  `X-Api-Version` and `X-Version`, and a published policy of at least one year
  of support after a new version appears.
- **Search is the store's job and it is good at it**: `?text=`, `?title_search=`,
  `?query=` (Tantivy-backed, with `__search_hit__` score/highlights) and
  `?more_like_id=`.
- **Renditions are separate endpoints**: `/api/documents/{id}/preview/`,
  `/thumb/`, `/download/`, `/metadata/`.
- **Filters** cover `modified__gt`, `added__gt`, `created__date__gt`,
  `checksum__iexact`, tags, correspondent, document type, storage path and
  owner — but `id` takes only `in` and `exact`. **There is no `id__gt`.**
- **Upload is asynchronous**: `POST /api/documents/post_document/` returns the
  UUID of a *consumption task*, and the document id only becomes knowable by
  polling `/api/tasks/?task_id={uuid}`.
- **Documents are soft-deleted** (trash, then permanent deletion on a delay),
  and 3.x has **document versions**: the root document holds the metadata while
  content, preview and download resolve to the latest version.
- **Workflows can call a webhook** (`WorkflowAction` type `WEBHOOK`, with url,
  headers, params, body) on consumption, add, update or a schedule.

**The tempting larger version is to let paperless hold the links too.** Its
custom fields include a `documentlink` type and an `integer` type; tags and
correspondents are free-form. One could tag a document with the appliance and
never write a line of Heorth code. Rejected, for reasons that are properties of
the split rather than of paperless:

1. **A reference in the store cannot be joined or enforced.** `gewrit_filings`
   with a real foreign key to `ethel_assets` cascades when the asset is deleted
   and cannot dangle. A custom field holding the integer `42` is a string that
   used to mean something.
2. **It inverts the estate's dependency direction.** Finance points at the asset
   register and never the reverse (ADR 0013 §3). A document store pointing into
   Heorth's ids makes an optional sidecar the keeper of household structure.
3. **Its permission model is not the household's.** Documents carry an `owner`
   and per-object view/change grants for paperless users and groups. Members are
   Heorth's (`users`), and ADR 0002 Phase A means paperless has no idea who they
   are.

This is ADR 0016's argument one level down: buy the expensive part, keep the
part that carries meaning. Writing a Heorth reference *back* into a paperless
custom field as a convenience for someone browsing the store directly stays
available later; it is not a system of record either way, and v1 does not do it.

**Timing — this ADR is planning, not a queue jump.**
[ADR 0015](0015-feature-work-resumes-before-deployment.md) §5 allowed one
pre-deployment slice; [ADR 0016](0016-bank-ingestion-behind-an-ingestion-provider.md)
took a second and closed the door behind itself: "a *third* pre-deployment slice
should be refused." Nothing here is built before Phase 3 is deployed and lived
with. This ADR exists because the shape is cheap to decide now and expensive to
decide inside a half-built module — and because the first thing real use will
ask for is the manual of the appliance the household is standing in front of.
The roadmap entry is **Phase 5+**, and it stays there.

## Decision

**Paperless-ngx is the household's system of record for documents. Heorth's new
Gewrit module keeps a *register* of the documents the household cares about —
a reference, a relation, an optional anchor, and nothing else. It never stores,
copies or indexes the bytes.**

1. **This is ADR 0001's category, fourth instance** — after calendars, tasks and
   (as the counter-example) the ingestion providers of ADR 0016. Documents are
   household-*authored* data that already lives elsewhere; Heorth mirrors
   metadata and enriches it with household meaning. One clause of
   [ADR 0001](0001-external-systems-of-record-behind-providers.md) does **not**
   carry: its "structural dependency on an OAuth app registration in the
   household's tenant". A **self-hosted system of record** is a new sub-case —
   auth is one household-level API token, and there is no tenant. That is a note
   on 0001, deliberately **not** a fourth provider taxonomy: the estate already
   pays for three (0001, 0003, 0016) and this one fits.
2. **The name is Gewrit** (OE *gewrit* — a writing, document, deed, charter;
   ancestor of modern "writ"). It replaces the placeholder **Office** in
   `CONTEXT.md`, which becomes an avoided word, and follows **Weorc** in having
   no rune. Module `src/modules/gewrit/`, tables `gewrit_*`, route
   `/api/v1/gewrit/...`, nav label "Gewrit" untranslated in both locales, as
   Feoh and Ethel already are.
3. **A `DocumentProvider` interface in Heorth-owned types, read-only in v1.**
   Five methods: `search(query, page)` and `listTagged(tag, cursor, limit)` to
   find documents, `get(documentId)` and `getMany(documentIds)` to refresh the
   register's cache in one round trip (paperless's `id__in` filter, confirmed by
   the probe), and `stream(documentId, rendition)` with `rendition` one of
   `preview | thumb | download`. No `create`, `update` or `delete` — as in
   ADR 0016 §2 the one-way street is in the type, not the prose;
   upload arrives with the capture slice and adds a method then. No paperless
   type crosses the boundary: tags, correspondents and document types come
   across as display strings, never as domain concepts, so a different store
   (or a plain WebDAV folder) can implement the same five methods — and a store
   with no tags implements `listTagged` as an empty list, which degrades the
   register to manual filing only rather than breaking it.
4. **The API version is pinned and the mismatch is loud.** Every request sends
   `Accept: application/json; version=10`. The provider reads `X-Api-Version`
   and `X-Version` off the first response, logs them, and classifies a version
   it was not built against as a provider error rather than parsing hopefully.
   Paperless promises a year; the pin is what turns that promise into something
   the household notices before it breaks.
5. **The register is the domain object: a Filing with an *optional* anchor.**
   `gewrit_filings` — one row per document the household has taken into Gewrit,
   holding `documentId integer` (paperless's own id), a `relation`, an `origin`,
   the display cache of §7, and **at most one anchor**: typed nullable foreign
   keys `anchorAssetId`, `anchorPlaceId`, `anchorTransactionId`,
   `anchorRoutineId`, `anchorOccurrenceId`, each real and each
   `on delete cascade`, under a single `num_nonnulls(...) <= 1` CHECK.
   The vocabulary is borrowed from Weorc on purpose: a Routine anchors to an
   asset, a place, or **nothing** (ADR 0014), and a Filing does the same, so "the
   boiler's manual" and "the house insurance policy" are one kind of row. That is
   ADR 0014's bet, already shipped and already proven once.
   It is **not** a generic `(entity_type, entity_id)` pair — no foreign key, no
   cascade, and ids that decay into pointers at deleted rows. Cost, stated: **a
   new anchor kind is a migration**, not a config change.
   Uniqueness is five partial unique indexes, one per anchor column with its
   `IS NOT NULL` predicate, plus a sixth on `documentId` where every anchor is
   null — so a document is filed at most once against a given thing, and at most
   once unanchored.
   **Why "Filing" and not "Link":** a row may have no anchor, so "link" would
   lie about half the table, and "document" would collide with paperless's own
   object. A Filing is the household's act of filing something, which may or may
   not attach it to a thing.
6. **`relation` is the document's role in the household's model, not its type.**
   A small enum — `manual`, `invoice`, `warranty`, `contract`, `receipt`,
   `report`, `other`. It deliberately overlaps paperless's `document_type` and
   is not derived from it: the same PDF is the `invoice` of a Feoh transaction
   and the `warranty` of an Ethel asset, and only the Filing knows which. On an
   unanchored Filing it says what the document is to the household as a whole —
   `contract` for the insurance policy. It is what makes "show me the boiler's
   manual" answerable without reading the store's taxonomy.
7. **Display metadata on the Filing is a cache and is labelled one.**
   `documentTitle`, `documentCreated`, `documentChecksum`, `cachedAt` — enough to
   render the register without a round trip per row, refreshed by the tick in
   §10, never authoritative, and **never searched**. Paperless answers every
   question about a document; the cache only answers "what shall I put on the
   button".
8. **One register page lists every Filing, anchored or not.** The household gets
   a single Gewrit page over `gewrit_filings` — the boiler's manual beside the
   insurance policy — filterable by `relation`, by anchor kind, by *unanchored
   only*, and by stale, sorted by the cached document date. It is a plain indexed
   Heorth query, not a proxied view of paperless's list, which is what the cache
   in §7 exists for.
   **This reverses an earlier draft of this ADR**, which said Gewrit would have
   no top-level list on the grounds that paperless already serves one. That was
   wrong twice over: the store's list is the operator's UI, which §12 keeps away
   from the household, and without a register an unanchored document is not
   merely unlinked but unreachable — "a document may be unanchored" would have
   meant "a document may be invisible".
9. **The household tag is the store's opt-in, and the tick materialises it.**
   One configured tag, `PAPERLESS_HOUSEHOLD_TAG` (default `household`): the tick
   sweeps documents carrying it and **creates a Filing with `origin = 'tag'`**
   and `relation = 'other'` for any that has none, which is how a document
   reaches the register without a member attaching it to anything. When the tag
   goes away the tick deletes that Filing **only while it is still unanchored** —
   anchoring it is adoption, and an adopted Filing survives untagging.
   Materialising beats listing the store live for three reasons: it keeps §11's
   predicate a single-table lookup, it makes the register one indexed query
   instead of a paginated proxy, and a paperless outage degrades the page to
   "possibly stale" rather than empty. `origin` is `manual | tag`, and it exists
   so the tick can only ever retract what the tick created.
10. **Pull, not push; rot is detected, not prevented.** No webhook — the
    `WEBHOOK` workflow action exists and is declined, because an inbound route
    needs a shared secret and buys latency that documents do not need (ADR 0016 §5
    made the same call for bank lines). One scheduler tick does both jobs — the
    tag sweep of §9 and a refresh of every Filing's cache — following
    `src/modules/feoh/import/scheduler.ts`: cursor state, classified errors, a
    tick that never throws. A document that has been trashed or permanently
    deleted marks its Filing **`stale`** with a timestamp instead of deleting it,
    so the household's record that the document *was* filed outlives the store's
    retention policy — ADR 0016 §6's permanent-register reasoning, same problem.
    Because paperless has no `id__gt`, a sweep walks `modified__gt` with
    `ordering=modified`, and since `modified` is not unique the tick **re-reads
    its boundary timestamp** rather than stepping past it.
11. **The bytes reach the household through Heorth, and only for a filed
    document.** Heorth streams `preview/`, `thumb/` and `download/` with the
    service token and writes nothing to disk. The rule is **no Filing, no
    proxy**: the route resolves the requested id through `gewrit_filings` and
    returns 404 for an id nobody filed, so a paperless document id is never a
    capability on its own. That rule *is* the authorisation model and is tested
    as one — and §9 is what keeps it a single predicate even though the register
    now holds documents nobody anchored. Two alternatives were rejected: deep
    links into paperless's UI (a second login on a kitchen touchscreen, and it
    makes the store a household surface), and paperless **share links** (an
    unauthenticated URL that outlives the glance that needed it).
12. **Paperless's UI is an operator tool, never a household surface** — the same
    posture ADR 0016 §3 took for Firefly. What follows is accepted openly:
    paperless's per-document `owner` and view/change grants are **not** mirrored,
    so a filed document is visible to every member who can see it in the register
    or on the thing it is anchored to. The **tag is therefore the household's
    publication switch**: Heorth's token can read the whole archive, but Heorth
    exposes only Filings, so an untagged, unanchored document stays invisible to
    the household even though the token could fetch it. Two things follow —
    **anything private stays untagged and unanchored**, and untagging revokes on
    the next tick rather than instantly. ADR 0004's three-state visibility is
    KithLedger's graph and does not reach here.
13. **A Filing points at the root document; versions are the store's business.**
    Heorth never pins a version id, so a manual that gets a revision changes what
    the household sees — which is the desired behaviour and, per the probe, what
    the root-document endpoints already do.
14. **No document text in Heorth, ever.** OCR content is not copied, not indexed,
    not embedded. Search is delegated (`text`, `title_search`, `query`,
    `more_like_id`). This keeps
    [ADR 0006](0006-no-server-side-generative-inference-and-a-conservative-base-db.md)
    §1 intact and kills the pgvector-over-documents temptation before it starts —
    [ADR 0005](0005-semantic-retrieval-with-pgvector.md) stays about KithLedger
    notes. The register is searchable only over its own cached titles and
    relations; anything more goes to the store.
15. **Manual filing only in v1. No suggestion rules, no auto-anchoring.** A
    member searches the store from a thing, or from the register, and files what
    they picked; the tag sweep of §9 is the one automatic writer and it never
    guesses an anchor. This is the deliberate difference from ADR 0016 §4: a bank
    line *must* be dispositioned or the ledger is wrong, whereas an unanchored
    Filing is a perfectly good end state. Suggestion rules and capture are named
    as later slices below, not built.
16. **Tools live in `heorth-mcp`** (ADR 0008): `gewrit.search_documents`,
    `gewrit.list_filings`, `gewrit.file_document`, `gewrit.unfile_document`,
    calling Heorth's REST API. Heorth gains no MCP surface, and paperless's own
    API is **not** exposed to the model — the model gets the register and the
    household's view of it, not a second store to reason about.
17. **Optional per deployment, and absent from the demo stack.**
    `GEWRIT_ENABLED` plus `PAPERLESS_URL`, `PAPERLESS_TOKEN` (encrypted at rest
    like `library_connections.credentials`) and `PAPERLESS_HOUSEHOLD_TAG`,
    all-or-nothing per the `FEOH_IMPORT_ENABLED` precedent. Off means search, the
    tick and the proxy return a classified `provider_unavailable` while the
    register still reads, files and unfiles — those are pure Heorth writes, so
    the page keeps working from its cache. Paperless joins the **dev and prod**
    stacks and **not** the demo stack (ADR 0012), which seeds Filings that render
    as unavailable — Weorc's "degrades rather than errors" precedent. It reserves
    dev port **14005**.

## Consequences

- **The Office slot is filled, renamed, and a false sentence in the glossary is
  retired.** "Documents stay in Library" described an intention, never a
  behaviour; Library goes back to being what it is, a media shelf.
- **Ethel's manual-shaped hole closes without Ethel growing a file store.** The
  v1 spec's exclusion becomes a Filing rather than a missing feature, and the
  same move gives Feoh its invoice and Weorc its service report — three domains,
  one table, no new storage.
- **The second bought sidecar arrives, and it differs from the first in the way
  that matters.** Firefly owns no household-visible data (ADR 0016); paperless
  owns the household's **files**. So its backup, retention and upgrade path
  become household concerns, and a Postgres dump of Heorth no longer covers
  everything a member would miss. That is the real price of this decision and it
  is not paid by the sidecar being optional.
- **Heorth becomes a proxy for someone else's bytes.** The no-Filing-no-proxy
  rule in §11 is the whole authorisation story, which makes it exactly the kind
  of rule that must be a test rather than a convention.
- **The register is a second surface with a second failure mode.** The tick of
  §9 writes rows no member created, so a mis-set tag publishes documents to the
  household and untagging retracts them a tick later, not at once (§12). That
  latency is the price of the register being a local query instead of a live
  proxy, and it is the reason `origin` exists: the tick may only retract what
  the tick created.
- **A privacy edge exists by construction** (§12): visibility is per Filing and
  per anchored entity, never per document as paperless models it. Stated rather
  than mitigated, because mitigating it means mapping members onto paperless
  users, which ADR 0002 Phase A cannot do. What makes it liveable is that the
  household tag, not the token's reach, decides what appears.
- **Rot becomes visible instead of silent**, at the cost of a `stale` state the
  register and every entity view have to render and a member has to
  understand.
- **No fourth provider taxonomy.** Systems of record (0001), reference feeds
  (0003), ingestion providers (0016) — and a self-hosted sub-case noted on 0001.
  Holding the line here is a deliberate consequence of §1.
- **A new anchor kind costs a migration** (§5). Assets, places, transactions,
  routines and occurrences are cheap now because they are one CHECK and five
  columns; a sixth kind is a schema change, and a KithLedger person is worse
  than that (see below). The household itself never becomes an anchor kind — a
  household document is simply an **unanchored** Filing, which is what §5's
  at-most-one CHECK buys and what makes the register in §8 necessary rather
  than decorative.
- **The test fake stays cheap** — five read methods carrying no semantics are
  faked with an in-memory list plus one checked-in response fixture per
  rendition, and no Python container in CI. This is ADR 0016's §2 consequence
  earned the same way.
- **`deploy/` grows and the env check will say so.** `deploy/.env.example`,
  `compose.dev.yml` and `compose.prod.yml` gain paperless together, and
  `scripts/check-env-template.mjs` fails until all of them agree — the intended
  behaviour, noted so it is not a surprise mid-slice.
- **Phase 3 is untouched.** This is not a third pre-deployment slice and must not
  become one. If it starts before a real household is running Heorth, that start
  needs its own ADR arguing why — and ADR 0016's Context section is the record of
  how that argument usually goes.

## Deferred, on purpose

- **Capture** — upload from the phone PWA (camera → receipt) via
  `post_document`. Cheap to want, not cheap to build: consumption is
  asynchronous, so the flow is upload → store the returned task UUID as a
  pending Filing → resolve it to a document id by polling
  `/api/tasks/?task_id=` on the tick. It roughly doubles the slice and adds a
  second write path; it is the obvious slice B.
- **Suggestions** — a rules table (paperless tag or correspondent → candidate
  entity) proposing an *anchor* for newly consumed documents, confirmed by a
  member. The tag sweep of §9 is deliberately not this: it files a document
  without ever guessing what it belongs to.
  ADR 0016 §3's rules-in-Heorth pattern applies directly, and nothing about §5's
  schema blocks it.
- **KithLedger person anchors** — a document that belongs to a person (a
  contractor's contract) cannot take a foreign key: KithLedger is a separate
  service with a separate database. It follows Feoh's party pattern (cache id and
  display name, never merge) and therefore cannot be an anchor column at all,
  breaking §5's typed-FK invariant rather than extending it — so it is its own
  decision.
- **Meter readings**, which `CONTEXT.md` listed under Office. They are structured
  household data, not documents; if they get built they belong beside Ethel's
  facilities, not here.
