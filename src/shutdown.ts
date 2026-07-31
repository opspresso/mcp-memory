/**
 * Leaving without dropping counters on the floor.
 *
 * A pod's only unsaved state is the counts `StatsTracker` has accumulated since
 * its last flush, so shutting down means: stop accepting work, push those, go.
 * The ordering matters — a server still answering is a server still
 * incrementing — which is why the flush waits for `close`.
 *
 * And why it does not wait forever. `close` fires its callback once every
 * connection has finished, so a single request wedged against a slow S3 holds
 * the whole shutdown open; the flush never runs, Kubernetes reaches the end of
 * its grace period, and SIGKILL takes the counters that were being protected.
 * Waiting is worth a few seconds and not worth the thing it was guarding.
 *
 * Its own module because the alternative is untestable. `main.ts` runs on
 * import — it reads the environment and binds a port — so anything written
 * there can only be verified by starting a process and signalling it.
 */

/** What this needs from an `http.Server`, and nothing more. */
export interface Closable {
  close(callback: () => void): unknown;
}

/** What this needs from `StatsTracker`. */
export interface Flushable {
  stop(): Promise<void>;
}

export interface ShutdownOptions {
  /** How long to let in-flight requests finish before flushing anyway. */
  graceMs: number;
  exit: (code: number) => void;
  /**
   * Injected in tests; defaults to the global.
   *
   * A test supplies one whose handle has no `unref`, because the production
   * timer is unref'd — right for a pod, and fatal for a test, where an empty
   * event loop lets the process leave before the deadline it is asserting on.
   */
  setTimer?: (handler: () => void, ms: number) => { unref?: () => void };
}

/**
 * Build the signal handler.
 *
 * Safe to call more than once: a second SIGTERM while the first is still
 * draining is common on an impatient rollout, and it must not start a second
 * flush or exit out from under the first.
 */
export function gracefulShutdown(
  server: Closable,
  stats: Flushable,
  options: ShutdownOptions,
): () => void {
  const setTimer = options.setTimer ?? setTimeout;
  let leaving = false;

  return () => {
    if (leaving) {
      return;
    }
    leaving = true;

    let flushed = false;
    const flushAndExit = () => {
      if (flushed) {
        return;
      }
      flushed = true;
      void stats
        .stop()
        // `catch` before `finally`, and not decoration: `finally` re-throws
        // what it was handed, so a rejected flush would become an unhandled
        // rejection and kill the process before the exit below — losing the
        // counters this whole path exists to save, on exactly the bad day it
        // was written for. The failure is already logged where it happened.
        .catch(() => {})
        .finally(() => options.exit(0));
    };

    const timer = setTimer(flushAndExit, options.graceMs);
    // Never let the shutdown timer be the reason the process stays alive.
    timer.unref?.();

    server.close(flushAndExit);
  };
}
