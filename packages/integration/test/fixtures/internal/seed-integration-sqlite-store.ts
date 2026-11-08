import { openSqliteConnection } from '@metaharness/sqlite';

/**
 * Seeds the SQLite database at `sqlitePath` with the `owner_global_rules` table and initial owner rule row.
 *
 * Closes the SQLite connection deterministically inside a `try / finally` block.
 *
 * @param {string} sqlitePath - Absolute path to `<repoDir>/.harness/state.sqlite`.
 */
export function seedIntegrationSqliteStore(sqlitePath: string): void {
  const db = openSqliteConnection(sqlitePath);
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS owner_global_rules (id TEXT PRIMARY KEY, directive TEXT NOT NULL); INSERT OR IGNORE INTO owner_global_rules (id, directive) VALUES ('owner-rule-1', 'Maintain backwards compatibility unless approved by owner.');",
    );
  } finally {
    db.close();
  }
}
