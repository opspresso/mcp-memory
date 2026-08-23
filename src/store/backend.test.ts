/**
 * A PostgreSQL deployment must never load an AWS SDK, and an S3 one must
 * never load `pg` — not as policy, but because a container with no AWS
 * credentials that imports an AWS client at boot is a container that may not
 * boot, and the only thing keeping the imports lazy is this test.
 *
 * Static rather than behavioural: Node offers no reliable list of the ES
 * modules a process has loaded, and a test that spawned a process per backend
 * would need a database and a bucket to get past configuration. Reading the
 * sources for a top-level `import … from "@aws-sdk/…"` that is not
 * `import type` says the same thing, for every file, on every run.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const SRC = new URL("../", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      return name === "testing" ? [] : sources(path);
    }
    return name.endsWith(".ts") && !name.endsWith(".test.ts") ? [path] : [];
  });
}

/** Top-level value imports of `specifier`; `import type` is erased and does not count. */
function staticImports(source: string, specifier: RegExp): string[] {
  return source
    .split("\n")
    .filter((line) => /^import\s+(?!type\s)/.test(line) || /^\} from /.test(line))
    .filter((line) => specifier.test(line));
}

describe("backend isolation", () => {
  it("loads no AWS SDK statically anywhere, so the PostgreSQL path never touches one", () => {
    for (const path of sources(SRC)) {
      const offending = staticImports(readFileSync(path, "utf8"), /@aws-sdk\//);
      assert.deepEqual(offending, [], `${path} imports an AWS SDK at module load`);
    }
  });

  it("imports pg from one module, reached only through a dynamic import", () => {
    const importers = sources(SRC).filter(
      (path) => staticImports(readFileSync(path, "utf8"), /from "pg"/).length > 0,
    );
    assert.deepEqual(
      importers.map((path) => path.slice(SRC.length)),
      ["store/pg.ts"],
    );
    const backend = readFileSync(join(SRC, "store/backend.ts"), "utf8");
    assert.match(backend, /await import\("\.\/pg\.js"\)/);
    assert.doesNotMatch(backend, /^import .* from "\.\/pg\.js"/m);
  });
});
