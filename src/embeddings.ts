/**
 * Turning text into a vector, over the OpenAI-compatible `/embeddings` route.
 *
 * Not a local model. Running one in-process — sentence-transformers, say —
 * means ~90 MB of weights and a cold start measured in tens of seconds, paid
 * again on every scale-out, by a Deployment whose whole point is that pods are
 * cheap to add and remove. Agent Studio already routes every LLM call through
 * one OpenAI-compatible base URL; embeddings go the same way, and the pod stays
 * small enough that adding one is free.
 *
 * The dimension is checked on every response rather than trusted. An S3 Vectors
 * index fixes its dimension at creation and will not change it, so a model
 * swapped underneath this server does not degrade search — it fails every
 * write, and it should say so in terms that name the cause.
 */

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export class EmbeddingError extends Error {}

/**
 * Guards every provider's output, because the failure it catches is expensive
 * and silent otherwise.
 *
 * An S3 Vectors index fixes its dimension at creation and will not change it,
 * so a model swapped underneath this server does not degrade search — it fails
 * every write, with an error from AWS that names neither the model nor the
 * setting. Saying it here is what makes that recoverable.
 */
function validate(embedding: unknown, dimension: number, model: string): number[] {
  if (!Array.isArray(embedding) || embedding.some((n) => typeof n !== "number")) {
    throw new EmbeddingError("the embedding service returned a response with no embedding in it");
  }
  if (embedding.length !== dimension) {
    throw new EmbeddingError(
      `model "${model}" returned ${embedding.length} dimensions but the vector index expects ` +
        `${dimension}. An index's dimension cannot be changed after creation: either set ` +
        "EMBEDDING_DIM and EMBEDDING_MODEL to match the index, or create a new index for this model.",
    );
  }
  // Zero vectors are rejected by S3 Vectors under the cosine metric, and a
  // model that returns one for real input is broken in a way worth naming.
  if (embedding.every((n) => n === 0)) {
    throw new EmbeddingError("the embedding service returned an all-zero vector");
  }
  return embedding as number[];
}

export interface EmbeddingOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  dimension: number;
  timeoutMs?: number;
  /** Injected in tests; defaults to the global. */
  fetchImpl?: typeof fetch;
}

/** On the critical path of every recall, so it fails rather than hangs. */
const DEFAULT_TIMEOUT_MS = 10_000;

export class HttpEmbedder implements Embedder {
  constructor(private readonly options: EmbeddingOptions) {}

  async embed(text: string): Promise<number[]> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const timeout = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let response: Response;
    try {
      response = await doFetch(`${this.options.baseUrl}/embeddings`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({ model: this.options.model, input: text }),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      const name = (error as Error)?.name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new EmbeddingError(`the embedding service did not respond within ${timeout}ms`);
      }
      throw new EmbeddingError(
        `could not reach the embedding service — ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!response.ok) {
      // The body may carry the provider's own explanation, which is usually the
      // actionable part (a wrong model id, a rejected key). Bounded so a stray
      // HTML error page cannot land in a tool result whole.
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new EmbeddingError(
        `the embedding service answered ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }

    const payload: unknown = await response.json().catch(() => undefined);
    const embedding = (payload as { data?: { embedding?: unknown }[] } | undefined)?.data?.[0]
      ?.embedding;
    return validate(embedding, this.options.dimension, this.options.model);
  }
}

/**
 * Amazon Titan Text Embeddings, over Bedrock.
 *
 * The default, and the one the deployment uses. It needs no API key — the pod's
 * own role covers it, so there is no secret to mount, rotate, or leak into a
 * log — and it runs in the same region as the vector bucket, which takes an
 * internet round trip off the critical path of every recall.
 *
 * Titan v2 will return 256, 512 or 1024 dimensions on request. Whichever the
 * index was built with has to be asked for explicitly: the model's own default
 * is 1024, and a mismatch is not recoverable once vectors exist.
 */
export interface BedrockEmbeddingOptions {
  model: string;
  dimension: number;
  /** Injected in tests. */
  invoke: (body: string, model: string) => Promise<unknown>;
}

export class BedrockEmbedder implements Embedder {
  constructor(private readonly options: BedrockEmbeddingOptions) {}

  async embed(text: string): Promise<number[]> {
    let payload: unknown;
    try {
      payload = await this.options.invoke(
        JSON.stringify({
          inputText: text,
          dimensions: this.options.dimension,
          // Cosine similarity on unit vectors is a dot product, and the index's
          // metric is cosine. Normalising at the source keeps every stored
          // vector on the same footing.
          normalize: true,
        }),
        this.options.model,
      );
    } catch (error) {
      throw new EmbeddingError(
        `Bedrock could not embed the text — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const embedding = (payload as { embedding?: unknown } | undefined)?.embedding;
    return validate(embedding, this.options.dimension, this.options.model);
  }
}

/** The real Bedrock call, kept apart so the embedder itself needs no AWS client to test. */
export function bedrockInvoker(region: string): BedrockEmbeddingOptions["invoke"] {
  // Imported lazily so a deployment using the HTTP provider never loads the SDK.
  const client = import("@aws-sdk/client-bedrock-runtime").then(
    ({ BedrockRuntimeClient }) => new BedrockRuntimeClient({ region }),
  );
  return async (body, model) => {
    const { InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const response = await (await client).send(
      new InvokeModelCommand({ modelId: model, body, contentType: "application/json" }),
    );
    return JSON.parse(new TextDecoder().decode(response.body));
  };
}
