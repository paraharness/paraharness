import type { z } from 'zod';
import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { EscalateCapabilityNode } from '../ast/escalate-capability-node.js';
import type { HumanNode } from '../ast/human-node.js';
import type { LeaseDelta } from '../ports/lease-delta.js';

/**
 * Fluent sub-builder for voluntary exogenous human escalation (`$cap.escalate(interrupt, $esc => ...)`).
 *
 * Binds a bidirectional `HumanNode` authority, a Zod decision response schema, and an
 * optional capability lease elevation rule.
 *
 * @template TPayload  Escalation brief payload type validated by `interrupt.schema`.
 * @template TResponse Human decision response type validated by `responseSchema`.
 */
export interface EscalateCapabilityBuilder<TPayload = unknown, TResponse = unknown>
  extends AstBuilder<EscalateCapabilityNode<TPayload, TResponse>> {
  /**
   * Binds the bidirectional `HumanNode` authority paged when the escalation tool is invoked.
   *
   * Throws at builder call time if `human`'s channel is `'notify-only'`.
   *
   * @template TMode Interaction mode of `human` (`'bidirectional' | 'notify-only'`).
   *
   * @param {MaybeBuilder<HumanNode<TMode>>} human - Target human authority node or builder.
   *
   * @returns {EscalateCapabilityBuilder<TPayload, TResponse>} New immutable escalation builder.
   */
  to<TMode extends 'bidirectional' | 'notify-only' = 'bidirectional' | 'notify-only'>(
    human: MaybeBuilder<HumanNode<TMode>>,
  ): EscalateCapabilityBuilder<TPayload, TResponse>;

  /**
   * Binds the Zod validation schema for the human authority's decision response.
   *
   * Resets any previously bound `elevateLeaseWhen` rule when the response type changes.
   *
   * @template TNewResp Validated human decision response type.
   *
   * @param {z.ZodType<TNewResp, z.ZodTypeDef, unknown>} schema - Zod schema validating the human response.
   *
   * @returns {EscalateCapabilityBuilder<TPayload, TNewResp>} New immutable escalation builder.
   */
  response<TNewResp>(
    schema: z.ZodType<TNewResp, z.ZodTypeDef, unknown>,
  ): EscalateCapabilityBuilder<TPayload, TNewResp>;

  /**
   * Registers a conditional capability lease elevation rule evaluated when the human responds.
   *
   * Grants the `LeaseDelta` returned by `leaseMapper(decision)` whenever `predicate(decision)` holds.
   *
   * @param {(decision: TResponse) => boolean}    predicate   - Predicate testing whether a lease should be granted.
   * @param {(decision: TResponse) => LeaseDelta} leaseMapper - Mapper producing the `LeaseDelta` to grant.
   *
   * @returns {EscalateCapabilityBuilder<TPayload, TResponse>} New immutable escalation builder.
   */
  elevateLeaseWhen(
    predicate: (decision: TResponse) => boolean,
    leaseMapper: (decision: TResponse) => LeaseDelta,
  ): EscalateCapabilityBuilder<TPayload, TResponse>;
}
