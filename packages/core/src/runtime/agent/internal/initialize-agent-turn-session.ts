import type { AgentNode } from '../../../ast/agent-node.js';
import type { ModelASTNode, StepASTNode } from '../../../ast/domain-ast.types.js';
import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { CompiledWirePrefix } from '../../../ports/compiled-wire-prefix.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { HumanAdapter } from '../../../ports/human-adapter.js';
import type { LedgerStore } from '../../../ports/ledger-store.js';
import type { LessonOutcome } from '../../../ports/lesson-outcome.types.js';
import type { LessonStore } from '../../../ports/lesson-store.js';
import type {
  LoopContinuationFrame,
  RecalledLoopLessonRecord,
} from '../../../ports/loop-continuation-frame.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { TopologyPartitionState } from '../../../ports/topology-partition-state.js';
import type { TopologyStore } from '../../../ports/topology-store.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import type { ChildForkExecutionOutcome } from '../../fork/child-fork-execution-outcome.js';
import { selectRecalledLessons } from '../../lessons/lesson-scoring.js';
import { ScopeLockManager } from '../../locks/scope-lock-manager.js';
import { StepContinuationQueue } from '../../locks/step-continuation-queue.js';
import { PoolManager } from '../../pools/pool-manager.js';
import { buildRoleAndScopeContextFrame } from '../../prefix/internal/build-role-and-scope-context-frame.js';
import { computeInRunGroundingDiffs } from '../../prefix/internal/compute-in-run-grounding-diffs.js';
import type { SkillCatalogEntryRecord } from '../../prefix/skill-catalog-entry-record.js';
import { ServiceSessionRegistry } from '../../services/service-session-registry.js';
import type { AgentTurnSessionState } from '../agent-turn-session-state.js';
import {
  executeDefaultChildStep,
  resolveAgentScopedRulesAndDirectives,
  resolveAgentSkillsAndTools,
} from './resolve-agent-session-inputs.js';

/**
 * Recalls Turn-0 empirical lessons for an `AgentNode` when not already provided by an enclosing `LoopContinuationFrame` (`SPEC.md` §3.4.3).
 *
 * Queries `lessonStore.queryCandidates` and ranks candidates via `selectRecalledLessons`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentNode<TIn, TOut, THandle>} node           - Passive `AgentNode` AST definition.
 * @param {TIn}                           validatedInput - Schema-validated agent input payload.
 * @param {object}                        recallContext  - Active step context, enclosing loop frame, and optional lesson store.
 *
 * @returns {Promise<readonly RecalledLoopLessonRecord[]>} Frozen recalled lesson records.
 */
async function recallAgentTurnLessons<TIn, TOut, THandle>(
  node: AgentNode<TIn, TOut, THandle>,
  validatedInput: TIn,
  recallContext: {
    readonly ctx: StepExecutionContext<THandle>;
    readonly loopFrame: LoopContinuationFrame | undefined;
    readonly lessonStore: LessonStore | undefined;
  },
): Promise<readonly RecalledLoopLessonRecord[]> {
  if (
    recallContext.loopFrame !== undefined &&
    recallContext.loopFrame.recalledLessons.length > 0
  ) {
    return recallContext.loopFrame.recalledLessons;
  }
  if (node.lessons === undefined || recallContext.lessonStore === undefined) {
    return Object.freeze([]);
  }
  const queryText =
    node.lessons.node.queryMapper !== undefined
      ? node.lessons.node.queryMapper(validatedInput)
      : JSON.stringify(validatedInput);
  const candidates = await recallContext.lessonStore.queryCandidates({
    queryText,
    partitions: recallContext.ctx.activePartitions,
  });
  const selected = selectRecalledLessons(
    candidates,
    node.lessons.node.scoring,
    recallContext.ctx.activePartitions,
  );
  const recalled: RecalledLoopLessonRecord[] = [];
  for (const lesson of selected) {
    recalled.push(
      Object.freeze<RecalledLoopLessonRecord>({
        id: lesson.id,
        partition: lesson.partition,
        directive: lesson.directive,
      }),
    );
  }
  return Object.freeze(recalled);
}

/**
 * Initializes the `AgentTurnSessionState` and `AgentContinuationFrame` for an `AgentNode` execution (`SPEC.md` §3.7.1).
 *
 * Pre-indexes tools, skills, and scoped rules once (`Rule 4.2`), resolves the model driver, recalls
 * Turn-0 lessons, and restores any persisted `AgentContinuationFrame` on resume.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentNode<TIn, TOut, THandle>} node           - Passive `AgentNode` AST definition.
 * @param {TIn}                           validatedInput - Schema-validated agent input payload.
 * @param {StepExecutionContext<THandle>} ctx            - Active step execution context.
 *
 * @returns {Promise<AgentTurnSessionState<TIn, TOut, THandle>>} Initialized agent turn session state.
 */
export async function initializeAgentTurnSession<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
>(
  node: AgentNode<TIn, TOut, THandle>,
  validatedInput: TIn,
  ctx: StepExecutionContext<THandle>,
): Promise<AgentTurnSessionState<TIn, TOut, THandle>> {
  const rtEnv = (
    ctx as StepExecutionContext<THandle> & {
      readonly _runtime?: {
        readonly ledgerStore?: LedgerStore;
        readonly topologyStore?: TopologyStore;
        readonly lessonStore?: LessonStore;
        readonly lockManager?: ScopeLockManager;
        readonly continuationQueue?: StepContinuationQueue;
        readonly poolManager?: PoolManager;
        readonly serviceRegistry?: ServiceSessionRegistry;
        readonly humanAdaptersById?: ReadonlyMap<string, HumanAdapter>;
        readonly wirePrefixesByGroupId?: ReadonlyMap<string, CompiledWirePrefix>;
        readonly outerFrames?: ContinuationFrame[];
        readonly existingAgentFrame?: AgentContinuationFrame;
        readonly overrideModelNode?: ModelASTNode;
        readonly laneId?: string;
        readonly itemKey?: string;
        readonly baseScopeCheckpoint?: string;
        readonly executeChildStep?: (
          childNode: StepASTNode<unknown, unknown, THandle>,
          childInput: unknown,
          childCtx: StepExecutionContext<THandle>,
        ) => Promise<ChildForkExecutionOutcome<unknown>>;
      };
    }
  )._runtime;
  const { toolsByName, skillsById, skillOwnerByToolName, serviceByToolName } =
    await resolveAgentSkillsAndTools(node, ctx);
  const { scopedRules, actorGroundingTexts, actorInstructionTexts } =
    await resolveAgentScopedRulesAndDirectives(node, ctx);
  const poolManager = rtEnv?.poolManager ?? new PoolManager();
  const modelNode: ModelASTNode =
    rtEnv?.overrideModelNode ?? poolManager.selectModel(node.model, ctx.runId, 0);
  const modelDriverFactory = ctx.registry.models[modelNode.type];
  if (modelDriverFactory === undefined) {
    throw new Error(
      `No ModelDriver registered for '${modelNode.type}' on agent '${node.id}'.`,
    );
  }
  const modelDriver = modelDriverFactory(modelNode as never, {
    registry: ctx.registry,
    resolveEnv: (v) => ctx.resolveEnv(v),
    getRunner: (n) => ctx.getRunner(n),
  });
  const outerFrames: ContinuationFrame[] = rtEnv?.outerFrames ?? [];
  const loopFrame = outerFrames.find(
    (f): f is LoopContinuationFrame => f.kind === 'loop-frame',
  );
  const resumedAgentFrame =
    rtEnv?.existingAgentFrame ??
    ctx.resumeContinuationStack?.find(
      (f): f is AgentContinuationFrame => f.kind === 'agent-frame',
    );
  const recalledLessons = await recallAgentTurnLessons(node, validatedInput, {
    ctx,
    loopFrame,
    lessonStore: rtEnv?.lessonStore,
  });
  const accumulatedLessonOutcomes: Record<string, LessonOutcome> = {
    ...(resumedAgentFrame?.accumulatedLessonOutcomes ?? {}),
  };
  const initialLeases = Object.freeze([
    ...ctx.activeLeases,
    ...(resumedAgentFrame?.activeLeases ?? loopFrame?.grantedLoopLeases ?? []),
  ]);
  const isActPhase = loopFrame?.phase === 'act';
  const agentFrame: AgentContinuationFrame =
    resumedAgentFrame !== undefined
      ? Object.freeze<AgentContinuationFrame>({
          ...resumedAgentFrame,
          activeLeases: initialLeases,
        })
      : Object.freeze<AgentContinuationFrame>({
          kind: 'agent-frame',
          agentId: node.id,
          roleKey: node.roleKey,
          modelId: modelNode.modelId,
          stepExecId: ctx.stepExecId,
          inputJson: JSON.stringify(validatedInput),
          leafMessageId: null,
          turnsTaken: 0,
          costUsd: 0,
          elapsedDurationMs: 0,
          activeLeases: initialLeases,
          activeSkillIds: isActPhase ? loopFrame.activeSkillIds : Object.freeze([]),
          activeSkillActivations: isActPhase
            ? loopFrame.activeSkillActivations
            : Object.freeze({}),
          observedEffects: isActPhase ? loopFrame.observedEffects : Object.freeze([]),
          injectedScopedRuleIds: isActPhase
            ? loopFrame.injectedScopedRuleIds
            : Object.freeze([]),
          pausedAtPhase: 'TOOL_BOUNDARY',
          pauseState: Object.freeze({ kind: 'active-turn' }),
        });
  const serviceRegistry = rtEnv?.serviceRegistry ?? new ServiceSessionRegistry();
  const session: AgentTurnSessionState<TIn, TOut, THandle> = {
    node,
    validatedInput,
    ctx,
    agentFrame,
    outerFrames,
    skillsById,
    skillOwnerByToolName,
    serviceByToolName,
    actorGroundingTexts,
    actorInstructionTexts,
    scopedRules,
    toolsByName,
    modelNode,
    modelDriver,
    wirePrefix:
      node.prefixGroup !== undefined
        ? rtEnv?.wirePrefixesByGroupId?.get(node.prefixGroup.id)
        : undefined,
    ledgerStore: rtEnv?.ledgerStore,
    topologyStore: rtEnv?.topologyStore,
    lessonStore: rtEnv?.lessonStore,
    lockManager: rtEnv?.lockManager ?? new ScopeLockManager(),
    continuationQueue: rtEnv?.continuationQueue ?? new StepContinuationQueue(),
    poolManager,
    serviceRegistry,
    humanAdaptersById: rtEnv?.humanAdaptersById ?? new Map(),
    recalledLessons,
    accumulatedLessonOutcomes,
    laneId: rtEnv?.laneId,
    itemKey: rtEnv?.itemKey,
    baseScopeCheckpoint: rtEnv?.baseScopeCheckpoint,
    spawnedTasksCount: 0,
    executeChildStep:
      rtEnv?.executeChildStep ??
      ((cNode, cIn, cCtx) =>
        executeDefaultChildStep(cNode, cIn, { childCtx: cCtx, parent: session })),
  };
  return session;
}

/**
 * Initializes the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` wire frame and evaluates `ScopedRuleNode.when.partitions` (`SPEC.md` §3.2.1 & §3.4.1).
 *
 * No-ops when resuming an existing session that already has a non-null `leafMessageId`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 *
 * @returns {Promise<void>} Resolves once the Turn-0 context frame is appended.
 */
export async function initializeAgentContinuationFrame<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
): Promise<void> {
  if (session.agentFrame.leafMessageId !== null || session.agentFrame.turnsTaken > 0) {
    return;
  }
  const injectedIdSet = new Set<string>(session.agentFrame.injectedScopedRuleIds);
  const activePartitionSet = new Set<string>(session.ctx.activePartitions);
  const partitionDirectives: Array<{ readonly id: string; readonly directive: string }> = [];
  for (const rule of session.scopedRules) {
    if (injectedIdSet.has(rule.id)) {
      continue;
    }
    let matchesPartition = false;
    for (const part of rule.when.partitions ?? []) {
      if (activePartitionSet.has(part)) {
        matchesPartition = true;
      }
    }
    if (matchesPartition) {
      injectedIdSet.add(rule.id);
      const directiveText =
        typeof rule.directive === 'string'
          ? rule.directive
          : JSON.stringify(rule.directive);
      partitionDirectives.push(Object.freeze({ id: rule.id, directive: directiveText }));
    }
  }
  const skillCatalog: SkillCatalogEntryRecord[] = [];
  for (const skill of session.skillsById.values()) {
    let highlighted = false;
    for (const part of skill.when?.partitions ?? []) {
      if (activePartitionSet.has(part)) {
        highlighted = true;
      }
    }
    skillCatalog.push(
      Object.freeze<SkillCatalogEntryRecord>({
        skillId: skill.id,
        description: skill.description,
        highlighted,
      }),
    );
  }
  const topologyPartitions: TopologyPartitionState[] = [];
  if (session.topologyStore !== undefined) {
    const parts = await session.topologyStore.getPartitions(session.ctx.runId);
    for (const [pid, state] of parts.entries()) {
      if (activePartitionSet.has(pid)) {
        topologyPartitions.push(state);
      }
    }
  }
  const updatedGroundingDiffs =
    session.wirePrefix !== undefined && session.node.prefixGroup !== undefined
      ? await computeInRunGroundingDiffs({
          prefixGroup: session.node.prefixGroup,
          compiledPrefix: session.wirePrefix,
          scopeHandle: session.ctx.scopeHandle,
          registry: session.ctx.registry,
          resolutionContext: session.ctx,
        })
      : undefined;
  const roleContextText = buildRoleAndScopeContextFrame({
    agentId: session.node.id,
    roleKey: session.agentFrame.roleKey,
    activePartitions: session.ctx.activePartitions,
    actorGroundingTexts: session.actorGroundingTexts,
    actorInstructionTexts: session.actorInstructionTexts,
    skillCatalog,
    topologyPartitions,
    updatedGroundingDiffs,
    scopedRuleDirectives: partitionDirectives,
    recalledLessons: session.recalledLessons,
  });
  const userPrompt = `${roleContextText}\n\n[INPUT]\n${session.agentFrame.inputJson}`;
  const turn0MsgId = `msg:${session.ctx.stepExecId}:turn-0`;
  const seededLeafId =
    session.ctx.seededHistory?.[session.ctx.seededHistory.length - 1]?.messageId ?? null;
  if (session.ledgerStore !== undefined) {
    await session.ledgerStore.appendMessageFrame(
      session.ctx.runId,
      Object.freeze<WireFrameRecord>({
        messageId: turn0MsgId,
        parentMessageId: seededLeafId,
        vendorId: session.modelNode.vendor,
        rawWireFrame: new TextEncoder().encode(userPrompt),
        canonical: Object.freeze({ role: 'user', visibleText: userPrompt }),
        prefixDigest: session.wirePrefix?.systemDigest ?? 'unpinned',
      }),
    );
  }
  session.agentFrame = Object.freeze<AgentContinuationFrame>({
    ...session.agentFrame,
    leafMessageId: turn0MsgId,
    injectedScopedRuleIds: Object.freeze(Array.from(injectedIdSet)),
  });
}

/**
 * Projects final or suspended agent continuation state into `_runtime.childOutcomeSink` and quiesces step-scoped services (`SPEC.md` §3.4.2 & §3.7.2).
 *
 * Invoked in `executeAgent`'s `finally` block so enclosing `H.loop`, `.fork()`, and `.speculate()` handlers
 * receive the latest `agentFrame`, `leafMessageId`, `accumulatedLessonOutcomes`, and `suspendedAtCallId`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {StepExecutionContext<THandle>}             ctx     - Active step execution context.
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 *
 * @returns {Promise<void>} Resolves once outcome sink projection and service quiescing complete.
 */
export async function finalizeAgentTurnSession<TIn, TOut, THandle>(
  ctx: StepExecutionContext<THandle>,
  session: AgentTurnSessionState<TIn, TOut, THandle>,
): Promise<void> {
  const sink = (
    ctx as StepExecutionContext<THandle> & {
      readonly _runtime?: {
        readonly childOutcomeSink?: {
          continuationStack?: readonly ContinuationFrame[];
          leafMessageId?: string | null;
          accumulatedLessonOutcomes?: Readonly<Record<string, LessonOutcome>>;
          suspendedAtCallId?: string;
        };
      };
    }
  )._runtime?.childOutcomeSink;
  if (sink !== undefined) {
    sink.continuationStack = Object.freeze([session.agentFrame]);
    sink.leafMessageId = session.agentFrame.leafMessageId;
    sink.accumulatedLessonOutcomes = Object.freeze({
      ...session.accumulatedLessonOutcomes,
    });
    if (session.agentFrame.pauseState.kind === 'tool-batch') {
      const pendingBatch = session.agentFrame.pauseState.pendingToolBatch;
      sink.suspendedAtCallId =
        pendingBatch.activeInterruptCallId ?? pendingBatch.remainingCalls[0]?.callId;
    }
  }
  await session.serviceRegistry.quiesceScopeServices(ctx.stepExecId);
}
