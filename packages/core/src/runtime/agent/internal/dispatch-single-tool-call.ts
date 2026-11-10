import type { ToolASTNode } from '../../../ast/domain-ast.types.js';
import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { LoopContinuationFrame } from '../../../ports/loop-continuation-frame.js';
import type { PendingToolBatch, RemainingToolCallRecord } from '../../../ports/pending-tool-batch.js';
import type { ToolEffect } from '../../../ports/tool-effect.js';
import type { PolicyEvaluationResult } from '../../policy/policy-evaluation-result.js';
import { evaluatePreFlightToolBatch } from '../../policy/evaluate-policy-guards.js';
import type { AgentTurnSessionState } from '../agent-turn-session-state.js';
import type { InterruptEdgeResolution } from '../interrupt-edge-resolution.js';
import { executePostFlightSandboxedToolCall } from './execute-post-flight-sandboxed-tool-call.js';
import { handleBuiltInSkillAndCapabilityTools } from './handle-built-in-skill-and-capability-tools.js';

/**
 * Execution parameters for `executeDeclaredEffectToolCall`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface ExecuteDeclaredEffectToolCallExecutionParams<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
> {
  /** Resolved `ToolASTNode` definition. */
  readonly toolNode: ToolASTNode<THandle>;
  /** Registered tool executor instance. */
  readonly toolDriver: NonNullable<
    AgentTurnSessionState<TIn, TOut, THandle>['ctx']['registry']['tools'][ToolASTNode<THandle>['type']]
  >;
  /** Schema-validated tool arguments. */
  readonly validatedArgs: unknown;
}

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
 * Executes a `'declared'` effect-tracking tool under a shared read or exclusive write scope lock and applies reactive scoped rules (`SPEC.md` §3.4.1 & §3.7.2).
 *
 * Acquires an exclusive write lock when any predicted effect has `mutatesScope === true`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>}                        session   - Active agent turn session state.
 * @param {RemainingToolCallRecord}                                          call      - Tool call record to execute.
 * @param {ExecuteDeclaredEffectToolCallExecutionParams<TIn, TOut, THandle>} execution - Tool node, tool driver, and validated arguments.
 *
 * @returns {Promise<{ readonly status: 'completed'; readonly content: string; readonly isError: boolean; readonly newEffects: readonly ToolEffect[] }>} Declared-effect tool outcome.
 */
async function executeDeclaredEffectToolCall<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  call: RemainingToolCallRecord,
  execution: ExecuteDeclaredEffectToolCallExecutionParams<TIn, TOut, THandle>,
): Promise<{
  readonly status: 'completed';
  readonly content: string;
  readonly isError: boolean;
  readonly newEffects: readonly ToolEffect[];
}> {
  let preEval: PolicyEvaluationResult;
  let rawOut: unknown;
  try {
    preEval = await evaluatePreFlightToolBatch({
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
    rawOut = mutates
      ? await session.lockManager.withWriteLock(
          session.ctx.scopeHandle,
          runTool,
          session.ctx.signal,
        )
      : await session.lockManager.withReadLock(
          session.ctx.scopeHandle,
          runTool,
          session.ctx.signal,
        );
  } catch (err) {
    const hasErrnoCode =
      typeof (err as { readonly code?: unknown } | undefined)?.code === 'string';
    const isFsMessage =
      err instanceof Error &&
      (err.message.startsWith('ENOENT:') ||
        err.message.startsWith('EISDIR:') ||
        err.message.startsWith('ENOTDIR:') ||
        err.message.startsWith('EACCES:'));
    if (session.ctx.signal?.aborted === true || (!hasErrnoCode && !isFsMessage)) {
      throw err;
    }
    return Object.freeze({
      status: 'completed',
      content: err instanceof Error ? err.message : String(err),
      isError: true,
      newEffects: Object.freeze([]),
    });
  }
  let outStr: string;
  if (typeof rawOut === 'string') {
    outStr = rawOut;
  } else if (typeof (rawOut as { readonly content?: unknown })?.content === 'string') {
    outStr = (rawOut as { readonly content: string }).content;
  } else {
    outStr = JSON.stringify(rawOut);
  }
  const isError = Boolean((rawOut as { readonly isError?: boolean })?.isError);
  if (isError) {
    return Object.freeze({
      status: 'completed',
      content: outStr,
      isError: true,
      newEffects: Object.freeze([]),
    });
  }
  const contentWithRules = await applyReactiveScopedRulesAndRecordEffects(
    session,
    preEval.primaryEffects,
    outStr,
  );
  return Object.freeze({
    status: 'completed',
    content: contentWithRules,
    isError: false,
    newEffects: preEval.primaryEffects,
  });
}

/**
 * Invokes a tool exposed by an active skill's `ServiceSession` when `call.toolName` belongs to `session.serviceByToolName` (`SPEC.md` §3.4.2).
 *
 * Returns `undefined` when `call.toolName` is not a service-backed tool.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session - Active agent turn session state.
 * @param {RemainingToolCallRecord}                   call    - Tool call record being dispatched.
 *
 * @returns {Promise<{ readonly status: 'completed'; readonly content: string; readonly isError: boolean } | undefined>} Service tool invocation outcome, or `undefined`.
 */
async function tryInvokeMountedServiceTool<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  call: RemainingToolCallRecord,
): Promise<
  | { readonly status: 'completed'; readonly content: string; readonly isError: boolean }
  | undefined
> {
  const serviceId = session.serviceByToolName?.get(call.toolName);
  if (serviceId === undefined) {
    return undefined;
  }
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

/**
 * Executes a single tool call through the pre-flight skill lease gate, service session or tool driver, post-flight sandbox, and reactive scoped rules (`SPEC.md` §3.4.1–§3.5).
 *
 * Sequences named checks and execution strategies at a uniform level of abstraction (`Rule 3.1`).
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
  const serviceOut = await tryInvokeMountedServiceTool(session, call);
  if (serviceOut !== undefined) {
    return serviceOut;
  }
  const toolNode = session.toolsByName.get(call.toolName);
  const toolDriver =
    toolNode !== undefined ? session.ctx.registry.tools[toolNode.type] : undefined;
  if (toolNode === undefined || toolDriver === undefined) {
    return Object.freeze({
      status: 'completed',
      content: `Unregistered tool '${call.toolName}' on agent '${session.node.id}'.`,
      isError: true,
    });
  }
  let validatedArgs: unknown;
  try {
    validatedArgs = toolNode.inputSchema.parse(JSON.parse(call.argsJson || '{}'));
  } catch (err) {
    return Object.freeze({
      status: 'completed',
      content: err instanceof Error ? err.message : String(err),
      isError: true,
      newEffects: Object.freeze([]),
    });
  }
  if (toolNode.effectTracking === 'declared') {
    return executeDeclaredEffectToolCall(session, call, {
      toolNode,
      toolDriver,
      validatedArgs,
    });
  }
  return executePostFlightSandboxedToolCall({
    session,
    call,
    batch,
    toolNode,
    toolDriver,
    validatedArgs,
  });
}
