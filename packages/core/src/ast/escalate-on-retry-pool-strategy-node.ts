import type { ASTNode } from './ast-node.js';

/**
 * Passive AST node for empirical retry-escalation pool strategies.
 *
 * Advances along the ordered candidate list on retry attempts or when a candidate's empirical
 * success rate drops below `minSuccessRate` after `minSamples` executions.
 */
export interface EscalateOnRetryPoolStrategyNode extends ASTNode {
  /** Discriminant identifying a pool selection strategy node. */
  readonly type: 'harness:pool-strategy';
  /** Unique identifier of the strategy configuration. */
  readonly id: string;
  /** Escalation scheduling algorithm kind. */
  readonly strategyKind: 'escalate-on-retry';
  /** Minimum empirical success rate in `[0, 1]` required before skipping to the next tier. */
  readonly minSuccessRate?: number;
  /** Minimum sample count required before `minSuccessRate` enforcement activates. */
  readonly minSamples?: number;
}
