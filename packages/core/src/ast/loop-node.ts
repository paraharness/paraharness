import type { z } from 'zod';
import type { AgentNode } from './agent-node.js';
import type { BivariantCallback } from './ast-foundation.types.js';
import type { LessonsNode } from './lessons-node.js';

/**
 * Action step descriptor (`actStep`) inside a `LoopNode`.
 *
 * Binds the literal `stepId` and the write-capable `actor` agent executed at the start of each
 * `.act() -> .evaluate()` refinement iteration.
 *
 * @template TIn        Loop and action step input payload type.
 * @template TOut       Action step and loop output payload type.
 * @template THandle    Runtime handle type of the active isolation scope.
 * @template TActStepId Literal step identifier string of the action step.
 */
export interface LoopActStepConfig<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
  TActStepId extends string = string,
> {
  /** Literal step identifier registered via `.act(stepId, actor)`. */
  readonly stepId: TActStepId;
  /** Write-capable action agent executed on each loop iteration. */
  readonly actor: AgentNode<TIn, TOut, THandle>;
}

/**
 * Evaluation step descriptor (`evaluateStep`) inside a `LoopNode`.
 *
 * Runs the read-only `evaluator` agent over `mapInput(loopInput, actOutput, scopeReceipt)` and
 * either accepts the iteration via `acceptWhen` or formats rejection feedback via `feedbackMapper`.
 *
 * @template TIn      Loop input payload type.
 * @template TOut     Action step output payload type.
 * @template THandle  Runtime handle type of the active isolation scope.
 * @template TReceipt Inspected scope receipt type.
 * @template TEvalOut Evaluator output payload type.
 */
export interface LoopEvaluateStepConfig<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
  TReceipt = unknown,
  TEvalOut = unknown,
> {
  /** Step identifier registered via `.evaluate(stepId, evaluator, ...)`. */
  readonly stepId: string;
  /** Adversarial or read-only evaluator agent invoked after `.act()` passes `beforeStop`. */
  readonly evaluator: AgentNode<unknown, TEvalOut, THandle>;
  /** Synchronous mapper constructing the evaluator's input from `(loopInput, actOutput, scopeReceipt)`. */
  readonly mapInput: BivariantCallback<
    [loopInput: TIn, actOutput: TOut, scopeReceipt: TReceipt],
    unknown
  >;
  /** Predicate returning `true` when the evaluator accepts the action step's output. */
  readonly acceptWhen: BivariantCallback<[evalOut: TEvalOut], boolean>;
  /** Synchronous formatter producing the rejection feedback string injected into the next `.act()` iteration. */
  readonly feedbackMapper: BivariantCallback<[evalOut: TEvalOut], string>;
}

/**
 * Passive AST node representing an iterative action-and-evaluation refinement loop (`H.loop(id)`).
 *
 * Repeatedly executes `actStep` followed by `evaluateStep` up to `maxIterations` times until
 * `evaluateStep.acceptWhen` returns `true`, optionally preserving the actor transcript and distilling lessons.
 *
 * @template TIn        Validated loop input payload type.
 * @template TOut       Validated loop output payload type.
 * @template THandle    Runtime handle type of the active isolation scope.
 * @template TActStepId Literal string type of the action step ID constrained by `.returnOutputFrom(actStepId)`.
 */
export interface LoopNode<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
  TActStepId extends string = string,
> {
  /** Discriminant identifying an iterative refinement loop AST node. */
  readonly type: 'harness:loop';
  /** Unique identifier of the loop definition. */
  readonly id: string;
  /** Canonical role key of the inner `.act()` actor (`actStep.actor.roleKey`). */
  readonly roleKey: string;
  /** Zod schema validating loop input. */
  readonly inputSchema: z.ZodType<TIn, z.ZodTypeDef, unknown>;
  /** Zod schema validating loop output. */
  readonly outputSchema: z.ZodType<TOut, z.ZodTypeDef, unknown>;
  /** Optional synchronous partition extractor mapping `TIn` to active partition IDs. */
  readonly extractPartitions?: BivariantCallback<[input: TIn], readonly string[]>;
  /** Maximum number of `.act() -> .evaluate()` iterations before failing the loop. */
  readonly maxIterations: number;
  /** True when rejected iterations resume the `.act()` actor's existing conversation transcript. */
  readonly preserveActorSession: boolean;
  /** Optional `LessonsNode` receiving contrastive loop recovery pairs and active evaluator violations. */
  readonly distillLessons?: LessonsNode<unknown>;
  /** Action step configuration. */
  readonly actStep: LoopActStepConfig<TIn, TOut, THandle, TActStepId>;
  /** Evaluation step configuration. */
  readonly evaluateStep: LoopEvaluateStepConfig<TIn, TOut, THandle>;
  /** Literal action step ID from which the loop projects its final accepted output. */
  readonly returnOutputFromStepId: TActStepId;
}
