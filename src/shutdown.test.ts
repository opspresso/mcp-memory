/**
 * The property under test is the one that only shows up on a bad day: the
 * counters get flushed whether or not the server manages to close.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gracefulShutdown, type Closable, type Flushable } from "./shutdown.js";

/** A server that closes when told to, or never — the two cases that matter. */
function serverThat(closes: boolean): Closable & { closeRequested: boolean } {
  return {
    closeRequested: false,
    close(callback: () => void) {
      this.closeRequested = true;
      if (closes) {
        callback();
      }
    },
  };
}

function counters(): Flushable & { flushes: number } {
  return {
    flushes: 0,
    async stop() {
      this.flushes += 1;
    },
  };
}

/** Resolves with the exit code the handler eventually calls. */
function leaving(server: Closable, stats: Flushable, graceMs: number): Promise<number> {
  return new Promise((resolve) => {
    gracefulShutdown(server, stats, { graceMs, exit: resolve })();
  });
}

describe("gracefulShutdown", () => {
  it("closes the server before flushing, then exits", async () => {
    const server = serverThat(true);
    const stats = counters();

    assert.equal(await leaving(server, stats, 10_000), 0);
    assert.equal(server.closeRequested, true, "the server must stop taking work first");
    assert.equal(stats.flushes, 1);
  });

  it("flushes anyway when close never comes back", async () => {
    // The failure this exists for: one request wedged against a slow S3 holds
    // `close` open, the flush never runs, and SIGKILL at the end of the grace
    // period takes the counters it was protecting.
    const server = serverThat(false);
    const stats = counters();

    assert.equal(await leaving(server, stats, 20), 0);
    assert.equal(server.closeRequested, true);
    assert.equal(stats.flushes, 1, "counters must survive a server that will not close");
  });

  it("flushes once when close and the deadline both land", async () => {
    const server = serverThat(true);
    const stats = counters();

    await leaving(server, stats, 5);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(stats.flushes, 1, "the deadline must not flush on top of a clean close");
  });

  it("ignores a second signal from an impatient rollout", async () => {
    const server = serverThat(true);
    const stats = counters();
    let exits = 0;

    const leave = gracefulShutdown(server, stats, {
      graceMs: 10_000,
      exit: () => {
        exits += 1;
      },
    });
    leave();
    leave();
    await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal(stats.flushes, 1);
    assert.equal(exits, 1, "a second SIGTERM must not exit out from under the first");
  });

  it("exits even when the final flush fails", async () => {
    // An exit conditional on the flush succeeding would hang on exactly the
    // outage that makes it fail.
    const failing: Flushable = { stop: () => Promise.reject(new Error("S3 is down")) };
    assert.equal(await leaving(serverThat(true), failing, 10_000), 0);
  });
});
