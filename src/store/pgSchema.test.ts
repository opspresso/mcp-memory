import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ensureSchema, type SchemaPool } from "./pg.js";

function schemaPool(legacy: boolean) {
  const statements: string[] = [];
  let released = false;
  const pool: SchemaPool = {
    connect: async () => ({
      query: async (text) => {
        statements.push(text);
        if (text.includes("FROM pg_extension")) {
          return { rows: [{}] };
        }
        if (text.includes("information_schema.columns")) {
          return { rows: legacy ? [{}] : [] };
        }
        return { rows: [] };
      },
      release: () => {
        released = true;
      },
    }),
  };
  return { pool, statements, released: () => released };
}

describe("ensureSchema", () => {
  it("replaces the legacy S3-shaped tables once", async () => {
    const fake = schemaPool(true);
    await ensureSchema(fake.pool);

    assert.ok(fake.statements.includes("DROP TABLE memories"));
    assert.ok(fake.statements.includes("DROP TABLE IF EXISTS objects"));
    assert.ok(fake.statements.some((statement) => statement.startsWith("CREATE TABLE IF NOT EXISTS memories")));
    assert.ok(fake.statements.includes("COMMIT"));
    assert.equal(fake.released(), true);
  });

  it("leaves the current table intact", async () => {
    const fake = schemaPool(false);
    await ensureSchema(fake.pool);

    assert.ok(!fake.statements.some((statement) => statement.startsWith("DROP TABLE")));
    assert.ok(fake.statements.some((statement) => statement.startsWith("CREATE TABLE IF NOT EXISTS memories")));
  });
});
