# Household Stack Compose Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `deploy/` in the meta repo — two strictly separated Docker Compose files (dev builds from sibling checkouts, prod pulls pinned GHCR images) running Heorth, Feoh, and KithLedger over one shared Postgres 18 cluster with a backup sidecar.

**Architecture:** One `postgres:18-alpine` container holds three databases (`heorth`, `feoh`, `kithledger`), each owned by its own login role, provisioned by a single `initdb` shell script that runs on first boot only. Each service keeps its own JWT secret and admin password; env vars are namespaced in `.env` and mapped back to each app's canonical names inside its `environment:` block. No profiles and no override files — `compose.dev.yml` and `compose.prod.yml` are independent and each readable end to end.

**Tech Stack:** Docker Compose v2, `postgres:18-alpine`, `node:22-alpine` service images, POSIX `sh`.

**Design spec:** `docs/plans/household-stack-compose.md`

## Global Constraints

- Postgres image is **`postgres:18-alpine`** in every file. ADR 0006 rule 2: official image only, no third-party image (`pgvector/pgvector:pg*` included).
- The Postgres volume mounts at **`/var/lib/postgresql`**, never `/var/lib/postgresql/data`. Postgres 18 sets `PGDATA` to `/var/lib/postgresql/<major>/docker` and declares its volume one level up; the old path silently stops persisting data.
- **No profiles, no override files, no `extends`.** The two compose files duplicate structure on purpose.
- Host ports: **Heorth 4000, Feoh 4001, KithLedger 4002**, each → container `3000`. Postgres exposes **55432** in dev only.
- Health endpoint is **`GET /health`** at the root (not under `/api/v1`) on all three services.
- Service images are `node:22-alpine` and contain **no `curl` or `wget`**. Healthchecks use Node's global `fetch`.
- Every service gets a **distinct** `JWT_SECRET`, minimum **32 characters**. Sharing one would make tokens cross-valid between services.
- Heorth's six `M365_*` vars are **all-or-nothing**: all set, or all blank. Partial presence is a startup error.
- Heorth's `FEOH_BASE_URL` and `FEOH_API_KEY` are **required** — it will not boot with either empty.
- **Never commit secrets.** No real tenant IDs, client IDs, client secrets, mailbox addresses, or FQDNs in any committed file, per `CLAUDE.md`'s honesty constraints. `deploy/.env` is git-ignored; only `deploy/.env.example` with empty values is committed.
- Commit **directly to `main`** in this repo — no branches, no PRs. **Never** add a Claude/AI co-author trailer to a commit message.
- Do not edit anything inside `Heorth/`, `Feoh/`, `KithLedger/`, `wyrhta-core/`, or `website-v0/` — they are separate repos, git-ignored here.

---

### Task 1: Shared Postgres cluster + repo rule carve-out

**Files:**
- Modify: `CLAUDE.md` (working-mode section)
- Modify: `.gitignore`
- Create: `deploy/.env.example`
- Create: `deploy/initdb/10-databases.sh`
- Create: `deploy/compose.dev.yml`

**Interfaces:**
- Consumes: nothing (first task).
- Produces: a running `db` service named `db` on the compose network, port `5432` internally and `55432` on the host. Databases `heorth`, `feoh`, `kithledger` owned by like-named login roles, plus `heorth_test`, `feoh_test`, `kithledger_test` in dev. Superuser is `postgres`. Volume `db_data`. Env var names `POSTGRES_SUPERUSER_PASSWORD`, `HEORTH_DB_PASSWORD`, `FEOH_DB_PASSWORD`, `KITH_DB_PASSWORD`, and the flag `CREATE_TEST_DATABASES`.

- [ ] **Step 1: Carve `deploy/` out of the docs-only rule**

In `CLAUDE.md`, under `## Working mode for this repo (IMPORTANT)`, replace the first bullet:

```markdown
- **Conceptual / architecture design only.** Work here produces docs under `docs/`.
```

with:

```markdown
- **Conceptual / architecture design only.** Work here produces docs under `docs/`.
  **One exception: `deploy/`** holds the household stack's Docker Compose files
  (`docs/plans/household-stack-compose.md`). It is the only runnable, non-docs
  content this repo tracks, because the meta repo is the only place that knows
  every service exists. This carve-out does not license editing code inside the
  service folders — that rule is unchanged.
```

- [ ] **Step 2: Git-ignore the secrets file before it can exist**

Append to `.gitignore`:

```gitignore

# --- Deployment secrets (deploy/.env.example is the committed template) ---
/deploy/.env
```

- [ ] **Step 3: Write `deploy/.env.example`**

Values are empty on purpose — this file is committed.

```bash
# Wyrhta Labs household stack — environment template.
# Copy to deploy/.env and fill in. deploy/.env is git-ignored; NEVER commit it.
# Generate a secret: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"

# --- Postgres: one cluster, three databases -------------------------------
POSTGRES_SUPERUSER_PASSWORD=
HEORTH_DB_PASSWORD=
FEOH_DB_PASSWORD=
KITH_DB_PASSWORD=

# --- Per-service auth. All three JWT secrets MUST differ (32+ chars each).
# A shared secret would make a token minted by one service valid at another.
# HEORTH_JWT_SECRET also keys Heorth's encryption of stored M365 refresh
# tokens — rotating it invalidates them and forces re-consent.
HEORTH_JWT_SECRET=
FEOH_JWT_SECRET=
KITH_JWT_SECRET=
HEORTH_ADMIN_PASSWORD=
FEOH_ADMIN_PASSWORD=
KITH_ADMIN_PASSWORD=

# --- Heorth household identity --------------------------------------------
HOUSEHOLD_NAME=
HEORTH_ADMIN_EMAIL=

# --- Heorth -> Feoh service link ------------------------------------------
# Heorth REFUSES TO START if either is empty. FEOH_API_KEY is minted from a
# running Feoh — see deploy/README.md, first bring-up, steps 1-4.
FEOH_BASE_URL=http://feoh:3000
FEOH_API_KEY=

# --- Microsoft 365 (Heorth only): ALL SIX, or ALL BLANK -------------------
# Partial presence is a startup error. All blank = module registers as a no-op.
# Real tenant/client/mailbox values belong in deploy/.env only, never here.
M365_TENANT_ID=
M365_CLIENT_ID=
M365_CLIENT_SECRET=
M365_REDIRECT_URI=
M365_FAMILY_MAILBOX=
M365_SHARED_TODO_LIST=

# --- Shared tuning knobs ---------------------------------------------------
JWT_TTL_SECONDS=604800
DB_POOL_MAX=10

# --- Backups ---------------------------------------------------------------
BACKUP_INTERVAL_SECONDS=86400
BACKUP_RETENTION_DAYS=14

# --- Prod only: pinned image tags (compose.prod.yml) ----------------------
HEORTH_IMAGE_TAG=
FEOH_IMAGE_TAG=
KITH_IMAGE_TAG=
```

- [ ] **Step 4: Write `deploy/initdb/10-databases.sh`**

A shell script rather than `.sql` so passwords come from the environment instead of a committed file.

```sh
#!/bin/sh
# Provisions the three household databases in the shared cluster.
#
# RUNS ONCE, AND ONLY WHEN THE DATA DIRECTORY IS EMPTY. docker-entrypoint-initdb.d
# is skipped entirely on an existing volume. Adding a fourth service to a live
# cluster is a manual psql step — see deploy/README.md.
set -eu

create_owned_db() {
  role="$1"
  db="$2"
  pw="$3"

  if [ -z "$pw" ]; then
    echo "initdb: refusing to create role '$role' with an empty password" >&2
    exit 1
  fi

  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
	CREATE ROLE "$role" LOGIN PASSWORD '$pw';
	CREATE DATABASE "$db" OWNER "$role";
	REVOKE ALL ON DATABASE "$db" FROM PUBLIC;
	EOSQL
  echo "initdb: created database '$db' owned by '$role'"
}

create_owned_db heorth     heorth     "${HEORTH_DB_PASSWORD:-}"
create_owned_db feoh       feoh       "${FEOH_DB_PASSWORD:-}"
create_owned_db kithledger kithledger "${KITH_DB_PASSWORD:-}"

# Dev only: separate databases for the test suites, so per-test truncation can
# never wipe dev data (the incident recorded at docs/manual-todo.md).
if [ "${CREATE_TEST_DATABASES:-false}" = "true" ]; then
  for pair in "heorth:heorth_test" "feoh:feoh_test" "kithledger:kithledger_test"; do
    role="${pair%%:*}"
    db="${pair##*:}"
    psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres <<-EOSQL
	CREATE DATABASE "$db" OWNER "$role";
	EOSQL
    echo "initdb: created test database '$db'"
  done
fi
```

Note the here-doc bodies are indented with **tab** characters — `<<-` strips leading tabs only, not spaces. If your editor converts them to spaces the SQL still runs, but keep tabs to match the upstream `postgres` image's own init scripts.

- [ ] **Step 5: Write `deploy/compose.dev.yml` with only the `db` service**

```yaml
# Wyrhta Labs household stack — DEVELOPMENT.
#
# Builds every service from its sibling checkout, so Heorth/, Feoh/, and
# KithLedger/ must be cloned beside this repo. The deployment file is
# compose.prod.yml; the two are deliberately independent and must not be
# merged, extended, or turned into profiles.
#
#   docker compose -f deploy/compose.dev.yml --env-file deploy/.env up -d

name: wyrhta-dev

services:
  db:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_DB: postgres
      POSTGRES_PASSWORD: ${POSTGRES_SUPERUSER_PASSWORD:?set it in deploy/.env}
      HEORTH_DB_PASSWORD: ${HEORTH_DB_PASSWORD:?set it in deploy/.env}
      FEOH_DB_PASSWORD: ${FEOH_DB_PASSWORD:?set it in deploy/.env}
      KITH_DB_PASSWORD: ${KITH_DB_PASSWORD:?set it in deploy/.env}
      CREATE_TEST_DATABASES: "true"
    volumes:
      # Postgres 18 sets PGDATA to /var/lib/postgresql/<major>/docker and
      # declares its volume one level up. Mounting /var/lib/postgresql/data
      # makes the container start against an anonymous volume and SILENTLY
      # STOP PERSISTING DATA.
      - db_data:/var/lib/postgresql
      - ./initdb:/docker-entrypoint-initdb.d:ro
    ports:
      - "55432:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d postgres"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped

volumes:
  db_data:
```

- [ ] **Step 6: Create a local `.env` and verify the stack refuses to start without secrets**

```bash
cd /path/to/wyrhta
cp deploy/.env.example deploy/.env
docker compose -f deploy/compose.dev.yml --env-file deploy/.env config -q
```

Expected: **FAIL** with `required variable POSTGRES_SUPERUSER_PASSWORD is missing a value: set it in deploy/.env`. This proves the `:?` guards work.

- [ ] **Step 7: Fill the database passwords and bring up `db`**

Edit `deploy/.env` and set the four Postgres passwords to generated values, then:

```bash
docker compose -f deploy/compose.dev.yml --env-file deploy/.env up -d db
docker compose -f deploy/compose.dev.yml --env-file deploy/.env ps
```

Expected: `db` is `running (healthy)` within ~15s.

- [ ] **Step 8: Verify the six databases and three roles exist**

```bash
docker compose -f deploy/compose.dev.yml --env-file deploy/.env exec -T db \
  psql -U postgres -Atc \
  "SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY 1;"
```

Expected exactly: `feoh`, `feoh_dev`, `feoh_test`, `heorth`, `heorth_dev`, `heorth_test`, `kithledger`, `kithledger_dev`, `kithledger_test`, `postgres`.

> **Note (human-approved mid-execution deviation):** the original expected list
> was six database names plus `postgres`. During execution, `10-databases.sh`
> was extended to also create `heorth_dev`, `feoh_dev`, and `kithledger_dev` so
> this dev cluster replaces a previously hand-run `kith-testdb` container that
> each service repo's own `.env` already points at
> (`localhost:55432/<service>_dev`). The expected list above is now ten rows.

```bash
docker compose -f deploy/compose.dev.yml --env-file deploy/.env exec -T db \
  psql -U postgres -Atc \
  "SELECT rolname FROM pg_roles WHERE rolcanlogin AND rolname <> 'postgres' ORDER BY 1;"
```

Expected exactly: `feoh`, `heorth`, `kithledger`.

- [ ] **Step 9: Verify the Postgres 18 data directory**

```bash
docker compose -f deploy/compose.dev.yml --env-file deploy/.env exec -T db \
  psql -U postgres -Atc "SHOW data_directory;"
```

Expected: `/var/lib/postgresql/18/docker`.

- [ ] **Step 10: Verify data actually survives a restart**

This is the test that catches a wrong volume path — the failure mode is silent, so it must be proven, not assumed.

```bash
docker compose -f deploy/compose.dev.yml --env-file deploy/.env exec -T db \
  psql -U heorth -d heorth -c "CREATE TABLE persistence_probe (id int); INSERT INTO persistence_probe VALUES (42);"

docker compose -f deploy/compose.dev.yml --env-file deploy/.env down
docker compose -f deploy/compose.dev.yml --env-file deploy/.env up -d db
sleep 15

docker compose -f deploy/compose.dev.yml --env-file deploy/.env exec -T db \
  psql -U heorth -d heorth -Atc "SELECT id FROM persistence_probe;"
```

Expected: `42`. If this returns "relation does not exist", the volume path is wrong — do not continue.

Note `down` **without** `-v`. Using `-v` deletes the volume and invalidates the test.

- [ ] **Step 11: Drop the probe table**

```bash
docker compose -f deploy/compose.dev.yml --env-file deploy/.env exec -T db \
  psql -U heorth -d heorth -c "DROP TABLE persistence_probe;"
```

- [ ] **Step 12: Commit**

```bash
git add CLAUDE.md .gitignore deploy/.env.example deploy/initdb/10-databases.sh deploy/compose.dev.yml
git status --porcelain   # confirm deploy/.env is NOT listed
git commit -m "Add shared Postgres 18 cluster to the dev compose stack

One cluster, three owned databases plus test siblings, provisioned by an
initdb script. Carves deploy/ out of this repo's docs-only working mode."
```

---

### Task 2: The three API services in dev

**Files:**
- Modify: `deploy/compose.dev.yml` (add three services)

**Interfaces:**
- Consumes: the `db` service and the `*_DB_PASSWORD` env vars from Task 1.
- Produces: services named `heorth`, `feoh`, `kithledger` on the compose network, each listening on container port `3000` and answering `GET /health`. Host ports 4000, 4001, 4002.

- [ ] **Step 1: Confirm the sibling checkouts are present**

```bash
ls -d Heorth Feoh KithLedger
```

Expected: all three listed. The dev file cannot build without them.

- [ ] **Step 2: Add the three services to `deploy/compose.dev.yml`**

Insert between the `db` service and the `volumes:` block. Order matters for readability: `feoh` first because `heorth` depends on it.

```yaml
  feoh:
    build: ../Feoh
    environment:
      DATABASE_URL: postgres://feoh:${FEOH_DB_PASSWORD:?}@db:5432/feoh
      JWT_SECRET: ${FEOH_JWT_SECRET:?set it in deploy/.env}
      ADMIN_PASSWORD: ${FEOH_ADMIN_PASSWORD:?set it in deploy/.env}
      API_PORT: 3000
      JWT_TTL_SECONDS: ${JWT_TTL_SECONDS:-604800}
      DB_POOL_MAX: ${DB_POOL_MAX:-10}
      CORS_ORIGIN: "*"
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "4001:3000"
    healthcheck:
      # node:22-alpine has no curl or wget; Node 22 has a global fetch.
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    restart: unless-stopped

  kithledger:
    build: ../KithLedger
    environment:
      DATABASE_URL: postgres://kithledger:${KITH_DB_PASSWORD:?}@db:5432/kithledger
      JWT_SECRET: ${KITH_JWT_SECRET:?set it in deploy/.env}
      ADMIN_PASSWORD: ${KITH_ADMIN_PASSWORD:?set it in deploy/.env}
      API_PORT: 3000
      JWT_TTL_SECONDS: ${JWT_TTL_SECONDS:-604800}
      DB_POOL_MAX: ${DB_POOL_MAX:-10}
      CORS_ORIGIN: "*"
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "4002:3000"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    restart: unless-stopped

  heorth:
    build: ../Heorth
    environment:
      DATABASE_URL: postgres://heorth:${HEORTH_DB_PASSWORD:?}@db:5432/heorth
      JWT_SECRET: ${HEORTH_JWT_SECRET:?set it in deploy/.env}
      ADMIN_PASSWORD: ${HEORTH_ADMIN_PASSWORD:?set it in deploy/.env}
      ADMIN_EMAIL: ${HEORTH_ADMIN_EMAIL:?set it in deploy/.env}
      HOUSEHOLD_NAME: ${HOUSEHOLD_NAME:?set it in deploy/.env}
      API_PORT: 3000
      JWT_TTL_SECONDS: ${JWT_TTL_SECONDS:-604800}
      DB_POOL_MAX: ${DB_POOL_MAX:-10}
      CORS_ORIGIN: "*"
      # Both required — Heorth fails env validation at startup if either is
      # empty. See deploy/README.md first bring-up.
      FEOH_BASE_URL: ${FEOH_BASE_URL:?set it in deploy/.env}
      FEOH_API_KEY: ${FEOH_API_KEY:?mint it from Feoh — see deploy/README.md}
      # All six, or all blank. Partial presence is a startup error.
      M365_TENANT_ID: ${M365_TENANT_ID:-}
      M365_CLIENT_ID: ${M365_CLIENT_ID:-}
      M365_CLIENT_SECRET: ${M365_CLIENT_SECRET:-}
      M365_REDIRECT_URI: ${M365_REDIRECT_URI:-}
      M365_FAMILY_MAILBOX: ${M365_FAMILY_MAILBOX:-}
      M365_SHARED_TODO_LIST: ${M365_SHARED_TODO_LIST:-}
    depends_on:
      db:
        condition: service_healthy
      feoh:
        condition: service_healthy
    ports:
      - "4000:3000"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    restart: unless-stopped
```

- [ ] **Step 3: Verify Heorth refuses to start without a Feoh key**

Leave `FEOH_API_KEY` empty in `deploy/.env` and fill the remaining secrets (`HEORTH_JWT_SECRET`, `FEOH_JWT_SECRET`, `KITH_JWT_SECRET`, the three admin passwords, `HOUSEHOLD_NAME`, `HEORTH_ADMIN_EMAIL`).

```bash
docker compose -f deploy/compose.dev.yml --env-file deploy/.env config -q
```

Expected: **FAIL** with `required variable FEOH_API_KEY is missing a value: mint it from Feoh — see deploy/README.md`. This is the guard that stops a misconfigured Heorth from ever booting.

- [ ] **Step 4: Bring up `db` and `feoh` only, and confirm Feoh is healthy**

```bash
FEOH_API_KEY=placeholder docker compose -f deploy/compose.dev.yml --env-file deploy/.env up -d --build db feoh
sleep 45
docker compose -f deploy/compose.dev.yml --env-file deploy/.env ps feoh
curl -fsS http://localhost:4001/health
```

Expected: `feoh` shows `running (healthy)`, and the curl prints a JSON body containing `"status":"ok"`.

The inline `FEOH_API_KEY=placeholder` only satisfies compose's interpolation guard so the file parses; `feoh` itself never reads it. Task 5 replaces it with a real minted key.

- [ ] **Step 5: Bring up the rest and confirm all three are healthy**

```bash
FEOH_API_KEY=placeholder docker compose -f deploy/compose.dev.yml --env-file deploy/.env up -d --build
sleep 60
docker compose -f deploy/compose.dev.yml --env-file deploy/.env ps
```

Expected: `db`, `feoh`, `kithledger`, `heorth` all `running (healthy)`.

- [ ] **Step 6: Verify each service answers on its own host port**

```bash
for p in 4000 4001 4002; do echo -n "$p: "; curl -fsS "http://localhost:$p/health"; echo; done
```

Expected: three JSON responses containing `"status":"ok"`.

- [ ] **Step 7: Verify each service migrated into its own database only**

```bash
for d in heorth feoh kithledger; do
  echo "== $d =="
  docker compose -f deploy/compose.dev.yml --env-file deploy/.env exec -T db \
    psql -U postgres -d "$d" -Atc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public';"
done
```

Expected: a non-zero count for each — every service ran its startup migrations against its own database.

- [ ] **Step 8: Commit**

```bash
git add deploy/compose.dev.yml
git commit -m "Add Heorth, Feoh, and KithLedger to the dev compose stack

Each service builds from its sibling checkout, gets a distinct JWT secret,
and connects to its own database in the shared cluster."
```

---

### Task 3: Backup sidecar

**Files:**
- Create: `deploy/backup.sh`
- Modify: `deploy/compose.dev.yml` (add `db-backup` service and `db_backups` volume)

**Interfaces:**
- Consumes: the `db` service and `POSTGRES_SUPERUSER_PASSWORD` from Task 1.
- Produces: a `db-backup` service writing `/backups/<db>-<UTC timestamp>.dump` files into the `db_backups` volume. Honours `BACKUP_INTERVAL_SECONDS`, `BACKUP_RETENTION_DAYS`, and `BACKUP_ONCE`.

- [ ] **Step 1: Write `deploy/backup.sh`**

`BACKUP_ONCE` exists so the loop is testable without waiting a day.

```sh
#!/bin/sh
# Periodic pg_dump of every household database into /backups.
#
# Runs postgres:18-alpine purely as a client — this does not affect ADR 0006
# rule 2, which constrains the image holding household data.
set -eu

INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
RETENTION="${BACKUP_RETENTION_DAYS:-14}"
DATABASES="heorth feoh kithledger"

while true; do
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  for db in $DATABASES; do
    out="/backups/${db}-${ts}.dump"
    tmp="${out}.tmp"
    if pg_dump -h db -U postgres -d "$db" -Fc -f "$tmp"; then
      mv "$tmp" "$out"
      echo "backup ok: ${out}"
    else
      echo "backup FAILED for '${db}'" >&2
      rm -f "$tmp"
    fi
  done

  # Prune by age. -mtime +N is "older than N days".
  find /backups -name '*.dump' -type f -mtime "+${RETENTION}" -delete
  echo "backup: pruned dumps older than ${RETENTION} days"

  if [ "${BACKUP_ONCE:-false}" = "true" ]; then
    echo "backup: BACKUP_ONCE set, exiting"
    exit 0
  fi

  sleep "$INTERVAL"
done
```

> **Note (human-approved mid-execution deviation):** the listing above is the
> code as actually committed in `deploy/backup.sh`. An earlier draft wrote
> `pg_dump ... -f "$out"` directly; that left a truncated `.dump` file behind
> if `pg_dump` was interrupted partway through. It was corrected during
> execution to write to `"$tmp"` and `mv`-rename to `"$out"` only after a
> clean exit, so a file appearing in `/backups` is always either complete or
> absent.

- [ ] **Step 2: Add the service to `deploy/compose.dev.yml`**

Add before the `volumes:` block:

```yaml
  db-backup:
    image: postgres:18-alpine
    environment:
      PGPASSWORD: ${POSTGRES_SUPERUSER_PASSWORD:?set it in deploy/.env}
      BACKUP_INTERVAL_SECONDS: ${BACKUP_INTERVAL_SECONDS:-86400}
      BACKUP_RETENTION_DAYS: ${BACKUP_RETENTION_DAYS:-14}
      BACKUP_ONCE: ${BACKUP_ONCE:-false}
    volumes:
      - db_backups:/backups
      - ./backup.sh:/usr/local/bin/backup.sh:ro
    entrypoint: ["/bin/sh", "/usr/local/bin/backup.sh"]
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped
```

and extend the `volumes:` block to:

```yaml
volumes:
  db_data:
  db_backups:
```

- [ ] **Step 3: Run one backup cycle and verify it exits cleanly**

```bash
FEOH_API_KEY=placeholder BACKUP_ONCE=true \
  docker compose -f deploy/compose.dev.yml --env-file deploy/.env run --rm db-backup
```

Expected output: three `backup ok: /backups/<db>-<ts>.dump` lines, a prune line, and `backup: BACKUP_ONCE set, exiting`. Exit code 0.

- [ ] **Step 4: Verify the dumps exist and are valid archives**

A file existing is not proof it can be restored — `pg_restore --list` parses the archive header.

```bash
FEOH_API_KEY=placeholder docker compose -f deploy/compose.dev.yml --env-file deploy/.env \
  run --rm --entrypoint sh db-backup -c 'ls -1 /backups/*.dump | wc -l'
```

Expected: `3`.

```bash
FEOH_API_KEY=placeholder docker compose -f deploy/compose.dev.yml --env-file deploy/.env \
  run --rm --entrypoint sh db-backup -c 'for f in /backups/*.dump; do pg_restore --list "$f" >/dev/null && echo "valid: $f"; done'
```

Expected: three `valid: /backups/...` lines and exit code 0.

- [ ] **Step 5: Commit**

```bash
git add deploy/backup.sh deploy/compose.dev.yml
git commit -m "Add a pg_dump backup sidecar to the dev compose stack

Interval and retention are env knobs (default daily, 14 days). BACKUP_ONCE
runs a single cycle so the path is testable."
```

---

### Task 4: Production compose file

**Files:**
- Create: `deploy/compose.prod.yml`

**Interfaces:**
- Consumes: the same `deploy/.env` contract, plus `HEORTH_IMAGE_TAG`, `FEOH_IMAGE_TAG`, `KITH_IMAGE_TAG`.
- Produces: the deployable stack. Same service names and topology as dev.

Deliberate differences from dev, and only these: pinned `image:` instead of `build:`; no `CREATE_TEST_DATABASES`, so no `*_test` databases; no host port on `db`; `CORS_ORIGIN` configurable rather than `*`.

- [ ] **Step 1: Write `deploy/compose.prod.yml`**

```yaml
# Wyrhta Labs household stack — DEPLOYMENT.
#
# Pulls pinned images from GHCR; no source checkout required on the host.
# ghcr.io/wyrhta-labs/feoh is PRIVATE — the host needs a prior
#   docker login ghcr.io
# with a token carrying read:packages.
#
# The development file is compose.dev.yml. The two are deliberately
# independent and must not be merged, extended, or turned into profiles.
#
#   docker compose -f deploy/compose.prod.yml --env-file deploy/.env up -d

name: wyrhta

services:
  db:
    image: postgres:18-alpine
    environment:
      POSTGRES_USER: postgres
      POSTGRES_DB: postgres
      POSTGRES_PASSWORD: ${POSTGRES_SUPERUSER_PASSWORD:?set it in deploy/.env}
      HEORTH_DB_PASSWORD: ${HEORTH_DB_PASSWORD:?set it in deploy/.env}
      FEOH_DB_PASSWORD: ${FEOH_DB_PASSWORD:?set it in deploy/.env}
      KITH_DB_PASSWORD: ${KITH_DB_PASSWORD:?set it in deploy/.env}
    volumes:
      # Postgres 18 PGDATA is /var/lib/postgresql/<major>/docker and the
      # declared volume is one level up. Mounting /var/lib/postgresql/data
      # SILENTLY STOPS PERSISTING DATA.
      - db_data:/var/lib/postgresql
      - ./initdb:/docker-entrypoint-initdb.d:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres -d postgres"]
      interval: 5s
      timeout: 5s
      retries: 10
    restart: unless-stopped

  feoh:
    image: ghcr.io/wyrhta-labs/feoh:${FEOH_IMAGE_TAG:?pin an image tag in deploy/.env}
    environment:
      DATABASE_URL: postgres://feoh:${FEOH_DB_PASSWORD:?}@db:5432/feoh
      JWT_SECRET: ${FEOH_JWT_SECRET:?set it in deploy/.env}
      ADMIN_PASSWORD: ${FEOH_ADMIN_PASSWORD:?set it in deploy/.env}
      API_PORT: 3000
      JWT_TTL_SECONDS: ${JWT_TTL_SECONDS:-604800}
      DB_POOL_MAX: ${DB_POOL_MAX:-10}
      CORS_ORIGIN: ${FEOH_CORS_ORIGIN:-http://heorth:3000}
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "4001:3000"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    restart: unless-stopped

  kithledger:
    image: ghcr.io/wyrhta-labs/kithledger:${KITH_IMAGE_TAG:?pin an image tag in deploy/.env}
    environment:
      DATABASE_URL: postgres://kithledger:${KITH_DB_PASSWORD:?}@db:5432/kithledger
      JWT_SECRET: ${KITH_JWT_SECRET:?set it in deploy/.env}
      ADMIN_PASSWORD: ${KITH_ADMIN_PASSWORD:?set it in deploy/.env}
      API_PORT: 3000
      JWT_TTL_SECONDS: ${JWT_TTL_SECONDS:-604800}
      DB_POOL_MAX: ${DB_POOL_MAX:-10}
      CORS_ORIGIN: ${KITH_CORS_ORIGIN:-*}
    depends_on:
      db:
        condition: service_healthy
    ports:
      - "4002:3000"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    restart: unless-stopped

  heorth:
    image: ghcr.io/wyrhta-labs/heorth:${HEORTH_IMAGE_TAG:?pin an image tag in deploy/.env}
    environment:
      DATABASE_URL: postgres://heorth:${HEORTH_DB_PASSWORD:?}@db:5432/heorth
      JWT_SECRET: ${HEORTH_JWT_SECRET:?set it in deploy/.env}
      ADMIN_PASSWORD: ${HEORTH_ADMIN_PASSWORD:?set it in deploy/.env}
      ADMIN_EMAIL: ${HEORTH_ADMIN_EMAIL:?set it in deploy/.env}
      HOUSEHOLD_NAME: ${HOUSEHOLD_NAME:?set it in deploy/.env}
      API_PORT: 3000
      JWT_TTL_SECONDS: ${JWT_TTL_SECONDS:-604800}
      DB_POOL_MAX: ${DB_POOL_MAX:-10}
      CORS_ORIGIN: ${HEORTH_CORS_ORIGIN:-*}
      FEOH_BASE_URL: ${FEOH_BASE_URL:?set it in deploy/.env}
      FEOH_API_KEY: ${FEOH_API_KEY:?mint it from Feoh — see deploy/README.md}
      M365_TENANT_ID: ${M365_TENANT_ID:-}
      M365_CLIENT_ID: ${M365_CLIENT_ID:-}
      M365_CLIENT_SECRET: ${M365_CLIENT_SECRET:-}
      M365_REDIRECT_URI: ${M365_REDIRECT_URI:-}
      M365_FAMILY_MAILBOX: ${M365_FAMILY_MAILBOX:-}
      M365_SHARED_TODO_LIST: ${M365_SHARED_TODO_LIST:-}
    depends_on:
      db:
        condition: service_healthy
      feoh:
        condition: service_healthy
    ports:
      - "4000:3000"
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 5
      start_period: 30s
    restart: unless-stopped

  db-backup:
    image: postgres:18-alpine
    environment:
      PGPASSWORD: ${POSTGRES_SUPERUSER_PASSWORD:?set it in deploy/.env}
      BACKUP_INTERVAL_SECONDS: ${BACKUP_INTERVAL_SECONDS:-86400}
      BACKUP_RETENTION_DAYS: ${BACKUP_RETENTION_DAYS:-14}
      BACKUP_ONCE: ${BACKUP_ONCE:-false}
    volumes:
      - db_backups:/backups
      - ./backup.sh:/usr/local/bin/backup.sh:ro
    entrypoint: ["/bin/sh", "/usr/local/bin/backup.sh"]
    depends_on:
      db:
        condition: service_healthy
    restart: unless-stopped

volumes:
  db_data:
  db_backups:
```

- [ ] **Step 2: Verify it fails without pinned image tags**

With `HEORTH_IMAGE_TAG` still empty in `deploy/.env`:

```bash
FEOH_API_KEY=placeholder docker compose -f deploy/compose.prod.yml --env-file deploy/.env config -q
```

Expected: **FAIL** with `required variable HEORTH_IMAGE_TAG is missing a value: pin an image tag in deploy/.env`. Unpinned production images are the failure this guard prevents.

- [ ] **Step 3: Verify it parses once tags are pinned**

Set `HEORTH_IMAGE_TAG=v0.3.1`, `FEOH_IMAGE_TAG=v0.1.0`, `KITH_IMAGE_TAG=v0.1.0` in `deploy/.env`, then:

```bash
FEOH_API_KEY=placeholder docker compose -f deploy/compose.prod.yml --env-file deploy/.env config -q
echo "exit=$?"
```

Expected: `exit=0`, no output.

- [ ] **Step 4: Verify the prod file has no build contexts and no test databases**

```bash
FEOH_API_KEY=placeholder docker compose -f deploy/compose.prod.yml --env-file deploy/.env config \
  | grep -E "build:|CREATE_TEST_DATABASES|55432" || echo "CLEAN"
```

Expected: `CLEAN`. Any hit means dev-only configuration leaked into the deployment file.

- [ ] **Step 5: Verify both files resolve to the same five services**

```bash
FEOH_API_KEY=placeholder docker compose -f deploy/compose.prod.yml --env-file deploy/.env config --services | sort
FEOH_API_KEY=placeholder docker compose -f deploy/compose.dev.yml  --env-file deploy/.env config --services | sort
```

Expected: both print exactly `db`, `db-backup`, `feoh`, `heorth`, `kithledger`. Divergence here means the two files have drifted apart.

- [ ] **Step 6: Commit**

```bash
git add deploy/compose.prod.yml
git commit -m "Add the production compose file

Pinned GHCR image tags, no build contexts, no test databases, Postgres not
exposed on the host. Same topology and service names as the dev file."
```

---

### Task 5: Operator README

**Files:**
- Create: `deploy/README.md`

**Interfaces:**
- Consumes: everything from Tasks 1-4.
- Produces: no code. The procedures no `depends_on` can express.

- [ ] **Step 1: Write `deploy/README.md`**

````markdown
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

**2. Mint a service key from Feoh.** The raw key is returned **once**.

```bash
TOKEN=$(curl -fsS -X POST http://localhost:4001/api/v1/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"password":"<FEOH_ADMIN_PASSWORD>"}' | sed -E 's/.*"token":"([^"]+)".*/\1/')

curl -fsS -X POST http://localhost:4001/api/v1/auth/keys \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"heorth-service"}'
```

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

The dev file also creates `heorth_test`, `feoh_test`, and `kithledger_test`.
**Point test suites at those**, never at the dev databases — the suites truncate
every table between tests, which has wiped dev state before.

## Backups

`db-backup` writes `/backups/<db>-<UTC>.dump` (custom format) into the
`db_backups` volume every `BACKUP_INTERVAL_SECONDS` (default daily), pruning
past `BACKUP_RETENTION_DAYS` (default 14).

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

## Gotchas

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
````

- [ ] **Step 2: Verify the key-minting procedure actually works**

Documentation that has not been executed is a guess. With the dev stack up from Task 2:

```bash
TOKEN=$(curl -fsS -X POST http://localhost:4001/api/v1/auth/token \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$(grep '^FEOH_ADMIN_PASSWORD=' deploy/.env | cut -d= -f2-)\"}")
echo "$TOKEN"
```

Expected: a JSON body containing a `token` field. If the response shape differs from what the README's `sed` assumes, **fix the README to match reality**.

- [ ] **Step 3: Mint a real key and confirm it is accepted**

```bash
TOKEN=$(curl -fsS -X POST http://localhost:4001/api/v1/auth/token \
  -H 'Content-Type: application/json' \
  -d "{\"password\":\"$(grep '^FEOH_ADMIN_PASSWORD=' deploy/.env | cut -d= -f2-)\"}" \
  | sed -E 's/.*"token":"([^"]+)".*/\1/')

curl -fsS -X POST http://localhost:4001/api/v1/auth/keys \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"heorth-service"}'
```

Expected: a JSON body containing a raw key starting with `fe_`.

- [ ] **Step 4: Put the real key in `.env` and restart Heorth without the placeholder**

Write the `fe_...` value into `deploy/.env` as `FEOH_API_KEY`, then:

```bash
docker compose -f deploy/compose.dev.yml --env-file deploy/.env up -d heorth
sleep 30
docker compose -f deploy/compose.dev.yml --env-file deploy/.env ps heorth
```

Expected: `running (healthy)`, with **no** `FEOH_API_KEY=placeholder` prefix needed — proving the documented procedure is complete and self-sufficient.

- [ ] **Step 5: Confirm no secret is staged**

```bash
git status --porcelain
git add deploy/README.md
git diff --cached --name-only
```

Expected: `deploy/.env` appears in **neither** listing. If it does, stop and fix `.gitignore` before committing.

- [ ] **Step 6: Commit**

```bash
git commit -m "Document household stack bring-up, backups, and gotchas

Covers the two-phase first bring-up that Compose cannot express: Heorth
requires FEOH_API_KEY at startup and the key can only be minted from a
running Feoh."
```

---

## Self-Review

**Spec coverage.** `deploy/` layout → Task 1 (+ files added in 2-5). Rule carve-out in `CLAUDE.md` → Task 1 Step 1. Two strictly separated files → Tasks 1-3 (dev), 4 (prod), cross-checked in Task 4 Steps 4-5. One shared Postgres, three owned databases → Task 1. Postgres 18 volume path → Task 1 Steps 9-10, both compose files, README gotchas. Test databases in dev only → Task 1 Step 8, Task 4 Step 4. Namespaced env with distinct JWT secrets → Tasks 2 and 4, `.env.example`. M365 all-or-nothing → `.env.example`, both compose files, README. Two-phase `FEOH_API_KEY` bootstrap → Task 2 Step 3 (guard), Task 5 (procedure, executed in Steps 2-4). Backup sidecar with retention and a tested restore path → Task 3. No proxy, no `website-v0`, no `wyrhta-core` → nothing creates them. Prerequisites 1 and 3 from the spec (image publishing, KithLedger volume path) are excluded at the user's direction — being handled in the service repos.

**Placeholder scan.** No TBD/TODO. Every code step carries literal file content; every test step carries a runnable command and an explicit expected result.

**Type consistency.** Service names (`db`, `feoh`, `kithledger`, `heorth`, `db-backup`), volume names (`db_data`, `db_backups`), role and database names, and every env var are identical across `.env.example`, both compose files, `initdb/10-databases.sh`, `backup.sh`, and the README. `BACKUP_ONCE`, `BACKUP_INTERVAL_SECONDS`, and `BACKUP_RETENTION_DAYS` are defined in `backup.sh` and consumed identically in both compose files.

One known rough edge, deliberately kept: Tasks 2-4 prefix commands with `FEOH_API_KEY=placeholder` purely to satisfy compose's `:?` interpolation guard so the file parses. Task 5 Step 4 removes it and proves the real procedure stands on its own.
