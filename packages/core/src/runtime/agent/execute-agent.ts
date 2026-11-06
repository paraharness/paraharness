import type { AgentNode } from '../../ast/agent-node.js';
import type { ModelASTNode, StepASTNode } from '../../ast/domain-ast.types.js';
import type { AgentContinuationFrame } from '../../ports/agent-continuation-frame.js';
import type { CompiledWirePrefix } from '../../ports/compiled-wire-prefix.js';
import type { ContinuationFrame } from '../../ports/continuation-frame.types.js';
import type { HumanAdapter } from '../../ports/human-adapter.js';
import type { LedgerStore } from '../../ports/ledger-store.js';
import type { LessonOutcome } from '../../ports/lesson-outcome.types.js';
import type { LessonStore } from '../../ports/lesson-store.js';
import type { LoopContinuationFrame, RecalledLoopLessonRecord } from '../../ports/loop-continuation-frame.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import type { TopologyStore } from '../../ports/topology-store.js';
import type { ChildForkExecutionOutcome } from '../fork/child-fork-execution-outcome.js';
import { selectRecalledLessons } from '../lessons/lesson-scoring.js';
import { ScopeLockManager } from '../locks/scope-lock-manager.js';
import { StepContinuationQueue } from '../locks/step-continuation-queue.js';
import { PoolManager } from '../pools/pool-manager.js';
import { ServiceSessionRegistry } from '../services/service-session-registry.js';
import type { AgentTurnSessionState } from './agent-turn-session-state.js';
import {
  executeDefaultChildStep,
  resolveAgentScopedRulesAndDirectives,
  resolveAgentSkillsAndTools,
} from './internal/resolve-agent-session-inputs.js';
import { runAgentTurnLoop } from './internal/run-agent-turn-loop.js';

/**
 * Executes a passive `AgentNode` across turns, tool batches, policy guards, skills, capabilities, and `beforeStop` gates (`SPEC.md` §3.7.1).
 *
 * Pre-indexes tools, skills, and scoped rules at session start, delegates the turn loop to `runAgentTurnLoop()`,
 * and deterministically quiesces `'skill'`-scoped `ServiceSession` daemons in `finally`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentNode<TIn, TOut, THandle>} node  - Passive `AgentNode` AST definition.
 * @param {TIn}                           input - Raw or pre-mapped input payload for the agent.
 * @param {StepExecutionContext<THandle>} ctx   - Active step execution context.
 *
 * @returns {Promise<TOut>} Schema-validated agent output payload.
 */
export async function executeAgent<TIn = unknown, TOut = unknown, THandle = unknown>(
  node: AgentNode<TIn, TOut, THandle>,
  input: TIn,
  ctx: StepExecutionContext<THandle>,
): Promise<TOut> {
  const validatedInput = node.inputSchema.parse(input);
  const rtEnv = (ctx as StepExecutionContext<THandle> & {
    readonly _runtime?: {
      readonly ledgerStore?: LedgerStore; readonly topologyStore?: TopologyStore; readonly lessonStore?: LessonStore;
      readonly lockManager?: ScopeLockManager; readonly continuationQueue?: StepContinuationQueue; readonly poolManager?: PoolManager;
      readonly serviceRegistry?: ServiceSessionRegistry; readonly humanAdaptersById?: ReadonlyMap<string, HumanAdapter>;
      readonly wirePrefixesByGroupId?: ReadonlyMap<string, CompiledWirePrefix>; readonly outerFrames?: ContinuationFrame[];
      readonly existingAgentFrame?: AgentContinuationFrame; readonly overrideModelNode?: ModelASTNode; readonly laneId?: string;
      readonly itemKey?: string; readonly baseScopeCheckpoint?: string;
      readonly executeChildStep?: (childNode: StepASTNode<unknown, unknown, THandle>, childInput: unknown, childCtx: StepExecutionContext<THandle>) => Promise<ChildForkExecutionOutcome<unknown>>;
      readonly childOutcomeSink?: { continuationStack?: readonly ContinuationFrame[]; leafMessageId?: string | null; accumulatedLessonOutcomes?: Readonly<Record<string, LessonOutcome>>; raisedByPhase?: 'act' | 'evaluate'; suspendedAtCallId?: string };
    };
  })._runtime;
  const { toolsByName, skillsById, skillOwnerByToolName, serviceByToolName } = await resolveAgentSkillsAndTools(node, ctx);
  const { scopedRules, actorGroundingTexts, actorInstructionTexts } = await resolveAgentScopedRulesAndDirectives(node, ctx);
  const poolManager = rtEnv?.poolManager ?? new PoolManager();
  const modelNode: ModelASTNode = rtEnv?.overrideModelNode ?? poolManager.selectModel(node.model, ctx.runId, 0);
  const modelDriverFactory = ctx.registry.models[modelNode.type];
  if (modelDriverFactory === undefined) throw new Error(`No ModelDriver registered for '${modelNode.type}' on agent '${node.id}'.`);
  const modelDriver = modelDriverFactory(modelNode as never, { registry: ctx.registry, resolveEnv: (v) => ctx.resolveEnv(v), getRunner: (n) => ctx.getRunner(n) });
  const outerFrames: ContinuationFrame[] = rtEnv?.outerFrames ?? [];
  const loopFrame = outerFrames.find((f): f is LoopContinuationFrame => f.kind === 'loop-frame');
  const resumedAgentFrame = rtEnv?.existingAgentFrame ?? ctx.resumeContinuationStack?.find((f): f is AgentContinuationFrame => f.kind === 'agent-frame');
  let recalledLessons: readonly RecalledLoopLessonRecord[] = loopFrame?.recalledLessons ?? [];
  if (recalledLessons.length === 0 && node.lessons !== undefined && rtEnv?.lessonStore !== undefined) {
    const queryText = node.lessons.node.queryMapper !== undefined ? node.lessons.node.queryMapper(validatedInput) : JSON.stringify(validatedInput);
    const candidates = await rtEnv.lessonStore.queryCandidates({ queryText, partitions: ctx.activePartitions });
    recalledLessons = selectRecalledLessons(candidates, node.lessons.node.scoring, ctx.activePartitions).map((l) => Object.freeze({ id: l.id, partition: l.partition, directive: l.directive }));
  }
  const accumulatedLessonOutcomes: Record<string, LessonOutcome> = { ...(resumedAgentFrame?.accumulatedLessonOutcomes ?? {}) };
  const initialLeases = Object.freeze([...ctx.activeLeases, ...(resumedAgentFrame?.activeLeases ?? loopFrame?.grantedLoopLeases ?? [])]);
  const agentFrame: AgentContinuationFrame = resumedAgentFrame !== undefined
    ? Object.freeze<AgentContinuationFrame>({ ...resumedAgentFrame, activeLeases: initialLeases })
    : Object.freeze<AgentContinuationFrame>({
      kind: 'agent-frame', agentId: node.id, roleKey: node.roleKey, modelId: modelNode.modelId, stepExecId: ctx.stepExecId, inputJson: JSON.stringify(validatedInput), leafMessageId: null,
      turnsTaken: 0, costUsd: 0, elapsedDurationMs: 0, activeLeases: initialLeases,
      activeSkillIds: loopFrame?.phase === 'act' ? loopFrame.activeSkillIds : Object.freeze([]), activeSkillActivations: loopFrame?.phase === 'act' ? loopFrame.activeSkillActivations : Object.freeze({}),
      observedEffects: loopFrame?.phase === 'act' ? loopFrame.observedEffects : Object.freeze([]), injectedScopedRuleIds: loopFrame?.phase === 'act' ? loopFrame.injectedScopedRuleIds : Object.freeze([]),
      pausedAtPhase: 'TOOL_BOUNDARY', pauseState: Object.freeze({ kind: 'active-turn' }),
    });
  const serviceRegistry = rtEnv?.serviceRegistry ?? new ServiceSessionRegistry();
  const session: AgentTurnSessionState<TIn, TOut, THandle> = {
    node, validatedInput, ctx, agentFrame, outerFrames, skillsById, skillOwnerByToolName, serviceByToolName, actorGroundingTexts, actorInstructionTexts, scopedRules, toolsByName, modelNode, modelDriver,
    wirePrefix: node.prefixGroup !== undefined ? rtEnv?.wirePrefixesByGroupId?.get(node.prefixGroup.id) : undefined, ledgerStore: rtEnv?.ledgerStore, topologyStore: rtEnv?.topologyStore, lessonStore: rtEnv?.lessonStore,
    lockManager: rtEnv?.lockManager ?? new ScopeLockManager(), continuationQueue: rtEnv?.continuationQueue ?? new StepContinuationQueue(), poolManager, serviceRegistry, humanAdaptersById: rtEnv?.humanAdaptersById ?? new Map(),
    recalledLessons, accumulatedLessonOutcomes, laneId: rtEnv?.laneId, itemKey: rtEnv?.itemKey, baseScopeCheckpoint: rtEnv?.baseScopeCheckpoint, spawnedTasksCount: 0,
    executeChildStep: rtEnv?.executeChildStep ?? ((cNode, cIn, cCtx) => executeDefaultChildStep(cNode, cIn, cCtx, session)),
  };
  try {
    return await runAgentTurnLoop(session);
  } finally {
    if (rtEnv?.childOutcomeSink !== undefined) {
      rtEnv.childOutcomeSink.continuationStack = Object.freeze([session.agentFrame]);
      rtEnv.childOutcomeSink.leafMessageId = session.agentFrame.leafMessageId;
      rtEnv.childOutcomeSink.accumulatedLessonOutcomes = Object.freeze({ ...session.accumulatedLessonOutcomes });
      if (session.agentFrame.pauseState.kind === 'tool-batch') {
        rtEnv.childOutcomeSink.suspendedAtCallId = session.agentFrame.pauseState.pendingToolBatch.activeInterruptCallId ?? session.agentFrame.pauseState.pendingToolBatch.remainingCalls[0]?.callId;
      }
    }
    await serviceRegistry.quiesceScopeServices(ctx.stepExecId);
  }
}
