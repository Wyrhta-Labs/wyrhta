---
name: wyrhta-demo
description: Run, reseed, reset, inspect, or troubleshoot the Wyrhta Labs throwaway demo household from the meta repo. Use when asked to start the demo, apply demo/sample data, fix an empty demo instance, print demo logins, verify seeded Heorth/KithLedger/heorth-mcp, or choose between the standalone service compose files and deploy/compose.demo.yml.
---

# Wyrhta Demo

Use this from the Wyrhta meta repo root, not from a service repo. The demo is the
isolated household stack in `deploy/compose.demo.yml`, seeded by
`deploy/seed-demo.mjs` through public REST APIs.

## Non-Negotiables

- Use `deploy/compose.demo.yml` for demo work. Do not use `Heorth/docker-compose.yml`
  or `KithLedger/docker-compose.yml` when the user asks for the demo household.
- The demo ports are shifted: Heorth `24000`, KithLedger `24002`, heorth-mcp
  `24003`, Postgres `25432`.
- `seed-demo.mjs` must only target the demo URLs: `HEORTH_URL=http://localhost:24000`
  and `KITH_URL=http://localhost:24002`.
- The Heorth admin is a maintenance account. It is intentionally quarantined and
  shows empty household content. Tell the user to log in as a seeded member.
- `deploy/.env.demo` is generated, git-ignored, and may contain throwaway secrets.
  Read only the login values needed for the task; do not paste JWTs or keys.

## Standard Flow

Prefer the wrapper when a POSIX shell is available:

```bash
deploy/demo-up.sh
deploy/demo-up.sh --reseed
deploy/demo-up.sh --fresh
```

Use `--fresh` when the user wants a clean demo or the current demo data is
confused. It destroys only the `wyrhta-demo` containers and volume.

On Windows, `bash` may resolve to WSL and fail with `E_ACCESSDENIED`. In that
case, run the equivalent PowerShell flow:

```powershell
docker compose -f deploy/compose.demo.yml --env-file deploy/.env.demo up -d --build
```

Then wait for these HTTP checks rather than relying only on Docker health:

```powershell
Invoke-WebRequest -UseBasicParsing http://localhost:24000/health
Invoke-WebRequest -UseBasicParsing http://localhost:24002/health
Invoke-WebRequest -UseBasicParsing http://localhost:24003/health
```

Seed through REST after the services are healthy:

```powershell
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

If `deploy/.env.demo` is missing and `bash` is unavailable, generate it by either
running `deploy/demo-up.sh` from a working shell or translating the env generation
block in that script exactly. Do not commit the generated file.

## Verification

After seeding, log in as `rowan@demo.invalid` with `DEMO_MEMBER_PASSWORD` and
check representative seeded surfaces:

```powershell
Get-Content deploy\.env.demo | ForEach-Object {
  if ($_ -match '^\s*([^#][^=]*)=(.*)$') {
    Set-Item -Path "env:$($matches[1].Trim())" -Value $matches[2].Trim('"')
  }
}
node -e "const base='http://localhost:24000';(async()=>{const token=(await (await fetch(base+'/api/v1/auth/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({email:'rowan@demo.invalid',password:process.env.DEMO_MEMBER_PASSWORD})})).json()).data.token;const get=async p=>(await (await fetch(base+p,{headers:{authorization:'Bearer '+token}})).json()).data;const events=await get('/api/v1/events');const places=await get('/api/v1/ethel/places');const assets=await get('/api/v1/ethel/assets?limit=100');const routines=await get('/api/v1/weorc/routines');console.log(JSON.stringify({events:events.length,places:places.length,assets:(assets.items??assets).length,routines:routines.length},null,2));})().catch(e=>{console.error(e);process.exit(1)})"
```

Expected current shape: 8 events, 10 places, 10 assets, 4 Weorc routines, plus
KithLedger people/reminders.

## User-Facing Output

Report the demo URL and member logins:

```text
Heorth:     http://localhost:24000
KithLedger: http://localhost:24002
heorth-mcp: http://localhost:24003

rowan@demo.invalid / demo-member-pw
mira@demo.invalid / demo-member-pw
wren@demo.invalid / demo-member-pw
tobin@demo.invalid / demo-member-pw
```

If a standalone service instance is also running on `14000`, say plainly that it
is not the seeded demo household. Stop it only when doing so is part of the
current task and it is clearly the per-repo Heorth stack.
