import type { z } from 'zod';

/**
 * Domain-agnostic base AST node contract for custom telemetry collectors (`TelemetryCollectorASTNode`).
 *
 * Aggregates `ToolEffect` records observed during a step or loop execution into strongly typed
 * custom telemetry metrics (`UniversalStepTelemetry.custom`).
 *
 * @template TType    String-literal discriminant of the telemetry collector node.
 * @template TMetrics Validated custom metrics record shape.
 */
export interface BaseTelemetryCollectorASTNode<
  TType extends string = string,
  TMetrics extends Record<string, unknown> = Record<string, unknown>,
> {
  /** Unique string-literal discriminant of the telemetry collector node. */
  readonly type: TType;
  /** Logical identifier of the telemetry collector. */
  readonly id: string;
  /** Zod schema validating the aggregated custom metrics object. */
  readonly schema: z.ZodType<TMetrics, z.ZodTypeDef, unknown>;
}
