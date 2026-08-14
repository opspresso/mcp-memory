/**
 * The entrypoint: read the environment, wire the layers, listen, and shut down
 * without dropping counters on the floor.
 *
 * Configuration is validated before anything binds a port, so a missing bucket
 * name stops a rollout at the readiness probe rather than surfacing as a tool
 * error inside somebody's agent run.
 */

import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { describeAuth } from "./auth.js";
import { ConfigError, loadConfig } from "./config.js";
import { KnowledgeBaseRetriever, knowledgeBaseInvoker } from "./docs.js";
import { BedrockEmbedder, bedrockInvoker, HttpEmbedder, type Embedder } from "./embeddings.js";
import { createMcpServer } from "./server.js";
import { S3MemoryService } from "./service.js";
import { createObjectStore } from "./store/objects.js";
import { StatsTracker } from "./store/stats.js";
import { createVectorStore } from "./store/vectors.js";
import { gracefulShutdown } from "./shutdown.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import { callTool, toolCatalogue } from "./tools.js";

/**
 * How long in-flight requests get before the counter flush runs regardless.
 *
 * Well inside Kubernetes' 30s default grace period: the point is to flush and
 * exit on our own terms rather than to be SIGKILLed mid-drain.
 */
const SHUTDOWN_GRACE_MS = 10_000;

let config;
try {
  config = loadConfig();
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(`configuration error: ${error.message}`);
    process.exit(1);
  }
  throw error;
}

const { store: vectors } = createVectorStore(config.region, config.vectorBucket, config.vectorIndex);
const { store: objects } = createObjectStore(config.region, config.stateBucket);

const stats = new StatsTracker(objects, {
  // Kubernetes sets HOSTNAME to the pod name. The random suffix distinguishes
  // one boot from the next, so a restarted pod never rewrites a shard its
  // previous life had already written — shards are append-only by construction.
  podId: `${process.env.HOSTNAME ?? hostname()}-${randomUUID().slice(0, 8)}`,
  flushMs: config.statsFlushMs,
  compactThreshold: config.statsCompactThreshold,
});
stats.start();

const embedder: Embedder =
  config.embedding.provider === "bedrock"
    ? new BedrockEmbedder({ ...config.embedding, invoke: bedrockInvoker(config.region) })
    : new HttpEmbedder(config.embedding);

const service = new S3MemoryService(
  vectors,
  objects,
  stats,
  embedder,
  config.recallMinSimilarity,
);

const docs = config.knowledgeBaseId
  ? new KnowledgeBaseRetriever({
      knowledgeBaseId: config.knowledgeBaseId,
      invoke: knowledgeBaseInvoker(config.region),
    })
  : undefined;

// Fixed for the process lifetime, which is what `initialize` promises with
// `listChanged: false`.
const catalogue = toolCatalogue(docs !== undefined);

const server = createMcpServer({
  config,
  tools: {
    definitions: () => catalogue,
    call: (tenant, name, args) => callTool(service, tenant, name, args, docs),
  },
});

server.listen(config.port, () => {
  console.log(`${SERVER_NAME} v${SERVER_VERSION} listening on :${config.port} (POST /mcp)`);
  console.log(
    `store: s3vectors://${config.vectorBucket}/${config.vectorIndex} ` +
      `(${config.embedding.provider}:${config.embedding.model}, ${config.embedding.dimension}d), ` +
      `state: s3://${config.stateBucket}`,
  );
  console.log(
    config.knowledgeBaseId
      ? `docs: bedrock-kb://${config.knowledgeBaseId} (search_docs offered)`
      : "docs: no KNOWLEDGE_BASE_ID — memories only, search_docs not offered",
  );
  // Always, not only when open: an operator reading logs to find out which mode
  // an instance is in should not have to infer it from a line that is missing.
  const notice = describeAuth(config.apiKey);
  if (config.apiKey) {
    console.log(notice);
  } else {
    console.warn(notice);
  }
});

// Counters are the only pod-local state worth saving, and a closed server is
// what stops anything still incrementing them — but not at the price of never
// flushing at all. See `shutdown.ts`.
const leave = gracefulShutdown(server, stats, {
  graceMs: SHUTDOWN_GRACE_MS,
  exit: (code) => process.exit(code),
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, leave);
}
