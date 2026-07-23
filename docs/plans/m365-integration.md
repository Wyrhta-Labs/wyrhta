# Plan — Microsoft 365 integration (Calendar mirror + To Do sync)

**Phase:** 1 (acceptance release) · **Governing decision:** ADR 0001
**Level:** concept plan. Implementation happens in the Heorth repo; this captures
the cross-cutting design so a Heorth session can execute it.

## Goal

Heorth mirrors the household's M365 personal + family calendars (read-only) and
syncs everyday tasks with Microsoft To Do — both behind provider interfaces, no
Graph types leaking into module domains.

## Auth model (the riskiest unknown — resolve first)

Constraint that forces the decision: **the Graph To Do API supports delegated
permissions only** (no application permissions). So per-member delegated tokens
are required for tasks regardless; using the same model for calendars keeps one
auth path.

- App registration in the household tenant, **delegated** scopes:
  `Calendars.Read` (write-back later: `Calendars.ReadWrite`), `Tasks.ReadWrite`,
  `offline_access`, `User.Read`.
- Each member connects their account once (auth-code flow from Heorth settings;
  device-code flow as fallback). Heorth stores refresh tokens **encrypted at
  rest** (Library's credential-crypto pattern generalises; consider moving that
  helper to core if reuse is verbatim).
- The shared **family calendar** may be a group/shared calendar — verify which
  kind it actually is in the tenant early, since shared-calendar delegated access
  is the classic Graph gotcha. Verify against the real tenant in week one.

## Provider interfaces (in Heorth)

- `CalendarProvider`: `listCalendars()`, `pullChanges(syncToken?) → {events[],
  nextToken}` — delta-based, provider-agnostic event shape mapped to Heorth's
  calendar domain. Graph implementation uses `/calendarView/delta` per calendar.
- `TaskProvider`: `pullChanges(...)` plus `createTask(...)` (outward projection —
  needed by Maintenance Plans in Phase 4, useful for quick-capture in Phase 1).
- Native Heorth events remain possible; mirrored items carry `(provider,
  externalId, memberAccount)` and are read-only in Heorth during phase 1.

## Sync mechanics

- **Polling first** (delta queries every few minutes) — simple, testable, good
  enough for a household. Graph change-notification webhooks (the FQDN makes them
  feasible) are an optimisation, not a requirement; subscriptions expire and need
  renewal machinery — defer.
- Sync state per (member, calendar/list): delta token, last success, last error —
  surfaced in a small settings/health UI ("wife-debuggable": a red badge and a
  "reconnect" button, not logs).
- Rate limits: per-mailbox throttling is generous at household scale; simple
  backoff on 429 suffices.

## Non-goals (phase 1)

Calendar write-back; attendee/invite handling; webhooks; providers other than
Graph (the interface is the preparation, Google/CalDAV land toward 2.0).

## Open questions (grill before implementation)

1. What kind of calendar is the "family calendar" in the tenant (shared mailbox,
   M365 group, or a shared personal calendar)?
2. Which To Do lists sync — all, or an allowlist per member?
3. Token loss UX: what happens on the Hearth View when a refresh token dies?
