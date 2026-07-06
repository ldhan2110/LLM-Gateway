import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { toPgSql } from "../../src/lib/db/adapters/pgParamRewriter";

describe("toPgSql", () => {
  it("converts ? to $1, $2, $3", () => {
    assert.equal(
      toPgSql("SELECT * FROM users WHERE id = ? AND name = ?"),
      "SELECT * FROM users WHERE id = $1 AND name = $2"
    );
  });

  it("leaves strings without ? unchanged", () => {
    assert.equal(
      toPgSql("SELECT * FROM users"),
      "SELECT * FROM users"
    );
  });

  it("skips ? inside single-quoted strings", () => {
    assert.equal(
      toPgSql("SELECT * FROM users WHERE name = '?' AND id = ?"),
      "SELECT * FROM users WHERE name = '?' AND id = $1"
    );
  });

  it("skips ? inside double-quoted identifiers", () => {
    assert.equal(
      toPgSql('SELECT "what?" FROM t WHERE id = ?'),
      'SELECT "what?" FROM t WHERE id = $1'
    );
  });

  it("handles escaped single quotes inside strings", () => {
    assert.equal(
      toPgSql("INSERT INTO t (v) VALUES ('it''s a ?') WHERE id = ?"),
      "INSERT INTO t (v) VALUES ('it''s a ?') WHERE id = $1"
    );
  });

  it("handles multiple params in INSERT", () => {
    assert.equal(
      toPgSql("INSERT INTO t (a, b, c) VALUES (?, ?, ?)"),
      "INSERT INTO t (a, b, c) VALUES ($1, $2, $3)"
    );
  });

  it("passes through $N placeholders already present", () => {
    assert.equal(
      toPgSql("SELECT * FROM t WHERE id = $1"),
      "SELECT * FROM t WHERE id = $1"
    );
  });
});
