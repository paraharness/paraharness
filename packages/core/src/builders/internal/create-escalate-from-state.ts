import type { z } from 'zod';
import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { EscalateCapabilityNode } from '../../ast/escalate-capability-node.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { HumanNode } from '../../ast/human-node.js';
import type { LeaseDelta } from '../../ports/lease-delta.js';
import type { EscalateCapabilityBuilder } from '../escalate-capability-builder.js';
import { deepFreeze } from './deep-freeze.js';
import type { EscalateCapabilityBuilderState } from './escalate-capability-builder-state.js';
import { validateBidirectionalHumanChannel } from './validate-agent-and-human-capabilities.js';

/**
 * Creates a copy-on-write immutable `EscalateCapabilityBuilder` from an internal state snapshot.
 *
 * Statically verifies that the bound `HumanNode` channel is `'bidirectional'` and requires
 * both `.to(human)` and `.response(schema)` before `.toAST()` compilation.
 *
 * @template TPayload  Escalation interrupt payload type.
 * @template TResponse Human decision response type.
 *
 * @param {EscalateCapabilityBuilderState<TPayload, TResponse>} state - Current escalate builder state.
 *
 * @returns {EscalateCapabilityBuilder<TPayload, TResponse>} Frozen escalate capability builder.
 */
export function createEscalateFromState<TPayload = unknown, TResponse = unknown>(
  state: EscalateCapabilityBuilderState<TPayload, TResponse>,
): EscalateCapabilityBuilder<TPayload, TResponse> {
  return Object.freeze<EscalateCapabilityBuilder<TPayload, TResponse>>({
    to<TMode extends 'bidirectional' | 'notify-only' = 'bidirectional' | 'notify-only'>(
      human: MaybeBuilder<HumanNode<TMode>>,
    ): EscalateCapabilityBuilder<TPayload, TResponse> {
      const humanNode = validateBidirectionalHumanChannel(extractAST(human), '.escalate()');
      return createEscalateFromState({
        ...state,
        human: humanNode,
      });
    },
    response<TNewResp>(
      schema: z.ZodType<TNewResp>,
    ): EscalateCapabilityBuilder<TPayload, TNewResp> {
      return createEscalateFromState<TPayload, TNewResp>({
        interrupt: state.interrupt,
        human: state.human,
        responseSchema: schema,
        elevateLeaseWhen: undefined,
      });
    },
    elevateLeaseWhen(
      predicate: (decision: TResponse) => boolean,
      leaseMapper: (decision: TResponse) => LeaseDelta,
    ): EscalateCapabilityBuilder<TPayload, TResponse> {
      return createEscalateFromState({
        ...state,
        elevateLeaseWhen: { predicate, leaseMapper },
      });
    },
    toAST(): EscalateCapabilityNode<TPayload, TResponse> {
      if (state.human === undefined || state.responseSchema === undefined) {
        throw new Error(
          `Escalate capability on '${state.interrupt.id}' requires both .to(human) and .response(schema).`,
        );
      }
      return deepFreeze<EscalateCapabilityNode<TPayload, TResponse>>({
        type: 'harness:escalate-capability',
        interrupt: state.interrupt,
        human: state.human,
        responseSchema: state.responseSchema,
        elevateLeaseWhen: state.elevateLeaseWhen,
      });
    },
  });
}
