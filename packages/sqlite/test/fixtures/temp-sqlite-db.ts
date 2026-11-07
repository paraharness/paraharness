import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TempSqliteDbHandle } from './temp-sqlite-db-handle.js';

/**
 * Allocates a fresh temporary directory in `os.tmpdir()` and returns a SQLite database file path handle.
 *
 * Ensures each unit test operates against a real, isolated on-disk SQLite file with full WAL journal
 * semantics and zero cross-test state contamination.
 *
 * @param {string} [fileName='test-state.sqlite'] - Relative SQLite filename inside the temporary directory.
 *
 * @returns {TempSqliteDbHandle} Temporary database path and deterministic cleanup callback.
 */
export function createTempSqliteDb(fileName = 'test-state.sqlite'): TempSqliteDbHandle {
  const dirPath = mkdtempSync(join(tmpdir(), 'harness-sqlite-test-'));
  const dbPath = join(dirPath, fileName);
  return Object.freeze<TempSqliteDbHandle>({
    dbPath,
    uri: dbPath,
    cleanup(): void {
      rmSync(dirPath, { recursive: true, force: true });
    },
  });
}
