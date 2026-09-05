/**
 * Whose memories a request may touch.
 *
 * The single owner of that question, and the reason it is a module rather than
 * two lines in the handler: every read and every write is scoped by it, so if
 * two places ever disagreed about what a tenant is, one of them would be a
 * cross-tenant leak.
 *
 * **The tenant comes from a header and never from tool arguments.** Agent
 * Studio stores per-server headers encrypted and merges a version's overrides
 * into them at dispatch (`application/execution/mcpTools.ts`), so the header is
 * something an operator configured. A tool argument is something the *model*
 * chose, and a model that can name its own tenant can read another project's
 * memories by asking for them — including a model that was talked into it by
 * text it retrieved a moment earlier. No amount of validation fixes that; the
 * channel is wrong.
 *
 * A request with no tenant is refused rather than defaulted. A default here
 * would be a shared tenant that every misconfigured binding silently falls
 * into, which is the same leak arriving by accident instead of by attack.
 */

export const TENANT_HEADER = "x-memory-tenant";

/**
 * The generic tenant header, read when no explicit {@link TENANT_HEADER} is
 * configured. Agent Studio stamps it on every MCP request with the calling
 * project's name — which is what makes this server per-project there with no
 * per-project registration at all — and the name is deliberately unbranded, so
 * any client with the same convention scopes the same way. Explicit wins: an
 * operator who set `x-memory-tenant` by hand has said which tenant this
 * binding is, and the automatic name must not override that.
 */
export const TENANT_ID_HEADER = "x-tenant-id";

/** Long enough for a repository-style name and bounded for indexed storage. */
const MAX_LENGTH = 128;
/**
 * Conservative on purpose. The value becomes a security-sensitive PostgreSQL
 * filter, so it is restricted to an unambiguous identifier shape.
 */
const ALLOWED = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class TenantError extends Error {}

/**
 * Validate a tenant identifier.
 *
 * `header` names the header the value arrived on, because two of them may
 * carry it and the refusal has to say which one to go and fix. It defaults to
 * {@link TENANT_HEADER}: with nothing sent at all there is no such header, and
 * the one an operator sets by hand is the one to name.
 *
 * @throws TenantError when absent or malformed — the caller turns this into a
 * protocol error, so a misconfigured binding fails loudly on its first call.
 */
export function parseTenant(
  raw: string | string[] | undefined,
  header: string = TENANT_HEADER,
): string {
  // A repeated header is ambiguous about which value was meant, and guessing is
  // how the wrong tenant gets picked. Node hands duplicates back as an array.
  if (Array.isArray(raw)) {
    throw new TenantError(`${header} was sent more than once`);
  }
  const value = raw?.trim();
  if (!value) {
    throw new TenantError(
      `${header} header is required — set it on the MCP server entry in the registry`,
    );
  }
  if (value.length > MAX_LENGTH) {
    throw new TenantError(`${header} is too long (max ${MAX_LENGTH} characters)`);
  }
  if (!ALLOWED.test(value)) {
    throw new TenantError(
      `${header} must start with a letter or digit and contain only letters, digits, '.', '_' or '-'`,
    );
  }
  // `.` and `..` carry no tenant identity despite passing the character rule.
  if (value === "." || value === "..") {
    throw new TenantError(`${header} is not a valid tenant`);
  }
  return value;
}
