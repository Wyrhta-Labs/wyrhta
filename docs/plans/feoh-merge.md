# Plan — Feoh merge (satellite → built-in optional module)

**Date:** 2026-08-10 · **Status:** design approved, amended same day after
independent (Codex) review; not implemented · **Level:** concept plan.
Implementation spans the Heorth repo (bulk), the Feoh repo (archival), and this
meta repo (`deploy/`, docs); this captures the cross-cutting design.

**Prerequisite:** the ADR recording this reversal and the `strategy.md` update
land **before** implementation starts — until then the strategy doc, which is
the source of truth, still says the opposite of this plan.

**Supersedes:** [Feoh extraction plan](feoh-extraction.md) (the satellite
architecture, Phase 1) and Heorth's approved-but-unimplemented plugin-host spec
(`Heorth/docs/superpowers/specs/2026-08-06-plugin-system-design.md`, all three
of its decomposed specs). Both remain in place, marked superseded — the plugin
extension point is revivable if a real third-party need ever appears, but it no
longer carries Feoh.

## Goal

Feoh ships **inside Heorth** as a built-in, optional finance feature: present in
every Heorth build, activated per deployment by an env kill switch, zero
**behavioral** footprint when off — no routes, no MCP tools, no UI. (Database
tables may exist and are simply not touched; see Shape §4.) One container, one database, one API surface, one liveness
probe. Acceptance test: with the switch on, the finance pages work exactly as
they do through today's satellite proxy; with it off, Heorth behaves as if
finance had never been built.

## Why (reversal rationale)

The satellite boundary bought Feoh an independent lifecycle it never used — one
maker, both repos moving in lockstep — and charged for it continuously: a second
container, database, API key, and liveness surface; roster sync with a
staleness window; a parties cache; classified-error plumbing for
unmapped-member writes. The 2026-08-06 plugin design shrank that boundary but
would have replaced it with a permanent compatibility contract (`apiVersion`,
peer-dependency lockstep, host-run foreign migrations) maintained for exactly
one first-party plugin — machinery `strategy.md` already lists as out of scope
("plugin runtime"). Merging deletes the problem class instead of managing it.

Genuine separation stays where it is genuine: **KithLedger remains a
satellite** (API-first, own UI, own lifecycle). This decision is about Feoh,
not the hub-and-satellites doctrine generally — Feoh was Heorth's finance
module that took a detour, not an independent service.

## Shape

1. **Code returns by transplant, not revert.** Feoh's `src/modules/feoh/`
   (schema, service, routes, validators, mcp, csv — plus the double-entry test
   suite) moves into Heorth's `src/modules/feoh/`. It still follows Heorth's
   6-file module convention, but the move is **a transplant with a deliberate
   adaptation workstream**, not a mechanical copy — the Phase-1 code is shaped
   around parties and satellite auth. The adaptation, in full: replace party FK
   columns with member FKs; rename `partyId` back to `memberId` throughout
   (schema, splits, validators, API types); delete `services/parties`,
   `routes/parties`, and the `feoh.list_parties` MCP tool; derive `createdBy`
   from the authenticated Heorth principal instead of explicit party input;
   adapt the tests accordingly. Transplant from the Feoh repo — not a revert of
   Heorth's extraction commits — because the Feoh copy is the maintained one
   (it received the Phase-1 cleanup batch). Heorth's `src/satellites/feoh/`
   (client, proxy, roster, runtime) is deleted.

   **Authorization must be restored inside the module.** Today the write
   guards live in Heorth's *proxy* (`requireRole('admin','adult')` plus the
   maintenance-admin quarantine, `src/satellites/feoh/proxy.ts`), and Feoh's
   own routes trust the caller. After the transplant those guards move onto
   the module's mutation routes and MCP write tools themselves — a naive copy
   would silently drop them.

2. **Toggle = env kill switch, M365 pattern.** One optional env var,
   `FEOH_ENABLED` (default **off**). On → `config.feoh` populated, the module
   registers routes at `/api/v1/feoh/*`, its MCP tools join Heorth's registry,
   the sidebar shows Finance. Off → the module registers as a no-op (requests
   fall through to the catch-all 404), MCP tools absent, UI hidden. Deactivating
   **never touches data**: tables stay; re-enabling picks up where it left off.

   **Feature-status endpoint (new — nothing equivalent exists today; the
   sidebar currently renders Finance unconditionally):**
   `GET /api/v1/features`, auth required (any role), returns
   `{ "finance": boolean }` and grows a key per future optional feature. The
   web app fetches it once after login; fetch failure is treated as
   all-features-off. Finance routes stay registered in the bundle — direct
   navigation to a finance URL while disabled renders an "unavailable" state,
   not a crash. One bundle serves both configurations.

3. **Parties table dropped; back to members.** In-process, the roster cache is
   pointless. Feoh code references Heorth members directly again and
   `createdBy` returns to auth-principal derivation (its pre-extraction
   semantics). The `external` payee idea (landlord, employer) is deferred to
   when checking-account features actually land, as its own table then. This
   deletes the roster-sync/staleness problem class entirely.

   **Member-deletion policy (new, was unspecified):** finance rows
   (`transactions.created_by`, split participants) FK to members with
   **`ON DELETE RESTRICT`** — finance records are audit data; deleting a
   member who has transactions or splits is refused, with a test proving it.
   Softening (e.g. `SET NULL` + display snapshot) is a future decision if
   restriction ever blocks a real workflow.

4. **Database: Heorth's DB, ordinary module tables.** Feoh's tables become
   normal Heorth migrations in the public schema, registered in both schema
   barrels per convention. **Port the schema and generate a fresh migration
   with `npm run db:generate` — never copy Feoh's migration files or
   snapshots** (Heorth convention: snapshots are generated, not hand-carried).
   **Fresh start, no data migration** — nothing is in production (Phase 3 not
   reached). The `feoh` service and database leave `deploy/`; as a cheap
   guardrail, take a final `pg_dump` of the dev `feoh` database before the
   compose cleanup deletes it. `FEOH_BASE_URL` / `FEOH_API_KEY` leave Heorth's
   env schema.

5. **MCP.** The `feoh.*` tools return to Heorth's MCP registry (they were
   dropped in Phase 1 Task 1.4), gated on the same switch. Two pieces of
   hidden work made explicit: (a) Heorth's `collectMcpTools` currently
   registers every module a *second* time against a throwaway Hono to harvest
   tools — the merge adopts the fix the plugin spec already designed
   (`createApp` returns the registry; register once); (b) Feoh's MCP write
   tools currently take `createdBy` as explicit input — after the merge they
   derive the acting member from Heorth's MCP auth principal and enforce the
   same adult/admin write policy as the routes. Feoh's standalone `/mcp`
   server retires with the repo.

6. **Feoh repo: archived last**, not deleted — only after the merged Heorth
   suite is green and the deploy cleanup is done, since the repo is the
   transplant source and comparison oracle until then. History and the v0.1.0
   tag remain browsable. Its README gains a pointer to Heorth.

## Testing

Feoh's suite (43 tests incl. double-entry invariants) merges into Heorth's
backend suite against the real `_test` Postgres, adapted for members-not-parties.
New cases:

- switch off → `/api/v1/feoh/*` 404s, MCP registry has no `feoh.*` tools,
  feature endpoint reports finance off, sidebar hides Finance (web suite);
- switch on → routes, tools, and UI all present;
- toggle round-trip → enable, write, disable, re-enable, data intact;
- authorization → non-adult members rejected on mutation routes and MCP write
  tools (the guards formerly enforced by the proxy);
- member deletion → refused (`ON DELETE RESTRICT`) while the member has
  transactions or splits.

## Versioning & docs

- Heorth: next minor, changelog honest — "Feoh merged back as a built-in
  optional feature (satellite retired)".
- Meta repo: **ADR** recording the reversal and rationale; `strategy.md`
  doctrine §4 and phase texts updated (Feoh no longer "graduates to satellite";
  Phase 3 deploys without a Feoh container; Phase 5+ Feoh growth items become
  module growth); `CONTEXT.md` / `CLAUDE.md` service tables updated;
  `deploy/` compose stack drops the `feoh` service + database.
- Heorth repo: mark the three plugin-system specs superseded (done from a
  Heorth session, per working-mode rules).
- Website brief: next re-issue reflects "finance is a built-in optional
  feature", per the one-way strategy → brief flow.

## Non-goals

Runtime/UI toggle (env-and-restart only), per-member enablement, data
migration tooling, any plugin-host implementation, new finance features during
the move, changes to KithLedger's satellite status.
