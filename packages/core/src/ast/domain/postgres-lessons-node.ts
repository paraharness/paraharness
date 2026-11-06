import type { BaseLessonStoreASTNode } from '../base/base-lesson-store-ast-node.js';
import type { EnvRef } from '../env-ref.js';

/**
 * Passive AST node configuring a PostgreSQL lesson store (`postgres.lessonStore`).
 *
 * Persists distilled empirical lessons, full-text search vectors, and sliding-window injection
 * outcome history inside a PostgreSQL database.
 */
export interface PostgresLessonsNode extends BaseLessonStoreASTNode<'postgres:lessons'> {
  /** PostgreSQL connection URI or symbolic `EnvRef`. */
  readonly uri: string | EnvRef;
}
