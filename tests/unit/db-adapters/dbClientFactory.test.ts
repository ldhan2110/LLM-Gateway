import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";

const { tryOpenSync } = await import("../../../src/lib/db/adapters/driverFactory.ts");
const { getDbClient, resetDbClient } = await import(
  "../../../src/lib/db/adapters/dbClientFactory.ts"
);

afterEach(() => {
  resetDbClient();
  // Clean up globalThis adapter set by tests
  delete globalThis.__omnirouteDb;
});

describe("dbClientFactory", () => {
  test("getDbClient() throws when no adapter initialized", () => {
    delete globalThis.__omnirouteDb;
    assert.throws(() => getDbClient(), /not initialized/);
  });

  test("getDbClient() returns a DbClient when adapter exists on globalThis", () => {
    const adapter = tryOpenSync(":memory:");
    if (!adapter) return;
    globalThis.__omnirouteDb = adapter;

    const client = getDbClient();
    assert.equal(client.backend, "sqlite");

    // Second call returns same singleton
    const client2 = getDbClient();
    assert.strictEqual(client, client2);

    adapter.close();
  });

  test("resetDbClient() clears singleton; next call re-wraps", () => {
    const adapter = tryOpenSync(":memory:");
    if (!adapter) return;
    globalThis.__omnirouteDb = adapter;

    const first = getDbClient();
    resetDbClient();
    const second = getDbClient();

    assert.notStrictEqual(first, second);
    assert.equal(second.backend, "sqlite");

    adapter.close();
  });

  test("DATABASE_BACKEND=postgres throws not-yet-implemented", () => {
    const original = process.env.DATABASE_BACKEND;
    try {
      process.env.DATABASE_BACKEND = "postgres";
      resetDbClient();
      assert.throws(() => getDbClient(), /not yet implemented/);
    } finally {
      if (original === undefined) {
        delete process.env.DATABASE_BACKEND;
      } else {
        process.env.DATABASE_BACKEND = original;
      }
    }
  });
});
