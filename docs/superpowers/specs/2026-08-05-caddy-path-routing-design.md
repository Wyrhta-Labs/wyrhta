# Design — Caddy path routing for the household stack

**Date:** 2026-08-05
**Status:** approved, not yet implemented
**Revised:** 2026-08-05, twice, after two independent review rounds (Codex) plus
local verification against the installed Hono and the real `caddy:2-alpine`
image. See "Review findings" at the end.
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
  `src/lib/sw-register.ts` registering `'/sw.js'` — i.e. **scope `/`**.
- Heorth's M365 OAuth callback emits six absolute redirects to `/profile?…`
  (`Heorth/src/m365/routes.ts:72-99`).
- Both Heorth and Feoh expose an MCP-over-HTTP endpoint at `/mcp`
  (`Feoh/src/app.ts:36`, `Heorth/src/index.ts:47`), Bearer-authenticated.
  Neither `/mcp` is under `/api/*`.
- Feoh has no web UI and returns JSON 404 for every unmatched route.
- No test in any of the three repos asserts trailing-slash redirect behaviour.

## Decisions

| Question | Decision |
|---|---|
| Where does Caddy live | Both compose files. In prod it sits **behind** HAProxy, which keeps terminating TLS; Caddy owns the path map. |
| Path map | **Uniform prefixes** — `/heorth/`, `/kithledger/`, `/feoh/`. Nothing at root except a redirect. |
| Prefix handling | Caddy **strips** the prefix. Apps keep their internal routes; `BASE_PATH` is used only where an app emits an outward URL. |
| How an app learns its prefix | **Static `BASE_PATH` env.** A per-request `X-Forwarded-Prefix` header was considered and rejected — see below. |
| Host ports | Dev keeps 4000/4001/4002, but they become **API-only** once `BASE_PATH` is set. Prod drops them in the cutover. |
| Root `/` | `308` redirect to `/heorth/`. |
| Prefix resolution | **Runtime**, via `<base href>` injection. One image runs at any prefix or at root, depending on env. |
| Trailing slashes | **Remove `trimTrailingSlash()`** from all three apps. |
| Feoh exposure | **Public.** No Caddy deny block; `/feoh/*` is routed like the others. |
| `caddy` dependencies | **No `depends_on` at all.** |

### Rejected: per-request `X-Forwarded-Prefix`

Caddy could send the prefix per request (`header_up X-Forwarded-Prefix /heorth`)
and each app could render its base href from that, which would let one container
serve correctly at root *and* under the prefix at the same time. Rejected in
favour of the static env: it is simpler to reason about, and the header is
forgeable by anything that can reach the app directly. The cost of that choice is
the coupling described in the next section, which is accepted and made explicit
rather than discovered in production.

## Architecture

### `BASE_PATH` is deployment-coupled — the central constraint

A non-empty `BASE_PATH` makes the app render `<base href="/heorth/">` on **every**
response, including responses served on its direct host port. There is no such
thing as a container that is simultaneously correct at root and under a prefix.
Three consequences, all load-bearing:

1. **Prod must set `BASE_PATH` and repoint HAProxy in one atomic step.** If
   HAProxy still points at `heorth:4000` while the container has
   `BASE_PATH=/heorth`, production serves a broken SPA. The direct ports are
   dropped in that same step, because leaving them published would only offer a
   broken page.
2. **Dev's direct ports become API-only.** With `BASE_PATH` set in
   `compose.dev.yml`, `http://localhost:4000/` serves an SPA whose assets point
   at `/heorth/...` with no Caddy to strip them. Direct ports remain useful for
   `curl`-ing APIs, `/health`, and the Feoh bootstrap — **not** for the UI. This
   must be stated in `deploy/README.md`; it is a real loss of convenience.
   Feoh is unaffected in practice: it has no UI, so `:4001` stays fully usable.
3. **The kill switch is a pair, not a single flag.** Disabling this feature means
   *both* unsetting `BASE_PATH` in `deploy/.env` *and* omitting `caddy` from the
   `up` command. Neither alone gives a working stack. Documented as a pair in
   `deploy/README.md`, satisfying the standing rule that new infra must be
   disableable down to running without the dependency.

### Routing

One new `caddy` service (`caddy:2-alpine`) in each compose file, both mounting
**one** `deploy/Caddyfile` read-only. Caddy listens plain HTTP on `:3000` in
both environments — in dev that is the entrypoint; in prod HAProxy terminates
TLS and forwards to it. The site block is a bare `:3000` with no hostname, so
Caddy never attempts auto-HTTPS and the file is byte-identical for dev and prod.

```caddyfile
{
	servers {
		# Caddy 2.7+ ignores inbound X-Forwarded-* unless the immediate peer is
		# trusted. Without this, apps behind HAProxy see proto=http and the
		# docker-network IP instead of the real client. Dev has no HAProxy, so
		# the loopback default is a no-op there.
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

	# Tombstone for the pre-migration root-scope service worker. Must outlive
	# one full release — see "PWA migration" below.
	handle /sw.js {
		header Content-Type application/javascript
		header Cache-Control no-store
		respond `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',async()=>{for(const k of await caches.keys())await caches.delete(k);await self.registration.unregister();for(const c of await self.clients.matchAll())c.navigate(c.url);});` 200
	}

	handle_path /heorth/* {
		reverse_proxy heorth:3000
	}

	handle_path /kithledger/* {
		reverse_proxy kithledger:3000
	}

	handle_path /feoh/* {
		reverse_proxy feoh:3000
	}

	# Required. Without a catch-all, an unmatched path falls out of the handle
	# group with no handler and Caddy answers 200 with an empty body — not 404.
	handle {
		error 404
	}
}
```

**Blocks must be multi-line.** The one-line form
`handle_path /heorth/* { reverse_proxy heorth:3000 }` is rejected by the
Caddyfile adapter — verified in `caddy:2-alpine`:
`Error: adapting config using caddyfile: Unexpected next token after '{' on same line`.

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
- **No `depends_on`.** Verified in `caddy:2-alpine`: Caddy starts and stays up
  with an unresolvable `reverse_proxy heorth:3000`, returns 502, and recovers to
  200 once a container with that network alias appears — no negative DNS caching,
  no `dynamic upstreams` needed. This is what keeps `up -d db feoh caddy` from
  dragging `heorth` into the bootstrap.
- Healthcheck against Caddy's own admin API, so proxy health never depends on
  upstreams. **`CMD-SHELL`, not exec-form `CMD`** — the redirection needs a shell:
  ```yaml
  test: ["CMD-SHELL", "wget -q -O- http://127.0.0.1:2019/config/ >/dev/null || exit 1"]
  ```
  Verified: admin defaults to `localhost:2019` in the official image, `/config/`
  returns 2xx, and busybox `wget` is present. **Do not set `CADDY_ADMIN=off`**
  without changing this healthcheck.
- `restart: unless-stopped`, matching every other service.

### Trailing slashes

Prefix stripping and `trimTrailingSlash()` combine into a prefix-escape bug:
`/heorth/tasks/` reaches Hono as `/tasks/` and redirects out of the prefix.
Verified against the installed Hono — and it is worse than a bare path, because
`trimTrailingSlash` emits an **absolute** `Location`:

```
--- trimTrailingSlash: true ---
/api/v1/household/     301 -> http://x/api/v1/household
--- trimTrailingSlash: false ---
/api/v1/household/     404
```

Behind Caddy that Location carries the request's host and **`http`**, so in
production it would bounce a browser out of the prefix *and* off TLS.

**Decision: remove `trimTrailingSlash()` from all three apps**, unconditionally
— not gated on `BASE_PATH`. Consequences, all verified:

- API paths with a trailing slash return 404 instead of a 301. No client of ours
  emits one, and no test asserts the redirect.
- SPA deep links are unaffected either way: `/tasks/` misses `serveStatic` and
  falls through to the `index.html` fallback.
- **`/health/` and `/mcp/` are not under `/api/*`**, so with the redirect gone
  they fall through the `/*` SPA fallback and return **HTML 200** instead of JSON
  404 / 401. Each app must therefore explicitly reject `/health/*` and `/mcp/*`
  (alongside the existing `/api/*` catch-all) **before** the SPA fallback.
- Standalone (no-Caddy) behaviour changes too. This is a real, if minor,
  behaviour change and must land in each repo's CHANGELOG.

The alternative — normalizing trailing slashes in Caddy and leaving the apps
untouched — was rejected: it makes correct behaviour depend on the proxy being
present, which contradicts the standalone-service principle.

### The `BASE_PATH` contract (service repos)

`BASE_PATH` is a new env var on `heorth`, `kithledger`, and `feoh`. It changes
**only URLs an app emits** — never how the app routes. Unset or empty means
exactly today's behaviour.

**Normalization contract:** `BASE_PATH` is either **empty** or an **absolute
path with no trailing slash** (`/heorth`). The server validates this at startup
and fails fast otherwise — a relative value like `heorth` silently breaks deep
links, and `/heorth/` would render `//`. The rendered base href is
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
injected, `/heorth/tasks` still yields `/heorth/`. Neither SPA currently uses
bare `href="#…"` anchors or relative form actions, so adding `<base>` breaks no
existing in-app link. The root case (`baseHref = '/'`) also holds: relative
build assets resolve to `/assets/…` as they do today.

Feoh has no SPA; it needs `BASE_PATH` only where it emits absolute URLs. The env
var is set on all three anyway, for uniformity and because an absolute URL that
ignores the prefix is already a bug.

### PWA migration (already-installed clients)

Heorth's PWA is live today with service-worker **scope `/`**, which *covers*
`/heorth/*`. A new worker registered at `/heorth/` cannot evict it, so without
action an installed client keeps a root-scope worker intercepting prefixed
navigations and serving the old root `index.html` from cache — whose absolute
`/assets/…` refs now 404.

Migration, in order:

1. Caddy serves a **tombstone `/sw.js`** at root (see the Caddyfile above) that
   `skipWaiting()`s, deletes all caches, calls `self.registration.unregister()`,
   and navigates its clients — which then follow the `/` → `/heorth/` redirect
   and register the new scoped worker. This must be reachable at root; if `/sw.js`
   merely 404s, eviction depends on the browser's update check and is not prompt.
2. Bump `CACHE_NAME` in the new `sw.js` so no old cache entry is reused.
3. Keep the tombstone for **at least one full release** — an installed client
   that has not been opened for weeks still needs to find it.
4. Verify on a real installed instance, not just a fresh browser profile: the
   fresh-profile path never exercises this at all.

### M365 OAuth migration

The external callback moves to `/heorth/api/v1/m365/callback`. This requires,
in order: a `withBasePath()` helper applied to the six redirects at
`Heorth/src/m365/routes.ts:72-99` (and the existing redirect tests updated); a
new `M365_REDIRECT_URI` in `deploy/.env`; and **an Azure app-registration
change** to add the new redirect URI. The Azure change is manual and external —
it goes in `docs/manual-todo.md`. Keep the old URI registered until the cutover
is verified.

## Changes in this repo

- **`deploy/Caddyfile`** — new; the route map above, including the `/sw.js`
  tombstone.
- **`deploy/compose.dev.yml`** — add the `caddy` service (no `depends_on`,
  `CMD-SHELL` healthcheck); add `BASE_PATH` to `heorth`, `kithledger`, `feoh`.
  Keep 4000/4001/4002 as API-only debug ports.
- **`deploy/compose.prod.yml`** — add the same `caddy` service; add
  `TRUSTED_PROXIES`. `BASE_PATH` stays **empty** until the cutover, at which
  point it is set and the three `ports:` blocks are removed together.
- **`deploy/README.md`** — services table gains a path column. Document: the
  paired kill switch; that dev direct ports are API-only once `BASE_PATH` is set;
  `TRUSTED_PROXIES`; the HAProxy forwarded-header requirement; and the
  `CADDY_ADMIN` caveat.
- **`deploy/.env.example`** — `BASE_PATH` per service (empty by default, with a
  comment that setting it requires Caddy as ingress), `TRUSTED_PROXIES`,
  `CADDY_HOST_PORT`.
- **`docs/plans/household-stack-compose.md`** — its "the stack publishes plain
  ports on the docker host and does not run its own proxy" rationale is now
  false; rewrite that section.
- **`docs/decisions/0007-single-origin-path-routing-behind-caddy.md`** — new
  ADR: path prefixes over per-service subdomains; Caddy behind HAProxy rather
  than replacing it; the emits-only `BASE_PATH` contract **and why the
  per-request `X-Forwarded-Prefix` alternative was rejected**; the accepted
  widening of public exposure; and why trailing-slash normalization was removed
  from the apps rather than added to the proxy.
- **`docs/plans/hearth-view-pwa.md`** — the PWA section describes work that
  already exists; correct that, and add: SW scope is `/heorth/`, `sw.js` derives
  its prefix from `self.registration.scope`, the manifest is served templated,
  the root-scope tombstone migration, and the kiosk Chromium URL
  `https://<host>/heorth/hearth`.
- **`docs/manual-todo.md`** — two external actions: repoint the HAProxy backend
  at the Caddy port (with the forwarded headers), and add the new M365 redirect
  URI to the Azure app registration.

## Rollout order

`BASE_PATH` is the switch that cannot be half-thrown. Everything before step 4
is a no-op in production because `BASE_PATH` stays empty there.

1. **Land `deploy/`** — Caddyfile, both compose files, docs. Prod `BASE_PATH`
   empty, all host ports still published, HAProxy still pointing at `heorth:4000`.
   Prod is untouched; dev can already exercise `/feoh/*` through Caddy.
2. **Heorth repo:** remove `trimTrailingSlash()`, reject `/health/*` and `/mcp/*`
   before the SPA fallback, implement `BASE_PATH` (explicit `index.html` and
   manifest handlers), fix the PWA SW, add `withBasePath()` for the M365
   redirects. Ships with `BASE_PATH` empty — a behavioural no-op.
3. **KithLedger repo:** remove `trimTrailingSlash()`, reject `/health/*` before
   the SPA fallback, implement `BASE_PATH`. **Feoh repo:** remove
   `trimTrailingSlash()`, accept and validate `BASE_PATH`, add a `/mcp` body
   limit. Both ship with `BASE_PATH` empty.
4. **Add the new M365 redirect URI in Azure** (additive, safe to do early).
5. **Atomic cutover, one deployment:** set `BASE_PATH` for all three, remove the
   three `ports:` blocks from `compose.prod.yml`, repoint the HAProxy backend at
   Caddy, set `TRUSTED_PROXIES`. These cannot be separated — a container with
   `BASE_PATH` set behind an un-repointed HAProxy serves a broken SPA.
6. **Post-cutover:** verify an already-installed PWA client evicts its root-scope
   worker via the tombstone. Keep the tombstone for at least one release.

### Prod bootstrap after the cutover

With 4001 no longer published, the two-phase `FEOH_API_KEY` bootstrap runs
through Caddy:

```bash
FEOH_API_KEY=bootstrap docker compose -f deploy/compose.prod.yml \
  --env-file deploy/.env up -d db feoh caddy
```

This works **only because `caddy` has no `depends_on`** — otherwise Compose
would start `heorth` too, which is exactly what the two-phase bootstrap exists
to avoid. Both curls then target `http://localhost:3000/feoh/api/v1/…`.

## Verification (dev, with `BASE_PATH` set)

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

Negative and edge cases — each is a specific way this change can fail:

- `curl -si localhost:3000/heorth/tasks/` → serves the SPA; **no** redirect to a
  prefix-less `/tasks`, and no absolute `Location`.
- `curl -si localhost:3000/heorth/api/v1/health/` → JSON 404.
- `curl -si localhost:3000/heorth/health/` → JSON 404, **not** HTML 200.
- `curl -si localhost:3000/heorth/mcp/` → JSON 404 or 401, **not** HTML 200.
- `curl -si localhost:3000/heorth/index.html` → templated (correct `<base>`) and
  `Cache-Control: no-store`.
- `curl -si localhost:3000/nope` → Caddy 404, no proxying.
- `curl -si localhost:3000/feoh/mcp` without a Bearer token → 401, not 200.
- `curl -s localhost:3000/sw.js` → the tombstone script, `no-store`.
- `curl -s localhost:4001/health` → still works (Feoh has no UI, so its direct
  port is unaffected by `BASE_PATH`).
- `curl -si localhost:4000/` → serves an SPA with `<base href="/heorth/">`, i.e.
  **knowingly broken**. This is the documented cost of the static-env choice, not
  a bug to file.
- Caddy starts and 502s cleanly when `heorth` is stopped, then recovers when it
  returns, without a restart.
- Behind HAProxy, the apps log `X-Forwarded-Proto: https` and the real client IP.
- A malformed `BASE_PATH` (`heorth`, `/heorth/`) fails startup validation.

Kill-switch check (both halves, together):

- With `BASE_PATH` unset in `.env` **and** `caddy` omitted from the `up` command,
  all three services behave exactly as they do today on 4000/4001/4002,
  including their SPAs.
- Each service still starts standalone from its own `docker-compose.yml`.

## Out of scope

- Replacing HAProxy, or moving TLS termination into Caddy.
- Per-service subdomains.
- Tightening `CORS_ORIGIN` now that traffic is same-origin.
- Rate limiting, basic auth, or any other Caddy middleware.
- Routing `db` or `db-backup` through the proxy.
- Restricting `/feoh/*` or the `/mcp` endpoints to the LAN — explicitly decided
  against; they are public and Bearer-authenticated.
- Serving a working SPA on the direct host ports while `BASE_PATH` is set —
  explicitly decided against by choosing static env over `X-Forwarded-Prefix`.

## Review findings

Two independent review rounds (Codex, read-only) plus local verification.

**Round 1** raised 12 findings against the first draft; all were checked against
source and incorporated. Headline items: a **CRITICAL** `depends_on` on `caddy`
would have made the documented `up -d db feoh caddy` bootstrap start `heorth`,
defeating the two-phase `FEOH_API_KEY` procedure; `trimTrailingSlash()` turns
every trailing-slash URL into a prefix-escaping redirect; the `<base href>` plan
did not cover `public/`, which Vite copies verbatim; and the prod port removal
was both claimed and deferred.

**Round 2** re-reviewed the revision, confirmed 10 of 12 fully resolved, and
found five new issues — three of them by actually running `caddy:2-alpine` and
the installed Hono rather than reading docs:

- **HIGH** — the Caddyfile snippet used one-line blocks, which the adapter
  rejects outright. Fixed; verified both forms locally.
- **HIGH** — "nothing breaks until the last step" was **false**: a non-empty
  `BASE_PATH` breaks the direct host ports and, if HAProxy is not yet repointed,
  production. This drove the deployment-coupling section, the atomic step 5, and
  the rejection note on `X-Forwarded-Prefix`.
- **HIGH** — already-installed PWA clients hold a root-scope worker that covers
  `/heorth/*` and cannot be evicted by a new scoped worker. Drove the tombstone.
- **MEDIUM** — `/health/` and `/mcp/` sit outside `/api/*`, so removing
  `trimTrailingSlash` makes them return HTML 200 from the SPA fallback.
- **MEDIUM** — the healthcheck needs `CMD-SHELL`, not exec-form `CMD`.

**Found while running the finished Caddyfile** (not by either review): without a
trailing `handle { error 404 }`, an unmatched path returns **200 with an empty
body**, not 404. Confirmed by `curl`-ing a live `caddy:2-alpine` with this exact
config. The catch-all is now in the Caddyfile and the verification list expects
404. The full config as written in this spec passes `caddy validate` and answers
`/` → 308, `/heorth` → 308, `/sw.js` → 200 tombstone, `/heorth/tasks` → 502 with
upstreams absent, `/nope` → 404.

Verified locally and confirmed sound: `handle_path` as the stripping primitive;
exact `redir` matchers not shadowed by `/*` handlers; bare `:3000` disabling
auto-HTTPS; `trusted_proxies` syntax and placement inside `servers`, including
the `{$VAR:default}` form; Caddy starting, 502-ing, and recovering with an
initially unresolvable upstream; the admin API on `127.0.0.1:2019` with busybox
`wget`; `base: './'` for code-split chunks and for the root case; and that
neither SPA has anchors or form actions that `<base>` would break.
