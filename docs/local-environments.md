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
| Reserved Feoh slot | `14001` | `24001` |
| KithLedger | `14002` | `24002` |
| heorth-mcp | `14003` | `24003` |
| Postgres | `15432` | `25432` |

The `*001` slot is reserved for the retired Feoh satellite so the allocation
stays readable if old notes or scripts mention it. Inside containers, services
still use normal ports: Heorth and KithLedger listen on `3000`, heorth-mcp on
`3200`, and Postgres on `5432`.

## Dev Stack

Use the dev stack when you are actively working across services. It builds from
the sibling checkouts and persists real local development data in the
`wyrhta-dev_db_data` Docker volume.

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
| KithLedger | `http://localhost:14002` |
| heorth-mcp | `http://localhost:14003` |
| Postgres | `localhost:15432` |

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
