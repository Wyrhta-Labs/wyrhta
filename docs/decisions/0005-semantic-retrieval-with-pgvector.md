# 0005 — Semantic retrieval with pgvector (KithLedger first)

**Status:** proposed (2026-07-27)

## Context

KithLedger's search is `ILIKE '%q%'` on `name` and `email` only
(`src/services/people.ts`). The free text that actually carries the relationship
knowledge — `people.notes`, `interactions.notes`, `relationships.notes` — is not
searchable at all. "Who did I talk to about the boat trip" cannot be answered when
the note says "took the sailboat out with Anna".

The pull is stronger than a search box. KithLedger is API-first with its own MCP, so
its `kith.*` tools hand a slice of the graph to an LLM whose context is the scarce
resource. Relevance-ranked retrieval is worth more there than in any UI.

The temptation is to treat "embeddings" as a general upgrade and reach for them
across four jobs at once: semantic note search, MCP/LLM retrieval, entity resolution
(is "Chris F." the same person as "Christian Foellmann"?), and suggestion/recall
("drifting from", "similar people"). Two of those have cheaper and *more accurate*
answers already in Postgres, and conflating them would embed vectors in places where
they are simply the wrong tool.

The harder problem is [ADR 0004](0004-per-member-access-control-in-the-knowledge-graph.md).
Approximate-nearest-neighbour indexes and per-item visibility filtering interact
badly, and the failure is not merely slow — it leaks graph shape, which is precisely
what ADR 0004 exists to prevent.

## Decision

Adopt pgvector in KithLedger for **meaning-similarity over free text, and nothing
else**, behind an `EmbeddingProvider` seam with a local default. Six parts.

### 1. Scope: vectors buy meaning over prose; everything else has a cheaper answer

The four candidate jobs, with suggestion/recall split in two because its halves land
on opposite sides of the line:

| Job | Tool |
|---|---|
| Semantic search over notes | **Hybrid** — Postgres FTS (`tsvector`) **+** vector, rank-fused. Not vector alone: pure ANN loses exact names, dates, and rare tokens that FTS nails. |
| MCP/LLM retrieval | Same index, different caller. Highest-value use; no machinery beyond the above. |
| Entity resolution / dedupe | **`pg_trgm` + `fuzzystrmatch` (dmetaphone)** — a *string* problem. Name embeddings are weak and will happily merge two different Christians. Vectors are admissible only as a weak secondary signal over the *note context* around two candidates. |
| "Drifting from" / recall | **Plain SQL** — `max(interactions.occurred_at)` plus frequency. Zero vectors; using embeddings here would be actively wrong. |
| "Similar people" / introductions | Vector work. |

This table is the operative rule: **if the question is not about meaning over prose,
do not reach for an embedding.**

### 2. Embeddings are columns on the owning row, never a central table

`people.embedding`, `interactions.embedding`, `relationships.embedding` — as
`halfvec(1024)`. Rationale is correctness, not convenience: visibility then travels
with the item automatically, so one ADR 0004 filter clause covers both the row and
its vector, and an owner-only note on a household-visible person cannot leak through
a node-scoped embedding. A central `embeddings` table would duplicate visibility
metadata and require re-syncing it — a correctness bug waiting to happen.

`halfvec` over `vector` halves storage and index size (~2KB vs ~4KB/row) at
negligible recall cost for retrieval, and stays well under HNSW's dimension ceiling.

PRM notes are short: **one embedding per row, no chunking.** Revisit only if a note
exceeds the model's window.

Staleness needs no new infrastructure: nullable `embedding` plus `embedded_at`, and a
worker claiming rows where `embedded_at IS NULL OR embedded_at < updated_at`.

### 3. Filtered ANN must be visibility-correct (the crux)

`ORDER BY embedding <=> $q LIMIT 10` under an ADR 0004 predicate does **not** return
"my 10 nearest visible notes." HNSW returns ~`ef_search` (default 40) candidates from
the *whole* index and the visibility filter is applied **afterwards**. If your visible
subgraph is 10% of the graph you get ~4 rows, and visible-but-slightly-more-distant
items are never considered. Worse: **result-set size becomes a function of how much is
hidden from you** — exactly the shape leak ADR 0004 traversal rule 4 forbids.

Three layers:

1. **Iterative index scans** (pgvector **≥ 0.8**) as the general path — Postgres keeps
   pulling candidates until `LIMIT` is satisfied under the filter. It is **off by
   default and scoped per session/transaction**, so it must be set *inside the
   transaction* (`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`) and never assumed
   sticky on a pooled connection. `strict_order` only where exact distance ordering is
   contractual.
2. **A partial HNSW index `WHERE visibility = 'household'`** — serves ADR 0004's
   household service principal (the always-on dashboard, the likely volume leader) at
   full recall with no iterative overhead. `shared`-subset scopes are arbitrary member
   sets and combinatorial; they take the general path and are **not** indexed per-scope.
3. **Aggregates and "top N similar" obey ADR 0004 rule 4** — computed over the
   caller's visible subgraph only. A similarity list is an aggregate.

### 4. Provider seam: split by doctrine, not wholesale into core

- **`@wyrhta/core`** takes the **DB conventions** — the vector column convention, the
  `embedded_at` staleness pair, `CREATE EXTENSION vector` bootstrap, and the index
  recipes including the partial-household index — plus the `EmbeddingProvider`
  *interface type*. Root `CLAUDE.md` already assigns DB conventions to core, so this is
  not a provider promotion.
- **The consumer (KithLedger)** holds the concrete implementations (Ollama, OpenAI).

This is deliberately narrower than "embeddings go in core," to keep
[ADR 0003](0003-external-reference-feeds-behind-providers.md) rule 6 (providers live
in the consumer; core gains nothing until a second service needs them) intact rather
than quietly eroded. The distinction: weather is structurally Heorth-shaped
(location-anchored, one plausible consumer), whereas embeddings-over-free-text is
structurally generic — Heorth has recipes and notes, Feoh has transaction
descriptions. A second consumer is genuinely likely here; for weather it was not.

**Local default, external opt-in.** Private notes must not leave the house by default —
anything else contradicts ADR 0004's premise. External providers are a per-deployment
opt-in, never the default.

### 5. Dimension is a deploy-time constant; model swaps are migrations

`vector`/`halfvec` pin dimension at the *column*, so "pluggable" cannot mean "swap
models at runtime."

- Dimension is **declared by the provider at deploy time**. Changing models is an
  explicit **re-embed migration**, not a config change. Stated plainly because
  flipping an env var would otherwise silently corrupt every distance computation.
- **Never compare vectors across models.** Store `embedding_model` per row; rows whose
  model ≠ current config are treated as **unembedded** — excluded from search and
  queued. This makes a model migration resumable and safe to run online.
- **The default model must be multilingual**, following the DE-first doctrine in
  ADR 0003: `bge-m3` or `multilingual-e5-large` (both 1024), **not**
  `nomic-embed-text` (768, English-centric), which would underperform on exactly the
  German notes the household actually writes.

The same wrinkle hits the FTS half: `to_tsvector('german', …)` and `('english', …)`
stem differently and mixed-language notes are wrong either way. Pragmatic answer —
`'german'` config plus `pg_trgm` as the safety net for English tokens; **no per-note
language detection.**

**Fusion is Reciprocal Rank Fusion**, in SQL, by rank. `ts_rank` and cosine distance
are incomparable scales; weighted score blending between them is a tuning rabbit hole
with no principled stopping point.

### 6. Postgres 18.4 now; the needed feature is pgvector's, not Postgres's

Move to the current stable major, **18.4** — an independent, mechanical step, **not**
gated on anything below. What 18 actually buys here: `uuidv7()` (KithLedger uses
`gen_random_uuid()` v4 throughout; time-ordered ids improve index locality in a schema
this join- and recursive-CTE-heavy), **skip scan on multicolumn btree indexes**
(helps the composite `(visibility, owner)` indexes ADR 0004 implies), and async I/O.

**Do not wait for Postgres 19** (Beta 2 as of 2026-07-16, final ~Sept/Oct 2026).
Nothing in 19 is vector-relevant: `pg_plan_advice` is the most interesting item and
needing it means the query shape is already wrong; JIT-off and `lz4` TOAST defaults are
settable or near-irrelevant today (a 1024-dim float vector is high-entropy data
pgvector stores uncompressed anyway); parallel autovacuum is a mild win against HNSW
churn. And a `.0` does not go under the household's data — one would wait for ~19.2–19.4,
plus lag on pgvector support, images, and driver validation.

**The load-bearing point: the capability this design needs is a pgvector version, not a
Postgres version.** Filtered ANN under an ADR 0004 predicate requires iterative index
scans — pgvector ≥ 0.8 — which works on 16 and on 18 alike. Re-evaluate the major at
build time rather than pre-committing.

## Consequences

- The relationship knowledge in notes becomes retrievable, and the MCP surface can hand
  an LLM a ranked slice instead of a row dump — the highest-leverage gain.
- Scope discipline is explicit: three of the five jobs above are served by `pg_trgm`,
  `fuzzystrmatch`, and ordinary aggregates. Future work will not reach for embeddings on
  a recency query.
- Privacy holds: embeddings inherit their row's visibility by construction, and note text
  stays in the homelab by default.
- ADR 0004's shape guarantee extends to similarity search rather than being undermined by
  it — result-set size stops depending on what is hidden.
- **Cost:** an inference container in the homelab, and CPU-only embedding latency on write.
- **Cost:** the ANN-plus-filter discipline is subtle and easy to regress. A query that
  omits `SET LOCAL hnsw.iterative_scan` still returns *plausible* results — silently
  fewer and scope-dependent. This needs a test, not a comment.
- **Cost:** model choice is effectively load-bearing. Swapping it is a re-embed migration
  over every row with a note.
- **Cost:** ADR 0003 rule 6 is narrowed, not broken — but the "structurally generic"
  argument in part 4 is now the precedent future promotions will cite. It should be held
  to.
- **Gated, not built.** The Postgres 18.4 bump may proceed independently. The pgvector
  work waits on: ADR 0004 **accepted** and ADR 0002 **Phase B** live (building unfiltered
  ANN search first and retrofitting visibility is the expensive direction), strategy's
  Phase 3 feature freeze, and pgvector ≥ 0.8 in the deployed image.
- An **ungated cheap precursor exists**: replacing `ILIKE` with FTS + `pg_trgm` needs none
  of the above, is independently useful, and is the FTS half of the eventual hybrid. Noted
  as available, not scheduled.
- **Proposed, not accepted.** Specifics here — `halfvec(1024)`, the model default, RRF, the
  core/consumer split — are provisional and get ratified, possibly revised, when the
  feature is designed for real.
