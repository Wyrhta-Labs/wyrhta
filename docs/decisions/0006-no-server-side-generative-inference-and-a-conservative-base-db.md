# 0006 — No server-side generative inference; conservative base database

**Status:** proposed (2026-07-27)

## Context

Every module in the roadmap has an obvious "make it smart" version. Summarise a
member's recent interactions. Turn a synced M365 email into a KithLedger interaction
automatically. Categorise a Feoh transaction from its description. Parse a recipe out of
a web page. Answer "who have I not seen lately" from natural language instead of a
filter. Each is individually attractive and each would quietly make a **generative
model a hard runtime dependency of a self-hosted household system**.

That dependency is not like the others. It brings GPU or heavy-CPU requirements into a
homelab, nondeterministic output into a system of record, a prompt-injection surface
onto data arriving from external providers (ADR 0001), a per-token cost or a large local
model to operate, and a support burden where "it gave a wrong answer" has no stack trace.
None of that is visible at the moment the feature is proposed; all of it lands on the
household later.

Separately, the database is now shared. `manual-todo.md` records the decision of
**2026-07-25: one Postgres container** serving multiple databases (`heorth`, `feoh`, and
`kithledger` to follow), each with its own role and connection string. That makes any
exotic extension a *cluster-wide* commitment: adopting pgvector for one satellite means
running the whole household's data on a non-official image
([ADR 0005](0005-semantic-retrieval-with-pgvector.md)). The blast radius is everyone's
data; the beneficiary is one nice-to-have.

The two concerns are independent — one is about models, one is about the database — and
are decided separately below.

## Decision

Two rules, both **mechanical** on purpose. Neither requires a judgment call at the point
of use, which is what makes them survive contact with an attractive feature.

### 1. No server-side generative inference in the base product

The base product must run with **no generative model as a runtime dependency**.

**Forbidden in the base product:**

- Summarisation of notes, interactions, or any household content.
- Automatic extraction — most concretely, turning synced M365 mail or calendar text into
  KithLedger interactions or Heorth tasks. This is the likeliest temptation and is
  explicitly named so it cannot arrive unnoticed.
- Natural-language → query translation.
- Model-written suggestions, categorisations, or labels persisted into a system of record.

**Permitted:**

- **Deterministic encoders** (embedding models) as ordinary dependencies. An encoder is
  not a generative model: no prompt, no generation, deterministic output, CPU-viable, and
  its result is a number rather than a claim. It is closer to an image resizer than to an
  assistant. Subject to rule 2 for any database support it needs.
- **Unlimited LLM value via MCP, where the model is the client.** KithLedger and Heorth
  already expose MCP servers; Claude sits *outside* the house and asks. Every capability
  in the forbidden list above is available this way — the member gets summarisation and
  extraction, and the server keeps no model dependency.

The doctrine in one line: **intelligence is a client concern; the server serves data.**

For an API-first, MCP-first product this is not a limitation but the reason the
architecture works. It also inverts the usual privacy trade: the household chooses which
client sees what, per query, instead of a server-side model having standing access to
everything — which is the same instinct as ADR 0004's refusal of a god-mode principal.

**Deferred, not cancelled.** Generative features are a future opt-in tier, revisited
once the base product is stable and the operational appetite is known. Nothing in this
ADR argues they are worthless — only that they must not be load-bearing in v1.

### 2. The base database stays on the official Postgres image

While the homelab runs one shared Postgres container, the base product uses **only
extensions bundled in the official Postgres image** — `pg_trgm`, `fuzzystrmatch`, and
built-in full-text search all qualify. No custom or third-party image
(`pgvector/pgvector:pg*` included).

**Trigger to revisit** — either is sufficient, and both are events rather than opinions:

1. The shared cluster's base image changes as **its own separately-justified decision**,
   weighed on behalf of every database in it; or
2. **KithLedger gets its own Postgres instance**, so the choice stops being cluster-wide
   and the decision is scoped to the service that wants it.

A satellite's optional feature must never dictate the image holding another service's
data. Note this rule is about *the image*, not about vectors: it would equally block any
other third-party extension, and it stops applying the moment the trigger fires — it is
a **sequencing rule, not a verdict** on pgvector.

The current Postgres major (**18.4**, per ADR 0005 part 6) remains the target; "official
image" is not an argument for staying on an old version.

## Consequences

- The household can run the whole stack on ordinary hardware with an official Postgres
  image and no model server. That is the deployment story the project exists to have.
- Members still get generative capability today, through MCP clients, with no server-side
  dependency and with per-query rather than standing data access.
- Nothing currently planned is affected: no existing plan or ADR depends on generative
  inference. This is **preventive doctrine, not a retraction** — nothing gets unbuilt.
- Systems of record stay deterministic. No row's contents originate from a model that
  cannot explain or reproduce them.
- The prompt-injection surface from ADR 0001 provider data stays closed, because no
  server-side model reads that text.
- **Cost — the real one:** several genuinely good features are deferred, and KithLedger's
  knowledge graph is the biggest loser. It keeps full-text search, fuzzy name matching,
  dedupe, drift/recall queries, and graph traversal; it gives up *meaning*-matching
  ("boat trip" finding "took the sailboat out") and similarity-based suggestions until
  the ADR 0005 trigger fires.
- **Cost:** the MCP escape hatch is only as good as the MCP surface. This ADR raises the
  stakes on MCP quality and on the HTTP-transport migration already noted in
  `strategy.md`, because MCP is now the *only* route to generative features.
- **Cost:** "generative" needs to stay a bright line. A small classifier or a rules engine
  with a model-ish name will eventually be proposed as not-really-generative. The test is
  the permitted-list definition above: deterministic, promptless, numeric output.
- **Cost:** rule 2 delays a decision already reasoned through in ADR 0005. That reasoning
  is preserved and its premise is untouched; only sequencing changes.
- **Proposed, not accepted.** Ratified alongside the first release that would have wanted
  a generative feature.
