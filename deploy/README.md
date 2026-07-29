# Household stack

Two independent Compose files over one shared Postgres 18 cluster.
Design rationale: [`../docs/plans/household-stack-compose.md`](../docs/plans/household-stack-compose.md).

| File | Use | Services from |
|---|---|---|
| `compose.dev.yml` | local work across services | `build:` the sibling checkouts |
| `compose.prod.yml` | the household server | pinned `ghcr.io` images |

They are **deliberately separate**. Do not merge them, add profiles, or use
`extends` — the production file must be readable end to end without resolving
conditionals.

## Services

| Service | Host port | Database |
|---|---|---|
| `heorth` | 4000 | `heorth` |
| `feoh` | 4001 | `feoh` |
| `kithledger` | 4002 | `kithledger` |
| `db` | 55432 (dev only) | — |
| `db-backup` | — | dumps all three |

HAProxy already fronts the household and terminates TLS
(`heorth.home.example.com`); the stack publishes plain ports on the docker
host and does not run its own proxy.

## First bring-up

Heorth requires `FEOH_API_KEY`, and that key can only be minted from a
**running Feoh**. `Heorth/src/config/env.ts` declares it `z.string().min(1)`, so
an empty value is a startup validation failure — not a degraded finance proxy.
Bring the stack up in two phases.

```bash
cp deploy/.env.example deploy/.env
# Fill in every value except FEOH_API_KEY. All three JWT secrets must differ.
```

**1. Start the database and Feoh only.**

Compose interpolates the *entire* project model before deciding which
services to actually start, so the bare command below fails with `required
variable FEOH_API_KEY is missing a value` even though `heorth` is not being
started — prefix it with a throwaway shell value; a shell env var overrides
`--env-file`, so this never gets written to `deploy/.env`.

```bash
FEOH_API_KEY=bootstrap docker compose -f deploy/compose.prod.yml --env-file deploy/.env up -d db feoh
docker compose -f deploy/compose.prod.yml --env-file deploy/.env ps feoh   # wait for (healthy)
```

**2. Mint a service key from Feoh.** The raw key is returned **once**. Feoh
wraps every response in a `{"data": {...}, "meta": {...}}` envelope, so the
field being extracted (`token`, then `key`) sits nested under `data` — the
`sed` below matches the field by name anywhere in the body, so the envelope
does not need to be unwrapped explicitly.

```bash
TOKEN=$(curl -fsS -X POST http://localhost:4001/api/v1/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"password":"<FEOH_ADMIN_PASSWORD>"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')

curl -fsS -X POST http://localhost:4001/api/v1/auth/keys \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"heorth-service"}'
```

The second call's response looks like:

```json
{"data":{"id":"...","name":"heorth-service","key":"fe_...","keyPrefix":"fe_...","createdAt":"..."},"meta":{}}
```

The `data.key` value (starts with `fe_`) is the one to save — it is not shown
again.

**3. Write the `fe_...` value into `deploy/.env` as `FEOH_API_KEY`.**

**4. Start everything else.**

```bash
docker compose -f deploy/compose.prod.yml --env-file deploy/.env up -d
```

## Private registry

`ghcr.io/wyrhta-labs/feoh` is private. Once per host:

```bash
docker login ghcr.io -u <github-user>   # token needs read:packages
```

## Databases

`initdb/10-databases.sh` creates the three roles and databases — **only when the
data directory is empty**. Docker skips `docker-entrypoint-initdb.d` entirely on
an existing volume.

**Adding a fourth service later is a manual step**, not a Compose change:

```bash
docker compose -f deploy/compose.prod.yml --env-file deploy/.env exec db \
  psql -U postgres -c "CREATE ROLE newsvc LOGIN PASSWORD '<pw>';" \
  -c "CREATE DATABASE newsvc OWNER newsvc;" \
  -c "REVOKE ALL ON DATABASE newsvc FROM PUBLIC;"
```

The dev file also creates six extra databases: `heorth_test`, `feoh_test`,
`kithledger_test`, and `heorth_dev`, `feoh_dev`, `kithledger_dev`.

### Which database runs what, and why it matters

| | dev (`compose.dev.yml`) | prod (`compose.prod.yml`) | tests |
|---|---|---|---|
| Heorth | `heorth_dev` | `heorth` | `heorth_test` |
| Feoh | `feoh_dev` | `feoh` | `feoh_test` |
| KithLedger | `kithledger_dev` | `kithledger` | `kithledger_test` |

**The dev services deliberately run against `*_dev`, not the primary databases.**
This is a safety property, not a cosmetic choice. Each service repo's
`tests/setup.ts` refuses to run when `DATABASE_URL` contains `_dev`, and
truncates every table when it does run. Naming the dev data `*_dev` is therefore
what stops a stray `npm test` from wiping it — as happened once already
(`../docs/manual-todo.md`, the dev-DB-wiped note).

Point test suites at the `*_test` databases:

```bash
export DATABASE_URL=postgres://heorth:<pw>@localhost:55432/heorth_test
```

Do **not** point a test run at a primary database (`heorth`, `feoh`,
`kithledger`). The current guard only rejects `_dev`, so a primary name passes it
and the suite will happily truncate. Hardening that guard to require a `_test`
suffix is an open follow-up in the service repos.

The `*_dev` trio exists so this stack's dev cluster can fully replace a
previously hand-run `kith-testdb` container: each service repo's own `.env`
already points its local dev config at `localhost:55432/<service>_dev` (e.g.
`heorth_dev`), and those names are preserved here rather than renumbered, so
existing per-repo dev configs keep working unchanged against this shared
cluster.

## Backups

`db-backup` writes `/backups/<db>-<UTC>.dump` (custom format) into the
`db_backups` volume every `BACKUP_INTERVAL_SECONDS` (default daily), pruning
past `BACKUP_RETENTION_DAYS` (default 14). Each dump is written to a `.tmp`
file first and `mv`-renamed into place only after `pg_dump` exits cleanly, so
a listing in `/backups` is always either a complete dump or absent — never a
truncated one from an interrupted run.

Run one cycle immediately:

```bash
BACKUP_ONCE=true docker compose -f deploy/compose.prod.yml --env-file deploy/.env \
  run --rm db-backup
```

List and restore:

```bash
docker compose -f deploy/compose.prod.yml --env-file deploy/.env \
  run --rm --entrypoint sh db-backup -c 'ls -lh /backups'

docker compose -f deploy/compose.prod.yml --env-file deploy/.env \
  run --rm --entrypoint sh db-backup \
  -c 'pg_restore -h db -U postgres -d heorth --clean --if-exists /backups/heorth-<ts>.dump'
```

Stop the consuming service before restoring into a live database. The dump
volume holds every household database and is as sensitive as the cluster.

These dumps hold table data only, not roles or passwords — a restore onto a
fresh volume works only because `initdb/10-databases.sh` recreates the roles
from `deploy/.env`, so `deploy/.env` is part of the restore path and must be
backed up separately (and as securely as the dumps themselves).

## Gotchas

- **This stack and the per-repo stacks cannot run at the same time.** Each service
  repo still has its own `docker-compose.yml` and `npm run docker:up`, which
  publishes the same host port this stack uses (Heorth 4000, Feoh 4001,
  KithLedger 4002). Running both gives `port is already allocated`. The per-repo
  files are kept deliberately — they are still the quickest way to bring up one
  service alone — but pick one or the other. The same applies to running a
  service natively with `npm run dev`.
- **The Postgres volume mounts at `/var/lib/postgresql`, not `.../data`.**
  Postgres 18 sets `PGDATA` to `/var/lib/postgresql/<major>/docker`. The old path
  makes the container start against an anonymous volume and *silently* stop
  persisting data. Verify with `SHOW data_directory;` → `/var/lib/postgresql/18/docker`.
- **A volume created under Postgres 16 will not start under 18.** Dump under 16,
  recreate the volume, restore under 18.
- **Consolidating the old per-repo stacks is manual.** Each service repo's own
  Compose file spins up a separate cluster. Moving to this shared one is a
  `pg_dump`/`pg_restore` per database, once.
- **`docker compose down -v` deletes the data and backup volumes.** Omit `-v`.
- **Heorth's six `M365_*` vars are all-or-nothing.** All set, or all blank.
  Partial presence is a startup error.
- **Rotating `HEORTH_JWT_SECRET` invalidates stored M365 refresh tokens** — it
  keys their encryption at rest. Members must re-consent.
- **`deploy/.env` is git-ignored and must stay that way.** Check
  `git status --porcelain` before committing anything in `deploy/`.
