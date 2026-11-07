import type { AgentNode } from '../../../ast/agent-node.js';
import type { RunnerPoolASTNode, StepASTNode } from '../../../ast/domain-ast.types.js';
import type { InterruptHandlerNode } from '../../../ast/interrupt-handler-node.types.js';
import type { LoopNode } from '../../../ast/loop-node.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { ToolEffect } from '../../../ports/tool-effect.js';
import type { FlowExecutionContext } from '../flow-execution-context.js';

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
 * Avoids unsound type casts while attaching `_runtime` stores and step-level interrupt edges.
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
  const execType = (executable as { readonly type?: string } | undefined)?.type;
  let mergedExec = executable;
  if (
    executable !== undefined &&
    stepParams.stepInterruptHandlers.length > 0 &&
    execType === 'harness:agent'
  ) {
    const ag = executable as AgentNode<unknown, unknown, THandle>;
    mergedExec = Object.freeze({
      ...ag,
      onInterruptHandlers: Object.freeze([
        ...ag.onInterruptHandlers,
        ...stepParams.stepInterruptHandlers,
      ]),
    });
  } else if (
    executable !== undefined &&
    stepParams.stepInterruptHandlers.length > 0 &&
    execType === 'harness:loop'
  ) {
    const lp = executable as LoopNode<unknown, unknown, THandle>;
    mergedExec = Object.freeze({
      ...lp,
      actStep: Object.freeze({
        ...lp.actStep,
        actor: Object.freeze({
          ...lp.actStep.actor,
          onInterruptHandlers: Object.freeze([
            ...lp.actStep.actor.onInterruptHandlers,
            ...stepParams.stepInterruptHandlers,
          ]),
        }),
      }),
    });
  }
  const baseCtx: StepExecutionContext<THandle> = {
    runId: flowCtx.runId,
    stepExecId: stepParams.stepExecId,
    scopeHandle: flowCtx.scopeHandle,
    scopeNode: flowCtx.flow.scope,
    scope: flowCtx.scopeDriver,
    activePartitions: stepParams.activePartitions,
    activeLeases: Object.freeze([]),
    observedEffects: flowCtx.observedRunEffects,
    signal: flowCtx.activeStepAbortController.signal,
    registry: flowCtx.registry,
    resolveEnv: (v) => (typeof v === 'string' ? v : flowCtx.env[v.key]),
    getRunner: (rNode: RunnerPoolASTNode) => {
      const factory = flowCtx.registry.runners[rNode.type];
      if (factory === undefined) {
        throw new Error(
          `No RunnerDriver registered for '${rNode.type}' (runner id '${rNode.id}', lane '${flowCtx.laneId}').`,
        );
      }
      return factory(rNode as never);
    },
    recordEffects: (effs: readonly ToolEffect[]) => {
      flowCtx.observedRunEffects.push(...effs);
    },
  };
  const stepCtx = Object.assign({}, baseCtx, {
    _runtime: {
      ledgerStore: flowCtx.ledgerStore,
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
    },
  });
  return { executable: mergedExec, stepCtx: Object.freeze(stepCtx) };
}
