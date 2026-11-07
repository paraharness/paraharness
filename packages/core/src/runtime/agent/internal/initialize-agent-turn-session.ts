import type { AgentNode } from '../../../ast/agent-node.js';
import type { ModelASTNode } from '../../../ast/domain-ast.types.js';
import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { LessonOutcome } from '../../../ports/lesson-outcome.types.js';
import type { LessonStore } from '../../../ports/lesson-store.js';
import type {
  LoopContinuationFrame,
  RecalledLoopLessonRecord,
} from '../../../ports/loop-continuation-frame.js';
import type { ModelDriver } from '../../../ports/model-driver.js';
import type { StepExecutionContext } from '../../../ports/step-execution-context.js';
import type { TopologyPartitionState } from '../../../ports/topology-partition-state.js';
import type { WireFrameRecord } from '../../../ports/wire-frame-record.js';
import { selectRecalledLessons } from '../../lessons/lesson-scoring.js';
import { ScopeLockManager } from '../../locks/scope-lock-manager.js';
import { StepContinuationQueue } from '../../locks/step-continuation-queue.js';
import { PoolManager } from '../../pools/pool-manager.js';
import { buildRoleAndScopeContextFrame } from '../../prefix/internal/build-role-and-scope-context-frame.js';
import { computeInRunGroundingDiffs } from '../../prefix/internal/compute-in-run-grounding-diffs.js';
import type { SkillCatalogEntryRecord } from '../../prefix/skill-catalog-entry-record.js';
import { ServiceSessionRegistry } from '../../services/service-session-registry.js';
import type { AgentTurnSessionState } from '../agent-turn-session-state.js';
import { executeDefaultChildStep } from './execute-default-child-step.js';
import { getStepRuntimeInternals } from './get-step-runtime-internals.js';
import {
  resolveAgentScopedRulesAndDirectives,
  resolveAgentSkillsAndTools,
} from './resolve-agent-session-inputs.js';

/**
 * Context parameters for `recallAgentTurnLessons`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface RecallAgentTurnLessonsContextParams<THandle = unknown> {
  /** Active step execution context. */
  readonly ctx: StepExecutionContext<THandle>;
  /** Optional enclosing `LoopContinuationFrame`. */
  readonly loopFrame: LoopContinuationFrame | undefined;
  /** Optional empirical `LessonStore`. */
  readonly lessonStore: LessonStore | undefined;
}

/**
 * Parameters for `buildInitialOrResumedAgentFrame`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface BuildInitialOrResumedAgentFrameParams<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
> {
  /** Passive `AgentNode` AST definition. */
  readonly node: AgentNode<TIn, TOut, THandle>;
  /** Schema-validated agent input payload. */
  readonly validatedInput: TIn;
  /** Active step execution context. */
  readonly ctx: StepExecutionContext<THandle>;
  /** Selected `ModelASTNode` for the session. */
  readonly modelNode: ModelASTNode;
  /** Optional enclosing `LoopContinuationFrame`. */
  readonly loopFrame: LoopContinuationFrame | undefined;
  /** Optional resumed `AgentContinuationFrame`. */
  readonly resumedAgentFrame: AgentContinuationFrame | undefined;
}

/**
 * Recalls Turn-0 empirical lessons for an `AgentNode` when not already provided by an enclosing `LoopContinuationFrame` (`SPEC.md` §3.4.3).
 *
 * Queries `lessonStore.queryCandidates` and ranks candidates via `selectRecalledLessons`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentNode<TIn, TOut, THandle>}                node           - Passive `AgentNode` AST definition.
 * @param {TIn}                                          validatedInput - Schema-validated agent input payload.
 * @param {RecallAgentTurnLessonsContextParams<THandle>} recallContext  - Active step context, enclosing loop frame, and optional lesson store.
 *
 * @returns {Promise<readonly RecalledLoopLessonRecord[]>} Frozen recalled lesson records.
 */
async function recallAgentTurnLessons<TIn, TOut, THandle>(
  node: AgentNode<TIn, TOut, THandle>,
  validatedInput: TIn,
  recallContext: RecallAgentTurnLessonsContextParams<THandle>,
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
 * Selects the active `ModelASTNode` (via override or `PoolManager.selectModel`) and instantiates its registered `ModelDriver`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentNode<TIn, TOut, THandle>} node        - Passive `AgentNode` AST definition.
 * @param {StepExecutionContext<THandle>} ctx         - Active step execution context.
 * @param {PoolManager}                   poolManager - Capacity pool manager.
 *
 * @returns {{ readonly modelNode: ModelASTNode; readonly modelDriver: ModelDriver }} Selected model node and driver instance.
 */
function selectAgentModelDriver<TIn, TOut, THandle>(
  node: AgentNode<TIn, TOut, THandle>,
  ctx: StepExecutionContext<THandle>,
  poolManager: PoolManager,
): { readonly modelNode: ModelASTNode; readonly modelDriver: ModelDriver } {
  const rtEnv = getStepRuntimeInternals(ctx);
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
  return { modelNode, modelDriver };
}

/**
 * Constructs a fresh `AgentContinuationFrame` or merges initial leases onto a resumed `AgentContinuationFrame`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {BuildInitialOrResumedAgentFrameParams<TIn, TOut, THandle>} params - Frame construction parameters.
 *
 * @returns {AgentContinuationFrame} Initial or resumed `AgentContinuationFrame`.
 */
function buildInitialOrResumedAgentFrame<TIn, TOut, THandle>(
  params: BuildInitialOrResumedAgentFrameParams<TIn, TOut, THandle>,
): AgentContinuationFrame {
  const { node, validatedInput, ctx, modelNode, loopFrame, resumedAgentFrame } = params;
  const initialLeases = Object.freeze([
    ...ctx.activeLeases,
    ...(resumedAgentFrame?.activeLeases ?? loopFrame?.grantedLoopLeases ?? []),
  ]);
  if (resumedAgentFrame !== undefined) {
    return Object.freeze<AgentContinuationFrame>({
      ...resumedAgentFrame,
      activeLeases: initialLeases,
    });
  }
  const isActPhase = loopFrame?.phase === 'act';
  return Object.freeze<AgentContinuationFrame>({
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
    activeSkillActivations: isActPhase ? loopFrame.activeSkillActivations : Object.freeze({}),
    observedEffects: isActPhase ? loopFrame.observedEffects : Object.freeze([]),
    injectedScopedRuleIds: isActPhase ? loopFrame.injectedScopedRuleIds : Object.freeze([]),
    pausedAtPhase: 'TOOL_BOUNDARY',
    pauseState: Object.freeze({ kind: 'active-turn' }),
  });
}

/**
 * Initializes the `AgentTurnSessionState` and `AgentContinuationFrame` for an `AgentNode` execution (`SPEC.md` §3.7.1).
 *
 * Pre-indexes tools, skills, capabilities, and scoped rules once (`Rule 4.2`), resolves the model driver, recalls
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
  const rtEnv = getStepRuntimeInternals(ctx);
  const resolvedSkillsAndTools = await resolveAgentSkillsAndTools(node, ctx);
  const { scopedRules, actorGroundingTexts, actorInstructionTexts } =
    await resolveAgentScopedRulesAndDirectives(node, ctx);
  const poolManager = rtEnv?.poolManager ?? new PoolManager();
  const { modelNode, modelDriver } = selectAgentModelDriver(node, ctx, poolManager);
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
  const agentFrame = buildInitialOrResumedAgentFrame({
    node,
    validatedInput,
    ctx,
    modelNode,
    loopFrame,
    resumedAgentFrame,
  });
  const session: AgentTurnSessionState<TIn, TOut, THandle> = {
    node,
    validatedInput,
    ctx,
    agentFrame,
    outerFrames,
    skillsById: resolvedSkillsAndTools.skillsById,
    skillOwnerByToolName: resolvedSkillsAndTools.skillOwnerByToolName,
    serviceByToolName: resolvedSkillsAndTools.serviceByToolName,
    actorGroundingTexts,
    actorInstructionTexts,
    scopedRules,
    toolsByName: resolvedSkillsAndTools.toolsByName,
    forksByToolName: resolvedSkillsAndTools.forksByToolName,
    speculationsByToolName: resolvedSkillsAndTools.speculationsByToolName,
    escalationsByInterruptId: resolvedSkillsAndTools.escalationsByInterruptId,
    canRaiseInterruptsById: resolvedSkillsAndTools.canRaiseInterruptsById,
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
    serviceRegistry: rtEnv?.serviceRegistry ?? new ServiceSessionRegistry(),
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
