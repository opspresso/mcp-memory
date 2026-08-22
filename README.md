# mcp-memory

An MCP server that gives an Agent Studio project a memory that outlives a run.

| Tool | Takes | Returns |
|---|---|---|
| `recall(query, limit?, mode?)` | a question in natural language | matching memories, ranked, with a confidence level |
| `remember(content, type?, category?, tags?, scope?)` | a fact worth keeping — for the project, or with `scope: "conversation"` for this conversation alone | the id it was stored under, or the existing one that already said it |
| `list_memories(type?, limit?)` | — | this project's memories, newest first |
| `forget(id)` | an id from `recall` | confirmation, or that no such memory exists |
| `memory_stats()` | — | how many memories there are, by type; a lower bound past 10,000 |
| `search_docs(query, limit?)` | a question in natural language | matching documentation excerpts with their sources — offered only when `KNOWLEDGE_BASE_ID` is set |

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

It also trails by a minute, which is what stops a shard being counted *zero*
times. A key is stamped when the flush builds it rather than when S3 accepts
it, so a line drawn across everything currently visible can land above a write
still in flight — and a pod whose clock runs behind mints low keys every time,
turning that race into a pattern. Only shards older than the lag are absorbed,
so any write that lands within a minute of being stamped is still counted.

```
s3://<VECTOR_BUCKET>/                      (S3 Vectors)
  index "memories"                          key: <tenant>#<ulid>
                                            filterable:     tenantId, memoryType, category,
                                                            scope (only "conversation"), conversation
                                            non-filterable: content, createdAt, tags, trustBase

s3://<STATE_BUCKET>/
  index/<tenant>/<invertedTime>#<ulid>#<type>[#<conversationDigest>]
                                                 empty; the key is the whole record —
                                                 the digest only on a conversation-scoped memory
  stats/<tenant>/shard/<ulid>-<podId>.json      one pod-flush of counter deltas
  stats/<tenant>/merged.json                    folded counters + watermark
```

## Which memories a caller gets

**The tenant comes from a header and never from a tool argument** — an explicit
`X-Memory-Tenant`, or the `X-Tenant-Id` header Agent Studio stamps on
every MCP request when no explicit one is configured (explicit wins). Agent Studio stores per-server headers encrypted and merges a
version's overrides in at dispatch, so the header is something an operator
configured. A tool argument is something the *model* chose — and a model that
can name its own tenant can read another project's memories by asking, including
a model that was talked into it by text it retrieved a moment earlier. No amount
of validation fixes that; the channel is wrong.

The handshake and `tools/list` do not need a tenant: they describe the server,
not anyone's memories. The tenant is resolved when a tool runs, and a call with
neither header is refused rather than defaulted.

The value itself is held to at most 128 characters, starting with a letter or a
digit and otherwise carrying only letters, digits, `.`, `_` and `-`. It lands in
an S3 key path and in an S3 Vectors filter value, so what it may hold is the
intersection of the two rather than what either would tolerate alone. A header
sent twice is refused as well: which of the values was meant is not something to
guess at when guessing wrong picks another project's memories.

### And which conversation is asking

A second header rides beside the tenant when the caller is in a conversation:
`X-Conversation-Id`, which Agent Studio stamps on every MCP request a run makes
from a chat (`chat:{id}`), a Slack thread (`slack:{channel}:{thread}`), an
inbound A2A call (`a2a:{client}:{contextId}`) or an API caller that declared
one (`api:{caller}:{id}`). Same rules for the same reason: from a header, never
from a tool argument, so a model cannot name a conversation it is not in.

What it changes:

- **`remember` takes a `scope`.** `project` (the default, and what every memory
  written before scopes existed is) is shared by every conversation of the
  tenant. `conversation` is this conversation's alone — a preference stated in
  one thread, a working note — and is recalled, listed and de-duplicated only
  where the same `X-Conversation-Id` asks. Asking for it on a request that is in
  no conversation is refused by name, never silently filed under the project.
- **A project memory written from a conversation records which one**, as
  provenance. Its visibility is not narrowed.
- **`recall` and `list_memories` answer with the project's memories plus this
  conversation's own.** Another conversation's scoped notes never reach the
  model — not in the results, not in the "gated out" count, and not as the
  "already known" answer to a `remember`. The store's own filter stays the one
  tenant key it has always been; visibility is applied on the way out.

The header is optional. A request without one — a probe, a **Test connection**,
a webhook firing, an API call that declared no conversation — reads and writes
project memories exactly as before, and simply cannot see or write
conversation-scoped ones. A malformed one (whitespace, non-ASCII, over 512
characters, sent twice) is refused rather than read as "no conversation".

Two things the key deliberately is not. It is not a *person*: the same thread
may hold several people, and a note kept for it is kept for the thread. And it
is not a ranking signal: a project memory recalled from the conversation that
stored it scores exactly as it does anywhere else — provenance is recorded,
never weighed.

## What it does not do

Worth knowing before you rely on it:

- **Nothing is injected by this server before a run.** A memory server would
  ideally put what it knows into the model's context *before* the first token,
  with no tool call to pay for — which is what MCP *resources* are for, and
  Agent Studio reads `tools/list` and `tools/call` and nothing else. What
  exists instead lives on the platform's side: a version that opts into
  `memoryRecall` has the *run* call `recall` with the newest user turn before
  the first token and put the answer in the system prompt. From here that is an
  ordinary `recall` — one call per run, with the run's tenant and conversation
  on it — and the `recall` description still asks the model to call it early
  for the versions that did not opt in.
- **Counters are approximate.** A pod that dies before its next flush takes up
  to `STATS_FLUSH_MS` of counts with it, and a pod re-reads the durable counts
  only once a minute, so another pod's flush reaches this one's ranking that
  much later — its own reads are counted immediately either way. They feed
  ranking and nothing else.
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
| `KNOWLEDGE_BASE_ID` | unset | Bedrock Knowledge Base behind `search_docs`; unset, the tool is not offered at all |
| `EMBEDDING_PROVIDER` | `bedrock` | `bedrock` or `openai` |
| `EMBEDDING_MODEL` | `amazon.titan-embed-text-v2:0` | `text-embedding-3-small` under `openai` |
| `EMBEDDING_DIM` | `1024` | `1536` under `openai`. Must equal the index's dimension |
| `EMBEDDING_BASE_URL` | — | **required under `openai`.** OpenAI-compatible base |
| `EMBEDDING_API_KEY` | — | **required under `openai`** |
| `RECALL_MIN_SIMILARITY` | `0.1` | relevance floor, in (0, 1] — model-specific, see below |
| `AWS_REGION` | `ap-northeast-2` | |
| `PORT` | `3000` | |
| `MCP_API_KEY` | unset | when set, every request must present it as a bearer token |
| `STATS_FLUSH_MS` | `30000` | how often a pod pushes its counters |
| `STATS_COMPACT_THRESHOLD` | `20` | a reader folds shards in once more than this many are *older than the lag* |

All of it is validated before the port is bound, so a missing bucket name stops
a rollout at the probe rather than surfacing inside somebody's agent run.

Bedrock is the default because it needs no API key — the pod's own role covers
it, so there is no secret to mount or rotate — and it runs in the same region as
the vector bucket, which takes an internet round trip off every recall.

### Calibrating the relevance floor

`RECALL_MIN_SIMILARITY` is the one model-specific number a deployment sets —
there is a second one compiled in, below — and getting it wrong is quiet in both
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

Zero is refused rather than accepted, and the process stops at boot if it is
set. A floor of zero admits every hit, and confidence is expressed as a multiple
of the floor — so every result, however remote, would reach the model labelled
HIGH CONFIDENCE.

Ranking survives a model swap untouched. Which results come back above the floor
is decided by a *fraction of the top match*, and the composite scales similarity
the same way, so neither carries an absolute cosine.

### The other cosine, and why it is not configurable

`remember` treats a new memory as already known above **0.92**, which on the
table above sits between the same fact reworded and the same fact with a typo —
so only near-verbatim repetition merges. That number is compiled in, not an
environment variable, and the reason is worth stating because it cuts against
the floor above.

Declining to write is *silent*: the caller is told the fact is already known,
and the fact is never stored. A knob that guards a silent failure is a knob
nobody knows to turn — an operator tunes the recall floor because bad recall is
visible, but nothing shows them a memory that was never written. So dedup does
not rely on the cosine alone. It also requires the two texts to share half their
words, which no embedding model gets a vote on: under a model whose
similarities are compressed into a narrow band, two unrelated facts can clear
0.92, and the wording is what stops them merging.

The consequence is that a model swap does not require re-measuring this the way
it requires re-measuring the floor. The failure it can still produce is a
duplicate rather than a lost memory, which is the direction worth failing in.

### What a single call may carry

Compiled in rather than configurable, and written down here because a refused
`remember` otherwise sends someone reading source:

| | |
|---|---|
| `content` | 32,000 bytes |
| `category` | 128 bytes |
| `tags` | 20 entries, 64 bytes each |
| `query` on `search_docs` | 1,000 characters |
| `limit` on `recall`, `list_memories` and `search_docs` | 1 – 50 |

Bytes rather than characters for the three that reach a vector, because the
ceiling underneath them is measured that way: 40 KB of metadata per vector, of
which the filterable half — where `category` lands — is 2 KB. The `search_docs`
query is the exception, counted in characters because that is how the Retrieve
API counts it. All of it is checked before anything is sent, so a model that
overshoots is told which field to shorten instead of getting a size back from
AWS that names neither the field nor the limit.

`memory_stats` has a ceiling of its own: it counts index keys and stops at
10,000, past which it reports a lower bound and says so. `search_docs` has one
on the way out rather than in: an excerpt is cut at 2,000 characters, with a
note saying so and pointing at the source. How large a chunk is belongs to the
knowledge base's ingestion and not to this server, and a generously-chunked
library could otherwise spend a run's context on a single call.

Omitted arguments have compiled-in answers too. `recall` takes a mode —
**precision** for few, closely-matching results, **balanced** (the default) for
the usual trade-off, **exploratory** for more results on looser matching, which
is what to reach for when a balanced search found nothing — and an omitted
`limit` is whatever that mode allows: 3, 5 and 10 respectively. `list_memories`
returns 20, and `search_docs` 5, the knowledge base's own default.

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

## The documentation library (optional)

Setting `KNOWLEDGE_BASE_ID` adds a sixth tool, `search_docs`, backed by a
Bedrock Knowledge Base. Unset, the tool is not offered — not listed, not
callable — and the SDK behind it is never loaded.

The knowledge base is created outside this repo, like the vector index, and the
division of labour is strict: the KB owns its own S3 Vectors index (which may
live in the same vector bucket, under a different index name) and its own
ingestion — chunking, embedding, and syncing whatever S3 bucket holds the source
documents. This server only queries it, over the `Retrieve` API. The KB embeds
the query itself with whatever model it was built on, so the `EMBEDDING_*`
settings play no part and cannot mismatch it.

Two things the deployment must line up:

- The pod's role needs `bedrock:Retrieve` on the knowledge base's ARN.
- The KB must live in `AWS_REGION` — the server uses one region for everything.

Unlike the memories, the library is **shared across all tenants**. A tenant
header is still required on every request, but it does not filter documents;
two projects with different tenants search the same library.
Memories remain strictly per-tenant.

## Registering it with Agent Studio

The Service is cluster-internal, so its address resolves to a private IP that
Agent Studio's outbound guard blocks by default. `MCP_INTERNAL_HOST_SUFFIXES`
already carries `agent-mcps.svc.cluster.local` for the sibling servers, which is
what admits this one too.

1. **MCP servers → Add**
   - URL: `http://mcp-memory.agent-mcps.svc.cluster.local/mcp`
   - Description: one line — it becomes a row in the model's system prompt
   - No tenant header needed: Agent Studio stamps every MCP request with
     `X-Tenant-Id: <project name>`, and this server reads it when no
     explicit `X-Memory-Tenant` is configured — each project lands in its own
     tenant with zero per-project setup.
2. **Test connection and the capability-catalog probe can list the tools.** They
   carry no project and therefore no tenant, but discovery is not a memory
   operation. A tool call without either tenant header is still refused; a bound
   project run carries the automatic header.
3. Bind it on the project version that should have a memory.

To *share* one memory across projects — or point one version at a different
bucket — set `X-Memory-Tenant` explicitly (on the entry, or as a per-version
header override); an explicit tenant always wins over the automatic project
name. There is no per-user scope. Conversation scope is automatic when Agent
Studio supplies `X-Conversation-Id`; the tenant override changes only which
project-level memory bucket is used.

## Run

Bedrock, the default — the pod's role covers the embeddings, so there is nothing
else to pass:

    VECTOR_BUCKET=… STATE_BUCKET=… node dist/main.js

An OpenAI-compatible endpoint instead. `EMBEDDING_PROVIDER` is what selects it;
without that the other two are read by nobody and the process still calls
Bedrock:

    EMBEDDING_PROVIDER=openai EMBEDDING_BASE_URL=… EMBEDDING_API_KEY=… \
      VECTOR_BUCKET=… STATE_BUCKET=… node dist/main.js

    POST /mcp      JSON-RPC; Authorization: Bearer <MCP_API_KEY> when a key is set
    GET  /health   liveness

The protocol is served by `@modelcontextprotocol/server`, which answers **both
eras from that one endpoint**: a client opening with `server/discover` gets
revision `2026-07-28`, one opening with the `initialize` handshake is served
statelessly as before. The server holds nothing between requests either way.
Requests carrying an `Origin` header are refused with 403: this cluster-internal
endpoint has no browser caller, and Streamable HTTP requires that boundary
against DNS rebinding.

The tenant header is this server's own, and it is read when a tool runs rather
than when a client connects: the handshake says what this server is, which is
true whoever is asking, so a client that connects lazily is not told about a
header problem before it has asked for anything. A call without the header comes
back as a tool error naming the header to set.

AWS credentials come from the pod's role. Never bake keys into the image.

The process logs one JSON line per event. Every tool call leaves a `tool_call`
line on stdout — the tool, the tenant, how long it took and whether it answered
(`ok`) — and a failure that reaches a tool is written to stderr as well, so an
outage shows up in the pod's logs and not only inside somebody's agent run.
Neither carries memory content or a recall query: a failing dependency is
identified by the tool and the tenant, not by what was being remembered.

    {"level":"info","event":"tool_call","tenant":"demo","tool":"recall","ms":312,"ok":true}
    {"level":"error","event":"tool_failed","message":"…","tenant":"demo","tool":"recall"}

## Develop

Node 24 or newer — `package.json` requires it, and the image and CI both run it.

```bash
npm install
npm run dev          # tsx, no build step
npm run typecheck
npm test
```

`typecheck` + `test` are the checks; `build` is the third.

S3 Vectors has no local emulator, so `src/testing/fakes.ts` stands in for both
stores and for the embedder. Its similarity scale is harsher than a real model's
— roughly the fraction of words two texts share — and fixtures have to be
written for that; the file documents the measured numbers.

### Releasing

A release is a tag, and everything else follows from it: CI runs the checks,
cuts a GitHub release whose notes are the commit subjects since the previous tag
bar the release commit itself, pushes the image to ECR and GHCR, and dispatches
to the GitOps repository, which is what puts it on alpha.

```bash
npm version 0.4.3 --no-git-tag-version
git add package.json package-lock.json src/server.ts
git commit -m "chore: release v0.4.3"
git tag v0.4.3
git push origin main v0.4.3
```

The version is written in three places — `package.json`, its lock file, and
`SERVER_VERSION` in `src/server.ts`, which is what a client is told it connected
to. `npm version` moves all three, the third through `scripts/sync-version.mjs`
on npm's `version` hook, and the check in `src/server.test.ts` fails the build if
they ever part company. `--no-git-tag-version` leaves the commit and the tag to
the lines below it, so the history reads `chore: release …` rather than npm's
bare version.
