import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { gracefulShutdown, type Closable } from "./shutdown.js";

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

const pending: NodeJS.Timeout[] = [];
const holdingTimer = (handler: () => void, ms: number) => {
  pending.push(setTimeout(handler, ms));
  return {};
};

afterEach(() => {
  for (const timer of pending.splice(0)) {
    clearTimeout(timer);
  }
});

function leaving(server: Closable, graceMs: number): Promise<number> {
  return new Promise((resolve) => {
    gracefulShutdown(server, { graceMs, exit: resolve, setTimer: holdingTimer })();
  });
}

describe("gracefulShutdown", () => {
  it("closes the server and exits", async () => {
    const server = serverThat(true);
    assert.equal(await leaving(server, 10_000), 0);
    assert.equal(server.closeRequested, true);
  });

  it("exits at the deadline when close never comes back", async () => {
    const server = serverThat(false);
    assert.equal(await leaving(server, 20), 0);
    assert.equal(server.closeRequested, true);
  });

  it("exits once when close and the deadline both land", async () => {
    const server = serverThat(true);
    let exits = 0;
    gracefulShutdown(server, {
      graceMs: 5,
      exit: () => {
        exits += 1;
      },
      setTimer: holdingTimer,
    })();
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(exits, 1);
  });

  it("ignores a second signal", async () => {
    const server = serverThat(true);
    let exits = 0;
    const leave = gracefulShutdown(server, {
      graceMs: 10_000,
      exit: () => {
        exits += 1;
      },
      setTimer: holdingTimer,
    });
    leave();
    leave();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(exits, 1);
  });
});
