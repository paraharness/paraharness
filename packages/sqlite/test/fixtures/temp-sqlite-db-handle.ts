/**
 * Handle managing an isolated temporary SQLite database directory and file path for unit tests.
 *
 * Exposes the absolute path to the SQLite `.sqlite` file along with a synchronous cleanup callback
 * that removes the temporary directory and all WAL/SHM sidecar files after the test completes.
 */
export interface TempSqliteDbHandle {
  /** Absolute filesystem path to the temporary SQLite database file. */
  readonly dbPath: string;

  /**
   * Deletes the temporary directory and any SQLite database or WAL/SHM files created inside it.
   *
   * Safe to invoke inside `afterEach` or `finally` blocks after closing active database connections.
   *
   * @returns {void} No return value.
   */
  cleanup(): void;
}
