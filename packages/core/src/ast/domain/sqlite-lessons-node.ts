import type { BaseLessonStoreASTNode } from '../base/base-lesson-store-ast-node.js';

/**
 * Passive AST node configuring a WAL-mode SQLite lesson store (`sqlite.lessonStore`).
 *
 * Persists distilled empirical lessons, FTS5 full-text indices, and sliding-window injection
 * outcome history inside a local SQLite database.
 */
export interface SqliteLessonsNode extends BaseLessonStoreASTNode<'sqlite:lessons'> {
  /** Host-root-relative SQLite database file path or `:memory:` URI. */
  readonly uri: string;
}
