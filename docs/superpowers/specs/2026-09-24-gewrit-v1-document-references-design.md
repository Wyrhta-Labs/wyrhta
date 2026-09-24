# Gewrit v1 — document references backed by Paperless-ngx — design

**Date:** 2026-09-24 · **Decision:** ADR 0017 (to be written as the first task of the plan)

**Status:** implemented 2026-09-24; ships with the Heorth v0.9.0 tag. Implementation plan:
[2026-09-24-gewrit-v1](../plans/2026-09-24-gewrit-v1.md). Settled at planning
time: provider errors are a `DocumentProviderError` class recognised by duck
typing; the demo provider generates its PDFs in code; the Paperless API version
is pinned to 10; places get their panel from the place manager.

**Target repos — this is at least three commits**, per `AGENTS.md` ("one change, one
repo, one commit"): the module, schema, migration, web panel and tests land in
`Wyrhta-Labs/Heorth`; the two read-only tools land in `Wyrhta-Labs/heorth-mcp`; the
ADR, the glossary and strategy updates, the env templates and the demo seed land in
this meta repo. Neither repo is ever staged from another.

**Gewrit** (Old English *gewrit*, "a writing, a document") is the module the
glossary so far called **Office**. It gives Heorth a database of *references* to
household documents and attaches them to the things they are about: the heating
system's manual, the car's registration, the floor plan of the ground floor.
Paperless-ngx is the system of record for the documents themselves. Files are
hosted in Paperless only; Heorth never stores them and only streams a preview
through while a member is looking at it.

## Goals and non-goals

**In v1:**

- Link an existing Paperless document to an Ethel **asset** (including assets with
  a vehicle or facility detail row) or an Ethel **place**, with a role.
- Show a "Documents" panel on the asset and place detail pages.
- Find a document to link by searching Paperless from Heorth, or by pasting a
  Paperless URL or document id.
- Preview a linked document inline in the Heorth UI, streamed from Paperless.
- Keep the panels readable while Paperless is down, from a local metadata snapshot.
- Two read-only MCP tools in heorth-mcp.
- A fake provider with seeded documents in the demo stack.

**Out, deliberately:**

- Uploading, OCR, tagging or editing documents from Heorth — that is Paperless's job.
- A document hub in Heorth (its own list, filters, full-text search over the
  snapshot). Search stays in Paperless.
- Links to Weorc routines, KithLedger people or Feoh items. The link table is shaped
  so each is one column and a wider CHECK later (see §2).
- Household facts on a document (contract end, notice period, warranty end) and
  reminders derived from them.
- Per-member Paperless credentials and Paperless's per-document permissions. One
  household credential; the boundary is what is shared with the `heorth` user in
  Paperless.
- Thumbnails in the search picker (see §3, preview gate).
- Links driven from Paperless (custom fields or tags synced into Heorth).
- A Paperless container in the Wyrhta compose stacks. Dev and prod point at an
  existing, external Paperless instance.

## 1. Architecture and seams

Gewrit is a built-in Heorth module at `src/modules/gewrit/`, registered like every
other module and mounted at `/api/v1/gewrit`. The dependency runs **Gewrit → Ethel**
and stays a read, the same direction Weorc's anchors take: Ethel never imports
Gewrit. The asset and place pages in the web UI render a panel that calls Gewrit's
API; Ethel's routes are unchanged.

All contact with Paperless goes through a provider interface (ADR 0001). No
Paperless type, URL or error body leaves the provider.

```ts
interface DocumentProvider {
  id: 'paperless' | 'fake';
  /** Full-text search. At most `limit` hits, in the provider's relevance order. */
  search(query: string, limit: number): Promise<DocumentMeta[]>;
  /** Metadata for the given ids. Ids the provider does not return are absent. */
  getMany(externalIds: string[]): Promise<DocumentMeta[]>;
  /** The inline preview (archived PDF, else original). */
  openPreview(externalId: string): Promise<DocumentStream>;
  /** The external UI link for "Open in Paperless", or null. */
  externalUrl(externalId: string): string | null;
  /** Maps a thrown value to a short safe reason token. Never token material. */
  classifyError(e: unknown): 'unreachable' | 'timeout' | 'auth' | 'not_found' | 'upstream';
}

interface DocumentMeta {
  externalId: string;       // Paperless document id, as a decimal string
  title: string;
  documentType: string | null;
  correspondent: string | null;
  createdOn: string | null; // YYYY-MM-DD
}

interface DocumentStream {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength: number | null;
}
```

`providers/paperless.ts` implements it against the Paperless REST API with
`Authorization: Token <PAPERLESS_TOKEN>`. Every JSON call pins the API version with
`Accept: application/json; version=<N>`, where `<N>` is a constant in the provider,
set at implementation time to the current Paperless API version and covered by a
test. An unpinned client gets whatever version the server defaults to, which can
change the response shape under Heorth on a Paperless upgrade.

| Provider call | Paperless endpoint |
|---|---|
| `search` | `GET /api/documents/?query=<q>&page_size=<limit>` |
| `getMany` | `GET /api/documents/?id__in=<ids>&page_size=<n>` |
| `openPreview` | `GET /api/documents/<id>/preview/` |
| `externalUrl` | `<PAPERLESS_PUBLIC_URL or PAPERLESS_BASE_URL>/documents/<id>/details` |

Document type and correspondent come back from Paperless as ids. The provider
resolves them to names through `GET /api/document_types/` and
`GET /api/correspondents/`, cached in process for 10 minutes. A stale name for up to
ten minutes is acceptable. Paperless applies object permissions to types and
correspondents as well as to documents: a name the `heorth` user cannot see, or a
failed lookup, degrades that field to `null` and never fails the call.

Every call has a timeout: 3 s for `getMany` during a list refresh, 8 s for `search`
and for the first byte of `openPreview`. The preview body itself streams without a
total timeout.

`providers/fake.ts` holds four fixed documents in code (a boiler manual, a boiler
warranty certificate, a car registration, a ground-floor plan) and serves one small
bundled sample PDF, committed under the module, as the preview of each. It never
opens a network connection.

### Configuration

| Variable | Meaning |
|---|---|
| `GEWRIT_PROVIDER` | `paperless`, `fake`, or blank. Blank means Gewrit is off. |
| `PAPERLESS_BASE_URL` | Base URL Heorth uses to reach Paperless. Required when the provider is `paperless`. |
| `PAPERLESS_TOKEN` | API token of the dedicated `heorth` user in Paperless. Required when the provider is `paperless`. |
| `PAPERLESS_PUBLIC_URL` | Optional. The URL members' browsers use for "Open in Paperless", when it differs from the base URL. |

The env check follows the `FEOH_IMPORT_ENABLED` precedent: `paperless` with a blank
`PAPERLESS_BASE_URL` or `PAPERLESS_TOKEN` fails startup and names the missing
variables. The `PAPERLESS_*` values may be present while the provider is blank.
`PAPERLESS_BASE_URL` is read from env only and is never taken from a request.

When Gewrit is off, the module registers as a **no-op** and mounts no routes, per
Heorth's optional-integration rule (Heorth `AGENTS.md`): every Gewrit path falls
through to the catch-all `404 NOT_FOUND`, and `/api/v1/features` reports
`gewrit: false` so the UI hides the panels. The provider resolves through a
`getGewritRuntime()` / `setGewritRuntime()` seam like `getKithRuntime`, so tests
install the in-memory fake without env.

## 2. Data model

Two tables. A document and the links to it are separate rows so that one
document — the household insurance policy — can belong to several elements without
being duplicated, and so that the role belongs to the link: the same PDF can be the
invoice for one asset and the warranty proof for another.

### `gewrit_documents`

One row per provider document Heorth knows about. The snapshot is a copy for
display and resilience, never the truth.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | `gen_random_uuid()` |
| `created_at`, `updated_at` | timestamptz | module convention |
| `source` | text NOT NULL | `'paperless'` or `'fake'`; CHECK |
| `external_id` | text NOT NULL | the provider's document id |
| `title` | text NOT NULL | snapshot |
| `document_type` | text NULL | snapshot, resolved name |
| `correspondent` | text NULL | snapshot, resolved name |
| `created_on` | date NULL | snapshot, the document's own date |
| `status` | text NOT NULL default `'available'` | `available` \| `missing`; CHECK |
| `last_seen_at` | timestamptz NOT NULL | last successful live read |

Unique on (`source`, `external_id`).

### `gewrit_links`

One document attached to one element in one role.

| column | type | notes |
|---|---|---|
| `id` | uuid PK | |
| `created_at`, `updated_at` | timestamptz | |
| `document_id` | uuid NOT NULL → `gewrit_documents.id` | ON DELETE CASCADE |
| `asset_id` | uuid NULL → `ethel_assets.id` | ON DELETE CASCADE |
| `place_id` | uuid NULL → `ethel_places.id` | ON DELETE CASCADE |
| `role` | text NOT NULL | `manual` \| `warranty` \| `invoice` \| `contract` \| `certificate` \| `other`; CHECK |
| `note` | text NULL | free text, trimmed, max 500 chars |

- CHECK: exactly one of `asset_id`, `place_id` is set.
- Unique on (`document_id`, `asset_id`, `place_id`, `role`) with `NULLS NOT
  DISTINCT` — the same document may be linked to the same element twice only in
  different roles. Like `ethel_places_parent_name_unique`, this may need a raw
  statement in the migration if drizzle cannot express it.
- Indexes on `asset_id` and `place_id`.

One nullable column per element type, as Weorc's anchors do, rather than a
polymorphic `element_type` + `element_id` pair: it keeps real foreign keys and
cascades. A later element type is one column and a wider CHECK; a KithLedger person
would be a plain id without a foreign key, since it lives in another service.

**Deleting.** Deleting an asset or place cascades to its links. When a link is
deleted directly and it was the document's last link, the service deletes the
`gewrit_documents` row in the same transaction. A cascade from Ethel cannot do
that — Ethel does not know Gewrit exists — so rows orphaned that way are removed by
a sweep at the start of each list refresh:
`DELETE FROM gewrit_documents d WHERE NOT EXISTS (SELECT 1 FROM gewrit_links l WHERE
l.document_id = d.id) AND d.updated_at < now() - interval '1 hour'`. The age guard
keeps the sweep off a row that a concurrent link request has just upserted but not
yet linked (§3, *Linking*, touches `updated_at`). An orphan is harmless while it
waits: nothing lists it, and the preview gate requires a link (§3). Nothing is ever
deleted in Paperless.

## 3. API and data flow

All routes require an authenticated member (`requireAuth`), as every Heorth route
does. **Search and the write routes** — `GET /documents/search` and `POST`,
`PATCH`, `DELETE` on `/links` — additionally require `requireRole('admin',
'adult')`, the same `canWrite` guard Ethel and Weorc use. Search is on that side
because it reaches every document shared with the `heorth` user, linked or not, and
only the members who can link need it. The element lists and the preview of
*linked* documents are readable by every member. Ids in paths are validated before
any provider call: Heorth uuids as uuids, provider ids as `^[1-9][0-9]{0,9}$`.

Responses use `ok` / `err` from `@wyrhta/core/http`, as every Heorth route does:
success is `{ data, meta? }`, failure is `{ error: { code, message } }` with an
upper-case code. The preview route is the one exception, since its success body is
the file itself; its failures still use `err`.

| Route | Behaviour |
|---|---|
| `GET /api/v1/gewrit/documents/search?q=` | `q` trimmed, 2–200 chars. Calls `search(q, 25)`, returns the hits. Writes nothing. |
| `GET /api/v1/gewrit/assets/:id/documents` | The asset's links with their documents, grouped by role in the UI. 404 if the asset does not exist. |
| `GET /api/v1/gewrit/places/:id/documents` | The same for a place. |
| `POST /api/v1/gewrit/links` | Body `{ externalId, assetId \| placeId, role, note? }`. See *Linking*. |
| `PATCH /api/v1/gewrit/links/:id` | Body `{ role?, note? }`. A role change that collides with the unique key is 409. |
| `DELETE /api/v1/gewrit/links/:id` | Deletes the link, and the document row if it was the last link. |
| `GET /api/v1/gewrit/documents/:id/preview` | `:id` is the Heorth document uuid. See *Preview*. |

A list response is (`stale` sits in `meta`, the links in `data`):

```json
{
  "meta": { "stale": false },
  "data": [
    {
      "id": "…", "role": "manual", "note": null,
      "document": {
        "id": "…", "externalId": "412", "title": "Vitodens 200-W Bedienungsanleitung",
        "documentType": "Manual", "correspondent": "Viessmann", "createdOn": "2019-03-11",
        "status": "available", "lastSeenAt": "…", "externalUrl": "https://…/documents/412/details"
      }
    }
  ]
}
```

### Linking

1. Validate the body; the element must exist (422 otherwise).
2. `getMany([externalId])` live. Absent → `422 DOCUMENT_NOT_FOUND`. Provider
   failure → `502 PROVIDER_UNAVAILABLE` or `502 PROVIDER_AUTH`.
3. In **one transaction**: upsert `gewrit_documents` on (`source`, `external_id`)
   with the fresh snapshot, `status='available'`, `last_seen_at=now()`,
   `updated_at=now()`; then insert the link. Duplicate → `409 ALREADY_LINKED`, and
   the transaction rolls back. The provider call in step 2 stays outside the
   transaction, so no lock is held across a network request.

Paste is not a separate route: the UI extracts the id from a pasted Paperless URL
(`/documents/<id>/…`) or takes a bare number, and posts it.

### Snapshot refresh on read

A list request first sweeps orphaned document rows, then loads the element's links
and documents. For documents whose `last_seen_at` is older than 15 minutes, it makes
one batched `getMany` call with the 3 s timeout:

- Returned ids: update the snapshot, `status='available'`, `last_seen_at=now()`.
- Ids the provider does not return: `status='missing'`. A missing document that
  reappears later becomes `available` again on the next refresh.
- Any provider failure: no row changes, and the response carries `meta.stale: true`.

The response is always built from the database after the refresh, so a failed
refresh degrades to the last known snapshot instead of an error.

### Preview

1. Load the `gewrit_documents` row by uuid **that has at least one
   `gewrit_links` row**. Otherwise → 404. **Only linked documents can be
   previewed**; Heorth is not a proxy onto the whole Paperless instance, and an
   orphan waiting for the sweep is not previewable. This is also why the search
   picker shows text only.
2. `openPreview(externalId)`. Not found → mark the row `missing`, answer 404.
   Other failures → 502 as above.
3. Decide the disposition from the upstream `Content-Type` against an allowlist:
   `application/pdf`, `image/png`, `image/jpeg`, `image/gif`, `image/webp`. An
   allowlisted type is served with that type and `Content-Disposition: inline`.
   **Everything else** — HTML, XML, SVG, text, unknown or missing — is served as
   `application/octet-stream` with `Content-Disposition: attachment`, so active
   content from a stored document can never execute in Heorth's origin.
4. Stream the body through with `Cache-Control: private, no-store` and
   `X-Content-Type-Options: nosniff` set by Heorth. Upstream headers are otherwise
   dropped. Nothing is buffered to disk or held whole in memory. If the client
   disconnects, the upstream request is aborted.

**`Content-Length`.** The provider sends `Accept-Encoding: identity` on the preview
request, so the bytes Heorth streams are the bytes Paperless counted. Node's
`fetch` decompresses a compressed body but keeps the compressed `Content-Length`
(undici #2514); passing that length on would truncate the download. Heorth forwards
`Content-Length` only when the upstream response carries no `Content-Encoding`, and
otherwise omits it and lets the response stream chunked.

**What actually protects the origin.** The UI never loads the preview URL directly.
It fetches the bytes and renders them from a `blob:` URL, which takes the page's
origin and none of the response's headers — so a `Content-Security-Policy` on the
preview response would protect nothing and is not set. The protection is the
content-type allowlist in step 3, applied twice: by the server when it picks the
type, and by the UI when it picks how to render.

The web UI authenticates with a Bearer header, which `<iframe src>` and `<img src>`
cannot send. The panel fetches the preview as a blob and branches on the
**response's** content type: `application/pdf` in an `<iframe>` using the browser's
built-in viewer, allowlisted images in an `<img>`, and anything else as an
`<a download>` link, never rendered. It revokes the object URL when the modal
closes. The PDF `<iframe>` carries no `sandbox` attribute: Chrome's and Firefox's
built-in PDF viewers refuse to render in a sandboxed frame, and a PDF is not HTML
in Heorth's origin. The implementation checks both browsers once by hand.

## 4. Error behaviour

| Situation | API | UI |
|---|---|---|
| Gewrit off | no routes mounted; catch-all `404 NOT_FOUND` | panels hidden via `/features` |
| Paperless unreachable / timeout | lists: 200 with `meta.stale: true`; search, link, preview: `502 PROVIDER_UNAVAILABLE` | hint "Paperless is not reachable"; list still shown |
| Paperless 401/403 | `502 PROVIDER_AUTH`, logged with the reason token | "Gewrit is not configured correctly" — no detail |
| Document deleted in Paperless | `status='missing'` on the next refresh or preview | link greyed out, "deleted in Paperless", remove button |
| Duplicate link | `409 ALREADY_LINKED` | inline message in the dialog |
| Invalid id or body | 400 / 422 before any provider call | form validation |

The Paperless token is never logged, never returned and never part of an error.
Upstream response bodies are never passed on.

## 5. Web UI

- A **Documents** panel on the asset detail page and the place detail page, shown
  when `features.gewrit` is true. Links are grouped by role; each row shows title,
  type, correspondent and date, and missing documents are greyed out.
- **Link document** opens a dialog: a debounced search field (text-only hits), a
  paste field that accepts a Paperless URL or id, a role select and an optional
  note.
- Clicking a document opens a **preview modal** with "Open in Paperless" (when
  `externalUrl` is set), "Edit" (role, note) and "Remove link".
- Strings in German and English through the existing `i18n`.

## 6. heorth-mcp

Two read-only tools, calling Heorth's REST API with the caller's `he_` key
(ADR 0008), in a separate commit after the Heorth release:

- `gewrit.list_documents({ assetId } | { placeId })` — the element's links with
  document metadata and `externalUrl`.
- `gewrit.search({ q })` — the search route. Like the route, it answers only for an admin or adult key; Heorth enforces that, the tool does not duplicate it.

The dotted names follow heorth-mcp's existing namespace convention
(`ethel.list_assets`).

No preview tool: an agent has no use for PDF bytes. No write tools in v1.

## 7. Deployment

- **Dev and prod:** no Paperless container is added. `deploy/.env.example` gains
  `GEWRIT_PROVIDER`, `PAPERLESS_BASE_URL`, `PAPERLESS_TOKEN` and
  `PAPERLESS_PUBLIC_URL` as one block, blank by default. `compose.dev.yml` and
  `compose.prod.yml` pass them to Heorth, and `scripts/check-env-template.mjs` must
  pass. That script only compares the compose files with the template; it cannot
  see a variable missing from both, so the schema side is covered by Heorth's env
  tests (§9) listing all four variables. Operator setup, documented in the Heorth
  README: create a `heorth` user in Paperless; give it **view** permission on the
  documents to be linked **and** on the document types and correspondents they use
  (without the latter the names show as blank, §1); create its API token.
- **Demo (ADR 0012):** `compose.demo.yml` sets `GEWRIT_PROVIDER: fake` and no
  `PAPERLESS_*` values. `deploy/seed-demo.mjs` links the fake documents through
  `POST /api/v1/gewrit/links` to the seeded boiler, car and ground floor. The demo
  reaches no external system.

## 8. Documentation

- **ADR 0017** — Gewrit: household documents stay in Paperless-ngx, Heorth keeps
  references and a snapshot; one household credential; preview streamed, never
  stored.
- **`CONTEXT.md`** — replace the **Office** (future) entry with **Gewrit**, and
  change "documents stay in Library" in the Ethel entry to point at Gewrit.
- **`docs/strategy.md`** — move the Office line from the later backlog to the
  current phase as Gewrit v1.
- **Heorth README** — the operator setup above.

## 9. Testing

- **Provider unit tests** (`paperless.ts`) against a stubbed `fetch`: response
  mapping including type and correspondent names, a hidden or failing taxonomy
  lookup → `null` names, the pinned `Accept` version header on every JSON call,
  `id__in` batching, 404 → absent, 401/403 → `auth`, timeout → `timeout`, and that
  the token appears in no thrown error or log line.
- **Service and route tests** on the `_test` database with an in-memory fake
  `DocumentProvider`: link happy path, `DOCUMENT_NOT_FOUND`, `ALREADY_LINKED`, the
  exactly-one CHECK, role change collision, refresh updates the snapshot, absent id
  becomes `missing` and reappears as `available`, provider outage gives
  `meta.stale: true` with rows unchanged, orphan sweep including its one-hour age guard,
  last-link delete removes the document row, asset and place deletion cascade,
  catch-all `404 NOT_FOUND` when off (no routes mounted), search and write routes refused for a non-adult member (403) and element lists and preview
  allowed, and the preview gate (unknown uuid and orphaned row → 404 without
  a provider call).
- **Streaming test:** allowlisted PDF and image types served inline with their
  type; HTML, SVG, text and a missing type served as `application/octet-stream`
  attachment; `Accept-Encoding: identity` sent upstream; `Content-Length` forwarded
  for an unencoded upstream and dropped for a `Content-Encoding` one; the two
  headers set, no CSP header, other upstream
  headers dropped, a client abort aborts upstream.
- **Env tests:** `paperless` with missing values fails startup and names them; all
  four variables are in the schema (the half `check-env-template.mjs` cannot see).
- **Web tests:** panel hidden when the feature is off, grouping by role, missing
  state, paste parsing (URL and bare id), stale hint.
- **heorth-mcp:** the two tools against a stubbed Heorth API.

## Open questions

None blocking. Two to watch after v1:

- Whether members want the snapshot searchable in Heorth after all — that would be
  the hub option this design declined, and a new decision.
- Whether the household needs documents that only one member can see — that is the
  per-member credential option, and belongs with ADR 0004's access model.
