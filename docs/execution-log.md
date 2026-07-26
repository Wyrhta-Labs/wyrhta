# Execution ledger — Wyrhta Labs strategy (Phases 0+)

Mode: subagent-driven, PAUSE for human review after each phase.
Plan source: docs/strategy.md + docs/plans/*.md (this umbrella repo).
Task work happens in the independent sub-repos (wyrhta-core/, KithLedger/, Heorth/).

> **What this is.** The durable cross-repo record of *what actually happened* during
> execution: commit ranges, tag boundaries, adjudicated deviations from the plan and
> why, and the batches of deferred review findings. No single service repo's history
> holds this — it spans `wyrhta-core`, `Heorth`, `KithLedger`, and `Feoh`.
>
> `strategy.md` says what we intend to do; this file says what was done. Where they
> disagree about *intent*, `strategy.md` wins.
>
> **Maintained automatically.** The execution tooling writes its live ledger to
> `.superpowers/sdd/progress.md` (git-ignored); a `Stop`/`SubagentStop` hook
> (`.claude/hooks/sync-execution-log.sh`) copies its phase sections into this file as work
> progresses. Everything above the first `##` heading is hand-written and preserved by the
> sync — edit the preamble here, but make content changes in the ledger, not below.
> Committing stays manual: review the synced diff, then commit it.

## Phase 0 — Housekeeping

- Task 0.1: wyrhta-core v0.1.2 — COMPLETE (commits f58b35c..2daa423, tag v0.1.2 pushed,
  review clean). Minor findings for final review: README omits root `.` barrel export
  from module map; 0.1.1 changelog entry is a shortened paraphrase.
- Task 0.2: KithLedger 0.2.0 — COMPLETE (commits c417ba4..daefa4a, tag v0.2.0 on main,
  pushed; 53/53 integration tests green vs live Postgres; review Approved). Changelog was
  missing the MCP server + core migration — implementer added entries, reviewer verified
  all claims against real commits. Pre-existing repo hygiene noted, NOT fixed: stray
  non-v-prefixed `0.2.0` tag (points into origin/testing), no v0.1.0 tag exists.

### Phase 0 verdict

ALL THREE TASKS COMPLETE, all reviews Approved with zero Critical/Important code
findings. Whole-phase final review skipped as redundant: each task's review already
covered its repo's entire phase diff (three small doc-only diffs). PAUSED for human
go-ahead before Phase 1 (Feoh extraction — needs new GitHub repo Wyrhta-Labs/Feoh).
- Task 0.3: Heorth Library verification — COMPLETE (commits 7511d38..816be2b on staging,
  pushed; backend 101/101 + web 32/32 green, both builds clean; review Approved).
  Controller adjudication: ~70 historical per-task TDD checkboxes in the library plan
  deliberately left unchecked (retro-checking would fabricate process history) — accepted.
  Note: Heorth `npm test` requires DATABASE_URL exported manually (pre-existing quirk).

### Interlude (controller, direct)

- Feoh repo: already existed on GitHub (private, empty) — cloned to ./Feoh, registered
  in umbrella .gitignore + CLAUDE.md. Keep PRIVATE for now.
- KithLedger hygiene fixed: stray `0.2.0` tag deleted (local + origin); retroactive
  `v0.1.0` created on b48d3c2 (last pre-web-UI commit) and pushed.

## Phase 1 — Feoh extraction (IN PROGRESS, human gave go)

- Task 1.1: Feoh skeleton — COMPLETE (empty-tree..1b699a6 on main+staging, pushed, live
  CI green; review Approved). Facts for later tasks: core helpers (parseEnv/createDb/
  runMigrations) used directly (controller signed off — deliberate); auth at
  /api/v1/auth, health at /health (KithLedger pattern); fe_ prefix; provisional
  /api/v1/auth/whoami route MUST be removed in Task 1.2. Minor for final review: dead
  ContextVariableMap 'auth' block in app.ts (inherited from KithLedger); no lint script
  note missing from CLAUDE.md gotchas.
- Task 1.2: module move + parties — COMPLETE (1b699a6..ba812b0 on main+staging, pushed;
  38/38 tests green; review Approved, zero Critical/Important). Verified verbatim
  code-move (service diffed line-by-line vs Heorth); parties table per spec; whoami
  removed. ADJUDICATED: transactions.createdBy = explicit party-id input (FK to
  parties) replacing auth-principal derivation — accepted, only implementable reading.
  NOTES FOR TASK 1.3: parties has no MCP tools yet (decide whether to add).
  NOTES FOR TASK 1.4: proxy forwards paths unchanged (/api/v1/feoh/*), but must map
  acting Heorth member -> Feoh party id and inject createdBy; invalid createdBy
  currently surfaces as 500 from Feoh, not 400.
- Task 1.3: HTTP MCP — COMPLETE (ba812b0..e5c8c1c on main+staging, pushed; 43/43 tests;
  review Approved, zero Critical/Important). Tools: feoh.list_envelopes,
  record_transaction, get_month_summary, list_recurring_bills, import_csv,
  export_ledger, list_parties. NOTE FOR TASK 1.5: MCP server version hardcoded
  '0.1.0' in src/mcp/server.ts:58 — keep in sync on any bump (drift trap, no test).
- Task 1.4: Heorth proxy + module removal — COMPLETE (816be2b..f8b94d2 on staging,
  pushed; backend 86/86 + web 32/32; review Approved). ADJUDICATED+RATIFIED: feoh.*
  MCP tools dropped from Heorth's registry (live on Feoh /mcp per satellite
  convention; no external consumers yet). Minor for final review: unmapped-member
  write surfaces as 500 (not classified); no in-flight dedup on lazy roster re-sync;
  displayName rename drift until next boot sync.
- Final whole-phase review: READY TO RELEASE verdict; cross-repo seams verified;
  ADR 0002 Phase A compliance confirmed; all accumulated minors (A–G) DEFERRED.
- Task 1.5: releases — COMPLETE (Feoh v0.1.0 on e1ac27b; Heorth v0.2.0 on ff23dfe +
  retroactive v0.1.0 on 30d686a, boundary independently ratified; main==staging both
  repos; review Approved).

### PHASE 1 COMPLETE — PAUSED at phase gate.

Deferred cleanup batch for an early Phase 2 task (all Minor, from final review):
- D+E error-status hardening: Feoh bad createdBy → 400 not 500; Heorth unmapped-member
  write → classified error not generic 500
- F+G roster freshness: in-flight dedup on lazy re-sync; displayName rename propagation
- A: dead ContextVariableMap 'auth' block (Feoh + same in KithLedger)
- B: lint-script note in Feoh CLAUDE.md gotchas
- C: Feoh MCP version hardcode — sync on next version bump
- New: Feoh docker-compose doesn't pass CORS_ORIGIN; Feoh CLAUDE.md /auth path prefix
  imprecision. Heorth still has no README.
- Umbrella docs updated (CONTEXT.md Feoh entry, strategy.md phase checkmarks).

### Post-phase interlude — COMPLETE

- docs/manual-todo.md written + pushed (tenant prep, ApplicationAccessPolicy PowerShell,
  shared To Do list, kiosk tablet, Pi, FQDNs) — gates Phase 2.
- Cleanup batch: ALL 11 deferred findings closed across Feoh (e1ac27b..bb5f406),
  Heorth (ff23dfe..82bd4d5, incl. new README + displayName choke-point fix),
  KithLedger (daefa4a..c50c2b8). Review Approved, zero Critical/Important.
  All as [Unreleased] work, no new tags. Accepted-as-known: createdBy pre-check
  TOCTOU window (documented); splits partyId not pre-checked (documented);
  findings 6+7 share one commit.

## Phase 2 — Acceptance release (IN PROGRESS, human gave go 2026-07-24)

Plans: docs/plans/m365-integration.md, hearth-view-pwa.md. Local dev provisioned
(all three services online, ports 4000/4001/4002, real M365 dev creds in Heorth
.env — never commit). Task chain: 2.1 M365 foundation → 2.2 calendar mirror →
2.3 To Do sync → 2.4 PWA → 2.5 Hearth View → final phase review → 2.6 release
(Heorth 0.3). PAUSE at phase end.

- Task 2.1: M365 foundation — COMPLETE (de37a9d..ff78233 on staging, pushed; 113 backend
  tests green; review Approved; Important finding FIXED + re-review confirmed: decrypt
  failure now classifies as needs_reauth). Interfaces for 2.2/2.3: src/m365/ exports
  delegated + app-only clients (getAccessToken), graphFetch (429 retry, GraphError),
  store (m365_connections, PublicM365Connection), m365_sync_state (feed-key convention
  calendar:member:<id> / calendar:family / todo:member:<id>:<listId>), isM365Enabled,
  setM365Runtime test seam, tests/fake-graph.ts. Minor for final review: OAuth state
  replayable within 10-min TTL (no jti); tamper test feeds hex-as-base64; /status
  lastRefreshError column must never carry verbose upstream bodies (note for 2.2/2.3);
  no-op cache.delete in decrypt catch (consistency copy).
- Task 2.2: CalendarProvider + mirror — COMPLETE (ff78233..865b117 on staging, pushed;
  130 backend + 33 web green; review Approved; Important finding FIXED + re-review
  confirmed: deterministic periodic re-window, M365_FULL_RESYNC_INTERVAL_SECONDS
  default 7d, lastFullSyncAt tracked, failed resync never stamps). Interfaces for
  2.3/2.5: CalendarProvider/MirroredEvent in calendar module providers/types.ts;
  Graph impl src/m365/calendar-provider.ts; calendar_mirror_events table (mig 0008/9);
  events tagged `source` via listEvents; staleness via GET /api/v1/m365/status feeds[];
  scheduler in src/m365/scheduler.ts (VITEST-gated, started in main()); manual
  POST /api/v1/m365/sync (admin). Minors for final review: family feed hidden under
  explicit member_id filter (2.5 policy); getEvent mirror fallback ignores child scope;
  stopM365Scheduler unwired to shutdown; M365_FULL_RESYNC_INTERVAL_SECONDS read ad hoc
  (not in Zod schema — silent fallback on malformed value, not in config object).
- Task 2.3: TaskProvider + To Do — COMPLETE (865b117..dc18d0c on staging, pushed; 150
  backend + 33 web green; review Approved; Important finding FIXED + re-review
  confirmed: transient upstream → 502/503 house-style). Interfaces for 2.4/2.5:
  tasks module (src/modules/tasks/) — REST list/complete/create + allowlist mgmt,
  MCP tasks.list/complete/create, write-through (provider-first) semantics, shared
  sync-runner (src/m365/sync-runner.ts), scheduler chains calendar→tasks, staleness
  via /api/v1/m365/status feeds[]. Minors for final review: shared-list name
  collision picks arbitrary row; zoneless dueDateTime branch untested vs real Graph
  (smoke!); "optimistic" docstring drift (code is write-through); MCP tool errors
  carry no transient/non-transient split; graph_5xx comment naming nit.
- Task 2.4: PWA — COMPLETE (dc18d0c..132df70 on staging, pushed; web 56 + backend 150
  green; review Approved, zero Critical/Important). Manifest/icons (web/public/
  pwa-icons/ — global gitignore eats "icons/"), hand-rolled SW (cache-first shell,
  /api/* never cached, waiting-worker update banner, PROD-gated), offline shopping
  list (last-write-wins queue in localStorage, event-triggered replay), three phone
  screens + md:hidden bottom nav. Reusables for 2.5: compact event/task components
  (see 2.4 report). Minors for final review: replay fires once on mount even when
  offline (wasted round-trip); SW cache has no within-version eviction of superseded
  hashed chunks.
- Task 2.5: Hearth View — COMPLETE (132df70..8dfe774 + phase-fix 64f135c; review
  Approved; 2 Important FIXED (local-midnight boundaries incl. 2.4 calendar-grid
  follow-up; pointercancel teardown) + re-reviews confirmed.
- FINAL PHASE REVIEW: "Needs fixes first" → 2 Important wall findings FIXED
  (64f135c: update banner suppressed on /hearth w/ idle-time silent SW apply;
  /status feeds[] household-visible) + re-review confirmed. All 18 accumulated
  minors (A–R) triaged DEFER — list lives in the final-review output; notable
  deferred: G (resync env not in Zod), E (mirror getEvent child scope), N (greyed
  tasks tappable), delegated-flow smoke script missing.
- Task 2.6: RELEASE — Heorth v0.3.0 on 2539553 (main==staging==tag; changelog
  reconciled incl. two stale claims corrected). Release review: ✅ correct (tag
  placement, factuality spot-checks, versions, no trailer — all verified).

### PHASE 2 CODE COMPLETE — PAUSED at phase gate.

Exit criterion (spouse acceptance) needs the HUMAN steps in umbrella
docs/manual-todo.md: §2 ApplicationAccessPolicy PowerShell, §7 first-live-run
checklist (real-tenant smokes), §4 Pi + touchscreen purchase, secret rotation at
deployment. Phase 3 (deployment) follows after real use validates.
