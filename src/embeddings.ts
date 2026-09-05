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
 * The dimension is checked on every response rather than trusted. PostgreSQL
 * cannot compare vectors of different widths, so a model swap must fail with
 * the cause named instead of degrading search.
 */

import type { BedrockRuntimeClient } from "@aws-sdk/client-bedrock-runtime";

export interface Embedder {
  embed(text: string): Promise<number[]>;
}

export class EmbeddingError extends Error {}

/**
 * Guards every provider's output, because the failure it catches is expensive
 * and silent otherwise.
 *
 * Existing PostgreSQL rows fix the usable dimension for a deployment. A model
 * swapped underneath the server must fail before incompatible vectors mix.
 */
function validate(embedding: unknown, dimension: number, model: string): number[] {
  if (!Array.isArray(embedding) || embedding.some((n) => typeof n !== "number")) {
    throw new EmbeddingError("the embedding service returned a response with no embedding in it");
  }
  if (embedding.length !== dimension) {
    throw new EmbeddingError(
      `model "${model}" returned ${embedding.length} dimensions but this deployment expects ` +
        `${dimension}. Set EMBEDDING_DIM and EMBEDDING_MODEL to match, then clear or re-embed ` +
        "existing memories before changing dimensions.",
    );
  }
  // Cosine distance is undefined for a zero vector.
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
 * The default provider. It needs no API key because the pod's role covers it.
 *
 * Titan v2 will return 256, 512 or 1024 dimensions on request. Whichever the
 * deployment expects has to be asked for explicitly; the model default is 1024.
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
  // Imported lazily so a deployment using the HTTP provider never loads the
  // SDK — and started on the first call rather than here. A promise built at
  // wiring time is one nobody is awaiting yet, so an import that fails becomes
  // an unhandled rejection: the process is already past `listen`, so the pod
  // has answered its readiness probe and then dies with a stack pointing at
  // nothing anybody wrote. Reached through the call instead, the same failure
  // arrives where it can be said in a sentence.
  let client: Promise<BedrockRuntimeClient> | undefined;
  return async (body, model) => {
    const { InvokeModelCommand } = await import("@aws-sdk/client-bedrock-runtime");
    const bedrock = await (client ??= import("@aws-sdk/client-bedrock-runtime").then(
      ({ BedrockRuntimeClient }) => new BedrockRuntimeClient({ region }),
    ));
    const response = await bedrock.send(
      new InvokeModelCommand({ modelId: model, body, contentType: "application/json" }),
    );
    return JSON.parse(new TextDecoder().decode(response.body));
  };
}
