import type { z } from 'zod';
import type { HumanNode } from './human-node.js';

/**
 * Passive AST node representing a role-aliased bidirectional human decision target with a bound output schema (`human.withName(alias).output(schema)`).
 *
 * Used by `P.lane.maxCostUsd` and structured human approval gates where the human channel
 * must validate its response against a specific Zod schema `outputSchema`.
 *
 * @template TResponse Validated human decision response type.
 */
export interface ScopedHumanTargetNode<TResponse = unknown> {
  /** Discriminant identifying a scoped human target AST node. */
  readonly type: 'harness:scoped-human';
  /** Underlying bidirectional `HumanNode` authority. */
  readonly human: HumanNode<'bidirectional'>;
  /** Role alias displayed in decision requests and audit logs. */
  readonly alias: string;
  /** Zod schema validating the human's decision response. */
  readonly outputSchema: z.ZodType<TResponse>;
}
