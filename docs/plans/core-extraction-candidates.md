# Cross-project duplication — candidates for `@wyrhta/core`

Audit date: **2026-08-24**. Trees audited: `Heorth` (`191dd48`), `KithLedger`
(`7a7c70c`), `wyrhta-core` (`7357748` = v0.5.0).

> **Status: all five done, same day.** Everything below shipped in
> **`@wyrhta/core` 0.6.0** (tag `v0.6.0`, published), and both consumers moved
> their pin and deleted their copies: Heorth `b3f035e` (385/385 tests),
> KithLedger `61932ff` (239/239). Per-item outcomes are recorded inline. The
> document is kept as written — the reasoning is what justifies each move, and
> the "rejected" section is the part worth re-reading before the next sweep.

Written as the closing step of the 0.5.0 env work, which was itself triggered
by the standing rule: **a function used by more than one project belongs in
core, where that is possible and feasible.** The env helpers
(`emptyToUndefined`, the parse-or-exit startup guard) were the first hit and
shipped in 0.5.0; this is what the same sweep turned up afterwards.

Core's own rule still governs everything below: *no speculative features —
capabilities land demand-driven*. Two consumers already carrying the same code
IS the demand, so each item names the concrete duplication rather than a
possible future use.

## Method

Every top-level `function` / `const … = (…)` in `Heorth/src` (214) and
`KithLedger/src` (76) was extracted and intersected by name, then the
intersection was read pairwise; separately, the files known to be
copy-adapted between the two services (`src/config/env.ts`, `src/app.ts`,
`tests/setup.ts`) were diffed. Name-matching finds true copies but misses
renamed ones, so the pairwise diffs are what caught items 2 and 5.

Names defined in both trees: `addDuration`, `resolveApiKey`, `createApp`,
`main`.

## 1. Postgres SQLSTATE classification — Heorth's version supersedes core's

> **Done** — core `ec269be` (`pgErrorCode` / `isPgError` in `./db`, `isUniqueViolation` re-expressed on top, 12 tests). Heorth deleted `src/db/pg-errors.ts`.

**Highest value of the set.** Core exports `isUniqueViolation`
(`wyrhta-core/src/identity/service.ts:27`) — a 23505-only predicate, living in
`./identity` although it is pure database plumbing. Heorth independently grew
the general form in `Heorth/src/db/pg-errors.ts`: `pgErrorCode(e)` walks the
`cause` chain and returns the SQLSTATE, and `isPgError(e, ...codes)` tests any
set of them (23505 unique, 23503 foreign key, 23001 restrict). Heorth uses it
in `modules/feoh/item-costs.ts` and `modules/feoh/occurrences.ts`; KithLedger
imports core's narrow one in `services/relationships.ts`; Heorth's
`household/service.ts` reaches for core's via `wiring.ts`.

Both implementations exist because of the same drizzle-orm ≥ 0.44 behaviour
(the driver error is wrapped in a `DrizzleQueryError`, so `e.code` is
`undefined`), and both walk the chain — one generally, one for a single code.

Proposal: add `./db` to core exporting `pgErrorCode` and `isPgError`, move
Heorth's implementation and its explanatory comment there verbatim, and
re-express `isUniqueViolation` as `isPgError(e, '23505')` — keeping the
existing export and its home so nothing breaks. Then Heorth deletes
`src/db/pg-errors.ts` and imports from core.

Impact: additive, non-breaking, patch or minor. Heorth's file has no tests of
its own; port a small suite (bare error, wrapped, double-wrapped, non-object)
along with it.

## 2. The `.env` loader in `src/config/env.ts` — verbatim in both

> **Done** — core `2f1228c` (`loadDotEnv({ path, skip })`, 7 tests). The boundary exception is now stated in both `identity/keys.ts` and the README. Heorth passes `skip: process.env['VITEST'] !== undefined`; KithLedger calls it bare.

The read-`.env`-without-overriding loop at the top of both `src/config/env.ts`
files is character-identical: same regex, same "exported vars always win"
rule, same quote-stripping, same `catch` comment. Heorth's copy additionally
sits behind `if (process.env['VITEST'] === undefined)` so a developer's local
`.env` cannot re-enable gated modules during a test run — a hermeticity fix
KithLedger's copy never received.

Proposal: `loadDotEnv({ path?, skip? })` in core's `./config`, next to the env
helpers 0.5.0 already put there. Heorth calls it with
`skip: process.env['VITEST'] !== undefined`; KithLedger calls it bare, and can
adopt the same guard later as a one-line change rather than a re-derivation.

Caveat worth stating in the review: core's boundary says *"core never reads env
or files"* (`src/identity/keys.ts:5-9`). `./config` is the module where that
boundary is deliberately crossed already (it is the env module), so a loader
belongs there if anywhere — but this is a **design call**, not mechanical, and
the alternative (accept two copies of ten lines) is defensible.

## 3. `addDuration` — Heorth's is strictly better than KithLedger's copy

> **Done** — core `548a338` (`parseDuration` / `isPositiveDuration` / `addDuration` in `./lib`, 12 tests). KithLedger `61932ff` also tightened its `recurrence` validator to require an advancing duration and made the completion path degrade rather than throw on a pre-validator row; four regression tests cover it. The web UI only submits values from `RECURRENCE_OPTIONS`, so nothing it sends is newly rejected.

`Heorth/src/lib/duration.ts:63` and `KithLedger/src/services/reminders.ts:20`
parse the same ISO-8601 subset with the same regex and add it to a `Date`.
Heorth's version is the more developed one: it also handles `PnW`, splits out
`parseDuration` and `isPositiveDuration` (which rejects the degenerate `P` /
`PT` / `P0D` that parse cleanly but advance nothing), and is covered by the
calendar-recurrence tests. KithLedger's is the earlier, simpler copy —
`duration.match(...).map(Number)` with no zero-advance guard — and a `P0D`
reminder recurrence there would re-fire on the same date.

ISO-8601 duration arithmetic is not a business domain, so this clears the "no
business domains" line.

Proposal: move `parseDuration` / `isPositiveDuration` / `addDuration` and the
`DurationParts` type into core `./lib`, port Heorth's tests, then have both
services import it. KithLedger gains the zero-advance rejection; check its
reminder tests for anything that relied on `P` parsing as a no-op.

## 4. `trimTrailingSlash` — a divergence, not just a duplicate

> **Done** — core `c0b2478` (7 tests). Heorth `b3f035e` switched off Hono's
> version and gained `tests/trailing-slash.test.ts`, which pins the path-only
> `Location`. The redirect *conditions* are identical to Hono's (404 + GET/HEAD
> + non-root + trailing slash), so only the header shape changed. Topology
> checked as the item asked: HAProxy fronts the household and terminates TLS
> while the stack publishes plain host ports (`deploy/README.md`), so Heorth
> was emitting `http://` in a `Location` for an `https://` request — the leak
> half of the bug was live, and there is no prefix stripping to worry about
> since routing is by host.

KithLedger does **not** use Hono's `trimTrailingSlash()`; it has its own in
`src/lib/trailing-slash.ts` because Hono's builds the redirect `Location` from
`c.req.url`, which behind a reverse proxy emits the wrong scheme, host, or a
path missing the stripped prefix (KithLedger issue #1). Heorth's `src/app.ts:6`
still imports Hono's version and therefore still has the bug — its middleware
stack is otherwise identical to KithLedger's, line for line.

This is the one item on the list that fixes something rather than deleting
something. Proposal: move KithLedger's implementation into core `./http`
alongside `securityHeaders` / `requestId` / `errorHandler` — the module where
both apps already get their middleware — and switch Heorth's import to it.
Verify against Heorth's deploy topology first (`deploy/compose.prod.yml`,
the Caddy prefix rules) so the behaviour change is intentional there.

## 5. The destructive-test database guard in `tests/setup.ts`

> **Done, on the terms the item set** — core `6d8f128` puts `assertTestDatabase()` on the `@wyrhta/core/testing` subpath, exported from no other barrel, so test scaffolding stays unreachable from application code.

Both suites refuse to run unless the `DATABASE_URL` database name ends in
`_test`, because both truncate every table between tests. Same allowlist idea,
same unparseable-URL fallback, same "never interpolate the URL, it carries a
password" care — independently written, with slightly different messages.

Lower priority, and a genuine boundary question: core is a runtime library and
this is test scaffolding. If it moves at all it wants its own subpath
(`@wyrhta/core/testing`) so nothing test-only reaches production bundles. Left
as a deliberate no-op unless a third service appears and writes it a third
time.

## Looked at and deliberately rejected

- **`resolveApiKey`** (`Heorth/src/wiring.ts:47`, `KithLedger/src/identity.ts:65`)
  — the shared half is already core's `validateApiKey`; what remains is a
  six-line user lookup, and KithLedger's version then does the B8 credential-kind
  check (ADR 0004 §2) that Heorth has no concept of. Extracting the common
  prefix would save less than it obscures.
- **`createApp`** — same name, same first six middleware lines, but Heorth's
  takes a `HeorthModule[]` registry and KithLedger's mounts a fixed router. The
  shared part is the middleware order, which is convention, not code.
  (The middleware themselves already come from core.)
- **`main`** — bootstrap sequences that differ in every step.
- **`KithLedger/src/lib/validation.ts:validationError`** vs core's
  `createErrorHandler` — not duplicates. The former formats an explicit
  per-route `safeParse` failure; the latter catches a thrown `ZodError`
  globally. Different layers, no overlap, Heorth has no counterpart.

## What was actually done

The suggested order (1 → 4 → 3 → 2 → 5) was followed, one focused commit each,
then a single `release: 0.6.0` commit — a minor rather than a patch because of
the new subpath and module surface, though nothing existing changed shape.
`v0.6.0` published cleanly (run 32738842095), and both consumers moved in one
commit apiece.

Item 5 was written up as "defer unless a third service appears". It shipped
anyway, because the subpath answers the objection that motivated the deferral:
the guard is only reachable from `@wyrhta/core/testing`, so a runtime library
does not start carrying test scaffolding in its main barrel.

Net: two live bugs closed (Heorth's proxy-unsafe redirect, KithLedger's
unvalidated recurrence), five duplicate implementations reduced to one each,
and ~250 lines deleted across the two services.
