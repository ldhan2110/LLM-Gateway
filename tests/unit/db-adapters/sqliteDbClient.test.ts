import { test, describe } from "node:test";
import assert from "node:assert/strict";

const { tryOpenSync } = await import("../../../src/lib/db/adapters/driverFactory.ts");
const { createSqliteDbClient } = await import(
  "../../../src/lib/db/adapters/sqliteDbClient.ts"
);

function makeClient() {
  const adapter = tryOpenSync(":memory:");
  if (!adapter || adapter.driver !== "better-sqlite3") return null;
  return { client: createSqliteDbClient(adapter), adapter };
}

describe("sqliteDbClient", () => {
  test("backend is 'sqlite'", async () => {
    const ctx = makeClient();
    if (!ctx) return;
    assert.equal(ctx.client.backend, "sqlite");
    await ctx.client.close();
  });

  test("all() returns rows identical to sync adapter", async () => {
    const ctx = makeClient();
    if (!ctx) return;

    await ctx.client.exec(
      "CREATE TABLE t1 (id INTEGER PRIMARY KEY, val TEXT)"
    );
    await ctx.client.run("INSERT INTO t1 (val) VALUES (?)", "a");
    await ctx.client.run("INSERT INTO t1 (val) VALUES (?)", "b");

    const asyncRows = await ctx.client.all<{ id: number; val: string }>(
      "SELECT * FROM t1 ORDER BY id"
    );
    const syncRows = ctx.adapter
      .prepare("SELECT * FROM t1 ORDER BY id")
      .all() as { id: number; val: string }[];

    assert.deepEqual(asyncRows, syncRows);
    assert.equal(asyncRows.length, 2);
    await ctx.client.close();
  });

  test("get() returns first row or undefined", async () => {
    const ctx = makeClient();
    if (!ctx) return;

    await ctx.client.exec("CREATE TABLE t2 (id INTEGER PRIMARY KEY, val TEXT)");
    await ctx.client.run("INSERT INTO t2 (val) VALUES (?)", "hello");

    const row = await ctx.client.get<{ id: number; val: string }>(
      "SELECT * FROM t2 WHERE id = ?",
      1
    );
    assert.equal(row?.val, "hello");

    const missing = await ctx.client.get("SELECT * FROM t2 WHERE id = ?", 999);
    assert.equal(missing, undefined);

    await ctx.client.close();
  });

  test("run() returns changes and lastInsertRowid", async () => {
    const ctx = makeClient();
    if (!ctx) return;

    await ctx.client.exec("CREATE TABLE t3 (id INTEGER PRIMARY KEY, val TEXT)");
    const result = await ctx.client.run(
      "INSERT INTO t3 (val) VALUES (?)",
      "test"
    );
    assert.equal(result.changes, 1);
    assert.ok(
      result.lastInsertRowid === 1 || result.lastInsertRowid === BigInt(1)
    );

    await ctx.client.close();
  });

  test("transaction commits on success", async () => {
    const ctx = makeClient();
    if (!ctx) return;

    await ctx.client.exec("CREATE TABLE t4 (id INTEGER PRIMARY KEY, val TEXT)");

    await ctx.client.transaction(async (c) => {
      await c.run("INSERT INTO t4 (val) VALUES (?)", "a");
      await c.run("INSERT INTO t4 (val) VALUES (?)", "b");
    });

    const rows = await ctx.client.all("SELECT * FROM t4");
    assert.equal(rows.length, 2);
    await ctx.client.close();
  });

  test("transaction rolls back on error", async () => {
    const ctx = makeClient();
    if (!ctx) return;

    await ctx.client.exec(
      "CREATE TABLE t5 (id INTEGER PRIMARY KEY, val TEXT NOT NULL)"
    );

    await assert.rejects(
      ctx.client.transaction(async (c) => {
        await c.run("INSERT INTO t5 (val) VALUES (?)", "before-error");
        throw new Error("forced rollback");
      }),
      /forced rollback/
    );

    const rows = await ctx.client.all("SELECT * FROM t5");
    assert.equal(rows.length, 0, "Transaction should have been rolled back");
    await ctx.client.close();
  });

  test("immediate transaction commits on success", async () => {
    const ctx = makeClient();
    if (!ctx) return;

    await ctx.client.exec("CREATE TABLE t6 (id INTEGER PRIMARY KEY, val TEXT)");

    await ctx.client.immediate(async (c) => {
      await c.run("INSERT INTO t6 (val) VALUES (?)", "imm");
    });

    const row = await ctx.client.get<{ val: string }>(
      "SELECT val FROM t6 WHERE id = 1"
    );
    assert.equal(row?.val, "imm");
    await ctx.client.close();
  });

  test("immediate transaction rolls back on error", async () => {
    const ctx = makeClient();
    if (!ctx) return;

    await ctx.client.exec("CREATE TABLE t7 (id INTEGER PRIMARY KEY, val TEXT)");

    await assert.rejects(
      ctx.client.immediate(async (c) => {
        await c.run("INSERT INTO t7 (val) VALUES (?)", "will-rollback");
        throw new Error("boom");
      }),
      /boom/
    );

    const rows = await ctx.client.all("SELECT * FROM t7");
    assert.equal(rows.length, 0);
    await ctx.client.close();
  });

  test("pragma returns value", async () => {
    const ctx = makeClient();
    if (!ctx) return;

    const mode = await ctx.client.pragma("journal_mode", { simple: true });
    assert.ok(typeof mode === "string");
    await ctx.client.close();
  });

  test("exec runs multi-statement SQL", async () => {
    const ctx = makeClient();
    if (!ctx) return;

    await ctx.client.exec(`
      CREATE TABLE t8 (id INTEGER PRIMARY KEY, val TEXT);
      INSERT INTO t8 (val) VALUES ('x');
      INSERT INTO t8 (val) VALUES ('y');
    `);

    const rows = await ctx.client.all("SELECT * FROM t8");
    assert.equal(rows.length, 2);
    await ctx.client.close();
  });
});
