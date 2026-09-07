import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { databaseAddress, ensureSchema, type SchemaPool } from "./pg.js";

function schemaPool(legacy: boolean, dimension = 3) {
  const statements: string[] = [];
  let released = false;
  const pool: SchemaPool = {
    connect: async () => ({
      query: async (text) => {
        statements.push(text);
        if (text.includes("FROM pg_attribute")) {
          return { rows: [{ dimension }] };
        }
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
    await ensureSchema(fake.pool, 3);

    assert.ok(fake.statements.includes("DROP TABLE memories"));
    assert.ok(fake.statements.includes("DROP TABLE IF EXISTS objects"));
    assert.ok(fake.statements.some((statement) => statement.startsWith("CREATE TABLE IF NOT EXISTS memories")));
    assert.ok(fake.statements.includes("COMMIT"));
    assert.equal(fake.released(), true);
  });

  it("leaves the current table intact", async () => {
    const fake = schemaPool(false);
    await ensureSchema(fake.pool, 3);

    assert.ok(!fake.statements.some((statement) => statement.startsWith("DROP TABLE")));
    assert.ok(fake.statements.some((statement) => statement.startsWith("CREATE TABLE IF NOT EXISTS memories")));
  });

  it("does not alter the column again when its dimension already matches", async () => {
    const fake = schemaPool(false);
    await ensureSchema(fake.pool, 3);
    assert.ok(!fake.statements.some((statement) => statement.startsWith("ALTER TABLE")));
  });

  it("rejects invalid dimensions before executing SQL", async () => {
    const fake = schemaPool(false);
    for (const dimension of [0, -1, 1.5, NaN, Infinity, 16001]) {
      await assert.rejects(ensureSchema(fake.pool, dimension), /embedding dimension/);
    }
    assert.equal(fake.statements.length, 0);
  });

});


describe("databaseAddress", () => {
  it("reports the database without credentials or connection options", () => {
    assert.equal(
      databaseAddress("postgres://private-user:private-password@db:5432/memory?password=query-secret&sslkey=/private/key#private-fragment"),
      "db:5432/memory",
    );
  });

  it("does not echo an invalid connection string", () => {
    assert.equal(databaseAddress("password=private-secret"), "<database url>");
  });
});
