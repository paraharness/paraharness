import type { AstBuilder, NodeRunnerNode } from '@harness-dsl/core';

/**
 * Fluent builder and passive descriptor for a local OS subprocess runner pool (`local.runner`).
 *
 * Implements both `AstBuilder<NodeRunnerNode>` and `NodeRunnerNode` so it can be passed directly
 * to `H.harness().pools(...)`, `local.command().runner(...)`, `local.streamCheck().runner(...)`,
 * and `local.daemon().runner(...)`.
 */
export interface LocalRunnerBuilder extends AstBuilder<NodeRunnerNode>, NodeRunnerNode {
  /** Discriminant identifying a local Node runner pool AST node. */
  readonly type: 'node:runner';
  /** Unique identifier of the local runner pool. */
  readonly id: string;
  /** Maximum concurrent one-shot command executions. */
  readonly slots: number;
  /** Maximum concurrent background daemon sessions. */
  readonly maxDaemons: number;

  /**
   * Compiles the runner configuration into a pure, deeply frozen `NodeRunnerNode` AST record.
   *
   * Returns a passive AST object containing zero methods for serialization and inspection.
   *
   * @returns {NodeRunnerNode} Frozen passive runner pool AST node.
   */
  toAST(): NodeRunnerNode;
}
