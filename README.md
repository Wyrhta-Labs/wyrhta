# Wyrhta

**Wyrhta** is the ecosystem around **[Heorth](https://github.com/Wyrhta-Labs/Heorth)** —
an interconnected, self-hosted household manager. Heorth is the hub: the household
system a family actually opens. Everything else in Wyrhta exists to serve it — a
shared foundation library, satellite services it consumes, one MCP server that fronts
them all, and the site that explains them.

This is the **meta repo** (`Wyrhta-Labs/wyrhta`, renamed from `wyrhta-labs`). It holds
no application code. It holds the cross-cutting concept, the architecture decision
records, and the Docker Compose stack — because it is the only place that knows every
service exists.

- **Concept & architecture:** [`docs/`](docs/) — start at [`docs/README.md`](docs/README.md)
- **Strategy & roadmap:** [`docs/strategy.md`](docs/strategy.md) (source of truth)
- **Decisions:** [`docs/decisions/`](docs/decisions/)
- **Glossary:** [`CONTEXT.md`](CONTEXT.md)
- **The stack:** [`deploy/`](deploy/)
- **Local dev/demo environments:** [`docs/local-environments.md`](docs/local-environments.md)

> **Naming.** *Wyrhta* (OE *wyrhta*, "maker, wright") is the ecosystem and this repo.
> *Wyrhta-Labs* is only the GitHub organisation that hosts it, and `ghcr.io/wyrhta-labs`
> the image namespace. *Heorth* (OE "hearth") is the product at the centre.

## The ecosystem

Heorth sits in the middle. Each of the others is its **own** GitHub repo — not a
submodule, not a monorepo package. They share the `@wyrhta/core` library as a
**published npm package** ([ADR 0011](docs/decisions/0011-core-is-published-to-npm.md)),
so a change in core only reaches a consumer when a release is cut and the consumer's
`package.json` range allows it — pre-1.0 that means a deliberate bump for anything
beyond a patch.

| Folder | Repo | Role in the ecosystem |
|---|---|---|
| `Heorth/` | [`Wyrhta-Labs/Heorth`](https://github.com/Wyrhta-Labs/Heorth) | **The hub.** The flagship household system (calendar, meals, finance, library, inventory) — one deployment per household |
| `wyrhta-core/` | [`Wyrhta-Labs/wyrhta-core`](https://github.com/Wyrhta-Labs/wyrhta-core) | The shared foundation `@wyrhta/core`: identity, auth, HTTP kit, household, DB conventions |
| `KithLedger/` | [`Wyrhta-Labs/KithLedger`](https://github.com/Wyrhta-Labs/KithLedger) | A satellite: API-first personal relationship manager, consumed by Heorth over its REST API |
| `heorth-mcp/` | [`Wyrhta-Labs/heorth-mcp`](https://github.com/Wyrhta-Labs/heorth-mcp) | The household's single MCP server, a pure REST client of the services (ADR 0008) |
| `website/` | [`Wyrhta-Labs/website`](https://github.com/Wyrhta-Labs/website) | The public site |

Two rules shape the whole ecosystem, and both are ADRs rather than habits:
services expose **REST only** — MCP is a separate container that fronts them
([ADR 0008](docs/decisions/0008-mcp-as-a-standalone-container-over-rest.md)) — and
identity is **Heorth-issued**, satellites holding service keys until they grow real
UIs ([ADR 0002](docs/decisions/0002-cross-service-identity-a-then-b.md)).

Those five folders are **git-ignored here** — this repo tracks only its own docs,
`deploy/`, and the agent instructions. Cloning this repo alone gives you the
thinking layer; the section below gets you the code.

## Getting the whole workspace

The layout matters: `deploy/compose.dev.yml` builds from `../Heorth`,
`../KithLedger`, and `../heorth-mcp`, so the sibling folders must sit next to
`deploy/` and **keep their exact names** (`Heorth` and `KithLedger` are
capitalised).

```
wyrhta/                 <- this repo
├── deploy/
├── docs/
├── Heorth/             <- sibling checkouts
├── KithLedger/
├── heorth-mcp/
├── website/
└── wyrhta-core/
```

### 1. Clone this repo

```bash
gh repo clone Wyrhta-Labs/wyrhta
cd wyrhta
```

(Or `git clone https://github.com/Wyrhta-Labs/wyrhta.git` if you have no `gh`.)

### 2. Clone the services into it

```powershell
pwsh ./scripts/clone-all.ps1        # Windows
```

```bash
./scripts/clone-all.sh              # macOS / Linux / Git Bash
```

Both read [`repos.txt`](repos.txt), clone anything missing, and `git pull --ff-only`
anything already there — so the same command is both "set up" and "update
everything". Neither script ever touches a dirty working tree; it skips it and
says so. Flags:

| Flag | Effect |
|---|---|
| `--list` | Print what would happen and exit |
| `--no-update` | Clone what is missing, leave existing checkouts alone |
| `--https` | Use plain `git clone` over HTTPS instead of `gh repo clone` |

`repos.txt` is the single source of truth for the set — one `folder repo` pair per
line. Adding a service means adding a line, nothing else.

### 3. Install and run

Each service is independent and carries its own README with its own quick start.
To run the whole household stack at once instead, from a clean checkout and with
no configuration:

```bash
deploy/dev-up.sh       # bash, Git Bash or WSL
```

```powershell
.\deploy\dev-up.ps1    # PowerShell
```

Both wrap `deploy/dev-up.mjs`. It creates `deploy/.env` when absent, generates
the local dev secrets it can (never overwriting a value you filled), starts
everything, bootstraps Firefly's operator account and API token so bank
ingestion works immediately, and prints the URLs. Values that reach a real
external system — `M365_*`, `KITH_API_KEY` — are left blank and reported as
blank.

By hand, if you prefer:

```bash
cp deploy/.env.example deploy/.env
# fill in every value — both JWT secrets must differ
docker compose -f deploy/compose.dev.yml --env-file deploy/.env up -d --build
```

The throwaway seeded demo is `deploy/demo-up.sh`.

See [`deploy/README.md`](deploy/README.md) for ports, databases, backups, and the
production file. For the two local multi-service environments, see
[`docs/local-environments.md`](docs/local-environments.md): dev uses
`14000/14001/14002/14003/14004/15432`, and demo uses `24000/24002/24003/25432`.
`14001` and `14004` are Firefly III and its Data Importer, the optional
bank-ingestion sidecar (ADR 0016), which the demo deliberately does not run.

## Agent skills

This repo carries repo-local skills for common Wyrhta operations. The canonical
copies live in [`.agents/skills/`](.agents/skills/); agent-specific directories
only contain discovery stubs that point back there, so the instructions do not
drift between tools.

| Skill | Use |
|---|---|
| [`wyrhta-dev-env`](.agents/skills/wyrhta-dev-env/SKILL.md) | Bootstrap, start, inspect, stop, and troubleshoot the local dev stack (`deploy/dev-up.sh`, `deploy/compose.dev.yml`) on ports 14000–14004 |
| [`wyrhta-demo`](.agents/skills/wyrhta-demo/SKILL.md) | Start, reseed, reset, and verify the throwaway seeded demo (`deploy/compose.demo.yml`) on ports 24000/24002/24003 |

Runtime discovery stubs are tracked under [`.codex/skills/`](.codex/skills/),
[`.claude/skills/`](.claude/skills/), and [`.opencode/skills/`](.opencode/skills/).
When changing a skill, edit the canonical `.agents/skills/<name>/SKILL.md` file
first; update only stub frontmatter when the trigger text needs to change.

### Why not submodules?

A submodule pins a specific commit of each service in this repo's tree, which is
exactly the coupling the architecture avoids: these are independent repos that
release on their own cadence and integrate through published tags and images, not
through a superproject's index. The manifest keeps the convenience of one command
without inventing a lockstep that nothing else in the system honours. The cost is
that `clone-all` gives you each service's default branch, not a combination this
repo vouches for — if you need a reproducible set, use `deploy/compose.prod.yml`,
which pins real image tags.

## Licence

MIT — see [`LICENSE`](LICENSE). The four code repos (`wyrhta-core`, `Heorth`,
`KithLedger`, `heorth-mcp`) carry the same licence, so a self-hoster may run,
modify, and redistribute the whole stack.

The `website` repo is the exception and carries **no** licence: it holds
generative imagery that is not the maintainer's to sublicense. It is published
to be read, not forked.

## Contributing and security

[`CONTRIBUTING.md`](CONTRIBUTING.md) explains how this project is run (one
maintainer, pre-1.0, ADR-governed) and what kinds of contribution are most
useful. Security problems go through GitHub's private vulnerability reporting,
never a public issue — see [`SECURITY.md`](SECURITY.md).
