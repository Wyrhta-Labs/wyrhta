# Design — Caddy path routing for the household stack

**Date:** 2026-08-05
**Status:** approved, not yet implemented
**Revised:** 2026-08-05 after independent review (Codex), which found a critical
bootstrap defect and three high-severity gaps. See "Review findings" at the end.
**Scope of this repo:** `deploy/` (Caddyfile + both compose files) and `docs/`.
The `BASE_PATH` work inside Heorth, KithLedger, and Feoh is specified here but
implemented in those repos, in their own sessions.

## Goal

Reach every household service through **one origin under path prefixes**
(`localhost:3000/kithledger`, `https://<host>/heorth/`) instead of one host port
per service. Same-origin removes the CORS/cookie friction between services,
gives the household a single bookmarkable URL, and needs no wildcard certificate
or per-service DNS on a home network.

## Current state (verified 2026-08-05)

- `deploy/compose.dev.yml` builds from sibling checkouts; `compose.prod.yml`
  pulls pinned GHCR images. The two are deliberately independent — **no merging,
  no `extends`, no profiles.**
- Each app publishes a host port: `heorth` 4000, `feoh` 4001, `kithledger` 4002
  (`db` 55490, dev only). No proxy in the stack.
- In production **HAProxy already fronts the household and terminates TLS**
  for the Wyrhta hostname.
- `Heorth/web/` and `KithLedger/web/` are both Vite + React + TanStack Router
  SPAs with **no `base`** and **no router `basepath`**
  (`Heorth/web/src/app.tsx:93` is a bare `createRouter({ routeTree })`). Each
  has exactly **one** absolute `/api/v1` literal, in its central API client.
- **All three apps run `trimTrailingSlash()`** — `Heorth/src/app.ts:43`,
  `KithLedger/src/app.ts:22`, `Feoh/src/app.ts:22`.
- Heorth serves its SPA from Hono `serveStatic` (`Heorth/src/app.ts:65-66`),
  where `app.use('/*', …)` can serve `/index.html` directly *before* the SPA
  fallback.
- **Heorth's PWA already exists**, hand-rolled: `Heorth/web/public/sw.js`,
  `public/manifest.webmanifest`, `public/pwa-icons/`, and
  `src/lib/sw-register.ts` registering `'/sw.js'`.
- Heorth's M365 OAuth callback emits six absolute redirects to `/profile?…`
  (`Heorth/src/m365/routes.ts:72-99`).
- Both Heorth and Feoh expose an MCP-over-HTTP endpoint at `/mcp`
  (`Feoh/src/app.ts:36`, `Heorth/src/index.ts:47`), Bearer-authenticated.
- Feoh has no web UI and returns JSON 404 for every unmatched route.

## Decisions

| Question | Decision |
|---|---|
| Where does Caddy live | Both compose files. In prod it sits **behind** HAProxy, which keeps terminating TLS; Caddy owns the path map. |
| Path map | **Uniform prefixes** — `/heorth/`, `/kithledger/`, `/feoh/`. Nothing at root except a redirect. |
| Prefix handling | Caddy **strips** the prefix. Apps keep their internal routes; `BASE_PATH` is used only where an app emits an outward URL. |
| Host ports | Dev keeps 4000/4001/4002 for direct debugging. Prod drops them **in a separate, final commit** — not as part of the first rollout. |
| Root `/` | `308` redirect to `/heorth/`. |
| Prefix resolution | **Runtime**, via `<base href>` injection. One image runs at any prefix or at root. |
| Trailing slashes | **Remove `trimTrailingSlash()`** from all three apps. See below. |
| Feoh exposure | **Public.** No Caddy deny block; `/feoh/*` is routed like the others. |
| `caddy` dependencies | **No `depends_on` at all.** |

## Architecture

### Routing

One new `caddy` service (`caddy:2-alpine`) in each compose file, both mounting
**one** `deploy/Caddyfile` read-only. Caddy listens plain HTTP on `:3000` in
both environments — in dev that is the entrypoint; in prod HAProxy terminates
TLS and forwards to it. The site block is a bare `:3000` with no hostname, so
Caddy never attempts auto-HTTPS and the file is byte-identical for dev and prod.

```
{
	servers {
		# Caddy 2.7+ ignores inbound X-Forwarded-* unless the immediate peer is
		# trusted. Without this, apps behind HAProxy see proto=http and the
		# docker-network IP instead of the real client. Dev has no HAProxy, so
		# the default is a loopback no-op.
		trusted_proxies static {$TRUSTED_PROXIES:127.0.0.1/32}
		trusted_proxies_strict
	}
}

:3000 {
	redir / /heorth/ 308

	# Bare-prefix entry points. Exact-path matchers, so they do not conflict
	# with the /*-suffixed handle_path blocks below; `redir` is also ordered
	# before `handle_path` in Caddy's directive order.
	redir /heorth /heorth/ 308
	redir /kithledger /kithledger/ 308
	redir /feoh /feoh/ 308

	handle_path /heorth/*     { reverse_proxy heorth:3000 }
	handle_path /kithledger/* { reverse_proxy kithledger:3000 }
	handle_path /feoh/*       { reverse_proxy feoh:3000 }
}
```

The route map is the one thing that must not drift between dev and prod, so it
lives in a single file. This does not violate the two-independent-files rule: a
mounted config file is neither `extends` nor a profile, and each compose file
remains readable end to end.

`TRUSTED_PROXIES` must be set in the prod `.env` to HAProxy's address or the
docker network CIDR it reaches Caddy from. HAProxy must send `Host`,
`X-Forwarded-For`, and `X-Forwarded-Proto: https`.

### What becomes publicly reachable

Prefix routing exposes **every route of all three services** through the public
HAProxy hostname — not just `/health`. Previously Feoh and KithLedger were
reachable only on docker-host ports on the LAN. This is an accepted, deliberate
widening:

| Path | Was | Now |
|---|---|---|
| `/heorth/*` | public via HAProxy | unchanged |
| `/kithledger/*` | LAN only (:4002) | public |
| `/feoh/*` incl. `/feoh/api/v1/*` | LAN only (:4001) | public |
| `/feoh/mcp`, `/heorth/mcp` | LAN only | public |
| `/<prefix>/health` | LAN only | public |

Both `/mcp` endpoints authenticate per request via `Authorization: Bearer`, so
this is defensible. One gap to fix in the Feoh repo as a follow-up: `bodyLimit`
is applied to `/api/*` only (`Feoh/src/app.ts:27`), leaving `/mcp` with **no
request body limit** on a now-internet-facing endpoint.

### The `caddy` service

- Image `caddy:2-alpine`; `./Caddyfile:/etc/caddy/Caddyfile:ro`.
- Dev publishes `3000:3000`; prod publishes `${CADDY_HOST_PORT:-3000}:3000`.
- **No `depends_on`.** `reverse_proxy` resolves its upstream at dial time, not
  config-load time, so Caddy starts alone and returns 502 until an upstream is
  up — which is the wanted behaviour, and it keeps `up -d db feoh caddy` from
  dragging `heorth` into the bootstrap (see rollout).
- Healthcheck against Caddy's own admin API so proxy health never depends on
  upstreams:
  `wget -q -O- http://127.0.0.1:2019/config/ >/dev/null || exit 1`
  (the alpine image has busybox `wget`). **Do not set `CADDY_ADMIN=off`** without
  changing this healthcheck.
- `restart: unless-stopped`, matching every other service.

### Trailing slashes

Prefix stripping and `trimTrailingSlash()` combine into a prefix-escape bug:
`/heorth/tasks/` reaches Hono as `/tasks/`, which redirects to the **absolute,
prefix-less** `/tasks`, so the browser leaves `/heorth/` and lands on Caddy's
404. Every trailing-slash URL is affected, API paths included.

**Decision: remove `trimTrailingSlash()` from all three apps**, unconditionally
— not gated on `BASE_PATH`. Consequences, accepted:

- SPA deep links keep working: `/tasks/` misses `serveStatic`, falls through to
  the `index.html` fallback, and the router resolves it.
- API calls with a trailing slash now return a JSON 404 instead of redirecting.
  No client of ours emits one; REST clients conventionally do not.
- Standalone (no-Caddy) behaviour changes too. This is a real, if minor,
  behaviour change and must land in each repo's CHANGELOG.
- Some service-repo tests may assert the redirect and will need updating.

The alternative — normalizing trailing slashes in Caddy before stripping, and
leaving the apps untouched — was rejected: it makes correct behaviour depend on
the proxy being present, which contradicts the standalone-service principle.

### The `BASE_PATH` contract (service repos)

`BASE_PATH` is a new env var on `heorth`, `kithledger`, and `feoh`. It changes
**only URLs an app emits** — never how the app routes. Unset or empty means
exactly today's behaviour; that is the kill switch, and it keeps each service
runnable standalone from its own `docker-compose.yml`.

**Normalization contract:** `BASE_PATH` is either **empty** or an **absolute
path with no trailing slash** (`/heorth`). The server validates this at startup
and fails fast otherwise — a relative value like `heorth` silently breaks deep
links. The rendered base href is
`baseHref = base === '' ? '/' : base + '/'`.

Places that must honour it:

| Emitter | Today | Under prefix |
|---|---|---|
| SPA asset URLs | `/assets/x.js` | resolved via `<base href>` |
| TanStack Router | no basepath | `basepath` from `document.baseURI` |
| SPA API client (1 literal each) | `/api/v1` | `new URL('api/v1/', document.baseURI)` |
| `index.html` public refs | `/manifest.webmanifest`, `/pwa-icons/…` | relative |
| `manifest.webmanifest` | `id`/`start_url`/`scope` = `/`, icon `src` = `/pwa-icons/…` | templated at serve time |
| SW registration | `register('/sw.js')` | `register(new URL('sw.js', document.baseURI))` |
| `sw.js` internals | `startsWith('/api/')`, `cache.match('/index.html')` | derived from `self.registration.scope` |
| Server absolute redirects | `/profile?…` ×6 | `withBasePath('/profile?…')` |
| Cookie `Path`, if any is ever set | `/` | `/heorth/` |

Runtime mechanism:

```
vite.config.ts   base: './'
index.html       <base href="__BASE_PATH__">   (substituted with baseHref)
server           explicit handler reads index.html, substitutes, sets
                 Cache-Control: no-store
router           basepath: new URL(document.baseURI).pathname.replace(/\/$/, '') || '/'
sw register      register(new URL('sw.js', document.baseURI))
```

Three things the naive version gets wrong, all confirmed against the source:

1. **`public/` is copied verbatim by Vite — `base` never rewrites it.** So
   `manifest.webmanifest` and `sw.js` are *not* fixed by `<base href>` and must
   be handled explicitly. The manifest needs the same serve-time templating as
   `index.html`; `sw.js` must derive its prefix from `self.registration.scope`
   (it has no access to `document`).
2. **`serveStatic` is not a sufficient hook point.** `app.use('/*', serveStatic)`
   at `Heorth/src/app.ts:65` serves `/index.html` directly, bypassing any
   templating done in the `rewriteRequestPath` fallback on the next line.
   Templating must be an explicit handler for `index.html` and the SPA fallback,
   registered before static serving. Hashed assets stay on `serveStatic`.
3. **`<base href>` affects relative URLs only.** Any absolute path (`/api/v1`,
   `/sw.js`) silently bypasses the prefix. Each SPA has exactly one `/api/v1`
   literal, so this is small — but it must be found, not assumed.

`document.baseURI` is correct on deep links too: with `<base href="/heorth/">`
injected, `/heorth/tasks` still yields `/heorth/`, which is why the base href
approach works where `base: './'` alone would not.

Feoh has no SPA; it needs `BASE_PATH` only where it emits absolute URLs. The env
var is set on all three anyway, for uniformity and because an absolute URL that
ignores the prefix is already a bug.

### M365 OAuth migration

The external callback moves to `/heorth/api/v1/m365/callback`. This requires,
in order: a `withBasePath()` helper applied to the six redirects at
`Heorth/src/m365/routes.ts:72-99`; a new `M365_REDIRECT_URI` in `deploy/.env`;
and **an Azure app-registration change** to add the new redirect URI. The Azure
change is manual and external — it goes in `docs/manual-todo.md`. Keep the old
URI registered until the cutover is verified.

## Changes in this repo

- **`deploy/Caddyfile`** — new; the route map above.
- **`deploy/compose.dev.yml`** — add the `caddy` service (no `depends_on`); add
  `BASE_PATH` to `heorth`, `kithledger`, `feoh`. Keep 4000/4001/4002.
- **`deploy/compose.prod.yml`** — add the same `caddy` service; add
  `TRUSTED_PROXIES`. **Keep** the three `ports:` blocks for now; removing them
  is the final rollout step, in its own commit.
- **`deploy/README.md`** — services table gains a path column; document
  `TRUSTED_PROXIES`, the required HAProxy forwarded headers, and the
  `CADDY_ADMIN` caveat. Record that "Caddy disabled" means omitting it from the
  `up` command (profiles are forbidden here).
- **`deploy/.env.example`** — `BASE_PATH` per service, `TRUSTED_PROXIES`,
  `CADDY_HOST_PORT`.
- **`docs/plans/household-stack-compose.md`** — its "the stack publishes plain
  ports on the docker host and does not run its own proxy" rationale is now
  false; rewrite that section.
- **`docs/decisions/0007-single-origin-path-routing-behind-caddy.md`** — new
  ADR: path prefixes over per-service subdomains (no wildcard cert or
  per-service DNS at home; same-origin helps the ADR 0002 identity work); Caddy
  behind HAProxy rather than replacing it; the emits-only `BASE_PATH` contract;
  the accepted widening of public exposure; and why trailing-slash normalization
  was removed from the apps rather than added to the proxy.
- **`docs/plans/hearth-view-pwa.md`** — the PWA section describes work that
  already exists; correct that, and add the constraints: service-worker scope is
  `/heorth/`, `sw.js` derives its prefix from `self.registration.scope`, the
  manifest is served templated, and the kiosk Chromium URL becomes
  `https://<host>/heorth/hearth`.
- **`docs/manual-todo.md`** — two external actions: repoint the HAProxy backend
  at the Caddy port (and set the forwarded headers), and add the new M365
  redirect URI to the Azure app registration.

## Rollout order

The Caddy routes are harmless before the apps are base-path-aware: `/feoh/*`
works immediately (API-only), while `/heorth/` and `/kithledger/` serve a broken
SPA until their repos land the change. Nothing that works today stops working
until step 5.

1. Land `deploy/` (Caddyfile, both compose files, docs) with **all host ports
   still published** in both files.
2. Heorth: remove `trimTrailingSlash()`, implement `BASE_PATH`, fix the PWA
   manifest/SW/redirects, add `withBasePath()` for the M365 redirects.
3. KithLedger: remove `trimTrailingSlash()`, implement `BASE_PATH`.
   Feoh: remove `trimTrailingSlash()`, accept `BASE_PATH`, add a `/mcp` body
   limit.
4. Add the new M365 redirect URI in Azure; repoint the HAProxy backend at Caddy;
   verify.
5. **Separate final commit:** remove the three `ports:` blocks from
   `compose.prod.yml`. Only now does the prod bootstrap change.

### Prod bootstrap after step 5

With 4001 no longer published, the two-phase `FEOH_API_KEY` bootstrap runs
through Caddy:

```bash
FEOH_API_KEY=bootstrap docker compose -f deploy/compose.prod.yml \
  --env-file deploy/.env up -d db feoh caddy
```

This works **only because `caddy` has no `depends_on`** — otherwise Compose
would start `heorth` too, which is exactly what the two-phase bootstrap exists
to avoid. Both curls then target `http://localhost:3000/feoh/api/v1/…`.

## Verification (dev)

Positive:

- `curl -si localhost:3000/` → `308` to `/heorth/`.
- `curl -si localhost:3000/heorth` → `308` to `/heorth/`.
- `curl -s localhost:3000/feoh/health` → identical body to
  `curl -s localhost:4001/health`.
- Each SPA loads at its prefix with **no 404s** in the network tab.
- A deep link (`/heorth/tasks`) survives a hard reload.
- `curl -s localhost:3000/heorth/manifest.webmanifest` → `start_url`, `scope`,
  `id`, and every icon `src` carry the `/heorth/` prefix.
- `curl -sI localhost:3000/heorth/sw.js` → 200, and the SW registers with scope
  `/heorth/`.
- The SW serves its cached shell with the network off.
- The M365 OAuth round trip completes and lands on `/heorth/profile?connected=m365`.

Negative and edge cases — each of these is a specific way this change can fail:

- `curl -si localhost:3000/heorth/tasks/` → serves the SPA, **does not** redirect
  to a prefix-less `/tasks`.
- `curl -si localhost:3000/heorth/api/v1/health/` → JSON 404, not a
  prefix-escaping redirect.
- `curl -si localhost:3000/heorth/index.html` → templated (correct `<base>`),
  and `Cache-Control: no-store`.
- `curl -si localhost:3000/nope` → Caddy 404, no proxying.
- `curl -si localhost:3000/feoh/mcp` without a Bearer token → 401, not 200.
- Behind HAProxy, the apps log `X-Forwarded-Proto: https` and the real client IP.
- Stack comes up with Caddy omitted (`up -d db feoh kithledger heorth`) and all
  three respond on their direct ports with `BASE_PATH` unset.
- Each service still starts standalone from its own `docker-compose.yml`.
- A malformed `BASE_PATH` (`heorth`, `/heorth/`) fails startup validation.

## Out of scope

- Replacing HAProxy, or moving TLS termination into Caddy.
- Per-service subdomains.
- Tightening `CORS_ORIGIN` now that traffic is same-origin.
- Rate limiting, basic auth, or any other Caddy middleware.
- Routing `db` or `db-backup` through the proxy.
- Restricting `/feoh/*` or the `/mcp` endpoints to the LAN — explicitly decided
  against; they are public and Bearer-authenticated.

## Review findings

An independent review (Codex, read-only, 2026-08-05) raised 12 findings against
the first draft. All were checked against source. Incorporated:

- **CRITICAL** — `depends_on` on `caddy` would have made the documented
  `up -d db feoh caddy` bootstrap start `heorth`, defeating the two-phase
  `FEOH_API_KEY` procedure. `depends_on` removed entirely.
- **HIGH** — `trimTrailingSlash()` (present in all three apps) turns every
  trailing-slash URL into a prefix-escaping redirect. Now an explicit decision.
- **HIGH** — the `<base href>` plan did not cover `public/` (manifest, `sw.js`),
  which Vite copies verbatim. Now specified.
- **HIGH** — the draft both listed the prod port removal as part of the change
  and deferred it to last. Now a separate final commit.
- **MEDIUM** — `trusted_proxies` needed behind HAProxy; router `basepath`
  trailing slash; `serveStatic` not a valid templating hook; M365 redirect URI
  migration; exposure is all routes, not just `/health`.
- **LOW** — `BASE_PATH` normalization contract; explicit healthcheck command;
  the expanded negative-verification list.

Confirmed sound and unchanged: `handle_path` as the stripping primitive; exact
`redir` matchers not conflicting with `/*` handlers; bare `:3000` disabling
auto-HTTPS; `base: './'` being adequate for code-split chunks once the entry
script loads from the prefix.
