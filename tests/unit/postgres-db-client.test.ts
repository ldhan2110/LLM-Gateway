import { describe, it, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";

// Mock pg types for unit testing (no real PG connection)
interface MockQueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

function createMockPool() {
  const mockClient = {
    query: mock.fn(async (_sql: string, _params?: unknown[]): Promise<MockQueryResult> => ({
      rows: [],
      rowCount: 0,
    })),
    release: mock.fn(),
  };

  const pool = {
    query: mock.fn(async (_sql: string, _params?: unknown[]): Promise<MockQueryResult> => ({
      rows: [],
      rowCount: 0,
    })),
    connect: mock.fn(async () => mockClient),
    end: mock.fn(async () => {}),
    _mockClient: mockClient,
  };

  return pool;
}

// Dynamic import to avoid top-level dependency on pg
async function loadAdapter() {
  return import("../../src/lib/db/adapters/postgresDbClient");
}

describe("PostgresDbClient", () => {
  let createPostgresDbClient: Awaited<ReturnType<typeof loadAdapter>>["createPostgresDbClient"];

  beforeEach(async () => {
    const mod = await loadAdapter();
    createPostgresDbClient = mod.createPostgresDbClient;
  });

  it("reports backend as postgres", () => {
    const pool = createMockPool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createPostgresDbClient(pool as any);
    assert.equal(client.backend, "postgres");
  });

  it("all() rewrites ? params and returns rows", async () => {
    const pool = createMockPool();
    pool.query.mock.mockImplementation(async () => ({
      rows: [{ id: 1, name: "test" }],
      rowCount: 1,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createPostgresDbClient(pool as any);
    const rows = await client.all("SELECT * FROM t WHERE id = ? AND x = ?", 1, "a");
    assert.deepEqual(rows, [{ id: 1, name: "test" }]);
    assert.equal(pool.query.mock.callCount(), 1);
    const call = pool.query.mock.calls[0];
    assert.equal(call.arguments[0], "SELECT * FROM t WHERE id = $1 AND x = $2");
    assert.deepEqual(call.arguments[1], [1, "a"]);
  });

  it("get() returns first row or undefined", async () => {
    const pool = createMockPool();
    pool.query.mock.mockImplementation(async () => ({
      rows: [{ id: 1 }],
      rowCount: 1,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createPostgresDbClient(pool as any);
    const row = await client.get("SELECT * FROM t WHERE id = ?", 1);
    assert.deepEqual(row, { id: 1 });
  });

  it("get() returns undefined when no rows", async () => {
    const pool = createMockPool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createPostgresDbClient(pool as any);
    const row = await client.get("SELECT * FROM t WHERE id = ?", 1);
    assert.equal(row, undefined);
  });

  it("run() returns changes and lastInsertRowid for INSERT with RETURNING", async () => {
    const pool = createMockPool();
    pool.query.mock.mockImplementation(async () => ({
      rows: [{ id: 42 }],
      rowCount: 1,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createPostgresDbClient(pool as any);
    const result = await client.run("INSERT INTO t (name) VALUES (?)", "test");
    assert.equal(result.changes, 1);
    assert.equal(result.lastInsertRowid, 42);
  });

  it("run() returns lastInsertRowid=0 for UPDATE", async () => {
    const pool = createMockPool();
    pool.query.mock.mockImplementation(async () => ({
      rows: [],
      rowCount: 3,
    }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createPostgresDbClient(pool as any);
    const result = await client.run("UPDATE t SET name = ? WHERE id = ?", "new", 1);
    assert.equal(result.changes, 3);
    assert.equal(result.lastInsertRowid, 0);
  });

  it("transaction() commits on success", async () => {
    const pool = createMockPool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createPostgresDbClient(pool as any);
    const mockClient = pool._mockClient;

    await client.transaction(async (tx) => {
      await tx.all("SELECT 1");
    });

    const queries = mockClient.query.mock.calls.map(
      (c: { arguments: unknown[] }) => c.arguments[0]
    );
    assert.equal(queries[0], "BEGIN");
    assert.equal(queries[queries.length - 1], "COMMIT");
    assert.equal(mockClient.release.mock.callCount(), 1);
  });

  it("transaction() rolls back on error", async () => {
    const pool = createMockPool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createPostgresDbClient(pool as any);
    const mockClient = pool._mockClient;

    await assert.rejects(async () => {
      await client.transaction(async () => {
        throw new Error("boom");
      });
    }, { message: "boom" });

    const queries = mockClient.query.mock.calls.map(
      (c: { arguments: unknown[] }) => c.arguments[0]
    );
    assert.ok(queries.includes("ROLLBACK"));
    assert.equal(mockClient.release.mock.callCount(), 1);
  });

  it("pragma() returns undefined (no-op on PG)", async () => {
    const pool = createMockPool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createPostgresDbClient(pool as any);
    const result = await client.pragma("journal_mode");
    assert.equal(result, undefined);
  });

  it("close() calls pool.end()", async () => {
    const pool = createMockPool();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = createPostgresDbClient(pool as any);
    await client.close();
    assert.equal(pool.end.mock.callCount(), 1);
  });
});
