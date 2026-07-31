/**
 * What this process says about itself when something goes wrong.
 *
 * It exists because of where the errors go otherwise. A storage failure, an
 * embedding timeout, a rejected Bedrock call — every one of them is caught in
 * `tools.ts` and turned into a sentence for the *model*, which reacts to it and
 * carries on. That is the right behaviour for the run and a dead end for the
 * operator: the pod logs stay empty through an outage, and the only trace of it
 * is inside a conversation nobody is reading.
 *
 * One JSON line per event, on stderr, so a log collector can index it without a
 * parser and a human can still read it.
 *
 * **What must never appear here.** Memory content and recall queries are the
 * two things this server holds that belong to somebody else, and neither is
 * needed to diagnose anything — a failing dependency is identified by the tool
 * and the tenant, not by what was being remembered. Nothing in this module
 * accepts them, which is the only reliable way to keep them out.
 */

/** The fields a caller may attach. Deliberately not `unknown` — see the module note. */
export interface LogContext {
  tenant?: string;
  tool?: string;
  method?: string;
  key?: string;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Report a failure the caller is otherwise about to swallow.
 *
 * `event` names the site rather than the error, so that a log search finds
 * every occurrence of one problem regardless of what the underlying service
 * called it that day.
 */
export function logError(event: string, error: unknown, context: LogContext = {}): void {
  console.error(
    JSON.stringify({
      level: "error",
      event,
      message: messageOf(error),
      ...(error instanceof Error && error.name !== "Error" ? { type: error.name } : {}),
      ...context,
    }),
  );
}
