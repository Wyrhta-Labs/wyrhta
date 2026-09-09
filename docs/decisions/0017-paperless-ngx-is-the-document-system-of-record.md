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

1. **A link in the store cannot be joined or enforced.** `gewrit_document_links`
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
**Gewrit** module stores *links* to documents and never stores, copies or
indexes the bytes.**

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
   `search(query, page)`, `get(documentId)`, `stream(documentId, rendition)`
   with `rendition` one of `preview | thumb | download`. No `create`, `update` or
   `delete` — as in ADR 0016 §2 the one-way street is in the type, not the prose;
   upload arrives with the capture slice and adds a method then. No paperless
   type crosses the boundary: tags, correspondents and document types come
   across as display strings, never as domain concepts, so a different store
   (or a plain WebDAV folder) can implement the same three methods.
4. **The API version is pinned and the mismatch is loud.** Every request sends
   `Accept: application/json; version=10`. The provider reads `X-Api-Version`
   and `X-Version` off the first response, logs them, and classifies a version
   it was not built against as a provider error rather than parsing hopefully.
   Paperless promises a year; the pin is what turns that promise into something
   the household notices before it breaks.
5. **The link is the domain object, and it is typed.**
   `gewrit_document_links`: one row per (document, target), holding
   `documentId integer` (paperless's own id), a `relation`, and **typed nullable
   foreign keys** — `assetId`, `placeId`, `transactionId`, `routineId`,
   `occurrenceId` — with a CHECK that exactly one is set, each a real FK with
   `on delete cascade`. This is ADR 0014's one-kind-of-row shape (the Weorc
   anchor), not a generic `(entity_type, entity_id)` pair: a polymorphic pair has
   no foreign key, no cascade, and decays into ids pointing at deleted rows. The
   cost is explicit — **a new link target is a migration**, not a config change.
6. **`relation` is the document's role in the household's model, not its type.**
   A small enum — `manual`, `invoice`, `warranty`, `contract`, `receipt`,
   `report`, `other`. It deliberately overlaps paperless's `document_type` and
   is not derived from it: the same PDF is the `invoice` of a Feoh transaction
   and the `warranty` of an Ethel asset, and only the link knows which. It is
   what makes "show me the boiler's manual" answerable without reading the
   store's taxonomy.
7. **Display metadata on the link row is a cache and is labelled one.**
   `documentTitle`, `documentCreated`, `documentChecksum`, `cachedAt` — enough to
   render a list without a round trip per row, refreshed by the tick in §9, never
   authoritative, and **never searched**. Paperless answers every question about
   a document; the cache only answers "what shall I put on the button".
8. **Manual linking only in v1. No rules, no auto-link, no inbox.** Search the
   store from the entity, pick a document, done. This is the deliberate
   difference from ADR 0016 §4: a bank line *must* be dispositioned or the ledger
   is wrong, whereas an unlinked document is simply a document, and the store is
   already a perfectly good place for it. Suggestion rules and capture are named
   as later slices below, not built.
9. **Pull, not push; link rot is detected, not prevented.** No webhook — the
   `WEBHOOK` workflow action exists and is declined, because an inbound route
   needs a shared secret and buys latency that documents do not need (ADR 0016 §5
   made the same call for bank lines). A scheduler tick re-reads linked documents
   in batches, following `src/modules/feoh/import/scheduler.ts`: cursor state,
   classified errors, a tick that never throws. A document that has been trashed
   or permanently deleted marks its links **`stale`** with a timestamp instead of
   deleting them — the household's record that the document *was* linked outlives
   the store's retention policy, which is ADR 0016 §6's reasoning about a
   permanent register applied to the same problem. Because paperless has no
   `id__gt`, a sweep walks `modified__gt` with `ordering=modified`, and since
   `modified` is not unique the tick **re-reads its boundary timestamp** rather
   than stepping past it.
10. **The bytes reach the household through Heorth, and only for a linked
    document.** Heorth streams `preview/`, `thumb/` and `download/` with the
    service token and writes nothing to disk. The rule is **no link, no proxy**:
    the route resolves the requested id through `gewrit_document_links` and
    returns 404 for an id nobody linked, so a paperless document id is never a
    capability on its own. That rule *is* the authorisation model and is tested
    as one. Two alternatives were rejected: deep links into paperless's UI (a
    second login on a kitchen touchscreen, and it makes the store a household
    surface), and paperless **share links** (an unauthenticated URL that outlives
    the glance that needed it).
11. **Paperless's UI is an operator tool, never a household surface** — the same
    posture ADR 0016 §3 took for Firefly. The consequence is accepted openly:
    paperless's per-document `owner` and view/change grants are **not** mirrored,
    so a linked document is visible to every member who can see the entity it
    hangs on. Therefore **anything private stays unlinked**, and the token Heorth
    holds should belong to a paperless user that can only see what the household
    may share. ADR 0004's three-state visibility is KithLedger's graph and does
    not reach here.
12. **A link points at the root document; versions are the store's business.**
    Heorth never pins a version id, so a manual that gets a revision changes what
    the household sees — which is the desired behaviour and, per the probe, what
    the root-document endpoints already do.
13. **No document text in Heorth, ever.** OCR content is not copied, not indexed,
    not embedded. Search is delegated (`text`, `title_search`, `query`,
    `more_like_id`). This keeps
    [ADR 0006](0006-no-server-side-generative-inference-and-a-conservative-base-db.md)
    §1 intact and kills the pgvector-over-documents temptation before it starts —
    [ADR 0005](0005-semantic-retrieval-with-pgvector.md) stays about KithLedger
    notes.
14. **Tools live in `heorth-mcp`** (ADR 0008): `gewrit.search_documents`,
    `gewrit.list_links`, `gewrit.link_document`, `gewrit.unlink_document`,
    calling Heorth's REST API. Heorth gains no MCP surface, and paperless's own
    API is **not** exposed to the model — the model gets links and the household's
    view of them, not a second store to reason about.
15. **Optional per deployment, and absent from the demo stack.**
    `GEWRIT_ENABLED` plus `PAPERLESS_URL` and `PAPERLESS_TOKEN` (encrypted at
    rest like `library_connections.credentials`), all-or-nothing per the
    `FEOH_IMPORT_ENABLED` precedent. Off means search and the proxy return a
    classified `provider_unavailable` while reading, creating and deleting link
    rows keep working — they are pure Heorth writes. Paperless joins the **dev
    and prod** stacks and **not** the demo stack (ADR 0012), which seeds link
    rows that render as unavailable — Weorc's "degrades rather than errors"
    precedent. It reserves dev port **14005**.

## Consequences

- **The Office slot is filled, renamed, and a false sentence in the glossary is
  retired.** "Documents stay in Library" described an intention, never a
  behaviour; Library goes back to being what it is, a media shelf.
- **Ethel's manual-shaped hole closes without Ethel growing a file store.** The
  v1 spec's exclusion becomes a link rather than a missing feature, and the same
  move gives Feoh its invoice and Weorc its service report — three domains, one
  table, no new storage.
- **The second bought sidecar arrives, and it differs from the first in the way
  that matters.** Firefly owns no household-visible data (ADR 0016); paperless
  owns the household's **files**. So its backup, retention and upgrade path
  become household concerns, and a Postgres dump of Heorth no longer covers
  everything a member would miss. That is the real price of this decision and it
  is not paid by the sidecar being optional.
- **Heorth becomes a proxy for someone else's bytes.** The no-link-no-proxy rule
  in §10 is the whole authorisation story, which makes it exactly the kind of
  rule that must be a test rather than a convention.
- **A privacy edge exists by construction** (§11): entity-level visibility, not
  document-level. Stated rather than mitigated, because mitigating it means
  mapping members onto paperless users, which ADR 0002 Phase A cannot do.
- **Link rot becomes visible instead of silent**, at the cost of a `stale` state
  every list view has to render and a member has to understand.
- **No fourth provider taxonomy.** Systems of record (0001), reference feeds
  (0003), ingestion providers (0016) — and a self-hosted sub-case noted on 0001.
  Holding the line here is a deliberate consequence of §1.
- **A new link target costs a migration** (§5). Assets, places, transactions,
  routines and occurrences are cheap now because they are one CHECK and five
  columns; the sixth target is a schema change, and a KithLedger person is worse
  than that (see below).
- **The test fake stays cheap** — three read methods carrying no semantics are
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
  asynchronous, so the flow is upload → store the returned task UUID as a pending
  link → resolve it to a document id by polling `/api/tasks/?task_id=` on the
  tick. It roughly doubles the slice and adds a second write path; it is the
  obvious slice B.
- **Suggestions** — a rules table (paperless tag or correspondent → candidate
  entity) proposing links for newly consumed documents, confirmed by a member.
  ADR 0016 §3's rules-in-Heorth pattern applies directly, and nothing about §5's
  schema blocks it.
- **KithLedger person links** — a document that belongs to a person (a
  contractor's contract) cannot take a foreign key: KithLedger is a separate
  service with a separate database. It follows Feoh's party pattern (cache id and
  display name, never merge) and therefore breaks §5's exactly-one-FK invariant,
  so it is its own decision.
- **Meter readings**, which `CONTEXT.md` listed under Office. They are structured
  household data, not documents; if they get built they belong beside Ethel's
  facilities, not here.
