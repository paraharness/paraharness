import type { z } from 'zod';
import type { LeaseDelta } from '../ports/lease-delta.js';
import type { UniversalStepTelemetry } from '../ports/universal-step-telemetry.js';
import type { BivariantCallback } from './ast-foundation.types.js';
import type { AbortHookASTNode, StepASTNode } from './domain-ast.types.js';
import type { HumanNode } from './human-node.js';
import type { InterruptNode } from './interrupt-node.js';

/**
 * Conditional capability lease elevation rule evaluated after an adjudicator step produces a verdict.
 *
 * @template TIn      Flow or actor input payload type.
 * @template TPayload Interrupt payload type.
 * @template TVerdict Adjudicator verdict output type.
 */
export type AdjudicateLeaseElevationConfig<
  TIn = unknown,
  TPayload = unknown,
  TVerdict = unknown,
> = {
  /** Synchronous predicate testing whether the adjudicator verdict approves elevating a lease. */
  readonly predicate: BivariantCallback<
    [input: TIn, payload: TPayload, verdict: TVerdict],
    boolean
  >;
  /** Synchronous mapper constructing the `LeaseDelta` granted to the interrupted actor. */
  readonly leaseMapper: BivariantCallback<
    [input: TIn, payload: TPayload, verdict: TVerdict],
    LeaseDelta
  >;
};

/**
 * Conditional capability lease elevation rule evaluated after a human authority responds to an `.ask()` interrupt handler.
 *
 * @template TDecision Validated human decision response type.
 */
export type AskLeaseElevationConfig<TDecision = unknown> = {
  /** Synchronous predicate testing whether the human decision approves elevating a lease. */
  readonly predicate: BivariantCallback<[decision: TDecision], boolean>;
  /** Synchronous mapper constructing the `LeaseDelta` granted to the interrupted actor. */
  readonly leaseMapper: BivariantCallback<[decision: TDecision], LeaseDelta>;
};

/**
 * Interrupt handler variant (`mode: 'adjudicate'`) that dispatches a read-only adjudicator step and resumes the interrupted actor.
 *
 * @template TIn      Flow or actor input payload type.
 * @template TPayload Interrupt payload type.
 * @template THandle  Runtime handle type of the active isolation scope.
 * @template TVerdict Adjudicator verdict output type.
 */
export type AdjudicateInterruptHandlerNode<
  TIn = unknown,
  TPayload = unknown,
  THandle = unknown,
  TVerdict = unknown,
> = {
  /** Discriminant identifying an interrupt handler AST node. */
  readonly type: 'harness:interrupt-handler';
  /** Adjudication handler mode. */
  readonly mode: 'adjudicate';
  /** Target `InterruptNode` intercepted by this handler. */
  readonly interrupt: InterruptNode<TPayload>;
  /** Read-only step executable invoked to adjudicate the interrupt. */
  readonly adjudicator: StepASTNode<unknown, TVerdict, THandle>;
  /** Synchronous mapper constructing the adjudicator's input from `(input, payload)`. */
  readonly mapInput: BivariantCallback<[input: TIn, payload: TPayload], unknown>;
  /** Nested interrupt handlers bound on the adjudicator (e.g. escalating a normative contradiction to a human). */
  readonly onInterruptHandlers: readonly InterruptHandlerNode<unknown, unknown, THandle>[];
  /** Optional lease elevation rule applied when the adjudicator approves a lease request. */
  readonly elevateLeaseWhen?: AdjudicateLeaseElevationConfig<TIn, TPayload, TVerdict>;
  /** Synchronous formatter producing the feedback string returned to the interrupted actor on resumption. */
  readonly resumeWith: BivariantCallback<
    [input: TIn, payload: TPayload, verdict: TVerdict],
    string
  >;
};

/**
 * Interrupt handler variant (`mode: 'ask'`) that pages a bidirectional `HumanNode` and resumes the interrupted actor.
 *
 * @template TPayload  Interrupt payload type.
 * @template TDecision Validated human decision response type.
 */
export type AskInterruptHandlerNode<TPayload = unknown, TDecision = unknown> = {
  /** Discriminant identifying an interrupt handler AST node. */
  readonly type: 'harness:interrupt-handler';
  /** Human decision handler mode. */
  readonly mode: 'ask';
  /** Target `InterruptNode` intercepted by this handler. */
  readonly interrupt: InterruptNode<TPayload>;
  /** Bidirectional human authority paged to resolve the interrupt. */
  readonly human: HumanNode<'bidirectional'>;
  /** Zod schema validating the human's decision response. */
  readonly responseSchema: z.ZodType<TDecision, z.ZodTypeDef, unknown>;
  /** Optional lease elevation rule applied to the outer interrupted actor when the human approves a lease. */
  readonly elevateLeaseWhen?: AskLeaseElevationConfig<TDecision>;
  /** Synchronous formatter producing the feedback string returned to the interrupted actor or adjudicator. */
  readonly resumeWith: BivariantCallback<[decision: TDecision], string>;
};

/**
 * Interrupt handler variant (`mode: 'replace'`) that aborts the current step, runs cleanup hooks, and promotes to a replacement executable.
 *
 * @template TIn      Flow or actor input payload type.
 * @template TPayload Interrupt payload type.
 * @template THandle  Runtime handle type of the active isolation scope.
 */
export type ReplaceInterruptHandlerNode<
  TIn = unknown,
  TPayload = unknown,
  THandle = unknown,
> = {
  /** Discriminant identifying an interrupt handler AST node. */
  readonly type: 'harness:interrupt-handler';
  /** Step replacement and promotion handler mode. */
  readonly mode: 'replace';
  /** Target `InterruptNode` intercepted by this handler. */
  readonly interrupt: InterruptNode<TPayload>;
  /** Optional abort hook executed to snapshot and reset the isolation scope before starting `replacementExecutable`. */
  readonly abortHook?: AbortHookASTNode<THandle, Record<string, unknown>>;
  /** Replacement step executable started after the interrupted step is cleaned up. */
  readonly replacementExecutable: StepASTNode<unknown, unknown, THandle>;
  /** Synchronous mapper projecting `(input, payload, telemetry)` into the replacement executable's input. */
  readonly mapReplacementInput: BivariantCallback<
    [
      input: TIn,
      payload: TPayload,
      telemetry: UniversalStepTelemetry<Record<string, unknown>, Record<string, unknown>>,
    ],
    unknown
  >;
};

/**
 * Passive AST node representing an actor-level or step-level `.onInterrupt(interrupt, $intr => ...)` edge.
 *
 * @template TIn      Flow or actor input payload type.
 * @template TPayload Interrupt payload type.
 * @template THandle  Runtime handle type of the active isolation scope.
 */
export type InterruptHandlerNode<TIn = unknown, TPayload = unknown, THandle = unknown> =
  | AdjudicateInterruptHandlerNode<TIn, TPayload, THandle>
  | AskInterruptHandlerNode<TPayload>
  | ReplaceInterruptHandlerNode<TIn, TPayload, THandle>;
