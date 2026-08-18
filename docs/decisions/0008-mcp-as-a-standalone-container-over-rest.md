# 0008 — MCP as a standalone container over REST

**Status:** accepted 2026-08-18 · **Amends:** the "every service ships its own
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
