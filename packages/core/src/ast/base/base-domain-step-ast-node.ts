import type { z } from 'zod';
import type { BivariantCallback } from '../ast-foundation.types.js';

/**
 * Domain-agnostic base AST node contract for external adapter step nodes (`DomainStepASTNode`).
 *
 * Dispatched by `executeStepNode` via `ctx.registry.steps[node.type]` after validating
 * `inputSchema` and prior to validating `outputSchema`.
 *
 * @template TType   String-literal discriminant of the domain step node.
 * @template TIn     Validated step input payload type.
 * @template TOut    Validated step output payload type.
 * @template THandle Isolation scope handle type required by the step.
 */
export interface BaseDomainStepASTNode<
  TType extends string = string,
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
> {
  /** Unique string-literal discriminant of the domain step node. */
  readonly type: TType;
  /** Logical identifier of the step node. */
  readonly id: string;
  /** Zod schema validating the step's input payload at entry. */
  readonly inputSchema: z.ZodType<TIn>;
  /** Zod schema validating the step's output payload at exit. */
  readonly outputSchema: z.ZodType<TOut>;
  /** Phantom type brand binding the step to its compatible scope handle type. */
  readonly __handleBrand?: BivariantCallback<[handle: THandle], void>;
}
