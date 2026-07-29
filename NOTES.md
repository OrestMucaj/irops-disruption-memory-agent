# NOTES — verified API research

Research log for the IROPS Disruption Memory Agent. Per [SPEC.md](SPEC.md) §1.2,
nothing in this project may be built on guessed API details. This file records
what the official docs **actually say**, with links, so the code can be checked
against a source rather than against memory.

**Date of research:** 2026-07-29
**Method:** fetched the live official docs. No live CockroachDB or AWS service
was contacted — no accounts exist yet.

**Caveat on quoting:** quotes below are as returned when fetching each page and
converting it to text. They have not been diffed character-by-character against
raw HTML. Treat them as accurate to intent and near-certainly accurate to the
letter, but per SPEC §1.2 still smoke-test before integrating.

**Confidence legend used throughout:**
- ✅ **Verified** — stated explicitly in official docs, quoted below.
- ⚠️ **Ambiguous** — docs conflict, or are silent, and I have said so rather
  than filled the gap with a plausible guess.
- ❌ **Unverified** — needs a live smoke test before any code depends on it.

---

## 1. CockroachDB vector indexing

Sources:
- [VECTOR data type](https://www.cockroachlabs.com/docs/v26.2/vector)
- [Vector Indexes](https://www.cockroachlabs.com/docs/stable/vector-indexes)
- [CREATE INDEX](https://www.cockroachlabs.com/docs/stable/create-index)
- [Cluster Settings](https://www.cockroachlabs.com/docs/stable/cluster-settings)

### 1.1 Column type ✅

`VECTOR(n)` where `n` is the dimension count.

> "A `VECTOR` value is expressed as an array of floating-point numbers."

From the docs' own examples:

```sql
CREATE TABLE items (
    department_id INT,
    category_id INT,
    embedding VECTOR(1536),
    VECTOR INDEX (embedding)
);
```

### 1.2 Index creation — two forms ✅

**Inline, inside `CREATE TABLE`** (this is the form the docs use most, and the
form this project will use):

```sql
CREATE TABLE items (
    department_id INT,
    category_id INT,
    embedding VECTOR(1536),
    VECTOR INDEX (embedding)
);
```

**Standalone statement:**

```sql
CREATE VECTOR INDEX ON items (embedding);
```

⚠️ **Docs typo, flagging rather than silently correcting.** The syntax synopsis
on the Vector Indexes page renders literally as:

> ```sql
> CREATE VECTOR INDEX ON {table} (column});
> ```

Note the unbalanced brace in `column})`. This is a typo in the CockroachDB docs
placeholder, not real syntax. The working example on the same page
(`CREATE VECTOR INDEX ON items (embedding);`) is the form to trust.

**Named index with an opclass:**

```sql
CREATE TABLE items (
    department_id INT,
    category_id   INT,
    embedding     VECTOR(1536),
    VECTOR INDEX embed_idx (embedding vector_cosine_ops)
);
```

**pgvector-compatible form.** [CREATE INDEX](https://www.cockroachlabs.com/docs/stable/create-index)
documents a `USING name` clause where `cspann` is the vector index type, and:

> "hnsw is aliased to cspann for compatibility with pgvector syntax."

So `USING hnsw` is accepted and silently means C-SPANN. Worth knowing so that
copy-pasted pgvector DDL does not mislead about what index is actually built.

### 1.3 Prefix columns — the hybrid-retrieval lever ✅

A vector index may carry leading non-vector columns:

```sql
CREATE TABLE items (
    department_id INT,
    category_id INT,
    embedding VECTOR(1536),
    VECTOR INDEX (department_id, category_id, embedding)
);
```

The index maintains a separate K-means tree per distinct prefix value. Index
acceleration only applies when the query's filters match the prefix. The docs
give these as the filter shapes that work:

```sql
WHERE department_id = 100 AND category_id = 200
WHERE (department_id, category_id) IN ((100, 200), (300, 400))
WHERE department_id = 100 AND category_id >= 200
```

**Why this matters to us:** SPEC §5.1 wants hybrid structured + semantic
retrieval — "only `status = 'resolved'`" alongside similarity. A prefix column
is precisely the mechanism that makes that filter *index-accelerated* rather
than a post-filter over an ANN result set. This is the single most important
finding in this document for the schema design. See §5.1 below.

### 1.4 Distance operators ✅

| Operator | Meaning | Accelerating opclass |
| --- | --- | --- |
| `<->` | Euclidean / L2 distance (default) | `vector_l2_ops` |
| `<=>` | Cosine distance | `vector_cosine_ops` |
| `<#>` | Negative inner product | `vector_ip_ops` |

The VECTOR type page also lists `=` and `<>` as supported.

Not implemented, quoted:

> "The distance functions `vector_l1_ops`, `bit_hamming_ops`, and
> `bit_jaccard_ops` are not implemented."

### 1.5 Query form ✅

```sql
SELECT id, name, embedding
FROM items
WHERE customer_id = 1
ORDER BY embedding <-> '[0.00644,-0.00866,...]'
LIMIT 3;
```

Two things to note for our implementation:
- The query vector is passed as a **string literal** of a bracketed array.
  Via `pg` this should be a parameterised `$1` bound to a `'[...]'` string
  (SPEC §5.4: parameterised queries only).
- `ORDER BY <distance op> ... LIMIT k` is the shape the index accelerates.
  Verify with `EXPLAIN` that the plan actually uses the vector index — the docs
  demonstrate exactly this with an `EXPLAIN` of the query above.

### 1.6 Supported dimensions ⚠️

**The docs do not state a maximum dimension count.** I checked the VECTOR type
page, the Vector Indexes page, and the v26.2 VECTOR page; none gives a limit.
Examples use `VECTOR(1536)` and `VECTOR(512)`.

The only size guidance given is indirect:

> "The size of a `VECTOR` value is variable, but it's recommended to keep values
> under 1 MB"

I am **not** going to assert a maximum. For this project it is moot — every
dimension we might pick (256/512/1024/1536) is well inside anything plausible.

### 1.7 Tuning knobs ✅

```sql
CREATE VECTOR INDEX ON items (category, embedding) WITH (min_partition_size=16, max_partition_size=128);
```

```sql
SET vector_search_beam_size = 16;
```

`vector_search_beam_size` is a session setting trading recall against latency —
relevant later for M2's "does retrieval return sensible precedents" tuning.

### 1.8 Feature flag and availability status ⚠️ — **conflict in the docs**

This is a genuine contradiction between two official pages and I am not going to
resolve it by guessing.

**The Vector Indexes page says the setting must be turned on:**

> "To enable the use of vector indexes, set the `feature.vector_index.enabled`
> cluster setting"

and shows:

```sql
SET CLUSTER SETTING feature.vector_index.enabled = true;
SET sql_safe_updates = false;
```

**The Cluster Settings reference says it is already on**, listing
`feature.vector_index.enabled` as boolean, **default `true`**, description
"set to true to enable vector indexes, false to disable; default is true",
supported deployments "Basic/Standard/Advanced/Self-Hosted".

Most likely explanation: the default flipped to `true` when the feature matured,
and the Vector Indexes page still carries preview-era instructions. But that is
inference, not documentation.

**Availability status:** vector indexing shipped in v25.2 described as Preview
("in preview and subject to change"). I could **not** find an official statement
that it has reached GA. The `/stable/` feature-availability page does not
mention vector indexes at all.

**Good news for us:** the Cluster Settings table explicitly lists Basic among
supported deployments for this setting, which strongly suggests a free Basic
cluster can use vector indexes. This was the biggest project risk going in
(a multi-tenant free cluster refusing `SET CLUSTER SETTING` would have sunk
the whole retrieval design).

❌ **Must smoke-test on day one, before anything else is built:**
1. `SHOW CLUSTER SETTING feature.vector_index.enabled;` on a real free cluster.
2. If `false`, confirm `SET CLUSTER SETTING ... = true` is permitted on Basic.
3. Create a table with a vector index and `EXPLAIN` a similarity query to prove
   the index is used.

This is exactly SPEC M1's exit criterion. Do not write retrieval code first.

### 1.9 Other stated limitations ✅

> "Large batch inserts of `VECTOR` types can cause performance degradation. When
> inserting vectors, batching should be avoided."

> "`IMPORT INTO` is not supported on tables with vector indexes."

> "Adding a vector index to a non-empty table can temporarily disrupt workloads
> that perform continuous writes."

**Direct consequence for M2 (synthetic data seeding).** The seeder plans to
insert ~60–100 cases with embeddings. Two of these bite:
- Do **not** bulk-insert vectors in large batches. Insert per-row or in small
  batches.
- `IMPORT INTO` is off the table, so seeding must go through INSERTs.
- Prefer creating the vector index **before** loading data, rather than adding
  it to an already-populated table.

---

## 2. CockroachDB Cloud Managed MCP Server

Source: [Managed MCP Server for AI Agents](https://www.cockroachlabs.com/blog/cockroachdb-ai-agents-managed-mcp-server/)

### 2.1 The question asked

SPEC §7 asks whether a server-side process such as a Lambda can use the MCP
server **at runtime**, or whether it is only meant for IDE clients — because
that decides whether we get option (a) (runtime read-only analyst path, scores
better) or fall back to (b) (documented dev-time use).

### 2.2 Answer: runtime server-side use is supported ✅

Endpoint:

> "https://cockroachlabs.cloud/mcp"

Two authentication mechanisms:

1. **OAuth 2.1** (Authorization Code Flow with PKCE) —
   > "Designed for interactive user workflows, with scoped permissions"

   with `mcp:read` and `mcp:write` scopes. This is the IDE / Claude Code path.
   It requires a human at a browser, so it is **not** usable from a Lambda.

2. **Service account API keys** —
   > "Intended for fully autonomous environments. API keys can be granted Cloud
   > RBAC roles scoped to the specific cluster being accessed."

**This is the one that answers the question.** "Fully autonomous environments"
is the non-interactive server-side case. A Lambda holding a service-account API
key is the intended shape, not a workaround.

Additional stated control:

> Every tool invocation performs a Cloud RBAC check before execution, and
> requests are rejected if permissions exceed the expected scope.

### 2.3 Read-only mode ✅

Read-only mode permits "safe, introspective tools" and blocks "Write
operations." Even with write consent granted:

> "Destructive SQL operations (for example, `DROP` or `TRUNCATE`) remain
> unsupported."

Tools named in the source include `list_databases`, `select_query`,
`get_table_schema`, `create_database`, `create_table`, `insert_rows`.

This maps cleanly onto SPEC §1.3's requirement to use MCP read-only and say so:
grant the service account `mcp:read` only, and the analyst path is structurally
incapable of mutating the memory layer.

### 2.4 Intended clients ✅

> "Out-of-the-box compatibility with Claude Code, with support for other MCP
> clients."

No restriction to IDE environments is stated.

### 2.5 What remains unverified ❌

The blog announces the capability; it is not a full API reference. Before
building the runtime path:
- Confirm the exact HTTP transport (streamable HTTP vs SSE) and how the API key
  is presented (`Authorization: Bearer <key>` is the CockroachDB Cloud API
  convention, but I have **not** seen it stated for the MCP endpoint
  specifically — do not assume).
- Confirm a service-account API key can be created on a **free Basic** org, not
  just paid tiers. Nothing I read says either way. ⚠️
- Confirm which MCP client library to use from Node.

**Plan:** target option (a), timebox it per SPEC §10's 30-minute rule, fall
back to (b) and be honest in the README if the auth handshake fights back.

---

## 3. CockroachDB Cloud free tier

Sources:
- [Pricing](https://www.cockroachlabs.com/pricing/)
- [Plan a CockroachDB Basic Cluster](https://www.cockroachlabs.com/docs/cockroachcloud/plan-your-cluster-basic)

### 3.1 Current shape ✅

The free offering is the **Basic** plan, not a separately-named "free tier".

> "50 million RUs and 10 GiB storage free per month"

> "No credit card required for Basic and Standard plans."

From the Basic planning page:

> "Each pay-as-you-go CockroachDB Cloud organization...is given $15 of resource
> consumption (equivalent to 50 million Request Units and 10 GiB of storage) for
> free each month."

Current plan names: **Basic**, **Standard** (Preview), **Advanced**.

### 3.2 What happens at the limits ✅

> "If you reach your storage limit, your cluster will be unable to write to its
> storage unless you delete data or increase your storage limit."

> "If you reach your RU limit, your cluster will be disabled until you increase
> your RU limit or a new billing cycle begins."

⚠️ **Worth taking seriously for a hackathon.** A disabled cluster the night
before the deadline, or during judging, would be fatal. The demo must be
RU-cheap. Vector index builds and embedding backfills are the expensive
operations — do them once, not on every demo run. Do not put an embedding call
in a page-load path.

Also noted:

> "Customers with annual or multi-year contracts are not eligible for the free
> monthly resource benefit."

Not applicable to a personal account.

### 3.3 Stale information to ignore ⚠️

Search results surface an older free tier described as "up to 1 vCPU and 5GB
storage per free cluster", and a "CockroachDB Cloud Free (beta)" product. The
naming has changed more than once —

> "CockroachDB Cloud Free (beta) and CockroachDB Cloud are now CockroachDB
> Serverless and CockroachDB Dedicated, respectively"

— and "Serverless" has since become "Basic". **Treat any figure mentioning
5 GB or 1 vCPU as obsolete.** The current numbers are 10 GiB / 50M RUs. I am
flagging this because the stale numbers rank highly in search and would be easy
to copy into the README by mistake.

⚠️ **Not documented anywhere I found:** the maximum number of Basic clusters per
organization. Unimportant for us (we need one).

---

## 4. Amazon Bedrock embedding models

Sources:
- [Amazon Titan Text Embeddings models](https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html)
- [Amazon Titan Embeddings G1 - Text (request/response)](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-titan-embed-text.html)
- [Cohere Embed v4](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-embed-v4.html)

### 4.1 Amazon Titan Text Embeddings V2 ✅

Quoted directly:

> + **Model ID** – `amazon.titan-embed-text-v2:0`
> + **Max input text tokens** – 8,192
> + **Max input text characters** – 50,000
> + **Output vector size** – 1,024 (default), 512, 256
> + **Inference types** – On-Demand, Provisioned Throughput

Request body:

```json
{
    "inputText": "string",
    "dimensions": 1024,
    "normalize": true,
    "embeddingTypes": ["float"]
}
```

> - inputText – Enter text to convert to an embedding.
> - normalize – (optional) Flag indicating whether or not to normalize the
>   output embedding. Defaults to true.
> - dimensions – (optional) The number of dimensions the output embedding should
>   have. The following values are accepted: 1024 (default), 512, 256.

Response body:

```json
{
    "embedding": [0.1, 0.2],
    "inputTextTokenCount": 7,
    "embeddingsByType": {"float": [0.1, 0.2]}
}
```

Gotcha worth recording:

> "When using Titan Text Embeddings V2, the `embedding` field is not in the
> response if the `embeddingTypes` only contains `binary`."

So: leave `embeddingTypes` unset (defaults to `float`) and read `embedding`.

### 4.2 Amazon Titan Embeddings G1 — Text ✅

Model ID `amazon.titan-embed-text-v1`. Request accepts only `inputText`;
no dimension control. Response is `{ "embedding": [...], "inputTextTokenCount": n }`.

Older; no reason to prefer it over V2.

### 4.3 Cohere Embed v4 ✅ (with one ⚠️)

> "with configurable output dimensions from 256 to 1536"

> **output_dimension** (optional) – Select vector length. Allowed: `256`, `512`,
> `1024`, `1536` (default `1536` if unspecified).

Max ~128k tokens per document; max 96 texts per call; `input_type` is
**required** and matters for retrieval quality:

> "For search/RAG, embed your corpus with `search_document` and queries with
> `search_query`."

⚠️ **Model ID inconsistency in AWS's own docs.** The prose says:

> "The model ID for Cohere Embed v4 is `cohere.embed-v4`."

but the code example on the same page uses:

> `model_id = 'cohere.embed-v4:0'`

I do not know which is correct. `:0` matches the versioned convention used by
`amazon.titan-embed-text-v2:0`, so `cohere.embed-v4:0` is the likelier one — but
that is inference. If we ever use Cohere, resolve this by calling
`ListFoundationModels` rather than trusting either string.

### 4.4 Dimension summary

| Model | Model ID | Dimensions | Default |
| --- | --- | --- | --- |
| Titan Text Embeddings V2 | `amazon.titan-embed-text-v2:0` | 1024, 512, 256 | 1024 |
| Titan Embeddings G1 Text | `amazon.titan-embed-text-v1` | 1536 (fixed) | 1536 |
| Cohere Embed v4 | `cohere.embed-v4` **or** `cohere.embed-v4:0` ⚠️ | 256, 512, 1024, 1536 | 1536 |

⚠️ Titan G1's 1536 is stated in secondary sources rather than the model page I
read; I did not find it quoted on the primary page. Immaterial — we are not
using G1.

### 4.5 Throttling note ✅

> "Embedding models on Amazon Bedrock are throttled by Requests Per Minute
> (RPM), not Tokens Per Minute (TPM)."

Relevant to the M2 backfill: embedding 100 cases is 100 requests. Rate-limit the
seeder rather than firing them in parallel.

### 4.6 Not verified ❌

- **Model access must be explicitly enabled per-model, per-region** in the
  Bedrock console. SPEC §3 already flags this as a common day-one blocker. I
  cannot verify which models are available in which region without an account.
- Whether Bedrock's free/trial allowance covers our usage. Assume it does not
  and keep call volume low.
- The LLM (not embedding) model choice is deliberately left open until an
  account exists and `ListFoundationModels` can be called for real.

---

## 5. Decisions taken for this build

Recorded here so the DDL and the code have a traceable justification.

### 5.1 Embedding model: Titan Text Embeddings V2 at 1024 dimensions

- Available on Bedrock (satisfies the mandatory AWS component, load-bearing).
- 1024 is the model default — no reason to deviate.
- Retrieval-optimised, which is exactly our use case.
- `VECTOR(1024)` is unremarkable for CockroachDB.

`EMBEDDING_DIMENSIONS=1024` in `.env.example` and `VECTOR(1024)` in the schema
must stay in lockstep. Changing the model's dimension is a **migration**, not a
config edit. The config module enforces this at boot.

### 5.2 Distance metric: cosine (`<=>`, `vector_cosine_ops`)

Titan V2 normalizes output by default (`normalize` defaults to `true`). For
normalized vectors cosine and L2 rank identically, so this is partly a wash —
but cosine is the conventional choice for text-embedding similarity, is robust
if normalization is ever turned off, and stating the opclass explicitly in the
DDL means the index and the query operator cannot silently drift apart.

**The trap to avoid:** an index built with the default `vector_l2_ops` will not
accelerate a query written with `<=>`. Opclass and operator must match. The DDL
declares `vector_cosine_ops` and every query must use `<=>`.

### 5.3 Prefix column on the vector index

SPEC §5.1 wants precedent retrieval filtered to resolved cases only. Per §1.3
above, a prefix column is what makes that filter index-accelerated. The schema
therefore carries a denormalized, filterable status column on the embeddings
table and puts it in the index prefix.

Denormalizing costs a little consistency discipline; it buys a genuinely
index-accelerated hybrid query, which is the differentiator SPEC §5.1 asks to
show off. Documented in the DDL so it does not look accidental.

---

## 6. Open questions — resolve before writing dependent code

Ordered by how badly a wrong assumption would hurt.

1. ❌ Does a **free Basic cluster** actually create and use vector indexes?
   (§1.8) — blocks the entire retrieval design. Smoke-test first, before
   anything else.
2. ❌ Is `feature.vector_index.enabled` already `true`, or must it be set?
   (§1.8) — docs contradict each other.
3. ❌ Can a **free Basic org create a service-account API key** for the MCP
   server? (§2.5) — decides SPEC §7 option (a) vs (b).
4. ❌ Exact MCP transport and auth header format. (§2.5) — do not assume Bearer.
5. ❌ Bedrock model access enabled for `amazon.titan-embed-text-v2:0` in the
   chosen region. (§4.6)
6. ⚠️ Vector indexing's GA-vs-Preview status. (§1.8) — if still Preview, say so
   plainly in the README rather than overclaiming. Judges will know.

---

## 7. Sources

- CockroachDB — [VECTOR data type](https://www.cockroachlabs.com/docs/v26.2/vector)
- CockroachDB — [Vector Indexes](https://www.cockroachlabs.com/docs/stable/vector-indexes)
- CockroachDB — [CREATE INDEX](https://www.cockroachlabs.com/docs/stable/create-index)
- CockroachDB — [Cluster Settings](https://www.cockroachlabs.com/docs/stable/cluster-settings)
- CockroachDB — [Managed MCP Server for AI Agents](https://www.cockroachlabs.com/blog/cockroachdb-ai-agents-managed-mcp-server/)
- CockroachDB — [Pricing](https://www.cockroachlabs.com/pricing/)
- CockroachDB — [Plan a CockroachDB Basic Cluster](https://www.cockroachlabs.com/docs/cockroachcloud/plan-your-cluster-basic)
- CockroachDB — [Introducing Distributed Vector Indexing](https://www.cockroachlabs.com/blog/distributed-vector-indexing-cockroachdb/)
- AWS — [Amazon Titan Text Embeddings models](https://docs.aws.amazon.com/bedrock/latest/userguide/titan-embedding-models.html)
- AWS — [Titan Embeddings request/response](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-titan-embed-text.html)
- AWS — [Cohere Embed v4](https://docs.aws.amazon.com/bedrock/latest/userguide/model-parameters-embed-v4.html)
