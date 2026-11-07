import { PGlite } from '@electric-sql/pglite';
import type { PostgresPoolFactory } from '../../src/ddl/postgres-pool-factory.js';
import type { PostgresQueryClient } from '../../src/ddl/postgres-query-client.js';
import type { PostgresQueryResult } from '../../src/ddl/postgres-query-result.js';

/**
 * Real `@electric-sql/pglite`-backed implementation of `PostgresQueryClient` and `PostgresPoolFactory` for deterministic tests.
 *
 * Wraps a single WASM PostgreSQL instance per test file (`beforeAll`), supports fast inter-test state reset
 * via `TRUNCATE ... RESTART IDENTITY CASCADE` (`beforeEach`), and deterministically frees WASM linear memory on `close()` (`afterAll`).
 */
export class PgliteTestClient implements PostgresQueryClient, PostgresPoolFactory {
  /** Underlying `@electric-sql/pglite` WASM PostgreSQL engine instance. */
  private readonly db: PGlite;
  /** Last connection URI requested via `getClient(connectionUri)`. */
  public lastRequestedUri: string | undefined;

  /**
   * Initializes a new in-memory `PgliteTestClient` instance backed by `@electric-sql/pglite`.
   *
   * Instantiate at most one `PgliteTestClient` per test file inside `beforeAll` and close it in `afterAll`.
   */
  constructor() {
    this.db = new PGlite();
  }

  /**
   * Returns this client instance for `connectionUri`, recording `lastRequestedUri` for test assertions.
   *
   * Satisfies `PostgresPoolFactory` so `createPostgresExecutors(client)` resolves late-bound `H.env(...)` URIs.
   *
   * @param {string} connectionUri - Resolved PostgreSQL connection URI.
   *
   * @returns {PostgresQueryClient} This `PgliteTestClient` instance.
   */
  getClient(connectionUri: string): PostgresQueryClient {
    this.lastRequestedUri = connectionUri;
    return this;
  }

  /**
   * Executes a parameterized PostgreSQL statement (`$1..$n`) against the backing `PGlite` engine.
   *
   * Converts `Buffer` or `Uint8Array` parameters and normalizes result rows and affected row counts.
   *
   * @template TRow Expected result row shape.
   *
   * @param {string}             sql      - Parameterized PostgreSQL SQL query string.
   * @param {readonly unknown[]} [params] - Positional parameter values bound to `$1..$n`.
   *
   * @returns {Promise<PostgresQueryResult<TRow>>} Normalized rows and affected row count.
   */
  async query<TRow = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<PostgresQueryResult<TRow>> {
    const normalizedParams: unknown[] = [];
    for (const param of params) {
      if (Buffer.isBuffer(param)) {
        normalizedParams.push(new Uint8Array(param.buffer, param.byteOffset, param.byteLength));
      } else {
        normalizedParams.push(param);
      }
    }
    const result = await this.db.query<TRow>(sql, normalizedParams);
    return Object.freeze<PostgresQueryResult<TRow>>({
      rows: Object.freeze(result.rows),
      rowCount: result.affectedRows ?? result.rows.length,
    });
  }

  /**
   * Truncates all tables in the `public` schema with `RESTART IDENTITY CASCADE` between tests.
   *
   * Resets `lastRequestedUri` and clears all rows in `< 1ms` without re-instantiating the WASM engine.
   *
   * @returns {Promise<void>} Resolves once all public tables are truncated.
   */
  async resetTables(): Promise<void> {
    this.lastRequestedUri = undefined;
    const tableResult = await this.db.query<{ readonly tablename: string }>(
      'SELECT tablename FROM pg_tables WHERE schemaname = $1',
      ['public'],
    );
    if (tableResult.rows.length === 0) {
      return;
    }
    const quotedNames: string[] = [];
    for (const row of tableResult.rows) {
      quotedNames.push(`"${row.tablename}"`);
    }
    await this.db.query(`TRUNCATE TABLE ${quotedNames.join(', ')} RESTART IDENTITY CASCADE`);
  }

  /**
   * Closes the underlying `PGlite` WASM instance and frees its linear memory.
   *
   * Must be called unconditionally inside `afterAll` in every test suite using `PgliteTestClient`.
   *
   * @returns {Promise<void>} Resolves once the `PGlite` database is closed.
   */
  async close(): Promise<void> {
    await this.db.close();
  }
}
