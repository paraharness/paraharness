import type { ToolASTNode } from '../../../ast/domain-ast.types.js';
import type { AgentContinuationFrame } from '../../../ports/agent-continuation-frame.js';
import type { CheckpointableScope } from '../../../ports/checkpointable-scope.js';
import type { ContinuationFrame } from '../../../ports/continuation-frame.types.js';
import type { PendingToolBatch, RemainingToolCallRecord } from '../../../ports/pending-tool-batch.js';
import type { ToolEffect } from '../../../ports/tool-effect.js';
import { executePostFlightSandboxedTool } from '../../policy/internal/execute-post-flight-sandboxed-tool.js';
import type { AgentTurnSessionState } from '../agent-turn-session-state.js';
import type { InterruptEdgeResolution } from '../interrupt-edge-resolution.js';
import { applyReactiveScopedRulesAndRecordEffects } from './dispatch-single-tool-call.js';
import { resolveInterruptEdge } from './resolve-interrupt-edge.js';

/**
 * Parameters for `executePostFlightSandboxedToolCall`.
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface ExecutePostFlightSandboxedToolCallParams<
  TIn = unknown,
  TOut = unknown,
  THandle = unknown,
> {
  /** Active agent turn session state. */
  readonly session: AgentTurnSessionState<TIn, TOut, THandle>;
  /** Tool call record being executed. */
  readonly call: RemainingToolCallRecord;
  /** Enclosing `PendingToolBatch` state. */
  readonly batch: PendingToolBatch;
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
 * Updates `session.agentFrame` with `nextBatch` and optional `inFlightPreToolCheckpoint` and persists the continuation stack (`SPEC.md` §3.5 & §3.10).
 *
 * Stateless top-level helper replacing nested closure state mutation (`Rule 3.1`).
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentTurnSessionState<TIn, TOut, THandle>} session   - Active agent turn session state.
 * @param {PendingToolBatch}                          nextBatch - Updated `PendingToolBatch` state.
 * @param {string}                                    [ckpt]    - Optional pre-tool checkpoint identifier.
 *
 * @returns {Promise<void>} Resolves once the continuation stack is persisted.
 */
export async function persistInFlightToolBatchEntry<TIn, TOut, THandle>(
  session: AgentTurnSessionState<TIn, TOut, THandle>,
  nextBatch: PendingToolBatch,
  ckpt?: string,
): Promise<void> {
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
        Object.freeze<readonly ContinuationFrame[]>([...session.outerFrames, session.agentFrame]),
      ),
    );
  }
}

/**
 * Executes a `'subprocess-post-flight'` tool under an exclusive write lock with pre-tool checkpointing, post-flight diffing, and reactive scoped-rule evaluation (`SPEC.md` §3.5).
 *
 * @template TIn     Validated agent input payload type.
 * @template TOut    Validated agent output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {ExecutePostFlightSandboxedToolCallParams<TIn, TOut, THandle>} params - Post-flight sandboxed tool execution parameters.
 *
 * @returns {Promise<{ readonly status: 'completed' | 'interrupted'; readonly content: string; readonly isError: boolean; readonly newEffects?: readonly ToolEffect[]; readonly interruptResolution?: InterruptEdgeResolution<THandle> }>} Tool execution outcome.
 */
export async function executePostFlightSandboxedToolCall<TIn, TOut, THandle>(
  params: ExecutePostFlightSandboxedToolCallParams<TIn, TOut, THandle>,
): Promise<{
  readonly status: 'completed' | 'interrupted';
  readonly content: string;
  readonly isError: boolean;
  readonly newEffects?: readonly ToolEffect[];
  readonly interruptResolution?: InterruptEdgeResolution<THandle>;
}> {
  const { session, call, batch, toolNode, toolDriver, validatedArgs } = params;
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
  if (scopeDriver === undefined) {
    const rawOut = await session.lockManager.withWriteLock(
      session.ctx.scopeHandle,
      () =>
        Promise.resolve(
          toolDriver.execute(toolNode as never, validatedArgs as never, session.ctx as never),
        ),
      session.ctx.signal,
    );
    return Object.freeze({
      status: 'completed',
      content: typeof rawOut === 'string' ? rawOut : JSON.stringify(rawOut),
      isError: false,
    });
  }
  const sbOut = await session.lockManager.withWriteLock(
    session.ctx.scopeHandle,
    () =>
      executePostFlightSandboxedTool({
        toolNode,
        toolDriver: toolDriver as never,
        parsedArgs: validatedArgs,
        callRecord: call,
        policy: session.node.policy,
        activeLeases: session.agentFrame.activeLeases,
        checkpointScope: scopeDriver,
        ctx: session.ctx,
        persistInFlightCheckpoint: (ckpt) => persistInFlightToolBatchEntry(session, batch, ckpt),
      }),
    session.ctx.signal,
  );
  if (
    sbOut.status === 'rolled-back-interrupt' &&
    sbOut.policyResult?.raisedInterrupt !== undefined
  ) {
    await persistInFlightToolBatchEntry(
      session,
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
    if (intrRes.status !== 'resumed') {
      return Object.freeze({
        status: 'interrupted',
        content: sbOut.toolResult.content,
        isError: true,
        interruptResolution: intrRes,
      });
    }
    return Object.freeze({
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
