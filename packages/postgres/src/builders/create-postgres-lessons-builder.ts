import type { EnvRef, PostgresLessonsNode } from '@harness-dsl/core';
import type { PostgresLessonsBuilder } from './postgres-lessons-builder.js';

/**
 * Creates a pure, side-effect-free `PostgresLessonsBuilder` for `postgres.lessonStore(uri)`.
 *
 * Produces an immutable builder whose `.toAST()` method returns a frozen `PostgresLessonsNode`
 * referencing the target PostgreSQL connection URI or symbolic `EnvRef`.
 *
 * @param {string | EnvRef} uri - PostgreSQL connection URI or symbolic `H.env(...)` reference.
 *
 * @returns {PostgresLessonsBuilder} Immutable builder for `PostgresLessonsNode`.
 */
export function createPostgresLessonsBuilder(uri: string | EnvRef): PostgresLessonsBuilder {
  return Object.freeze<PostgresLessonsBuilder>({
    toAST(): PostgresLessonsNode {
      return Object.freeze<PostgresLessonsNode>({
        type: 'postgres:lessons',
        uri,
      });
    },
  });
}
