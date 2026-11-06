import type { z } from 'zod';
import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { AbortHookASTNode, StepASTNode } from '../ast/domain-ast.types.js';
import type { HumanNode } from '../ast/human-node.js';
import type {
  InterruptHandlerNode,
  ReplaceInterruptHandlerNode,
} from '../ast/interrupt-handler-node.types.js';
import type { UniversalStepTelemetry } from '../ports/universal-step-telemetry.js';
import type { AdjudicateInterruptBuilder } from './adjudicate-interrupt-builder.js';
import type { AskInterruptBuilder } from './ask-interrupt-builder.js';
import type { ExtractAbortMeta } from './flow-extraction.types.js';

/**
 * Fluent builder for actor-level and step-level `.onInterrupt(interrupt, $intr => ...)` edges.
 *
 * Supports adjudicator-backed resolution (`.adjudicateWith()`), human decision paging
 * (`.ask()`), and abort-and-replace step promotion (`.onAbort()` + `.replaceWith()`).
 *
 * @template TIn            Flow or actor input payload type.
 * @template TPayload       Interrupt payload type.
 * @template THandle        Runtime handle type of the active isolation scope.
 * @template TCustomMetrics Custom step telemetry metrics type.
 * @template TAbortMeta     Abort hook metadata type.
 */
export interface InterruptEdgeBuilder<
  TIn = unknown,
  TPayload = unknown,
  THandle = unknown,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TAbortMeta extends Record<string, unknown> = Record<string, unknown>,
> extends AstBuilder<InterruptHandlerNode<TIn, TPayload, THandle>> {
  /**
   * Routes the interrupt to a read-only adjudicator step (`mode: 'adjudicate'`).
   *
   * Returns a fluent `AdjudicateInterruptBuilder` requiring `.resumeWith(formatter)`.
   *
   * @template TAdjIn   Adjudicator step input type.
   * @template TVerdict Adjudicator verdict output type.
   *
   * @param {MaybeBuilder<StepASTNode<TAdjIn, TVerdict, THandle>>} adjudicator - Read-only adjudicator step.
   * @param {(input: TIn, payload: TPayload) => TAdjIn}            mapInput    - Synchronous adjudicator input mapper.
   *
   * @returns {AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict>} Fluent adjudicate sub-builder.
   */
  adjudicateWith<TAdjIn, TVerdict>(
    adjudicator: MaybeBuilder<StepASTNode<TAdjIn, TVerdict, THandle>>,
    mapInput: (input: TIn, payload: TPayload) => TAdjIn,
  ): AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict>;

  /**
   * Routes the interrupt to a bidirectional `HumanNode` authority (`mode: 'ask'`).
   *
   * Validates at builder call time that `human` uses a `'bidirectional'` channel.
   *
   * @template TDecision Validated human decision response type.
   * @template TMode     Channel interaction mode of `human`.
   *
   * @param {MaybeBuilder<HumanNode<TMode>>}              human          - Bidirectional human authority node or builder.
   * @param {z.ZodType<TDecision, z.ZodTypeDef, unknown>} responseSchema - Zod schema validating the human's decision.
   *
   * @returns {AskInterruptBuilder<TPayload, TDecision>} Fluent ask sub-builder.
   */
  ask<TDecision, TMode extends 'bidirectional' | 'notify-only' = 'bidirectional' | 'notify-only'>(
    human: MaybeBuilder<HumanNode<TMode>>,
    responseSchema: z.ZodType<TDecision, z.ZodTypeDef, unknown>,
  ): AskInterruptBuilder<TPayload, TDecision>;

  /**
   * Binds an abort hook (`git.snapshotAndReset()`) executed before `.replaceWith(...)` starts its replacement executable.
   *
   * Narrows `TAbortMeta` to the metadata schema of `abortHook` for downstream `mapReplacementInput` callbacks.
   *
   * @template THook Abort hook AST node type.
   *
   * @param {MaybeBuilder<THook>} abortHook - Abort hook AST node or builder.
   *
   * @returns {InterruptEdgeBuilder<TIn, TPayload, THandle, TCustomMetrics, ExtractAbortMeta<THook>>} New immutable interrupt edge builder narrowed to `ExtractAbortMeta<THook>`.
   */
  onAbort<THook extends AbortHookASTNode<THandle>>(
    abortHook: MaybeBuilder<THook>,
  ): InterruptEdgeBuilder<TIn, TPayload, THandle, TCustomMetrics, ExtractAbortMeta<THook>>;

  /**
   * Aborts the current step and promotes execution to `replacementExecutable` (`mode: 'replace'`).
   *
   * Passes `(input, payload, telemetry)` to `mapReplacementInput` to construct the replacement step's input.
   *
   * @template TRepIn  Replacement step input payload type.
   * @template TRepOut Replacement step output payload type.
   *
   * @param {MaybeBuilder<StepASTNode<TRepIn, TRepOut, THandle>>}                                                      replacementExecutable - Replacement step executable.
   * @param {(input: TIn, payload: TPayload, telemetry: UniversalStepTelemetry<TCustomMetrics, TAbortMeta>) => TRepIn} mapReplacementInput   - Replacement input mapper.
   *
   * @returns {AstBuilder<ReplaceInterruptHandlerNode<TIn, TPayload, THandle>>} Compiled replace handler builder.
   */
  replaceWith<TRepIn, TRepOut = unknown>(
    replacementExecutable: MaybeBuilder<StepASTNode<TRepIn, TRepOut, THandle>>,
    mapReplacementInput: (
      input: TIn,
      payload: TPayload,
      telemetry: UniversalStepTelemetry<TCustomMetrics, TAbortMeta>,
    ) => TRepIn,
  ): AstBuilder<ReplaceInterruptHandlerNode<TIn, TPayload, THandle>>;
}
