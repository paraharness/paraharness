import type { AgentNode } from '../../../ast/agent-node.js';
import type { ToolASTNode } from '../../../ast/domain-ast.types.js';
import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { BranchableScope } from '../../../ports/branchable-scope.js';
import type { CheckpointableScope } from '../../../ports/checkpointable-scope.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { PendingToolBatch, RemainingToolCallRecord } from '../../../ports/pending-tool-batch.js';
import type { RuntimeDriverContext } from '../../../ports/runtime-driver-context.js';
import type { ToolEffect } from '../../../ports/tool-effect.js';
import { executeResumeForkBatch } from '../../fork/execute-fork-batch.js';
import {
  executeAddDependencies,
  executeSpawnTasks,
  executeUpdatePartitionContract,
} from '../../plan/execute-plan-mutation.js';
import type { SpawnTaskInputEntry } from '../../plan/plan-mutation-params.js';
import { evaluatePreFlightToolBatch } from '../../policy/evaluate-policy-guards.js';
import { executePostFlightSandboxedTool } from '../../policy/internal/execute-post-flight-sandboxed-tool.js';
import { executeSpeculateTournament } from '../../speculate/execute-speculate-tournament.js';
import type { AgentTurnSessionState } from '../agent-turn-session-state.js';
import type { InterruptEdgeResolution } from '../interrupt-edge-resolution.js';
import { resolveInterruptEdge } from './resolve-interrupt-edge.js';

/**
 * Evaluates reactive `ScopedRuleNode.when.effects` predicates against a tool call's effects and appends newly triggered directives (`SPEC.md` §3.4.1).
 *
 * Records newly matched rule IDs in `session.agentFrame.injectedScopedRuleIds` so each scoped rule is injected at most once.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 * @param {readonly ToolEffect[]}                     effects - Observed effects from the current tool call.
 * @param {string}                                    content - Serialized tool result text before rule injection.
 *
 * @returns {Promise<string>} Tool result text with any newly triggered scoped rule directives appended.
 */
export async function applyReactiveScopedRulesAndRecordEffects<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  effects: readonly ToolEffect[],
  content: string,
): Promise<string> {
  if (effects.length === 0) {
    return content;
  }
  const injectedSet = new Set(session.agentFrame.injectedScopedRuleIds);
  const appendedDirectives: string[] = [];
  for (const rule of session.scopedRules) {
    if (injectedSet.has(rule.id)) {
      continue;
    }
    const matcher = rule.when.effects;
    const matcherExec =
      matcher !== undefined ? session.ctx.registry.effectMatchers[matcher.type] : undefined;
    if (matcherExec === undefined || matcher === undefined) {
      continue;
    }
    let matched = false;
    for (const eff of effects) {
      if (await matcherExec(matcher as never, eff, session.ctx as never)) {
        matched = true;
        break;
      }
    }
    if (matched) {
      injectedSet.add(rule.id);
      const directiveText =
        typeof rule.directive === 'string'
          ? rule.directive
          : JSON.stringify(rule.directive);
      appendedDirectives.push(`[SCOPED_RULE: ${rule.id}]\n${directiveText}`);
    }
  }
  const injectedIds = Array.from(injectedSet);
  const mergedEffects = Object.freeze([...session.agentFrame.observedEffects, ...effects]);
  session.agentFrame = Object.freeze<AgentContinuationFrame>({
    ...session.agentFrame,
    observedEffects: mergedEffects,
    injectedScopedRuleIds: Object.freeze(injectedIds),
  });
  for (let idx = 0; idx < session.outerFrames.length; idx += 1) {
    const outer = session.outerFrames[idx];
    if (outer?.kind === 'loop-frame' && outer.phase === 'act') {
      session.outerFrames[idx] = Object.freeze<LoopContinuationFrame>({
        ...outer,
        observedEffects: Object.freeze([...outer.observedEffects, ...effects]),
        injectedScopedRuleIds: Object.freeze([
          ...new Set([...outer.injectedScopedRuleIds, ...injectedIds]),
        ]),
      });
    }
  }
  return appendedDirectives.length > 0
    ? `${content}\n${appendedDirectives.join('\n')}`
    : content;
}

/**
 * Handles built-in `activateSkill` and `completeSkill` lifecycle tool calls (`SPEC.md` §3.4.2).
 *
 * Acquires or releases reference-counted `ServiceSession` daemons and records compaction tombstones on `completeSkill`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 * @param {RemainingToolCallRecord}                   call    - Tool call record being dispatched.
 * @param {RuntimeDriverContext}                      drvCtx  - Runtime driver context.
 *
 * @returns {Promise<{ readonly status: 'completed'; readonly content: string; readonly isError: boolean } | undefined>} Skill tool outcome, or `undefined`.
 */
export async function handleSkillLifecycleToolCall<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  call: RemainingToolCallRecord,
  drvCtx: RuntimeDriverContext,
): Promise<
  | { readonly status: 'completed'; readonly content: string; readonly isError: boolean }
  | undefined
> {
  const args = JSON.parse(call.argsJson || '{}') as Record<string, unknown>;
  const skillId = String(args['skillId'] ?? args['id'] ?? '');
  if (call.toolName === 'activateSkill') {
    const skill = session.skillsById.get(skillId);
    if (skill === undefined) {
      return Object.freeze({
        status: 'completed',
        content: `Unknown skill '${skillId}'.`,
        isError: true,
      });
    }
    await session.serviceRegistry.acquireSkillServices({
      runId: session.ctx.runId,
      scopeKey: session.ctx.stepExecId,
      scopeHandle: session.ctx.scopeHandle,
      skill,
      driverContext: drvCtx,
    });
    const activeIds = new Set(session.agentFrame.activeSkillIds).has(skillId)
      ? session.agentFrame.activeSkillIds
      : Object.freeze([...session.agentFrame.activeSkillIds, skillId]);
    const activations = Object.freeze({
      ...session.agentFrame.activeSkillActivations,
      [skillId]: Object.freeze({
        messageId: session.agentFrame.leafMessageId ?? 'turn-0',
        callId: call.callId,
      }),
    });
    session.agentFrame = Object.freeze<AgentContinuationFrame>({
      ...session.agentFrame,
      activeSkillIds: activeIds,
      activeSkillActivations: activations,
    });
    for (let idx = 0; idx < session.outerFrames.length; idx += 1) {
      const outer = session.outerFrames[idx];
      if (outer?.kind === 'loop-frame' && outer.phase === 'act') {
        session.outerFrames[idx] = Object.freeze<LoopContinuationFrame>({
          ...outer,
          activeSkillIds: activeIds,
          activeSkillActivations: activations,
        });
      }
    }
    const instrText =
      typeof skill.instructions === 'string'
        ? skill.instructions
        : JSON.stringify(skill.instructions);
    return Object.freeze({
      status: 'completed',
      content: `[SKILL_ACTIVATED: ${skillId}]\n${instrText}`,
      isError: false,
    });
  }
  if (call.toolName === 'completeSkill') {
    const summary = String(args['summary'] ?? '');
    const actCoord = session.agentFrame.activeSkillActivations[skillId];
    await session.serviceRegistry.releaseSkillServices(session.ctx.stepExecId, skillId);
    if (actCoord !== undefined && session.ledgerStore !== undefined) {
      await session.ledgerStore.markFrameTombstone(
        session.ctx.runId,
        actCoord.messageId,
        actCoord.callId,
        summary,
      );
    }
    const nextActs: Record<string, { readonly messageId: string; readonly callId: string }> =
      {};
    const nextActiveList: string[] = [];
    for (const id of session.agentFrame.activeSkillIds) {
      if (id === skillId) {
        continue;
      }
      nextActiveList.push(id);
      const act = session.agentFrame.activeSkillActivations[id];
      if (act !== undefined) {
        nextActs[id] = act;
      }
    }
    const nextActiveIds = Object.freeze(nextActiveList);
    const frozenActs = Object.freeze(nextActs);
    session.agentFrame = Object.freeze<AgentContinuationFrame>({
      ...session.agentFrame,
      activeSkillIds: nextActiveIds,
      activeSkillActivations: frozenActs,
    });
    for (let idx = 0; idx < session.outerFrames.length; idx += 1) {
      const outer = session.outerFrames[idx];
      if (outer?.kind === 'loop-frame' && outer.phase === 'act') {
        session.outerFrames[idx] = Object.freeze<LoopContinuationFrame>({
          ...outer,
          activeSkillIds: nextActiveIds,
          activeSkillActivations: frozenActs,
        });
      }
    }
    return Object.freeze({
      status: 'completed',
      content: `[SKILL_COMPLETED: ${skillId}] ${summary}`,
      isError: false,
    });
  }
  return undefined;
}

/**
 * Handles built-in skill (`activateSkill`, `completeSkill`) and capability (`resumeFork`, `speculate`, `spawnTasks`, `addDependencies`, `updatePartitionContract`, `escalate`, and `.canRaise()`) tools (`SPEC.md` §3.4.2 & §3.7.2).
 *
 * Returns `undefined` when `call.toolName` is not a built-in skill, capability, or voluntary interrupt tool.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 * @param {RemainingToolCallRecord}                   call    - Tool call record being dispatched.
 * @param {PendingToolBatch}                          batch   - Current `PendingToolBatch` state.
 *
 * @returns {Promise<{ readonly status: 'completed' | 'suspended' | 'interrupted'; readonly content: string; readonly isError: boolean; readonly interruptResolution?: InterruptEdgeResolution<THandle> } | undefined>} Capability execution outcome, or `undefined`.
 */
export async function handleBuiltInSkillAndCapabilityTools<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  call: RemainingToolCallRecord,
  batch: PendingToolBatch,
): Promise<
  | {
      readonly status: 'completed' | 'suspended' | 'interrupted';
      readonly content: string;
      readonly isError: boolean;
      readonly interruptResolution?: InterruptEdgeResolution<THandle>;
    }
  | undefined
> {
  const drvCtx: RuntimeDriverContext = {
    registry: session.ctx.registry,
    resolveEnv: (v) => session.ctx.resolveEnv(v),
    getRunner: (n) => session.ctx.getRunner(n),
  };
  const skillOut = await handleSkillLifecycleToolCall(session, call, drvCtx);
  if (skillOut !== undefined) {
    return skillOut;
  }
  const args = JSON.parse(call.argsJson || '{}') as Record<string, unknown>;
  const rtScope = (session.ctx as { readonly _runtime?: { readonly branchableScope?: unknown } })
    ._runtime?.branchableScope;
  const scopeFactory =
    session.ctx.scopeNode !== undefined
      ? session.ctx.registry.scopes[session.ctx.scopeNode.type]
      : undefined;
  const scopeDriver = (session.ctx.scope ??
    rtScope ??
    (scopeFactory !== undefined && session.ctx.scopeNode !== undefined
      ? scopeFactory(session.ctx.scopeNode as never, drvCtx)
      : undefined)) as BranchableScope<THandle, Record<string, unknown>, Record<string, unknown>>;
  if (call.toolName === 'resumeFork') {
    const fRes = await executeResumeForkBatch({
      parentNode: session.node as AgentNode<unknown, unknown, THandle>,
      parentInput: session.validatedInput,
      parentLeafMessageId: session.agentFrame.leafMessageId,
      outerFrames: [...session.outerFrames, session.agentFrame],
      resumeRequest: {
        callId: call.callId,
        suspendedForkIds: (args['suspendedForkIds'] as readonly string[] | undefined) ?? [],
        action: (args['action'] as 'resume' | 'abort' | undefined) ?? 'resume',
        resolutionSummary: String(args['resolutionSummary'] ?? ''),
      },
      branchableScope: scopeDriver,
      lockManager: session.lockManager,
      continuationQueue: session.continuationQueue,
      ledgerStore: session.ledgerStore as NonNullable<typeof session.ledgerStore>,
      lessonStore: session.lessonStore,
      poolManager: session.poolManager,
      modelDriver: session.modelDriver,
      wirePrefix: session.wirePrefix,
      humanAdaptersById: session.humanAdaptersById,
      ctx: session.ctx,
      executeChildStep: session.executeChildStep,
    });
    if (fRes.batchFrame.forks.some((f) => f.conflictCheckArmed)) {
      session.agentFrame = Object.freeze<AgentContinuationFrame>({
        ...session.agentFrame,
        conflictCheckArmed: true,
      });
    }
    const outEntry = fRes.toolResultsByCallId.get(call.callId);
    return Object.freeze({
      status: 'completed',
      content: outEntry?.content ?? JSON.stringify(fRes.batchFrame),
      isError: outEntry?.isError ?? false,
    });
  }
  const specCap = session.node.capabilities?.speculations.find(
    (s) => s.toolName === call.toolName,
  );
  if (specCap !== undefined) {
    const sRes = await executeSpeculateTournament({
      parentNode: session.node as AgentNode<unknown, unknown, THandle>,
      parentInput: session.validatedInput,
      callId: call.callId,
      capability: specCap as never,
      argsJson: call.argsJson,
      outerFrames: [...session.outerFrames, session.agentFrame],
      branchableScope: scopeDriver,
      lockManager: session.lockManager,
      continuationQueue: session.continuationQueue,
      ledgerStore: session.ledgerStore as NonNullable<typeof session.ledgerStore>,
      lessonStore: session.lessonStore,
      modelDriver: session.modelDriver,
      wirePrefix: session.wirePrefix,
      humanAdaptersById: session.humanAdaptersById,
      ctx: session.ctx,
      executeChildStep: session.executeChildStep,
    });
    if (sRes.tournamentFrame.conflictCheckArmed) {
      session.agentFrame = Object.freeze<AgentContinuationFrame>({
        ...session.agentFrame,
        conflictCheckArmed: true,
      });
    }
    return Object.freeze({
      status: 'completed',
      content: sRes.toolResultText,
      isError: sRes.isError,
    });
  }
  if (
    (call.toolName === 'spawnTasks' ||
      call.toolName === 'addDependencies' ||
      call.toolName === 'updatePartitionContract') &&
    session.node.capabilities?.mutatePlan !== undefined
  ) {
    const pParams = {
      mutatePlanNode: session.node.capabilities.mutatePlan,
      laneId: session.laneId ?? 'default-lane',
      parentItemKey: session.itemKey ?? session.ctx.runId,
      previouslySpawnedCount: session.spawnedTasksCount,
      previousSpawnedTipKey: session.previousSpawnedTipKey,
      tasksToSpawn: (args['tasks'] as readonly SpawnTaskInputEntry[] | undefined) ?? [],
      dependencyKeysToAdd:
        (args['prerequisiteItemKeys'] as readonly string[] | undefined) ??
        (args['dependsOn'] as readonly string[] | undefined) ??
        [],
      contractUpdate:
        (args['partition'] ?? args['partitionId']) !== undefined
          ? {
              partitionId: String(args['partition'] ?? args['partitionId']),
              newContractText: String(
                args['updatedContractText'] ?? args['newContractText'] ?? '',
              ),
            }
          : undefined,
      agentFrame: session.agentFrame,
      outerFrames: session.outerFrames,
      pendingToolBatch: batch,
      ledgerStore: session.ledgerStore as NonNullable<typeof session.ledgerStore>,
      continuationQueue: session.continuationQueue,
      topologyStore: session.topologyStore,
      serviceRegistry: session.serviceRegistry,
      checkpointScope: scopeDriver,
      ctx: session.ctx,
    };
    const r =
      call.toolName === 'spawnTasks'
        ? await executeSpawnTasks(pParams)
        : call.toolName === 'addDependencies'
          ? await executeAddDependencies(pParams)
          : undefined;
    if (r !== undefined) {
      if (call.toolName === 'spawnTasks') {
        session.spawnedTasksCount += r.prerequisiteItemKeys.length;
        session.previousSpawnedTipKey = r.latestTipItemKey;
      }
      return Object.freeze({
        status: r.suspended ? 'suspended' : 'completed',
        content: r.toolResultText,
        isError: false,
      });
    }
    return Object.freeze({
      status: 'completed',
      content: JSON.stringify(await executeUpdatePartitionContract(pParams)),
      isError: false,
    });
  }
  const escCap = session.node.capabilities?.escalations.find(
    (e) => e.interrupt.id === call.toolName,
  );
  const canRaiseIntr = session.node.canRaiseInterrupts.find((i) => i.id === call.toolName);
  if (escCap !== undefined || canRaiseIntr !== undefined || call.toolName === 'escalate') {
    const intrId =
      escCap?.interrupt.id ??
      canRaiseIntr?.id ??
      String(args['interruptId'] ?? 'harness:escalate');
    const res = await resolveInterruptEdge(session, intrId, args['payload'] ?? args);
    return res.status === 'resumed'
      ? Object.freeze({
          status: 'completed',
          content: res.feedback ?? 'Resumed',
          isError: false,
        })
      : Object.freeze({
          status: 'interrupted',
          content: `[Interrupted: ${intrId}]`,
          isError: true,
          interruptResolution: res,
        });
  }
  return undefined;
}

/**
 * Executes a `'declared'` effect-tracking tool under a shared read or exclusive write scope lock and applies reactive scoped rules (`SPEC.md` §3.4.1 & §3.7.2).
 *
 * Acquires an exclusive write lock when any predicted effect has `mutatesScope === true`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session     - Active agent turn session state.
 * @param {RemainingToolCallRecord}                   call        - Tool call record to execute.
 * @param {object}                                    execution   - Tool node, tool driver, and validated arguments.
 *
 * @returns {Promise<{ readonly status: 'completed'; readonly content: string; readonly isError: boolean; readonly newEffects: readonly ToolEffect[] }>} Declared-effect tool outcome.
 */
async function executeDeclaredEffectToolCall<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  call: RemainingToolCallRecord,
  execution: {
    readonly toolNode: ToolASTNode<THandle>;
    readonly toolDriver: NonNullable<
      (typeof session.ctx.registry.tools)[ToolASTNode<THandle>['type']]
    >;
    readonly validatedArgs: unknown;
  },
): Promise<{
  readonly status: 'completed';
  readonly content: string;
  readonly isError: boolean;
  readonly newEffects: readonly ToolEffect[];
}> {
  const preEval = await evaluatePreFlightToolBatch({
    policy: undefined,
    remainingCalls: [call],
    toolsByName: session.toolsByName,
    activeLeases: session.agentFrame.activeLeases,
    ctx: session.ctx,
  });
  const mutates = preEval.primaryEffects.some((e) => e.mutatesScope === true);
  const runTool = (): Promise<unknown> =>
    Promise.resolve(
      execution.toolDriver.execute(
        execution.toolNode as never,
        execution.validatedArgs as never,
        session.ctx as never,
      ),
    );
  const rawOut = mutates
    ? await session.lockManager.withWriteLock(session.ctx.scopeHandle, runTool)
    : await session.lockManager.withReadLock(session.ctx.scopeHandle, runTool);
  const outStr =
    typeof rawOut === 'string'
      ? rawOut
      : typeof (rawOut as { readonly content?: unknown })?.content === 'string'
        ? (rawOut as { readonly content: string }).content
        : JSON.stringify(rawOut);
  const contentWithRules = await applyReactiveScopedRulesAndRecordEffects(
    session,
    preEval.primaryEffects,
    outStr,
  );
  return Object.freeze({
    status: 'completed',
    content: contentWithRules,
    isError: Boolean((rawOut as { readonly isError?: boolean })?.isError),
    newEffects: preEval.primaryEffects,
  });
}

/**
 * Executes a single tool call through the pre-flight skill lease gate, service session or tool driver, post-flight sandbox, and reactive scoped rules (`SPEC.md` §3.4.1–§3.5).
 *
 * Returns the tool result text, error flag, observed new effects, and any interrupt resolution.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 * @param {RemainingToolCallRecord}                   call    - Tool call record to execute.
 * @param {PendingToolBatch}                          batch   - Enclosing `PendingToolBatch` state.
 *
 * @returns {Promise<{ readonly status: 'completed' | 'suspended' | 'interrupted'; readonly content: string; readonly isError: boolean; readonly newEffects?: readonly ToolEffect[]; readonly interruptResolution?: InterruptEdgeResolution<THandle> }>} Tool call execution outcome.
 */
export async function dispatchSingleToolCall<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  call: RemainingToolCallRecord,
  batch: PendingToolBatch,
): Promise<{
  readonly status: 'completed' | 'suspended' | 'interrupted';
  readonly content: string;
  readonly isError: boolean;
  readonly newEffects?: readonly ToolEffect[];
  readonly interruptResolution?: InterruptEdgeResolution<THandle>;
}> {
  const builtIn = await handleBuiltInSkillAndCapabilityTools(session, call, batch);
  if (builtIn !== undefined) {
    return builtIn;
  }
  const requiredSkillId = session.skillOwnerByToolName.get(call.toolName);
  if (
    requiredSkillId !== undefined &&
    !new Set(session.agentFrame.activeSkillIds).has(requiredSkillId)
  ) {
    return Object.freeze({
      status: 'completed',
      content: `Tool '${call.toolName}' requires active skill '${requiredSkillId}' via activateSkill.`,
      isError: true,
    });
  }
  const serviceId = session.serviceByToolName?.get(call.toolName);
  if (serviceId !== undefined) {
    const svcSession = session.serviceRegistry
      .getActiveSessionsForScope(session.ctx.stepExecId)
      .get(serviceId);
    if (svcSession === undefined) {
      return Object.freeze({
        status: 'completed',
        content: `Service '${serviceId}' for tool '${call.toolName}' is not active.`,
        isError: true,
      });
    }
    const svcRes = await svcSession.invokeTool(
      call.toolName,
      JSON.parse(call.argsJson || '{}'),
      session.ctx,
    );
    return Object.freeze({
      status: 'completed',
      content: svcRes.content,
      isError: Boolean(svcRes.isError),
    });
  }
  const toolNode = session.toolsByName.get(call.toolName) as ToolASTNode<THandle> | undefined;
  const toolDriver =
    toolNode !== undefined ? session.ctx.registry.tools[toolNode.type] : undefined;
  if (toolNode === undefined || toolDriver === undefined) {
    return Object.freeze({
      status: 'completed',
      content: `Unregistered tool '${call.toolName}' on agent '${session.node.id}'.`,
      isError: true,
    });
  }
  const validatedArgs = toolNode.inputSchema.parse(JSON.parse(call.argsJson || '{}'));
  if (toolNode.effectTracking === 'declared') {
    return executeDeclaredEffectToolCall(session, call, {
      toolNode,
      toolDriver,
      validatedArgs,
    });
  }
  const scopeFactory =
    session.ctx.scopeNode !== undefined
      ? session.ctx.registry.scopes[session.ctx.scopeNode.type]
      : undefined;
  const scopeDriver = (session.ctx.scope ??
    (scopeFactory !== undefined && session.ctx.scopeNode !== undefined
      ? scopeFactory(session.ctx.scopeNode as never, {
          registry: session.ctx.registry,
          resolveEnv: (v) => session.ctx.resolveEnv(v),
          getRunner: (n) => session.ctx.getRunner(n),
        })
      : undefined)) as CheckpointableScope<THandle> | undefined;
  if (scopeDriver !== undefined) {
    const persistBatch = async (
      nextBatch: PendingToolBatch,
      ckpt?: string,
    ): Promise<void> => {
      session.agentFrame = Object.freeze<AgentContinuationFrame>({
        ...session.agentFrame,
        pauseState: Object.freeze({
          kind: 'tool-batch',
          pendingToolBatch: nextBatch,
          inFlightPreToolCheckpoint: ckpt,
        }),
      });
      if (session.ledgerStore !== undefined) {
        const ledgerStore = session.ledgerStore;
        await session.continuationQueue.enqueueUpdate(session.ctx.stepExecId, () =>
          ledgerStore.updateContinuationStack(
            session.ctx.runId,
            session.ctx.stepExecId,
            Object.freeze<readonly ContinuationFrame[]>([
              ...session.outerFrames,
              session.agentFrame,
            ]),
          ),
        );
      }
    };
    const sbOut = await session.lockManager.withWriteLock(session.ctx.scopeHandle, () =>
      executePostFlightSandboxedTool({
        toolNode,
        toolDriver: toolDriver as never,
        parsedArgs: validatedArgs,
        callRecord: call,
        policy: session.node.policy,
        activeLeases: session.agentFrame.activeLeases,
        checkpointScope: scopeDriver,
        ctx: session.ctx,
        persistInFlightCheckpoint: (ckpt) => persistBatch(batch, ckpt),
      }),
    );
    if (
      sbOut.status === 'rolled-back-interrupt' &&
      sbOut.policyResult?.raisedInterrupt !== undefined
    ) {
      await persistBatch(
        Object.freeze({
          ...batch,
          completedResults: Object.freeze([
            ...batch.completedResults,
            Object.freeze({
              callId: call.callId,
              content: sbOut.toolResult.content,
              isError: true,
            }),
          ]),
          remainingCalls: Object.freeze(batch.remainingCalls.slice(1)),
          activeInterruptCallId: call.callId,
        }),
      );
      const intrRes = await resolveInterruptEdge(
        session,
        sbOut.policyResult.raisedInterrupt.id,
        sbOut.policyResult.interruptPayload,
      );
      return intrRes.status !== 'resumed'
        ? Object.freeze({
            status: 'interrupted',
            content: sbOut.toolResult.content,
            isError: true,
            interruptResolution: intrRes,
          })
        : Object.freeze({
            status: 'completed',
            content: `${sbOut.toolResult.content}\n[Adjudication: ${intrRes.feedback ?? ''}]`,
            isError: true,
          });
    }
    if (sbOut.status !== 'allowed') {
      return Object.freeze({
        status: 'completed',
        content: sbOut.toolResult.content,
        isError: true,
      });
    }
    const contentWithRules = await applyReactiveScopedRulesAndRecordEffects(
      session,
      sbOut.synthesizedEffects,
      sbOut.toolResult.content,
    );
    return Object.freeze({
      status: 'completed',
      content: contentWithRules,
      isError: Boolean(sbOut.toolResult.isError),
      newEffects: sbOut.synthesizedEffects,
    });
  }
  const rawOut = await session.lockManager.withWriteLock(session.ctx.scopeHandle, () =>
    Promise.resolve(
      toolDriver.execute(toolNode as never, validatedArgs as never, session.ctx as never),
    ),
  );
  return Object.freeze({
    status: 'completed',
    content: typeof rawOut === 'string' ? rawOut : JSON.stringify(rawOut),
    isError: false,
  });
}
