# 0017 — Gewrit: household documents stay in Paperless-ngx

**Status:** accepted (2026-09-24) · authorises a second pre-deployment slice (ADR 0015 §5)

## Context

The glossary has carried a future **Office** module since the strategy was
accepted: household documents — manuals, warranty certificates, contracts,
floor plans — attached to the things they are about. Until now it said
"documents stay in Library", but Library holds books and films only, so in
practice documents were not in the system at all.

The household already runs Paperless-ngx, which does ingestion, OCR, tagging,
full-text search and storage well. Rebuilding any of that in Heorth would be a
second, weaker copy.

## Decision

1. **The module is named Gewrit** (Old English *gewrit*, "a writing") and
   replaces the Office placeholder. It is built into Heorth, like Ethel and
   Weorc.
2. **Paperless-ngx is the system of record for documents** (ADR 0001). Files
   are hosted in Paperless only. Heorth stores a *reference* to a document and a
   small metadata snapshot (title, type, correspondent, date, last seen), and
   never the file.
3. **Links are Heorth's.** A link attaches one document to one Ethel asset or
   place in a role (`manual`, `warranty`, `invoice`, `contract`, `certificate`,
   `other`). Documents and links are separate tables, so one document can belong
   to several elements. v1 links to Ethel only.
4. **One household credential.** Heorth talks to Paperless as a dedicated
   `heorth` user through `PAPERLESS_TOKEN`. What Heorth can see is exactly what
   is shared with that user. Paperless's per-member permissions are not applied
   inside Heorth; per-member access is a later decision beside ADR 0004.
5. **Preview is streamed, never stored.** Heorth proxies the preview of a
   *linked* document to the browser, inline only for PDF and raster images, and
   as a download for everything else. It is not a proxy onto the whole Paperless
   instance: search returns text only, and only admins and adults may search.
6. **Search stays in Paperless.** Heorth offers a search picker for linking, not
   a document hub.
7. **Optional per deployment.** `GEWRIT_PROVIDER` is `paperless`, `fake` (the
   demo stack, ADR 0012) or blank (off, module not mounted).
8. **Sequencing (ADR 0015 §5).** Gewrit v1 is a second pre-deployment feature
   slice after bank ingestion (ADR 0016), and this ADR is the one ADR 0015 §5
   requires before such a slice starts. Phase 3 deployment follows Gewrit v1;
   a third pre-deployment slice would need its own ADR again.

## Consequences

- The Documents panel keeps working from the snapshot while Paperless is down;
  preview, search and linking need Paperless and fail with a clear 502.
- A document deleted or unshared in Paperless shows as "missing" until a member
  removes the link; nothing is cleaned up silently.
- Weorc routines, KithLedger people and Feoh items are not linkable in v1. Each
  is one nullable column and a wider CHECK later; a KithLedger person would be a
  plain id without a foreign key.
- Household facts about a document (contract end, notice period) and reminders
  derived from them are out of scope; they would be a new decision.

Spec: `docs/superpowers/specs/2026-09-24-gewrit-v1-document-references-design.md`.
