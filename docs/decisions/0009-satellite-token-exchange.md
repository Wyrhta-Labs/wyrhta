# 0009 — Satellite token exchange: how member identity reaches a satellite

**Status:** accepted 2026-08-18 · **Depends on:** [ADR 0002](0002-cross-service-identity-a-then-b.md)
Phase B, [ADR 0004](0004-per-member-access-control-in-the-knowledge-graph.md),
[ADR 0008](0008-mcp-as-a-standalone-container-over-rest.md) ·
**Tracking:** `Wyrhta-Labs/wyrhta-labs` issue #1 (task B3)

## Context

ADR 0008 moved MCP into its own container, and ADR 0004 (now shipping in full)
requires that every member-scoped read of KithLedger data carries a **member
principal**. Between those two decisions sits a hop no ADR describes.

An MCP client authenticates to heorth-mcp with a **`he_` API key** — that is the
only credential it has. KithLedger will require a **member JWT**. heorth-mcp
holds no signing key and must not: it is a stateless translator, deliberately the
least-trusted component in the household, and a container that could mint member
identities would be a far more attractive target than one that cannot.

So something must turn "the bearer of this `he_` key is member X" into a token
KithLedger will accept. Only Heorth can do that — it is the sole authority on who
the household's members are.

Three alternatives were considered and rejected:

- **KithLedger accepts `he_` keys directly.** It would have to call Heorth to
  validate every key, making each tool call two round trips, and would hold a
  Heorth credential to do so. It also puts Heorth's key namespace inside a
  satellite's trust boundary.
- **Pass the member's web JWT through.** The MCP caller has an API key, not a
  JWT. And Heorth's web token is audience-less with a 7-day TTL — far too broad
  a credential to hand to a satellite.
- **heorth-mcp holds a signing key.** Rejected above: it makes the translator
  mintable.

## Decision

Heorth exposes a **token-exchange endpoint**. A caller presenting a credential
Heorth already accepts receives a short-lived, audience-bound member token for
one named satellite.

- **Endpoint:** `POST /api/v1/auth/satellite-token`, authenticated by
  `requireAuth` (an `he_` key or a member JWT both work).
- **Request:** the target audience, e.g. `{ "audience": "kithledger" }`. Only
  audiences Heorth knows are accepted; anything else is refused rather than
  minted optimistically.
- **Response:** a JWT with claims `sub` (the member id), `role`, `iss: heorth`,
  `aud: <satellite>`, `iat`, `exp` — plus `expires_in`, so callers need not parse
  the token to schedule renewal.
- **Signed with Heorth's satellite private key** (RS256/EdDSA), published via
  JWKS and verified by the satellite. Distinct from Heorth's own `JWT_SECRET`,
  which stays internal — it also derives the M365 refresh-token encryption key
  and never leaves the service.
- **TTL: 5 minutes.** Exchange is one cheap local call and the result is cached,
  so a short life costs little. A leaked satellite token expires before it is
  useful, and no revocation list is needed.
- **Caching:** heorth-mcp may hold exchanged tokens **in memory only**, keyed by
  the hash of the presenting credential plus the audience, evicted at
  `exp - 30s`. Never written to disk, never logged, never shared between callers.
  A cache keyed by anything coarser than the individual caller would let one
  member act as another and is forbidden.
- **The exchanged token grants no more than its bearer already had.** The
  member's role travels with it; a satellite must not treat the token as
  privileged merely because Heorth issued it.

The two service-principal cases from ADR 0004 §2 do **not** use this endpoint:
the always-on dashboard uses its own household-scoped key, and the admin/ops key
is provisioning-only with no data access. Exchange is for member context alone.

## Consequences

- Member identity reaches satellites without any component but Heorth being able
  to assert it. heorth-mcp stays unmintable; a full compromise of it yields only
  the tokens of members who called it during the cache window.
- ADR 0004's "every member-scoped call carries member context" becomes
  implementable for MCP callers — currently there is no path at all.
- **Cost:** one extra call per cache miss, and Heorth becomes a runtime
  dependency of `kith.*` tools — if Heorth is down, they fail even when
  KithLedger is healthy. Acceptable: Heorth is the identity authority, and a
  household with Heorth down has larger problems.
- **Cost:** a new public endpoint on Heorth that mints credentials. It is
  rate-limited like `POST /auth/token`, and audience-validated, but it is
  security-sensitive surface and should be treated as such in review.
- Adding a satellite means registering its audience in Heorth — deliberate
  friction, so tokens cannot be minted for services nobody decided to trust.

## Open questions

1. **Does an `he_` key holder always deserve a member token?** API keys are
   issued per member and carry that member's role, so today the answer is yes.
   If Heorth ever issues scoped or service-level `he_` keys, exchange must
   respect that scope rather than silently granting full member identity.
2. **Should exchange be logged as an auth event?** It is a credential-minting
   operation; the argument for auditing it is strong, but at 5-minute TTLs with
   a warm cache it is chatty. Sample, or log only cache misses.
3. **Clock skew** between Heorth and satellites at a 5-minute TTL. A small
   `leeway` on verification is probably needed; core's `verifyToken` has none.
