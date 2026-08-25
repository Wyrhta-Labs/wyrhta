---
name: wyrhta-dev-env
description: Start, restart, inspect, or troubleshoot the Wyrhta Labs local development environment from the meta repo. Use when asked to bring up the dev stack, run the local dev env, start Heorth/KithLedger/heorth-mcp together, choose between compose.dev.yml and the demo or per-service compose files, verify dev health, or explain the local dev ports and databases.
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

## Ports

```text
Heorth        http://localhost:14000
KithLedger    http://localhost:14002
heorth-mcp    http://localhost:14003
Postgres      localhost:15432
```

The services listen on `3000` or `3200` inside containers, but the host ports
above are what users and local tools hit.

## Start

Require `deploy/.env`. If it is missing, tell the user to create it from
`deploy/.env.example` and fill the placeholders; do not invent secrets.

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
```

Prefer HTTP probes for final readiness, because they verify published host ports:

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:14000/health
Invoke-WebRequest -UseBasicParsing http://localhost:14002/health
Invoke-WebRequest -UseBasicParsing http://localhost:14003/health
```

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

## User-Facing Output

When the dev environment is up, report the URLs and whether each health check
passed. If a port conflict prevents startup, name the conflicting port and the
stack that normally owns it: demo uses `24000/24002/24003`, dev uses
`14000/14002/14003`, and per-service stacks can collide with dev.
