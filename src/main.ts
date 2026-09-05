/**
 * The entrypoint: read the environment, wire the layers, listen, and shut down
 * cleanly.
 *
 * Configuration is validated before anything binds a port, so a missing database
 * URL — or a database that cannot be reached — stops a rollout at the
 * readiness probe rather than surfacing as a tool error inside somebody's
 * agent run.
 */

import { describeAuth } from "./auth.js";
import { ConfigError, loadConfig } from "./config.js";
import { BedrockEmbedder, bedrockInvoker, HttpEmbedder, type Embedder } from "./embeddings.js";
import { createMcpServer } from "./server.js";
import { MemoryManager } from "./service.js";
import { openPgStore } from "./store/pg.js";
import { gracefulShutdown } from "./shutdown.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import { callTool, TOOLS } from "./tools.js";

/**
 * How long in-flight requests get before the process exits regardless.
 */
const SHUTDOWN_GRACE_MS = 10_000;

/**
 * An error's message, reaching inside an `AggregateError` for it: a refused
 * connection to `localhost` is one of those — one failure per address the
 * name resolved to — and its own message is empty.
 */
function describeError(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    return error.errors.map(describeError).join("; ");
  }
  if (error instanceof Error) {
    return error.message || (error as { code?: string }).code || error.name;
  }
  return String(error);
}

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

// Before the port is bound, like the configuration: a database this process
// cannot reach, or a schema it may not create, is a failed boot and not a
// pod that answers the health probe and fails every tool call.
const store = await openPgStore(config.databaseUrl).catch((error: unknown) => {
  console.error(`storage error: ${describeError(error)}`);
  return process.exit(1);
});

const embedder: Embedder =
  config.embedding.provider === "bedrock"
    ? new BedrockEmbedder({ ...config.embedding, invoke: bedrockInvoker(config.region) })
    : new HttpEmbedder(config.embedding);

const service = new MemoryManager(store.memories, embedder, config.recallMinSimilarity);

const server = createMcpServer({
  config,
  tools: {
    definitions: () => TOOLS,
    call: (context, name, args) => callTool(service, context, name, args),
  },
});

server.listen(config.port, () => {
  console.log(`${SERVER_NAME} v${SERVER_VERSION} listening on :${config.port} (POST /mcp)`);
  console.log(
    `${store.description} ` +
      `(${config.embedding.provider}:${config.embedding.model}, ${config.embedding.dimension}d)`,
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

const leave = gracefulShutdown(server, {
  graceMs: SHUTDOWN_GRACE_MS,
  // Pool shutdown never stands between the process and its exit: a connection
  // that will not close is not worth another grace period.
  exit: (code) => {
    void store
      .close()
      .catch(() => {})
      .finally(() => process.exit(code));
  },
});
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, leave);
}
