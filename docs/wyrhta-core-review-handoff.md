# Closed — the `@wyrhta/core` code review of 2026-08-23

**Status: closed 2026-08-25.** All ten findings are fixed and shipped. This file
was a work order; it is kept now only as the provenance record of that review —
which commit closed which finding, and why finding 9 was implemented instead of
deferred. **There is no open work here.** One residual gap that the review's own
fix left behind is recorded at the end, and is tracked as new work, not as an
unclosed finding.

Nothing in the original list was a production incident. These were review
findings on a self-hosted foundation library, ranked so the next session could
pick them up in order.

Line numbers in this document refer to the tree at commit `0dcf674` (v0.4.0,
before the 0.4.2/0.5.0 work) and no longer resolve — the 0.6.0 duplication sweep
moved several of these modules.

## The ten findings, as shipped

| # | Finding | Commit |
|---|---|---|
| 1 | `CORE_VERSION` was `0.3.0` in a `0.4.0` package; smoke test only checked non-empty | `38df9a9` — constant bumped, smoke test now compares against `package.json` |
| 2 | `coreMigrationsFolder()` pointed at a folder missing from the published tarball (`tsc` doesn't copy `.sql`) | `be1105e` — `scripts/copy-migrations.mjs` runs after `tsc` in `build`; dist verified to contain the SQL + meta |
| 3 | `rateLimit` trusted the client-supplied `X-Forwarded-For` (bypass, shared bucket, unbounded store) | `d6f1559` + `eed04dd` — 3a store pruning (`maxEntries`, `size` getter), 3b injectable `resolveIp`, 3c trust requirement in the README module map and in `docs/plans/household-stack-compose.md` (meta repo `07bdac9`). **3a was incomplete — see Residual below.** |
| 4 | RSA CRT members (`p`/`q`/`dp`/`dq`/`qi`) could survive `loadPublicKey` and leak into a JWKS document | `0dcf674` — `assertShape` rejects them in public material, `toJwks` strips all six private members |
| 5 | `seedHousehold` was not race-safe — two concurrent boots both inserted and the loser crashed the boot on a `23505` | `fd9b1c6` — the insert catches the unique violation via the shared `isUniqueViolation` helper and re-selects the winner's row |
| 6 | `authenticate` leaked user existence via timing (unknown email skipped the argon2 work) | `a070aac` — the not-found path verifies against a lazily-built throwaway hash (`verifyDummyPassword` in `./identity`); return shape unchanged |
| 7 | HSTS localhost check was a substring match (`notlocalhost.example.com` lost HSTS) | `c070ac6` — host is port-stripped (bracketed IPv6 included) and compared exactly: `localhost`, `*.localhost`, `127.0.0.1`, `::1` |
| 8 | `errorHandler` read `process.env.NODE_ENV`, breaking the env-agnostic boundary | `b91841f` — design call resolved as handoff option 1: additive `createErrorHandler({ validationDetails })` factory; the `errorHandler` const keeps the NODE_ENV default; README module map states the deviation |
| 9 | `baseEnvSchema` forced a 32-char `JWT_SECRET` even on a verify-only deployment | `d7b1efb` — the base field is `.optional()`; both consumers re-declare it as required in their `extend()` shape. Shipped in **0.5.0** (minor — the inferred type changes) |
| 10 | README install examples still said 0.3.1 | `52da60d` — both point at 0.4.1, in the same commit as the version bump |

### Why finding 9 was implemented rather than deferred

The review recommended deferring it until the satellite-token-exchange work
(ADR 0009) actually needed a verifier-only deployment. It was implemented on
2026-08-24 instead, because the standing instruction that a function living in
more than one project belongs in core made `./config` a module that was going to
be touched anyway — both consumers had grown the same two env helpers
(`emptyToUndefined`, and the safeParse/print/exit startup guard), so finding 9
rode along in the same minor:

- `d7b1efb` — `JWT_SECRET` is `.optional()` in `baseEnvSchema`.
- `d92c788` — `emptyToUndefined` and `parseEnvOrExit` added to `./config`.
  `parseEnvOrExit` takes any `z.ZodType`, not just an object shape, so a schema
  carrying a `superRefine` group check (KithLedger's satellite group) still works.
- `7357748` — release 0.5.0.
- Heorth `191dd48`, KithLedger `7a7c70c` — both build their env schema on
  `baseEnvSchema.extend()`, drop the locally duplicated helpers, and re-declare
  `JWT_SECRET` as required (both sign HS256).

A verifier-only deployment (ADR 0009) can now hold no `JWT_SECRET` at all.

## Verification, 2026-08-25

Every finding was re-verified against the tree at **0.7.0** (`5114fa0`) — after
the 0.6.0 duplication sweep and the 0.7.0 Node 24 floor — to check that no later
commit had weakened a fix. Nine of ten **hold**, with the two most at risk of
drift confirmed clean:

- Finding 5 survived 0.6.0 moving SQLSTATE classification out of
  `identity/service.ts` into `./db` — `isUniqueViolation` is still 23505-aware
  and still walks the drizzle-orm `cause` chain, and is tested there.
- Finding 6's dummy hash is built *through* `hashPassword` itself, so the
  argon2id parameters match by construction rather than by a copied constant.
  A dummy with different memory or time cost would have leaked the timing
  difference it was added to hide.
- Finding 4 is broader than its own description: the CRT rejection runs through
  shared shape logic across both supported algorithms, not only RSA. Only an
  explicit EdDSA-with-bogus-CRT test is missing — a coverage nicety, not a hole.

Observed baseline at 0.7.0: `npm run typecheck` clean, `npm run build` clean with
`dist/db/migrations` carrying the SQL plus both meta files (confirmed present in
the tarball surface via `npm pack --dry-run`, which is what finding 2 was about),
and **183 tests passing across 23 files**. The old baseline of 131 in this
document was from v0.4.2.

## Residual — `maxEntries` was a trigger, not a cap

Finding 3a is the one fix that did not do what it claimed, and the claim was
written into the code:

> The store prunes expired buckets once it passes `maxEntries` (default 10 000)
> so a flood of fresh keys cannot grow it without bound

The sweep deleted only **expired** buckets. In the exact scenario the option was
added to defend against — a flood of unique keys, one request per unique
`X-Forwarded-For` value — every bucket is fresh (`resetAt = now + windowMs`),
nothing is expired, nothing is deleted, and the map grows for the whole window.
`maxEntries` was where the useless scan *started*, not where growth stopped. The
second-order effect was the worse one: past that size the O(n) walk ran on every
subsequent request and freed nothing, so the flood degraded into quadratic work.

Fixed 2026-08-25 by making `maxEntries` a real cap: the expired sweep stays as
the first pass, then eviction runs in `Map` insertion order until the store is at
or below the cap. Insertion order is the principled policy here, not merely the
cheap one — `windowMs` is constant per `rateLimit` instance and `resetAt` is set
once at insertion and never extended (`entry.count++` does not touch it), so
insertion order *is* `resetAt` ascending, and front-of-map eviction drops
precisely the soonest-to-expire buckets. The accepted tradeoff: an evicted key
that returns within its old window gets a fresh bucket, and so a fresh budget.

The **trust** half of finding 3 is not part of this. 3c was resolved as
documentation by design — the default XFF key is unsound on a direct connection,
`resolveIp` is injectable for deployments that need something else, and both
facts are stated in the doc comment and the README module map. That is a settled
design call, not a gap.

## Release notes

Release discipline (README "Release discipline", CHANGELOG header): every change
ships as a semver tag **plus a CHANGELOG entry**; pre-1.0 a minor bump may break,
a patch bump is safe.

- **0.4.1 (patch)** shipped **2026-08-24** (tag `v0.4.1`) carrying 3a, 3b/3c,
  and 10. Heorth and KithLedger moved to it the same day: KithLedger keys its
  `/auth/token` limiter on the same `getIp` its audit log records
  (`resolveIp`), Heorth is a lockfile-only move. Two release-blocker fixes
  rode along in the tag: the core migration SQL that a machine-global
  `*.sql` ignore kept out of git (`be87446`), and `CORE_VERSION` (`2927d59`).
- **0.4.2 (patch)** shipped **2026-08-24** (tag `v0.4.2`) carrying 5, 6, 7, 8.
  Nothing in that set is breaking; consumers on `^0.4.0` pick it up on a
  lockfile refresh.
- **0.5.0 (minor)** shipped **2026-08-24** (tag `v0.5.0`) carrying 9 plus the
  two shared env helpers. Minor because the inferred type of `JWT_SECRET`
  changes; both consumers moved their pin from `^0.4.0` to `^0.5.0` the same
  day. Remaining cross-project duplication was catalogued in
  `docs/plans/core-extraction-candidates.md`.
- **0.6.0 (minor)** shipped **2026-08-24** (tag `v0.6.0`) carrying all five
  items of that catalogue: SQLSTATE classification (`./db`), a proxy-safe
  `trimTrailingSlash` (`./http`), ISO 8601 duration arithmetic (`./lib`),
  `loadDotEnv` (`./config`), and `assertTestDatabase` on the new
  `@wyrhta/core/testing` subpath. Additive throughout; minor for the new
  subpath and module surface. Heorth `b3f035e` and KithLedger `61932ff` moved
  the same day, each deleting its duplicate copies.
- **0.7.0 (minor)** shipped **2026-08-24** (tag `v0.7.0`) — metadata and CI
  only, no source change: the supported Node floor moves from 22.12 to 24,
  which every consumer already runs. Minor rather than patch because pre-1.0 a
  minor may break, and an `engines` floor can.
- The `maxEntries` cap fix above is **uncommitted** as of 2026-08-25 — the code
  and its tests sit in the `wyrhta-core` working tree (185 tests passing, up from
  183), awaiting a fix commit, then the version bump, CHANGELOG entry and tag.
  It is a patch: no exported shape or default changes.
- The publish pipeline validates `v*` tag == `package.json` version and runs
  typecheck + tests + build first, so the usual flow is: fix commits →
  version bump + CHANGELOG → tag `vX.Y.Z` → CI publishes.
