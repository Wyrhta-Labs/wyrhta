# 0002 — Cross-service identity: service keys now, Heorth-issued SSO later

**Status:** accepted (2026-07-23)

## Context

With Feoh graduating to an independent service (see roadmap) alongside KithLedger,
a literal reading of today's setup — each service embedding `@wyrhta/core` identity
with its own users table — would give every household member three accounts and
three passwords. Unacceptable for household software. An external IdP (Keycloak
etc.) was rejected: core's identity module *is* the stack's identity story, and a
heavyweight third-party dependency at the center contradicts it.

## Decision

Phased, one path:

- **Phase A (from the Feoh extraction onward):** satellites (Feoh, KithLedger)
  hold no human member accounts — only an admin user and API keys. Heorth is the
  single human-facing surface; its backend calls satellites with service API keys.
  Household members exist exactly once, in Heorth.
- **Phase B (when a satellite grows a real UI of its own):** satellites additionally
  accept **Heorth-issued member JWTs**. First implementation: shared `JWT_SECRET`
  across services (core's HS256 `verifyToken` as-is, plus an issuer convention);
  upgrade path to asymmetric keys if/when needed. Heorth becomes the household's
  identity provider; one login everywhere.

## Consequences

- The acceptance release and the extraction stay simple: no SSO machinery on the
  critical path.
- Satellites' MCP servers keep their existing API-key auth unchanged.
- Core eventually gains a small "issuer" convention, not a new auth subsystem.
- Until Phase B, satellites must not build member-facing UI that requires login —
  a deliberate constraint, not an oversight.
