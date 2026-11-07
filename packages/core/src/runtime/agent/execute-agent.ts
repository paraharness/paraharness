import type { AgentNode } from '../../ast/agent-node.js';
import type { StepExecutionContext } from '../../ports/step-execution-context.js';
import {
  finalizeAgentTurnSession,
  initializeAgentTurnSession,
} from './internal/initialize-agent-turn-session.js';
import { runAgentTurnLoop } from './internal/run-agent-turn-loop.js';

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
  const session = await initializeAgentTurnSession(node, validatedInput, ctx);
  try {
    return await runAgentTurnLoop(session);
  } finally {
    await finalizeAgentTurnSession(ctx, session);
  }
}
