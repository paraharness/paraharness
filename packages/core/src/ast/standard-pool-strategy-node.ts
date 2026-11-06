import type { ASTNode } from './ast-node.js';

/**
 * Passive AST node for built-in non-escalating capacity pool selection strategies.
 *
 * Supports `'soonest-reset'`, `'round-robin'`, and `'least-used'` scheduling across seats or models.
 */
export interface StandardPoolStrategyNode extends ASTNode {
  /** Discriminant identifying a pool selection strategy node. */
  readonly type: 'harness:pool-strategy';
  /** Unique identifier of the strategy configuration. */
  readonly id: string;
  /** Built-in scheduling algorithm kind. */
  readonly strategyKind: 'soonest-reset' | 'round-robin' | 'least-used';
}
