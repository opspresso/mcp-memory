/** Stop accepting requests and leave after in-flight work or a fixed deadline. */

export interface Closable {
  close(callback: () => void): unknown;
}

export interface ShutdownOptions {
  graceMs: number;
  exit: (code: number) => void;
  setTimer?: (handler: () => void, ms: number) => { unref?: () => void };
}

/** Safe to call more than once when an impatient rollout sends another signal. */
export function gracefulShutdown(server: Closable, options: ShutdownOptions): () => void {
  const setTimer = options.setTimer ?? setTimeout;
  let leaving = false;

  return () => {
    if (leaving) {
      return;
    }
    leaving = true;

    let exited = false;
    const exit = () => {
      if (exited) {
        return;
      }
      exited = true;
      options.exit(0);
    };

    const timer = setTimer(exit, options.graceMs);
    timer.unref?.();
    server.close(exit);
  };
}
