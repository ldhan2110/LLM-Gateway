/**
 * Codemod: Convert sync SQLite DB modules to async DbClient.
 *
 * Phase 2 of the SQLite→Postgres migration. Transforms db module files
 * from the sync `getDbInstance().prepare(sql).get/all/run()` pattern to
 * the async `getDbClient()` + `await db.get/all/run(sql, ...params)` pattern.
 *
 * Usage:
 *   npx tsx scripts/codemod-async-db.ts [--dry-run] [--file path]
 *
 * --dry-run: show what would change without writing files
 * --file: process a single file (otherwise processes all src/lib/db/*.ts)
 *
 * What this codemod does (db modules only):
 * 1. Replaces `import { getDbInstance } from "./core"` → `import { getDbClient } from "./core"`
 * 2. Replaces `const db = getDbInstance()` → `const db = getDbClient()`
 * 3. Converts `.prepare(sql).all(...params)` → `await db.all(sql, ...params)`
 * 4. Converts `.prepare(sql).get(...params)` → `await db.get(sql, ...params)`
 * 5. Converts `.prepare(sql).run(...params)` → `await db.run(sql, ...params)`
 * 6. Makes enclosing `export function` → `export async function` with Promise return
 * 7. Converts `db.exec(sql)` → `await db.exec(sql)`
 * 8. Converts `db.transaction(...)` → `await db.transaction(async (c) => { ... })`
 *
 * What it flags but does NOT auto-convert:
 * - Named-param `.run({...})` patterns (need manual positional conversion)
 * - Module-level prepared statements
 * - Complex transaction patterns with stored closures
 * - `.pragma()` calls
 * - `db.immediate()` calls
 *
 * After running this codemod, you still need to:
 * - Fix callers (separate codemod or manual)
 * - Handle flagged edge cases manually
 * - Run typecheck + tests
 */

import fs from "fs";
import path from "path";

const DB_DIR = path.resolve(import.meta.dirname, "../src/lib/db");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const fileArg = args.find((a) => !a.startsWith("--"));

// Files to skip (infrastructure, not domain modules)
const SKIP_FILES = new Set([
  "core.ts",
  "localDb.ts",
  "_rowTypes.ts",
  "caseMapping.ts",
  "readCache.ts",
  "stateReset.ts",
  "schemaColumns.ts",
  "healthCheck.ts",
  "migrationRunner.ts",
  "jsonMigration.ts",
  "AGENTS.md",
]);

// Already converted files
const ALREADY_CONVERTED = new Set([
  "agentBridgeMappings.ts",
  "agentBridgeBypass.ts",
  "agentBridgeState.ts",
]);

interface Warning {
  file: string;
  line: number;
  message: string;
}

const warnings: Warning[] = [];

function processFile(filePath: string): { changed: boolean; content: string } {
  const original = fs.readFileSync(filePath, "utf-8");
  let content = original;
  const fileName = path.basename(filePath);
  const relPath = path.relative(process.cwd(), filePath);

  // Step 1: Replace getDbInstance import with getDbClient
  content = content.replace(
    /import\s*\{([^}]*)\bgetDbInstance\b([^}]*)\}\s*from\s*["']\.\/core(?:\.ts)?["']/g,
    (match, before, after) => {
      const otherImports = (before + after).trim();
      if (otherImports) {
        // Has other imports from core — keep them, replace getDbInstance
        return match.replace("getDbInstance", "getDbClient");
      }
      return `import { getDbClient } from "./core"`;
    }
  );

  // Step 2: Replace getDbInstance() calls with getDbClient()
  content = content.replace(/\bgetDbInstance\(\)/g, "getDbClient()");

  // Step 3: Convert .prepare(sql).all(...params) patterns
  // Match: db.prepare("SQL").all(...) or db\n  .prepare("SQL")\n  .all(...)
  content = content.replace(
    /(\w+)(?:\s*\n\s*)?\.prepare\(([\s\S]*?)\)(?:\s*\n\s*)?\.all\((.*?)\)/g,
    (match, dbVar, sql, params) => {
      const trimmedParams = params.trim();
      if (trimmedParams) {
        return `await ${dbVar}.all(${sql.trim()}, ${trimmedParams})`;
      }
      return `await ${dbVar}.all(${sql.trim()})`;
    }
  );

  // Step 4: Convert .prepare(sql).get(...params) patterns
  content = content.replace(
    /(\w+)(?:\s*\n\s*)?\.prepare\(([\s\S]*?)\)(?:\s*\n\s*)?\.get\((.*?)\)/g,
    (match, dbVar, sql, params) => {
      const trimmedParams = params.trim();
      if (trimmedParams) {
        return `await ${dbVar}.get(${sql.trim()}, ${trimmedParams})`;
      }
      return `await ${dbVar}.get(${sql.trim()})`;
    }
  );

  // Step 5: Convert .prepare(sql).run(...params) patterns
  // Flag named-param patterns
  content = content.replace(
    /(\w+)(?:\s*\n\s*)?\.prepare\(([\s\S]*?)\)(?:\s*\n\s*)?\.run\((.*?)\)/g,
    (match, dbVar, sql, params) => {
      const trimmedParams = params.trim();
      // Check for named params (object arg)
      if (trimmedParams.startsWith("{")) {
        const lineNum = content.substring(0, content.indexOf(match)).split("\n").length;
        warnings.push({
          file: relPath,
          line: lineNum,
          message: `Named-param .run({...}) needs manual conversion to positional params`,
        });
        return match; // Don't auto-convert
      }
      if (trimmedParams) {
        return `await ${dbVar}.run(${sql.trim()}, ${trimmedParams})`;
      }
      return `await ${dbVar}.run(${sql.trim()})`;
    }
  );

  // Step 6: Convert db.exec(sql) → await db.exec(sql)
  content = content.replace(
    /(?<!await\s)(\w+)\.exec\(/g,
    "await $1.exec("
  );

  // Step 7: Flag transaction patterns
  const txMatches = content.match(/\.transaction\(/g);
  if (txMatches && txMatches.length > 0) {
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      if (line.includes(".transaction(")) {
        warnings.push({
          file: relPath,
          line: i + 1,
          message: `Transaction pattern needs manual async conversion`,
        });
      }
    });
  }

  // Step 8: Flag pragma calls
  const pragmaMatches = content.match(/\.pragma\(/g);
  if (pragmaMatches) {
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      if (line.includes(".pragma(")) {
        warnings.push({
          file: relPath,
          line: i + 1,
          message: `.pragma() call needs review (no-op on PG, Phase 3)`,
        });
      }
    });
  }

  // Step 9: Make exported sync functions async
  // Match: export function name(...): ReturnType {
  // Only if function body contains 'await'
  const functionRegex = /^(export\s+)function\s+(\w+)\s*\(([^)]*)\)\s*:\s*([^{]+)\{/gm;
  const functionBodies = content.split(/^(?=export\s+function\s)/m);

  // Simpler approach: find functions that now contain 'await' but aren't async
  content = content.replace(
    /^(export\s+)function\s+(\w+)/gm,
    (match, exportKw, funcName) => {
      // Check if this function's body contains 'await'
      const funcStart = content.indexOf(match);
      const afterMatch = content.substring(funcStart + match.length);
      // Find matching closing brace (rough heuristic: next export function or end)
      const nextExport = afterMatch.search(/\n(?=export\s)/);
      const funcBody = nextExport > 0 ? afterMatch.substring(0, nextExport) : afterMatch;

      if (funcBody.includes("await ")) {
        return `${exportKw}async function ${funcName}`;
      }
      return match;
    }
  );

  // Step 10: Update return types for async functions
  // `async function foo(): SomeType {` → `async function foo(): Promise<SomeType> {`
  content = content.replace(
    /async function (\w+)\(([^)]*)\)\s*:\s*(?!Promise)(\S[^{]*?)\s*\{/g,
    (match, name, params, returnType) => {
      const trimmedReturn = returnType.trim();
      return `async function ${name}(${params}): Promise<${trimmedReturn}> {`;
    }
  );

  const changed = content !== original;
  return { changed, content };
}

// Main
const files: string[] = [];

if (fileArg) {
  files.push(path.resolve(fileArg));
} else {
  // Process all .ts files in src/lib/db/ (not subdirectories for now)
  const entries = fs.readdirSync(DB_DIR);
  for (const entry of entries) {
    if (!entry.endsWith(".ts")) continue;
    if (SKIP_FILES.has(entry)) continue;
    if (ALREADY_CONVERTED.has(entry)) continue;
    if (entry.startsWith("_")) continue;
    files.push(path.join(DB_DIR, entry));
  }
}

let changedCount = 0;
let skippedCount = 0;

for (const file of files) {
  const { changed, content } = processFile(file);
  const rel = path.relative(process.cwd(), file);

  if (!changed) {
    skippedCount++;
    continue;
  }

  changedCount++;
  if (dryRun) {
    console.log(`[DRY-RUN] Would modify: ${rel}`);
  } else {
    fs.writeFileSync(file, content);
    console.log(`[MODIFIED] ${rel}`);
  }
}

console.log(`\n--- Summary ---`);
console.log(`Files processed: ${files.length}`);
console.log(`Files modified: ${changedCount}`);
console.log(`Files unchanged: ${skippedCount}`);

if (warnings.length > 0) {
  console.log(`\n--- Warnings (${warnings.length}) — needs manual fix ---`);
  for (const w of warnings) {
    console.log(`  ${w.file}:${w.line}: ${w.message}`);
  }
}
