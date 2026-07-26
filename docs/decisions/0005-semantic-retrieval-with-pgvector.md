# 0005 — Semantic retrieval with pgvector (KithLedger first)

**Status:** proposed — **deferred** behind
[ADR 0006](0006-no-server-side-generative-inference-and-a-conservative-base-db.md)
(2026-07-27)

> **Deferral note.** ADR 0006 keeps the base database on the official Postgres image
> (bundled extensions only) while the homelab runs **one shared Postgres container** for
> `heorth` + `feoh` + `kithledger`. pgvector therefore waits. The reasoning below is
> **unaffected** — ADR 0006 permits deterministic embedding encoders as ordinary
> dependencies, so it is the *extension*, not the idea, that is deferred. The
> **FTS + `pg_trgm` tier is ungated** and is the near-term work.

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
else**, behind an `EmbeddingProvider` seam with a local default, and behind an
**env switch that lets the database run without the extension at all**. Seven parts.

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

### 2. Embeddings live in per-parent side tables, always joined back to the parent

One side table per embedded entity, keyed 1:1 to its parent:

```
people_embeddings(person_id PK REFERENCES people(id) ON DELETE CASCADE,
                  embedding halfvec(1024), model text, embedded_at timestamptz)
interaction_embeddings(interaction_id PK REFERENCES interactions(id) ON DELETE CASCADE, …)
relationship_embeddings(relationship_id PK REFERENCES relationships(id) ON DELETE CASCADE, …)
```

**Visibility is filtered on the parent, never on the side table.** Every search joins
back (`FROM people_embeddings pe JOIN people p ON p.id = pe.person_id WHERE <ADR 0004
predicate on p> ORDER BY pe.embedding <=> $q`). The requirement ADR 0004 imposes is
*no duplicated visibility metadata*, and an always-join satisfies it by construction —
visibility has exactly one home, the parent row. An edge's note embedding keys to the
`relationships` row, so it inherits the edge's own visibility, independent of its
endpoints, exactly as ADR 0004 part 1 requires.

**Why side tables rather than a column on the parent** (this reverses an earlier
draft of this ADR): KithLedger uses bare `db.select().from(people)` at ~19 sites
across `src/services/*.ts` and `src/identity.ts`. Drizzle expands a bare `.select()`
into an explicit column list **taken from the schema definition** — so declaring an
`embedding` column that is absent on a deployment without the extension breaks every
one of those queries, including plain `getPersonById`. The alternative is rewriting
all 19 to explicit column lists and holding that discipline permanently. Side tables
are also simply better hygiene: a 2KB vector has no business travelling in every list
response, and disabling the feature becomes `DROP TABLE` (see part 7).

One central `embeddings(source_table, source_id, …)` table is rejected: a polymorphic
key cannot carry a foreign key, forfeiting `ON DELETE CASCADE` and admitting orphans.

`halfvec` over `vector` halves storage and index size (~2KB vs ~4KB/row) at negligible
recall cost for retrieval. PRM notes are short: **one embedding per parent row, no
chunking** — revisit only if a note exceeds the model's window.

Staleness needs no new infrastructure: a row absent from the side table, or whose
`embedded_at < parent.updated_at`, is pending. A worker claims those via the join.

### 3. Exact search, no ANN index — which dissolves the visibility problem

**Default: no vector index at all.** Exact `ORDER BY embedding <=> $q LIMIT n` over a
household-scale corpus (thousands, not millions, of embedded rows) is single-digit
milliseconds, and the planner applies the ADR 0004 predicate as an ordinary filter at
**full recall**.

This matters because approximate search and per-item visibility filtering interact
badly. With HNSW, `ORDER BY embedding <=> $q LIMIT 10` under an ADR 0004 predicate does
**not** return "my 10 nearest visible notes": the index yields ~`ef_search` (default 40)
candidates from the *whole* index and the visibility filter is applied **afterwards**.
If your visible subgraph is 10% of the graph you get ~4 rows, and visible-but-slightly-
more-distant items are never considered. Worse, **result-set size becomes a function of
how much is hidden from you** — precisely the shape leak ADR 0004 traversal rule 4
forbids.

Exact search has none of that. So the decision is to **not buy the problem**: no HNSW,
no `ef_search` tuning, no iterative-scan discipline, no per-scope partial indexes.

**Trigger and recipe for when scale demands HNSW** (revisit north of ~100k embedded
rows, or when exact search exceeds a measured latency budget):

1. **Iterative index scans**, pgvector **≥ 0.8** — Postgres keeps pulling candidates
   until `LIMIT` is satisfied under the filter. **Off by default and scoped per
   session/transaction**, so it must be set *inside the transaction*
   (`SET LOCAL hnsw.iterative_scan = 'relaxed_order'`) and never assumed sticky on a
   pooled connection. `strict_order` only where exact distance ordering is contractual.
2. `shared`-subset scopes are arbitrary member sets and combinatorial — they are
   **not** indexed per-scope. A partial index for the `household` slice is not
   available either: the side tables of part 2 hold no `visibility` column, and a
   partial index predicate cannot reference another table. Denormalising `visibility`
   onto the side tables to enable one would reintroduce the duplication part 2 exists
   to avoid, and is rejected.
3. Adopting HNSW is therefore a **deliberate trade of recall-correctness machinery for
   latency**, to be taken only against a measurement — never pre-emptively.

**Regardless of index strategy, aggregates and "top N similar" obey ADR 0004 rule 4** —
computed over the caller's visible subgraph only. A similarity list is an aggregate.

### 4. Provider seam: split three ways, so ADR 0003 rule 6 stays mechanical

| Piece | Home | Why |
|---|---|---|
| Capability-gated migration helper + extension bootstrap (part 7 machinery) | **`@wyrhta/core`** | Stable shape, reused verbatim, and it is a **DB convention** — a category root `CLAUDE.md` already assigns to core. Not a provider, so no rule 6 question arises. |
| `halfvec` column + staleness convention | **`@wyrhta/core`** | Same: boring, stable, conventional. |
| `EmbeddingProvider` interface + implementations (Ollama, OpenAI) | **KithLedger** | Most likely to churn. Promote to core on **second demand** *or* on interface stability — whichever comes first. |

An earlier draft put the interface in core too, justified by "embeddings-over-free-text
is structurally generic, so a second consumer is likely." That is rejected as a
*prediction*, and
[ADR 0003](0003-external-reference-feeds-behind-providers.md) rule 6 exists precisely to
stop abstractions being placed on predictions. Its value is that it is **mechanical** —
a named trigger, no judgment — and a judgment-based exception ("structurally generic")
would be citable for almost anything and would dull it for every future case.

Two further reasons the prediction was weak:

1. **Release cadence.** Root `CLAUDE.md` is explicit that core reaches consumers only by
   cutting a tag and bumping `package.json`. A seam in core makes every iteration cost
   tag → bump → install, during exactly the phase when the interface churns most.
2. **The generic half is the boring half.** Plausible second consumers do not share the
   interesting part: KithLedger has ADR 0004 per-item visibility, Heorth recipes are
   household-wide, Feoh transaction descriptions likely have no per-item visibility at
   all. What generalises is the column and staleness convention; the visibility-joined
   retrieval pattern — where the design content lives — is KithLedger-specific.

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
- **Pin the model by digest, not by tag.** Ollama tags move. A silently-updated model
  yields silently incomparable vectors in one table, and an `embedding_model` column
  recording only `bge-m3` will not catch it. Store the resolved revision.
- **The model requirement, not a named winner:** multilingual covering **German +
  English**, CPU-viable, 384–1024 dimensions. Monolingual English models are excluded
  because household notes code-switch mid-sentence, which is exactly where they degrade
  — that argument is robust independent of which model wins. The specific choice is
  made **at build time** from then-current benchmarks plus a smoke test on real notes;
  naming a winner in a document written a year ahead of implementation would be false
  precision.

**Model choice is cheaper to reverse than it looks.** A full re-embed at household
scale is minutes of CPU time, and because part 2 uses side tables a dimension change is
`DROP TABLE` + recreate + re-embed — no `ALTER COLUMN TYPE` on a hot domain table, no
lock concerns. What is *not* cheap is anything **derived** from embeddings that is
persisted with user-visible history: cached similarity lists, clusters, or
introduction suggestions the member has acted on or dismissed. Re-embedding invalidates
those, and unlike the vectors they cannot be silently regenerated without losing the
member's decisions. **Rule: keep derived state recomputable, or key the member's
decisions to the entity rather than to the suggestion.**

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

**The load-bearing point: what this design needs is a pgvector version, not a Postgres
version.** The baseline requirement is `halfvec` — **pgvector ≥ 0.7**. Iterative index
scans (**≥ 0.8**) become required only if and when part 3's HNSW trigger fires. Both
work on 16 and on 18 alike, so no Postgres major is doing load-bearing work here.
Re-evaluate the major at build time rather than pre-committing.

### 7. The whole feature is switchable off, down to the database image

A deployment must be able to run **plain `postgres:18`**, with no pgvector binary at
all. Three distinct levels of "off", all supported:

| Level | What is off | Mechanism |
|---|---|---|
| **Query path** | Feature disabled, worker idle, search falls back to FTS. Extension and side tables still present. | `EMBEDDINGS_ENABLED=false` |
| **Schema** | No side tables, no vector storage. | Capability-gated migration (below) |
| **Image** | `postgres:18` instead of `pgvector/pgvector:pg18` — no extension available. | Deployment choice |

Rules:

1. **Migrations gate on database *capability*, not on the env var.** The vector DDL is
   wrapped in a `DO` block conditional on `pg_available_extensions`, so schema state
   follows what the server can actually do — never a flag someone may flip back. An env
   var must never be able to make migration history diverge irreconcilably.
2. **The env var gates application behaviour only** — `EMBEDDINGS_ENABLED`, **default
   `false`**, plus provider config, validated in `config/env.ts` beside the existing Zod
   vars.
3. **Fail fast; never silently degrade.** `EMBEDDINGS_ENABLED=true` against a database
   without the extension must **refuse to start** with an explicit message. Silent
   fallback would present as "semantic search is bad" rather than "semantic search is
   off" — the worse failure by far.
4. **Off is a working state, not a broken one.** Because part 1 chose *hybrid* search,
   disabling vectors degrades to FTS + `pg_trgm` — still a real search. This is the
   property that makes the switch cheap, and a reason not to drift toward vector-only
   ranking later.
5. **Turning it off after the fact is `DROP TABLE`** on the side tables of part 2, with
   no impact on domain tables.

## Consequences

- The relationship knowledge in notes becomes retrievable, and the MCP surface can hand
  an LLM a ranked slice instead of a row dump — the highest-leverage gain.
- Scope discipline is explicit: three of the five jobs above are served by `pg_trgm`,
  `fuzzystrmatch`, and ordinary aggregates. Future work will not reach for embeddings on
  a recency query.
- Privacy holds: visibility has a single home (the parent row) and every search joins
  through it, and note text stays in the homelab by default.
- ADR 0004's shape guarantee extends to similarity search rather than being undermined by
  it — with exact search, result-set size cannot depend on what is hidden.
- Choosing exact search removes the largest source of subtle incorrectness in the whole
  design, at no cost at household scale. The HNSW machinery is documented but unbuilt.
- The feature is switchable off down to the database image, and "off" leaves a working
  FTS search rather than a hole.
- **Cost:** an inference container in the homelab, and CPU-only embedding latency on write.
- **Cost:** exact search is O(rows) per query. It is correct and fast now, but it *will*
  need the part 3 revisit eventually, against a measured budget rather than a guess.
- **Cost:** every semantic query carries a join back to the parent. Trivial on a primary
  key, but it means no search query may ever read the side tables alone — doing so would
  bypass ADR 0004 entirely. This needs a test, not a comment.
- Model choice is **reversible in minutes** at household scale (part 5), so it does not
  need to be settled now — which is why part 5 states a requirement rather than a winner.
- ADR 0003 rule 6 is left **intact and mechanical**: only DB conventions go to core, and
  the provider interface follows the existing second-demand trigger. No judgment-based
  exception is created for future promotions to cite.
- **Cost:** persisted *derived* state (similarity caches, acted-on suggestions) is the
  real lock-in, not the model. Part 5's recomputability rule has to be honoured or a
  re-embed destroys member decisions.
- **Gated, not built.** The Postgres 18.4 bump may proceed independently. The pgvector
  work waits on **all** of:
  1. **ADR 0006's DB trigger** — either the shared cluster's base image changes as its
     own separately-justified decision, or KithLedger gets its own Postgres instance.
     One satellite's optional feature must not dictate the image holding Heorth's and
     Feoh's data.
  2. **ADR 0004 accepted** and **ADR 0002 Phase B** live — building unfiltered search
     first and retrofitting visibility is the expensive direction.
  3. Strategy's Phase 3 feature freeze, and pgvector **≥ 0.7** (`halfvec`) in whatever
     image is then in use.
- **The `EmbeddingProvider` seam is not blocked by ADR 0006.** Encoders are permitted
  dependencies; only the *extension* waits. The seam may be designed whenever useful.
- An **ungated cheap precursor exists**: replacing `ILIKE` with FTS + `pg_trgm` needs none
  of the above, is independently useful, and is the FTS half of the eventual hybrid. Noted
  as available, not scheduled.
- **Proposed, not accepted.** Specifics here — `halfvec(1024)`, the model default, RRF, the
  core/consumer split, the exact-search default — are provisional and get ratified,
  possibly revised, when the feature is designed for real.

## Revision history

- **2026-07-27 (same day):** parts 2, 3, and 6 revised and part 7 added, prompted by the
  requirement that vector search be switchable off in ENV so the database can run without
  the extension. Part 2 moved embeddings from columns on the parent row to per-parent side
  tables — the bare `db.select()` expansion at ~19 call sites makes an optional column
  untenable, and an always-join keeps visibility single-sourced anyway. That removed the
  option of a partial `household` index, which in turn prompted part 3 to drop ANN
  indexing entirely at household scale; exact search is both simpler and strictly more
  correct under ADR 0004. The switch requirement made the design smaller.
- **2026-07-27 (same day, second pass):** status changed to *deferred* behind
  [ADR 0006](0006-no-server-side-generative-inference-and-a-conservative-base-db.md) —
  the shared single-Postgres-container decision of 2026-07-25 means adopting pgvector
  would change the image holding Heorth's and Feoh's data for one satellite's optional
  feature. Part 4 revised: the `EmbeddingProvider` interface returns to KithLedger and
  only DB conventions go to core, abandoning the "structurally generic" exception to
  ADR 0003 rule 6 as a prediction the rule exists to prevent. Part 5 revised: the model
  default becomes a *requirement* rather than a named model, gains digest-pinning, and
  its reversal cost is corrected downward — a re-embed is minutes, and side tables make a
  dimension change a `DROP TABLE`; the real lock-in is persisted derived state.
