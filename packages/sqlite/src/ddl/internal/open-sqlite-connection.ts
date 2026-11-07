import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import Database from 'better-sqlite3';
import {
  SQLITE_DDL_STATEMENTS,
  SQLITE_PRAGMA_STATEMENTS,
  SQL_IDENTIFIER_REGEX,
} from '../sqlite-schema.constants.js';

/**
 * Validates that `identifier` matches `^[A-Za-z_][A-Za-z0-9_]*$`.
 *
 * Throws an actionable error if `identifier` is empty or contains unsafe characters.
 *
 * @param {string} identifier - Candidate SQL table or column identifier.
 * @param {string} fieldName  - Diagnostic field label included in thrown errors.
 *
 * @returns {void} Returns nothing when `identifier` is valid.
 */
export function assertValidSqlIdentifier(identifier: string, fieldName: string): void {
  if (!SQL_IDENTIFIER_REGEX.test(identifier)) {
    throw new Error(
      `Invalid SQLite identifier for '${fieldName}': '${identifier}'. Expected matching /^[A-Za-z_][A-Za-z0-9_]*$/.`,
    );
  }
}

/**
 * Opens or initializes a WAL-mode `better-sqlite3` database connection and applies all schema DDL statements.
 *
 * Resolves relative file URIs against `process.cwd()` (host root per SPEC §1.2 Invariant 5), ensures parent
 * directories exist on disk, and executes `SQLITE_PRAGMA_STATEMENTS` and `SQLITE_DDL_STATEMENTS`.
 *
 * @param {string | Database.Database} uriOrDb - SQLite file path, `:memory:`, or existing `Database` handle.
 *
 * @returns {Database.Database} Initialized `better-sqlite3` database instance.
 */
export function openSqliteConnection(uriOrDb: string | Database.Database): Database.Database {
  let db: Database.Database;
  if (typeof uriOrDb === 'string') {
    const trimmed = uriOrDb.trim();
    if (trimmed.length === 0) {
      throw new Error('Cannot open SQLite connection: database URI must be non-empty.');
    }
    if (trimmed === ':memory:' || trimmed.startsWith('file:')) {
      db = new Database(trimmed);
    } else {
      const resolvedPath = isAbsolute(trimmed) ? trimmed : resolve(process.cwd(), trimmed);
      mkdirSync(dirname(resolvedPath), { recursive: true });
      db = new Database(resolvedPath);
    }
  } else {
    db = uriOrDb;
  }

  try {
    for (const pragmaSql of SQLITE_PRAGMA_STATEMENTS) {
      db.exec(pragmaSql);
    }
    for (const ddlSql of SQLITE_DDL_STATEMENTS) {
      db.exec(ddlSql);
    }
    return db;
  } catch (error) {
    if (typeof uriOrDb === 'string') {
      db.close();
    }
    throw error;
  }
}
