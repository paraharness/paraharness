import type { FlowBranchNode } from '../../ast/flow-branch-node.js';
import type { FlowStepNode } from '../../ast/flow-step-node.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { InterruptEdgeResolution } from '../agent/interrupt-edge-resolution.js';
import { compileRunWirePrefixes } from '../prefix/compile-wire-prefix.js';
import { executeStepNode } from '../step/execute-step-node.js';
import type { FlowExecutionContext } from './flow-execution-context.js';
import type { FlowRunResult } from './flow-run-result.js';
import {
  buildFlowStepExecutionContext,
  collectFlowActors,
  collectFlowPrefixGroups,
} from './internal/collect-flow-actors.js';
import { executeReplaceWithPromotion, foldFlowCustomTelemetry } from './internal/flow-replace-and-rewind.js';

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
export async function executeFlowStep<TIn = unknown, THandle = unknown>(flowCtx: FlowExecutionContext<TIn, THandle>, stepNode: FlowStepNode<unknown, unknown, THandle>, outerBranchId?: string): Promise<{ readonly status: 'completed' | 'suspended' | 'rewound'; readonly output?: unknown }> {
  const maxTries = flowCtx.retryConfig?.tries ?? 1;
  for (let attempt = 1; attempt <= maxTries; attempt += 1) {
    const scopeReceipt = await flowCtx.lockManager.withReadLock(flowCtx.scopeHandle, () => flowCtx.scopeDriver.inspect(flowCtx.scopeHandle));
    const isReplaced = flowCtx.activeReplacementExecutable !== undefined, targetExecutable = flowCtx.activeReplacementExecutable ?? stepNode.step;
    const stepInput = !isReplaced && stepNode.inputFrom !== undefined ? stepNode.inputFrom(flowCtx.currentInput, Object.fromEntries(flowCtx.completedStepOutputs.entries()), scopeReceipt) : flowCtx.currentInput;
    const extractPartsFn = (targetExecutable as { readonly extractPartitions?: (i: unknown) => readonly string[] }).extractPartitions, stepExecId = flowCtx.activeStepExecId ?? `${flowCtx.runId}:${stepNode.id}:${String(attempt)}`;
    const baseCkpt = flowCtx.scopeDriver.serializeCheckpoint !== undefined ? await flowCtx.scopeDriver.serializeCheckpoint(flowCtx.scopeHandle) : undefined;
    if (flowCtx.activeStepExecId === null) await flowCtx.ledgerStore.recordStepStart({ runId: flowCtx.runId, stepExecId, stepId: stepNode.id, executableId: targetExecutable.id, inputMsgId: null, baseScopeCheckpoint: baseCkpt, continuationStack: Object.freeze([]) });
    flowCtx.activeStepId = stepNode.id;
    flowCtx.activeStepExecId = stepExecId;
    const { executable, stepCtx } = buildFlowStepExecutionContext(flowCtx, targetExecutable, { stepExecId, activePartitions: extractPartsFn !== undefined ? extractPartsFn(stepInput) : [], baseScopeCheckpoint: baseCkpt, stepInterruptHandlers: isReplaced ? [] : stepNode.onInterruptHandlers });
    try {
      const output = await executeStepNode(executable, stepInput, stepCtx);
      flowCtx.activeReplacementExecutable = undefined;
      flowCtx.activeStepExecId = null;
      flowCtx.completedStepOutputs.set(stepNode.id, output);
      if (outerBranchId !== undefined) flowCtx.completedStepOutputs.set(outerBranchId, output);
      await flowCtx.ledgerStore.recordStepTransition({ stepExecId, status: 'COMPLETED', outputJson: JSON.stringify(output), telemetryJson: JSON.stringify({ costUsd: 0, turnsTaken: 1, elapsedDurationMs: 0 }) });
      return Object.freeze({ status: 'completed', output });
    } catch (err) {
      const typedErr = err as Error & { readonly code?: string; readonly interruptResolution?: InterruptEdgeResolution<THandle> };
      if (typedErr.code === 'HARNESS_STEP_SUSPENDED') return Object.freeze({ status: 'suspended' });
      if (flowCtx.pendingRewindToStepId !== undefined) return Object.freeze({ status: 'rewound' });
      const effHandler = typedErr.interruptResolution?.replaceHandler ?? (typedErr.interruptResolution !== undefined ? stepNode.onInterruptHandlers.find((h) => h.interrupt.id === typedErr.interruptResolution?.interruptId) : undefined);
      if (effHandler?.mode === 'replace') {
        await executeReplaceWithPromotion({ flowCtx, stepExecId, stepId: stepNode.id, baseScopeCheckpoint: baseCkpt, replacementExecutable: effHandler.replacementExecutable, replacementInput: effHandler.mapReplacementInput(flowCtx.currentInput, typedErr.interruptResolution?.payload, { costUsd: 0, turnsTaken: 0, durationMs: 0, custom: scopeReceipt, abortMeta: {} }) as TIn, abortHook: effHandler.abortHook });
        attempt -= 1;
        continue;
      }
      flowCtx.activeStepExecId = null;
      await flowCtx.serviceRegistry.quiesceScopeServices(stepExecId);
      if (flowCtx.topologyStore !== undefined) await flowCtx.topologyStore.resetRunOverlay(flowCtx.runId, { scope: 'step', stepExecId });
      if (baseCkpt !== undefined && flowCtx.scopeDriver.restoreCheckpoint !== undefined) await flowCtx.scopeDriver.restoreCheckpoint(flowCtx.scopeHandle, baseCkpt);
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
export async function executeFlow<TIn = unknown, THandle = unknown>(flowCtx: FlowExecutionContext<TIn, THandle>): Promise<FlowRunResult> {
  flowCtx.currentInput = flowCtx.flow.inputSchema.parse(flowCtx.currentInput);
  const flowActors = collectFlowActors(flowCtx.flow.nodes), prefixGroups = collectFlowPrefixGroups(flowActors, flowCtx.prefixGroups);
  if (flowCtx.wirePrefixesByGroupId.size === 0 && prefixGroups.length > 0) {
    const compiled = await compileRunWirePrefixes({ prefixGroups, actors: flowActors, registry: flowCtx.registry, resolutionContext: { runId: flowCtx.runId, scopeHandle: flowCtx.scopeHandle, activePartitions: [], observedEffects: [], resolveEnv: (v) => (typeof v === 'string' ? v : flowCtx.env[v.key]) } });
    const byId = new Map<string, CompiledWirePrefix>(), jsonMap: Record<string, string> = {};
    for (const [pgId, p] of compiled.entries()) {
      byId.set(pgId, p);
      jsonMap[pgId] = JSON.stringify(p);
    }
    flowCtx.wirePrefixesByGroupId = byId;
    await flowCtx.ledgerStore.createOrResumeRun({ runId: flowCtx.runId, laneId: flowCtx.laneId, itemKey: flowCtx.itemKey, inputJson: JSON.stringify(flowCtx.currentInput), compiledPrefixesJson: jsonMap });
  } else {
    const resumed = await flowCtx.ledgerStore.createOrResumeRun({ runId: flowCtx.runId, laneId: flowCtx.laneId, itemKey: flowCtx.itemKey, inputJson: JSON.stringify(flowCtx.currentInput) });
    for (const [stepId, outJson] of resumed.completedStepOutputsJson.entries()) if (!flowCtx.completedStepOutputs.has(stepId)) flowCtx.completedStepOutputs.set(stepId, JSON.parse(outJson));
  }
  try {
    for (let idx = 0; idx < flowCtx.flow.nodes.length; ) {
      if (flowCtx.pendingRewindToStepId !== undefined) {
        const jumpIdx = flowCtx.flow.nodes.findIndex((n) => n.id === flowCtx.pendingRewindToStepId);
        flowCtx.pendingRewindToStepId = undefined;
        if (jumpIdx >= 0) idx = jumpIdx;
      }
      const node = flowCtx.flow.nodes[idx];
      if (node === undefined) break;
      const stepRes = node.type === 'harness:flow-step' ? await executeFlowStep(flowCtx, node) : await executeFlowBranch(flowCtx, node);
      if (stepRes.status === 'suspended') {
        const scopeReceipt = await flowCtx.lockManager.withReadLock(flowCtx.scopeHandle, () => flowCtx.scopeDriver.inspect(flowCtx.scopeHandle));
        return Object.freeze<FlowRunResult>({ runId: flowCtx.runId, exitState: 'SUSPENDED', scopeReceipt, stepOutputs: Object.freeze(Object.fromEntries(flowCtx.completedStepOutputs.entries())) });
      }
      if (stepRes.status !== 'rewound') idx += 1;
    }
    const finalReceipt = await flowCtx.lockManager.withReadLock(flowCtx.scopeHandle, () => flowCtx.scopeDriver.inspect(flowCtx.scopeHandle));
    if (flowCtx.topologyStore !== undefined) await flowCtx.topologyStore.sealRunOverlay(flowCtx.runId);
    const customTelemetry = await foldFlowCustomTelemetry(flowCtx);
    return Object.freeze<FlowRunResult>({ runId: flowCtx.runId, exitState: flowCtx.flow.exitState, scopeReceipt: finalReceipt, stepOutputs: Object.freeze(Object.fromEntries(flowCtx.completedStepOutputs.entries())), customTelemetry });
  } finally {
    await flowCtx.serviceRegistry.quiesceScopeServices(flowCtx.runId);
  }
}
