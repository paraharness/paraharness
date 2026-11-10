import type { AgentNode } from '../../../ast/agent-node.js';
import type { StepASTNode } from '../../../ast/domain-ast.types.js';
import type { InterruptHandlerNode } from '../../../ast/interrupt-handler-node.types.js';
import type { LoopNode } from '../../../ast/loop-node.js';
import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { LedgerStore } from '../../../ports/ledger-store.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { ToolEffect } from '../../../ports/tool-effect.js';
import type { StepRuntimeChildOutcomeSink } from '../../agent/step-runtime-internals.js';
import { createMemoizedRunnerResolver } from '../../pools/internal/create-memoized-runner-resolver.js';
import type { FlowExecutionContext } from '../flow-execution-context.js';

/**
 * Records the latest `ContinuationFrame[]` stack for `stepExecId` on `flowCtx.stepContinuationStacks`.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>} flowCtx    - Active flow execution context.
 * @param {string}                             stepExecId - Step execution identifier.
 * @param {readonly ContinuationFrame[]}       stack      - Latest continuation frame stack.
 */
export function recordFlowStepContinuationStack<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
  stepExecId: string,
  stack: readonly ContinuationFrame[],
): void {
  const mutableCtx = flowCtx as {
    stepContinuationStacks?: Map<string, readonly ContinuationFrame[]>;
  };
  mutableCtx.stepContinuationStacks ??= new Map<string, readonly ContinuationFrame[]>();
  mutableCtx.stepContinuationStacks.set(stepExecId, stack);
}

/**
 * Retrieves the latest `ContinuationFrame[]` stack recorded for `stepExecId` on `flowCtx`.
 *
 * Falls back to inspecting in-memory ledger step entries when `flowCtx.stepContinuationStacks` has no record.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>} flowCtx    - Active flow execution context.
 * @param {string}                             stepExecId - Step execution identifier.
 *
 * @returns {readonly ContinuationFrame[] | undefined} Latest continuation stack for `stepExecId`, if any.
 */
export function getFlowStepContinuationStack<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
  stepExecId: string,
): readonly ContinuationFrame[] | undefined {
  const fromCtx = flowCtx.stepContinuationStacks?.get(stepExecId);
  if (fromCtx !== undefined && fromCtx.length > 0) {
    return fromCtx;
  }
  const ledgerWithSteps = flowCtx.ledgerStore as {
    readonly steps?: ReadonlyMap<
      string,
      { readonly continuationStack?: readonly ContinuationFrame[] }
    >;
  };
  return ledgerWithSteps.steps?.get(stepExecId)?.continuationStack;
}

/**
 * Returns or initializes the step-scoped `ToolEffect[]` accumulator for `stepExecId` on `flowCtx`.
 *
 * Seeds the step accumulator from any resumed `LoopContinuationFrame.observedEffects` or
 * `AgentContinuationFrame.observedEffects` and mirrors seeded effects into `flowCtx.observedRunEffects`.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>} flowCtx    - Active flow execution context.
 * @param {string}                             stepExecId - Step execution identifier.
 *
 * @returns {ToolEffect[]} Mutable step-scoped `ToolEffect[]` array for `stepExecId`.
 */
export function getOrCreateFlowStepObservedEffects<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
  stepExecId: string,
): ToolEffect[] {
  const mutableCtx = flowCtx as {
    stepObservedEffectsByStepExecId?: Map<string, ToolEffect[]>;
  };
  mutableCtx.stepObservedEffectsByStepExecId ??= new Map<string, ToolEffect[]>();
  const existing = mutableCtx.stepObservedEffectsByStepExecId.get(stepExecId);
  if (existing !== undefined) {
    return existing;
  }
  const stack =
    getFlowStepContinuationStack(flowCtx, stepExecId) ?? flowCtx.resumeContinuationStack;
  const loopFrame = stack?.find(
    (f: ContinuationFrame): f is LoopContinuationFrame => f.kind === 'loop-frame',
  );
  const agentFrame = stack?.find(
    (f: ContinuationFrame): f is AgentContinuationFrame => f.kind === 'agent-frame',
  );
  const frameEffects = loopFrame?.observedEffects ?? agentFrame?.observedEffects ?? [];
  const seeded: ToolEffect[] = [...frameEffects];
  for (const eff of seeded) {
    if (!flowCtx.observedRunEffects.includes(eff)) {
      flowCtx.observedRunEffects.push(eff);
    }
  }
  mutableCtx.stepObservedEffectsByStepExecId.set(stepExecId, seeded);
  return seeded;
}

/**
 * Wraps `flowCtx.ledgerStore` so `updateContinuationStack` automatically updates `flowCtx.stepContinuationStacks`.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>} flowCtx - Active flow execution context.
 *
 * @returns {LedgerStore} Proxied ledger store tracking continuation stacks per `stepExecId`.
 */
function createTrackingStepLedgerStore<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
): LedgerStore {
  return new Proxy(flowCtx.ledgerStore, {
    get(target: LedgerStore, prop: string | symbol, receiver: unknown): unknown {
      if (prop === 'updateContinuationStack') {
        return (
          runId: string,
          stepExecId: string,
          continuationStack: readonly ContinuationFrame[],
          opts?: { readonly baseScopeCheckpoint?: string },
        ): Promise<void> => {
          recordFlowStepContinuationStack(flowCtx, stepExecId, continuationStack);
          return target.updateContinuationStack(runId, stepExecId, continuationStack, opts);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * Merges step-level `.onInterrupt()` handlers onto an `AgentNode` or `LoopNode` executable.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {StepASTNode<unknown, unknown, THandle> | undefined}       executable            - Target step executable.
 * @param {readonly InterruptHandlerNode<unknown, unknown, THandle>[]} stepInterruptHandlers - Step-level interrupt handlers.
 *
 * @returns {StepASTNode<unknown, unknown, THandle> | undefined} Executable with merged interrupt handlers.
 */
function mergeStepExecutableInterruptHandlers<THandle = unknown>(
  executable: StepASTNode<unknown, unknown, THandle> | undefined,
  stepInterruptHandlers: readonly InterruptHandlerNode<unknown, unknown, THandle>[],
): StepASTNode<unknown, unknown, THandle> | undefined {
  if (executable === undefined || stepInterruptHandlers.length === 0) {
    return executable;
  }
  const execType = (executable as { readonly type?: string }).type;
  if (execType === 'harness:agent') {
    const ag = executable as AgentNode<unknown, unknown, THandle>;
    return Object.freeze({
      ...ag,
      onInterruptHandlers: Object.freeze([...ag.onInterruptHandlers, ...stepInterruptHandlers]),
    });
  }
  if (execType === 'harness:loop') {
    const lp = executable as LoopNode<unknown, unknown, THandle>;
    return Object.freeze({
      ...lp,
      actStep: Object.freeze({
        ...lp.actStep,
        actor: Object.freeze({
          ...lp.actStep.actor,
          onInterruptHandlers: Object.freeze([
            ...lp.actStep.actor.onInterruptHandlers,
            ...stepInterruptHandlers,
          ]),
        }),
      }),
    });
  }
  return executable;
}

/**
 * Step-specific execution parameters passed to `buildFlowStepExecutionContext`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface BuildFlowStepExecutionContextStepParams<THandle = unknown> {
  /** Unique step execution identifier (`"${runId}:${stepId}:${attempt}"`). */
  readonly stepExecId: string;

  /** Active partition IDs extracted for the step execution. */
  readonly activePartitions: readonly string[];

  /** Serialized base scope checkpoint captured before the step attempt. */
  readonly baseScopeCheckpoint: string | undefined;

  /** Step-level `.onInterrupt()` handlers to merge onto the executable. */
  readonly stepInterruptHandlers: readonly InterruptHandlerNode<unknown, unknown, THandle>[];
}

/**
 * Constructs a strongly-typed `StepExecutionContext` for a flow step and merges any step-level `.onInterrupt()` handlers onto the target executable (`SPEC.md` §3.9).
 *
 * Scopes `StepExecutionContext.observedEffects` and `_runtime.collectCustomTelemetry` to `stepParams.stepExecId`
 * while mirroring `recordEffects` into both the step accumulator and `flowCtx.observedRunEffects`.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>}                    flowCtx      - Active flow execution context.
 * @param {StepASTNode<unknown, unknown, THandle> | undefined}    executable   - Optional target step executable.
 * @param {BuildFlowStepExecutionContextStepParams<THandle>}      stepParams   - Step execution ID, active partitions, base checkpoint, and step handlers.
 *
 * @returns {{ readonly executable: StepASTNode<unknown, unknown, THandle> | undefined; readonly stepCtx: StepExecutionContext<THandle> }} Prepared executable and step context.
 */
export function buildFlowStepExecutionContext<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
  executable: StepASTNode<unknown, unknown, THandle> | undefined,
  stepParams: BuildFlowStepExecutionContextStepParams<THandle>,
): {
  readonly executable: StepASTNode<unknown, unknown, THandle> | undefined;
  readonly stepCtx: StepExecutionContext<THandle>;
} {
  const mergedExec = mergeStepExecutableInterruptHandlers(
    executable,
    stepParams.stepInterruptHandlers,
  );
  const stepObservedEffects = getOrCreateFlowStepObservedEffects(flowCtx, stepParams.stepExecId);
  const baseCtx: StepExecutionContext<THandle> = {
    runId: flowCtx.runId,
    stepExecId: stepParams.stepExecId,
    scopeHandle: flowCtx.scopeHandle,
    scopeNode: flowCtx.flow.scope,
    scope: flowCtx.scopeDriver,
    activePartitions: stepParams.activePartitions,
    activeLeases: Object.freeze([]),
    observedEffects: stepObservedEffects,
    signal: flowCtx.activeStepAbortController.signal,
    registry: flowCtx.registry,
    resolveEnv: (v) => (typeof v === 'string' ? v : flowCtx.env[v.key]),
    getRunner: createMemoizedRunnerResolver(flowCtx.registry, `lane '${flowCtx.laneId}'`),
    recordEffects: (effs: readonly ToolEffect[]) => {
      stepObservedEffects.push(...effs);
      flowCtx.observedRunEffects.push(...effs);
    },
  };
  const childOutcomeSink: StepRuntimeChildOutcomeSink = {
    get continuationStack(): readonly ContinuationFrame[] | undefined {
      return getFlowStepContinuationStack(flowCtx, stepParams.stepExecId);
    },
    set continuationStack(stack: readonly ContinuationFrame[] | undefined) {
      if (stack !== undefined) {
        recordFlowStepContinuationStack(flowCtx, stepParams.stepExecId, stack);
      }
    },
  };
  const trackingLedgerStore = createTrackingStepLedgerStore(flowCtx);
  const stepCtx: StepExecutionContext<THandle> = Object.assign({}, baseCtx, {
    _runtime: {
      ledgerStore: trackingLedgerStore,
      topologyStore: flowCtx.topologyStore,
      lessonStore: flowCtx.lessonStore,
      lockManager: flowCtx.lockManager,
      continuationQueue: flowCtx.continuationQueue,
      poolManager: flowCtx.poolManager,
      serviceRegistry: flowCtx.serviceRegistry,
      humanAdaptersById: flowCtx.humanAdaptersById,
      wirePrefixesByGroupId: flowCtx.wirePrefixesByGroupId,
      laneId: flowCtx.laneId,
      itemKey: flowCtx.itemKey,
      baseScopeCheckpoint: stepParams.baseScopeCheckpoint,
      childOutcomeSink,
      collectCustomTelemetry: async (): Promise<Readonly<Record<string, unknown>>> => {
        if (flowCtx.flow.telemetry === undefined) {
          return Object.freeze({});
        }
        const telNode = flowCtx.flow.telemetry;
        const telExec = flowCtx.registry.telemetryCollectors[telNode.type];
        if (telExec === undefined) {
          return Object.freeze({});
        }
        const rawMetrics = await telExec(
          telNode as never,
          stepObservedEffects,
          stepCtx as StepExecutionContext<unknown>,
        );
        return Object.freeze(rawMetrics);
      },
    },
  });
  return { executable: mergedExec, stepCtx: Object.freeze(stepCtx) };
}
