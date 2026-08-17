/**
 * What this process says about itself.
 *
 * It exists because of where the errors go otherwise. A storage failure, an
 * embedding timeout, a rejected Bedrock call — every one of them is caught in
 * `tools.ts` and turned into a sentence for the *model*, which reacts to it and
 * carries on. That is the right behaviour for the run and a dead end for the
 * operator: the pod logs stay empty through an outage, and the only trace of it
 * is inside a conversation nobody is reading.
 *
 * The same silence hid the healthy case. A pod that answers every call and one
 * that nobody calls look identical from the outside, so every tool call is
 * written down as well — which tool, for which tenant, how long it took and
 * whether it answered — and a question like "did the recall in that run reach
 * us at all" has somewhere to be answered.
 *
 * One JSON line per event, so a log collector can index it without a parser and
 * a human can still read it. Failures go to stderr, the rest to stdout.
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
  /** How long the call took, in whole milliseconds. */
  ms?: number;
  /** Whether the tool answered, or refused with `isError`. */
  ok?: boolean;
  /** Whether the request declared a conversation — never which one. */
  inConversation?: boolean;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Record something that happened, as opposed to something that went wrong.
 *
 * `event` names the site, as it does for `logError`, so that one search finds
 * every line of one kind.
 */
export function logInfo(event: string, context: LogContext = {}): void {
  console.log(JSON.stringify({ level: "info", event, ...context }));
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

/** Whole milliseconds since a `performance.now()` reading, for a log line. */
export function elapsedMs(started: number): number {
  return Math.round(performance.now() - started);
}
