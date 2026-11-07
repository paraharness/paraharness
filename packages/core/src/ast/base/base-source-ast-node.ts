import type { BivariantCallback } from '../ast-foundation.types.js';

/**
 * Domain-agnostic base AST node contract for external content and rule/skill sources (`SourceASTNode`).
 *
 * Resolved lazily at run or session start via `RuntimeExecutorRegistry.sources[node.type]`
 * into `{ content, digest }`.
 *
 * @template TType String-literal discriminant of the source node.
 * @template T     Resolved payload type produced by the source executor.
 */
export interface BaseSourceASTNode<TType extends string = string, T = unknown> {
  /** Unique string-literal discriminant of the source node. */
  readonly type: TType;
  /** Logical identifier of the source descriptor. */
  readonly id: string;
  /** Phantom type brand preserving the resolved content type `T`. */
  readonly __dataType?: BivariantCallback<[data: T], void>;
}
