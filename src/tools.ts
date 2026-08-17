/**
 * The five memory tools, the optional docs tool, their schemas, and the
 * dispatch from a JSON-RPC name to the service that does the work.
 * `search_docs` only exists in a catalogue when a knowledge base is configured
 * — see `toolCatalogue`.
 *
 * Descriptions are load-bearing. They are the whole of what the model knows
 * about this server, and the one about `recall` has a job beyond describing
 * itself: Agent Studio never reads MCP *resources*, only tools, so there is no
 * way to push remembered context into a run before it starts. Asking for the
 * call in the description is the only channel available.
 *
 * No tool takes a tenant. See `tenant.ts` for why that is a security property
 * and not an omission.
 */

import { renderDocs, type DocsRetriever } from "./docs.js";
import { elapsedMs, logError, logInfo } from "./log.js";
import type { RequestContext } from "./mcp.js";
import {
  isMemoryScope,
  isMemoryType,
  isRecallMode,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  type MemoryScope,
  type MemoryType,
} from "./types.js";
import { MAX_CONTENT_BYTES } from "./store/vectors.js";
import { STATS_SCAN_CAP, type MemoryService } from "./service.js";

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** The MCP tool-result shape: content blocks, plus a flag when it went wrong. */
export interface ToolResult {
  content: { type: "text"; text: string }[];
  isError?: boolean;
}

export const MAX_TAGS = 20;
/**
 * Byte ceilings for the two labels a model supplies alongside the body.
 *
 * Both are labels, so these are generous — but they are not decoration. The
 * category shares a 2 KB filterable budget it can exhaust on its own, and the
 * tags share a 40 KB one with a body that may be 32 KB. Bounded here so the
 * model is told which field to shorten, rather than in the store alone, where
 * the answer arrives as a size it cannot attribute to anything it sent.
 */
export const MAX_CATEGORY_BYTES = 128;
export const MAX_TAG_BYTES = 64;
const MAX_LIMIT = 50;

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "recall",
    description:
      "Search this project's remembered knowledge by meaning and return what matches. " +
      "Call this at the start of a task, before asking the user to re-explain anything: " +
      "decisions, conventions and setup steps from earlier sessions are stored here and " +
      "will not be in your context otherwise. Returns the memories themselves, ranked, " +
      "with a confidence level — not a summary. An empty result means nothing was stored " +
      "on the subject, which is not the same as the subject having no answer. What comes " +
      "back is the project's shared memory plus whatever was remembered for this " +
      "conversation in particular; other conversations' own notes are never included.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to know, in natural language." },
        limit: {
          type: "integer",
          description: `Maximum memories to return (1-${MAX_LIMIT}). Defaults to the mode's own limit.`,
        },
        mode: {
          type: "string",
          enum: ["precision", "balanced", "exploratory"],
          description:
            "precision: few, closely-matching results. balanced (default): the usual trade-off. " +
            "exploratory: more results, looser matching — use when a balanced search found nothing.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "remember",
    description:
      "Store something worth knowing in a later session. Use it for durable facts — an " +
      "architectural decision and its reason, a convention this project follows, a command " +
      "that turned out to be the right one. Content near-identical to something already " +
      "stored is not written a second time: you are told which memory already says it, and " +
      "the tags and category you passed are discarded along with the rest. By default a " +
      "memory is the project's, seen by every conversation; pass scope \"conversation\" for " +
      "something that belongs to this thread alone — a preference the user stated here, a " +
      "working note — which only this conversation will ever recall or list.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description:
            "The fact itself, written so it still makes sense months later with none of " +
            "this conversation around it.",
        },
        scope: {
          type: "string",
          enum: [...MEMORY_SCOPES],
          description:
            "project (default): shared by every conversation of this project. conversation: " +
            "kept for this conversation only, invisible everywhere else. Needs a conversation " +
            "on the request — the platform sends one for chats, Slack threads and A2A calls.",
        },
        type: {
          type: "string",
          enum: [...MEMORY_TYPES],
          description:
            "project: how this project is built or decided. pattern: a reusable snippet or " +
            "command. reference: an external fact or link. conversation: something the user " +
            "said that should persist. Defaults to project.",
        },
        category: {
          type: "string",
          description:
            `Optional sub-label, e.g. 'decision', 'architecture', 'convention' (max ${MAX_CATEGORY_BYTES} bytes).`,
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: `Optional labels for retrieval (max ${MAX_TAGS}, each up to ${MAX_TAG_BYTES} bytes).`,
        },
      },
      required: ["content"],
    },
  },
  {
    name: "list_memories",
    description:
      "List this project's memories newest first, without searching. Use it to see what is " +
      "stored when you do not have a query — for a search by meaning, use recall. Includes " +
      "this conversation's own memories and excludes other conversations'.",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", enum: [...MEMORY_TYPES], description: "Filter to one type." },
        limit: { type: "integer", description: `Maximum to return (1-${MAX_LIMIT}). Default 20.` },
      },
    },
  },
  {
    name: "forget",
    description:
      "Delete one memory by id, permanently. Use it when a stored fact has become wrong — " +
      "a superseded decision, a command that no longer works. Prefer storing the correction " +
      "with remember when the old fact is merely out of date rather than false.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "The memory id, as returned by recall." } },
      required: ["id"],
    },
  },
  {
    name: "memory_stats",
    description:
      "How many memories this project has, broken down by type. Exact up to " +
      `${STATS_SCAN_CAP} memories; past that the answer says so and reports a lower bound.`,
    inputSchema: { type: "object", properties: {} },
  },
];

/** The Retrieve API's own ceiling on a query, in characters. */
export const MAX_QUERY_CHARS = 1000;
/** The knowledge base's own default result count. */
const DEFAULT_DOCS_LIMIT = 5;

/**
 * Not part of `TOOLS`: the memory tools exist everywhere, this one only where a
 * knowledge base is configured. `toolCatalogue` is the one place they combine.
 */
export const SEARCH_DOCS_TOOL: ToolDefinition = {
  name: "search_docs",
  description:
    "Search the shared documentation library by meaning and return the most relevant " +
    "excerpts, each with the source document it came from. Use it when this project's own " +
    "memories (recall) do not answer — how-tos, policies, reference material. Results are " +
    "excerpts, not whole documents. An empty result means nothing close is indexed, which " +
    "is not the same as the subject having no answer.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: `What you want to find, in natural language (max ${MAX_QUERY_CHARS} characters).`,
      },
      limit: {
        type: "integer",
        description: `Maximum excerpts to return (1-${MAX_LIMIT}). Default ${DEFAULT_DOCS_LIMIT}.`,
      },
    },
    required: ["query"],
  },
};

export function toolCatalogue(withDocs: boolean): readonly ToolDefinition[] {
  return withDocs ? [...TOOLS, SEARCH_DOCS_TOOL] : TOOLS;
}

class ArgumentError extends Error {}

function requireString(args: Record<string, unknown>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || !value.trim()) {
    throw new ArgumentError(`\`${name}\` is required and must be a non-empty string.`);
  }
  return value;
}

function optionalLimit(args: Record<string, unknown>, fallback: number | undefined) {
  const value = args.limit;
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
    throw new ArgumentError(`\`limit\` must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  return value;
}

function optionalType(args: Record<string, unknown>): MemoryType | undefined {
  const value = args.type;
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!isMemoryType(value)) {
    throw new ArgumentError(`\`type\` must be one of: ${MEMORY_TYPES.join(", ")}.`);
  }
  return value;
}

function optionalScope(args: Record<string, unknown>): MemoryScope {
  const value = args.scope;
  if (value === undefined || value === null) {
    return "project";
  }
  if (!isMemoryScope(value)) {
    throw new ArgumentError(`\`scope\` must be one of: ${MEMORY_SCOPES.join(", ")}.`);
  }
  return value;
}

function optionalTags(args: Record<string, unknown>): string[] {
  const value = args.tags;
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) {
    throw new ArgumentError("`tags` must be an array of strings.");
  }
  const tags = (value as string[]).map((tag) => tag.trim()).filter(Boolean);
  if (tags.length > MAX_TAGS) {
    throw new ArgumentError(`\`tags\` may hold at most ${MAX_TAGS} entries.`);
  }
  const oversized = tags.find((tag) => Buffer.byteLength(tag, "utf8") > MAX_TAG_BYTES);
  if (oversized !== undefined) {
    throw new ArgumentError(
      `each tag may be at most ${MAX_TAG_BYTES} bytes; "${oversized.slice(0, 30)}…" is longer. ` +
        "Tags are labels to retrieve by, not content.",
    );
  }
  return tags;
}

function text(body: string): ToolResult {
  return { content: [{ type: "text", text: body }] };
}

function failure(body: string): ToolResult {
  return { content: [{ type: "text", text: body }], isError: true };
}

/**
 * Dispatch one tool call.
 *
 * A bad argument or a storage failure comes back as a tool *result* with
 * `isError`, not as a protocol error: it is the model's problem to react to —
 * by fixing the argument or by carrying on without the memory — and a protocol
 * error would fail the whole run over it.
 *
 * Every call leaves one line behind, whatever the outcome — the tool, the
 * tenant, how long it took and whether it answered. Not the arguments: what
 * was asked or remembered is the caller's, and `log.ts` says why it never
 * reaches a log line.
 */
export async function callTool(
  service: MemoryService,
  context: RequestContext,
  name: string,
  args: Record<string, unknown>,
  docs?: DocsRetriever,
): Promise<ToolResult> {
  const started = performance.now();
  const result = await dispatch(service, context, name, args, docs);
  // Whether the request was in a conversation, never which: the value is a
  // thread address the caller owns, and `log.ts` keeps those out.
  logInfo("tool_call", {
    tenant: context.tenant,
    tool: name,
    ms: elapsedMs(started),
    ok: result.isError !== true,
    inConversation: context.conversation !== undefined,
  });
  return result;
}

async function dispatch(
  service: MemoryService,
  { tenant, conversation }: RequestContext,
  name: string,
  args: Record<string, unknown>,
  docs?: DocsRetriever,
): Promise<ToolResult> {
  try {
    switch (name) {
      case "recall": {
        const mode = args.mode;
        if (mode !== undefined && mode !== null && !isRecallMode(mode)) {
          throw new ArgumentError("`mode` must be precision, balanced or exploratory.");
        }
        return text(
          await service.recall(tenant, {
            query: requireString(args, "query"),
            limit: optionalLimit(args, undefined),
            mode: isRecallMode(mode) ? mode : undefined,
            conversation,
          }),
        );
      }
      case "remember": {
        const content = requireString(args, "content");
        // Bytes, because that is what the metadata budget is measured in and
        // the two differ by 3x for non-ASCII. Checked here as well as in the
        // store so the model gets an actionable message rather than a rejection
        // from AWS it cannot interpret.
        const bytes = Buffer.byteLength(content, "utf8");
        if (bytes > MAX_CONTENT_BYTES) {
          throw new ArgumentError(
            `\`content\` is ${bytes} bytes; the maximum a single memory may hold is ` +
              `${MAX_CONTENT_BYTES}. Store the essential fact rather than the whole document.`,
          );
        }
        const category = args.category;
        if (category !== undefined && category !== null && typeof category !== "string") {
          throw new ArgumentError("`category` must be a string.");
        }
        if (typeof category === "string" && Buffer.byteLength(category, "utf8") > MAX_CATEGORY_BYTES) {
          throw new ArgumentError(
            `\`category\` may be at most ${MAX_CATEGORY_BYTES} bytes. It is a sub-label such as ` +
              "'decision' or 'convention' — put the detail in `content`.",
          );
        }
        const scope = optionalScope(args);
        // The scope is the model's choice; the conversation it scopes to is not.
        // Asked to keep something for "this conversation" on a request that is
        // in none, the honest answer is a refusal naming what is missing — not
        // a silent promotion to the project, which would put a thread's note in
        // front of every other thread.
        if (scope === "conversation" && !conversation) {
          throw new ArgumentError(
            "`scope` is \"conversation\" but this request is not in one — no X-Conversation-Id " +
              "reached the server. Store it for the project instead, or leave `scope` unset.",
          );
        }
        return text(
          await service.remember(tenant, {
            content,
            memoryType: optionalType(args) ?? "project",
            category: typeof category === "string" ? category.trim() || undefined : undefined,
            tags: optionalTags(args),
            scope,
            conversation,
          }),
        );
      }
      case "list_memories":
        return text(
          await service.list(tenant, {
            memoryType: optionalType(args),
            limit: optionalLimit(args, 20) ?? 20,
            conversation,
          }),
        );
      case "forget":
        return text(await service.forget(tenant, requireString(args, "id")));
      case "memory_stats":
        return text(await service.stats(tenant));
      case "search_docs": {
        // Without a knowledge base the tool is absent from the catalogue and
        // the server rejects the name before it gets here — but the dispatch
        // must not depend on that.
        if (!docs) {
          return failure(`Error: unknown tool "search_docs".`);
        }
        const query = requireString(args, "query");
        // Characters, not bytes: that is how the Retrieve API measures it.
        if (query.length > MAX_QUERY_CHARS) {
          throw new ArgumentError(
            `\`query\` is ${query.length} characters; the maximum is ${MAX_QUERY_CHARS}. ` +
              "Ask for the one thing you want to find.",
          );
        }
        // The tenant is deliberately not part of the search: the documentation
        // library is shared across tenants, unlike the memories. It still lands
        // in the error log context below.
        return text(
          await docs
            .retrieve(query, optionalLimit(args, DEFAULT_DOCS_LIMIT) ?? DEFAULT_DOCS_LIMIT)
            .then((results) => renderDocs(query, results)),
        );
      }
      default:
        return failure(`Error: unknown tool "${name}".`);
    }
  } catch (error) {
    if (error instanceof ArgumentError) {
      // The model's mistake, and it can see the message. Nothing for an
      // operator to act on, so nothing goes to the log.
      return failure(`Error: ${error.message}`);
    }
    // Everything else is a dependency failing. The model gets a sentence and
    // moves on, which is right for the run and useless for whoever has to fix
    // it — so it is said out loud here as well.
    logError("tool_failed", error, { tenant, tool: name });
    const message = error instanceof Error ? error.message : String(error);
    return failure(
      name === "search_docs"
        ? `Error: the documentation index could not be searched — ${message}`
        : `Error: the memory store could not complete this request — ${message}`,
    );
  }
}
