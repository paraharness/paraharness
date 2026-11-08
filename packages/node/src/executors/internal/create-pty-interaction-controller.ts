import type { LocalServiceInteractionConfig, LocalServiceNode, ToolExecutionResult } from '@metaharness/core';
import type { LocalDaemonCommandContext } from '../../builders/local-daemon-builder.js';
import { extractInteractiveInputString } from './extract-interactive-input-string.js';
import type { ResolvedSubprocessEnvironment } from './process-group-lifecycle.js';
import { PtyFramedInteractiveSession } from './pty-framed-session.js';
import type { PtyInteractionController } from './pty-interaction-controller.js';

/**
 * Parameters for constructing a `PtyInteractionController` for a running `LocalServiceNode`.
 *
 * Supplies the daemon AST node, allocated port/scope context, and resolved worktree environment.
 */
export interface CreatePtyInteractionControllerParams {
  /** Passive daemon service AST node. */
  readonly node: LocalServiceNode;
  /** Allocated dynamic ports and sanitized scope key context. */
  readonly cmdCtx: LocalDaemonCommandContext;
  /** Resolved worktree directory and subprocess environment variables. */
  readonly resolvedEnv: ResolvedSubprocessEnvironment;
}

/**
 * Creates a `PtyInteractionController` that lazily spawns and frames `PtyFramedInteractiveSession` instances per tool.
 *
 * Pre-indexes `node.interactions` by `toolName` for $O(1)$ lookup and reuses the same PTY session
 * across turns for a given `toolName` within the active daemon session.
 *
 * @param {CreatePtyInteractionControllerParams} params - Daemon node, command context, and resolved environment.
 *
 * @returns {PtyInteractionController} Frozen PTY interaction controller for the daemon session.
 */
export function createPtyInteractionController(
  params: CreatePtyInteractionControllerParams,
): PtyInteractionController {
  const { node, cmdCtx, resolvedEnv } = params;
  const interactionsByName = new Map<string, LocalServiceInteractionConfig>();
  for (const item of node.interactions) {
    interactionsByName.set(item.toolName, item);
  }
  const ptySessions = new Map<string, PtyFramedInteractiveSession>();
  return Object.freeze<PtyInteractionController>({
    async invokeTool(
      toolName: string,
      args: unknown,
      signal?: AbortSignal,
    ): Promise<ToolExecutionResult> {
      const spec = interactionsByName.get(toolName);
      if (spec === undefined) {
        throw new Error(`Unknown interaction tool '${toolName}' on daemon '${node.id}'.`);
      }
      const validated = spec.inputSchema.parse(args);
      const existing = ptySessions.get(toolName);
      const session =
        existing ??
        new PtyFramedInteractiveSession({
          toolName,
          argv: spec.command(cmdCtx),
          resolvedEnv,
          frameDelimiter: spec.frameDelimiter,
          idleSettleMs: spec.idleSettleMs,
          timeoutSeconds: spec.timeoutSeconds,
        });
      if (existing === undefined) {
        ptySessions.set(toolName, session);
      }
      const content = await session.sendTurn(extractInteractiveInputString(validated), signal);
      return Object.freeze<ToolExecutionResult>({ content });
    },
    async closeAll(): Promise<void> {
      try {
        for (const session of ptySessions.values()) {
          await session.close();
        }
      } finally {
        ptySessions.clear();
      }
    },
  });
}
