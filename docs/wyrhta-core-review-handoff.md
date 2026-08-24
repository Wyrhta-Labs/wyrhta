# Handoff — `@wyrhta/core` code review, remaining fixes

A full code review of `wyrhta-core` at **v0.4.0** was done on **2026-08-23**.
**Every finding (1–10) is now fixed and committed** — see *Already done*.
Finding 9, which this document recommended deferring, was implemented on
**2026-08-24** and shipped in **0.5.0** together with two env helpers lifted
out of the consumers; both consumers now build on it. Line numbers below refer
to the tree at commit `0dcf674`, before the 0.4.2/0.5.0 work.

Nothing in this list was a production incident — these are review findings on a
self-hosted foundation library, ranked so the next session could pick them up
in order.

## How to work these

- The work happens in the sibling repo `wyrhta-core/` (its own git repo,
  `Wyrhta-Labs/wyrhta-core`). Read its `README.md` first — the UPPER_SNAKE_CASE
  domain-error convention, the "what core is NOT" boundary, and the release
  discipline all constrain how these fixes should be written.
- Baseline to hold: `npm run typecheck` clean, `npm test` = **131 passing**
  (as of v0.4.2),
  `npm run build` clean (the build now also copies migrations into `dist/`).
- One change → one focused commit, repo-local, conventional-commit style
  (`fix(scope): …`). If an item is tracked as a GitHub issue, name it in the
  commit message so the issue timeline picks it up.
- Items marked **(design call)** need a decision before code; the others are
  mechanical once the stated approach is accepted.

## Already done (do not redo)

| # | Finding | Commit |
|---|---|---|
| 1 | `CORE_VERSION` was `0.3.0` in a `0.4.0` package; smoke test only checked non-empty | `38df9a9` — constant bumped, smoke test now compares against `package.json` |
| 2 | `coreMigrationsFolder()` pointed at a folder missing from the published tarball (`tsc` doesn't copy `.sql`) | `be1105e` — `scripts/copy-migrations.mjs` runs after `tsc` in `build`; dist verified to contain the SQL + meta |
| 4 | RSA CRT members (`p`/`q`/`dp`/`dq`/`qi`) could survive `loadPublicKey` and leak into a JWKS document | `0dcf674` — `assertShape` rejects them in public material, `toJwks` strips all six private members |
| 3 | `rateLimit` trusted the client-supplied `X-Forwarded-For` (bypass, shared bucket, unbounded store) | `d6f1559` + `eed04dd` — 3a store pruning (`maxEntries`, `size` getter), 3b injectable `resolveIp`, 3c trust requirement in the README module map and in `docs/plans/household-stack-compose.md` (meta repo `07bdac9`) |
| 10 | README install examples still said 0.3.1 | `52da60d` — both point at 0.4.1, in the same commit as the version bump |
| 5 | `seedHousehold` was not race-safe — two concurrent boots both inserted and the loser crashed the boot on a `23505` | `fd9b1c6` — the insert catches the unique violation via the shared `isUniqueViolation` helper and re-selects the winner's row |
| 6 | `authenticate` leaked user existence via timing (unknown email skipped the argon2 work) | `a070aac` — the not-found path verifies against a lazily-built throwaway hash (`verifyDummyPassword` in `./identity`); return shape unchanged |
| 7 | HSTS localhost check was a substring match (`notlocalhost.example.com` lost HSTS) | `c070ac6` — host is port-stripped (bracketed IPv6 included) and compared exactly: `localhost`, `*.localhost`, `127.0.0.1`, `::1` |
| 9 | `baseEnvSchema` forced a 32-char `JWT_SECRET` even on a verify-only deployment | `d7b1efb` — the base field is `.optional()`; both consumers re-declare it as required in their `extend()` shape. Shipped in **0.5.0** (minor — the inferred type changes) |
| 8 | `errorHandler` read `process.env.NODE_ENV`, breaking the env-agnostic boundary | `b91841f` — design call resolved as handoff option 1: additive `createErrorHandler({ validationDetails })` factory; the `errorHandler` const keeps the NODE_ENV default; README module map states the deviation |

## 5. `seedHousehold` is not race-safe — (mechanical)

`src/household/service.ts:13-27`. Two concurrent boots (e.g. a container
restart racing itself, or two replicas of the same single-household service)
both see zero rows, both insert, and the loser gets a `23505` that crashes the
boot instead of reading back the winner's row — despite the comment claiming
"idempotent".

Fix: catch the unique violation and re-select. `isUniqueViolation` already
exists in `src/identity/service.ts:27` (and is 23505-aware through the
drizzle-orm ≥ 0.44 `cause` chain). Either import it into
`src/household/service.ts` or keep household self-contained with a two-line
local check — prefer importing, the Postgres-specific logic should live in
one place.

```ts
try {
  const [row] = await db.insert(household).values(…).returning();
  if (!row) throw new Error('Failed to seed household');
  return row;
} catch (error) {
  if (isUniqueViolation(error)) {
    const [winner] = await db.select().from(household).limit(1);
    if (winner) return winner;
  }
  throw error;
}
```

Test: mock `db` whose `insert` throws `{ code: '23505' }` and whose `select`
returns the existing row; assert the existing row comes back. The existing
tests in `tests/household/household.test.ts` show the mock style.

## 6. `authenticate` leaks user existence via timing — (mechanical, hardening)

`src/identity/service.ts:64-73`. When the email is unknown the function
returns `null` without running argon2 at all; when it is known, a full
argon2id verification runs (~50–100 ms at default parameters). The difference
is measurable remotely and enumerates valid emails.

Fix: verify against a dummy hash on the not-found path so both paths do
real work. Suggested home: `src/identity/password.ts` exports a lazily-built
dummy (e.g. `const dummy = await hashPassword(DUMMY_PLAINTEXT)` computed once
on first use, module scope) and `authenticate` calls
`await verifyPassword(EMPTY_HASH, password)` instead of returning early.
`verifyPassword` already never throws, so the shape of `authenticate` stays
the same. Note the dummy must be argon2id with comparable parameters to what
`hashPassword` produces — deriving it with `hashPassword` guarantees that.

Test: not-found path takes on the order of a real verification (asserting an
absolute duration is flaky; instead assert the dummy-verify branch is
exercised, e.g. by spying on `argon2.verify` or by a relative-timing smoke
assertion with a generous bound).

## 7. HSTS localhost check is a substring match — (mechanical)

`src/http/middleware/security-headers.ts:14-17`. `host.includes('localhost')`
also matches `notlocalhost.example.com`, so a legitimate public host can
silently lose HSTS (and `includes('127.0.0.1')` has the same disease).

Fix: strip the port, then compare exactly:

```ts
const host = (c.req.header('host') ?? '').split(':')[0] ?? '';
const isLocal = host === 'localhost' || host.endsWith('.localhost')
  || host === '127.0.0.1' || host === '::1';
```

Tests: `Host: notlocalhost.example.com` **gets** HSTS; `Host: localhost:4000`,
`Host: myapp.localhost`, `Host: 127.0.0.1:3000` do not. Extend
`tests/http/middleware.test.ts` (the existing `securityHeaders` describe).

## 8. `errorHandler` reads `process.env.NODE_ENV` — (design call)

`src/http/middleware/error-handler.ts:8-9`. Every other module in core is
deliberately env-agnostic — the boundary is stated in
`src/identity/keys.ts:5-9` ("Core never reads env or files") — and this is the
one spot that breaks it. The read only gates whether Zod field names leak in
`details`, so the risk is low; the smell is real.

Options, in order of preference:

1. Keep the `errorHandler` const export (both consumers import it as a value —
   `Heorth/src/app.ts:8`, `KithLedger/src/app.ts:9`; changing the export shape
   is breaking) and add an optional `createErrorHandler({ validationDetails? }:
   { validationDetails?: boolean })` factory for apps that want to decide
   explicitly. The const keeps today's NODE_ENV behavior as the default.
2. Accept the deviation and document it: one line in the README module map
   ("`errorHandler` is the one core export that reads `NODE_ENV`, to keep
   validation details out of production error bodies").

Either is defensible; 1 is more in the spirit of the library, 2 is less code.
Whichever is chosen, the module-map line in `README.md` should say so.

## 9. `baseEnvSchema` forces a 32-char `JWT_SECRET` — DONE (was: design call, deferrable)

`src/config/env.ts:5-7`. The base schema unconditionally requires
`JWT_SECRET` ≥ 32 chars — even for a deployment that only *verifies*
asymmetrically signed tokens, a flow 0.2.0 explicitly built
(`createAuthGuards` accepts `jwtVerificationKeys` with no secret, and the
guards even throw `MISSING_JWT_VERIFICATION_KEY` only when *neither* is given).

Today this is friction, not a bug: both consumers run issuer + verifier in one
process and sign HS256, so they have a secret anyway. It bites when the
satellite-token-exchange phase (ADR 0009) lands a verifier-only deployment.

If implemented: make the base field
`z.string().min(32).optional()` and let apps that sign re-declare it as
required in their `extra` shape (`baseEnvSchema.extend` replaces keys, so this
composes). Caveat: the inferred type of `JWT_SECRET` changes from `string` to
`string | undefined`, which may break consumer typechecks — a **minor** bump,
not a patch. Recommendation at review time: **defer** until the ADR 0009 work
actually needs it.

**Resolution (2026-08-24): implemented instead of deferred.** The trigger was
the standing instruction that a function living in more than one project
belongs in core where feasible — both consumers had grown the same two env
helpers (`emptyToUndefined`, the safeParse/print/exit startup guard), so core's
`./config` was going to be touched anyway and finding 9 rode along in the same
minor:

- `d7b1efb` — `JWT_SECRET` is `.optional()` in `baseEnvSchema`.
- `d92c788` — `emptyToUndefined` and `parseEnvOrExit` added to `./config`.
  `parseEnvOrExit` takes any `z.ZodType`, not just an object shape, so a
  schema carrying a `superRefine` group check (KithLedger's satellite group)
  still works.
- `7357748` — release 0.5.0.
- Heorth `191dd48`, KithLedger `7a7c70c` — both build their env schema on
  `baseEnvSchema.extend()`, drop the locally duplicated helpers, and
  re-declare `JWT_SECRET` as required (both sign HS256). Verified: typecheck
  and build clean in both, Heorth 382/382 and KithLedger 235/235 tests
  passing against a real Postgres `_test` database.

A verifier-only deployment (ADR 0009) can now hold no `JWT_SECRET` at all.

## Release notes

Release discipline (README "Release discipline", CHANGELOG header): every
change ships as a semver tag **plus a CHANGELOG entry**; pre-1.0 a minor bump
may break, a patch bump is safe.

- **0.4.1 (patch)** shipped **2026-08-24** (tag `v0.4.1`) carrying 3a, 3b/3c,
  and 10. Heorth and KithLedger moved to it the same day: KithLedger keys its
  `/auth/token` limiter on the same `getIp` its audit log records
  (`resolveIp`), Heorth is a lockfile-only move. Two release-blocker fixes
  rode along in the tag: the core migration SQL that a machine-global
  `*.sql` ignore kept out of git (`be87446`), and `CORE_VERSION`
  (`2927d59`).
- **0.4.2 (patch)** shipped **2026-08-24** (tag `v0.4.2`) carrying 5, 6, 7, 8.
  Nothing in that set is breaking; consumers on `^0.4.0` pick it up on a
  lockfile refresh.
- **0.5.0 (minor)** shipped **2026-08-24** (tag `v0.5.0`) carrying 9 plus the
  two shared env helpers. Minor because the inferred type of `JWT_SECRET`
  changes; both consumers moved their pin from `^0.4.0` to `^0.5.0` the same
  day. Remaining cross-project duplication is catalogued in
  `docs/plans/core-extraction-candidates.md`.
- The publish pipeline validates `v*` tag == `package.json` version and runs
  typecheck + tests + build first, so the usual flow is: fix commits →
  version bump + CHANGELOG → tag `vX.Y.Z` → CI publishes.

Consumer impact: Heorth and KithLedger both pin `^0.4.0`, so a patch reaches
them on a lockfile refresh with no code change (done for 0.4.1 on
2026-08-24). A minor bump requires a deliberate pin change in each consumer.

## Verification baseline

For any commit from this handoff:

```
npm run typecheck   # clean
npm test            # 131 passing before your change, all plus your new ones after
npm run build       # and dist/db/migrations still lands
```

Repo conventions to keep: ESM, 2-space indent, single quotes, semicolons, no
comments unless extending an existing explanatory one, domain errors as bare
UPPER_SNAKE_CASE `Error`s, tests in vitest mirroring the existing per-module
layout under `tests/`.