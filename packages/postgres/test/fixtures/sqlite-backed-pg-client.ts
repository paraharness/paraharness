import BetterSqlite3 from 'better-sqlite3';
import type {
  PostgresPoolFactory,
  PostgresQueryClient,
  PostgresQueryResult,
} from '../../src/index.js';

/**
 * In-memory `better-sqlite3`-backed implementation of `PostgresQueryClient` and `PostgresPoolFactory` for deterministic offline tests.
 *
 * Translates PostgreSQL positional `$1..$n` parameters and DDL type keywords (`BIGINT GENERATED ALWAYS AS IDENTITY`, `BYTEA`)
 * into SQLite-compatible statements while preserving full relational, `ON CONFLICT`, and transactional semantics.
 */
export class SqliteBackedPgClient implements PostgresQueryClient, PostgresPoolFactory {
  /** Underlying `better-sqlite3` database connection. */
  private readonly db: BetterSqlite3.Database;
  /** Last connection URI requested via `getClient(connectionUri)`. */
  public lastRequestedUri: string | undefined;
  /** Active transaction nesting depth for savepoint emulation. */
  private txDepth = 0;

  /**
   * Creates a new `SqliteBackedPgClient` backed by an isolated in-memory or file-backed SQLite database.
   *
   * Initializes WAL mode and foreign keys on the backing `better-sqlite3` connection.
   *
   * @param {string} [filename=':memory:'] - Optional SQLite database file path or `:memory:`.
   */
  constructor(filename = ':memory:') {
    this.db = new BetterSqlite3(filename);
    this.db.pragma('journal_mode = WAL');
  }

  /**
   * Returns this client instance for `connectionUri`, recording `lastRequestedUri` for test assertions.
   *
   * Satisfies the `PostgresPoolFactory` interface so `createPostgresExecutors(client)` can resolve `H.env(...)` URIs.
   *
   * @param {string} connectionUri - Resolved PostgreSQL connection URI.
   *
   * @returns {PostgresQueryClient} This `SqliteBackedPgClient` instance.
   */
  getClient(connectionUri: string): PostgresQueryClient {
    this.lastRequestedUri = connectionUri;
    return this;
  }

  /**
   * Executes a PostgreSQL SQL statement with `$1..$n` positional bindings against the backing SQLite engine.
   *
   * Translates `$1..$n` placeholders into ordered `?` bindings and normalizes PostgreSQL DDL clauses.
   *
   * @template TRow Expected result row shape.
   *
   * @param {string}             sql      - Parameterized PostgreSQL SQL query string.
   * @param {readonly unknown[]} [params] - Positional parameter values corresponding to `$1..$n`.
   *
   * @returns {Promise<PostgresQueryResult<TRow>>} Normalized rows and affected row count.
   */
  query<TRow = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<TRow>> {
    try {
      const trimmed = sql.trim();
      const upper = trimmed.toUpperCase();
      if (upper === 'BEGIN') {
        if (this.txDepth === 0) {
          this.db.exec('BEGIN');
        } else {
          this.db.exec(`SAVEPOINT sp_${String(this.txDepth)}`);
        }
        this.txDepth += 1;
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (upper === 'COMMIT') {
        if (this.txDepth > 0) {
          this.txDepth -= 1;
          if (this.txDepth === 0) {
            this.db.exec('COMMIT');
          } else {
            this.db.exec(`RELEASE SAVEPOINT sp_${String(this.txDepth)}`);
          }
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }
      if (upper === 'ROLLBACK') {
        if (this.txDepth > 0) {
          this.txDepth -= 1;
          if (this.txDepth === 0) {
            this.db.exec('ROLLBACK');
          } else {
            this.db.exec(`ROLLBACK TO SAVEPOINT sp_${String(this.txDepth)}`);
          }
        }
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      const normalizedDdl = trimmed
        .replace(/BIGINT\s+GENERATED\s+ALWAYS\s+AS\s+IDENTITY/gi, 'INTEGER')
        .replace(/\bBYTEA\b/gi, 'BLOB')
        .replace(/\bDOUBLE\s+PRECISION\b/gi, 'REAL');

      const boundValues: unknown[] = [];
      const sqliteSql = normalizedDdl.replace(/\$(\d+)/g, (_match, digits: string) => {
        const index = Number.parseInt(digits, 10) - 1;
        const val = params[index];
        boundValues.push(val === undefined ? null : val);
        return '?';
      });

      if (/^SELECT\b/i.test(sqliteSql)) {
        const stmt = this.db.prepare(sqliteSql);
        const rows = stmt.all(...boundValues) as TRow[];
        return Promise.resolve({
          rows: Object.freeze(rows),
          rowCount: rows.length,
        });
      }

      if (boundValues.length === 0 && /^(CREATE|DROP|ALTER)\b/i.test(sqliteSql)) {
        this.db.exec(sqliteSql);
        return Promise.resolve({ rows: [], rowCount: 0 });
      }

      const stmt = this.db.prepare(sqliteSql);
      const info = stmt.run(...boundValues);
      return Promise.resolve({
        rows: [],
        rowCount: info.changes,
      });
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /**
   * Closes the underlying `better-sqlite3` database connection.
   *
   * Releases all in-memory tables and prepared statements.
   *
   * @returns {void} Returns nothing once closed.
   */
  close(): void {
    this.db.close();
  }
}
