import type { FlowBranchNode } from '../../ast/flow-branch-node.js';
import type { FlowStepNode } from '../../ast/flow-step-node.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { ToolEffect } from '../../ports/tool-effect.js';
import type { InterruptEdgeResolution } from '../agent/agent-turn-session-state.js';
import { compileRunWirePrefixes } from '../prefix/compile-wire-prefix.js';
import { executeStepNode } from '../step/execute-step-node.js';
import type { FlowExecutionContext, FlowRunResult } from './flow-execution-context.js';
import { executeReplaceWithPromotion, foldFlowCustomTelemetry } from './internal/flow-replace-and-rewind.js';

/**
 * Executes a single `FlowStepNode`, handling `.inputFrom()` projection, step-level `.replaceWith()` promotion, and `.retry()` backoff (`SPEC.md` §3.9).
 *
 * Persists `completedStepOutputs` and `recordStepTransition` in `LedgerStore` when the step completes,
 * and quiesces `'scope'`-scoped services if the step faults or aborts.
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
): Promise<{ readonly status: 'completed' | 'suspended' | 'rewound'; readonly output?: unknown }> {
  const maxTries = flowCtx.retryConfig?.tries ?? 1;
  for (let attempt = 1; attempt <= maxTries; attempt += 1) {
    const scopeReceipt = await flowCtx.lockManager.withReadLock(flowCtx.scopeHandle, () => flowCtx.scopeDriver.inspect(flowCtx.scopeHandle));
    const stepInput = stepNode.inputFrom !== undefined ? stepNode.inputFrom(flowCtx.currentInput, Object.fromEntries(flowCtx.completedStepOutputs.entries()), scopeReceipt) : flowCtx.currentInput;
    const targetExecutable = flowCtx.activeReplacementExecutable ?? stepNode.step;
    const extractPartsFn = (targetExecutable as { readonly extractPartitions?: (i: unknown) => readonly string[] }).extractPartitions;
    const activePartitions = extractPartsFn !== undefined ? extractPartsFn(stepInput) : [];
    if (flowCtx.topologyStore !== undefined && activePartitions.length > 0) await flowCtx.topologyStore.getPartitions(flowCtx.runId);
    const stepExecId = flowCtx.activeStepExecId ?? `${flowCtx.runId}:${stepNode.id}:${String(attempt)}`;
    flowCtx.activeStepId = stepNode.id; flowCtx.activeStepExecId = stepExecId;
    const baseCkpt = flowCtx.scopeDriver.serializeCheckpoint !== undefined ? await flowCtx.scopeDriver.serializeCheckpoint(flowCtx.scopeHandle) : undefined;
    await flowCtx.ledgerStore.recordStepStart({ runId: flowCtx.runId, stepExecId, stepId: stepNode.id, executableId: targetExecutable.id, inputMsgId: null, baseScopeCheckpoint: baseCkpt, continuationStack: Object.freeze([]) });
    const stepCtx = { runId: flowCtx.runId, stepExecId, scopeHandle: flowCtx.scopeHandle, scopeNode: flowCtx.flow.scope, activePartitions, registry: flowCtx.registry, signal: flowCtx.activeStepAbortController.signal, recordEffects: (effs: readonly ToolEffect[]) => { flowCtx.observedRunEffects.push(...effs); }, _runtime: { ledgerStore: flowCtx.ledgerStore, topologyStore: flowCtx.topologyStore, lessonStore: flowCtx.lessonStore, lockManager: flowCtx.lockManager, continuationQueue: flowCtx.continuationQueue, poolManager: flowCtx.poolManager, serviceRegistry: flowCtx.serviceRegistry, humanAdaptersById: flowCtx.humanAdaptersById, wirePrefixesByGroupId: flowCtx.wirePrefixesByGroupId, laneId: flowCtx.laneId, itemKey: flowCtx.itemKey, baseScopeCheckpoint: baseCkpt } } as unknown as StepExecutionContext<THandle>;
    try {
      const output = await executeStepNode(targetExecutable, stepInput, stepCtx);
      flowCtx.activeReplacementExecutable = undefined; flowCtx.activeStepExecId = null;
      flowCtx.completedStepOutputs.set(stepNode.id, output);
      if (outerBranchId !== undefined) flowCtx.completedStepOutputs.set(outerBranchId, output);
      await flowCtx.ledgerStore.recordStepTransition({ stepExecId, status: 'COMPLETED', outputJson: JSON.stringify(output), telemetryJson: JSON.stringify({ costUsd: 0, turnsTaken: 1, elapsedDurationMs: 0 }) });
      return Object.freeze({ status: 'completed', output });
    } catch (err) {
      const typedErr = err as Error & { readonly code?: string; readonly interruptResolution?: InterruptEdgeResolution<THandle> };
      if (typedErr.code === 'HARNESS_STEP_SUSPENDED') return Object.freeze({ status: 'suspended' });
      if (flowCtx.pendingRewindToStepId !== undefined) return Object.freeze({ status: 'rewound' });
      const effHandler = typedErr.interruptResolution?.replaceHandler ?? (typedErr.interruptResolution !== undefined ? stepNode.onInterruptHandlers.find((h) => h.interrupt.id === typedErr.interruptResolution?.interruptId) : undefined);
      const replaceTarget = effHandler?.mode === 'replace' ? effHandler.replacementExecutable : undefined;
      const replaceInput = effHandler?.mode === 'replace' ? effHandler.mapReplacementInput(flowCtx.currentInput, typedErr.interruptResolution?.payload, { costUsd: 0, turnsTaken: 0, durationMs: 0, custom: scopeReceipt, abortMeta: {} }) : undefined;
      if (replaceTarget !== undefined) { await executeReplaceWithPromotion({ flowCtx, stepExecId, stepId: stepNode.id, baseScopeCheckpoint: baseCkpt, replacementExecutable: replaceTarget, replacementInput: (replaceInput ?? flowCtx.currentInput) as TIn }); attempt -= 1; continue; }
      if (flowCtx.topologyStore !== undefined) await flowCtx.topologyStore.resetRunOverlay(flowCtx.runId, { scope: 'step', stepExecId });
      await flowCtx.ledgerStore.recordStepTransition({ stepExecId, status: 'FAILED', telemetryJson: JSON.stringify({ costUsd: 0, turnsTaken: 0, elapsedDurationMs: 0 }) });
      if (attempt >= maxTries) throw err;
    }
  }
  throw new Error(`Exhausted retries for step '${stepNode.id}' in run '${flowCtx.runId}'.`);
}

/**
 * Evaluates a `FlowBranchNode` against `flowCtx.currentInput`, executes the first matching `when` case (or `otherwiseSteps`), and records output under `branchNode.id` (`SPEC.md` §3.9).
 *
 * Validates the final step output of the selected branch against `branchNode.outputSchema`.
 *
 * @template TIn     Validated flow input payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FlowExecutionContext<TIn, THandle>}    flowCtx    - Active flow execution context.
 * @param {FlowBranchNode<TIn, unknown, THandle>} branchNode - Passive `FlowBranchNode` to evaluate.
 *
 * @returns {Promise<{ readonly status: 'completed' | 'suspended' | 'rewound'; readonly output?: unknown }>} Branch execution outcome.
 */
export async function executeFlowBranch<TIn = unknown, THandle = unknown>(
  flowCtx: FlowExecutionContext<TIn, THandle>,
  branchNode: FlowBranchNode<TIn, unknown, THandle>,
): Promise<{ readonly status: 'completed' | 'suspended' | 'rewound'; readonly output?: unknown }> {
  const matchedCase = branchNode.cases.find((c) => c.predicate(flowCtx.currentInput));
  const selectedSteps = matchedCase !== undefined ? matchedCase.steps : branchNode.otherwiseSteps;
  let lastOutput: unknown;
  for (const childNode of selectedSteps) {
    const childRes = childNode.type === 'harness:flow-step'
      ? await executeFlowStep(flowCtx, childNode, branchNode.id)
      : await executeFlowBranch(flowCtx, childNode as FlowBranchNode<TIn, unknown, THandle>);
    if (childRes.status !== 'completed') return childRes;
    lastOutput = childRes.output;
  }
  const validatedBranchOut = branchNode.outputSchema.parse(lastOutput);
  flowCtx.completedStepOutputs.set(branchNode.id, validatedBranchOut);
  return Object.freeze({ status: 'completed', output: validatedBranchOut });
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
  flowCtx.currentInput = flowCtx.flow.inputSchema.parse(flowCtx.currentInput);
  if (flowCtx.wirePrefixesByGroupId.size === 0 && (flowCtx.prefixGroups?.length ?? 0) > 0) {
    const compiled = await compileRunWirePrefixes({ prefixGroups: flowCtx.prefixGroups ?? [], actors: [], registry: flowCtx.registry, resolutionContext: { runId: flowCtx.runId, scopeHandle: flowCtx.scopeHandle, activePartitions: [], observedEffects: [], resolveEnv: (v) => (typeof v === 'string' ? v : flowCtx.env[v.key]) } });
    const byId = new Map<string, CompiledWirePrefix>(), jsonMap: Record<string, string> = {};
    for (const [pgId, p] of compiled.entries()) { byId.set(pgId, p); jsonMap[pgId] = JSON.stringify(p); }
    flowCtx.wirePrefixesByGroupId = byId;
    await flowCtx.ledgerStore.createOrResumeRun({ runId: flowCtx.runId, laneId: flowCtx.laneId, itemKey: flowCtx.itemKey, inputJson: JSON.stringify(flowCtx.currentInput), compiledPrefixesJson: jsonMap });
  } else {
    const resumed = await flowCtx.ledgerStore.createOrResumeRun({ runId: flowCtx.runId, laneId: flowCtx.laneId, itemKey: flowCtx.itemKey, inputJson: JSON.stringify(flowCtx.currentInput) });
    for (const [stepId, outJson] of resumed.completedStepOutputsJson.entries()) if (!flowCtx.completedStepOutputs.has(stepId)) flowCtx.completedStepOutputs.set(stepId, JSON.parse(outJson));
  }
  try {
    let idx = 0;
    while (idx < flowCtx.flow.nodes.length) {
      if (flowCtx.pendingRewindToStepId !== undefined) {
        const targetId = flowCtx.pendingRewindToStepId; flowCtx.pendingRewindToStepId = undefined;
        const jumpIdx = flowCtx.flow.nodes.findIndex((n) => n.id === targetId);
        if (jumpIdx >= 0) idx = jumpIdx;
      }
      const node = flowCtx.flow.nodes[idx];
      if (node === undefined) break;
      const stepRes = node.type === 'harness:flow-step' ? await executeFlowStep(flowCtx, node) : await executeFlowBranch(flowCtx, node);
      if (stepRes.status === 'suspended') {
        const scopeReceipt = await flowCtx.lockManager.withReadLock(flowCtx.scopeHandle, () => flowCtx.scopeDriver.inspect(flowCtx.scopeHandle));
        return Object.freeze<FlowRunResult>({ runId: flowCtx.runId, exitState: 'SUSPENDED', scopeReceipt, stepOutputs: Object.freeze(Object.fromEntries(flowCtx.completedStepOutputs.entries())) });
      }
      if (stepRes.status === 'rewound') continue;
      idx += 1;
    }
    const finalReceipt = await flowCtx.lockManager.withReadLock(flowCtx.scopeHandle, () => flowCtx.scopeDriver.inspect(flowCtx.scopeHandle));
    if (flowCtx.topologyStore !== undefined) await flowCtx.topologyStore.sealRunOverlay(flowCtx.runId);
    const customTelemetry = await foldFlowCustomTelemetry(flowCtx);
    return Object.freeze<FlowRunResult>({ runId: flowCtx.runId, exitState: flowCtx.flow.exitState, scopeReceipt: finalReceipt, stepOutputs: Object.freeze(Object.fromEntries(flowCtx.completedStepOutputs.entries())), customTelemetry });
  } finally {
    await flowCtx.serviceRegistry.quiesceScopeServices(flowCtx.runId);
  }
}
