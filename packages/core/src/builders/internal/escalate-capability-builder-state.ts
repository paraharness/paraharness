import type { z } from 'zod';
import type { EscalateLeaseElevationConfig } from '../../ast/escalate-capability-node.js';
import type { HumanNode } from '../../ast/human-node.js';
import type { InterruptNode } from '../../ast/interrupt-node.js';

/**
 * Immutable copy-on-write state snapshot backing `EscalateCapabilityBuilder`.
 *
 * Holds the target escalation interrupt, bidirectional human authority, response schema,
 * and optional capability lease elevation rule.
 *
 * @template TPayload  Escalation interrupt payload type validated by `interrupt.schema`.
 * @template TResponse Human decision response type validated by `responseSchema`.
 */
export interface EscalateCapabilityBuilderState<TPayload = unknown, TResponse = unknown> {
  /** Target interrupt node raised when the escalation tool is invoked. */
  readonly interrupt: InterruptNode<TPayload>;
  /** Bidirectional human authority paged when the escalation tool is invoked. */
  readonly human: HumanNode<'bidirectional'> | undefined;
  /** Zod schema validating the human authority's decision response. */
  readonly responseSchema: z.ZodType<TResponse> | undefined;
  /** Optional conditional capability lease elevation rule evaluated on human response. */
  readonly elevateLeaseWhen: EscalateLeaseElevationConfig<TResponse> | undefined;
}
