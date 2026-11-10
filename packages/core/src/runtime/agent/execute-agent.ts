import type { AgentNode } from '../../ast/agent-node.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import { finalizeAgentTurnSession } from './internal/finalize-agent-turn-session.js';
import { initializeAgentTurnSession } from './internal/initialize-agent-turn-session.js';
import { runAgentTurnLoop } from './internal/run-agent-turn-loop.js';

/**
 * Creates a combined `AbortSignal` scope when `node.timeoutMinutes` is positive (`SPEC.md` §1.13).
 *
 * Links `ctx.signal` to a child `AbortController`, schedules an `.unref()`ed timer for `node.timeoutMinutes * 60_000` ms,
 * and returns a deterministic `dispose()` cleanup callback (`Rule 5.3`).
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {AgentNode<unknown, unknown, THandle>} node - Passive `AgentNode` AST definition.
 * @param {StepExecutionContext<THandle>}        ctx  - Active step execution context.
 *
 * @returns {{ readonly effectiveCtx: StepExecutionContext<THandle>; readonly dispose: () => void; readonly normalizeError: (err: unknown) => unknown }} Combined signal context and cleanup callbacks.
 */
function createAgentTimeoutSignalScope<THandle = unknown>(
  node: AgentNode<unknown, unknown, THandle>,
  ctx: StepExecutionContext<THandle>,
): {
  readonly effectiveCtx: StepExecutionContext<THandle>;
  readonly dispose: () => void;
  readonly normalizeError: (err: unknown) => unknown;
} {
  if (node.timeoutMinutes === undefined || node.timeoutMinutes <= 0) {
    return {
      effectiveCtx: ctx,
      dispose: (): void => undefined,
      normalizeError: (err: unknown): unknown => err,
    };
  }
  const controller = new AbortController();
  const timeoutError = new Error(
    `Agent '${node.id}' timed out after ${String(node.timeoutMinutes)} minute(s) in run '${ctx.runId}' (step '${ctx.stepExecId}').`,
  );
  const parentSignal = ctx.signal;
  let onParentAbort: (() => void) | undefined;
  if (parentSignal?.aborted === true) {
    controller.abort(parentSignal.reason);
  } else if (parentSignal !== undefined) {
    onParentAbort = (): void => {
      controller.abort(parentSignal.reason);
    };
    parentSignal.addEventListener('abort', onParentAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(timeoutError);
  }, node.timeoutMinutes * 60_000);
  timer.unref?.();
  const effectiveCtx = Object.freeze({
    ...ctx,
    signal: controller.signal,
  }) as StepExecutionContext<THandle>;
  return {
    effectiveCtx,
    dispose: (): void => {
      clearTimeout(timer);
      if (onParentAbort !== undefined && parentSignal !== undefined) {
        parentSignal.removeEventListener('abort', onParentAbort);
      }
    },
    normalizeError: (err: unknown): unknown =>
      controller.signal.aborted && controller.signal.reason === timeoutError ? timeoutError : err,
  };
}

/**
 * Executes a passive `AgentNode` across turns, tool batches, policy guards, skills, capabilities, and `beforeStop` gates (`SPEC.md` §3.7.1).
 *
 * Sequences session initialization (`initializeAgentTurnSession`), turn-loop execution (`runAgentTurnLoop`),
 * and deterministic finalization (`finalizeAgentTurnSession`) at one uniform level of abstraction (`Rule 3.1`).
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
  const timeoutScope = createAgentTimeoutSignalScope(node as AgentNode<unknown, unknown, THandle>, ctx);
  const session = await initializeAgentTurnSession(node, validatedInput, timeoutScope.effectiveCtx);
  try {
    return await runAgentTurnLoop(session);
  } catch (err) {
    throw timeoutScope.normalizeError(err);
  } finally {
    timeoutScope.dispose();
    await finalizeAgentTurnSession(timeoutScope.effectiveCtx, session);
  }
}
