# Wyrhta Labs — Idea Inbox

A lightweight intake for raw ideas. **You** drop ideas in the Inbox below; **I**
(Claude) read them, ask questions if needed, and move them along the pipeline —
checking each off as it lands in [`strategy.md`](strategy.md), a `plans/` doc, or
a `decisions/` ADR.

This file is a **staging area, not a source of truth**. Once an idea is captured
in strategy/plan/ADR, that document owns it; the entry here just records where it
went.

## How to use this

**You:** Add a new idea under **📥 Inbox** using the template. Keep it as rough as
you like — a sentence is fine. Optionally tag the service(s) it touches
(`core` · `Heorth` · `KithLedger` · `Feoh` · `cross`).

**Me:** On each pass I will:
1. Read new Inbox items and, if anything is unclear, ask before acting.
2. Triage each into the pipeline and tick the checkbox stages as they complete.
3. When an idea is fully absorbed into a doc, move it to **✅ Landed** with a link
   to where it now lives.
4. Park anything out of scope or deferred under **🧊 Parked** with a one-line why.

Status legend for pipeline checkboxes:
- [ ] **Triaged** — I've read it and understood the intent
- [ ] **Shaped** — refined into a concrete direction (questions resolved)
- [ ] **Placed** — written into strategy / a plan / an ADR

---

## 📥 Inbox

<!--
Copy this template for each new idea. Leave the checkboxes unchecked — I tick them.

### IDEA: <short title>
- **Tags:** cross | core | Heorth | KithLedger | Feoh
- **Added:** YYYY-MM-DD
- **The idea:** <one or more sentences — as rough as you like>
- **Why / what problem:** <optional>
- **Pipeline:**
  - [ ] Triaged
  - [ ] Shaped
  - [ ] Placed
- **Notes (Claude):** <I fill this in>
-->

_(nothing here yet)_

---

## ✅ Landed

Ideas fully captured elsewhere. Format: **title** → destination + date.

<!-- - **<title>** → [`plans/<file>.md`](plans/<file>.md) · YYYY-MM-DD -->

- **A committed-spend forecast for Feoh, like the iOS app Subtrack** →
  [`specs/2026-09-09-feoh-committed-spend-forecast-design.md`](superpowers/specs/2026-09-09-feoh-committed-spend-forecast-design.md)
  + [ADR 0018](decisions/0018-weorc-projects-one-off-deadlines.md) (proposed) ·
  2026-09-09 — subscriptions as a **recurring bill plus a detail row**
  (`feoh_subscriptions`, the Ethel vehicle pattern), a normalised monthly cost,
  a forward timeline with a per-envelope breakdown, and announced future
  **price changes** so a forecast spanning one is right rather than merely
  arithmetic. The forecast is a **fold over the existing `listOccurrences`
  engine** — override beats price change beats bill amount, booked beats all
  three — so Feoh does not grow a second projector. Foreign-billed
  subscriptions carry a declared amount and a hand-maintained rate and are
  shown as an **estimate**; the ledger stays single-currency, so ADR 0016 §7
  stands and a future `FxProvider` (ADR 0003's category) would just fill in the
  rate. Scoped **against** a balance projection: no expected income is
  modelled, so it says what leaves, never what remains.
  The cross-cutting half is ADR 0018: **Weorc gains `mode = 'once'`** so a
  trial-end or cancel-by date reaches the task inbox through the household's one
  projection engine (ADR 0014) instead of Feoh growing its own. The boundary
  rule it adds — Weorc owns work whose **existence is derived from a household
  fact**, recurring or not; "buy milk" stays a Task — is what keeps that door
  from swinging, and the mode is not Feoh-specific: Wyrtgeard's "sow by" is the
  next consumer. Also in [`strategy.md`](strategy.md) (Phase 5+, Feoh and Weorc
  growth) and [`../CONTEXT.md`](../CONTEXT.md) (Subscription, Committed Spend,
  Deadline, Routine). **Not startable:** Phase 5+, after Phase 3 deployment.
  Caveat recorded in the spec — the App Store page was unreachable from the
  authoring session, so Subtrack's feature set is from description and
  familiarity, not a read.

- **Connect paperless-ngx via API, so reference documents hang off transactions,
  appliances and so on** →
  [ADR 0017](decisions/0017-paperless-ngx-is-the-document-system-of-record.md)
  (proposed) + [`plans/gewrit-paperless.md`](plans/gewrit-paperless.md) ·
  2026-09-09 — **paperless-ngx becomes the household's document system of
  record**; Heorth stores *links only* and never the bytes, the OCR text or an
  index of either (which keeps ADR 0006 §1 intact and ADR 0005 about KithLedger
  notes). The module is **Gewrit** (OE *gewrit* — a writing, deed, charter; no
  rune, like Weorc), replacing the placeholder name **Office**. Triage found the
  premise was false: `CONTEXT.md` said documents "stay in Library until Office
  exists", but Heorth's Library module is a media shelf (Trakt + LibraryThing,
  `MEDIA_TYPES` book/movie/series) and no schema anywhere has an attachment or
  document column — so documents never had a home, and Ethel's manuals, Feoh's
  invoices and Weorc's service reports were all working around the same hole.
  Shape: this is **ADR 0001's category, fourth instance**, with a new
  *self-hosted* sub-case (an API token, no tenant, no OAuth) rather than a
  fourth provider taxonomy; a three-method read-only `DocumentProvider` with the
  API version pinned (`Accept: application/json; version=10`);
  a register table `gewrit_filings` whose row is a **Filing** — a document, a
  `relation` saying what it is *to that thing*, and **typed nullable FK anchors**
  (asset, place, transaction, routine, occurrence) under an **at-most-one**
  CHECK, so Weorc's anchor shape (ADR 0014) carries over and an unanchored
  Filing is a first-class row; **one register page** listing anchored and
  unanchored Filings together, with the configured `PAPERLESS_HOUSEHOLD_TAG`
  sweeping documents into the register so an unanchored document is reachable
  without a member attaching it to anything; **no Filing, no proxy** as the whole
  authorisation model for streaming preview/thumb/download through Heorth; pull
  not push (the paperless webhook action exists and is declined) with rot marked
  stale rather than deleted. Rejected: letting paperless hold the references in
  custom fields, deep links into its UI, and its share links. Deferred by
  choice: capture/upload, anchor-suggestion rules, KithLedger person anchors,
  meter readings.
  **Two corrections the same day, both recorded in the ADR:** a document may be
  **unanchored** (so no `householdId` anchor column, and the CHECK relaxed from
  exactly-one to at-most-one), and — reversing the first pass — Gewrit **does**
  get a top-level register page, because an unanchored document with no register
  is unreachable rather than merely unattached. Also in
  [`strategy.md`](strategy.md) (Phase 5+) and
  [`../CONTEXT.md`](../CONTEXT.md) (Gewrit, Filing, Ethel).
  **Timing is the honest part:** ADR 0015 §5 and ADR 0016 refuse a third
  pre-deployment slice, so nothing is built until Phase 3 is deployed — this is
  a decided shape, not queued work.

- **A name for chores** →
  [ADR 0014](decisions/0014-weorc-owns-recurring-household-work.md) (accepted) ·
  2026-08-24 — the domain is **Weorc** (OE *weorc*, work/labour; **no rune** —
  *Dægweorc* ᛞ and *Nyd* ᚾ considered and rejected), a **peer of Ethel, not a
  feature of it**: Ethel keeps assets, places and the upkeep facts of a thing;
  Weorc owns **Routines** — the recurring definition, the completion history, and
  the single projection engine into the task provider. The anchor is nullable, so
  "put the bins out" and "service the boiler" are one kind of row; Maintenance
  Plan becomes an asset-anchored Routine, making Phase 4 slice C **Weorc's first
  slice**. "Chore" stops being an avoided word and becomes the gloss; kids'-chore
  mechanics (points, allowances, rotation) stay out of scope. Also in
  [`strategy.md`](strategy.md) (Phase 4, Phase 5+, Out of scope) and
  [`../CONTEXT.md`](../CONTEXT.md) (Weorc, Routine, Maintenance Plan, Occurrence,
  Ethel, Task). **Shipped 2026-08-25** as Weorc's first slice: plan
  [`plans/2026-08-25-weorc-first-slice.md`](superpowers/plans/2026-08-25-weorc-first-slice.md),
  spec
  [`specs/2026-08-25-weorc-first-slice-design.md`](superpowers/specs/2026-08-25-weorc-first-slice-design.md),
  schema/engine/REST API/web page in Heorth and `weorc.*` tools in heorth-mcp,
  all in-repo and green, seeded into the demo household with both the anchored
  and unanchored cases side by side. Not yet deployed to a real household.

- **Defer server-side LLM features; run a conservative DB first** →
  [ADR 0006](decisions/0006-no-server-side-generative-inference-and-a-conservative-base-db.md)
  (proposed) · 2026-07-27 — two mechanical rules: (1) no **generative** model as a runtime
  dependency of the base product — summarisation, M365 mail→interaction extraction, NL→query
  all deferred to a future opt-in tier; deterministic **encoders are permitted**, and
  generative value stays available **via MCP where the model is the client**
  ("intelligence is a client concern; the server serves data"). (2) The base DB uses only
  extensions **bundled in the official Postgres image**, while one shared Postgres container
  serves `heorth`/`feoh`/`kithledger` — revisited when the cluster image changes on its own
  merits or KithLedger gets its own instance. Preventive: nothing planned is affected.

- **pgvector for the KithLedger knowledge graph** →
  [ADR 0005](decisions/0005-semantic-retrieval-with-pgvector.md) (proposed) · 2026-07-27
  — yes for semantic note search + MCP/LLM retrieval; **no** for dedupe (`pg_trgm` +
  `fuzzystrmatch`) and for "drifting from" (plain SQL). Embeddings as `halfvec(1024)` in
  per-parent side tables, always joined back to the parent so ADR 0004 visibility stays
  single-sourced. **Exact search, no ANN index** at household scale — which dissolves the
  filtered-ANN recall leak; HNSW documented but deferred past ~100k rows. Multilingual
  local model by default. Switchable off in ENV down to a plain `postgres:18` image, with
  FTS as the working fallback. Postgres **18.4** now (ungated); don't wait for 19.
  **Deferred** behind ADR 0006's shared-cluster image rule, then ADR 0004 accepted +
  ADR 0002 Phase B. The **FTS + `pg_trgm` tier is ungated** and is the near-term work.

- **Per-member access control (KithLedger knowledge graph)** →
  [ADR 0004](decisions/0004-per-member-access-control-in-the-knowledge-graph.md)
  (proposed) · 2026-07-26 — 3-state visibility (`private`/`shared`/`household`) on
  nodes *and* edges, enforced at graph traversal; three caller principals (member /
  household-dashboard / admin); depends on ADR 0002 Phase B.

- **Garden** → [`strategy.md` Phase 5+](strategy.md#phase-5--toward-20) · 2026-07-26
  — captured as the **Wyrtgeard** module (plant library) + **Ger** harvest
  subfeature. Roadmap capture only (feature freeze until Phase 3); no `plans/` doc
  yet. New `WeatherProvider` doctrine captured in
  [ADR 0003](decisions/0003-external-reference-feeds-behind-providers.md) (proposed).

---

## 🧊 Parked

Out of scope, deferred, or superseded — kept so we don't re-litigate them.

<!-- - **<title>** — <one-line reason> · YYYY-MM-DD -->

_(nothing here yet)_
