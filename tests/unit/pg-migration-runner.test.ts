import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import { resolvePgMigrationsDir } from "../../src/lib/db/pgMigrationRunner";

describe("pgMigrationRunner", () => {
  it("resolves migrations-pg directory", () => {
    const dir = resolvePgMigrationsDir();
    assert.ok(
      dir.endsWith("migrations-pg"),
      `Expected path ending with migrations-pg, got: ${dir}`
    );
  });

  it("migrations-pg/001_initial_schema.sql exists", () => {
    const dir = resolvePgMigrationsDir();
    const schemaPath = path.join(dir, "001_initial_schema.sql");
    assert.ok(fs.existsSync(schemaPath), `Missing: ${schemaPath}`);
  });

  it("001_initial_schema.sql contains core tables", () => {
    const dir = resolvePgMigrationsDir();
    const sql = fs.readFileSync(path.join(dir, "001_initial_schema.sql"), "utf-8");
    assert.ok(sql.includes("provider_connections"), "Missing provider_connections table");
    assert.ok(sql.includes("api_keys"), "Missing api_keys table");
    assert.ok(sql.includes("call_logs"), "Missing call_logs table");
    assert.ok(sql.includes("_omniroute_migrations"), "Missing migrations tracking table");
  });

  it("001_initial_schema.sql uses PG syntax (SERIAL, no AUTOINCREMENT)", () => {
    const dir = resolvePgMigrationsDir();
    const sql = fs.readFileSync(path.join(dir, "001_initial_schema.sql"), "utf-8");
    assert.ok(sql.includes("SERIAL PRIMARY KEY"), "Should use SERIAL for auto-increment");
    assert.ok(!sql.includes("AUTOINCREMENT"), "Should not contain SQLite AUTOINCREMENT");
  });
});
