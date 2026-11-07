import type { z } from 'zod';

/**
 * Domain-agnostic base AST node contract for step abort hooks (`AbortHookASTNode`).
 *
 * Executed during `.replaceWith()` step promotion or `.onLimitExceeded()` cleanup to snapshot
 * and reset dirty scope state before starting the replacement executable.
 *
 * @template TType      String-literal discriminant of the abort hook node.
 * @template THandle    Isolation scope handle type operated on by the hook.
 * @template TAbortMeta Validated abort metadata shape attached to `UniversalStepTelemetry.abortMeta`.
 */
export interface BaseAbortHookASTNode<
  TType extends string = string,
  THandle = unknown,
  TAbortMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Unique string-literal discriminant of the abort hook node. */
  readonly type: TType;
  /** Logical identifier of the abort hook. */
  readonly id: string;
  /** Zod schema validating metadata returned by the abort hook executor. */
  readonly metaSchema: z.ZodType<TAbortMeta>;
  /** Phantom type brand binding the hook to its compatible scope handle type. */
  readonly __handleBrand?: THandle;
}
