import type { z } from 'zod';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { HumanNode } from '../ast/human-node.js';
import type { ScopedHumanTargetNode } from '../ast/scoped-human-target-node.js';

/**
 * Fluent builder representing a scoped human target (`human.withName(alias).output(schema)`).
 *
 * Pairs a bidirectional `HumanNode` with a display role alias and a Zod output schema
 * for structured human decision gates such as `lane.maxCostUsd(limit, approver)`.
 *
 * @template TResponse Validated human decision response type.
 */
export interface ScopedHumanTargetBuilder<TResponse = unknown>
  extends AstBuilder<ScopedHumanTargetNode<TResponse>> {
  /** Underlying bidirectional `HumanNode`. */
  readonly human: HumanNode<'bidirectional'>;
  /** Role alias displayed in decision requests. */
  readonly alias: string;
  /** Bound Zod schema validating the human's decision response. */
  readonly outputSchema: z.ZodType<TResponse>;
}
