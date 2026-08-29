---
name: wyrhta-dev-env
description: Start, restart, inspect, or troubleshoot the Wyrhta Labs local development environment from the meta repo. Use when asked to bring up the dev stack, run the local dev env, start Heorth/KithLedger/heorth-mcp/Firefly together, bootstrap a fresh checkout with deploy/dev-up.sh, choose between compose.dev.yml and the demo or per-service compose files, verify dev health, set up the Firefly bank-ingestion sidecar, or explain the local dev ports and databases.
---

# Wyrhta Dev Env

Use this from the Wyrhta meta repo root. The local development environment is
`deploy/compose.dev.yml`; it builds the sibling service checkouts and runs them
against the shared dev Postgres cluster.

## Non-Negotiables

- Use `deploy/compose.dev.yml` for the cross-service dev environment.
- Do not use `deploy/compose.demo.yml` for dev work; that is the throwaway
  seeded demo on shifted ports.
- Do not use `Heorth/docker-compose.yml` or `KithLedger/docker-compose.yml` when
  the user asks for the Wyrhta dev environment; those are per-service stacks.
- Read the target service repo's `AGENTS.md` or `CLAUDE.md` before editing that
  service. Starting the compose stack from the meta repo does not transfer meta
  conventions into service code.
- Never point tests at dev databases. The dev stack uses `heorth_dev` and
  `kithledger_dev`; test suites need their own `_test` databases.
- `deploy/dev-up.sh` may generate the LOCAL DEV secrets in `deploy/.env`, and
  may bootstrap Firefly's operator account and API token; that is what it is
  for. Never invent a production secret, and never invent an external
  credential in any environment — `M365_*` and `KITH_API_KEY` are obtained, not
  generated. `FIREFLY_PAT` is the exception only because Firefly is a container
  we own, and only in dev.
- Never print the contents of `deploy/.env`. Report where a value lives, not
  what it is.

## Ports

```text
Heorth        http://localhost:14000
Firefly III   http://localhost:14001
KithLedger    http://localhost:14002
heorth-mcp    http://localhost:14003
Importer      http://localhost:14004
Postgres      localhost:15432
```

The services listen on `3000`, `3200` or `8080` inside containers, but the host
ports above are what users and local tools hit. `14001`/`14004` are the optional
Firefly bank-ingestion sidecar (ADR 0016); they exist in dev and prod only,
never in the demo stack.

## Start

Prefer the bootstrap script. It works from a clean checkout with no `deploy/.env`
at all, and is safe to re-run against a filled one — it fills only blank values
and never overwrites.

```powershell
.\deploy\dev-up.ps1
```

```bash
deploy/dev-up.sh
deploy/dev-up.sh --no-build
```

Both are thin wrappers around `deploy/dev-up.mjs`; `node deploy/dev-up.mjs` works
anywhere. Prefer them over hand-rolling the compose invocation, because the
script also creates Firefly's database on a cluster that predates it — `initdb`
runs only on an empty volume, so without that step Firefly restart-loops.

There is no `--fresh`. The dev cluster holds real local development data; do not
offer to delete it.

Raw compose, when the user explicitly wants it:

```powershell
docker compose -f deploy/compose.dev.yml --env-file deploy/.env up -d --build
```

For a smaller rebuild, name the services:

```powershell
docker compose -f deploy/compose.dev.yml --env-file deploy/.env up -d --build heorth
docker compose -f deploy/compose.dev.yml --env-file deploy/.env up -d --build kithledger heorth-mcp
```

## Inspect

```powershell
docker compose -f deploy/compose.dev.yml --env-file deploy/.env ps
docker compose -f deploy/compose.dev.yml --env-file deploy/.env logs --tail 80 heorth
docker compose -f deploy/compose.dev.yml --env-file deploy/.env logs --tail 80 kithledger
docker compose -f deploy/compose.dev.yml --env-file deploy/.env logs --tail 80 heorth-mcp
docker compose -f deploy/compose.dev.yml --env-file deploy/.env logs --tail 80 firefly
```

Prefer HTTP probes for final readiness, because they verify published host ports:

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:14000/health
Invoke-WebRequest -UseBasicParsing http://localhost:14002/health
Invoke-WebRequest -UseBasicParsing http://localhost:14003/health
```

Firefly is not part of readiness. Nothing depends on it, its first boot runs
migrations and takes minutes, and the stack is fully usable without it. Report
its container state; do not block on it.

## Bank Ingestion Sidecar

`firefly` and `firefly-importer` are optional (ADR 0016). Firefly's only job is
talking to banks; Feoh inside Heorth remains the system of record, and Firefly's
web UI is an operator tool for connecting banks, never a household surface.

**In dev this is already automated — do not walk the user through it by hand
unless the script failed.** Firefly mints personal access tokens through its web
UI only, so `dev-up.mjs` drives that UI: Passport personal-access client, then
register (or log in as) `FIREFLY_OPERATOR_EMAIL`, then mint and verify a token,
then write `FIREFLY_PAT` and `FEOH_IMPORT_ENABLED=true` and recreate `heorth`
and `firefly-importer`. After a successful `deploy/dev-up.sh`, ingestion is on.

The script reports one of these; repeat it rather than guessing:

```text
enabled (token minted this run)
enabled (token already in deploy/.env)
not bootstrapped (see the warning above)
```

Only on `not bootstrapped` is the manual route relevant:

1. open `http://localhost:14001`, log in as `FIREFLY_OPERATOR_EMAIL`
   (password in `deploy/.env`, `FIREFLY_OPERATOR_PASSWORD`)
2. Profile -> OAuth -> Personal Access Tokens -> Create new token
3. paste into `deploy/.env` as `FIREFLY_PAT` (shown once)
4. set `FEOH_IMPORT_ENABLED=true`, re-run `deploy/dev-up.sh`

**This bootstrap is dev-only.** It leaves an operator password in `deploy/.env`.
Never run it, port it, or suggest it for `compose.prod.yml`; on the household
server that account and its token are created by a person, once.

## Stop

Stop services without deleting data:

```powershell
docker compose -f deploy/compose.dev.yml --env-file deploy/.env down
```

Do not add `-v` unless the user explicitly wants to delete the dev databases and
backup volume.

## Heorth Web Iteration

The dev compose stack serves Heorth's built web bundle on `14000`. For frontend
iteration, keep the compose API on `14000` and run Vite from the Heorth repo:

```powershell
cd Heorth\web
npm run dev
```

Vite uses `5173` by default and proxies `/api` to `http://localhost:14000`.

For API iteration, either rebuild the `heorth` service or stop the compose
`heorth` container and run the Heorth API locally on port `14000` with its repo
`.env`. Keep the port aligned with the web proxy you are using.

## Common Confusions

- Empty demo data on `14000` is not a demo problem. The seeded demo lives on
  `24000`; dev lives on `14000`.
- Source edits do not automatically reach compose containers. Rebuild the
  affected service image, or run that service locally if you need hot reload.
- The Heorth maintenance admin can authenticate but is not a normal household
  member. Do not use it to judge household content visibility.
- `deploy/.env` is private deployment/dev state. Do not commit it or paste
  secrets into chat.
- A restart-looping `firefly` is almost always the missing `firefly_dev`
  database, not a bad image. `initdb` runs only on an empty volume; re-run
  `deploy/dev-up.sh`, which creates the role and database idempotently.
- Firefly answering "invalid host" means `FIREFLY_APP_URL` does not match the
  URL in the browser. A boot failure right after a config change is usually
  `FIREFLY_APP_KEY` not being exactly 32 characters.
- An empty import inbox in dev is expected until a bank is connected in
  Firefly; the token being present only means Heorth can poll. In the demo an
  empty inbox beyond the seed is expected always — no Firefly runs there.
- `could not bootstrap Firefly` after a Firefly version bump usually means the
  registration or login form changed. The bring-up is still fine; mint the
  token by hand and open an issue to re-check `fireflyBootstrap()`.

## User-Facing Output

When the dev environment is up, report the URLs and whether each health check
passed. If a port conflict prevents startup, name the conflicting port and the
stack that normally owns it: demo uses `24000/24002/24003`, dev uses
`14000/14001/14002/14003/14004`, and per-service stacks can collide with dev.

Report Firefly separately from the three required services, and say plainly
whether bank ingestion is enabled — if `FIREFLY_PAT` is blank, the sidecar is
running but idle, and that is the normal state for a fresh checkout.
