/**
 * Convert SQLite-style `?` placeholders to PostgreSQL `$1, $2, ...` syntax.
 * Skips `?` inside single-quoted strings and double-quoted identifiers.
 */
export function toPgSql(sql: string): string {
  let paramIndex = 0;
  let result = "";
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];

    // Single-quoted string — skip to closing quote
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2; // escaped quote
        } else if (sql[j] === "'") {
          j++;
          break;
        } else {
          j++;
        }
      }
      result += sql.slice(i, j);
      i = j;
      continue;
    }

    // Double-quoted identifier — skip to closing quote
    if (ch === '"') {
      const end = sql.indexOf('"', i + 1);
      const j = end === -1 ? sql.length : end + 1;
      result += sql.slice(i, j);
      i = j;
      continue;
    }

    // Unquoted `?` — replace with $N
    if (ch === "?") {
      paramIndex++;
      result += `$${paramIndex}`;
      i++;
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}
