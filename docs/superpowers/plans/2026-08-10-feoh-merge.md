# Feoh Merge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the Feoh satellite and ship its double-entry finance domain inside Heorth as a built-in module gated by a `FEOH_ENABLED` env kill switch (default off).

**Architecture:** Transplant `Feoh/src/modules/feoh/` back into `Heorth/src/modules/feoh/`, reversing the parties boundary to direct member FKs and restoring the write guards that currently live in Heorth's proxy. Spec: `docs/plans/feoh-merge.md` (meta repo). Two oracles exist for every adaptation decision: the Feoh repo checkout (`./Feoh`, the maintained code) and Heorth's pre-extraction module (`git -C Heorth show v0.1.0:src/modules/feoh/<file>` — the member-semantics reference). The merge target is "v0.1.0 member semantics + Feoh's post-cleanup improvements".

**Tech Stack:** Node 22 + TypeScript, Hono, Drizzle ORM, PostgreSQL 18, Zod, Vitest, React + TanStack Router (web), `@wyrhta/core` pinned by git tag.

## Global Constraints

- Three repos are touched: the meta repo (`.`, commit to `main` directly), Heorth (`./Heorth`, work on `staging` if that is the current convention — check `git -C Heorth branch --show-current` and match the Phase 2 flow), Feoh (`./Feoh`, archival only). Each commit goes to its own repo — never stage sub-repo folders in the meta repo.
- Git against GitHub goes through `gh`; no AI co-author trailers.
- Heorth tests need `DATABASE_URL` exported, database name MUST end in `_test` (default `postgres://heorth:…@localhost:5432/heorth_test`, dev cluster from `deploy/`). Run backend tests from `Heorth/`, web tests from `Heorth/web/`.
- Heorth migrations: `npm run db:generate -- --name <name>`; never hand-edit snapshots, never copy Feoh's migration files.
- Env switch name is exactly `FEOH_ENABLED`; config key `config.feohEnabled`; feature endpoint `GET /api/v1/features` returning `{ "finance": boolean }`.
- New tables FK member columns to core's `users` table with the default (RESTRICT) delete behavior — no `onDelete` on member FKs.
- All Feoh mutation routes and MCP write tools enforce `requireRole('admin','adult')` + maintenance-admin quarantine (acting principal AND split members), exactly like today's proxy (`Heorth/src/satellites/feoh/proxy.ts:43-55,121-136`).

---

### Task 1: ADR + strategy update (meta repo) — prerequisite, blocks all other tasks

**Files:**
- Create: `docs/decisions/0007-feoh-returns-to-heorth-as-built-in-module.md`
- Modify: `docs/strategy.md` (doctrine §4, Phase 3, Phase 5+)
- Modify: `docs/decisions/README.md` (index line, match existing format)

**Interfaces:**
- Produces: the strategy source of truth stops contradicting the merge; later tasks may cite ADR 0007.

- [ ] **Step 1: Write ADR 0007**

```markdown
# 0007 — Feoh returns to Heorth as a built-in optional module

**Status:** accepted 2026-08-10 · **Supersedes:** the Feoh satellite architecture
(plans/feoh-extraction.md, executed as Phase 1) and Heorth's unimplemented
plugin-host design (Heorth docs/superpowers/specs/2026-08-06-plugin-system-design.md).

## Context

Phase 1 extracted Feoh into an independent satellite: own repo, database,
container, API key, MCP surface, reached through an HTTP proxy in Heorth. The
boundary bought an independent lifecycle nobody used — one maker, both repos in
lockstep — and charged continuously: a second deployable, roster sync with a
staleness window, a parties cache, classified-error plumbing. A follow-up
design (2026-08-06) would have kept Feoh's repo but run it in-process as a
runtime-loaded plugin; that trades the operational cost for a permanent
compatibility contract (apiVersion, peer-dependency lockstep, host-run foreign
migrations) maintained for exactly one first-party plugin — and strategy.md
already lists "plugin runtime" as out of scope.

## Decision

Feoh's finance domain moves back into Heorth as an ordinary compile-time
module, present in every build, gated per deployment by `FEOH_ENABLED`
(default off, zero behavioral footprint when off, data untouched by toggling).
The parties boundary is dropped: finance rows FK household members directly
(`ON DELETE RESTRICT` — finance records are audit data). The Feoh repo is
archived after the merge is verified. KithLedger's satellite status is
unchanged — hub-and-satellites remains the doctrine for genuinely independent
services; Feoh simply never was one.

## Consequences

- One container, one database, one API surface, one liveness probe.
- The roster-sync/staleness problem class is deleted, not managed.
- Optional features get a precedent: env kill switch + runtime feature
  endpoint (`GET /api/v1/features`), following the M365 all-or-nothing pattern.
- The `external` payee concept returns only when checking-account features
  land, as its own table.
- Heorth ships this as its next minor with an honest changelog entry.
```

- [ ] **Step 2: Update `docs/strategy.md`**

Doctrine §4 — replace the sentence starting "Feoh graduates":

```markdown
4. **Hub and satellites.** Heorth is the household hub. KithLedger is an
   independent API-first service (own repo, API, MCP) that Heorth consumes via
   its API. Feoh — extracted to a satellite in Phase 1, merged back 2026-08-10
   (ADR 0007) — ships inside Heorth as a built-in optional finance module
   (`FEOH_ENABLED`) and grows there (checking accounts, investments,
   retirement projections).
```

Phase 1 heading block — append one line at the end of the Phase 1 section:

```markdown
- **2026-08-10:** the satellite was retired and Feoh merged back into Heorth as
  a built-in optional module — see ADR 0007 and plans/feoh-merge.md. This
  section stays as the record of Phase 1 as executed.
```

Phase 3 — change `(existing HAProxy FQDN → containers, now incl. Feoh)` to `(existing HAProxy FQDN → containers)`.

Phase 5+ — change `- Feoh growth: checking accounts …` to `- Feoh module growth (in Heorth, ADR 0007): checking accounts for daily life, investments, retirement projection strategies.`

- [ ] **Step 3: Add the ADR to `docs/decisions/README.md` index, matching the existing entries' format**

- [ ] **Step 4: Commit (meta repo, main)**

```bash
git add docs/decisions/ docs/strategy.md
git commit -m "docs: adopt ADR 0007 — Feoh returns to Heorth as a built-in optional module"
```

---

### Task 2: `FEOH_ENABLED` switch + features endpoint (Heorth)

**Files:**
- Modify: `Heorth/src/config/env.ts`
- Create: `Heorth/src/routes/features.ts`
- Modify: `Heorth/src/app.ts` (mount features router)
- Test: `Heorth/tests/features.test.ts`

**Interfaces:**
- Produces: `config.feohEnabled: boolean` (consumed by Tasks 5, 6); `GET /api/v1/features` → `200 { data: { finance: boolean } }` in core's `ok` envelope, auth required, any role (consumed by Task 7).
- Consumes: `requireAuth` from `src/wiring.ts`; `ok` from `@wyrhta/core/http`.

- [ ] **Step 1: Write the failing test** — `Heorth/tests/features.test.ts`. Mirror an existing route test file (e.g. copy the auth/bootstrap helpers from a small one such as the health or household test) for app construction and an authenticated member. Cases: unauthenticated → 401; authenticated → 200 with `{ finance: false }` (the test env does not set `FEOH_ENABLED`). Note how existing tests build the app (`createApp(ALL_MODULES)` or a helper) and reuse that.

- [ ] **Step 2: Run it** — `cd Heorth && npm test -- tests/features.test.ts`. Expected: FAIL (404 route not found).

- [ ] **Step 3: Implement.** In `env.ts` add to `buildEnvSchema()` (next to the Trakt optionals), with a comment matching the file's style:

```ts
    // Feoh built-in finance module (ADR 0007). Optional kill switch, default
    // off: absent/empty/'false' → module registers as a no-op (routes 404,
    // no MCP tools, UI hidden). Toggling never touches data.
    FEOH_ENABLED: emptyToUndefined(z.enum(['true', 'false'])),
```

and to the `config` object: `feohEnabled: parsed.data.FEOH_ENABLED === 'true',`. Do NOT remove `FEOH_BASE_URL`/`FEOH_API_KEY` yet — the proxy still consumes them until Task 5.

Create `src/routes/features.ts`:

```ts
import { Hono } from 'hono';
import { ok } from '@wyrhta/core/http';
import { requireAuth } from '../wiring.js';
import { config } from '../config/env.js';

/**
 * Runtime feature discovery for the web app: which optional built-in features
 * are enabled on this deployment (ADR 0007). One key per optional feature.
 * Auth required (any role) — feature flags are not public information.
 */
export const featuresRouter = new Hono();
featuresRouter.use('*', requireAuth);
featuresRouter.get('/', (c) => ok(c, { finance: config.feohEnabled }));
```

In `app.ts`, before the module loop: `app.route('/api/v1/features', featuresRouter);` (+ import).

- [ ] **Step 4: Run tests** — the new file, then the full backend suite. Expected: PASS.

- [ ] **Step 5: Commit (Heorth)** — `feat: add FEOH_ENABLED kill switch and GET /api/v1/features`

---

### Task 3: Finance schema + migration (Heorth)

**Files:**
- Create: `Heorth/src/modules/feoh/schema.ts`
- Modify: `Heorth/src/db/schema/index.ts` and `Heorth/src/db/schema/drizzle-schema.ts` (both barrels — runtime barrel uses `.js` suffix, drizzle-kit barrel none)
- Create: generated migration via `npm run db:generate -- --name feoh_merge`
- Test: `Heorth/tests/feoh-schema.test.ts`

**Interfaces:**
- Produces: tables `accounts`, `envelopes`, `transactions`, `postings`, `recurring_bills`, `expense_splits`; exports `accounts, envelopes, transactions, postings, recurringBills, expenseSplits` + `$inferSelect` types. `transactions.createdBy` and `expenseSplits.memberId` are `uuid … .references(() => users.id)` (no `onDelete` → RESTRICT).
- Consumes: `users` from `@wyrhta/core/identity` (verify the exact import the pre-extraction schema used: `git -C Heorth show v0.1.0:src/modules/feoh/schema.ts` — match it).

- [ ] **Step 1: Write the schema.** Start from `Feoh/src/modules/feoh/schema.ts` (current in this checkout) and apply exactly these edits: replace the `parties` import with the member/users import from the v0.1.0 oracle; `transactions.createdBy` references `users.id`; rename `expenseSplits.partyId` → `memberId` (column `member_id`, index `expense_splits_member_id_idx`) referencing `users.id`; update both header comments to say member FKs are back (parties boundary removed, ADR 0007). Everything else (checks, indexes, numeric precision, cascade behavior on `postings`/`expense_splits.transactionId`) stays byte-identical to the Feoh copy.

- [ ] **Step 2: Register in BOTH barrels** (`export * from '../../modules/feoh/schema.js';` in `index.ts`; no-`.js` equivalent in `drizzle-schema.ts`), replacing the `// feoh tables removed` comment line in `index.ts`.

- [ ] **Step 3: Generate the migration** — `cd Heorth && npm run db:generate -- --name feoh_merge`. Review the SQL: 6 tables, FKs to `users`, no drops of existing tables.

- [ ] **Step 4: Write the failing test** — `Heorth/tests/feoh-schema.test.ts`: port `Feoh/tests/feoh-schema.test.ts` (11 lines, existence checks) plus one new case: insert a member (use the test helpers other Heorth tests use to create users), insert a transaction with `createdBy` = that member, attempt to delete the member row, expect an FK-violation error (code `23503`) — RESTRICT proven.

- [ ] **Step 5: Run** — migration applies via test setup; tests PASS.

- [ ] **Step 6: Commit (Heorth)** — `feat: add finance tables with direct member FKs (feoh merge, ADR 0007)`

---

### Task 4: Service, validators, csv transplant (Heorth)

**Files:**
- Create: `Heorth/src/modules/feoh/service.ts`, `validators.ts`, `csv.ts` (from the Feoh repo copies)
- Test: `Heorth/tests/feoh-transactions.test.ts`, `feoh-accounts.test.ts`, `feoh-bills.test.ts`, `feoh-summary.test.ts`, `feoh-csv.test.ts` (ported from `Feoh/tests/`)

**Interfaces:**
- Produces: the service API Tasks 5–6 call. Signatures after adaptation: `recordTransaction(input, createdBy: string)` and `importTransactionsCsv(csv: string, createdBy: string)` where `createdBy` is the acting **member id** (auth-derived by callers, no longer part of the input schema); splits input/output field is `memberId`. All other service functions keep the Feoh copy's signatures (`listAccounts`, `createAccount`, `updateAccount`, `deleteAccount`, same for envelopes/bills, `listTransactions`, `getTransaction`, `deleteTransaction`, `getMonthSummary`, `exportLedger`, `exportTransactionsCsv`).
- Consumes: Task 3's schema exports.

- [ ] **Step 1: Copy the three files from `Feoh/src/modules/feoh/`**, then adapt. Diff against `git -C Heorth show v0.1.0:src/modules/feoh/service.ts` (and validators) to recover the exact pre-extraction member semantics; the required deltas from the Feoh copy are:
  - `validators.ts`: remove `createdBy` from `recordTransactionSchema` (callers derive it); rename `partyId` → `memberId` in the splits schema; delete `importCsvQuerySchema` (the import route no longer takes `?createdBy=`).
  - `service.ts`: `recordTransaction` takes `createdBy` as a second parameter instead of reading it from input; drop the `UNKNOWN_PARTY` pre-check (the id comes from the authenticated principal — the FK is the backstop); rename split handling to `memberId`; same second-parameter change for `importTransactionsCsv`. Keep every double-entry invariant (`UNBALANCED`, `ORPHAN_POSTING`), the csv error taxonomy, and the export formats byte-identical to the Feoh copy.
  - `csv.ts`: unchanged copy unless it references parties (check; it should not).

- [ ] **Step 2: Port the five test files** from `Feoh/tests/`, adapting: app/bootstrap helpers → Heorth's test conventions; anywhere a test created a party, create a household member instead and pass its id; splits assertions use `memberId`. These tests exercise the service through the routes — they will FAIL until Task 5 mounts them. So for THIS task, port only the pure-service assertions if the originals go through HTTP: check the originals; if they are HTTP-level (they are, per Feoh's integration style), write them now but mark the task pair 4+5 as one review unit and run them at the end of Task 5. In that case this task's verification is `npm run typecheck`.

- [ ] **Step 3: Run `npm run typecheck`** — PASS (service compiles against the new schema).

- [ ] **Step 4: Commit (Heorth)** — `feat: transplant finance service/validators/csv with member semantics`

---

### Task 5: Routes, module registration, proxy deletion (Heorth)

**Files:**
- Create: `Heorth/src/modules/feoh/routes.ts`, `Heorth/src/modules/feoh/index.ts`
- Modify: `Heorth/src/modules/index.ts` (add `feohModule` to `ALL_MODULES`)
- Modify: `Heorth/src/app.ts` (remove proxy mount + import)
- Delete: `Heorth/src/satellites/feoh/` (whole directory) and, if nothing else under `src/satellites/` remains, the shared `satellite-client.ts` — check imports first
- Modify: `Heorth/src/config/env.ts` (remove `FEOH_BASE_URL`, `FEOH_API_KEY`, `feohBaseUrl`, `feohApiKey`)
- Modify: `Heorth/tests/*` and `.env.example`/CI env if they set `FEOH_BASE_URL`/`FEOH_API_KEY` (grep and remove)
- Test: the five ported files from Task 4 + new `Heorth/tests/feoh-gating.test.ts`

**Interfaces:**
- Produces: `feohModule: HeorthModule` mounting `/api/v1/feoh/*` when `config.feohEnabled`, no-op otherwise.
- Consumes: Task 4 service; `requireAuth`, `requireRole` from `src/wiring.ts`; `assertNotMaintenanceAdmin`, `assertNoneAreMaintenanceAdmin` from `src/household/maintenance-admin.js`; `config.feohEnabled` from Task 2.

- [ ] **Step 1: Write `routes.ts`.** Start from `Feoh/src/modules/feoh/routes.ts`; replace its `requireAuth` import with Heorth's wiring; add the write gate, composed once, exactly as the proxy does today (`src/satellites/feoh/proxy.ts:43-55`):

```ts
const requireWriteRole = requireRole('admin', 'adult');
/** Write gate for every finance mutation route: role check + maintenance-admin
 *  quarantine on the acting principal (same composition the satellite proxy used). */
const canWrite: MiddlewareHandler = async (c, next) =>
  requireWriteRole(c, async () => {
    await assertNotMaintenanceAdmin(c.get('auth').userId);
    await next();
  });
```

Apply `canWrite` to every POST/PATCH/DELETE (accounts, envelopes, transactions, bills, import) — the same twelve the proxy guards. `POST /transactions`: parse body with the createdBy-less schema, call `assertNoneAreMaintenanceAdmin(splits.map(s => s.memberId))` when splits present, then `service.recordTransaction(body.data, c.get('auth').userId)`. Drop the `UNKNOWN_PARTY` catch branches (gone from the service). `POST /import`: no query param — `service.importTransactionsCsv(text, c.get('auth').userId)`. Everything else stays as in the Feoh copy. Compare against `git -C Heorth show v0.1.0:src/modules/feoh/routes.ts` to confirm parity with pre-extraction behavior.

- [ ] **Step 2: Write `index.ts`** (module convention + kill switch):

```ts
import type { Hono } from 'hono';
import { config } from '../../config/env.js';
import type { HeorthModule, McpRegistry } from '../registry.js';
import { feohRouter } from './routes.js';
import { feohTools } from './mcp.js';

/** Finance module (ADR 0007). Disabled (default): registers nothing — routes
 *  fall through to the /api catch-all 404, no MCP tools, UI hides via
 *  GET /api/v1/features. Data is never touched by the toggle. */
export const feohModule: HeorthModule = {
  name: 'feoh',
  register(app: Hono, mcp: McpRegistry): void {
    if (!config.feohEnabled) return;
    app.route('/api/v1/feoh', feohRouter);
    mcp.add(...feohTools);
  },
};
```

(`mcp.ts` lands in Task 6 — create it in THIS task as a stub `export const feohTools: McpTool[] = [];` with a `// filled in by the MCP task` comment so the module compiles, and note it in the commit message.)

- [ ] **Step 3: Swap registration.** Add `feohModule` to `ALL_MODULES` (replace the `NOTE: feoh is intentionally absent` comment). In `app.ts` delete the proxy import + `app.route('/api/v1/feoh', createFeohProxyRouter())` + its comment. Delete `src/satellites/feoh/`; grep for remaining imports of `satellite-client` before deleting it too. Remove the two env vars and config keys; grep `FEOH_BASE_URL\|FEOH_API_KEY\|feohBaseUrl\|feohApiKey` across `src/`, `tests/`, `.env.example`, `.github/` and clean every hit.

- [ ] **Step 4: Write `tests/feoh-gating.test.ts`.** First discover how existing tests control env-gated config (the M365 suite is the precedent: grep `tests/` for `M365_TENANT_ID` / `buildEnvSchema` and mirror the mechanism — likely setting `process.env.FEOH_ENABLED` before the config/app import, or building a schema instance directly). Cases:
  - disabled (default test env): all `/api/v1/feoh/*` routes → 404 with the catch-all envelope; `GET /api/v1/features` → `{ finance: false }`; MCP registry contains no `feoh.*` tools.
  - enabled: routes respond; features reports `{ finance: true }`.
  - authorization: a `child`-role member gets 403 on `POST /api/v1/feoh/accounts` (and one more mutation route); an admin under maintenance-admin quarantine is rejected per the quarantine's error contract.
  - toggle round-trip: with the feature enabled, create an account + a balanced transaction; rebuild the app with the feature disabled → routes 404; rebuild enabled → the data is still returned. (Same DB throughout — proves the toggle never touches data.)

- [ ] **Step 5: Enable the ported Task 4 tests** (they need routes): ensure the five files run with `FEOH_ENABLED` set per the mechanism from Step 4.

- [ ] **Step 6: Run the full backend suite** — `cd Heorth && npm test`. Expected: PASS, including all Task 4 ports and gating tests.

- [ ] **Step 7: Commit (Heorth)** — `feat: mount finance as env-gated built-in module, retire the Feoh satellite proxy`

---

### Task 6: MCP — register-once fix + finance tools (Heorth)

**Files:**
- Modify: `Heorth/src/app.ts` (`createApp` signature; delete `collectMcpTools`)
- Modify: `Heorth/src/index.ts` (consume the registry from `createApp`)
- Create: `Heorth/src/modules/feoh/mcp.ts` (replace Task 5's stub)
- Test: `Heorth/tests/feoh-mcp.test.ts` (port of Feoh's) + registry assertions in `feoh-gating.test.ts`

**Interfaces:**
- Consumes: `McpTool` handler context is `ctx.principal` (`{ userId, role }` — see `src/mcp/auth-adapter.ts` and `meals/mcp.ts` for the pattern); Task 4 service.
- Produces: `createApp(modules, mcp = new McpRegistry())` — same return type as today (the app), with the caller-supplied registry filled during the single registration pass. `collectMcpTools` is deleted (spec: modules must register exactly once).

- [ ] **Step 1: Registration fix.** Change `createApp` to accept an optional registry: `export function createApp(modules: HeorthModule[], mcp = new McpRegistry()): Hono` and use it instead of the local `const mcp`. Delete `collectMcpTools`. Update `src/index.ts` (and any other `collectMcpTools` callers — grep) to build one registry, pass it to `createApp`, and hand it to the MCP server wiring. This keeps every existing `createApp(ALL_MODULES)` call site valid while guaranteeing single registration.

- [ ] **Step 2: Write `mcp.ts`.** Start from `Feoh/src/modules/feoh/mcp.ts` and re-instate member semantics from the v0.1.0 oracle (`git -C Heorth show v0.1.0:src/modules/feoh/mcp.ts` — it had the write gate). Deltas from the Feoh copy: remove `createdBy` from `feoh.record_transaction` / `feoh.import_csv` input schemas; splits input renamed `memberId`; each write tool derives the actor from `ctx.principal.userId` and gates on role first:

```ts
function assertCanWrite(ctx: { principal: { userId: string; role: Role } }): McpToolResult | null {
  if (ctx.principal.role !== 'admin' && ctx.principal.role !== 'adult') {
    return toolError('Finance writes require an admin or adult member');
  }
  return null;
}
```

Write handlers call `assertCanWrite`, then `await assertNotMaintenanceAdmin(ctx.principal.userId)` (and `assertNoneAreMaintenanceAdmin` over split member ids), then the service with `ctx.principal.userId` as `createdBy`. Drop the `UNKNOWN_PARTY` tool-error branches. Read tools unchanged. Do NOT port `feoh.list_parties` (parties are gone).

- [ ] **Step 3: Port `Feoh/tests/feoh-mcp.test.ts`**, adding: a child-role principal gets the tool-error on `feoh.record_transaction`; the registry from `createApp` contains the six `feoh.*` tools when enabled and none when disabled (extend `feoh-gating.test.ts` if easier). Follow how existing Heorth MCP tests invoke tools (grep `tests/` for `principal` / mcp tests).

- [ ] **Step 4: Run the full backend suite** — PASS.

- [ ] **Step 5: Commit (Heorth)** — `feat: finance MCP tools with principal-derived createdBy; register modules exactly once`

---

### Task 7: Web gating (Heorth web)

**Files:**
- Create: `Heorth/web/src/api/features.ts`
- Modify: `Heorth/web/src/components/layout/sidebar.tsx` (filter nav)
- Modify: `Heorth/web/src/pages/feoh.tsx` (unavailable state)
- Modify: the en/de i18n catalogs (find them: `grep -r "nav.feoh" Heorth/web/src`) — add `feoh.unavailableTitle` / `feoh.unavailableBody` keys in both languages
- Test: `Heorth/web/src/components/layout/sidebar.test.tsx` (or the existing sidebar/nav test file), `Heorth/web/src/pages/feoh.test.tsx` (extend/create following sibling page tests)

**Interfaces:**
- Consumes: `GET /api/v1/features` → `{ data: { finance: boolean } }` (Task 2), fetched with the same client util `web/src/api/feoh.ts` uses (open it and mirror the fetch/query pattern — the web app uses TanStack Query if other api modules do; match exactly).
- Produces: `getFeatures(): Promise<{ finance: boolean }>` + whatever hook shape the codebase convention dictates (e.g. `useFeatures()`).

- [ ] **Step 1: Write the failing web tests.** Sidebar: with features `{ finance: false }` the `nav.feoh` item is absent; with `{ finance: true }` it renders. Feoh page: with finance disabled, renders the unavailable message (assert on the i18n key's English text); enabled renders the normal content. Mock the features fetch the same way sibling tests mock their api modules. **Failure semantics:** a failed/errored features fetch must behave as all-off (assert once).

- [ ] **Step 2: Run** — `cd Heorth/web && npm test`. Expected: FAIL.

- [ ] **Step 3: Implement.** `api/features.ts` mirroring `api/feoh.ts`'s style. Sidebar: `navItems` stays the static catalog; the component filters — `const visible = navItems.filter((i) => i.labelKey !== 'nav.feoh' || features.finance)`. Feoh page: when `features.finance === false`, render a simple centered card with the two i18n strings instead of the finance components (route stays registered — direct navigation gets the card, not a crash). German copy for the catalog: `"Finanzen sind auf diesem Server nicht aktiviert."` (body), `"Funktion nicht aktiviert"` (title); English: `"Feature not enabled"` / `"Finance is not enabled on this server."`

- [ ] **Step 4: Run web suite** — PASS. Also `cd Heorth/web && npm run build` (or the repo's build gate) to prove the bundle compiles.

- [ ] **Step 5: Commit (Heorth)** — `feat(web): gate finance nav and page on the runtime feature flag`

---

### Task 8: Heorth docs + release (Heorth)

**Files:**
- Modify: `Heorth/CLAUDE.md` (remove satellite-proxy mentions; document `FEOH_ENABLED` in a short "Feoh finance module" note near the M365 enablement paragraph), `Heorth/README.md` (same sweep — grep `satellite\|Feoh` and correct), `Heorth/CHANGELOG.md`
- Modify: `Heorth/docs/superpowers/specs/2026-08-06-plugin-system-design.md` (prepend a `> **SUPERSEDED 2026-08-10** by the Feoh merge (meta repo docs/plans/feoh-merge.md, ADR 0007) — the plugin host was never implemented; Feoh ships as a built-in env-gated module instead.` banner under the title)
- Modify: `Heorth/.env.example` if not already done in Task 5

**Interfaces:** none produced; requires Tasks 2–7 merged and green.

- [ ] **Step 1: Docs sweep** — grep `Heorth/` (excluding `node_modules`, `web/dist`) for `satellite`, `FEOH_BASE_URL`, `proxy` and update every stale statement. CLAUDE.md's module conventions section gains one line: finance module is env-gated via `FEOH_ENABLED` (default off), tests toggle it per the gating-test mechanism.

- [ ] **Step 2: CHANGELOG** — new minor section (next after the current version — check `Heorth/package.json`; expected `0.4.0`): "Feoh merged back as a built-in optional feature (satellite retired, ADR 0007): `FEOH_ENABLED` kill switch, `GET /api/v1/features`, finance tables with direct member FKs (fresh start — the satellite's database is not migrated), MCP tools restored to Heorth's registry, modules now register exactly once." Bump `package.json` version.

- [ ] **Step 3: Verify everything** — `npm run typecheck && npm run build && npm test` (backend, with DATABASE_URL) and `cd web && npm test && npm run build`. All green before the release commit.

- [ ] **Step 4: Commit + tag** — `chore(release): v0.4.0`, then `git tag v0.4.0 && git push && git push --tags` (via `gh`-authenticated remote; if the repo's flow is staging→main, merge to main first per the Phase 2 release precedent — check `git -C Heorth log v0.3.1 --oneline -1` and the branch layout, and mirror it).

---

### Task 9: Deploy + meta-repo cleanup (meta repo)

**Files:**
- Modify: `deploy/compose.dev.yml`, `deploy/compose.prod.yml` (drop the `feoh` service, Heorth's `FEOH_BASE_URL`/`FEOH_API_KEY` env + `depends_on: feoh`, add `FEOH_ENABLED` to Heorth's environment as documented-off, e.g. `FEOH_ENABLED: ${FEOH_ENABLED:-false}`)
- Modify: `deploy/initdb/` (remove the feoh role/database bootstrap), `deploy/README.md` (port table, the Feoh bootstrap walkthrough, key-minting section), `deploy/backup.sh` (drop the feoh database if referenced)
- Modify: `CLAUDE.md` (root: folder table row for `Feoh/` → "merged into Heorth 2026-08-10, repo archived"), `CONTEXT.md` (same sweep)

**Interfaces:** requires Task 8 (a Heorth image with the module) conceptually; compose edits are safe regardless because the stack is dev-only.

- [ ] **Step 1: Guardrail dump** — if the dev stack's db container is up (`docker compose -f deploy/compose.dev.yml ps`), run `docker compose -f deploy/compose.dev.yml exec db pg_dump -U feoh feoh_dev > deploy/feoh-final-dump-2026-08-10.sql` and keep it OUT of git (`.gitignore` if needed); if the container is down, note in the commit message that no dump was takeable/needed.

- [ ] **Step 2: Edit the compose files, initdb, README, backup.sh** per the file list. Grep `deploy/` for `feoh` afterwards — remaining hits must be historical prose only.

- [ ] **Step 3: Sweep `CLAUDE.md` + `CONTEXT.md`** — update the Feoh rows/entries; do not delete history, state the merge + archival.

- [ ] **Step 4: Validate** — `docker compose -f deploy/compose.dev.yml config -q` and same for prod (syntax check without starting anything).

- [ ] **Step 5: Commit (meta repo)** — `chore(deploy): retire the feoh service and database after the merge (ADR 0007)`

---

### Task 10: Archive the Feoh repo (Feoh)

**Files:**
- Modify: `Feoh/README.md` (banner at top)

**Interfaces:** requires Tasks 5–8 verified green (the repo is the comparison oracle until then).

- [ ] **Step 1: README banner** — prepend: `> **ARCHIVED 2026-08-10.** Feoh's finance domain was merged back into [Heorth](https://github.com/Wyrhta-Labs/Heorth) as a built-in optional module (meta-repo ADR 0007, docs/plans/feoh-merge.md). This repo stays read-only as the historical record of the satellite (v0.1.0).`

- [ ] **Step 2: Commit + push (Feoh repo, main)** — `docs: archive notice — merged back into Heorth (ADR 0007)`

- [ ] **Step 3: Archive** — `gh repo archive Wyrhta-Labs/Feoh --yes`, then verify: `gh repo view Wyrhta-Labs/Feoh --json isArchived`.

---

## Self-review notes (already applied)

- Spec coverage checked against `docs/plans/feoh-merge.md`: prerequisite ADR/strategy (T1), kill switch + features contract (T2), transplant + adaptation workstream (T3–5), proxy-guard restoration (T5), RESTRICT + test (T3, T5), MCP register-once + principal path (T6), UI gating incl. fetch-failure = off (T7), docs/changelog/spec supersession (T8), deploy + pg_dump guardrail (T9), archive-last (T10). Website brief re-issue is out of scope per the spec's interim workflow.
- Task 4/5 share one test payload deliberately (Feoh's tests are HTTP-level); Task 4's gate is typecheck, the pair's real gate is Task 5 Step 6.
- Naming pinned: `FEOH_ENABLED`, `config.feohEnabled`, `feohModule`, `featuresRouter`, `{ finance: boolean }`, `expense_splits.member_id`, `canWrite`, `assertCanWrite`.
