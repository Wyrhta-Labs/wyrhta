# Plan — Hearth View + PWA

**Phase:** 1 (acceptance release)
**Level:** concept plan. Implementation happens in the Heorth repo (`web/`).

## Goal

The adoption hook: an always-on kitchen touchscreen showing the week — meal plan
beside the family calendar with what's currently due — plus an installable phone
PWA as the companion (shopping list in the supermarket, quick capture).

## Hearth View (primary surface)

- **Layout:** week view as default, month available; each day = calendar events
  (all mirrored M365 calendars, colour per member) + planned meals + due tasks.
  A "now/next" strip for what is current today.
- **Touch-first at arm's length:** large targets, readable across the kitchen,
  no hover affordances, no login ceremony on the wall. Interactions are
  glance-and-tap (mark task done, open recipe, flip week) — deep editing stays
  on desktop/phone.
- **Always-on behaviour:** auto-refresh via the existing TanStack Query polling;
  screen-burn-friendly idle state; survives Wi-Fi blips (stale-while-revalidate,
  show data age when stale).
- **Auth on the wall (phase 1 pragmatic):** a long-lived kiosk session for the
  device. A proper device-scoped read token is noted in the strategy for later
  (ADR 0002 world); do not build token machinery now.
- **Route:** a dedicated `/hearth` route/mode in the existing SPA — not a second
  frontend. The existing branded design (Fraunces, parchment/ember) carries.

## Phone PWA (companion)

- **Installable on iOS homescreen:** manifest (name/icons/`display: standalone`),
  apple-touch-icon set, splash/theme colours. Android later — but the manifest
  work is identical; "later" means "not tested/polished", not "excluded".
- **Responsive pass** over existing pages with three priority screens:
  1. **Shopping list** — one-handed, big checkboxes, works in the supermarket
     queue (this is the killer mobile moment)
  2. **Today/This-week** — compact version of the Hearth View
  3. **Quick capture** — add a task (→ To Do via provider) or a meal note
- **Offline:** service worker with cache-first shell and last-known data for the
  shopping list (read + check-off queued until online). Full offline sync is out
  of scope; the shopping list is the one surface that must tolerate a dead spot.
- **No push notifications** — "quiet by design", and iOS PWA push isn't worth
  the ceremony for phase 1.

## Acceptance test (the honest one)

Mounted on the kitchen screen for a normal week: does the household check it
each morning without being asked, and does the shopping list survive one real
supermarket trip? That — not the test suite — closes Phase 1.

## Open questions (grill before implementation)

1. Which device is the kitchen screen (iPad? mounted Android tablet? Pi +
   touchscreen)? Determines browser quirks, kiosk mode, and idle/wake handling.
2. Meal plan editing on the Hearth View itself, or plan on desktop / consume on
   the wall?
3. Do completed To Do tasks disappear from the Hearth View immediately, or show
   as struck-through for the day (family visibility of "who did what")?
