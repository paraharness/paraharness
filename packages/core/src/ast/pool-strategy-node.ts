import type { PoolSelectorFn } from './pool-selector.types.js';

/**
 * Passive AST node for built-in non-escalating capacity pool selection strategies.
 *
 * Supports `'soonest-reset'`, `'round-robin'`, and `'least-used'` scheduling across seats or models.
 */
export type StandardPoolStrategyNode = {
  /** Discriminant identifying a pool selection strategy node. */
  readonly type: 'harness:pool-strategy';
  /** Unique identifier of the strategy configuration. */
  readonly id: string;
  /** Built-in scheduling algorithm kind. */
  readonly strategyKind: 'soonest-reset' | 'round-robin' | 'least-used';
};

/**
 * Passive AST node for empirical retry-escalation pool strategies.
 *
 * Advances along the ordered candidate list on retry attempts or when a candidate's empirical
 * success rate drops below `minSuccessRate` after `minSamples` executions.
 */
export type EscalateOnRetryPoolStrategyNode = {
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
};

/**
 * Passive AST node for user-supplied custom pool selector functions.
 *
 * @template TItem Pooled resource item type.
 */
export type CustomPoolStrategyNode<TItem = unknown> = {
  /** Discriminant identifying a pool selection strategy node. */
  readonly type: 'harness:pool-strategy';
  /** Unique identifier of the strategy configuration. */
  readonly id: string;
  /** Custom selector strategy kind. */
  readonly strategyKind: 'custom';
  /** Synchronous selector callback invoked to pick a candidate from the pool. */
  readonly selectFn: PoolSelectorFn<TItem>;
};

/**
 * Discriminated union of passive capacity pool selection strategy AST nodes.
 *
 * @template TItem Pooled resource item type.
 */
export type PoolStrategyNode<TItem = unknown> =
  | StandardPoolStrategyNode
  | EscalateOnRetryPoolStrategyNode
  | CustomPoolStrategyNode<TItem>;
