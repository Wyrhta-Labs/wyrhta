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
