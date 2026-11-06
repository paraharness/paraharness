import type { ToolASTNode } from '../../src/ast/domain-ast.types.js';
import type { ServiceSession } from '../../src/ports/service-session.js';
import type { StepExecutionContext } from '../../src/ports/step-execution-context.js';
import type { ToolExecutionResult } from '../../src/ports/tool-execution-result.js';

/**
 * Deterministic `ServiceSession` test fixture tracking daemon start/stop lifecycle counters and `invokeTool` calls (`SPEC.md` §3.4.2).
 *
 * Used to verify reference-counted skill service sharing, step-boundary quiescing, and `[SERVICE_REACQUIRED]` notes.
 */
export class ScriptedServiceSession implements ServiceSession<string> {
  /** Service AST node identifier. */
  readonly id: string;
  /** Interaction tools exposed while the service session is active. */
  readonly tools: readonly ToolASTNode<string>[];
  /** Number of times `stop()` has been called on this session instance. */
  stopCount = 0;
  /** True while the session has not yet been stopped. */
  running = true;
  /** Recorded `invokeTool` calls `(toolName, args)`. */
  readonly toolCalls: Array<{ readonly toolName: string; readonly args: unknown }> = [];

  /**
   * Creates a `ScriptedServiceSession` for `id` with optional exposed `tools`.
   *
   * Starts in `running = true` with `stopCount = 0`.
   *
   * @param {string}                         id      - Service identifier.
   * @param {readonly ToolASTNode<string>[]} [tools] - Exposed service interaction tools.
   */
  constructor(id: string, tools: readonly ToolASTNode<string>[] = []) {
    this.id = id;
    this.tools = Object.freeze([...tools]);
  }

  /**
   * Invokes an exposed service interaction tool and records the call in `toolCalls`.
   *
   * Returns a deterministic result string containing the service ID and tool name.
   *
   * @param {string}                       toolName - Interaction tool name.
   * @param {unknown}                      args     - Tool call arguments.
   * @param {StepExecutionContext<string>} _ctx     - Step execution context.
   *
   * @returns {Promise<ToolExecutionResult>} Tool execution result.
   */
  async invokeTool(toolName: string, args: unknown, _ctx: StepExecutionContext<string>): Promise<ToolExecutionResult> {
    this.toolCalls.push(Object.freeze({ toolName, args }));
    return Object.freeze({ content: `service:${this.id}:${toolName}:${JSON.stringify(args)}`, isError: false });
  }

  /**
   * Stops the daemon session, increments `stopCount`, and sets `running = false`.
   *
   * Called by `ServiceSessionRegistry.releaseSkillServices` and `quiesceScopeServices`.
   *
   * @returns {Promise<void>} Resolves once stopped.
   */
  async stop(): Promise<void> {
    this.stopCount += 1;
    this.running = false;
  }
}
