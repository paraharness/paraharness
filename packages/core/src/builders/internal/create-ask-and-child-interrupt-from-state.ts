import type { z } from 'zod';
import type {
  AskInterruptHandlerNode,
  AskLeaseElevationConfig,
} from '../../ast/ask-interrupt-handler-node.js';
import type { ChildInterruptHandlerNode } from '../../ast/child-interrupt-handler-node.js';
import type { HumanNode } from '../../ast/human-node.js';
import type { InterruptNode } from '../../ast/interrupt-node.js';
import type { LeaseDelta } from '../../ports/lease-delta.js';
import type { ChildInterruptHandlerBuilder } from '../child-interrupt-handler-builder.js';
import type { AskInterruptBuilder } from '../interrupt-edge-builder.js';
import { deepFreeze } from './deep-freeze.js';

/**
 * Creates an immutable `AskInterruptBuilder` from an internal state snapshot.
 *
 * Captures the bidirectional human channel, response schema, optional lease elevation
 * rule, and required `.resumeWith()` formatter for an `ask`-mode interrupt handler.
 *
 * @template TPayload  Interrupt payload type.
 * @template TDecision Validated human decision response type.
 *
 * @param {object} state - Ask interrupt handler state.
 *
 * @returns {AskInterruptBuilder<TPayload, TDecision>} Frozen ask builder.
 */
export function createAskEdgeFromState<TPayload = unknown, TDecision = unknown>(state: {
  readonly interrupt: InterruptNode<TPayload>;
  readonly human: HumanNode<'bidirectional'>;
  readonly responseSchema: z.ZodType<TDecision>;
  readonly elevateLeaseWhen: AskLeaseElevationConfig<TDecision> | undefined;
  readonly resumeWith: ((decision: TDecision) => string) | undefined;
}): AskInterruptBuilder<TPayload, TDecision> {
  return Object.freeze<AskInterruptBuilder<TPayload, TDecision>>({
    elevateLeaseWhen(
      predicate: (decision: TDecision) => boolean,
      leaseMapper: (decision: TDecision) => LeaseDelta,
    ): AskInterruptBuilder<TPayload, TDecision> {
      return createAskEdgeFromState({ ...state, elevateLeaseWhen: { predicate, leaseMapper } });
    },
    resumeWith(formatter: (decision: TDecision) => string): AskInterruptBuilder<TPayload, TDecision> {
      return createAskEdgeFromState({ ...state, resumeWith: formatter });
    },
    toAST(): AskInterruptHandlerNode<TPayload, TDecision> {
      if (state.resumeWith === undefined) {
        throw new Error(`Ask interrupt handler on '${state.interrupt.id}' requires .resumeWith(formatter).`);
      }
      return deepFreeze<AskInterruptHandlerNode<TPayload, TDecision>>({
        type: 'harness:interrupt-handler',
        mode: 'ask',
        interrupt: state.interrupt,
        human: state.human,
        responseSchema: state.responseSchema,
        elevateLeaseWhen: state.elevateLeaseWhen,
        resumeWith: state.resumeWith,
      });
    },
  });
}

/**
 * Creates an immutable `ChildInterruptHandlerBuilder` from an internal state snapshot.
 *
 * Compiles `.onChildInterrupt()` configurations that optionally pause sibling forks
 * in affected partitions before suspending and returning to the parent agent.
 *
 * @template TPayload Interrupt payload type.
 *
 * @param {object} state - Current child interrupt state.
 *
 * @returns {ChildInterruptHandlerBuilder<TPayload>} Frozen child interrupt builder.
 */
export function createChildInterruptFromState<TPayload = unknown>(state: {
  readonly interrupt: InterruptNode<TPayload>;
  readonly pauseSiblingForksInPartitions: ((payload: TPayload) => readonly string[]) | undefined;
  readonly suspended: boolean;
}): ChildInterruptHandlerBuilder<TPayload> {
  return Object.freeze<ChildInterruptHandlerBuilder<TPayload>>({
    pauseSiblingForksInPartitions: (mapper: (payload: TPayload) => readonly string[]) =>
      createChildInterruptFromState({ ...state, pauseSiblingForksInPartitions: mapper }),
    suspendAndReturnToParent: () => createChildInterruptFromState({ ...state, suspended: true }),
    toAST: (): ChildInterruptHandlerNode<TPayload> => {
      if (!state.suspended) {
        throw new Error(
          `Child interrupt handler for '${state.interrupt.id}' requires .suspendAndReturnToParent().`,
        );
      }
      return deepFreeze<ChildInterruptHandlerNode<TPayload>>({
        type: 'harness:child-interrupt-handler',
        interrupt: state.interrupt,
        pauseSiblingForksInPartitions: state.pauseSiblingForksInPartitions,
        mode: 'suspend-and-return-to-parent',
      });
    },
  });
}
