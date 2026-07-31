/**
 * Everything this server reads from its environment, validated once at boot.
 *
 * Fail-fast rather than on first use: a missing bucket name should stop a
 * rollout at the readiness probe, not surface as a tool error inside somebody's
 * agent run half an hour later.
 *
 * The set is deliberately small. Every knob here is a way for two deployments
 * to behave differently for a reason nobody wrote down, so the scoring weights,
 * thresholds and half-lives are constants in `ranking.ts` rather than
 * environment variables. What remains is what a deployment genuinely has to
 * say: where its buckets are, how to embed, and who may call it.
 */

export interface Config {
  port: number;
  /** Shared secret callers must present. Unset means no authentication — see `auth.ts`. */
  apiKey: string | undefined;
  region: string;
  /** S3 Vectors bucket holding the memories themselves. */
  vectorBucket: string;
  vectorIndex: string;
  /** Ordinary S3 bucket holding the access counters and the recency index. */
  stateBucket: string;
  embedding: EmbeddingConfig;
  /**
   * The cosine similarity below which a hit is not relevant to the query at all.
   *
   * The only model-specific number a deployment configures, and configurable
   * for exactly that reason. It is not quite the only one that exists: dedup in
   * `service.ts` compares against a compiled-in cosine too, which is why it
   * takes a model-independent second opinion before it acts on it.
   *
   * Measured on Titan v2 (normalised, 1024d): a correct answer
   * scores 0.15–0.41, an unrelated one under 0.05. A model whose correct
   * answers sit at 0.8 needs this raised to match, or every query looks
   * relevant; one whose scores are lower needs it dropped, or none do.
   *
   * To recalibrate: embed a handful of queries you know the answers to, plus a
   * few you know are absent, and put this between the two clusters.
   */
  recallMinSimilarity: number;
  /** How often a pod pushes its accumulated counters to its own shard. */
  statsFlushMs: number;
  /** Shard count past which a reader compacts them into one object. */
  statsCompactThreshold: number;
}

/**
 * Where embeddings come from.
 *
 * `dimension` on either must equal the dimension the vector index was created
 * with. S3 Vectors fixes that at creation and will not change it, so a mismatch
 * is not a degraded search — it is every write failing.
 */
export type EmbeddingConfig =
  | { provider: "bedrock"; model: string; dimension: number }
  | { provider: "openai"; baseUrl: string; apiKey: string; model: string; dimension: number };

/** Bedrock is the default: in-region, and the pod's role covers it, so there is no key to hold. */
const DEFAULT_BEDROCK_MODEL = "amazon.titan-embed-text-v2:0";
const DEFAULT_BEDROCK_DIM = 1024;
const DEFAULT_OPENAI_MODEL = "text-embedding-3-small";
const DEFAULT_OPENAI_DIM = 1536;

export class ConfigError extends Error {}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new ConfigError(`${name} is required`);
  }
  return value;
}

/**
 * A cosine threshold, in (0, 1].
 *
 * Zero is refused rather than accepted. A floor of zero admits every hit, and
 * confidence is expressed as a multiple of the floor — so every result, however
 * remote, would come back to the model labelled HIGH CONFIDENCE. A setting that
 * makes the server confidently wrong should stop the rollout, not survive it.
 */
function ratio(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new ConfigError(`${name} must be greater than 0 and at most 1, got "${raw}"`);
  }
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigError(`${name} must be a positive integer, got "${raw}"`);
  }
  return value;
}

function loadEmbedding(env: NodeJS.ProcessEnv): EmbeddingConfig {
  const provider = env.EMBEDDING_PROVIDER?.trim() || "bedrock";
  if (provider === "bedrock") {
    return {
      provider,
      model: env.EMBEDDING_MODEL?.trim() || DEFAULT_BEDROCK_MODEL,
      dimension: integer(env, "EMBEDDING_DIM", DEFAULT_BEDROCK_DIM),
    };
  }
  if (provider === "openai") {
    return {
      provider,
      baseUrl: required(env, "EMBEDDING_BASE_URL").replace(/\/+$/, ""),
      apiKey: required(env, "EMBEDDING_API_KEY"),
      model: env.EMBEDDING_MODEL?.trim() || DEFAULT_OPENAI_MODEL,
      dimension: integer(env, "EMBEDDING_DIM", DEFAULT_OPENAI_DIM),
    };
  }
  throw new ConfigError(`EMBEDDING_PROVIDER must be "bedrock" or "openai", got "${provider}"`);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: integer(env, "PORT", 3000),
    apiKey: env.MCP_API_KEY?.trim() || undefined,
    region: env.AWS_REGION?.trim() || "ap-northeast-2",
    vectorBucket: required(env, "VECTOR_BUCKET"),
    vectorIndex: env.VECTOR_INDEX?.trim() || "memories",
    stateBucket: required(env, "STATE_BUCKET"),
    embedding: loadEmbedding(env),
    recallMinSimilarity: ratio(env, "RECALL_MIN_SIMILARITY", 0.1),
    statsFlushMs: integer(env, "STATS_FLUSH_MS", 30_000),
    statsCompactThreshold: integer(env, "STATS_COMPACT_THRESHOLD", 20),
  };
}
