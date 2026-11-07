import type { z } from 'zod';
import type { AgentNode } from '../ast/agent-node.js';
import type { MaybeBuilder } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { ToolASTNode } from '../ast/domain-ast.types.js';
import type { LessonsNode } from '../ast/lessons-node.js';
import type { LoopNode } from '../ast/loop-node.js';
import type { PolicyNode } from '../ast/policy-node.js';
import type { ExtractEvalScopeReceipt } from './flow-extraction.types.js';
import type { LoopEvaluateOptions } from './loop-evaluate-options.js';

/**
 * Fluent builder for an iterative action-and-evaluation refinement loop (`H.loop(id)`).
 *
 * Pairs a write-capable `.act(stepId, actor)` agent with a read-only adversarial
 * `.evaluate(stepId, evaluator, options)` agent and enforces `.returnOutputFrom(actStepId)`.
 *
 * @template TIn        Validated loop input payload type.
 * @template TOut       Validated loop output payload type.
 * @template THandle    Runtime handle type of the active isolation scope.
 * @template TActStepId Literal string type of the action step ID constrained by `.returnOutputFrom(actStepId)`.
 */
export interface LoopBuilder<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
  TActStepId extends string = string,
> extends AstBuilder<LoopNode<TIn, TOut, THandle, TActStepId>> {
  /** Unique identifier of the loop definition. */
  readonly id: string;
  /** Canonical role key of the inner `.act()` actor (`actStep.actor.roleKey`). */
  readonly roleKey: string;

  /**
   * Binds the Zod validation schema for the loop's input payload.
   *
   * Resets dependent `extractPartitions`, `actStep`, and `evaluateStep` bindings when changed.
   *
   * @template TNewIn Validated loop input payload type.
   *
   * @param {z.ZodType<TNewIn>} schema - Zod schema validating loop input.
   *
   * @returns {LoopBuilder<TNewIn, TOut, THandle, TActStepId>} New immutable loop builder.
   */
  input<TNewIn>(
    schema: z.ZodType<TNewIn>,
  ): LoopBuilder<TNewIn, TOut, THandle, TActStepId>;

  /**
   * Binds the Zod validation schema for the loop's output payload.
   *
   * Resets dependent `actStep` and `evaluateStep` bindings when changed.
   *
   * @template TNewOut Validated loop output payload type.
   *
   * @param {z.ZodType<TNewOut>} schema - Zod schema validating loop output.
   *
   * @returns {LoopBuilder<TIn, TNewOut, THandle, TActStepId>} New immutable loop builder.
   */
  output<TNewOut>(
    schema: z.ZodType<TNewOut>,
  ): LoopBuilder<TIn, TNewOut, THandle, TActStepId>;

  /**
   * Binds an optional synchronous partition extractor mapping `TIn` to active partition IDs.
   *
   * Populates `ResolutionContext.activePartitions` across iterations of the loop.
   *
   * @param {(input: TIn) => readonly string[]} extractor - Partition ID extractor callback.
   *
   * @returns {LoopBuilder<TIn, TOut, THandle, TActStepId>} New immutable loop builder.
   */
  partitions(
    extractor: (input: TIn) => readonly string[],
  ): LoopBuilder<TIn, TOut, THandle, TActStepId>;

  /**
   * Sets the maximum number of `.act() -> .evaluate()` iterations before failing the loop.
   *
   * Throws immediately at builder call time if `count < 1` or is not an integer.
   *
   * @param {number} count - Positive integer iteration limit.
   *
   * @returns {LoopBuilder<TIn, TOut, THandle, TActStepId>} New immutable loop builder.
   */
  maxIterations(count: number): LoopBuilder<TIn, TOut, THandle, TActStepId>;

  /**
   * Configures whether rejected iterations resume the `.act()` actor's existing conversation transcript.
   *
   * Defaults to `true` so evaluator rejection feedback is appended in-place onto the `.act()` session.
   *
   * @param {boolean} preserve - True to append evaluator feedback onto the existing `.act()` session.
   *
   * @returns {LoopBuilder<TIn, TOut, THandle, TActStepId>} New immutable loop builder.
   */
  preserveActorSession(preserve: boolean): LoopBuilder<TIn, TOut, THandle, TActStepId>;

  /**
   * Binds an optional `LessonsNode` receiving contrastive loop recovery pairs and active evaluator violations.
   *
   * Triggers contrastive distillation when a rejected iteration is followed by an accepted iteration.
   *
   * @param {MaybeBuilder<LessonsNode<unknown>>} lessons - Target `LessonsNode` or builder.
   *
   * @returns {LoopBuilder<TIn, TOut, THandle, TActStepId>} New immutable loop builder.
   */
  distillLessonsInto(
    lessons: MaybeBuilder<LessonsNode<unknown>>,
  ): LoopBuilder<TIn, TOut, THandle, TActStepId>;

  /**
   * Binds the write-capable action step executed on each loop iteration.
   *
   * Narrows `TActStepId` to `TNewActStepId` and updates `roleKey` to `actor.roleKey`.
   *
   * @template TNewActStepId Literal step identifier string of the action step.
   *
   * @param {TNewActStepId}                               stepId - Action step identifier.
   * @param {MaybeBuilder<AgentNode<TIn, TOut, THandle>>} actor  - Action agent AST node or builder.
   *
   * @returns {LoopBuilder<TIn, TOut, THandle, TNewActStepId>} New immutable loop builder narrowed to `TNewActStepId`.
   */
  act<TNewActStepId extends string>(
    stepId: TNewActStepId,
    actor: MaybeBuilder<AgentNode<TIn, TOut, THandle>>,
  ): LoopBuilder<TIn, TOut, THandle, TNewActStepId>;

  /**
   * Binds the read-only adversarial evaluation step executed after `.act()` passes `beforeStop`.
   *
   * Evaluates `(loopInput, actOutput, scopeReceipt)` and either accepts the output or injects feedback.
   *
   * @template TEvalIn  Evaluator agent input payload type.
   * @template TEvalOut Evaluator agent output payload type.
   * @template TReceipt Inspected scope receipt type.
   *
   * @param {string}                                                      stepId    - Evaluation step identifier.
   * @param {MaybeBuilder<AgentNode<TEvalIn, TEvalOut, THandle>>}         evaluator - Read-only evaluator agent.
   * @param {LoopEvaluateOptions<TIn, TOut, TEvalIn, TEvalOut, TReceipt>} options   - Input mapper, acceptance predicate, and feedback formatter.
   *
   * @returns {LoopBuilder<TIn, TOut, THandle, TActStepId>} New immutable loop builder.
   */
  evaluate<TEvalIn, TEvalOut, TReceipt = ExtractEvalScopeReceipt<TEvalIn>>(
    stepId: string,
    evaluator: MaybeBuilder<AgentNode<TEvalIn, TEvalOut, THandle>>,
    options: LoopEvaluateOptions<TIn, TOut, TEvalIn, TEvalOut, TReceipt>,
  ): LoopBuilder<TIn, TOut, THandle, TActStepId>;

  /**
   * Constrains and records the action step ID from which the loop projects its final accepted output.
   *
   * Throws immediately if `actStepId` does not match the configured `.act(stepId, ...)` identifier.
   *
   * @param {TActStepId} actStepId - Literal action step ID matching `.act(stepId, ...)`.
   *
   * @returns {LoopBuilder<TIn, TOut, THandle, TActStepId>} New immutable loop builder.
   */
  returnOutputFrom(actStepId: TActStepId): LoopBuilder<TIn, TOut, THandle, TActStepId>;

  /**
   * Clones the loop with `newPolicy` applied to the inner `.act()` actor while preserving `.onInterrupt()` handlers and `.evaluate()`'s policy.
   *
   * Throws if called before `.act(stepId, actor)` has been configured.
   *
   * @param {MaybeBuilder<PolicyNode<THandle>>} newPolicy - Replacement policy for the `.act()` actor.
   *
   * @returns {LoopBuilder<TIn, TOut, THandle, TActStepId>} Cloned immutable loop builder.
   */
  withPolicy(
    newPolicy: MaybeBuilder<PolicyNode<THandle>>,
  ): LoopBuilder<TIn, TOut, THandle, TActStepId>;

  /**
   * Clones the loop with additional tools mounted on the inner `.act()` actor and updates `roleKey` canonically.
   *
   * Throws if called before `.act(stepId, actor)` has been configured.
   *
   * @param {...ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>>>>} extraTools - Additional tools for the `.act()` actor.
   *
   * @returns {LoopBuilder<TIn, TOut, THandle, TActStepId>} Cloned immutable loop builder.
   */
  withTools(
    ...extraTools: ReadonlyArray<
      MaybeBuilder<ToolASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>>>
    >
  ): LoopBuilder<TIn, TOut, THandle, TActStepId>;
}
