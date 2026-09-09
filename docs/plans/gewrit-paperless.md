# Plan — Gewrit: reference documents from paperless-ngx

**Phase:** 5+ (after Phase 3 deployment) · **Governing decision:**
[ADR 0017](../decisions/0017-paperless-ngx-is-the-document-system-of-record.md)
**Level:** concept plan. Implementation happens in `Heorth` and `heorth-mcp`;
this captures the cross-cutting design so a service session can execute it.

**Not started, and not startable yet.** ADR 0015 §5 and ADR 0016 refuse a third
pre-deployment feature slice. This document is the shape, decided while it is
cheap; the work waits for a real household to be running Heorth.

## Goal

The household can reach the document that explains a thing from the thing
itself: the boiler's manual from the boiler, the invoice from the transaction,
the service report from the routine that was completed. It can also reach every
document it cares about from **one register page** — anchored and unanchored
together, so the insurance policy is as reachable as the boiler's manual.
Paperless-ngx keeps the files, the OCR and the search; Heorth keeps the register
and the household meaning.

## Probe status

The API facts below come from a **source read of paperless-ngx v3.1.3** (commit
`b989b74`, 2026-09-08) — `docs/api.md`, `src/documents/filters.py`,
`src/documents/models.py`. **No live instance was queried.** Before slice A is
written, run the live probe against the household's own instance and check the
four things a source read cannot settle:

1. Response shape and field names of `GET /api/documents/?query=...` under
   `Accept: application/json; version=10`, including `__search_hit__`.
2. That `X-Api-Version` / `X-Version` actually arrive on an authenticated
   response, and what the deployed server reports.
3. Content types and sizes coming back from `preview/`, `thumb/` and
   `download/`, and whether `thumb/` is cheap enough to fan out over a list.
4. Whether the deployed instance's `modified` timestamps move on metadata-only
   edits (the tick in slice C depends on it).

Check the response fixture in (1) and (3) into Heorth's tests — one per
rendition — as the drift guard.

## Interface

Heorth-owned types, read-only, three methods (ADR 0017 §3):

```ts
type Rendition = 'preview' | 'thumb' | 'download';

interface DocumentRef {
  documentId: number;        // paperless's own id, root document
  title: string;
  created: string;           // ISO date (API v9+ made this a date, not a datetime)
  correspondent: string | null;
  documentType: string | null;
  tags: string[];            // display strings, never domain concepts
  checksum: string | null;
  pageCount: number | null;
  excerpt: string | null;    // search highlight, search results only
}

interface DocumentPage { items: DocumentRef[]; total: number; nextPage: number | null; }

interface DocumentStream { contentType: string; bytes: ReadableStream; filename: string | null; }

interface TaggedPage { items: DocumentRef[]; nextCursor: string | null; checkpoint: string; }

interface DocumentProvider {
  search(query: string, page: number): Promise<DocumentPage>;
  listTagged(tag: string, cursor: string | null, limit: number): Promise<TaggedPage>;
  get(documentId: number): Promise<DocumentRef | null>;    // null = gone (trashed or deleted)
  getMany(documentIds: number[]): Promise<DocumentRef[]>;  // absent id = gone
  stream(documentId: number, rendition: Rendition): Promise<DocumentStream>;
}
```

Error taxonomy follows `SourceProviderError` in
`src/modules/feoh/import/providers/types.ts` — the only tokens that may reach a
log line or an API response: `no_credentials`, `auth_failed`, `network_error`,
`rate_limited`, `bad_response`, `version_mismatch`, `error`.

The paperless implementation maps: `search` → `/api/documents/?query=` (fall back
to `?text=` when the query has no full-text syntax in it), `listTagged` →
`/api/documents/?tags__name__iexact=<tag>&modified__gt=<cursor>&ordering=modified`,
`get` → `/api/documents/{id}/`, `getMany` → `/api/documents/?id__in=1,2,3` (the
probe confirms `id` takes `in` and `exact` — and **not** `gt`, which is why the
cursor is a timestamp), `stream` →
`/api/documents/{id}/{preview,thumb,download}/`.
`TaggedPage` carries the same cursor/checkpoint split as ADR 0016's
`SourcePage`, for the same reason: the caller never does date arithmetic on a
watermark, and the provider re-windows its own overlap.
Every request carries `Authorization: Token …` and
`Accept: application/json; version=10`.

## Schema

One table (ADR 0017 §5–§9). Names follow Heorth's Drizzle conventions, and the
anchor columns mirror `weorc_routines`:

```
gewrit_filings
  id             uuid pk
  createdAt      timestamptz not null default now()
  updatedAt      timestamptz not null default now()
  documentId     integer not null                   -- paperless root document id
  relation       text not null                      -- manual|invoice|warranty|contract|receipt|report|other
  origin         text not null default 'manual'     -- manual|tag  (§9)
  note           text                               -- why this document is here
  anchorAssetId       uuid null → ethel_assets.id        on delete cascade
  anchorPlaceId       uuid null → ethel_places.id        on delete cascade
  anchorTransactionId uuid null → transactions.id        on delete cascade
  anchorRoutineId     uuid null → weorc_routines.id      on delete cascade
  anchorOccurrenceId  uuid null → weorc_occurrences.id   on delete cascade
  createdBy      uuid null → users.id                on delete restrict
  documentTitle    text                             -- cache (§7)
  documentCreated  date                             -- cache
  documentChecksum text                             -- cache
  cachedAt         timestamptz                      -- cache
  staleAt          timestamptz                      -- set when the document is gone (§10)
```

Constraints:

- CHECK: `num_nonnulls(anchorAssetId, anchorPlaceId, anchorTransactionId,
  anchorRoutineId, anchorOccurrenceId) <= 1` — **at most** one anchor. Zero is
  the household document; the CHECK is the whole of what makes it expressible.
- CHECK: `relation` and `origin` in their enums; `documentId > 0`.
- CHECK: `origin = 'manual'` implies `createdBy is not null` — a tag-swept
  Filing has no author, and pretending it has one would attribute the tick to a
  member. This is why `createdBy` is nullable here, unlike
  `feoh_import_rules.created_by`; it still restricts on delete, so it is one more
  thing to clear before a member can be hard-deleted.
- Five partial unique indexes, one per anchor column
  (`unique(documentId, <col>) where <col> is not null`), plus a sixth,
  `unique(documentId) where <all five> is null` — a document is filed at most
  once against a given thing, and at most once unanchored.
- Index on `documentId` (the proxy's lookup, §11), on `staleAt` where not null,
  and on `documentCreated` (the register's default sort).

State for the tick mirrors `feoh_import_state`: one row, cursor plus health
(`lastRunAt`, `lastError`, `lastErrorAt`), the cursor never exposed over the API.

## REST surface (Heorth)

```
GET    /api/v1/gewrit/filings                     # THE register page: all filings,
                                                  #   ?anchored=true|false &relation=
                                                  #   &anchor=asset|place|transaction|routine|occurrence
                                                  #   &stale=true &q= (cached title only) &page=
GET    /api/v1/gewrit/filings?assetId=|placeId=|transactionId=|routineId=|occurrenceId=
                                                  # the same endpoint, per thing
POST   /api/v1/gewrit/filings                     # { documentId, relation, note?, <one anchor>? }
PATCH  /api/v1/gewrit/filings/:id                 # relation, note, or move/clear the anchor
DELETE /api/v1/gewrit/filings/:id
GET    /api/v1/gewrit/filings/:id/preview         # streams; no-Filing-no-proxy (§11)
GET    /api/v1/gewrit/filings/:id/thumb
GET    /api/v1/gewrit/filings/:id/download
GET    /api/v1/gewrit/search?q=&page=             # delegated to the store, for finding
                                                  #   something to file
POST   /api/v1/gewrit/sync                        # manual tick trigger, classified errors
GET    /api/v1/gewrit/status                      # enabled, provider health, server version,
                                                  #   household tag, stale count, last tick
```

Two things are deliberate here. **The register and the per-thing list are one
endpoint** — the per-thing view is the register with an anchor filter, so there
is one query, one shape and one pagination story rather than two that drift.
And **`?q=` on the register searches only the cached title and relation**
(ADR 0017 §14): finding a document by its *content* is `/search`, which is the
store's job.

The rendition routes are addressed by **Filing id, not document id** — that is
what makes "no Filing, no proxy" structural rather than a check someone has to
remember to write. A stale Filing's rendition route returns 410, not 404: the
household should be able to tell "never existed" from "was here, is gone".

## Slices

**A — The register, filing and viewing (this plan's scope).**
Provider + fake, `gewrit_filings`, the REST surface above, the proxy with its
authorisation test, and **the register page** — one Gewrit page listing every
Filing with the anchored/unanchored and relation filters, plus the same list
embedded on an Ethel asset, a Feoh transaction and a Weorc routine/occurrence
with a document picker. The tick is in scope here rather than deferred, because
without the tag sweep the register only ever shows what somebody attached by
hand: one tick that sweeps `PAPERLESS_HOUSEHOLD_TAG`, refreshes the cache and
sets `staleAt`, with `/sync` and the health fields in `/status`. Plus the
`gewrit.*` MCP tools. `GEWRIT_ENABLED` off by default. Paperless in
`compose.dev.yml` and `compose.prod.yml` on port 14005, absent from the demo
stack, whose seed writes Filings — anchored *and* unanchored — that render as
unavailable.

Slice A is bigger than the first draft of this plan, by roughly the tick. That
is the cost of the register being a local query rather than a live proxy of the
store (ADR 0017 §9), and it is worth it: the page survives a paperless outage
and a hundred-document household loads in one query.

**B — Capture** (deferred, ADR 0017): upload from the phone PWA, a pending
Filing keyed by the consumption task UUID, resolved on the tick.

**C — Suggestions** (deferred): tag/correspondent → candidate *anchor* rules,
member-confirmed. Note this is not the tag sweep: the sweep files a document
without guessing what it belongs to, and that is exactly the line between A and
C.

## Deploy changes (this repo)

`deploy/` is the one runnable thing the meta repo owns, so slice A touches it
here: paperless-ngx + its Redis and (per ADR 0006's bundled-extensions rule) a
database on the shared Postgres container, in `compose.dev.yml` and
`compose.prod.yml`, **not** in `compose.demo.yml`. `PAPERLESS_URL`,
`PAPERLESS_TOKEN`, `PAPERLESS_HOUSEHOLD_TAG` and `GEWRIT_ENABLED` go into
`deploy/.env.example` and the compose files together — `scripts/check-env-template.mjs` fails until they
agree, which is the point. Dev port **14005** (the ports table in `AGENTS.md` and the allocation in
`docs/README.md` both change).

Paperless mints its token in the UI, so dev bring-up cannot fully self-provision
it the way `dev-up.sh` mints Firefly's. Either the bootstrap creates a superuser
non-interactively and issues a token through Django's shell, or `deploy/.env`
gains one hand-pasted value and `dev-up.sh` leaves it alone (it never overwrites
a filled value). Decide in slice A; the hand-pasted value is the honest default.

## Testing

- Provider against the in-memory fake for all five methods plus every error
  token; one checked-in fixture per rendition and one search response.
- The CHECK constraints, at the database and not only in the validator: a Filing
  with **two** anchors is rejected, a Filing with **none** is accepted, and a
  `manual` Filing with no `createdBy` is rejected.
- The partial unique indexes: the same document files twice against two
  different assets, once against one asset, and once unanchored — and a second
  unanchored Filing for the same document is rejected.
- **The authorisation test is the load-bearing one**: a document id that exists
  in paperless and has no Filing must 404 through every rendition route, for
  every member role — including a document that carries the household tag but
  has not yet been swept.
- The register query: anchored and unanchored Filings appear in one list, the
  filters partition it, and `?q=` never reaches the provider.
- Cascade: deleting an asset, a transaction and an occurrence each removes its
  Filings; deleting a Filing removes nothing in paperless.
- Tick: the tag sweep creates `origin='tag'` Filings and is idempotent across
  runs; **untagging removes a tag Filing only while it is unanchored**, and an
  anchored one survives; a trashed document sets `staleAt` and does not delete
  the row; a boundary timestamp shared by two documents loses neither.
- Provider off: the register reads, files and unfiles from cache; search, the
  tick and the renditions return `provider_unavailable`.

## Non-goals (slice A)

Upload; suggestion (anchor-guessing) rules; KithLedger person anchors; document
text in Heorth (ever — ADR 0017 §14); mirroring paperless's permissions; writing
anything back into paperless, including tagging a document from Heorth or
storing a Heorth reference in a custom field; meter readings.

## Open questions

1. **Does the household's paperless instance already exist, with tags and
   correspondents the household actually uses?** If yes, slice A's picker should
   be shaped around that vocabulary rather than a bare search box, and the live
   probe should sample it.
2. ~~Which entity does a *household* document hang on?~~ **Resolved 2026-09-09:
   nothing — a Filing's anchor is optional, and there is one register page that
   lists anchored and unanchored Filings together.** An insurance policy or a tax
   return is a Filing with no anchor; Gewrit gets **no `householdId` anchor
   column**, and the CHECK relaxes from exactly-one to **at most one**
   (ADR 0017 §5, §8). A document reaches the register either because a member
   filed it or because it carries `PAPERLESS_HOUSEHOLD_TAG` and the tick swept it
   in (§9). An earlier resolution of this question on the same day said there
   would be *no* top-level list; that was wrong and is recorded as reversed in the
   ADR, because an unanchored document with no register is unreachable rather than
   merely unattached.
3. **Thumbnail cost on the Hearth View.** If `thumb/` is a per-document round trip
   through Heorth, an asset list with twenty manuals is twenty proxied requests.
   Resolve with the probe: if thumbs are small and cacheable, a short-lived
   in-memory cache in Heorth is enough; if not, the list shows an icon and only
   the detail view fetches.
4. **Backup ownership.** ADR 0017 names this as the real price: paperless holds
   household-visible files, so `docs/manual-todo.md` gains its backup and
   restore-rehearsal items, and the restore has to be rehearsed once before the
   household is told the documents are safe.

5. **One household tag, or a set?** §9 configures a single tag. A household that
   already files by department (`insurance`, `haus`, `auto`) would want several,
   and the sweep is the same query with `tags__id__in`. Left at one until the
   live probe shows what the instance's vocabulary actually is — question 1
   answers this one.
6. **What does the register do about a document the household untagged but a
   member had anchored?** Decided in ADR 0017 §9 — it survives, because
   anchoring is adoption — but the *page* still has to say something sensible
   about a Filing whose document is no longer household-tagged. Probably nothing;
   confirm when the page is designed rather than inventing a badge for it now.
