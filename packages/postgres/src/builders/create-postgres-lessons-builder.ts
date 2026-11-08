import type { EnvRef, PostgresLessonsNode } from '@paraharness/core';
import type { PostgresLessonsBuilder } from './postgres-lessons-builder.js';

/**
 * Creates a pure, side-effect-free `PostgresLessonsBuilder` for `postgres.lessonStore(uri)`.
 *
 * Produces an immutable builder whose `.toAST()` method returns a frozen `PostgresLessonsNode`
 * referencing the target PostgreSQL connection URI or symbolic `EnvRef`.
 *
 * @param {string | EnvRef} uri - PostgreSQL connection URI or symbolic `P.env(...)` reference.
 *
 * @returns {PostgresLessonsBuilder} Immutable builder for `PostgresLessonsNode`.
 */
export function createPostgresLessonsBuilder(uri: string | EnvRef): PostgresLessonsBuilder {
  if (typeof uri === 'string' && uri.trim().length === 0) {
    throw new Error('postgres.lessonStore(uri) requires a non-empty database URI.');
  }
  return Object.freeze<PostgresLessonsBuilder>({
    toAST(): PostgresLessonsNode {
      return Object.freeze<PostgresLessonsNode>({
        type: 'postgres:lessons',
        uri,
      });
    },
  });
}
