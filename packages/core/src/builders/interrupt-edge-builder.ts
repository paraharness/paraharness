import type { z } from 'zod';
import type { AdjudicateInterruptHandlerNode } from '../ast/adjudicate-interrupt-handler-node.js';
import type { AskInterruptHandlerNode } from '../ast/ask-interrupt-handler-node.js';
import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { AbortHookASTNode, StepASTNode } from '../ast/domain-ast.types.js';
import type { HumanNode } from '../ast/human-node.js';
import type { InterruptHandlerNode } from '../ast/interrupt-handler-node.types.js';
import type { InterruptNode } from '../ast/interrupt-node.js';
import type { ReplaceInterruptHandlerNode } from '../ast/replace-interrupt-handler-node.js';
import type { LeaseDelta } from '../ports/lease-delta.js';
import type { UniversalStepTelemetry } from '../ports/universal-step-telemetry.js';
import type { ExtractAbortMeta } from './flow-extraction.types.js';

/**
 * Fluent builder for an automated adjudicator interrupt edge (`.adjudicateWith(adjudicator, mapInput)`).
 *
 * Configures nested `.onInterrupt(...)` escalation handlers on the adjudicator, conditional
 * `.elevateLeaseWhen(...)` sandbox lease grants, and the `.resumeWith(...)` formatter.
 *
 * @template TIn      Enclosing step or actor input payload type.
 * @template TPayload Validated interrupt payload type.
 * @template THandle  Runtime handle type of the active isolation scope.
 * @template TVerdict Validated adjudicator output verdict type.
 * @template TAdjIn   Adjudicator input payload type preserved for nested `.onInterrupt(...)` handlers.
 */
export interface AdjudicateInterruptBuilder<
  TIn = unknown,
  TPayload = unknown,
  THandle = unknown,
  TVerdict = unknown,
  TAdjIn = unknown,
> extends AstBuilder<AdjudicateInterruptHandlerNode<TIn, TPayload, THandle, TVerdict>> {
  /**
   * Registers a nested interrupt handler for interrupts raised while the adjudicator step is executing.
   *
   * Enables multi-tier escalation (e.g. adjudicator raises `normativeEscalation` to ask a human).
   *
   * @template TSubPayload Nested interrupt payload type.
   *
   * @param {MaybeBuilder<InterruptNode<TSubPayload>>}                                                                                subInterrupt - Nested interrupt AST node or builder.
   * @param {($sub: InterruptEdgeBuilder<TAdjIn, TSubPayload, THandle>) => AstBuilder<InterruptHandlerNode<TAdjIn, TSubPayload, THandle>>} configure    - Nested interrupt edge configurator.
   *
   * @returns {AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict, TAdjIn>} New immutable adjudicate builder.
   */
  onInterrupt<TSubPayload>(
    subInterrupt: MaybeBuilder<InterruptNode<TSubPayload>>,
    configure: (
      $sub: InterruptEdgeBuilder<TAdjIn, TSubPayload, THandle>,
    ) => AstBuilder<InterruptHandlerNode<TAdjIn, TSubPayload, THandle>>,
  ): AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict, TAdjIn>;

  /**
   * Conditionally elevates the paused actor's write lease when `predicate(input, payload, verdict)` returns `true`.
   *
   * Applies the `LeaseDelta` returned by `leaseMapper` before re-evaluating the parked tool call.
   *
   * @param {(input: TIn, payload: TPayload, verdict: TVerdict) => boolean}    predicate   - Lease elevation condition.
   * @param {(input: TIn, payload: TPayload, verdict: TVerdict) => LeaseDelta} leaseMapper - Lease delta factory.
   *
   * @returns {AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict, TAdjIn>} New immutable adjudicate builder.
   */
  elevateLeaseWhen(
    predicate: (input: TIn, payload: TPayload, verdict: TVerdict) => boolean,
    leaseMapper: (input: TIn, payload: TPayload, verdict: TVerdict) => LeaseDelta,
  ): AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict, TAdjIn>;

  /**
   * Binds the synchronous formatter producing the resume note injected into the paused actor's tool result.
   *
   * Required to complete an `AdjudicateInterruptHandlerNode`.
   *
   * @param {(input: TIn, payload: TPayload, verdict: TVerdict) => string} formatter - Resume note formatter callback.
   *
   * @returns {AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict, TAdjIn>} New immutable adjudicate builder.
   */
  resumeWith(
    formatter: (input: TIn, payload: TPayload, verdict: TVerdict) => string,
  ): AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict, TAdjIn>;
}

/**
 * Fluent builder for a human-in-the-loop interrupt edge (`.ask(human, responseSchema)`).
 *
 * Configures optional conditional `.elevateLeaseWhen(...)` sandbox lease grants and the
 * mandatory `.resumeWith(formatter)` callback converting the human decision into a resume note.
 *
 * @template TPayload  Validated interrupt payload type.
 * @template TDecision Validated human decision response type.
 */
export interface AskInterruptBuilder<TPayload = unknown, TDecision = unknown>
  extends AstBuilder<AskInterruptHandlerNode<TPayload, TDecision>> {
  /**
   * Conditionally elevates the paused actor's write lease when `predicate(decision)` returns `true`.
   *
   * Applies the `LeaseDelta` returned by `leaseMapper(decision)` before resuming the actor.
   *
   * @param {(decision: TDecision) => boolean}    predicate   - Lease elevation condition over the human decision.
   * @param {(decision: TDecision) => LeaseDelta} leaseMapper - Lease delta factory over the human decision.
   *
   * @returns {AskInterruptBuilder<TPayload, TDecision>} New immutable ask interrupt builder.
   */
  elevateLeaseWhen(
    predicate: (decision: TDecision) => boolean,
    leaseMapper: (decision: TDecision) => LeaseDelta,
  ): AskInterruptBuilder<TPayload, TDecision>;

  /**
   * Binds the synchronous formatter converting the validated `TDecision` into an in-band resume note.
   *
   * Required to complete an `AskInterruptHandlerNode`.
   *
   * @param {(decision: TDecision) => string} formatter - Decision-to-string resume formatter.
   *
   * @returns {AskInterruptBuilder<TPayload, TDecision>} New immutable ask interrupt builder.
   */
  resumeWith(formatter: (decision: TDecision) => string): AskInterruptBuilder<TPayload, TDecision>;
}

/**
 * Fluent builder for an `.onInterrupt(interrupt, $intr => ...)` resolution edge on a flow step or actor.
 *
 * Supports three mutually exclusive resolution modes: automated adjudication (`.adjudicateWith(...)`),
 * bidirectional human approval (`.ask(...)`), and abort-plus-replacement (`.onAbort(...).replaceWith(...)`).
 *
 * @template TIn            Enclosing step or actor input payload type.
 * @template TPayload       Validated interrupt payload type.
 * @template THandle        Runtime handle type of the active isolation scope.
 * @template TCustomMetrics Custom step telemetry metrics type.
 * @template TAbortMeta     Structured abort hook metadata type.
 */
export interface InterruptEdgeBuilder<
  TIn = unknown,
  TPayload = unknown,
  THandle = unknown,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TAbortMeta extends Record<string, unknown> = Record<string, unknown>,
> extends AstBuilder<InterruptHandlerNode<TIn, TPayload, THandle>> {
  /**
   * Routes the interrupt to an automated adjudicator step (`AgentNode`, `LoopNode`, or `CommandNode`).
   *
   * Parks the interrupted actor while running `adjudicator` with `mapInput(input, payload)`.
   *
   * @template TAdjIn   Adjudicator input payload type.
   * @template TVerdict Adjudicator output verdict type.
   *
   * @param {MaybeBuilder<StepASTNode<TAdjIn, TVerdict, THandle>>} adjudicator - Adjudicator step AST node or builder.
   * @param {(input: TIn, payload: TPayload) => TAdjIn}            mapInput    - Input mapper for the adjudicator.
   *
   * @returns {AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict, TAdjIn>} Fluent adjudicate interrupt builder.
   */
  adjudicateWith<TAdjIn, TVerdict>(
    adjudicator: MaybeBuilder<StepASTNode<TAdjIn, TVerdict, THandle>>,
    mapInput: (input: TIn, payload: TPayload) => TAdjIn,
  ): AdjudicateInterruptBuilder<TIn, TPayload, THandle, TVerdict, TAdjIn>;

  /**
   * Routes the interrupt to a bidirectional human authority and validates the response with `responseSchema`.
   *
   * Rejects `'notify-only'` human channels at `.ask()` builder call time.
   *
   * @template TDecision Validated human decision response type.
   * @template TMode     Human channel interaction mode (`'bidirectional' | 'notify-only'`).
   *
   * @param {MaybeBuilder<HumanNode<TMode>>} human          - Bidirectional `HumanNode` or builder.
   * @param {z.ZodType<TDecision>}           responseSchema - Zod schema validating the human decision.
   *
   * @returns {AskInterruptBuilder<TPayload, TDecision>} Fluent ask interrupt builder.
   */
  ask<TDecision, TMode extends 'bidirectional' | 'notify-only' = 'bidirectional' | 'notify-only'>(
    human: MaybeBuilder<HumanNode<TMode>>,
    responseSchema: z.ZodType<TDecision>,
  ): AskInterruptBuilder<TPayload, TDecision>;

  /**
   * Binds an explicit abort hook (`git.snapshotAndReset()`) executed before `.replaceWith(...)` starts the replacement step.
   *
   * Narrows `TAbortMeta` to `ExtractAbortMeta<THook>` so `telemetry.abortMeta` is strongly typed in `mapReplacementInput`.
   *
   * @template THook Abort hook AST node type.
   *
   * @param {MaybeBuilder<THook>} abortHook - Abort hook AST node or builder.
   *
   * @returns {InterruptEdgeBuilder<TIn, TPayload, THandle, TCustomMetrics, ExtractAbortMeta<THook>>} New immutable interrupt edge builder.
   */
  onAbort<THook extends AbortHookASTNode<THandle>>(
    abortHook: MaybeBuilder<THook>,
  ): InterruptEdgeBuilder<TIn, TPayload, THandle, TCustomMetrics, ExtractAbortMeta<THook>>;

  /**
   * Aborts the interrupted actor and replaces it with `replacementExecutable`.
   *
   * Passes `(input, payload, telemetry)` to `mapReplacementInput` to construct the replacement step's input.
   *
   * @template TRepIn  Replacement executable input payload type.
   * @template TRepOut Replacement executable output payload type.
   *
   * @param {MaybeBuilder<StepASTNode<TRepIn, TRepOut, THandle>>}                                                               replacementExecutable - Replacement step AST node or builder.
   * @param {(input: TIn, payload: TPayload, telemetry: UniversalStepTelemetry<TCustomMetrics, TAbortMeta>) => TRepIn} mapReplacementInput   - Replacement input projector.
   *
   * @returns {AstBuilder<ReplaceInterruptHandlerNode<TIn, TPayload, THandle>>} Completed replace interrupt handler builder.
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
