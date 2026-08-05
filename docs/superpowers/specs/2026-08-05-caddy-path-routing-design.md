# Design — Caddy path routing for the household stack

**Date:** 2026-08-05
**Status:** approved, not yet implemented
**Scope of this repo:** `deploy/` (Caddyfile + both compose files) and `docs/`.
The `BASE_PATH` work inside Heorth, KithLedger, and Feoh is specified here but
implemented in those repos, in their own sessions.

## Goal

Reach every household service through **one origin under path prefixes**
(`localhost:3000/kithledger`, `https://<host>/heorth/`) instead of one host port
per service. Same-origin removes the CORS/cookie friction between services,
gives the household a single bookmarkable URL, and needs no wildcard certificate
or per-service DNS on a home network.

## Current state (2026-08-05)

- `deploy/compose.dev.yml` builds from sibling checkouts; `compose.prod.yml`
  pulls pinned GHCR images. The two are deliberately independent — **no merging,
  no `extends`, no profiles.**
- Each app publishes a host port: `heorth` 4000, `feoh` 4001, `kithledger` 4002
  (`db` 55490, dev only). No proxy in the stack.
- In production **HAProxy already fronts the household and terminates TLS**
  for the Wyrhta hostname.
- `Heorth/web/` and `KithLedger/web/` are both Vite + React + TanStack Router
  SPAs with **no `base` configured**, so they emit absolute `/assets/...` and are
  not path-prefix-aware. Heorth serves its SPA from Hono `serveStatic`
  (`Heorth/src/app.ts:65-66`). Feoh is API-only.

## Decisions

| Question | Decision |
|---|---|
| Where does Caddy live | Both compose files. In prod it sits **behind** HAProxy, which keeps terminating TLS; Caddy owns the path map. |
| Path map | **Uniform prefixes** — `/heorth/`, `/kithledger/`, `/feoh/`. Nothing at root except a redirect. |
| Prefix handling | Caddy **strips** the prefix. Apps keep their internal routes; `BASE_PATH` is used only where an app emits an outward URL. |
| Host ports | Dev keeps 4000/4001/4002 for direct debugging; prod publishes only Caddy. |
| Root `/` | `308` redirect to `/heorth/`. |
| Prefix resolution | **Runtime**, via `<base href>` injection. One image runs at any prefix or at root. |

## Architecture

### Routing

One new `caddy` service (`caddy:2-alpine`) in each compose file, both mounting
**one** `deploy/Caddyfile` read-only. Caddy listens plain HTTP on `:3000` in
both environments — in dev that is the entrypoint; in prod HAProxy terminates
TLS and forwards to it. The site block is a bare `:3000` with no hostname, so
Caddy never attempts auto-HTTPS and the file is byte-identical for dev and prod.

```
:3000 {
	redir / /heorth/ 308

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

Consequences to be aware of:

- Each service's `/health` becomes externally reachable at `/<prefix>/health`.
  Useful for monitoring; not a secret.
- Container-to-container calls are untouched. `FEOH_BASE_URL` stays
  `http://feoh:3000` and does **not** go through Caddy.
- `db` and `db-backup` are unaffected.
- Browser traffic becomes same-origin, so `CORS_ORIGIN` stops mattering for it.
  Tightening those values is a follow-up, not part of this change.

### The `caddy` service

- Image `caddy:2-alpine`; `./Caddyfile:/etc/caddy/Caddyfile:ro`.
- Dev publishes `3000:3000`; prod publishes `${CADDY_HOST_PORT:-3000}:3000`.
- `depends_on` the three apps with `condition: service_started` — **not**
  `service_healthy`, so one sick service cannot keep the proxy down.
- Healthcheck against Caddy's own admin API on `127.0.0.1:2019` (the alpine
  image has busybox `wget`), so proxy health does not depend on upstreams.
- `restart: unless-stopped`, matching every other service.

### The `BASE_PATH` contract (service repos)

`BASE_PATH` is a new env var on `heorth`, `kithledger`, and `feoh`. It changes
**only URLs an app emits** — never how the app routes. Unset or empty means
exactly today's behaviour; that is the kill switch, and it keeps each service
runnable standalone from its own `docker-compose.yml`.

Places that must honour it:

| Emitter | Today | Under prefix |
|---|---|---|
| SPA asset URLs | `/assets/x.js` | resolved via `<base href>` |
| TanStack Router | root | `basepath` from `document.baseURI` |
| SPA API client | `/api/v1` | `new URL('api/v1/', document.baseURI)` |
| Service worker | scope `/` | script and scope `/heorth/` |
| Absolute `Location` redirects | `/foo` | `/heorth/foo` |
| Cookie `Path`, if any is ever set | `/` | `/heorth/` |

Runtime mechanism:

```
vite.config.ts   base: './'
index.html       <base href="__BASE_PATH__/">
server           serving index.html substitutes __BASE_PATH__ from env (default '')
router           basepath: new URL(document.baseURI).pathname
sw register      register('sw.js', { scope: './' })
```

Heorth's hook point is the `serveStatic` SPA fallback at
`Heorth/src/app.ts:65-66`; KithLedger's equivalent. index.html must not be
cached long-lived, since it is now templated.

**Critical subtlety:** `<base href>` affects **relative URLs only**. Any
absolute path (`/api/v1`, `/sw.js`) silently bypasses the prefix and 404s or
hits the wrong service. Every such literal in the SPAs must become relative or
be derived from `document.baseURI`.

Feoh has no SPA; it needs `BASE_PATH` only where it emits absolute URLs. The env
var is set on all three anyway, for uniformity and because an absolute URL that
ignores the prefix is already a bug.

## Changes in this repo

- **`deploy/Caddyfile`** — new; the route map above.
- **`deploy/compose.dev.yml`** — add the `caddy` service; add `BASE_PATH` to
  `heorth`, `kithledger`, `feoh`. Keep 4000/4001/4002.
- **`deploy/compose.prod.yml`** — add the same `caddy` service; **remove** the
  `ports:` blocks from the three apps.
- **`deploy/README.md`** — services table gains a path column. **The prod
  first-bring-up changes:** with 4001 no longer published, step 1 becomes
  `up -d db feoh caddy` and both bootstrap curls target
  `http://localhost:3000/feoh/api/v1/...`. This is the one operational gotcha
  the change introduces and must be spelled out.
- **`docs/plans/household-stack-compose.md`** — its "the stack publishes plain
  ports on the docker host and does not run its own proxy" rationale is now
  false; rewrite that section.
- **`docs/decisions/0007-single-origin-path-routing-behind-caddy.md`** — new
  ADR: path prefixes over per-service subdomains (no wildcard cert or per-service
  DNS at home; same-origin helps the ADR 0002 identity work), Caddy behind
  HAProxy rather than replacing it, and the emits-only `BASE_PATH` contract.
- **`docs/plans/hearth-view-pwa.md`** — add the constraint: service-worker scope
  is `/heorth/`, and the kiosk Chromium URL becomes
  `https://<host>/heorth/hearth`.
- **`docs/manual-todo.md`** — the HAProxy backend must be repointed at the Caddy
  port. That config is outside this repo and is a manual host action.

## Rollout order

The Caddy routes are harmless before the apps are base-path-aware: `/feoh/*`
works immediately (API-only), while `/heorth/` and `/kithledger/` serve a broken
SPA until their repos land the change. Therefore:

1. Land `deploy/` (Caddyfile, both compose files, docs) — dev ports still
   published, so nothing that works today stops working.
2. Heorth: `BASE_PATH` implementation.
3. KithLedger: `BASE_PATH` implementation.
4. Repoint the HAProxy backend.
5. Remove the prod host ports **last**.

## Verification (dev)

- `curl -si localhost:3000/` → `308` to `/heorth/`.
- `curl -s localhost:3000/feoh/health` → identical body to
  `curl -s localhost:4001/health`.
- `curl -si localhost:3000/heorth` → `308` to `/heorth/`.
- Each SPA loads at its prefix with **no 404s** in the network tab.
- A deep link (`/heorth/tasks`) survives a hard reload.
- The M365 OAuth redirect still completes.
- The shopping-list service worker registers with scope `/heorth/` and serves
  its cached shell offline.
- Stack still comes up with Caddy omitted (`up -d db feoh kithledger heorth`)
  and all three respond on their direct ports with `BASE_PATH` unset.

## Out of scope

- Replacing HAProxy, or moving TLS termination into Caddy.
- Per-service subdomains.
- Tightening `CORS_ORIGIN` now that traffic is same-origin.
- Basic auth, rate limiting, or any other Caddy middleware.
- Routing `db` or `db-backup` through the proxy.
