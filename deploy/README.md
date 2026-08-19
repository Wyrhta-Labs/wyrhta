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
| `kithledger` | 4002 | `kithledger` |
| `heorth-mcp` | 4003 | — (owns no data) |
| `db` | 5432 (dev only) | — |
| `db-backup` | — | dumps both |

HAProxy already fronts the household and terminates TLS
(`heorth.home.example.com`); the stack publishes plain ports on the docker
host and does not run its own proxy.

## First bring-up

Feoh's finance module is built into Heorth (ADR 0007) and is **always on** —
the `FEOH_ENABLED` kill switch was removed on 2026-08-17. Bring-up is a single
phase:

```bash
cp deploy/.env.example deploy/.env
# Fill in every value. Both JWT secrets must differ.
docker compose -f deploy/compose.prod.yml --env-file deploy/.env up -d
```

### Registry login (required — `heorth-mcp` is a private image)

`ghcr.io/wyrhta-labs/heorth-mcp` is **private**, so the docker host must be
logged in to GHCR before the first `up -d`. Without it `compose.prod.yml` still
*validates* (the pin resolves fine) but the pull fails with `denied` /
`unauthorized` at bring-up. The other two images are public; this is the only
service that needs it.

The maintainer's `gh` token already carries the `read:packages` scope, so no
separate PAT is needed:

```bash
gh auth status                     # expect read:packages among the scopes
gh auth token | docker login ghcr.io -u cfoellmann --password-stdin
docker pull ghcr.io/wyrhta-labs/heorth-mcp:main-0c293d6   # prove it, don't assume
```

This writes a credential into the host's docker config and persists across
reboots — it is a one-time step per docker host. **The docker host is
`localhost`** for now; there is no separate remote host yet, so the login above
runs on this machine. Re-run it if the token is ever rotated or revoked: a
`gho_`/`ghp_` token stored in docker's config does not follow `gh auth login`.

## heorth-mcp

The household's single MCP server (ADR 0008), reached on port 4003. It owns no
data and holds no Heorth credential: an MCP client presents its own
`Authorization: Bearer he_...` and heorth-mcp forwards it verbatim to Heorth, so
per-member permissions and the audit trail stay intact end to end.

It talks to `heorth` over the compose network (`HEORTH_BASE_URL=http://heorth:3000`
— origin only; the client appends `/api/v1` itself) and waits for Heorth to be
healthy before starting.

It also serves the 13 `kith.*` tools (task B11). Those carry **member** identity,
not a service key: heorth-mcp exchanges the caller's own `he_` key at Heorth for a
short-lived, audience-bound member token (ADR 0009), which KithLedger verifies
against Heorth's JWKS and provisions the member from just in time. heorth-mcp holds
no signing key and cannot mint one; `KITH_API_KEY` is gone from it entirely.

Prod pins `HEORTH_MCP_IMAGE_TAG`; dev builds from `../heorth-mcp`.

**Pin an immutable tag, never a moving one.** The repo's GitHub Actions workflow
publishes `main-<short sha>` on every push to `main`, and also moves `main` and
`latest` to that build. Only the `main-<sha>` form is safe to pin — `main` and
`latest` would silently change what the household runs on the next `docker
compose pull`. To find the current build:

```bash
gh api orgs/Wyrhta-Labs/packages/container/heorth-mcp/versions \
  --jq '.[0:5][] | "\(.created_at)  \(.metadata.container.tags | join(","))"'
```

Bumping the pin requires the registry login above.

## Satellite identity

Heorth is the household's identity provider. It signs member tokens with
`SATELLITE_SIGNING_KEY` (a single-line Ed25519 JWK — see `.env.example` for the
generator) and publishes the public half, unauthenticated, at
`/.well-known/jwks.json`. KithLedger only ever **verifies**; it holds no signing
key and is structurally unable to mint a member token.

Two things follow, and both are deliberate:

- **The satellite key is not `HEORTH_JWT_SECRET`.** That secret also derives the
  M365 refresh-token encryption key, so sharing it with a satellite would make a
  satellite compromise a Heorth M365 compromise.
- **`SATELLITE_AUDIENCES` is an allowlist.** A token can only be minted for a
  satellite named there, so adding one is a deliberate deployment change.

Key rotation is documented in Heorth's README; every step needs a restart, since
keys are cached for the process lifetime.

## Databases

`initdb/10-databases.sh` creates the two roles and databases — **only when the
data directory is empty**. Docker skips `docker-entrypoint-initdb.d` entirely on
an existing volume.

**Adding a third service later is a manual step**, not a Compose change:

```bash
docker compose -f deploy/compose.prod.yml --env-file deploy/.env exec db \
  psql -U postgres -c "CREATE ROLE newsvc LOGIN PASSWORD '<pw>';" \
  -c "CREATE DATABASE newsvc OWNER newsvc;" \
  -c "REVOKE ALL ON DATABASE newsvc FROM PUBLIC;"
```

The dev file also creates four extra databases: `heorth_test`,
`kithledger_test`, and `heorth_dev`, `kithledger_dev`.

### Which database runs what, and why it matters

| | dev (`compose.dev.yml`) | prod (`compose.prod.yml`) | tests |
|---|---|---|---|
| Heorth | `heorth_dev` | `heorth` | `heorth_test` |
| KithLedger | `kithledger_dev` | `kithledger` | `kithledger_test` |

**The dev services deliberately run against `*_dev`, not the primary databases.**
This is a safety property, not a cosmetic choice. Each service repo's
`tests/setup.ts` refuses to run when `DATABASE_URL` contains `_dev`, and
truncates every table when it does run. Naming the dev data `*_dev` is therefore
what stops a stray `npm test` from wiping it — as happened once already
(`../docs/manual-todo.md`, the dev-DB-wiped note).

Point test suites at the `*_test` databases:

```bash
export DATABASE_URL=postgres://heorth:<pw>@localhost:5432/heorth_test
```

Do **not** point a test run at a primary database (`heorth`,
`kithledger`). The current guard only rejects `_dev`, so a primary name passes it
and the suite will happily truncate. Hardening that guard to require a `_test`
suffix is an open follow-up in the service repos.

The `*_dev` pair exists so this stack's dev cluster can fully replace a
previously hand-run `kith-testdb` container: each service repo's own `.env`
points its local dev config at `<service>_dev` (e.g. `heorth_dev`), and those
database *names* are preserved here rather than renumbered.

**The port is not.** Every service repo's `.env` still reads
`postgres://kith:kithpw@localhost:55432/<service>_dev`, and this stack publishes
**5432** (`compose.dev.yml`, the `db` service). Since `kith-testdb` is retired,
nothing listens on 55432 at all, so those configs are stale and will fail to
connect. Each service repo must update its own `.env` — and the credentials too:
this cluster uses per-service roles
(`postgres://<service>:<pw>@localhost:5432/<service>_dev`), not the old shared
`kith:kithpw`. `Heorth/CLAUDE.md` also still documents the old
`localhost:55432/heorth_test`.

> An earlier revision of this file said the stack publishes **55490**, on the
> grounds that 55432 falls inside a Hyper-V/WSL excluded port range on this host.
> That is not what `compose.dev.yml` does — it maps `5432:5432`, and
> `docker port wyrhta-dev-db-1` confirms `0.0.0.0:5432`. Corrected 2026-08-19;
> if the excluded-range problem resurfaces, change the Compose file and this
> file together.

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
  publishes the same host port this stack uses (Heorth 4000,
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
