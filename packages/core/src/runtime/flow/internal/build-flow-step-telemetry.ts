import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { ToolEffect } from '../../../ports/tool-effect.js';
import type { UniversalStepTelemetry } from '../../../ports/universal-step-telemetry.js';
import type { FlowExecutionContext } from '../flow-execution-context.js';
import {
  buildFlowStepExecutionContext,
  getFlowStepContinuationStack,
  getOrCreateFlowStepObservedEffects,
} from './build-flow-step-execution-context.js';

/**
 * Parameters passed to `buildFlowStepTelemetry`.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface BuildFlowStepTelemetryParams<TIn = unknown, THandle = unknown> {
  /** Active flow execution context. */
  readonly flowCtx: FlowExecutionContext<TIn, THandle>;

  /** Step execution identifier whose telemetry is being summarized. */
  readonly stepExecId: string;

  /** Fallback wall-clock step duration in milliseconds when no frame duration is present. */
  readonly fallbackDurationMs?: number;

  /** Optional abort metadata produced by an `AbortHookASTNode` execution. */
  readonly abortMeta?: Record<string, unknown>;
}

/**
 * Folds observed `ToolEffect[]` through `flow.telemetry` when configured (`SPEC.md` §3.9).
 *
 * Invokes the registered `TelemetryCollectorASTNode` executor in `flowCtx.registry.telemetryCollectors`
 * over `effectsOverride` (when building step-scoped `UniversalStepTelemetry.custom`) or
 * `flowCtx.observedRunEffects` (when building run-wide `FlowRunResult.customTelemetry`).
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>} flowCtx         - Active flow execution context.
 * @param {readonly ToolEffect[]}              [effectsOverride] - Optional step-scoped `ToolEffect[]` slice.
 *
 * @returns {Promise<Readonly<Record<string, unknown>> | undefined>} Folded telemetry record, or `undefined`.
 */
export async function foldFlowCustomTelemetry<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
  effectsOverride?: readonly ToolEffect[],
): Promise<Readonly<Record<string, unknown>> | undefined> {
  if (flowCtx.flow.telemetry === undefined) {
    return undefined;
  }
  const telNode = flowCtx.flow.telemetry;
  const telExec = flowCtx.registry.telemetryCollectors[telNode.type];
  if (telExec === undefined) {
    return undefined;
  }
  const { stepCtx } = buildFlowStepExecutionContext(
    flowCtx,
    flowCtx.activeReplacementExecutable,
    {
      stepExecId: flowCtx.activeStepExecId ?? flowCtx.runId,
      activePartitions: [],
      baseScopeCheckpoint: undefined,
      stepInterruptHandlers: [],
    },
  );
  const rawMetrics = await telExec(
    telNode as never,
    effectsOverride ?? flowCtx.observedRunEffects,
    stepCtx as StepExecutionContext<unknown>,
  );
  return Object.freeze(rawMetrics);
}

/**
 * Resolves the step-scoped `ToolEffect[]` slice for `stepExecId`, combining `stepObservedEffectsByStepExecId` with any frame-persisted `observedEffects`.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>}       flowCtx    - Active flow execution context.
 * @param {string}                                   stepExecId - Step execution identifier.
 * @param {readonly ContinuationFrame[] | undefined} frames     - Recorded continuation stack for the step.
 *
 * @returns {readonly ToolEffect[]} Step-scoped `ToolEffect[]` slice.
 */
function resolveFlowStepObservedEffects<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
  stepExecId: string,
  frames: readonly ContinuationFrame[] | undefined,
): readonly ToolEffect[] {
  const stepEffects = getOrCreateFlowStepObservedEffects(flowCtx, stepExecId);
  const loopFrame = frames?.find(
    (f: ContinuationFrame): f is LoopContinuationFrame => f.kind === 'loop-frame',
  );
  const agentFrame = frames?.find(
    (f: ContinuationFrame): f is AgentContinuationFrame => f.kind === 'agent-frame',
  );
  const frameEffects = loopFrame?.observedEffects ?? agentFrame?.observedEffects ?? [];
  for (const eff of frameEffects) {
    if (!stepEffects.includes(eff)) {
      stepEffects.push(eff);
    }
    if (!flowCtx.observedRunEffects.includes(eff)) {
      flowCtx.observedRunEffects.push(eff);
    }
  }
  return stepEffects;
}

/**
 * Extracts `turnsTaken`, `costUsd`, `durationMs`, and persisted `abortMeta` from a `ContinuationFrame[]` stack.
 *
 * Prioritizes cumulative `LoopContinuationFrame` counters over inner `AgentContinuationFrame` counters (`SPEC.md` §3.8).
 *
 * @param {readonly ContinuationFrame[] | undefined} frames             - Recorded continuation stack for the step.
 * @param {number}                                   [fallbackDurationMs=0] - Wall-clock fallback duration in milliseconds.
 *
 * @returns {{ readonly turnsTaken: number; readonly costUsd: number; readonly durationMs: number; readonly abortMeta: Record<string, unknown> | undefined }} Extracted telemetry counters.
 */
function extractContinuationFramesTelemetry(
  frames: readonly ContinuationFrame[] | undefined,
  fallbackDurationMs = 0,
): {
  readonly turnsTaken: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly abortMeta: Record<string, unknown> | undefined;
} {
  const loopFrame = frames?.find(
    (f: ContinuationFrame): f is LoopContinuationFrame => f.kind === 'loop-frame',
  );
  const agentFrame = frames?.find(
    (f: ContinuationFrame): f is AgentContinuationFrame => f.kind === 'agent-frame',
  );
  const turnsTaken = loopFrame?.turnsTaken ?? agentFrame?.turnsTaken ?? 0;
  const costUsd = loopFrame?.costUsd ?? agentFrame?.costUsd ?? 0;
  const frameDurationMs = loopFrame?.elapsedDurationMs ?? agentFrame?.elapsedDurationMs;
  const durationMs =
    frameDurationMs !== undefined && frameDurationMs > 0 ? frameDurationMs : fallbackDurationMs;
  const abortMetaJson =
    agentFrame?.pauseState.kind === 'interrupt-flush'
      ? agentFrame.pauseState.abortMetaJson
      : undefined;
  const abortMeta =
    abortMetaJson !== undefined
      ? (JSON.parse(abortMetaJson) as Record<string, unknown>)
      : undefined;
  return { turnsTaken, costUsd, durationMs, abortMeta };
}

/**
 * Builds a canonical `UniversalStepTelemetry` object for `params.stepExecId` (`SPEC.md` §2.7, §3.8 & §3.9).
 *
 * Combines real `ContinuationFrame` counters (`turnsTaken`, `costUsd`, `durationMs`), step-scoped `custom`
 * telemetry from `foldFlowCustomTelemetry(flowCtx, stepEffects) ?? {}`, and optional `abortMeta`.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {BuildFlowStepTelemetryParams<TIn, THandle>} params - Flow context, step execution ID, duration fallback, and abort metadata.
 *
 * @returns {Promise<UniversalStepTelemetry>} Frozen canonical `UniversalStepTelemetry` object.
 */
export async function buildFlowStepTelemetry<TIn = unknown, THandle = unknown>(
  params: BuildFlowStepTelemetryParams<TIn, THandle>,
): Promise<UniversalStepTelemetry> {
  const { flowCtx, stepExecId, fallbackDurationMs = 0, abortMeta } = params;
  const frames = getFlowStepContinuationStack(flowCtx, stepExecId);
  const extracted = extractContinuationFramesTelemetry(frames, fallbackDurationMs);
  const stepEffects = resolveFlowStepObservedEffects(flowCtx, stepExecId, frames);
  const custom = (await foldFlowCustomTelemetry(flowCtx, stepEffects)) ?? Object.freeze({});
  const resolvedAbortMeta = abortMeta ?? extracted.abortMeta;
  return Object.freeze<UniversalStepTelemetry>({
    turnsTaken: extracted.turnsTaken,
    costUsd: extracted.costUsd,
    durationMs: extracted.durationMs,
    custom,
    abortMeta: resolvedAbortMeta,
  });
}
