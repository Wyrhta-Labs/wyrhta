# Architecture Decision Records

Cross-cutting decisions that affect more than one Wyrhta Labs service.

## Decisions

- [0001 — External systems of record behind provider abstractions](0001-external-systems-of-record-behind-providers.md)
- [0002 — Cross-service identity: service keys now, Heorth-issued SSO later](0002-cross-service-identity-a-then-b.md)
- [0003 — External reference feeds behind providers](0003-external-reference-feeds-behind-providers.md)
- [0004 — Per-member access control in the KithLedger knowledge graph](0004-per-member-access-control-in-the-knowledge-graph.md)
- [0005 — Semantic retrieval with pgvector (KithLedger first)](0005-semantic-retrieval-with-pgvector.md)
- [0006 — No server-side generative inference; conservative base database](0006-no-server-side-generative-inference-and-a-conservative-base-db.md)
- [0007 — Feoh returns to Heorth as a built-in optional module](0007-feoh-returns-to-heorth-as-built-in-module.md)
- [0008 — MCP as a standalone container over REST](0008-mcp-as-a-standalone-container-over-rest.md)
- [0009 — Satellite token exchange: how member identity reaches a satellite](0009-satellite-token-exchange.md)
- [0010 — `@wyrhta/core` stays a git dependency that builds on install](0010-core-stays-a-git-dependency-that-builds-on-install.md)

## Format

One file per decision: `NNNN-short-title.md` (e.g. `0001-shared-household-identity.md`).

Each ADR captures:

- **Context** — what forced the decision.
- **Decision** — what we chose.
- **Consequences** — what this makes easy, and what it costs.
- **Status** — proposed / accepted / superseded.
