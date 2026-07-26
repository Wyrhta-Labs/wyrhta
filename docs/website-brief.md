# Website Brief — Current Strategy & Decisions (handoff)

**Generated:** 2026-07-26 · **Purpose:** a single consolidated snapshot of Wyrhta
Labs' strategy and current per-project state, to be carried into a **`website-v0`
session** and rendered into public site copy.

> **Provenance rule (do not violate).** [`strategy.md`](strategy.md) is the source of
> truth; the website is a **downstream rendering** and gets corrected to match — never
> the reverse. This brief summarises `strategy.md`, the four ADRs, `IDEAS.md`, and
> `manual-todo.md` as of the date above. If this brief and `strategy.md` ever
> disagree, `strategy.md` wins.
>
> **Honesty constraints for public copy:**
> - "One maker" principle — review any fictional journal personas / multi-person
>   framing before publishing (flagged in `strategy.md` Phase 5+).
> - Distinguish **shipped** from **planned**. Much below is code-complete but *not yet
>   deployed or accepted*. Don't imply a live product.
> - Never publish secrets, tenant IDs, mailbox addresses, client IDs, or FQDNs from
>   `manual-todo.md`. Those are operational, not marketing.

---

## 1. What Wyrhta Labs is (the elevator version)

An **interconnected, self-hosted household manager** built as a small constellation of
independent services that share one foundation library — **not** a monorepo, **not** a
hosted SaaS. Own-your-data, local-first, runs on your own homelab.

- **Hub-and-satellites.** **Heorth** is the household hub and the only human-facing
  surface for now. **KithLedger** and **Feoh** are independent, API-first satellite
  services that Heorth consumes over their APIs.
- **Shared foundation.** All services build on **`@wyrhta/core`** (identity, auth,
  HTTP kit, household model, MCP scaffold, DB conventions), consumed as a **pinned
  GitHub-tag dependency** — each service upgrades deliberately, by bumping the pin.
- **The primary surface is the Hearth View** — a kitchen wall touchscreen showing the
  week's meal plan beside the family calendar and current items. That's the adoption
  hook; calendar/task sync is the plumbing that keeps it truthful. A phone PWA is the
  companion (shopping list, on-the-go capture).

### Naming (Old English / futhorc theme — useful for site voice)
- **Wyrhta** — "maker/wright". **Heorth** — hearth. **KithLedger** — kith (one's
  circle). **Feoh** (rune ᚠ, "wealth/cattle") — movable wealth → personal finance.
  **Ethel** (ᛟ, *ēðel*, "estate/immovable wealth") — physical property domain.
  **Wyrtgeard** ("plant-yard") — the Garden; **Ger** (ᛄ, "harvest") — grow-your-own.

---

## 2. Doctrine (the load-bearing principles)

1. **Own household first.** The primary user for the next ~12 months is the maker's own
   household. External self-hosters are a *gate* ("ready for others") near 1.0, not a
   driver.
2. **The spouse is the acceptance gate.** A release is launch-ready when household
   members would actually adopt it — not when tests pass.
3. **External systems of record, behind providers** (ADR 0001). Microsoft 365 owns
   calendars; Microsoft To Do owns everyday tasks. Heorth **mirrors and enriches**
   rather than replacing them. Providers are pluggable from day one; a multi-provider
   matrix (Google, CalDAV, Google Tasks, a partner task project) is a **2.0**
   commitment, not now.
4. **Two provider categories** — *systems of record* (owned data mirrored + eventually
   written back, ADR 0001) and *external reference feeds* (read-only world data, never
   written back, ADR 0003, e.g. weather).
5. **Identity: A-then-B** (ADR 0002). Satellites hold no member accounts (service keys
   only) until they grow real UIs, then they accept Heorth-issued member JWTs — one
   login everywhere. Heorth is the household's identity provider.
6. **Core discipline.** `@wyrhta/core` is demand-driven only (features land when a
   consumer needs them), ships every change as a semver tag + changelog, and holds no
   business domains and no UI.

---

## 3. Per-project state (as of 2026-07-26)

| Service | Latest | Public? | State |
|---|---|---|---|
| **`@wyrhta/core`** | v0.1.2 | public | Foundation lib; README + CHANGELOG in place, version-drift fixed. |
| **Heorth** | v0.3.0 | — | Flagship hub. **Phase 2 code-complete**; awaiting real-tenant smoke, kitchen hardware, and the spouse gate. **Not deployed.** |
| **KithLedger** | v0.2.0 | — | API-first relationship manager (web UI + security hardening tagged). Still service-key-only; MCP is stdio (moves to HTTP before it deploys as a satellite). |
| **Feoh** | v0.1.0 | private | Personal-finance service, **extracted from Heorth** as an independent repo/API/MCP/DB. Heorth's finance UI now proxies to it via a service key. |
| `website-v0` | — | — | The public site (this brief's target). Separate repo. |

**Milestone framing for the site:** the system is **pre-launch**. Foundation, the Feoh
extraction, and the acceptance-release feature set are **built**; the product goes live
only after homelab deployment and household acceptance (Phase 3). Present it as "in
active development toward a first at-home release," not as shipping.

---

## 4. Roadmap (phased)

- **Phase 0 — Housekeeping** ✅ done (2026-07-23/24). Core v0.1.2, KithLedger v0.2.0,
  Heorth Library verification.
- **Phase 1 — Feoh extraction** ✅ done (2026-07-24). Feoh v0.1.0 + Heorth v0.2.0 ("no
  functional change"). Done *before* deployment on purpose: no data migration, Feoh at
  its smallest, and the `FeohClient` proxy becomes the template for all satellite
  consumption. Acceptance test: **the household can't tell it happened.**
- **Phase 2 — Acceptance release** ✅ code-complete (Heorth v0.3.0); **awaiting**
  real-tenant smoke + hardware + spouse gate. Smallest set to get adopted at home:
  read-only **calendar mirror** (M365 via a `CalendarProvider`), **task sync** with
  Microsoft To Do (`TaskProvider`), an installable **iOS PWA**, and the headline
  **Hearth View** (week/month meals + calendar + current items, wall-first). **Exit
  criterion: spouse acceptance.**
- **Phase 3 — Deployment.** Homelab deploy (HAProxy FQDN → containers incl. Feoh),
  Postgres with backups, seed the real household, live with it. **Feature work does not
  resume until deployed**; real-use learnings reprioritise everything below.
- **Phase 4 — Ethel v1.** The physical-property domain: assets/appliances (incl.
  vehicles), rooms, **Maintenance Plans** that project due work into the task provider,
  and service contacts backed by **KithLedger** — the first real cross-service
  integration. Prerequisite: **KithLedger's MCP moves stdio → HTTP** so it deploys as a
  satellite first.
- **Phase 5+ — toward 2.0** (unordered until Phase 3 learnings land): Feoh growth
  (checking accounts, investments, retirement projections); the **Wyrtgeard** Garden
  module + **Ger** grow-your-own subfeature (introduces a `WeatherProvider`); calendar
  write-back; the multi-provider matrix; an **Office** document module; identity Phase
  B + satellite UIs; Hearth View device tokens; Android PWA + DE localisation; and a
  **website correction pass**.

**Out of scope until further notice:** kids'-chores features, multi-household, plugin
runtime, hosted offering, federation.

---

## 5. Architecture decisions (ADR digest)

- **ADR 0001 — External systems of record behind providers** *(accepted)*. Calendars
  and everyday tasks stay owned by M365 / To Do; Heorth is a synced client that mirrors
  + enriches. All sync goes through provider interfaces from day one (Graph is just the
  first). Calendar: read-only mirror now, write-back later. Tasks: mirror everyday
  tasks; Heorth-native Maintenance Plans project tasks *outward* so all doing lives in
  one inbox. Heorth stays system-of-record for domain knowledge no external service
  models (The Home, Maintenance, Meals, Feoh, Library).
- **ADR 0002 — Cross-service identity: A-then-B** *(accepted)*. Phase A: satellites
  hold only an admin user + API keys; Heorth calls them with service keys; members
  exist once, in Heorth. Phase B (when a satellite grows its own UI): satellites also
  accept Heorth-issued member JWTs (shared `JWT_SECRET`/HS256 first, asymmetric later).
  No external IdP.
- **ADR 0003 — External reference feeds behind providers** *(proposed)*. A second
  provider category for read-only world data nobody authors (weather first,
  `WeatherProvider`). Rules: never written back; no tenant coupling (prefer a **keyless**
  first provider — Open-Meteo, or DWD/Bright Sky for the DE-first household);
  location-anchored; **split persistence** — forecasts are ephemeral cache, observed
  past conditions are persisted into Heorth (so a crop's history is durable and
  provider-independent). Lives in Heorth, not core, until a second consumer needs it.
- **ADR 0004 — Per-member access control in the KithLedger knowledge graph**
  *(proposed)*. Privacy as a property of the data and the query, not the UI. 3-state
  visibility (`private` / `shared`-subset / `household`) on **nodes and edges**; three
  caller principals (member JWT / always-on household-dashboard key / admin ops key,
  least-privilege, separate credentials); traversal rules so the graph's *shape*
  (edges, paths, counts) can't leak hidden items; default-`household`, owner-only
  mutation, reassign-on-offboarding (no standing god-mode). **Hard dependency on ADR
  0002 Phase B** — schema-present but inert until member JWTs reach KithLedger.

> Note for copy: ADR 0003 and 0004 are **proposed, not accepted** — describe them as
> design direction, not committed features. Nothing is built for either until its phase
> arrives.

---

## 6. Suggested site structure (a proposal, not a decision)

A translation of the above into public sections — refine in the website session:

1. **Hero** — "A self-hosted household manager you actually own." Lead with the Hearth
   View / kitchen-wall image and the own-your-data promise.
2. **The idea** — hub-and-satellites, local-first, the OE naming as flavour.
3. **The services** — Heorth (hub), KithLedger, Feoh, `@wyrhta/core` — each a short
   card with its one-line purpose and honest status.
4. **How it works** — mirrors your existing calendar/tasks (M365 today, more later)
   instead of forcing migration; providers keep it portable.
5. **Roadmap** — the phased list above, honestly marked (done / in progress /
   planned). This section is the one most likely to drift — keep it a direct rendering
   of `strategy.md`.
6. **Principles / philosophy** — own household first; the spouse gate; own your data.

---

## 7. Handoff checklist (do this in the `website-v0` session)

- [ ] Open the site repo's own session (this brief is read-only input; do not edit
      site code from the meta repo).
- [ ] Reconcile existing site copy against §3–§5; correct anything that overstates
      status ("shipping" → "in development toward first at-home release").
- [ ] Render the roadmap (§4) as a direct downstream copy of `strategy.md`.
- [ ] Apply the honesty constraints (§ top): one-maker persona review; no secrets/IDs.
- [ ] Mark ADR 0003 / 0004 features as proposed, not committed.
- [ ] Leave `strategy.md` as the authority — if the site suggests a strategy change,
      bring it back to this meta repo as an edit to `strategy.md` first.
