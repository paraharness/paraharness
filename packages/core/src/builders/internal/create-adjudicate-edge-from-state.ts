import type { AstBuilder } from '../../ast/ast-builder.js';
import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type {
  AdjudicateInterruptHandlerNode,
  AdjudicateLeaseElevationConfig,
} from '../../ast/adjudicate-interrupt-handler-node.js';
import type { StepASTNode } from '../../ast/domain-ast.types.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { InterruptHandlerNode } from '../../ast/interrupt-handler-node.types.js';
import type { InterruptNode } from '../../ast/interrupt-node.js';
import type { LeaseDelta } from '../../ports/lease-delta.js';
import type { AdjudicateInterruptBuilder, InterruptEdgeBuilder } from '../interrupt-edge-builder.js';
import { deepFreeze } from './deep-freeze.js';

/**
 * Creates an immutable `AdjudicateInterruptBuilder` from an internal state snapshot.
 *
 * Preserves all prior adjudicator, nested interrupt handler, lease elevation, and
 * resume formatter bindings while returning a new frozen builder on each chain step.
 *
 * @template TIn      Flow or actor input payload type.
 * @template TPayload Interrupt payload type.
 * @template THandle  Isolation scope handle type.
 * @template TVerdict Adjudicator verdict output type.
 *
 * @param {object}   state            - Adjudicate interrupt handler state.
 * @param {Function} createSubEdge    - Factory callback creating a nested `InterruptEdgeBuilder`.
 *
 * @returns {AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict>} Frozen adjudicate builder.
 */
export function createAdjudicateEdgeFromState<
  TIn = unknown,
  TPayload = unknown,
  THandle = unknown,
  TVerdict = unknown,
>(
  state: {
    readonly interrupt: InterruptNode<TPayload>;
    readonly adjudicator: StepASTNode<unknown, TVerdict, THandle>;
    readonly mapInput: (input: TIn, payload: TPayload) => unknown;
    readonly onInterruptHandlers: readonly InterruptHandlerNode<unknown, unknown, THandle>[];
    readonly elevateLeaseWhen: AdjudicateLeaseElevationConfig<TIn, TPayload, TVerdict> | undefined;
    readonly resumeWith: ((input: TIn, payload: TPayload, verdict: TVerdict) => string) | undefined;
  },
  createSubEdge: <TSubPayload>(
    subInterrupt: InterruptNode<TSubPayload>,
  ) => InterruptEdgeBuilder<unknown, TSubPayload, THandle>,
): AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict> {
  return Object.freeze<AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict>>({
    onInterrupt<TSubPayload>(
      subInterrupt: MaybeBuilder<InterruptNode<TSubPayload>>,
      configure: (
        $sub: InterruptEdgeBuilder<unknown, TSubPayload, THandle>,
      ) => AstBuilder<InterruptHandlerNode<unknown, TSubPayload, THandle>>,
    ): AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict> {
      const subHandler = configure(createSubEdge(extractAST(subInterrupt))).toAST();
      return createAdjudicateEdgeFromState(
        {
          ...state,
          onInterruptHandlers: [...state.onInterruptHandlers, subHandler],
        },
        createSubEdge,
      );
    },
    elevateLeaseWhen(
      predicate: (input: TIn, payload: TPayload, verdict: TVerdict) => boolean,
      leaseMapper: (input: TIn, payload: TPayload, verdict: TVerdict) => LeaseDelta,
    ): AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict> {
      return createAdjudicateEdgeFromState(
        {
          ...state,
          elevateLeaseWhen: { predicate, leaseMapper },
        },
        createSubEdge,
      );
    },
    resumeWith(
      formatter: (input: TIn, payload: TPayload, verdict: TVerdict) => string,
    ): AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict> {
      return createAdjudicateEdgeFromState({ ...state, resumeWith: formatter }, createSubEdge);
    },
    toAST(): AdjudicateInterruptHandlerNode<TIn, TPayload, THandle, TVerdict> {
      if (state.resumeWith === undefined) {
        throw new Error(
          `Adjudicate interrupt handler on '${state.interrupt.id}' requires .resumeWith(formatter).`,
        );
      }
      return deepFreeze<AdjudicateInterruptHandlerNode<TIn, TPayload, THandle, TVerdict>>({
        type: 'harness:interrupt-handler',
        mode: 'adjudicate',
        interrupt: state.interrupt,
        adjudicator: state.adjudicator,
        mapInput: state.mapInput,
        onInterruptHandlers: state.onInterruptHandlers,
        elevateLeaseWhen: state.elevateLeaseWhen,
        resumeWith: state.resumeWith,
      });
    },
  });
}
