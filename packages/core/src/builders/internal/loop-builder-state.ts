import type { z } from 'zod';
import type { LessonsNode } from '../../ast/lessons-node.js';
import type { LoopActStepConfig, LoopEvaluateStepConfig } from '../../ast/loop-node.js';

/**
 * Immutable copy-on-write state snapshot backing `LoopBuilder`.
 *
 * Tracks the loop's input/output schemas, iteration limits, session preservation policy,
 * contrastive lesson sink, `.act()` step, `.evaluate()` step, and output projection target.
 *
 * @template TIn        Validated loop input payload type.
 * @template TOut       Validated loop output payload type.
 * @template THandle    Runtime handle type of the active isolation scope.
 * @template TActStepId Literal string identifier of the `.act()` step.
 */
export interface LoopBuilderState<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
  TActStepId extends string = string,
> {
  /** Unique loop identifier passed to `H.loop(id)`. */
  readonly id: string;
  /** Canonical role key inherited from the inner `.act()` actor. */
  readonly roleKey: string;
  /** Zod schema validating loop input payloads. */
  readonly inputSchema?: z.ZodType<TIn, z.ZodTypeDef, unknown>;
  /** Zod schema validating loop output payloads. */
  readonly outputSchema?: z.ZodType<TOut, z.ZodTypeDef, unknown>;
  /** Optional synchronous partition extractor mapping `TIn` to active partition IDs. */
  readonly extractPartitions?: (input: TIn) => readonly string[];
  /** Maximum number of `.act() -> .evaluate()` iterations before failing the loop. */
  readonly maxIterations: number;
  /** Whether rejected iterations resume the `.act()` actor's existing conversation transcript. */
  readonly preserveActorSession: boolean;
  /** Optional lessons node receiving contrastive failure-to-pass trajectory pairs. */
  readonly distillLessons?: LessonsNode<unknown>;
  /** Configured write-capable action step. */
  readonly actStep?: LoopActStepConfig<TIn, TOut, THandle, TActStepId>;
  /** Configured read-only evaluation step. */
  readonly evaluateStep?: LoopEvaluateStepConfig<TIn, TOut, THandle>;
  /** Action step identifier from which the loop projects its final accepted output. */
  readonly returnOutputFromStepId?: TActStepId;
}
