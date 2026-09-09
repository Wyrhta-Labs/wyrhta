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
the service report from the routine that was completed. Paperless-ngx keeps the
files, the OCR and the search; Heorth keeps the links and the household meaning.

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

interface DocumentProvider {
  search(query: string, page: number): Promise<DocumentPage>;
  get(documentId: number): Promise<DocumentRef | null>;   // null = gone (trashed or deleted)
  stream(documentId: number, rendition: Rendition): Promise<DocumentStream>;
}
```

Error taxonomy follows `SourceProviderError` in
`src/modules/feoh/import/providers/types.ts` — the only tokens that may reach a
log line or an API response: `no_credentials`, `auth_failed`, `network_error`,
`rate_limited`, `bad_response`, `version_mismatch`, `error`.

The paperless implementation maps: `search` → `/api/documents/?query=` (fall back
to `?text=` when the query has no full-text syntax in it), `get` →
`/api/documents/{id}/`, `stream` → `/api/documents/{id}/{preview,thumb,download}/`.
Every request carries `Authorization: Token …` and
`Accept: application/json; version=10`.

## Schema

One table (ADR 0017 §5–§7). Names follow Heorth's Drizzle conventions:

```
gewrit_document_links
  id             uuid pk
  createdAt      timestamptz not null default now()
  updatedAt      timestamptz not null default now()
  documentId     integer not null                  -- paperless root document id
  relation       text not null                     -- manual|invoice|warranty|contract|receipt|report|other
  note           text                              -- why this document is here
  assetId        uuid null → ethel_assets.id        on delete cascade
  placeId        uuid null → ethel_places.id        on delete cascade
  transactionId  uuid null → transactions.id        on delete cascade
  routineId      uuid null → weorc_routines.id      on delete cascade
  occurrenceId   uuid null → weorc_occurrences.id   on delete cascade
  createdBy      uuid not null → users.id           on delete restrict
  documentTitle    text                            -- cache (§7)
  documentCreated  date                            -- cache
  documentChecksum text                            -- cache
  cachedAt         timestamptz                     -- cache
  staleAt          timestamptz                     -- set when the document is gone (§9)
```

Constraints:

- CHECK: exactly one of the five target columns is non-null — the ADR 0014 anchor
  shape, written as a five-term `num_nonnulls(...) = 1`.
- CHECK: `relation` in the enum; `documentId > 0`.
- UNIQUE per (target column, `documentId`, `relation`) — the same document may be
  an `invoice` on a transaction and a `warranty` on an asset, but not twice on the
  same pair. Postgres cannot express "unique over whichever column is set", so
  this is five partial unique indexes, one per target, each with the `IS NOT NULL`
  predicate.
- Index on `documentId` (the proxy's lookup in §10) and on `staleAt` where not
  null.

`createdBy` with `on delete restrict` is one more thing to clear before a member
can be hard-deleted — the same class as `transactions.created_by` and
`feoh_import_rules.created_by`, and named as such in ADR 0016's consequences.

State for the tick mirrors `feoh_import_state`: one row, cursor plus health
(`lastRunAt`, `lastError`, `lastErrorAt`), the cursor never exposed over the API.

## REST surface (Heorth)

```
GET    /api/v1/gewrit/documents?q=&page=          # delegated search, provider-backed
GET    /api/v1/gewrit/links?assetId=|placeId=|transactionId=|routineId=|occurrenceId=
POST   /api/v1/gewrit/links                       # { documentId, relation, note?, <one target> }
PATCH  /api/v1/gewrit/links/:id                   # relation, note
DELETE /api/v1/gewrit/links/:id
GET    /api/v1/gewrit/links/:id/preview           # streams; no-link-no-proxy (§10)
GET    /api/v1/gewrit/links/:id/thumb
GET    /api/v1/gewrit/links/:id/download
POST   /api/v1/gewrit/sync                        # manual tick trigger, classified errors
GET    /api/v1/gewrit/status                      # enabled, provider health, server version, stale count
```

The rendition routes are addressed by **link id, not document id** — that is what
makes "no link, no proxy" structural rather than a check someone has to remember
to write. A stale link's rendition route returns 410, not 404: the household
should be able to tell "never existed" from "was here, is gone".

## Slices

**A — Link and view (this plan's scope).**
Provider + fake, the table, the REST surface above minus `/sync`, the proxy with
its authorisation test, a document picker in the web UI reachable from an Ethel
asset, a Feoh transaction and a Weorc routine/occurrence, and the `gewrit.*` MCP
tools. `GEWRIT_ENABLED` off by default. Paperless in `compose.dev.yml` and the
prod compose on port 14005, absent from the demo stack, whose seed writes link
rows that render unavailable.

**B — Capture** (deferred, ADR 0017): upload from the phone PWA, pending link
keyed by the consumption task UUID, resolved on the tick.

**C — Freshness and rot** (foldable into A if it stays small): the scheduler tick
that refreshes the cache and sets `staleAt`, `modified__gt` cursor with the
boundary re-read, `/sync` and the health fields in `/status`.

**D — Suggestions** (deferred): tag/correspondent → candidate entity rules,
member-confirmed.

## Deploy changes (this repo)

`deploy/` is the one runnable thing the meta repo owns, so slice A touches it
here: paperless-ngx + its Redis and (per ADR 0006's bundled-extensions rule) a
database on the shared Postgres container, in `compose.dev.yml` and
`compose.prod.yml`, **not** in `compose.demo.yml`. `PAPERLESS_URL`,
`PAPERLESS_TOKEN` and `GEWRIT_ENABLED` go into `deploy/.env.example` and the
compose files together — `scripts/check-env-template.mjs` fails until they agree, which is the
point. Dev port **14005** (the ports table in `AGENTS.md` and the allocation in
`docs/README.md` both change).

Paperless mints its token in the UI, so dev bring-up cannot fully self-provision
it the way `dev-up.sh` mints Firefly's. Either the bootstrap creates a superuser
non-interactively and issues a token through Django's shell, or `deploy/.env`
gains one hand-pasted value and `dev-up.sh` leaves it alone (it never overwrites
a filled value). Decide in slice A; the hand-pasted value is the honest default.

## Testing

- Provider against the in-memory fake for all three methods plus every error
  token; one checked-in fixture per rendition and one search response.
- The CHECK constraint: a link with zero targets and a link with two are both
  rejected at the database, not only in the validator.
- **The authorisation test is the load-bearing one**: a document id that exists
  in paperless and is not linked must 404 through every rendition route, for
  every member role.
- Cascade: deleting an asset, a transaction and an occurrence each removes its
  links; deleting a link removes nothing in paperless.
- Tick: a trashed document sets `staleAt` and does not delete the row; a
  boundary timestamp shared by two documents loses neither.
- Provider off: link CRUD works, search and renditions return
  `provider_unavailable`.

## Non-goals (slice A)

Upload; suggestion rules; KithLedger person links; document text in Heorth (ever
— ADR 0017 §13); mirroring paperless's permissions; writing anything back into
paperless, including a Heorth reference in a custom field; meter readings.

## Open questions

1. **Does the household's paperless instance already exist, with tags and
   correspondents the household actually uses?** If yes, slice A's picker should
   be shaped around that vocabulary rather than a bare search box, and the live
   probe should sample it.
2. ~~Which entity does a *household* document hang on?~~ **Resolved 2026-09-09:
   it hangs on nothing — documents can be unlinked.** An insurance policy or a
   tax return stays in paperless with no link row, and Gewrit gets **no
   `householdId` target column**. The CHECK in §5 keeps exactly-one-target, so
   slice A's schema needs no extra column, and the picker never has to offer
   "the household" as a thing to attach to. What follows from it: Gewrit's list
   views are always *per entity* — there is no Gewrit index page listing every
   household document, because that page is paperless's own UI, which the
   operator has and the household does not need (ADR 0017 §11).
3. **Thumbnail cost on the Hearth View.** If `thumb/` is a per-document round trip
   through Heorth, an asset list with twenty manuals is twenty proxied requests.
   Resolve with the probe: if thumbs are small and cacheable, a short-lived
   in-memory cache in Heorth is enough; if not, the list shows an icon and only
   the detail view fetches.
4. **Backup ownership.** ADR 0017 names this as the real price: paperless holds
   household-visible files, so `docs/manual-todo.md` gains its backup and
   restore-rehearsal items, and the restore has to be rehearsed once before the
   household is told the documents are safe.
