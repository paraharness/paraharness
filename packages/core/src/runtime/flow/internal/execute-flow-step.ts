import type { StepASTNode } from '../../../ast/domain-ast.types.js';
import type { FlowStepNode } from '../../../ast/flow-step-node.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { InterruptEdgeResolution } from '../../agent/interrupt-edge-resolution.js';
import { executeStepNode } from '../../step/execute-step-node.js';
import type { FlowExecutionContext } from '../flow-execution-context.js';
import { buildFlowStepExecutionContext } from './build-flow-step-execution-context.js';
import {
  executeReplaceWithPromotion,
  foldFlowCustomTelemetry,
} from './flow-replace-and-rewind.js';

/**
 * Parameters passed to `tryPromoteStepReplacement`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
interface TryPromoteStepReplacementParams<THandle = unknown> {
  /** Caught step execution error with optional interrupt resolution metadata. */
  readonly typedErr: Error & {
    readonly code?: string;
    readonly interruptResolution?: InterruptEdgeResolution<THandle>;
  };

  /** Active step execution identifier. */
  readonly stepExecId: string;

  /** Base scope checkpoint serialized before the step attempt. */
  readonly baseCkpt: string | undefined;

  /** Isolation scope inspection receipt captured before the step attempt. */
  readonly scopeReceipt: Record<string, unknown>;

  /** Active step execution context. */
  readonly stepCtx: StepExecutionContext<THandle>;
}

/**
 * Prepared step attempt state returned by `prepareFlowStepAttempt`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
interface PreparedFlowStepAttempt<THandle = unknown> {
  /** Unique step execution identifier for the attempt. */
  readonly stepExecId: string;

  /** Base scope checkpoint serialized before the attempt. */
  readonly baseCkpt: string | undefined;

  /** Isolation scope inspection receipt captured before the attempt. */
  readonly scopeReceipt: Record<string, unknown>;

  /** Projected or raw step input payload. */
  readonly stepInput: unknown;

  /** Target step executable merged with step-level interrupt handlers. */
  readonly executable: StepASTNode<unknown, unknown, THandle>;

  /** Configured step execution context for the attempt. */
  readonly stepCtx: StepExecutionContext<THandle>;
}

/**
 * Parameters passed to `handleFlowStepAttemptError`.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
interface HandleFlowStepAttemptErrorParams<TIn = unknown, THandle = unknown> {
  /** Active flow execution context. */
  readonly flowCtx: FlowExecutionContext<TIn, THandle>;

  /** Passive `FlowStepNode` that faulted or suspended. */
  readonly stepNode: FlowStepNode<unknown, unknown, THandle>;

  /** Prepared step attempt metadata. */
  readonly prepared: PreparedFlowStepAttempt<THandle>;

  /** Caught error from `executeStepNode`. */
  readonly err: unknown;

  /** Current 1-based retry attempt index. */
  readonly attempt: number;

  /** Maximum configured retry attempts for the step. */
  readonly maxTries: number;
}

/**
 * Executes a step-level `.replaceWith()` promotion when a step raises an interrupt matching a `'replace'` handler (`SPEC.md` §3.6 & §3.9).
 *
 * Runs any configured `abortHook`, computes `replacementInput`, and calls `executeReplaceWithPromotion`.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>}      flowCtx    - Active flow execution context.
 * @param {FlowStepNode<unknown, unknown, THandle>} stepNode   - Passive `FlowStepNode` being replaced.
 * @param {TryPromoteStepReplacementParams<THandle>} replaceCtx - Caught error, step execution ID, base checkpoint, scope receipt, and step context.
 *
 * @returns {Promise<boolean>} True if a `'replace'` handler matched and promoted the replacement executable.
 */
async function tryPromoteStepReplacement<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
  stepNode: FlowStepNode<unknown, unknown, THandle>,
  replaceCtx: TryPromoteStepReplacementParams<THandle>,
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
 * Prepares a single flow step execution attempt by inspecting the scope, projecting `.inputFrom()`, recording step start, and building `StepExecutionContext` (`SPEC.md` §3.9).
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>}      flowCtx  - Active flow execution context.
 * @param {FlowStepNode<unknown, unknown, THandle>} stepNode - Passive `FlowStepNode` to prepare.
 * @param {number}                                  attempt  - Current 1-based attempt index.
 *
 * @returns {Promise<PreparedFlowStepAttempt<THandle>>} Prepared step attempt context and metadata.
 */
async function prepareFlowStepAttempt<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
  stepNode: FlowStepNode<unknown, unknown, THandle>,
  attempt: number,
): Promise<PreparedFlowStepAttempt<THandle>> {
  const scopeReceipt = await flowCtx.lockManager.withReadLock(
    flowCtx.scopeHandle,
    () => flowCtx.scopeDriver.inspect(flowCtx.scopeHandle),
    flowCtx.activeStepAbortController.signal,
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
  flowCtx.activeStepId = stepNode.id;
  flowCtx.activeStepExecId = stepExecId;
  const built = buildFlowStepExecutionContext(flowCtx, targetExecutable, {
    stepExecId,
    activePartitions: extractPartsFn !== undefined ? extractPartsFn(stepInput) : [],
    baseScopeCheckpoint: baseCkpt,
    stepInterruptHandlers: isReplaced ? [] : stepNode.onInterruptHandlers,
  });
  const stepCtx =
    flowCtx.resumeContinuationStack !== undefined
      ? Object.freeze({
          ...built.stepCtx,
          resumeContinuationStack: flowCtx.resumeContinuationStack,
        })
      : built.stepCtx;
  flowCtx.resumeContinuationStack = undefined;
  return {
    stepExecId,
    baseCkpt,
    scopeReceipt,
    stepInput,
    executable: built.executable ?? targetExecutable,
    stepCtx,
  };
}

/**
 * Handles an error or suspension thrown during a flow step attempt, performing replacement promotion or rollback (`SPEC.md` §3.9).
 *
 * Quiesces step services, resets step overlays, restores `baseScopeCheckpoint`, and records `'FAILED'` when not suspended or replaced.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {HandleFlowStepAttemptErrorParams<TIn, THandle>} params - Flow context, step node, prepared attempt, error, and retry bounds.
 *
 * @returns {Promise<'suspended' | 'rewound' | 'promoted' | 'retry'>} Resolution action for the step attempt loop.
 */
async function handleFlowStepAttemptError<TIn = unknown, THandle = unknown>(
  params: HandleFlowStepAttemptErrorParams<TIn, THandle>,
): Promise<'suspended' | 'rewound' | 'promoted' | 'retry'> {
  const { flowCtx, stepNode, prepared, err, attempt, maxTries } = params;
  const typedErr = err as Error & {
    readonly code?: string;
    readonly interruptResolution?: InterruptEdgeResolution<THandle>;
  };
  if (typedErr.code === 'HARNESS_STEP_SUSPENDED') {
    return 'suspended';
  }
  if (flowCtx.pendingRewindToStepId !== undefined) {
    return 'rewound';
  }
  const promoted = await tryPromoteStepReplacement(flowCtx, stepNode, {
    typedErr,
    stepExecId: prepared.stepExecId,
    baseCkpt: prepared.baseCkpt,
    scopeReceipt: prepared.scopeReceipt,
    stepCtx: prepared.stepCtx,
  });
  if (promoted) {
    return 'promoted';
  }
  flowCtx.activeStepExecId = null;
  await flowCtx.serviceRegistry.quiesceScopeServices(prepared.stepExecId);
  if (flowCtx.topologyStore !== undefined) {
    await flowCtx.topologyStore.resetRunOverlay(flowCtx.runId, {
      scope: 'step',
      stepExecId: prepared.stepExecId,
    });
  }
  if (prepared.baseCkpt !== undefined && flowCtx.scopeDriver.restoreCheckpoint !== undefined) {
    await flowCtx.scopeDriver.restoreCheckpoint(flowCtx.scopeHandle, prepared.baseCkpt);
  }
  await flowCtx.ledgerStore.recordStepTransition({
    stepExecId: prepared.stepExecId,
    status: 'FAILED',
    telemetryJson: JSON.stringify({ costUsd: 0, turnsTaken: 0, elapsedDurationMs: 0 }),
  });
  if (attempt >= maxTries) {
    throw err;
  }
  return 'retry';
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
    const prepared = await prepareFlowStepAttempt(flowCtx, stepNode, attempt);
    try {
      const output = await executeStepNode(
        prepared.executable,
        prepared.stepInput,
        prepared.stepCtx,
      );
      flowCtx.activeReplacementExecutable = undefined;
      flowCtx.activeStepExecId = null;
      flowCtx.completedStepOutputs.set(stepNode.id, output);
      if (outerBranchId !== undefined) {
        flowCtx.completedStepOutputs.set(outerBranchId, output);
      }
      await flowCtx.ledgerStore.recordStepTransition({
        stepExecId: prepared.stepExecId,
        status: 'COMPLETED',
        outputJson: JSON.stringify(output),
        telemetryJson: JSON.stringify({ costUsd: 0, turnsTaken: 1, elapsedDurationMs: 0 }),
      });
      return Object.freeze({ status: 'completed', output });
    } catch (err) {
      const action = await handleFlowStepAttemptError({
        flowCtx,
        stepNode,
        prepared,
        err,
        attempt,
        maxTries,
      });
      if (action === 'suspended' || action === 'rewound') {
        return Object.freeze({ status: action });
      }
      if (action === 'promoted') {
        attempt -= 1;
      }
    }
  }
  throw new Error(`Exhausted retries for step '${stepNode.id}' in run '${flowCtx.runId}'.`);
}
