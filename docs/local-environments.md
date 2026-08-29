# Local Environments

Wyrhta has two local multi-service environments in the meta repo. They are not
profiles of one Compose file and they are not interchangeable.

| Environment | File | Purpose |
|---|---|---|
| Dev | `deploy/compose.dev.yml` | Daily development across Heorth, KithLedger and heorth-mcp |
| Demo | `deploy/compose.demo.yml` | Throwaway seeded household for showing or exploring the system |

The port ranges are deliberately high and separated from common per-service
defaults:

| Service | Dev | Demo |
|---|---:|---:|
| Heorth | `14000` | `24000` |
| Firefly III | `14001` | — |
| KithLedger | `14002` | `24002` |
| heorth-mcp | `14003` | `24003` |
| Firefly Data Importer | `14004` | — |
| Postgres | `15432` | `25432` |

The `*001` slot used to be reserved for the retired Feoh satellite; Firefly III
now occupies it in dev (ADR 0016). Inside containers, services still use normal
ports: Heorth and KithLedger listen on `3000`, heorth-mcp on `3200`, the two
Firefly containers on `8080`, and Postgres on `5432`.

## Dev Stack

Use the dev stack when you are actively working across services. It builds from
the sibling checkouts and persists real local development data in the
`wyrhta-dev_db_data` Docker volume.

### From nothing, in one command

```powershell
.\deploy\dev-up.ps1          # PowerShell
```

```bash
deploy/dev-up.sh             # bash, Git Bash or WSL
deploy/dev-up.sh --no-build  # start without rebuilding the images
```

Both are three-line wrappers around `deploy/dev-up.mjs`; run
`node deploy/dev-up.mjs` directly if you prefer. There is one implementation,
so all three behave identically — unlike `demo-up.sh`, which is bash and needs
the PowerShell fallback documented below.

It creates `deploy/.env` from `.env.example` when absent and then fills **only
blank or missing values**: database passwords, both JWT secrets, both admin
passwords, the Ed25519 satellite signing key and Firefly's `APP_KEY`. A value
you have already filled is never overwritten, so running it against an existing
`.env` is safe. Then it builds, starts, makes sure Firefly's database exists,
bootstraps Firefly's operator account and API token, waits for health, and
prints the URLs. Bank ingestion is on when it finishes.

Anything that reaches a real external system is left blank and reported as
blank: the six `M365_*` vars and `KITH_API_KEY`. `FIREFLY_PAT` is not in that
group — Firefly is a container we own, so the script mints that token itself.
The script prints **where** the generated passwords are, never the passwords
themselves.

Note it does not delete anything. There is no `--fresh` here — the dev cluster
holds real local development data, which is exactly what the demo's `--fresh`
exists to throw away.

### By hand

```powershell
cp deploy/.env.example deploy/.env
# Fill deploy/.env. Do not commit it.
docker compose -f deploy/compose.dev.yml --env-file deploy/.env up -d --build
```

Health checks:

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:14000/health
Invoke-WebRequest -UseBasicParsing http://localhost:14002/health
Invoke-WebRequest -UseBasicParsing http://localhost:14003/health
```

URLs:

| Surface | URL |
|---|---|
| Heorth | `http://localhost:14000` |
| Firefly III | `http://localhost:14001` |
| KithLedger | `http://localhost:14002` |
| heorth-mcp | `http://localhost:14003` |
| Firefly Data Importer | `http://localhost:14004` |
| Postgres | `localhost:15432` |

### The bank-ingestion sidecar

Firefly III and its Data Importer run in the dev stack as an **optional**
sidecar whose only job is talking to banks (ADR 0016). Feoh, inside Heorth,
stays the system of record for every financial fact the household sees; Firefly
is a one-way inbound feed that Heorth polls. Firefly's web UI is an operator
tool for connecting banks and is never a household surface.

Nothing depends on either container. `heorth` has no `depends_on` for Firefly on
purpose: Firefly being down pauses the import and nothing else, so the dev stack
is fully usable with both containers stopped.

**You do not have to set this up by hand.** Firefly mints personal access
tokens through its web UI only — no artisan command, no API — so `dev-up.mjs`
drives that UI for you: it creates the Passport personal-access client,
registers the `FIREFLY_OPERATOR_EMAIL` account (or logs in if it already
exists), mints a token, verifies it against `/api/v1/about`, writes it to
`deploy/.env` as `FIREFLY_PAT`, flips `FEOH_IMPORT_ENABLED` to `true`, and
recreates `heorth` and `firefly-importer`. One command, working ingestion.

The operator account is not a household member. It exists to connect banks, and
its password lives in `deploy/.env` — which is precisely why this is a dev-only
shortcut. On the household server the account and its token are created by a
person, once; `compose.prod.yml` has no bootstrap.

If Firefly ever changes its forms, the bring-up still succeeds and ingestion
just stays off, with instructions printed. The manual route is unchanged:
`http://localhost:14001` → Profile → OAuth → Personal Access Tokens → paste into
`deploy/.env` → re-run.

Firefly gets its own role and database, `firefly` / `firefly_dev`, in the shared
dev cluster. `initdb/10-databases.sh` creates them on an empty volume; on a
cluster that already exists — which is every cluster created before this — the
directory is skipped entirely, so `dev-up.mjs` creates them instead. That is the
manual third-service step `deploy/README.md` documents, just automated.

The demo stack runs **neither** container. A demo reaches no external system
(ADR 0012), so `seed-demo.mjs` fills the import inbox and rules directly, and
`compose.demo.yml` pins `FEOH_IMPORT_ENABLED: "false"` literally rather than
leaving it unset — the same belt-and-braces the six `M365_*` vars get there.

The dev services use `heorth_dev` and `kithledger_dev`, not the primary database
names. Tests must use `_test` databases, for example:

```powershell
$env:DATABASE_URL='postgres://heorth:<password>@localhost:15432/heorth_test'
```

Stop without deleting data:

```powershell
docker compose -f deploy/compose.dev.yml --env-file deploy/.env down
```

Do not add `-v` unless you intentionally want to delete the local dev databases
and backup volume.

## Demo Stack

Use the demo stack when you want a safe household with sample data. It has its
own project name, its own Postgres volume, generated throwaway secrets, and no
real Microsoft 365 or KithLedger-reminders integration.

Preferred flow when `bash` works:

```bash
deploy/demo-up.sh
deploy/demo-up.sh --reseed
deploy/demo-up.sh --fresh
```

Use `--fresh` for a clean demo. It deletes only the `wyrhta-demo` containers and
the demo volume.

On Windows, `bash` may resolve to WSL and fail with `E_ACCESSDENIED`. Use the
PowerShell fallback:

```powershell
docker compose -f deploy/compose.demo.yml --env-file deploy/.env.demo up -d --build

Invoke-WebRequest -UseBasicParsing http://localhost:24000/health
Invoke-WebRequest -UseBasicParsing http://localhost:24002/health
Invoke-WebRequest -UseBasicParsing http://localhost:24003/health

Get-Content deploy\.env.demo | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
    $name=$matches[1].Trim()
    $value=$matches[2]
    if ($value.Length -ge 2 -and $value[0] -eq '"' -and $value[$value.Length-1] -eq '"') {
      $value=$value.Substring(1,$value.Length-2)
    }
    Set-Item -Path "env:$name" -Value $value
  }
}
$env:HEORTH_URL='http://localhost:24000'
$env:KITH_URL='http://localhost:24002'
node deploy\seed-demo.mjs
```

URLs:

| Surface | URL |
|---|---|
| Heorth | `http://localhost:24000` |
| KithLedger | `http://localhost:24002` |
| heorth-mcp | `http://localhost:24003` |
| Postgres | `localhost:25432` |

Seeded member logins all use the password from `DEMO_MEMBER_PASSWORD`; by
default that is `demo-member-pw`:

```text
rowan@demo.invalid
mira@demo.invalid
wren@demo.invalid
tobin@demo.invalid
```

The Heorth admin is a maintenance account and intentionally shows empty
household content. Use one of the seeded members to inspect the demo household.

## Secrets And Tokens

`deploy/.env` and `deploy/.env.demo` are ignored. Do not commit them and do not
paste their contents into issues, logs, or chat.

`deploy/demo-up.sh` generates throwaway secrets in `deploy/.env.demo` and prints
human login values. The seed and verification commands obtain short-lived JWTs
only in process memory. They do not write bearer tokens to disk.

KithLedger `kl_` API keys are different: the raw key is shown only once when an
operator creates it, so the operator must store it in the relevant deployment
secret store. The demo stack does not require a persistent `kl_` key.

## LLM And Agent Rule

When an agent is asked to start, inspect, reset, reseed, or troubleshoot one of
these environments, use the repo-local skills first:

- `.agents/skills/wyrhta-dev-env/SKILL.md`
- `.agents/skills/wyrhta-demo/SKILL.md`

Those files are the operational source for agent runs. This document is the
human-facing explanation.
