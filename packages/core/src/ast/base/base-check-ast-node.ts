import type { BivariantCallback } from '../ast-foundation.types.js';

/**
 * Domain-agnostic base AST node contract for deterministic verification checks (`CheckASTNode`).
 *
 * Executed at actor `beforeStop` gates, scoped rule enforcement points, and branch reconciliation
 * boundaries via `RuntimeExecutorRegistry.checks[node.type]`.
 *
 * @template TType   String-literal discriminant identifying the check implementation.
 * @template THandle Isolation scope handle type inspected by the check.
 */
export interface BaseCheckASTNode<TType extends string = string, THandle = unknown> {
  /** Unique string-literal discriminant of the check node. */
  readonly type: TType;
  /** Logical identifier of the check instance. */
  readonly id: string;
  /** Phantom type brand binding the check to its compatible scope handle type. */
  readonly __handleBrand?: BivariantCallback<[handle: THandle], void>;
}
