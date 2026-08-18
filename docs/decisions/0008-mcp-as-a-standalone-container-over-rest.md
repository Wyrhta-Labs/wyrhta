# 0008 — MCP as a standalone container over REST

**Status:** accepted 2026-08-18 · **Amended 2026-08-18** (same day, before any
implementation): the `kith.*` service-key arrangement below is superseded — see
"Amendment" at the end. · **Amends:** the "every service ships its own
MCP surface" convention assumed by ADR 0002, `strategy.md` (hub-and-satellites,
Phase 4's stdio→HTTP prerequisite), and `wyrhta-core`'s MCP scaffold.

## Context

MCP has so far been a property of each service: Heorth compiles 37 tools into
its process behind a Streamable HTTP endpoint, KithLedger compiles 13 behind a
**stdio** server that resolves one `kl_` key from the environment, and
`@wyrhta/core` ships the scaffold both depend on. Feoh had a fourth surface
before it merged back (ADR 0007).

That arrangement charges in three places. Clients see **two endpoints with two
transports**, one of which cannot be deployed at all — hence the Phase 4
prerequisite "KithLedger's MCP moves from stdio to HTTP" sitting in front of
unrelated work. The MCP SDK and its version churn ride inside two production
services. And because tool handlers call domain code directly, the tool surface
can quietly diverge from the REST API: a tool can do things no HTTP client can,
which is exactly the surface that is hardest to reason about for a system whose
whole premise is a household's private data.

The services already expose complete REST APIs. Every tool but one maps onto an
endpoint that exists today.

## Decision

**MCP moves out of the services into its own container: `heorth-mcp`**
(`Wyrhta-Labs/heorth-mcp`, private). It owns no data and no domain logic; every
tool call is translated into calls against an upstream service's **public REST
API**.

- **One container, both upstreams.** The Heorth tools (`household.*`,
  `calendar.*`, `meals.*`, `library.*`, `inventory.*`, `tasks.*`, `feoh.*`) and
  the KithLedger tools (`kith.*`) are served from one endpoint. Each upstream is
  optional and ENV-configured (`HEORTH_BASE_URL`, `KITH_BASE_URL`); with neither
  set, the container still starts.
- **Streamable HTTP only.** No stdio, not even for local dev.
- **Auth is pass-through for Heorth**: the caller's `Bearer he_...` is forwarded
  verbatim, so per-member permissions and Heorth's audit trail stay intact and
  heorth-mcp holds no Heorth credential. **KithLedger keeps a `kl_` service
  key** (ADR 0002 Phase A), as Heorth already does for the reminders feed.
- **The MCP scaffold leaves `@wyrhta/core`.** `createMcpServer`, `McpTool`,
  `AuthAdapter`, `McpPrincipal` move into heorth-mcp; core cuts a new tag
  without `@wyrhta/core/mcp` and both consumers bump.
- **Nothing is deleted upstream until its replacement is verified** against the
  deployed container. The migration order and preconditions live in
  `heorth-mcp/docs/spec/migration.md`; the frozen tool contract in
  `heorth-mcp/docs/spec/tool-surface.md`.

**The rule this establishes:** a new service does **not** ship an MCP surface.
It ships a REST API, and heorth-mcp gains tools that call it.

## Consequences

- One MCP endpoint for the household, one transport, one place to version tools.
- The tool surface is bounded by the REST API by construction — a tool that
  needs a new capability forces a new REST endpoint upstream, where it is
  visible and testable, rather than a private path through domain code.
- Phase 4's "KithLedger MCP stdio → HTTP" prerequisite is **dropped**: the
  transport move happens by the `kith.*` tools landing in heorth-mcp.
- Heorth's `HeorthModule.register(app, mcp)` contract loses its `mcp` parameter —
  a wide but mechanical change touching every module.
- **Cost:** one more container, one more network hop per tool call, and tool
  changes that need new data become two-repo changes.
- **Known asymmetry:** `kith.*` tools act as a single service principal, so they
  cannot express KithLedger's per-member access control (ADR 0004). This
  resolves with ADR 0002 Phase B (Heorth-issued SSO); until then, whether the
  `kith.*` write tools ship is an open question recorded in the spec.

## Amendment (2026-08-18) — per-member access ships now

The "known asymmetry" recorded above is **not deferred**. `kith.*` tools will not
ship on a `kl_` service key; per-member access control (ADR 0004, in full) and
the member-JWT path it needs (ADR 0002 Phase B) are being built first, and the
`kith.*` tools land afterwards carrying member context.

Three findings from scoping this change amend the decision:

- **KithLedger has no member concept at all** — no ownership or visibility column
  on any domain table, exactly one user by construction with no route to create a
  second, and `principal` read in zero places outside `@wyrhta/core`. ADR 0004
  assumed Phase B would supply a member id to filter against; there is nothing to
  filter against yet. Multi-member identity in KithLedger is a prerequisite the
  ADR does not name.
- **ADR 0002 Phase B's shared `JWT_SECRET` is rejected on security grounds.**
  Heorth's `JWT_SECRET` also derives the M365 refresh-token encryption key
  (`src/m365/crypto.ts`); sharing it with a satellite makes a satellite env
  compromise a Heorth M365 compromise. Satellite tokens get their own signing key.
  Its form — separate shared secret, or asymmetric keys plus JWKS — is open.
- **A token-exchange hop is missing from every ADR.** An MCP client presents an
  `he_` API key; KithLedger will require a member JWT; heorth-mcp holds no minting
  capability and must not. Heorth therefore needs an endpoint exchanging an `he_`
  key for a short-lived satellite JWT (`iss: heorth`, `aud: kithledger`). This
  needs its own ADR covering endpoint shape, TTL, audience binding, and whether
  the exchanged token may be cached.

Consequence for this decision's cost line: Programme B is larger than the MCP
migration it unblocks, and its nine-deep dependency chain — not the tool porting —
sets the timeline. The 37 Heorth tools are unaffected and proceed in parallel.

Tracking: `Wyrhta-Labs/wyrhta-labs` issue #1.
