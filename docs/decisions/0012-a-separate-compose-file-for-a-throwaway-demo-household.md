# 0012 — A separate Compose file for a throwaway demo household

**Status:** accepted 2026-08-21

## Context

The stack had two Compose files, `compose.dev.yml` and `compose.prod.yml`, and
no way to stand up a household you could show someone or poke at without
consequence. That gap matters more since every repo went public (ADR 0011): the
first thing a stranger wants is a running system with something in it, and the
first thing *we* want for a demo is a household whose data nobody minds losing.

The obvious move — bring up `compose.dev.yml` and seed it — is wrong on two
counts, and both were observed rather than theorised:

- **It writes into `heorth_dev` / `kithledger_dev`.** Those hold real
  development data on the shared `wyrhta-dev_db_data` volume. A demo seed
  landing there is indistinguishable from hand-made dev data afterwards, and
  the reseed step (`--fresh`) would destroy the volume both share. The
  `*_dev` naming exists precisely because dev data has already been wiped
  once by a stray test run (`docs/manual-todo.md`).
- **It cannot start next to what is already running.** The original
  `compose.dev.yml` published 5432, and on the authoring host that port belonged
  to an unrelated project's Postgres. The per-repo stacks collide the same way on
  the low service ports —
  the "cannot run at the same time" gotcha in `deploy/README.md`. A demo you
  must shut other things down to see is a demo nobody runs.

A profile or an override layered onto `compose.dev.yml` was considered and
rejected. It contradicts the standing rule that these files stay readable end
to end without resolving conditionals, and it would put the demo's isolation —
the whole point — behind a flag that can be forgotten.

## Decision

**A third, independent Compose file, `compose.demo.yml`, defining a fully
isolated throwaway household, driven by one script.**

1. **Isolated by construction, not by discipline.** Own project name
   (`wyrhta-demo`), own volume (`wyrhta-demo_db_data`), and every published port
   shifted. As of 2026-08-25 the demo uses the safe high range
   **24000 / 24002 / 24003 / 25432**; dev uses
   **14000 / 14002 / 14003 / 15432**. The `*001` slot remains reserved for the
   retired Feoh satellite, keeping the allocation readable. It runs alongside
   the dev stack, the per-repo stacks, and any unrelated Postgres on 5432. It is
   the one stack here without the simultaneity gotcha. It uses the *primary*
   database names
   (`heorth`, `kithledger`) inside its own cluster, which is safe precisely
   because the cluster is separate and off the default port.
2. **It cannot reach an external system.** The six `M365_*` vars are **pinned
   blank in the Compose file**, not merely left unset in an env file. Blanking
   them there means no `.env` a future maintainer writes can switch a demo onto
   a real tenant or mailbox by accident. The KithLedger reminders feed points
   only at the sibling demo container, with a throwaway household key minted by
   `demo-up.sh` after KithLedger is healthy and before Heorth starts. The
   satellite signing key is generated per demo and shared with nothing.
3. **Generated secrets, never committed ones.** `deploy/demo-up.sh` writes
   `deploy/.env.demo` with fresh random values on first run. It is git-ignored
   by the existing `/deploy/.env*` rule; delete it and re-run to rotate. A
   committed demo `.env` was rejected — a file of real-looking secrets in a
   public repo teaches the wrong habit even when the values are worthless.
4. **The sample data is seeded through the public REST APIs.** `seed-demo.mjs`
   has no SQL fixture and no privileged back door, so seeding exercises the same
   validation and authorisation a client would, and the demo cannot depend on a
   state the API could not produce. It is idempotent: every create is guarded by
   a lookup on a natural key, so re-running repairs rather than duplicates.
   Dates are anchored to the current week, so a demo never looks abandoned.
5. **No `db-backup` service.** The data is generated and meant to be discarded;
   backing it up would imply it is worth keeping.

## Consequences

- **There are now three Compose files to keep honest.** A change to a service's
  environment contract may need making in three places. That is the accepted
  cost of the no-conditionals rule, and it is the same trade 0008-era `dev`/`prod`
  duplication already made — the demo file is not a new kind of debt.
- **A demo is not a deployment rehearsal.** It builds from sibling checkouts and
  runs with M365 disabled and KithLedger wired only to the sibling demo service,
  so it exercises neither the pinned-image path nor any external integration.
  `compose.prod.yml` remains the only thing that resembles the household server.
- **`seed-demo.mjs` is a loaded gun pointed by a URL.** It writes household data
  as real members and nothing in it distinguishes a demo Heorth from a real one
  but the base URL it is given. That warning lives at the top of the file and in
  `deploy/README.md`; it is inherent to seeding over the public API rather than
  through a fixture, which is otherwise the property that makes it valuable.
- **Seeding over the real API surface found a real bug**, which is the clearest
  argument for having done it that way. The seed wrote an RRULE into
  `events.recurrence`, which is an ISO 8601 duration; the write was accepted and
  every subsequent ranged calendar read returned 500 for the whole household.
  Fixed in Heorth (`fix(calendar): reject an unusable recurrence instead of
  500ing the range view`) at both the schema and the expander. A SQL fixture
  would have reproduced the same bad row silently and taught us nothing.
- **The demo is a place to notice this class of problem early.** It is the only
  configuration that exercises every service together, from empty database to
  populated household, in one command — closer to a first-run experience than
  any test suite gets.
