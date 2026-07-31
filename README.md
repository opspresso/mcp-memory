# mcp-memory

An MCP server that gives an Agent Studio project a memory that outlives a run.

| Tool | Takes | Returns |
|---|---|---|
| `recall(query, limit?, mode?)` | a question in natural language | matching memories, ranked, with a confidence level |
| `remember(content, type?, category?, tags?)` | a fact worth keeping | the id it was stored under, or the one it merged into |
| `list_memories(type?, limit?)` | — | this project's memories, newest first |
| `forget(id)` | an id from `recall` | confirmation, or that no such memory exists |
| `memory_stats()` | — | how many memories there are, by type |

It exists because every run starts from nothing. An agent that decided something
last week, or was told a convention, or worked out which command actually works,
has no way to know it now — so the user explains it again, or the agent guesses.

## Storage is S3, and only S3

Two buckets, no database.

**S3 Vectors** holds the memories. The body rides in the vector's own metadata,
so `recall` is one `QueryVectors` call — the text comes back with the distance,
and there is no second lookup to make.

**Ordinary S3** holds what changes: access counters, and one empty object per
memory whose key encodes the time so that listing it gives newest-first order.

A memory is written once and never updated. That is the load-bearing decision:
updating one would mean rewriting its vector, and two pods rewriting the same
vector is a lost update with no way to notice. Everything mutable was moved out
from under that constraint instead.

### Counters without a lock

S3 has no atomic increment, so nothing here modifies a shared object in place.
A pod accumulates counts in memory and periodically writes a **delta** to a key
only it will ever write. A reader sums `merged.json` and every shard above its
watermark — counts add, timestamps take the later — which converges regardless
of arrival order. When shards pile up, whichever request notices folds them in
with a compare-and-swap and advances the watermark.

The watermark is what makes that safe: a shard is never counted twice, even if
the pod that folded it died before deleting it, and even if two pods compact at
once. Deleting absorbed shards is garbage collection, not correctness.

```
s3://<VECTOR_BUCKET>/                      (S3 Vectors)
  index "memories"                          key: <tenant>#<ulid>
                                            filterable:     tenantId, memoryType, category
                                            non-filterable: content, createdAt, tags, trustBase

s3://<STATE_BUCKET>/
  index/<tenant>/<invertedTime>#<ulid>#<type>    empty; the key is the whole record
  stats/<tenant>/shard/<ulid>-<podId>.json      one pod-flush of counter deltas
  stats/<tenant>/merged.json                    folded counters + watermark
```

## Which memories a caller gets

**The tenant comes from the `X-Memory-Tenant` header and never from a tool
argument.** Agent Studio stores per-server headers encrypted and merges a
version's overrides in at dispatch, so the header is something an operator
configured. A tool argument is something the *model* chose — and a model that
can name its own tenant can read another project's memories by asking, including
a model that was talked into it by text it retrieved a moment earlier. No amount
of validation fixes that; the channel is wrong.

A request with no tenant is refused rather than defaulted, and `tools/list` is
refused too — so a missing header shows up the moment someone presses **Test
connection**, rather than as a working test button and a broken run later.

## What it does not do

Worth knowing before you rely on it:

- **Nothing is injected before a run.** A memory server would ideally put what
  it knows into the model's context *before* the first token, with no tool call
  to pay for — which is what MCP *resources* are for. Agent Studio reads
  `tools/list` and `tools/call` and nothing else, so there is no channel for it.
  The `recall` description asks the model to call it early, which is the only
  lever available. Adding `resources/*` support to Agent Studio would fix this
  properly, at the cost of a round trip on every run's first token.
- **Counters are approximate.** A pod that dies before its next flush takes up
  to `STATS_FLUSH_MS` of counts with it. They feed ranking and nothing else.
- **No automatic expiry.** S3 Vectors has no lifecycle rules, so nothing ages
  out on its own. `forget` is the only removal.
- **No keyword matching.** A query naming something the embedding does not
  associate — a library name, an error code — will not find it by that name
  alone. Catching those needs a full-text index, which S3 has no equivalent for.
- **No knowledge graph, contradiction detection, or consolidation.** A memory
  that contradicts an older one simply outranks it as the older one decays;
  nothing detects the conflict or reconciles the two.

## Configuration

| Variable | Default | |
|---|---|---|
| `VECTOR_BUCKET` | — | **required.** S3 Vectors bucket holding the memories |
| `VECTOR_INDEX` | `memories` | index within it |
| `STATE_BUCKET` | — | **required.** Ordinary S3 bucket for counters and the recency index |
| `EMBEDDING_PROVIDER` | `bedrock` | `bedrock` or `openai` |
| `EMBEDDING_MODEL` | `amazon.titan-embed-text-v2:0` | `text-embedding-3-small` under `openai` |
| `EMBEDDING_DIM` | `1024` | `1536` under `openai`. Must equal the index's dimension |
| `EMBEDDING_BASE_URL` | — | **required under `openai`.** OpenAI-compatible base |
| `EMBEDDING_API_KEY` | — | **required under `openai`** |
| `RECALL_MIN_SIMILARITY` | `0.1` | relevance floor — model-specific, see below |
| `AWS_REGION` | `ap-northeast-2` | |
| `PORT` | `3000` | |
| `MCP_API_KEY` | unset | when set, every request must present it as a bearer token |
| `STATS_FLUSH_MS` | `30000` | how often a pod pushes its counters |
| `STATS_COMPACT_THRESHOLD` | `20` | shard count past which a reader folds them in |

All of it is validated before the port is bound, so a missing bucket name stops
a rollout at the probe rather than surfacing inside somebody's agent run.

Bedrock is the default because it needs no API key — the pod's own role covers
it, so there is no secret to mount or rotate — and it runs in the same region as
the vector bucket, which takes an internet round trip off every recall.

### Calibrating the relevance floor

`RECALL_MIN_SIMILARITY` is the one number here that belongs to the embedding
model rather than to this server, and getting it wrong is quiet in both
directions: too high and every query answers "nothing is stored", too low and
unrelated memories come back as weak matches.

Measured on Titan v2 (normalised, 1024d), over real memories and queries:

| | cosine |
|---|---|
| correct answer to a question phrased differently | 0.15 – 0.41 |
| a different memory from the same project | 0.04 – 0.19 |
| a question about something not stored at all | < 0.05 |
| the same fact reworded | 0.72 |
| the same fact with a typo | 0.99 |

Hence `0.1`. **These numbers do not transfer between models** — a model whose
correct answers sit at 0.8 needs this raised to match. To recalibrate: embed a
handful of queries you know the answers to, plus a few you know are absent, and
put the floor between the two clusters.

Nothing else is model-specific. Which results come back above the floor is
decided by a *fraction of the top match*, and the ranking scales similarity the
same way, so both survive a model swap untouched.

### Authentication has two modes

With `MCP_API_KEY` set, every request must present it as `Authorization: Bearer
<key>`, compared in constant time. **With it unset, the server answers anyone
that can reach it.**

The open mode is the intended one here: a Deployment behind a ClusterIP with no
ingress, where the network is the boundary and a shared secret every pod already
reaches adds something to rotate without adding something it protects against.
That holds only while nothing routes to it from outside, so the process states
which mode it is in on every start. **If you expose it, set the key.**

Note that authentication and tenancy are different questions. The key says a
caller may talk to the server; the header says whose memories they get.

## Creating the vector index

Do this before the first deploy. **Dimension, distance metric and the
non-filterable metadata keys cannot be changed after creation** — changing any of
them means a new index and re-embedding everything, so they belong in IaC rather
than in a console session.

```bash
aws s3vectors create-vector-bucket --vector-bucket-name agent-studio-vector
aws s3vectors create-index \
  --vector-bucket-name agent-studio-vector \
  --index-name memories \
  --data-type float32 \
  --dimension 1024 \
  --distance-metric cosine \
  --metadata-configuration '{"nonFilterableMetadataKeys":["content","createdAt","tags","trustBase"]}'
```

`--dimension` is 1024 for Titan v2, 1536 for `text-embedding-3-small`. It must
match `EMBEDDING_DIM` and what the model actually returns; the server checks
every embedding against it and fails with that explanation rather than writing
something the index will reject.

The four non-filterable keys must be exactly those. They are where the body and
its provenance live, and the list cannot be changed once the index exists.

## Registering it with Agent Studio

The Service is cluster-internal, so its address resolves to a private IP that
Agent Studio's outbound guard blocks by default. `MCP_INTERNAL_HOST_SUFFIXES`
already carries `agent-mcps.svc.cluster.local` for the sibling servers, which is
what admits this one too.

1. **MCP servers → Add**
   - URL: `http://mcp-memory.agent-mcps.svc.cluster.local/mcp`
   - Header: `X-Memory-Tenant: <project name>`
   - Description: one line — it becomes a row in the model's system prompt
2. **Test connection.** A missing or malformed tenant header fails here, by design.
3. Bind it on the project version that should have a memory. A per-version
   header override can point one version at a different tenant.

Two projects that should share a memory get the same tenant; two that should not
must not. There is no per-user or per-chat scope — Agent Studio passes only
static headers, so the finest grain available is the project.

## Run

    VECTOR_BUCKET=… STATE_BUCKET=… EMBEDDING_BASE_URL=… EMBEDDING_API_KEY=… node dist/main.js

    POST /mcp      JSON-RPC; Authorization: Bearer <MCP_API_KEY> when a key is set
    GET  /health   liveness

AWS credentials come from the pod's role. Never bake keys into the image.

## Develop

    npm install
    npm run dev          # tsx, no build step
    npm run typecheck
    npm test

`typecheck` + `test` are the checks; `build` is the third.

S3 Vectors has no local emulator, so `src/testing/fakes.ts` stands in for both
stores and for the embedder. Its similarity scale is harsher than a real model's
— roughly the fraction of words two texts share — and fixtures have to be
written for that; the file documents the measured numbers.
