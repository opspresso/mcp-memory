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
 * would be a shared bucket that every misconfigured binding silently falls
 * into, which is the same leak arriving by accident instead of by attack.
 */

export const TENANT_HEADER = "x-memory-tenant";

/** Long enough for a repository-style name, short enough to keep S3 keys sane. */
const MAX_LENGTH = 128;
/**
 * Conservative on purpose. The value lands in two places with different rules —
 * an S3 key path and an S3 Vectors filter value — so it is restricted to what
 * is unambiguous in both rather than to what either would tolerate alone.
 */
const ALLOWED = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export class TenantError extends Error {}

/**
 * Validate a tenant identifier.
 *
 * @throws TenantError when absent or malformed — the caller turns this into a
 * protocol error, so a misconfigured binding fails loudly on its first call.
 */
export function parseTenant(raw: string | string[] | undefined): string {
  // A repeated header is ambiguous about which value was meant, and guessing is
  // how the wrong tenant gets picked. Node hands duplicates back as an array.
  if (Array.isArray(raw)) {
    throw new TenantError(`${TENANT_HEADER} was sent more than once`);
  }
  const value = raw?.trim();
  if (!value) {
    throw new TenantError(
      `${TENANT_HEADER} header is required — set it on the MCP server entry in the registry`,
    );
  }
  if (value.length > MAX_LENGTH) {
    throw new TenantError(`${TENANT_HEADER} is too long (max ${MAX_LENGTH} characters)`);
  }
  if (!ALLOWED.test(value)) {
    throw new TenantError(
      `${TENANT_HEADER} must start with a letter or digit and contain only letters, digits, '.', '_' or '-'`,
    );
  }
  // `.` and `..` pass the pattern and mean something to a path. Nothing else
  // does: the pattern already bars '/', so no other traversal spelling exists.
  if (value === "." || value === "..") {
    throw new TenantError(`${TENANT_HEADER} is not a valid tenant`);
  }
  return value;
}
