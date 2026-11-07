import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import { compileRunWirePrefixes } from '../prefix/compile-wire-prefix.js';
import type { FlowExecutionContext } from './flow-execution-context.js';
import type { FlowRunResult } from './flow-run-result.js';
import { collectFlowActors, collectFlowPrefixGroups } from './internal/collect-flow-actors.js';
import { executeFlowBranch } from './internal/execute-flow-branch.js';
import { executeFlowStep } from './internal/execute-flow-step.js';
import { foldFlowCustomTelemetry } from './internal/flow-replace-and-rewind.js';

/**
 * Compiles run wire prefixes (if not already compiled) and initializes or resumes the run record in `LedgerStore` (`SPEC.md` §3.9).
 *
 * Restores persisted `completedStepOutputsJson` into `flowCtx.completedStepOutputs` when resuming.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>} flowCtx - Active flow execution context.
 *
 * @returns {Promise<void>} Resolves once prefixes and run state are initialized in `LedgerStore`.
 */
async function initializeOrResumeFlowRun<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
): Promise<void> {
  flowCtx.currentInput = flowCtx.flow.inputSchema.parse(flowCtx.currentInput);
  const flowActors = collectFlowActors(flowCtx.flow.nodes);
  const prefixGroups = collectFlowPrefixGroups(flowActors, flowCtx.prefixGroups);
  if (flowCtx.wirePrefixesByGroupId.size === 0 && prefixGroups.length > 0) {
    const compiled = await compileRunWirePrefixes({
      prefixGroups,
      actors: flowActors,
      registry: flowCtx.registry,
      resolutionContext: {
        runId: flowCtx.runId,
        scopeHandle: flowCtx.scopeHandle,
        activePartitions: [],
        observedEffects: [],
        resolveEnv: (v) => (typeof v === 'string' ? v : flowCtx.env[v.key]),
      },
    });
    const byId = new Map<string, CompiledWirePrefix>();
    const jsonMap: Record<string, string> = {};
    for (const [pgId, prefix] of compiled.entries()) {
      byId.set(pgId, prefix);
      jsonMap[pgId] = JSON.stringify(prefix);
    }
    flowCtx.wirePrefixesByGroupId = byId;
    await flowCtx.ledgerStore.createOrResumeRun({
      runId: flowCtx.runId,
      laneId: flowCtx.laneId,
      itemKey: flowCtx.itemKey,
      inputJson: JSON.stringify(flowCtx.currentInput),
      compiledPrefixesJson: jsonMap,
    });
    return;
  }
  const resumed = await flowCtx.ledgerStore.createOrResumeRun({
    runId: flowCtx.runId,
    laneId: flowCtx.laneId,
    itemKey: flowCtx.itemKey,
    inputJson: JSON.stringify(flowCtx.currentInput),
  });
  for (const [stepId, outJson] of resumed.completedStepOutputsJson.entries()) {
    if (!flowCtx.completedStepOutputs.has(stepId)) {
      flowCtx.completedStepOutputs.set(stepId, JSON.parse(outJson));
    }
  }
}

/**
 * Applies a pending `.rewindTo()` jump on `flowCtx`, invalidating downstream `completedStepOutputs` (`SPEC.md` §3.9 & §3.10).
 *
 * Returns the updated node cursor index.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>} flowCtx    - Active flow execution context.
 * @param {number}                             currentIdx - Current flow node cursor index.
 *
 * @returns {number} Updated flow node cursor index.
 */
function applyPendingFlowRewindJump<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
  currentIdx: number,
): number {
  if (flowCtx.pendingRewindToStepId === undefined) {
    return currentIdx;
  }
  const jumpIdx = flowCtx.flow.nodes.findIndex((n) => n.id === flowCtx.pendingRewindToStepId);
  flowCtx.pendingRewindToStepId = undefined;
  if (jumpIdx < 0) {
    return currentIdx;
  }
  for (let i = jumpIdx; i < flowCtx.flow.nodes.length; i += 1) {
    flowCtx.completedStepOutputs.delete(flowCtx.flow.nodes[i]?.id ?? '');
  }
  return jumpIdx;
}

/**
 * Executes a `FlowNode` from start or crash-recovery resume through its sequential steps and conditional branches (`SPEC.md` §3.9).
 *
 * Compiles and pins `PrefixGroupNode` wire prefixes at run start, loops across `flow.nodes` (supporting
 * live `.rewindTo()` jumps), seals the run's topology overlay on completion, and releases the root scope in `finally`.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>} flowCtx - Configured flow execution context.
 *
 * @returns {Promise<FlowRunResult>} Terminal flow run receipt and outputs.
 */
export async function executeFlow<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
): Promise<FlowRunResult> {
  await initializeOrResumeFlowRun(flowCtx);
  try {
    let idx =
      flowCtx.activeStepId !== null
        ? Math.max(
            0,
            flowCtx.flow.nodes.findIndex((n) => n.id === flowCtx.activeStepId),
          )
        : 0;
    for (; idx < flowCtx.flow.nodes.length; ) {
      idx = applyPendingFlowRewindJump(flowCtx, idx);
      const node = flowCtx.flow.nodes[idx];
      if (node === undefined) {
        break;
      }
      const stepRes =
        node.type === 'harness:flow-step'
          ? await executeFlowStep(flowCtx, node)
          : await executeFlowBranch(flowCtx, node);
      if (stepRes.status === 'suspended') {
        const scopeReceipt = await flowCtx.lockManager.withReadLock(
          flowCtx.scopeHandle,
          () => flowCtx.scopeDriver.inspect(flowCtx.scopeHandle),
          flowCtx.activeStepAbortController.signal,
        );
        return Object.freeze<FlowRunResult>({
          runId: flowCtx.runId,
          exitState: 'SUSPENDED',
          scopeReceipt,
          stepOutputs: Object.freeze(Object.fromEntries(flowCtx.completedStepOutputs.entries())),
        });
      }
      if (stepRes.status !== 'rewound' && flowCtx.pendingRewindToStepId === undefined) {
        idx += 1;
      }
    }
    const finalReceipt = await flowCtx.lockManager.withReadLock(
      flowCtx.scopeHandle,
      () => flowCtx.scopeDriver.inspect(flowCtx.scopeHandle),
      flowCtx.activeStepAbortController.signal,
    );
    if (flowCtx.topologyStore !== undefined) {
      await flowCtx.topologyStore.sealRunOverlay(flowCtx.runId);
    }
    return Object.freeze<FlowRunResult>({
      runId: flowCtx.runId,
      exitState: flowCtx.flow.exitState,
      scopeReceipt: finalReceipt,
      stepOutputs: Object.freeze(Object.fromEntries(flowCtx.completedStepOutputs.entries())),
      customTelemetry: await foldFlowCustomTelemetry(flowCtx),
    });
  } finally {
    await flowCtx.serviceRegistry.quiesceScopeServices(flowCtx.runId);
  }
}
