# 0001 — External systems of record behind provider abstractions

**Status:** accepted (2026-07-23)

## Context

The household's life already runs on Microsoft 365 Business: personal + family
calendars, and Microsoft To Do for tasks. Forcing a migration into Heorth-native
calendar/task storage would make adoption all-or-nothing and break the moment a
member accepts a meeting invite in Outlook. At the same time, hard-coding Heorth
against Microsoft Graph would contradict the self-host/local-first philosophy and
block other households (Google, CalDAV, other task backends).

## Decision

For data categories that already have a well-established home in a member's life
(calendars, everyday tasks), the external service **stays the system of record**.
Heorth acts as a synced client that mirrors the data and enriches it with household
metadata (links to meals, maintenance, members).

All such sync goes through a **provider interface** from day one — no vendor API
types leak into module domains. Microsoft 365 (Graph) is merely the first provider;
Google (Calendar/Tasks), CalDAV, and other backends are planned as alternative
providers for the 2.0 horizon.

Phasing per category:

- **Calendar:** phase 1 read-only mirror (M365 → Heorth); phase 2 write-back.
- **Tasks:** mirror everyday tasks from Microsoft To Do; Heorth-native concepts
  (Maintenance Plans for The Home) *project* generated tasks outward into the
  task provider, so all doing happens in one inbox.

Heorth-native storage remains the system of record for domain knowledge no external
service models: The Home, Maintenance Plans, Meals, Feoh, Library.

## Consequences

- Adoption is incremental: the household keeps Outlook/To Do workflows untouched.
- Heorth gains a structural dependency on an OAuth app registration in the
  household's tenant (token storage, quotas) — accepted as honest about where the
  data lives today.
- Two-way sync conflict handling is deferred by the read-first phasing, keeping
  phase 1 shippable.
- The provider interface is extra indirection in v1 with only one implementation —
  deliberate, so 2.0 multi-provider support doesn't require re-architecting.
