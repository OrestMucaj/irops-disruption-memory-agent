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

✅ **RESOLVED 2026-07-29 against a live free Basic cluster** (v26.2.1, AWS
us-east-1) — see §1.10. `feature.vector_index.enabled` is **already `true`**.
The Cluster Settings reference is correct and the Vector Indexes page's "you
must enable it" is preview-era text that should be ignored. No `SET CLUSTER
SETTING` is required, so the question of whether Basic permits it never arises.

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

### 1.10 Verified against a live cluster ✅

Everything above in §1 was read from documentation. This section is what a real
cluster actually did. Reproduce with `node --env-file=.env scripts/db-check.mjs`.

**Cluster:** `irops-memory`, Basic plan, AWS us-east-1, **CockroachDB CCL
v26.2.1** (built 2026/05/21).

| Question | Answer |
| --- | --- |
| Does a free Basic cluster do vector indexing? | **Yes.** No upgrade, no flag, no support ticket. |
| `feature.vector_index.enabled` default | **`true`** — the Vector Indexes page is stale (§1.8) |
| `VECTOR INDEX name (prefix, embedding opclass)` | **Parses and works.** The composition I inferred from two separate doc examples is valid; `001_init.sql` was correct as written. |
| Vector index on a **nullable** column | **Works**, and `INSERT ... VALUES (NULL)` is accepted — so `resolutions.embedding` stays nullable and the graceful-degradation design survives (§5.3 of the DDL). |
| Is the hybrid query index-accelerated? | **Yes** — see the plan below. |

**The query plan, which is the whole ballgame:**

```
• vector search
    table: case_embeddings@idx_case_embeddings_status_vec
    target count: 5
    prefix spans: [/'resolved' - /'resolved']
```

`prefix spans: [/'resolved' - /'resolved']` is the line that matters. The
structured filter is **pushed into the vector index as a span**, not applied as
a post-filter over an approximate-nearest-neighbour result set. That is exactly
the hybrid structured + semantic retrieval SPEC §5.1 asks for, and it is the
single strongest technical claim this project can make. It is now demonstrated
rather than hoped for.

**M1 exit criterion — met.** Four synthetic summaries embedded, stored, and
queried with a fifth unseen phrasing ("Flight delayed roughly three hours by
storms, dozens of passengers missing connections"):

```
weather-heavy    distance 0.6518   <- correctly nearest
crew-shortage    distance 0.8333
unrelated        distance 1.0000
```

An `open` case deliberately planted in the table did **not** appear in
`resolved`-only results, so the filter genuinely holds.

Dimension enforcement confirmed too: inserting `'[1,2,3]'` into a `VECTOR(1024)`
column is rejected with *"expected 1024 dimensions, not 3"*.

⚠️ **One thing to NOT act on.** The optimizer attaches this recommendation to
the plan:

> `CREATE INDEX ON defaultdb.public.case_embeddings (case_status) STORING (summary_text, embedding);`

**Ignore it.** The tables are empty, so the optimizer has no statistics; that
index would serve the `case_status` filter with an ordinary scan and defeat the
vector search entirely. Revisit only with real data and a measured comparison —
and be suspicious even then.

**On Preview vs GA:** still no official GA statement found (§1.8). But the
feature is enabled by default on a managed free-tier cluster, which is not how
Cockroach Labs treats preview features. Describe it in the README as working and
enabled by default; do not claim "GA" as though it were documented.

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

### 2.5 Connection mechanics — RESOLVED 2026-08-04 ✅

Source: [Connect to the CockroachDB Cloud MCP Server](https://www.cockroachlabs.com/docs/cockroachcloud/connect-to-the-cockroachdb-cloud-mcp-server)
(a dedicated quickstart that did not exist / was not found during the July
research; it supersedes the blog for mechanics).

- **Transport:** streamable HTTP. "HTTP transport is supported and recommended";
  "SSE transport is intentionally excluded (deprecated in MCP)".
- **Auth header, verbatim:** `"Authorization": "Bearer {your-service-account-api-key}"`.
- **Cluster scoping:** header `"mcp-cluster-id": "{your-cluster-id}"`. The
  cluster ID is the UUID in the console URL
  (`https://cockroachlabs.cloud/cluster/{id}/overview`).
- **RBAC, and this is the surprise:** an API-key service account "must have
  **'Cluster Admin' or 'Cluster Operator'** role on target clusters." There is
  **no read-only role option for MCP access**. The `mcp:read`/`mcp:write`
  scopes from the blog are OAuth scopes, not API-key scopes.

⚠️ **Consequence for the "read-only" claim.** With an API key, read-only cannot
be enforced by giving the account a read-only role — the platform requires
Operator/Admin. Read-only must therefore be enforced at the **client layer**:
our code only ever invokes tools from an explicit read-only allowlist
(`select_query`, `explain_query`, `get_table_schema`, `list_tables`,
`list_databases`) and refuses anything else even if the server offers it.
Choose **Cluster Operator** over Cluster Admin (the lesser of the two permitted
roles). Say all of this plainly in the README rather than implying a read-only
credential exists.

**Tools (from the quickstart):** read-only — `list_clusters`, `get_cluster`,
`list_databases`, `list_tables`, `get_table_schema`, `select_query`,
`explain_query`, `show_statement`, `show_running_queries`; write —
`create_database`, `create_table`, `insert_rows`.

**Operational limits that shape the analyst design:**
- one SQL statement per call, ≤16,384 chars; **20-second query timeout**
- **10 KiB response cap**; `SELECT` without `LIMIT` returns 25 rows; explicit
  `LIMIT` capped at 10,000
- blocked schemas: `system`, `crdb_internal`, `pg_catalog`,
  `information_schema`, `pg_extension`
- `explain_query` supports `SELECT`/`INSERT`/`CREATE TABLE` only; no
  `EXPLAIN ANALYZE`

So the analyst must instruct the model to always use LIMIT, keep result sets
small, and never query system schemas — the server enforces all three anyway,
but a model that knows the limits wastes fewer round trips.

### 2.6 Verified against the live server ✅ (2026-08-04)

Run `npm run check:mcp`. Confirmed on a **free Basic org**:

- **Service accounts and API keys exist on the free tier.** No paid-plan gate.
  This was the last fact deciding SPEC §7 option (a) vs (b).
- **The handshake works exactly as documented.** `initialize` →
  `notifications/initialized` → `tools/list` over streamable HTTP, with
  `Authorization: Bearer` and `mcp-cluster-id`. Server identifies as
  `cockroachdb-cloud 1.0.0`, protocol `2025-06-18`.
- **All 12 tools are offered**, read and write alike:
  `create_database`, `create_table`, `explain_query`, `get_cluster`,
  `get_table_schema`, `insert_rows`, `list_clusters`, `list_databases`,
  `list_tables`, `select_query`, `show_running_queries`, `show_statement`.

⚠️ **The write tools are exposed to our key.** This is the concrete proof of
what §2.5 predicted: because the platform requires Cluster Operator/Admin and
offers no read-only role, `insert_rows` and friends are on the wire whether we
want them or not. Read-only is a property of **our client**, not the credential.
The analyst's allowlist is therefore load-bearing security, not decoration.

**Real input schemas** (recorded so integration uses actual argument names —
note `query`, NOT `sql`, which is what a reasonable guess would have used):

```json
select_query:      { "required": ["database", "query"],
                     "properties": { "database", "query", "cluster_id" } }
get_table_schema:  { "required": ["database", "table"],
                     "properties": { "database", "table", "schema", "cluster_id" } }
```

`cluster_id` is described as "Required when the MCP config has no cluster_id;
otherwise must be omitted" — we send the `mcp-cluster-id` header, so it must be
omitted from arguments.

### 2.7 RBAC gotcha worth knowing ⚠️

Creating the service account and its API key is **not sufficient**. A key with
no cluster-scoped role authenticates cleanly, lists tools cleanly, and then
fails every data call with a bare `unauthorized`.

The tell is `list_clusters` returning `{"rows":[]}` — an empty list rather than
an error. The account is valid and can query; it simply has visibility of
nothing. `scripts/mcp-check.mjs` runs org-scope before cluster-scope precisely
to surface this distinction, because otherwise "bad key" and "no role" produce
identical symptoms.

**Fix:** Access Management → Service Accounts → the account → assign
**Cluster Operator** scoped to the *cluster*, not the organization. The role
applies to an existing key; regenerating is unnecessary.

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

✅ Titan G1's 1536 was initially secondary-sourced; since confirmed from the
model's own page in the Bedrock console: "The new Titan Embeddings G1 – Text
v1.2 can intake up to 8k tokens and outputs a vector of 1536". Immaterial to us
— we are using V2 at 1024 — but worth noting because `amazon.titan-embed-text-v1`
and `amazon.titan-embed-text-v2:0` are one character apart in the console and
produce vectors of **different widths**. Picking the wrong one means every
insert fails against `VECTOR(1024)`.

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

## 4A. Bedrock verified live (2026-07-29)

Reproduce: `npm run check:bedrock` and `node --env-file=.env scripts/bedrock-llm-check.mjs`.

### 4A.1 Embeddings ✅

`amazon.titan-embed-text-v2:0` in us-east-1, with a scoped IAM user granting only
`bedrock:InvokeModel`:

- 1024 dimensions returned, matching `VECTOR(1024)`.
- **L2 norm 1.000000** — confirms `normalize` defaults to true, as §4.1 said.
- cosine(weather text, similar weather text) = **0.575**;
  cosine(weather text, unrelated catering text) = **0.044**.
- No throttling on first call, so the Service Quota is **not** zero on a new
  account (closes the doubt left open in §6.6).

### 4A.2 Reasoning models — probed, not guessed ⚠️→✅

§4.3 records AWS's own docs disagreeing on a model ID, so candidates were probed
with a real Converse call rather than chosen from a page. In us-east-1:

| Model ID | Result |
| --- | --- |
| `amazon.nova-micro-v1:0` | OK, 684ms, strict JSON |
| `amazon.nova-lite-v1:0` | OK, 740ms, strict JSON |
| `amazon.nova-pro-v1:0` | OK, 706ms, strict JSON |
| `us.amazon.nova-*-v1:0` | AccessDeniedException |
| `anthropic.claude-3-5-haiku-*` | ResourceNotFoundException |

Anthropic models need the one-time use-case form first, which had not been
submitted. The `us.*` inference profiles are denied by the region-scoped IAM
policy — expected, not a problem.

**Chosen: `amazon.nova-lite-v1:0`.** The probe recommended Micro on latency, but
all three respond in ~700ms and the task is multi-document reasoning over
precedent, where the smallest model is the wrong economy. Cost difference is
fractions of a cent (§6.3).

### 4A.3 Converse, not InvokeModel ✅

Verified against the AWS API reference:

```
request  { messages: [{ role, content: [{ text }] }], system: [{ text }],
           inferenceConfig: { maxTokens, temperature, topP, stopSequences } }
response { output: { message: { content: [{ text }], role } },
           stopReason, usage: { inputTokens, outputTokens, totalTokens } }
```

Converse gives one request shape across every model, so changing model is a
config edit rather than a rewrite, and it reports token usage uniformly — which
`agent_runs` needs to be real cost data instead of decoration.

`stopReason` is checked explicitly. `max_tokens` means the JSON is truncated and
a retry would truncate identically, so it raises its own error rather than
surfacing twice as a misleading "not valid JSON".

### 4A.4 Real embeddings scored WORSE than the fake one, and why ⚠️

This is the most useful thing measured today, so it is recorded in full.

First run against Titan, on a corpus whose `summary_text` had only ever been
tested against the lexical fake provider:

| Axis | Fake (feature hashing) | Titan | |
| --- | --- | --- | --- |
| same cause | 71.3% | 61.3% | |
| same severity | 65.0% | 55.0% | |
| same recovery window | 70.5% | **27.8%** | **chance** |

The recovery-window signal — the most decision-relevant fact about a disruption —
collapsed to exactly chance.

**Cause:** `summary_text` had been accidentally tuned to token overlap. The
window sat at sentence 5 of 6, behind a sentence of flight number, route and
aircraft type that is near-identical across all 84 cases. A lexical matcher does
not care about position or dilution; a semantic model very much does.

**Fix:** lead with an operational-signature sentence carrying every
discriminator, state the window's consequence again in its own sentence, and
demote flight/route to last. After re-embedding:

| Axis | Before | After |
| --- | --- | --- |
| same cause | 61.3% | 56.0% |
| same severity | 55.0% | 54.8% |
| same recovery window | **27.8%** | **42.8%** |

Window moves from 1.00× to 1.54× lift; cause gives up some ground. All three
now clear the bar.

⚠️ **Do not read this table as "the fake embedder is better than Titan."** The
metric scores agreement on *labels that are literally words in the text*, which
is the one thing lexical matching is unbeatable at. Titan generalises to
paraphrases the fake provider cannot see at all — which is what matters for a
real disruption typed in by an ops controller rather than generated by our own
template. The benchmark flatters the fake by construction.

**The transferable lesson:** an embedding-quality result on synthetic data
whose text you also wrote is partly a measurement of your own template. Re-check
retrieval quality whenever `summary_text` changes, and never assume a change
that helps one embedder helps another.

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

## 6. Cost, quota, and eligibility — the deployment constraint

Added 2026-07-29 after the organizers ruled on AWS credits in the Devpost
discussion forum. This section decides whether the Bedrock dependency in
SPEC §3 survives contact with a zero-budget deployment.

### 6.1 What the organizers said ✅

Michelle Brain (organizer), Devpost discussion forum:

> "We currently do not have AWS Credits to distribute for participants so please
> first work with the Free account provided by AWS. AWS Bedrock is the only
> service we are aware of on the list provided that lacks a free tier. The
> workaround the team has found is to use Ollama, which is straightforward and
> free to run. The models are smaller but still reasonably capable for demos."

And, materially for cost:

> "the submission form questions on the submission step called 'Additional Info'
> will only show to the judges. Add your functional app link to those questions
> only to avoid outside usage."

Three consequences:
- No hackathon credits, and the organizers are right that Bedrock has no free tier.
- **The demo URL is judge-only.** Traffic is bounded to a handful of judges over
  Aug 19 – Sep 15, not the open internet. That bounds cost enormously.
- Ollama is the organizers' suggested workaround.

### 6.2 AWS's own new-account credits ⚠️ — the organizers' answer is incomplete

There are no *hackathon* credits. That is true and it is not the whole picture:
AWS restructured its Free Tier on 15 July 2025, and new accounts now get credits
directly from AWS.

> "Starting July 15, 2025, new AWS customers will receive up to $200 in AWS Free
> Tier credits"

$100 on sign-up, plus a further $100 for completing activities — and **Amazon
Bedrock is explicitly named among the qualifying activity services**, as is AWS
Budgets.

The free account plan "expires after 6 months or when you exhaust your credits,
whichever comes first." Signing up on 2026-07-29 covers the Aug 19 – Sep 15
judging window with about four months to spare.

⚠️ This applies to accounts created **after** 15 July 2025. An older account sits
in the legacy programme (12-month trials plus always-free tier) and gets no $200.
Since no AWS account exists yet, we qualify for the new programme — but only if
the account is genuinely new.

### 6.3 What Bedrock actually costs at our volume ✅

Verified on-demand prices:

| Model | Price |
| --- | --- |
| Titan Text Embeddings V2 | $0.02 per million tokens |
| Amazon Nova Lite | $0.06 per million input tokens, $0.24 per million output |

Estimate for the entire project — build, demo, and the full judging window:

| Workload | Volume | Cost |
| --- | --- | --- |
| Embeddings (100 seed cases + ~500 dev/demo) | ~120K tokens | ~$0.002 |
| Agent runs (~500 runs × 3K in / 600 out, Nova Lite) | 1.5M in, 300K out | ~$0.16 |
| **Total** | | **under $1** |

Ten times these volumes still lands under $2, against $100–200 of credits. The
"surprise bill" fear is reasonable in principle and negligible in magnitude for
a workload this small.

⚠️ Volumes are my estimates, not measurements. The prices are verified; the token
counts are guesses that will not be real until M3 runs. Amazon Nova Micro is
text-only and cheaper still — I did not verify its price.

### 6.4 Ollama would cost more here, not less ⚠️

For heavy inference the organizers' advice is sound. At our volume it inverts:

- Ollama must run somewhere the deployed Lambda can reach. Ollama on a laptop
  cannot serve a demo URL that has to stay up from Aug 19 to Sep 15.
- On AWS that means an always-on instance through judging. A small CPU instance
  is roughly $12–15/month; anything with a GPU is far more.
- That trades a ~$0.20 *variable* cost for a ~$20–40 *fixed* cost, and pays for
  it again in CPU-inference latency and a weaker model.

**Decision: stay on Bedrock.** Keep Ollama as a documented fallback for the one
scenario where it genuinely wins — see §6.6.

### 6.5 The always-on cost concern does not apply to this architecture ✅

The forum thread prices an always-on demo at $30–50/month, based on ECS/Fargate
plus an Application Load Balancer. SPEC §3 already specifies **Lambda + S3**,
which behaves differently:

> "The free tier provides 1M requests per month for AWS Lambda. The always-free
> tier is available under both the new Free Tier program and the legacy Free
> Tier program."

- A Lambda **Function URL** has no hourly charge, unlike an ALB or API Gateway.
- Idle costs nothing — scale-to-zero is the entire point.
- S3 static hosting for three small views is cents.

The architecture chosen before this ruling already sidesteps the problem. Say so
explicitly in the README: it reads as a production-readiness decision, which is
a judging criterion, not merely as budgeting.

### 6.6 Model access — resolved, and it is a non-issue ✅

**Superseded 2026-07-29 (same day).** This section previously treated Bedrock
model-access approval as the longest-lead item in the project, based on a
participant's report in the forum thread:

> "New accounts also start with model throughput quotas at zero until you request
> an increase, which takes time to approve."

**That is stale.** AWS changed it in October 2025:

> "Amazon Bedrock now provides immediate access to all serverless foundation
> models by default for users in all commercial AWS regions. This update
> eliminates the need for manually activating model access"

> "Access to all Amazon Bedrock foundation models is enabled by default with the
> correct AWS Marketplace permissions."

Confirmed against the live console: there is no longer a "Model access → Modify
model access" request page. Serverless models are simply listed in a **Model
catalog** and are invocable.

**One exception, and it matters if we want Claude as a fallback:**

> "Anthropic models, although enabled by default, still require you to submit a
> one-time usage form before first use."

Per account, once. Amazon's own models — Titan and Nova, which is what we
actually chose — need nothing.

⚠️ **Access is not the same as quota.** The change above removes the *access*
request. It says nothing about per-account Service Quotas for InvokeModel
requests-per-minute, which may still be low on a new account. Do not assume the
forum poster was wrong about quotas just because they were wrong about access.

❌ **The only real verification is an API call.** The console cannot tell you
whether your IAM principal can actually invoke a model in your region at your
quota. Per SPEC §1.2 this needs a smoke test, not a screenshot.

**Remaining mitigation:**
1. Set an AWS Budgets alert at a few dollars on day one. Still worth it — and
   AWS Budgets is one of the credit-earning activities (§6.2).
2. Ollama stays as the documented fallback behind the existing provider
   interfaces, but the scenario it was insuring against has largely evaporated.

Note that dropping Bedrock does **not** break eligibility: SPEC §7 requires ≥1
AWS service, and Lambda + S3 are two. Bedrock is what makes the AWS involvement
*load-bearing* rather than decorative, which is a scoring matter, not a
qualifying one.

---

## 7. Open questions — resolve before writing dependent code

Ordered by how badly a wrong assumption would hurt.

1. ~~Does a **free Basic cluster** actually create and use vector indexes?~~
   ✅ **RESOLVED 2026-07-29 — yes**, and the hybrid filter is a genuine index
   prefix span, not a post-filter (§1.10). The project's biggest risk is gone.
2. ~~Is `feature.vector_index.enabled` already `true`?~~ ✅ **RESOLVED — it is
   `true` by default.** The Vector Indexes page is stale (§1.8, §1.10).
3. ❌ Can a **free Basic org create a service-account API key** for the MCP
   server? (§2.6) — the last fact deciding SPEC §7 option (a) vs (b).
4. ~~Exact MCP transport and auth header format.~~ ✅ **RESOLVED 2026-08-04**
   — streamable HTTP; `Authorization: Bearer <key>` + `mcp-cluster-id` header;
   service account needs Cluster Operator/Admin (no read-only role exists, so
   read-only is enforced by our client-side tool allowlist). §2.5.
5. ❌ Bedrock model access enabled for `amazon.titan-embed-text-v2:0` in the
   chosen region. (§4.6)
6. ⚠️ Vector indexing's GA-vs-Preview status. (§1.8, §1.10) — no official GA
   statement found, but it ships enabled by default on managed free-tier
   clusters. README should say "works, enabled by default", not "GA".
9. ~~Whether `VECTOR INDEX (prefix, embedding opclass)` parses, and whether a
   vector index tolerates NULLs.~~ ✅ **RESOLVED — both work** (§1.10).
7. ~~Bedrock model-access approval time.~~ **Resolved 2026-07-29** — AWS
   auto-enables serverless models since Oct 2025; there is nothing to request
   (§6.6). What remains unverified is the *Service Quota* for InvokeModel RPM on
   a new account, which only an API call can answer. ❌
8. ❌ Whether the AWS account qualifies for the post-15-July-2025 $200 credit
   programme. (§6.2) — it should, being new, but confirm at sign-up rather than
   assuming.

---

## 8. Sources

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
- AWS — [Amazon Bedrock pricing](https://aws.amazon.com/bedrock/pricing/)
- AWS — [Amazon Nova pricing](https://aws.amazon.com/nova/pricing/)
- AWS — [Free Tier update: up to $200 in credits](https://aws.amazon.com/blogs/aws/aws-free-tier-update-new-customers-can-get-started-and-explore-aws-with-up-to-200-in-credits/)
- AWS — [Free Tier FAQs](https://aws.amazon.com/free/free-tier-faqs/)
- AWS — [Lambda pricing](https://aws.amazon.com/lambda/pricing/)
- Devpost — [Hackathon discussion forum](https://cockroachdb-ai.devpost.com/forum_topics) (organizer ruling on credits, §6.1)
