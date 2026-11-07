import type { FlowStepNode } from '../../../ast/flow-step-node.js';
import type { InterruptEdgeResolution } from '../../agent/interrupt-edge-resolution.js';
import { executeStepNode } from '../../step/execute-step-node.js';
import type { FlowExecutionContext } from '../flow-execution-context.js';
import { buildFlowStepExecutionContext } from './collect-flow-actors.js';
import {
  executeReplaceWithPromotion,
  foldFlowCustomTelemetry,
} from './flow-replace-and-rewind.js';

/**
 * Executes a step-level `.replaceWith()` promotion when a step raises an interrupt matching a `'replace'` handler (`SPEC.md` §3.6 & §3.9).
 *
 * Runs any configured `abortHook`, computes `replacementInput`, and calls `executeReplaceWithPromotion`.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>}      flowCtx   - Active flow execution context.
 * @param {FlowStepNode<unknown, unknown, THandle>} stepNode  - Passive `FlowStepNode` being replaced.
 * @param {object}                                  replaceCtx - Caught error, step execution ID, base checkpoint, scope receipt, and step context.
 *
 * @returns {Promise<boolean>} True if a `'replace'` handler matched and promoted the replacement executable.
 */
async function tryPromoteStepReplacement<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
  stepNode: FlowStepNode<unknown, unknown, THandle>,
  replaceCtx: {
    readonly typedErr: Error & {
      readonly code?: string;
      readonly interruptResolution?: InterruptEdgeResolution<THandle>;
    };
    readonly stepExecId: string;
    readonly baseCkpt: string | undefined;
    readonly scopeReceipt: Record<string, unknown>;
    readonly stepCtx: unknown;
  },
): Promise<boolean> {
  const { typedErr, stepExecId, baseCkpt, scopeReceipt, stepCtx } = replaceCtx;
  const effHandler =
    typedErr.interruptResolution?.replaceHandler ??
    (typedErr.interruptResolution !== undefined
      ? stepNode.onInterruptHandlers.find(
          (h) => h.interrupt.id === typedErr.interruptResolution?.interruptId,
        )
      : undefined);
  if (effHandler?.mode !== 'replace') {
    return false;
  }
  const abortExec =
    effHandler.abortHook !== undefined
      ? flowCtx.registry.abortHooks[
          effHandler.abortHook.type as keyof typeof flowCtx.registry.abortHooks
        ]
      : undefined;
  const abortMeta = (
    abortExec !== undefined && effHandler.abortHook !== undefined
      ? await abortExec(
          effHandler.abortHook as never,
          { handle: flowCtx.scopeHandle, runId: flowCtx.runId, stepExecId } as never,
          stepCtx as never,
        )
      : {}
  ) as Record<string, unknown>;
  const replacementInput = effHandler.mapReplacementInput(
    flowCtx.currentInput,
    typedErr.interruptResolution?.payload,
    {
      costUsd: 0,
      turnsTaken: 0,
      durationMs: 0,
      custom: (await foldFlowCustomTelemetry(flowCtx)) ?? scopeReceipt,
      abortMeta,
    },
  ) as TIn;
  await executeReplaceWithPromotion({
    flowCtx,
    stepExecId,
    stepId: stepNode.id,
    baseScopeCheckpoint: effHandler.abortHook !== undefined ? undefined : baseCkpt,
    replacementExecutable: effHandler.replacementExecutable,
    replacementInput,
    abortHook: undefined,
  });
  return true;
}

/**
 * Executes a single `FlowStepNode`, handling `.inputFrom()` projection, step-level `.replaceWith()` promotion, and `.retry()` backoff (`SPEC.md` §3.9).
 *
 * Persists `completedStepOutputs` and `recordStepTransition` in `LedgerStore` when the step completes,
 * and quiesces `'scope'`-scoped services and restores `baseScopeCheckpoint` if the step faults or aborts.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>}      flowCtx         - Active flow execution context.
 * @param {FlowStepNode<unknown, unknown, THandle>} stepNode        - Passive `FlowStepNode` to execute.
 * @param {string}                                  [outerBranchId] - Optional enclosing `FlowBranchNode.id` for output attribution.
 *
 * @returns {Promise<{ readonly status: 'completed' | 'suspended' | 'rewound'; readonly output?: unknown }>} Step execution outcome.
 */
export async function executeFlowStep<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
  stepNode: FlowStepNode<unknown, unknown, THandle>,
  outerBranchId?: string,
): Promise<{
  readonly status: 'completed' | 'suspended' | 'rewound';
  readonly output?: unknown;
}> {
  const maxTries = flowCtx.retryConfig?.tries ?? 1;
  for (let attempt = 1; attempt <= maxTries; attempt += 1) {
    const scopeReceipt = await flowCtx.lockManager.withReadLock(flowCtx.scopeHandle, () =>
      flowCtx.scopeDriver.inspect(flowCtx.scopeHandle),
    );
    const isReplaced = flowCtx.activeReplacementExecutable !== undefined;
    const targetExecutable = flowCtx.activeReplacementExecutable ?? stepNode.step;
    const stepInput =
      !isReplaced && stepNode.inputFrom !== undefined
        ? stepNode.inputFrom(
            flowCtx.currentInput,
            Object.fromEntries(flowCtx.completedStepOutputs.entries()),
            scopeReceipt,
          )
        : flowCtx.currentInput;
    const extractPartsFn = (
      targetExecutable as { readonly extractPartitions?: (i: unknown) => readonly string[] }
    ).extractPartitions;
    const stepExecId =
      flowCtx.activeStepExecId ?? `${flowCtx.runId}:${stepNode.id}:${String(attempt)}`;
    const baseCkpt =
      flowCtx.scopeDriver.serializeCheckpoint !== undefined
        ? await flowCtx.scopeDriver.serializeCheckpoint(flowCtx.scopeHandle)
        : undefined;
    if (
      baseCkpt !== undefined &&
      flowCtx.stepBaseCheckpointsByStepId !== undefined &&
      !flowCtx.stepBaseCheckpointsByStepId.has(stepNode.id)
    ) {
      flowCtx.stepBaseCheckpointsByStepId.set(stepNode.id, baseCkpt);
    }
    if (flowCtx.activeStepExecId === null) {
      await flowCtx.ledgerStore.recordStepStart({
        runId: flowCtx.runId,
        stepExecId,
        stepId: stepNode.id,
        executableId: targetExecutable.id,
        inputMsgId: null,
        baseScopeCheckpoint: baseCkpt,
        continuationStack: Object.freeze([]),
      });
    }
    Object.assign(flowCtx, { activeStepId: stepNode.id, activeStepExecId: stepExecId });
    const built = buildFlowStepExecutionContext(flowCtx, targetExecutable, {
      stepExecId,
      activePartitions: extractPartsFn !== undefined ? extractPartsFn(stepInput) : [],
      baseScopeCheckpoint: baseCkpt,
      stepInterruptHandlers: isReplaced ? [] : stepNode.onInterruptHandlers,
    });
    const resumeHolder = flowCtx as FlowExecutionContext<TIn, THandle> & {
      resumeContinuationStack?: typeof built.stepCtx.resumeContinuationStack;
    };
    const stepCtx =
      resumeHolder.resumeContinuationStack !== undefined
        ? Object.freeze({
            ...built.stepCtx,
            resumeContinuationStack: resumeHolder.resumeContinuationStack,
          })
        : built.stepCtx;
    resumeHolder.resumeContinuationStack = undefined;
    try {
      const output = await executeStepNode(built.executable, stepInput, stepCtx);
      Object.assign(flowCtx, { activeReplacementExecutable: undefined, activeStepExecId: null });
      flowCtx.completedStepOutputs.set(stepNode.id, output);
      if (outerBranchId !== undefined) {
        flowCtx.completedStepOutputs.set(outerBranchId, output);
      }
      await flowCtx.ledgerStore.recordStepTransition({
        stepExecId,
        status: 'COMPLETED',
        outputJson: JSON.stringify(output),
        telemetryJson: JSON.stringify({ costUsd: 0, turnsTaken: 1, elapsedDurationMs: 0 }),
      });
      return Object.freeze({ status: 'completed', output });
    } catch (err) {
      const typedErr = err as Error & {
        readonly code?: string;
        readonly interruptResolution?: InterruptEdgeResolution<THandle>;
      };
      if (
        typedErr.code === 'HARNESS_STEP_SUSPENDED' ||
        flowCtx.pendingRewindToStepId !== undefined
      ) {
        return Object.freeze({
          status: typedErr.code === 'HARNESS_STEP_SUSPENDED' ? 'suspended' : 'rewound',
        });
      }
      const promoted = await tryPromoteStepReplacement(flowCtx, stepNode, {
        typedErr,
        stepExecId,
        baseCkpt,
        scopeReceipt,
        stepCtx,
      });
      if (promoted) {
        attempt -= 1;
        continue;
      }
      flowCtx.activeStepExecId = null;
      await flowCtx.serviceRegistry.quiesceScopeServices(stepExecId);
      if (flowCtx.topologyStore !== undefined) {
        await flowCtx.topologyStore.resetRunOverlay(flowCtx.runId, {
          scope: 'step',
          stepExecId,
        });
      }
      if (baseCkpt !== undefined && flowCtx.scopeDriver.restoreCheckpoint !== undefined) {
        await flowCtx.scopeDriver.restoreCheckpoint(flowCtx.scopeHandle, baseCkpt);
      }
      await flowCtx.ledgerStore.recordStepTransition({
        stepExecId,
        status: 'FAILED',
        telemetryJson: JSON.stringify({ costUsd: 0, turnsTaken: 0, elapsedDurationMs: 0 }),
      });
      if (attempt >= maxTries) {
        throw err;
      }
    }
  }
  throw new Error(`Exhausted retries for step '${stepNode.id}' in run '${flowCtx.runId}'.`);
}
