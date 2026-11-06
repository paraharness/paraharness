import type { BaseRunnerPoolASTNode } from '../base/base-runner-pool-ast-node.js';

/**
 * Passive AST node representing a local OS subprocess and daemon concurrency pool (`local.runner`).
 *
 * Separates one-shot command slots (`slots`) from long-lived background daemon slots (`maxDaemons`).
 */
export interface NodeRunnerNode extends BaseRunnerPoolASTNode<'node:runner'> {
  /** Unique identifier of the local runner pool. */
  readonly id: string;
  /** Maximum concurrent one-shot command executions. */
  readonly slots: number;
  /** Maximum concurrent background daemon sessions. */
  readonly maxDaemons: number;
}
