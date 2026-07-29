# Plan — Household stack Compose

**Phase:** 3 (deployment) · **Governing decisions:** `manual-todo.md` §6
(2026-07-25: one Postgres container), ADR 0006 rule 2 (official Postgres image),
ADR 0002 (cross-service identity, Phase A — Feoh headless behind Heorth) ·
**Designed 2026-07-29.**
**Level:** concept plan with a concrete artifact. Two Compose files land in this
repo; the prerequisites they depend on land in the service repos.

## Goal

One place that describes how the whole household runs. Today each service repo
carries a single-service Compose file that spins up its **own** Postgres — three
clusters, three volumes — while `manual-todo.md` records the opposite decision:
**one Postgres container serving `heorth`, `feoh`, and `kithledger`**, each with
its own role and connection string. This plan supplies the artifact that decision
implies, and makes the meta repo the one place that knows the full topology.

Acceptance test: on a clean household server with a populated `.env`,
`docker compose -f deploy/compose.prod.yml up -d` brings up the stack, and the
only manual step is the one Compose provably cannot do (see *Bootstrap ordering*).

## Placement — a deliberate rule change

`deploy/` becomes **the one runnable exception** to this repo's docs-only working
mode. `CLAUDE.md`'s working-mode section is amended to say so explicitly, so the
carve-out is a recorded rule rather than an erosion of one. The rule against
editing code inside `wyrhta-core/`, `Heorth/`, `KithLedger/`, `Feoh/`, and
`website-v0/` is untouched.

```
deploy/
  compose.prod.yml      # pinned ghcr.io images
  compose.dev.yml       # build: ../Heorth, ../Feoh, ../KithLedger
  .env.example          # every var, placeholders only
  initdb/10-databases.sh
  README.md             # bring-up order, backup/restore, caveats
```

The meta repo is the natural home: it is the only repo that knows all services
exist. A separate `Wyrhta-Labs/deploy` repo was considered and rejected — it would
split the stack from the ADRs that justify it and add a sixth repo to maintain.

## Two files, strictly separated

**No profiles, no override files.** `compose.prod.yml` and `compose.dev.yml` are
independent and each readable on its own. They describe the same topology and
differ only in image source, port exposure, and the extra test databases in dev.
The duplication is accepted deliberately: a single file with conditional
behaviour is harder to trust than two files you can read end to end, and the
production file is the one that must never surprise anyone.

| Service | Prod image | Dev source | Host port | Notes |
|---|---|---|---|---|
| `db` | `postgres:18-alpine` | same | none | one cluster, three databases |
| `heorth` | `ghcr.io/wyrhta-labs/heorth` | `build: ../Heorth` | 4000→3000 | needs `FEOH_BASE_URL`, M365 group |
| `feoh` | `ghcr.io/wyrhta-labs/feoh` | `build: ../Feoh` | 4001→3000 | private repo → registry auth |
| `kithledger` | `ghcr.io/wyrhta-labs/kithledger` | `build: ../KithLedger` | 4002→3000 | only service publishing today |
| `db-backup` | `postgres:18-alpine` | same | none | interval `pg_dump` to a volume |

Host ports follow the existing dev allocation (Heorth 4000, Feoh 4001, KithLedger
4002). Internal traffic uses service names (`db:5432`, `heorth:3000`), so no host
port is required for services to reach each other.

**Not in the stack.** `wyrhta-core` is a library consumed by git tag — it never
gets a container. `website-v0` is a public marketing site with no Dockerfile and
a different deployment target; `CLAUDE.md` also forbids this repo from writing
site code. Heorth and KithLedger build their web UIs into their own API images,
so there are no separate frontend services.

**The `db` volume mounts at `/var/lib/postgresql`, not `/var/lib/postgresql/data`.**
Postgres 18 sets `PGDATA` to `/var/lib/postgresql/<major>/docker` and declares its
volume one level up; mounting the pre-18 path makes the container start against an
anonymous volume and **silently stop persisting data**.

The backup sidecar runs the official `postgres:18-alpine` image purely as a
`pg_dump` client. ADR 0006 rule 2 constrains the image holding household data,
which is unchanged.

## Database provisioning

`POSTGRES_USER`/`POSTGRES_DB` create only the first database. The other two come
from `initdb/10-databases.sh`, mounted into `docker-entrypoint-initdb.d`. It is a
**shell script, not `.sql`**, so role passwords are read from the environment
rather than written into a committed file. Each role owns exactly its own
database and is granted nothing on the others.

**Caveat, and it belongs in the README rather than a code comment:**
`docker-entrypoint-initdb.d` scripts run **only when the data directory is empty**.
Adding a fourth service to an existing cluster is a manual `psql` step, not a
Compose change. An idempotent bootstrap service that re-runs on every `up` was
designed and set aside — it removes that manual step at the cost of an extra
container start on every boot and a startup dependency for every service.

`compose.dev.yml`'s script additionally creates `heorth_test`, `feoh_test`, and
`kithledger_test`, so test suites have somewhere to point that is not dev data.
This closes the hazard recorded at `manual-todo.md:115`, where the backend suite
and the dev stack shared one `heorth` database and per-test truncation wiped the
delegated M365 connection, mirrored events, allowlist, and household row.

It additionally creates `heorth_dev`, `feoh_dev`, and `kithledger_dev` (approved
mid-execution deviation). Each service repo's own `.env` already points its local
dev config at `localhost:55432/<service>_dev`, left over from a previously
hand-run `kith-testdb` container; keeping those names lets this shared cluster
absorb that role without every repo's dev `.env` needing to change.

## Env and secrets

A single git-ignored `deploy/.env`; `deploy/.env.example` is committed with
placeholders only.

All three services define `DATABASE_URL`, `JWT_SECRET`, `ADMIN_PASSWORD`, and
`DB_POOL_MAX` under **identical names**, so in one file they must be namespaced —
`HEORTH_JWT_SECRET`, `FEOH_JWT_SECRET`, `KITH_JWT_SECRET` — and mapped back to the
canonical name inside each service's own `environment:` block. `DATABASE_URL` is
composed in the Compose file from the per-service password so the password appears
once.

**Each service keeps a distinct `JWT_SECRET`.** They are independent auth domains;
one shared secret would silently make a token minted by one service valid at
another. `JWT_SECRET` also keys Heorth's AES-256-GCM encryption of stored M365
refresh tokens — rotating it invalidates them and forces re-consent.

Heorth's six `M365_*` variables are **all-or-nothing**: all present mounts the
module, all absent registers it as a no-op, and partial presence is a startup
error. `.env.example` keeps them in one commented block for exactly that reason.
Per `CLAUDE.md`'s honesty constraints, no real tenant IDs, client IDs, mailbox
addresses, or FQDNs appear in the example file.

## Bootstrap ordering — the step Compose cannot do

Heorth's `FEOH_API_KEY` must be an `fe_` key minted through **Feoh's own API**,
which requires Feoh to be running with its admin seeded. No `depends_on` can
express this.

**Heorth cannot boot without it.** `Heorth/src/config/env.ts:38-39` declares
`FEOH_BASE_URL: z.string().url()` and `FEOH_API_KEY: z.string().min(1)` as
**required** — "Both are required (production and test alike)". An empty value
is a startup validation failure, not a degraded finance proxy. First bring-up is
therefore a *partial* start, as a numbered README procedure:

1. `FEOH_API_KEY=bootstrap docker compose up -d db feoh` — Feoh boots and
   seeds its admin. Heorth is deliberately not started yet. The
   `FEOH_API_KEY=bootstrap` prefix is required even though `heorth` is not in
   the service list: Compose interpolates the entire project model before
   selecting which services to start, so `heorth`'s `${FEOH_API_KEY:?...}`
   guard aborts the whole command without it; the shell-level value overrides
   `--env-file` and is never written to `deploy/.env`.
2. `POST /api/v1/auth/token` against Feoh with `FEOH_ADMIN_PASSWORD`, then
   `POST /api/v1/auth/keys` with that JWT. The raw `fe_` key is returned **once**.
3. Write it to `deploy/.env` as `FEOH_API_KEY`.
4. `docker compose up -d` — Heorth, KithLedger, and the backup sidecar start.

Ordering the bring-up this way means Heorth never runs misconfigured and no
placeholder key is ever written to `.env`.

## Backup

`db-backup` loops on a fixed interval taking a per-database `pg_dump -Fc` into a
`db_backups` volume, pruning dumps past a retention window. Both are env knobs;
the defaults are **daily, kept 14 days**. Restore is a
documented `pg_restore` invocation in the README — an untested restore path is not
a backup. The dump volume holds every household database and is exactly as
sensitive as the cluster.

Each dump is written to a `.tmp` path and `mv`-renamed to its final name only
after `pg_dump` exits cleanly, so a partial or interrupted run never leaves a
truncated `.dump` file behind — a listing under `/backups` is always either
complete or absent.

## Prerequisites

1. **Blocking for `compose.prod.yml`:** Heorth and Feoh publish **no container
   images**. Their CI is `staging.yml` (typecheck, test, build) with no push step;
   KithLedger's `build-image.yml` is the only workflow producing a GHCR image, and
   is the template to copy. Each repo must add its own — not doable from here.
   Recorded in `manual-todo.md`.
2. **Feoh is private.** The household server needs `docker login ghcr.io` with a
   token carrying `read:packages`.
3. **Consolidation is a dump and restore.** Existing per-repo volumes are three
   separate clusters; nothing in Compose merges them. Documented, manual, one time.

## Non-goals

Reverse proxy and TLS. The household **already runs HAProxy** —
`manual-todo.md` §6 records that `heorth.home.example.com` resolves to it and
only the route to the docker host is missing. Terminating TLS a second time
inside the stack would duplicate infrastructure that exists; the stack publishes
ports on the docker host and HAProxy stays the edge. Also out of scope:
`website-v0` in any form, replacing the per-repo single-service
Compose files, Kubernetes or Swarm, secret managers beyond a `.env` file, and any
change to the services' own configuration surfaces — this plan wires what already
exists.
