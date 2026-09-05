/**
 * Which conversation a request belongs to, when the caller says.
 *
 * The second axis beside the tenant, and the same rules for the same reason:
 * it comes from a **header** and never from a tool argument. The platform
 * stamps `X-Conversation-Id` on every MCP request a run makes — a chat, a
 * Slack thread, an inbound A2A `contextId`, an API caller's own key — after
 * merging the registry's and the binding's headers, so a model cannot name a
 * conversation it is not in any more than it can name a tenant it does not
 * belong to. That is what lets a memory scoped to one conversation stay out of
 * every other conversation's recall, list and dedup: the server checks the
 * header, and the header is not the model's to write.
 *
 * Optional, unlike the tenant. A probe, a "Test connection", a firing, an API
 * call that declared no conversation — none is in one, and every one of them
 * may still keep and read *project* memories. Only writing or reading a
 * conversation-scoped memory needs the header, and asking for that without one
 * is refused by name.
 */

export const CONVERSATION_ID_HEADER = "x-conversation-id";

/**
 * What the platform sends: at most 512 characters of printable ASCII, no
 * whitespace — the platform's own bound and its own encoding (it percent-encodes
 * anything else). Held to exactly that here before PostgreSQL uses it as a
 * visibility key.
 */
const MAX_LENGTH = 512;
const ALLOWED = /^[\x21-\x7e]+$/;

export class ConversationError extends Error {}

/**
 * The request's conversation, or `undefined` when it declared none.
 *
 * @throws ConversationError when a header is present and malformed — a
 * misconfigured binding fails loudly, like a bad tenant, rather than quietly
 * becoming "no conversation" and writing thread notes into the project.
 */
export function parseConversation(raw: string | string[] | undefined | null): string | undefined {
  if (Array.isArray(raw)) {
    throw new ConversationError(`${CONVERSATION_ID_HEADER} was sent more than once`);
  }
  const value = raw?.trim();
  if (!value) {
    return undefined;
  }
  if (value.length > MAX_LENGTH) {
    throw new ConversationError(`${CONVERSATION_ID_HEADER} is too long (max ${MAX_LENGTH} characters)`);
  }
  if (!ALLOWED.test(value)) {
    throw new ConversationError(
      `${CONVERSATION_ID_HEADER} may carry printable ASCII only, with no whitespace`,
    );
  }
  return value;
}
