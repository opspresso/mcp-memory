/**
 * The documentation library, searched through a Bedrock Knowledge Base.
 *
 * The knowledge base owns its own S3 Vectors index and its own ingestion — this
 * server only queries it, over the Retrieve API. Query embedding happens inside
 * the knowledge base with whatever model *it* was built on, so the `EMBEDDING_*`
 * configuration plays no part here and cannot mismatch it.
 *
 * The library is shared across tenants by design: memories are per-project,
 * documentation is for everyone. See the README's tenancy note.
 */

import type { BedrockAgentRuntimeClient } from "@aws-sdk/client-bedrock-agent-runtime";

/** One excerpt the knowledge base returned. */
export interface RetrievedDoc {
  excerpt: string;
  /** Where the excerpt came from, e.g. an s3:// URI, when the KB says. */
  source?: string;
  /** The KB's relevance score. Used only to rank results against each other. */
  score?: number;
}

export interface DocsRetriever {
  retrieve(query: string, limit: number): Promise<RetrievedDoc[]>;
}

export class DocsError extends Error {}

export interface KnowledgeBaseOptions {
  knowledgeBaseId: string;
  /** Injected in tests. */
  invoke: (knowledgeBaseId: string, query: string, limit: number) => Promise<unknown>;
}

/**
 * How much of one excerpt may reach the model.
 *
 * The KB's chunking decides how big an excerpt is, not this server, and a
 * library chunked generously could put tens of kilobytes into a single result.
 * Cut here so a full page of results cannot crowd out the context it was
 * fetched to inform.
 */
export const MAX_EXCERPT_CHARS = 2000;

export class KnowledgeBaseRetriever implements DocsRetriever {
  constructor(private readonly options: KnowledgeBaseOptions) {}

  async retrieve(query: string, limit: number): Promise<RetrievedDoc[]> {
    let payload: unknown;
    try {
      payload = await this.options.invoke(this.options.knowledgeBaseId, query, limit);
    } catch (error) {
      throw new DocsError(
        `the knowledge base could not be searched — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    const results = (payload as { retrievalResults?: unknown } | undefined)?.retrievalResults;
    if (!Array.isArray(results)) {
      throw new DocsError("the knowledge base returned a response with no retrieval results in it");
    }
    const docs: RetrievedDoc[] = [];
    for (const result of results as {
      content?: { text?: unknown };
      location?: { s3Location?: { uri?: unknown } };
      score?: unknown;
    }[]) {
      const excerpt = result?.content?.text;
      if (typeof excerpt !== "string" || !excerpt.trim()) {
        continue;
      }
      const source = result?.location?.s3Location?.uri;
      const score = result?.score;
      docs.push({
        excerpt,
        source: typeof source === "string" ? source : undefined,
        score: typeof score === "number" ? score : undefined,
      });
    }
    return docs;
  }
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function clip(excerpt: string): string {
  if (excerpt.length <= MAX_EXCERPT_CHARS) {
    return excerpt;
  }
  return `${excerpt.slice(0, MAX_EXCERPT_CHARS)}… (truncated — read the source document for the rest)`;
}

/**
 * Render excerpts as the model sees them.
 *
 * Standing is a fraction of the top result's score, never the score itself —
 * what a raw relevance number means is a property of the knowledge base's
 * embedding model, and the model reading this cannot calibrate it. Same
 * reasoning as memory rendering in `service.ts`.
 */
export function renderDocs(query: string, docs: RetrievedDoc[]): string {
  if (docs.length === 0) {
    return (
      `[DOCS] Nothing in the documentation library matched "${query}". ` +
      "An empty result means nothing close is indexed — it is not the same as the " +
      "subject having no answer; rephrasing may help."
    );
  }
  const topScore = Math.max(...docs.map((doc) => doc.score ?? 0), 0);
  const rendered = docs.map((doc, i) => {
    const facets = [
      ...(doc.score !== undefined && topScore > 0
        ? [`${percent(Math.min(1, doc.score / topScore))} of the top result`]
        : []),
      ...(doc.source ? [`source: ${doc.source}`] : []),
    ];
    const label = facets.length > 0 ? ` (${facets.join(", ")})` : "";
    return `${i + 1}.${label}\n   ${clip(doc.excerpt)}`;
  });
  return [
    `[DOCS] ${docs.length} ${docs.length === 1 ? "excerpt" : "excerpts"} matched ` +
      `"${query}" in the documentation library.`,
    "",
    ...rendered,
  ].join("\n");
}

/** The real Retrieve call, kept apart so the retriever itself needs no AWS client to test. */
export function knowledgeBaseInvoker(region: string): KnowledgeBaseOptions["invoke"] {
  // Imported lazily so a memories-only deployment never loads the SDK — and
  // started on the first call rather than here. See `bedrockInvoker`: a promise
  // built at wiring time is one nobody is awaiting yet, so an import that fails
  // takes the process down after it has already answered its readiness probe,
  // with a stack pointing at nothing anybody wrote.
  let client: Promise<BedrockAgentRuntimeClient> | undefined;
  return async (knowledgeBaseId, query, limit) => {
    const { RetrieveCommand } = await import("@aws-sdk/client-bedrock-agent-runtime");
    const agent = await (client ??= import("@aws-sdk/client-bedrock-agent-runtime").then(
      ({ BedrockAgentRuntimeClient }) => new BedrockAgentRuntimeClient({ region }),
    ));
    return agent.send(
      new RetrieveCommand({
        knowledgeBaseId,
        retrievalQuery: { text: query },
        retrievalConfiguration: { vectorSearchConfiguration: { numberOfResults: limit } },
      }),
    );
  };
}
