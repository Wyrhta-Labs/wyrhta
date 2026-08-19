# Wyrhta Labs

The umbrella repo for **Wyrhta Labs** — an interconnected, self-hosted household
manager built from several independent services. This repo holds no application
code. It holds the cross-cutting concept, the architecture decision records, and
the Docker Compose stack that knows every service exists.

- **Concept & architecture:** [`docs/`](docs/) — start at [`docs/README.md`](docs/README.md)
- **Strategy & roadmap:** [`docs/strategy.md`](docs/strategy.md) (source of truth)
- **Decisions:** [`docs/decisions/`](docs/decisions/)
- **Glossary:** [`CONTEXT.md`](CONTEXT.md)
- **The stack:** [`deploy/`](deploy/)

## The repos

Each service is its **own** GitHub repo, not a submodule and not a monorepo
package. They share the `@wyrhta/core` library by **pinned git tag**, so a change
in core only reaches a consumer when a new tag is cut and the consumer's
`package.json` pin is deliberately bumped.

| Folder | Repo | What it is |
|---|---|---|
| `wyrhta-core/` | [`Wyrhta-Labs/wyrhta-core`](https://github.com/Wyrhta-Labs/wyrhta-core) | Shared foundation `@wyrhta/core`: identity, auth, HTTP kit, household, DB conventions |
| `Heorth/` | [`Wyrhta-Labs/Heorth`](https://github.com/Wyrhta-Labs/Heorth) | The flagship household system (calendar, meals, finance, library, inventory) |
| `KithLedger/` | [`Wyrhta-Labs/KithLedger`](https://github.com/Wyrhta-Labs/KithLedger) | API-first personal relationship manager |
| `heorth-mcp/` | [`Wyrhta-Labs/heorth-mcp`](https://github.com/Wyrhta-Labs/heorth-mcp) | The household's single MCP server, a pure REST client of the services (ADR 0008) |
| `website/` | [`Wyrhta-Labs/website`](https://github.com/Wyrhta-Labs/website) | The public site |

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
To run the whole household stack at once instead:

```bash
cp deploy/.env.example deploy/.env
# fill in every value — both JWT secrets must differ
docker compose -f deploy/compose.dev.yml --env-file deploy/.env up -d --build
```

See [`deploy/README.md`](deploy/README.md) for ports, databases, backups, and the
production file.

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
