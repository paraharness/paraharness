import type { z } from 'zod';
import type {
  BaseIsolationScopeASTNode,
  BaseTrackerASTNode,
} from '../ast/base/index.js';

/**
 * Extracts the runtime scope handle type `THandle` from an `IsolationScopeASTNode`.
 *
 * Evaluates to `unknown` when `TScope` does not extend `BaseIsolationScopeASTNode`.
 *
 * @template TScope Isolation scope AST node type.
 */
export type ExtractScopeHandle<TScope> = TScope extends BaseIsolationScopeASTNode<
  string,
  infer THandle,
  Record<string, unknown>,
  Record<string, unknown>
>
  ? THandle
  : unknown;

/**
 * Extracts the inspected scope receipt type `TReceipt` from an `IsolationScopeASTNode`.
 *
 * Evaluates to `unknown` when `TScope` does not declare a `receiptSchema` property.
 *
 * @template TScope Isolation scope AST node type.
 */
export type ExtractScopeReceipt<TScope> = TScope extends {
  readonly receiptSchema: z.ZodType<infer TReceipt, z.ZodTypeDef, unknown>;
}
  ? TReceipt
  : unknown;

/**
 * Extracts the custom telemetry metrics type `TMetrics` from a `TelemetryCollectorASTNode`.
 *
 * Evaluates to `Record<string, unknown>` when `TCollector` does not declare a `schema` property.
 *
 * @template TCollector Telemetry collector AST node type.
 */
export type ExtractTelemetryMetrics<TCollector> = TCollector extends {
  readonly schema: z.ZodType<infer TMetrics extends Record<string, unknown>, z.ZodTypeDef, unknown>;
}
  ? TMetrics
  : Record<string, unknown>;

/**
 * Extracts the validated input payload type `TIn` from a `StepASTNode`.
 *
 * Evaluates to `unknown` when `TStep` does not declare an `inputSchema` property.
 *
 * @template TStep Step AST node type.
 */
export type ExtractStepInput<TStep> = TStep extends {
  readonly inputSchema: z.ZodType<infer TIn, z.ZodTypeDef, unknown>;
}
  ? TIn
  : unknown;

/**
 * Extracts the validated output payload type `TOut` from a `StepASTNode`.
 *
 * Evaluates to `unknown` when `TStep` does not declare an `outputSchema` property.
 *
 * @template TStep Step AST node type.
 */
export type ExtractStepOutput<TStep> = TStep extends {
  readonly outputSchema: z.ZodType<infer TOut, z.ZodTypeDef, unknown>;
}
  ? TOut
  : unknown;

/**
 * Extracts the validated abort metadata type `TAbortMeta` from an `AbortHookASTNode`.
 *
 * Evaluates to `Record<string, unknown>` when `THook` does not declare a `metaSchema` property.
 *
 * @template THook Abort hook AST node type.
 */
export type ExtractAbortMeta<THook> = THook extends {
  readonly metaSchema: z.ZodType<
    infer TAbortMeta extends Record<string, unknown>,
    z.ZodTypeDef,
    unknown
  >;
}
  ? TAbortMeta
  : Record<string, unknown>;

/**
 * Extracts the external issue payload type `TExternal` from a `TrackerASTNode`.
 *
 * Evaluates to `unknown` when `TAdapter` does not extend `BaseTrackerASTNode`.
 *
 * @template TAdapter Tracker AST node type.
 */
export type ExtractTrackerExternal<TAdapter> = TAdapter extends BaseTrackerASTNode<
  string,
  infer TExternal,
  string
>
  ? TExternal
  : unknown;

/**
 * Extracts the external state string type `TExternalState` from a `TrackerASTNode`.
 *
 * Evaluates to `string` when `TAdapter` does not extend `BaseTrackerASTNode`.
 *
 * @template TAdapter Tracker AST node type.
 */
export type ExtractTrackerState<TAdapter> = TAdapter extends BaseTrackerASTNode<
  string,
  unknown,
  infer TExternalState
>
  ? TExternalState
  : string;

/**
 * Extracts the `scopeReceipt` property type from an evaluator agent's input payload type when present.
 *
 * Evaluates to `unknown` when `TEvalIn` does not declare a `scopeReceipt` field.
 *
 * @template TEvalIn Evaluator agent input payload type.
 */
export type ExtractEvalScopeReceipt<TEvalIn> = TEvalIn extends {
  readonly scopeReceipt: infer TReceipt;
}
  ? TReceipt
  : unknown;

/**
 * Extracts the candidate union element type from an arbiter agent's `SpeculationInputSchema` input type.
 *
 * Evaluates to `unknown` when `TArbiterIn` does not declare a `candidates` array property.
 *
 * @template TArbiterIn Arbiter agent input type.
 */
export type ExtractSpeculationCandidate<TArbiterIn> = TArbiterIn extends {
  readonly candidates: ReadonlyArray<infer TCandidate>;
}
  ? TCandidate
  : unknown;
