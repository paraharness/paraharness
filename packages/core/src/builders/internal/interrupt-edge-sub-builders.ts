import type { z } from 'zod';
import type { MaybeBuilder } from '../../ast/ast-foundation.types.js';
import type { AstBuilder } from '../../ast/ast-builder.js';
import type { AbortHookASTNode, StepASTNode } from '../../ast/domain-ast.types.js';
import { extractAST } from '../../ast/extract-ast.js';
import type { HumanNode } from '../../ast/human-node.js';
import type {
  InterruptHandlerNode,
  ReplaceInterruptHandlerNode,
} from '../../ast/interrupt-handler-node.js';
import type { InterruptNode } from '../../ast/interrupt-node.js';
import type { UniversalStepTelemetry } from '../../ports/universal-step-telemetry.js';
import type { AdjudicateInterruptEdgeBuilder } from '../adjudicate-interrupt-builder.js';
import type { AskInterruptEdgeBuilder } from '../ask-interrupt-builder.js';
import type { ExtractAbortMeta } from '../flow-extraction.types.js';
import type { InterruptEdgeBuilder } from '../interrupt-edge-builder.js';
import { createAdjudicateEdgeFromState } from './create-adjudicate-edge-from-state.js';
import {
  createAskEdgeFromState,
  createChildInterruptFromState,
} from './create-ask-and-child-interrupt-from-state.js';
import { deepFreeze } from './deep-freeze.js';
import { validateBidirectionalHumanChannel } from './validate-flow-capabilities.js';

export {
  createAdjudicateEdgeFromState,
  createAskEdgeFromState,
  createChildInterruptFromState,
};

/**
 * Creates an immutable `InterruptEdgeBuilder` from an internal state snapshot.
 *
 * Provides `.adjudicateWith()`, `.ask()`, `.onAbort()`, and `.replaceWith()` transitions
 * for handling interrupts raised on a flow step or actor.
 *
 * @template TIn            Step or actor input payload type.
 * @template TPayload       Interrupt payload type.
 * @template THandle        Isolation scope handle type.
 * @template TCustomMetrics Step custom telemetry metrics record type.
 * @template TAbortMeta     Abort hook metadata record type.
 *
 * @param {{ interrupt: InterruptNode<TPayload>; abortHook: AbortHookASTNode<THandle, TAbortMeta> | undefined }} state - Current interrupt edge state.
 *
 * @returns {InterruptEdgeBuilder<TIn, TPayload, THandle, TCustomMetrics, TAbortMeta>} Frozen interrupt edge builder.
 */
export function createInterruptEdgeFromState<
  TIn = unknown,
  TPayload = unknown,
  THandle = unknown,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TAbortMeta extends Record<string, unknown> = Record<string, unknown>,
>(state: {
  readonly interrupt: InterruptNode<TPayload>;
  readonly abortHook: AbortHookASTNode<THandle, TAbortMeta> | undefined;
}): InterruptEdgeBuilder<TIn, TPayload, THandle, TCustomMetrics, TAbortMeta> {
  return Object.freeze<InterruptEdgeBuilder<TIn, TPayload, THandle, TCustomMetrics, TAbortMeta>>({
    adjudicateWith<TAdjIn, TVerdict>(
      adjudicator: MaybeBuilder<StepASTNode<TAdjIn, TVerdict, THandle>>,
      mapInput: (input: TIn, payload: TPayload) => TAdjIn,
    ): AdjudicateInterruptEdgeBuilder<TIn, TPayload, THandle, TVerdict> {
      return createAdjudicateEdgeFromState({
        interrupt: state.interrupt,
        adjudicator: extractAST(adjudicator),
        mapInput,
        onInterruptHandlers: [],
        elevateLeaseWhen: undefined,
        resumeWith: undefined,
      });
    },
    ask<TDecision, TMode extends 'bidirectional' | 'notify-only' = 'bidirectional' | 'notify-only'>(
      human: MaybeBuilder<HumanNode<TMode>>,
      responseSchema: z.ZodType<TDecision, z.ZodTypeDef, unknown>,
    ): AskInterruptEdgeBuilder<TPayload, TDecision> {
      const humanNode = validateBidirectionalHumanChannel(extractAST(human), '.ask()');
      return createAskEdgeFromState({
        interrupt: state.interrupt,
        human: humanNode,
        responseSchema,
        elevateLeaseWhen: undefined,
        resumeWith: undefined,
      });
    },
    onAbort<THook extends AbortHookASTNode<THandle>>(
      abortHook: MaybeBuilder<THook>,
    ): InterruptEdgeBuilder<TIn, TPayload, THandle, TCustomMetrics, ExtractAbortMeta<THook>> {
      return createInterruptEdgeFromState({ interrupt: state.interrupt, abortHook: extractAST(abortHook) });
    },
    replaceWith<TRepIn, TRepOut = unknown>(
      replacementExecutable: MaybeBuilder<StepASTNode<TRepIn, TRepOut, THandle>>,
      mapReplacementInput: (
        input: TIn,
        payload: TPayload,
        telemetry: UniversalStepTelemetry<TCustomMetrics, TAbortMeta>,
      ) => TRepIn,
    ): AstBuilder<ReplaceInterruptHandlerNode<TIn, TPayload, THandle>> {
      const compiled = deepFreeze<ReplaceInterruptHandlerNode<TIn, TPayload, THandle>>({
        type: 'harness:interrupt-handler',
        mode: 'replace',
        interrupt: state.interrupt,
        abortHook: state.abortHook,
        replacementExecutable: extractAST(replacementExecutable),
        mapReplacementInput,
      });
      return Object.freeze<AstBuilder<ReplaceInterruptHandlerNode<TIn, TPayload, THandle>>>({
        toAST: (): ReplaceInterruptHandlerNode<TIn, TPayload, THandle> => compiled,
      });
    },
    toAST(): InterruptHandlerNode<TIn, TPayload, THandle> {
      throw new Error(
        `Interrupt handler on '${state.interrupt.id}' is incomplete: call .adjudicateWith(...), .ask(...), or .replaceWith(...).`,
      );
    },
  });
}
