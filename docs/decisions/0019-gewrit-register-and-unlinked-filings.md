# 0019 — Gewrit grows a register: unlinked Filings, a household tag, more anchors

**Status:** proposed (2026-09-09, renumbered and rewritten as a delta against
ADR 0017 on 2026-09-24)

This ADR was first written on 2026-09-09 as a *proposed* ADR 0017, "Paperless-ngx
is the document system of record; Gewrit stores links, never bytes". On
2026-09-24 a separate session built Gewrit v1 and recorded it as the *accepted*
[ADR 0017](0017-gewrit-documents-stay-in-paperless.md). Both carried the number
0017. The built one keeps it, because it describes the code. This one is
renumbered and rewritten: what ADR 0017 already decides is referenced, not
repeated, and where this design differs from what was built, the difference is
stated as an **open decision** with its cost against the shipped schema.

## Context

**Where the idea came from.** `CONTEXT.md` said from the beginning that documents
"stay in Library until the future **Office** module exists". That sentence was not
true, and a read of Heorth confirmed it: `src/modules/library/` is a **media**
collection — two tables (`library_connections`, `library_items`), `MEDIA_TYPES` of
`book | ebook | movie | series`, and connectors to Trakt and LibraryThing. There
was no document in it, and no document anywhere else either: a grep for
`attachment`, `receipt`, `invoice` and `manual` over every
`src/modules/*/schema.ts` returned nothing. Every domain that wanted one worked
around the hole:

- **Ethel v1's** spec put manuals explicitly out of scope — the one Ethel fact an
  appliance obviously has.
- **Feoh** books a transaction with no way to keep the invoice that justifies it.
  Bank ingestion (ADR 0016) made this sharper: a line arrives from the bank, gets
  an envelope, and the paper that explains it stays in a drawer.
- **Weorc** records that the boiler was serviced and has nowhere to put the
  service report.

Building document management inside Heorth means OCR, a file store,
thumbnailing, full-text indexing, dedupe by checksum and a retention policy — the
same shape of work ADR 0016 declined for bank statements. ADR 0017 settled that
part: Paperless-ngx is the system of record, Heorth keeps references and a
snapshot, never the bytes. ADR 0017 closed Ethel's hole. Feoh's and Weorc's
holes, and the household documents that belong to no thing at all, are still
open. This ADR proposes how to close them.

**What was probed.** Paperless-ngx **v3.1.3** (source read at commit `b989b74`,
2026-09-08) — its documented API, filter set and models, **not** a live
instance. The facts this proposal leans on beyond what ADR 0017 uses:

- **The API says which version answered**: every authenticated response carries
  `X-Api-Version` and `X-Version`, and Paperless publishes a policy of at least
  one year of support after a new version appears. Supported versions are `9`
  and `10`.
- **Search is richer than v1 uses**: `?text=`, `?title_search=`, `?query=`
  (Tantivy-backed, with `__search_hit__` score/highlights) and `?more_like_id=`.
- **Renditions are separate endpoints**: `/api/documents/{id}/preview/`,
  `/thumb/`, `/download/`, `/metadata/`.
- **Filters** cover `modified__gt`, `added__gt`, `created__date__gt`,
  `checksum__iexact`, tags, correspondent, document type, storage path and
  owner — but `id` takes only `in` and `exact`. **There is no `id__gt`**, so any
  sweep has to walk a timestamp.
- **Upload is asynchronous**: `POST /api/documents/post_document/` returns the
  UUID of a consumption task, and the document id only becomes knowable by
  polling `/api/tasks/?task_id={uuid}`.
- **Documents are soft-deleted** (trash, then permanent deletion on a delay), and
  3.x has **document versions**: the root document holds the metadata while
  content, preview and download resolve to the latest version.
- **Workflows can call a webhook** (`WorkflowAction` type `WEBHOOK`) on
  consumption, add, update or a schedule.

**Why the references stay in Heorth, not in Paperless.** Paperless's custom
fields include a `documentlink` and an `integer` type, and tags are free-form, so
one could tag a document with the appliance and write no Heorth code. Rejected,
and ADR 0017 §3 builds on the same conclusion:

1. **A reference in the store cannot be joined or enforced.** A Heorth row with a
   real foreign key to `ethel_assets` cascades when the asset is deleted and
   cannot dangle. A custom field holding the integer `42` is a string that used to
   mean something.
2. **It inverts the estate's dependency direction.** Finance points at the asset
   register and never the reverse (ADR 0013 §3). A document store pointing into
   Heorth's ids makes an optional sidecar the keeper of household structure.
3. **Its permission model is not the household's.** Documents carry an `owner`
   and per-object grants for Paperless users and groups. Members are Heorth's
   (`users`), and ADR 0002 Phase A means Paperless has no idea who they are.

Writing a Heorth reference *back* into a Paperless custom field as a convenience
for someone browsing the store directly stays available later; it is not a
system of record either way.

**Timing — this ADR is planning, not a queue jump.** ADR 0016 took the second
pre-deployment slice and said a third should be refused. Gewrit v1 was then taken
as that third slice anyway, under ADR 0017 §8. Everything this ADR proposes waits
for Phase 3 to be deployed and lived with. The roadmap entry is **Phase 5+**, and
it stays there. Starting any of it before deployment would be a fourth
pre-deployment slice and would need its own ADR.

## The built baseline (ADR 0017, Heorth v0.9.0 release commit)

This is what exists, and every proposal below is measured against it.

- **Tables** (migration `0029_gewrit.sql`, `src/modules/gewrit/schema.ts`):
  - `gewrit_documents` — one row per provider document: `source`
    (`paperless` | `fake`) + `external_id`, unique together; snapshot `title`,
    `document_type`, `correspondent`, `created_on`, `last_seen_at`; `status`
    (`available` | `missing`).
  - `gewrit_links` — `document_id` → `gewrit_documents` (cascade), `asset_id` →
    `ethel_assets` and `place_id` → `ethel_places` (both cascade), `role`,
    `note` (≤ 500 chars).
  - `gewrit_links_element_check`: `(asset_id IS NULL) <> (place_id IS NULL)` —
    **exactly one** anchor.
  - `gewrit_links_role_check`: `role IN ('manual', 'warranty', 'invoice',
    'contract', 'certificate', 'other')`.
  - `gewrit_links_unique`: `UNIQUE NULLS NOT DISTINCT (document_id, asset_id,
    place_id, role)` — the same document may sit on the same thing once **per
    role**.
- **Orphan lifecycle**: a `gewrit_documents` row with no link is garbage.
  `deleteLink()` removes the document row with its last link; `sweepOrphans()`
  deletes linkless rows older than one hour on every list read; the preview gate
  requires `EXISTS (SELECT 1 FROM gewrit_links …)`.
- **Refresh on read**: a list request re-reads documents older than 15 minutes
  with one `getMany` (3 s timeout). A document Paperless no longer returns
  becomes `status = 'missing'` and recovers to `available` when it comes back. An
  outage answers `meta.stale: true` with `staleReason`.
- **Routes** under `/api/v1/gewrit`: `GET /documents/search?q=`,
  `GET /assets/:id/documents`, `GET /places/:id/documents`, `POST /links`,
  `PATCH /links/:id` (role and note only), `DELETE /links/:id`,
  `GET /documents/:id/preview` (keyed by the `gewrit_documents` uuid; a gone
  document answers **404** and is marked missing).
- **Roles**: every route requires auth; search and every write are
  `requireRole('admin', 'adult')`; lists and preview are open to every member.
- **Provider interface** (`providers/types.ts`): `id`, `search(q, limit)`
  (25 hits, text only), `getMany`, `openPreview`, `externalUrl`. Two
  implementations: `paperless` and the demo `fake`.
- **Deep links**: `externalUrl` → `<PAPERLESS_PUBLIC_URL>/documents/<id>/details`,
  shown as "Open in Paperless" in the preview dialog and returned by
  `gewrit.list_documents`.
- **Env**: `GEWRIT_PROVIDER` (`paperless` | `fake` | blank = off, **module not
  mounted**), `PAPERLESS_BASE_URL`, `PAPERLESS_TOKEN` (plain env, the dedicated
  `heorth` user's token), `PAPERLESS_PUBLIC_URL` (optional).
- **Deploy**: no Paperless container; dev and prod point at an **external**
  instance. The demo stack runs `GEWRIT_PROVIDER: fake` with four built-in
  documents that preview for real.
- **MCP** (heorth-mcp): `gewrit.list_documents` and `gewrit.search`, read-only.
- **API version**: `Accept: application/json; version=10` on every request; no
  response-header check yet (a manual TODO).

## Proposal

**Gewrit keeps a register of the documents the household cares about — anchored
to a thing, or to nothing at all — reachable from one page, with a household tag
as the store-side way in.**

The name for a register row in this design is a **Filing**: the household's act
of filing a document, which may or may not attach it to a thing. "Link" would lie
about the unanchored half, and "document" collides with Paperless's own object.
Whether the name replaces "link" in the code is open decision 3.

### Proposed additions (additive against the built schema)

1. **More anchor kinds.** Nullable foreign keys on `gewrit_links` for a Feoh
   transaction, a Weorc routine and a Weorc occurrence, each `ON DELETE CASCADE`,
   beside `asset_id` and `place_id` — Weorc's anchor pattern, which ADR 0017
   already uses. Cost: one migration per batch of columns and a wider CHECK. A
   new anchor kind is always a migration, not a config change. KithLedger person
   anchors stay out (see Deferred).
2. **One register page.** A single Gewrit page over every document the household
   has taken in, anchored or not, filterable by role/relation, by anchor kind, by
   *unanchored only* and by missing/stale, sorted by the cached document date,
   searchable only over the cached title (`?q=`). It is a plain indexed Heorth
   query, not a proxied view of Paperless's list. This **reverses** ADR 0017 §6
   ("not a document hub") and the v1 spec's non-goal of the same name, so it has
   to be accepted as a reversal, not slipped in. The first draft of this ADR
   also said "no top-level list"; that was reversed on 2026-09-09 because without
   a register an unanchored document is not merely unlinked but unreachable.
   Cost: new routes and a page; additive once open decision 1 is settled.
3. **The household tag and a tick.** One configured tag (default `household`):
   a scheduler tick, modelled on `src/modules/feoh/import/scheduler.ts` (cursor
   state, classified errors, never throws), sweeps documents carrying it into the
   register with `origin = 'tag'`, and retracts such an entry when the tag goes
   away **only while it is still unanchored** — anchoring is adoption. Because
   Paperless has no `id__gt`, the sweep walks `modified__gt` with
   `ordering=modified` and re-reads its boundary timestamp. The same tick can
   refresh the snapshot, beside or instead of v1's refresh on read. No webhook:
   the `WEBHOOK` action exists and is declined, as ADR 0016 §5 declined one for
   bank lines. Cost: a state table like `feoh_import_state`, an `origin` column
   (`manual` | `tag`), and optionally `created_by` (see open decision 10).
   Additive, but meaningful only after open decision 1.
4. **Thumb and download renditions** beside `preview`, streamed the same way.
   Additive (a provider method or a `rendition` argument, two routes).
5. **The version-header check.** Read `X-Api-Version` / `X-Version` off the first
   response, log them, and treat a version the provider was not built against as
   a classified provider error instead of parsing hopefully. Additive; it closes
   the v1 manual TODO in code.
6. **Richer search.** Paged results, the highlight excerpt from
   `__search_hit__`, and a fallback from `?query=` to `?text=`. Additive.
7. **MCP write tools** in heorth-mcp: file and unfile a document, calling
   Heorth's REST API. Paperless's own API stays unexposed to the model. Additive,
   but the tool names follow open decision 5.
8. **Capture, suggestions** remain deferred (see below), as in the first draft.

### Open decisions

Each is a point where the 2026-09-09 design and the built v1 disagree. None is
decided here. The cost is the cost of moving the built system to the proposed
design.

1. **Unlinked documents vs the exactly-one CHECK and the orphan lifecycle.** The
   proposal makes a document with no anchor a first-class row ("the insurance
   policy on nothing at all"). The build forbids it four ways:
   `gewrit_links_element_check` (exactly one anchor), `sweepOrphans()`,
   `deleteLink()` removing the document with its last link, and the preview
   gate's `EXISTS` on `gewrit_links`. Two routes:
   (a) relax the CHECK to `num_nonnulls(...) <= 1`, so an unanchored *link* is
   the Filing; or (b) let a linkless `gewrit_documents` row *be* the unanchored
   Filing, and retire the sweep, the last-link delete and the `EXISTS` gate.
   Either way the authorisation gate changes — from "has a link" to "has a
   register entry" — and the v1 tests that pin "orphaned row → 404 without a
   provider call" change with it. Cost: a migration (CHECK swap) plus service,
   validator and MCP-guard changes under (a); no migration but a behaviour and
   authorisation change under (b).
2. **Uniqueness: one per thing, or one per role.** The proposal files a document
   at most once per thing (and at most once unanchored), whatever the relation,
   via partial unique indexes. The build allows the same document on the same
   thing once **per role** (`gewrit_links_unique`). Moving to the proposal is a
   migration that fails wherever a document already sits on one thing in two
   roles, and it changes `409 ALREADY_LINKED`. Keeping the build means the
   proposal's "filed at most once against a given thing" is dropped.
3. **`relation` vs `role`, and the vocabulary.** The proposal's column is
   `relation` with `manual, invoice, warranty, contract, receipt, report, other`;
   the build's is `role` with `manual, warranty, invoice, contract, certificate,
   other`. Adding `receipt` and `report` is an additive CHECK change. Dropping
   `certificate` needs a data mapping (the demo seeds one: the car registration).
   Renaming the column breaks the API field, the web types and the MCP output;
   likewise renaming "link" to "Filing" in routes and code.
4. **Stale vs missing.** The proposal marks a gone document with a `staleAt`
   timestamp and answers **410 Gone** from a rendition; the build has
   `status = 'missing'` with automatic recovery and answers **404**. Moving is a
   column change (or both representations) plus a status-code change on the
   preview route. The proposal's point — telling "never existed" from "was here,
   is gone" — is also served by the built `DOCUMENT_NOT_FOUND` message; whether
   that is enough is the decision.
5. **Routes.** The proposal has one surface, `/filings` (list with filters, per
   thing via `?assetId=` etc., `POST`, `PATCH` that may move or clear the anchor,
   `DELETE`, `/filings/:id/{preview,thumb,download}` keyed by **Filing id**),
   plus `/search`, `POST /sync`, `GET /status`. The build has `/links`,
   `/assets/:id/documents`, `/places/:id/documents`, `/documents/search` and
   `/documents/:id/preview` keyed by **document uuid**. Moving is a breaking
   route change for `web/src/api/gewrit.ts` and heorth-mcp unless both surfaces
   are kept as aliases. `/sync` and `/status` are additive either way.
6. **Deep links into Paperless.** The proposal rejects them: a second login on a
   kitchen touchscreen, and it makes the store a household surface ("Paperless's
   UI is an operator tool, never a household surface", as ADR 0016 §3 held for
   Firefly). The build **ships** them (`externalUrl`, "Open in Paperless",
   `gewrit.list_documents`). No schema cost either way; adopting the proposal
   removes a shipped feature and `PAPERLESS_PUBLIC_URL`. Paperless **share
   links** (unauthenticated URLs) were rejected by the proposal and are not used
   by the build — that part agrees.
7. **"Off" means what.** The proposal keeps the register reading, filing and
   unfiling while the provider is off (pure Heorth writes over the cache), with
   search, tick and renditions returning a classified `provider_unavailable`.
   The build mounts **nothing** when `GEWRIT_PROVIDER` is blank (catch-all 404,
   `/features` → `gewrit: false`, UI hidden), in line with Heorth's
   optional-integration rule. Moving changes the mount rule and needs a
   `createLink` path that does not call `getMany`.
8. **Env names.** Proposal: `GEWRIT_ENABLED` (boolean), `PAPERLESS_URL`,
   `PAPERLESS_TOKEN` (encrypted at rest like `library_connections.credentials`),
   `PAPERLESS_HOUSEHOLD_TAG`. Build: `GEWRIT_PROVIDER`, `PAPERLESS_BASE_URL`,
   `PAPERLESS_TOKEN` (plain env), `PAPERLESS_PUBLIC_URL`. `PAPERLESS_HOUSEHOLD_TAG`
   is additive. Renaming the other two breaks operator config (cheap today: no
   `deploy/.env` holds Paperless values yet), and a boolean has no place for the
   demo's `fake`. Encrypting the token at rest is additive but moves it from env
   into the database.
9. **Deploy topology and the demo.** Proposal: Paperless, its Redis and a
   database join `compose.dev.yml` and `compose.prod.yml` on dev port **14005**
   (the `AGENTS.md` port table and the `docs/README.md` allocation change), and
   the demo stack has no provider and seeds Filings that render as unavailable
   (ADR 0012). Build: Paperless is **external** in dev and prod, no port
   reserved, and the demo runs `fake` documents that preview for real. Either
   compose change is small; the decision is which stack shape to own.
10. **Authorship and origin.** The proposal adds `origin` (`manual` | `tag`) and
    `created_by` → `users ON DELETE RESTRICT`, with a CHECK that a manual entry has
    an author. The build has neither. Additive, but `ON DELETE RESTRICT` is a new
    obstacle to hard-deleting a member.
11. **One table or two.** The first draft described a single `gewrit_filings`
    table keyed by Paperless's integer id. The build has two tables keyed by
    `(source, external_id)`. Reaching one table literally is a drop-and-migrate;
    the cheaper route keeps both tables and maps a Filing onto them (open
    decision 1). The built `source` column is what lets the demo `fake` provider
    exist, which the one-table draft had no place for.

### Constraints any later decision keeps

These were decided while building v1 and are not up for renegotiation by
accepting this ADR; a design that needs to change one needs its own argument.

- **The preview content-type allowlist**: PDF, PNG, JPEG, GIF and WebP inline;
  everything else `application/octet-stream` with `Content-Disposition:
  attachment`, never rendered. It applies to every rendition this ADR adds.
- **`Cache-Control: private, no-store` and `X-Content-Type-Options: nosniff`** on
  every streamed rendition. No bytes are written to disk.
- **Search is admin/adult only**, and returns text only. So are the writes.
- **The dedicated `heorth` Paperless user**: what Heorth can see is exactly what
  is shared with that user (ADR 0017 §4). If the household tag is adopted, it
  narrows what the household sees *inside* that reach; it does not replace it.
- From ADR 0017 unchanged: bytes never stored, copied or indexed; search stays in
  Paperless; no OCR text or embeddings in Heorth (ADR 0005/0006 intact); read-only
  provider, nothing written back to Paperless; typed nullable anchor columns, not
  a polymorphic `(type, id)` pair; tools only in heorth-mcp (ADR 0008).

## Consequences (if accepted)

- **Feoh gets its invoice and Weorc its service report** without a new store —
  three domains, one mechanism.
- **The household document gets a home.** An insurance policy or a tax return
  becomes a register entry with no anchor, which only makes sense together with
  the register page; the household itself never becomes an anchor kind.
- **Paperless becomes a household concern in a way it is not yet.** Firefly owns
  no household-visible data (ADR 0016); Paperless owns the household's files. Its
  backup, retention and upgrade path become household concerns, and a Postgres
  dump of Heorth no longer covers everything a member would miss. That is true
  already under ADR 0017, and it grows with the register.
- **A privacy edge exists by construction.** Visibility is per register entry
  and per anchored entity, never per document as Paperless models it. With the
  tag, a mis-set tag publishes a document to the household and untagging retracts
  it a tick later, not at once.
- **The authorisation model changes** under open decision 1, from "has a link"
  to "has a register entry". It stays a single predicate, and it has to remain a
  test, not a convention.
- **ADR 0001 gains a note, not a taxonomy.** A self-hosted system of record — one
  household API token, no tenant, no OAuth app registration — is a sub-case of
  ADR 0001's category, not a fourth provider taxonomy beside 0001, 0003 and 0016.
- **`deploy/` may grow** (open decision 9), and `scripts/check-env-template.mjs`
  fails until `deploy/.env.example` and the compose files agree — the intended
  behaviour.
- **Phase 3 is untouched.** None of this starts before a real household runs
  Heorth.

## Deferred, on purpose

- **Capture** — upload from the phone PWA via `post_document`. Consumption is
  asynchronous, so the flow is upload → store the returned task UUID as a pending
  entry → resolve it to a document id by polling `/api/tasks/?task_id=`. It adds a
  second write path and the first write to Paperless.
- **Suggestions** — a rules table (Paperless tag or correspondent → candidate
  anchor) proposing an anchor for newly consumed documents, confirmed by a
  member. The tag sweep is deliberately not this: it files a document without
  guessing what it belongs to.
- **KithLedger person anchors** — KithLedger is a separate service with a
  separate database, so a person cannot take a foreign key. It would follow
  Feoh's party pattern (cache id and display name) and break the typed-FK
  invariant rather than extend it, so it is its own decision. (ADR 0017's
  Consequences call it "a plain id without a foreign key"; this ADR holds that
  such a column is a different kind of anchor and needs its own ADR.)
- **Meter readings** — structured household data, not documents; if built, they
  belong beside Ethel's facilities.

Plan: [Gewrit — reference documents from paperless-ngx](../plans/gewrit-paperless.md)
(written against the 2026-09-09 draft; the open decisions above take precedence
over it).
