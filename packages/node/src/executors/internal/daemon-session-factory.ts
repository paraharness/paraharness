import type { ChildProcess } from 'node:child_process';
import type {
  LocalServiceInteractionConfig,
  LocalServiceNode,
  LocalServiceToolNode,
  ServiceSession,
  StepExecutionContext,
  ToolExecutionResult,
} from '@harness-dsl/core';
import type { LocalDaemonCommandContext } from '../../builders/local-daemon-interact-options.js';
import { ACTIVE_LEASED_DAEMON_PORTS } from '../node-subprocess-env.constants.js';
import {
  allocateDynamicPorts,
  sanitizeDaemonScopeKey,
  waitForTcpPortReady,
} from './daemon-ports-and-scope-key.js';
import {
  runBestEffortStopCommand,
  waitForDaemonStdoutReady,
} from './daemon-startup-helpers.js';
import {
  spawnDetachedSubprocess,
  terminateProcessGroupWithGrace,
} from './process-group-lifecycle.js';
import { PtyFramedInteractiveSession } from './pty-framed-session.js';
import type { ResolvedSubprocessEnvironment } from './spawn-detached-subprocess-params.js';

/**
 * Builds the `LocalServiceToolNode` descriptors and interaction lookup map for a `LocalServiceNode`.
 *
 * Sets `effectTracking: 'subprocess-post-flight'` on each emitted `LocalServiceToolNode`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LocalServiceNode} node - Passive daemon service AST node.
 *
 * @returns {readonly LocalServiceToolNode<THandle>[]} Frozen array of service tool AST nodes.
 */
export function buildServiceToolNodes<THandle = unknown>(
  node: LocalServiceNode,
): readonly LocalServiceToolNode<THandle>[] {
  const tools: LocalServiceToolNode<THandle>[] = [];
  for (const interaction of node.interactions) {
    tools.push(
      Object.freeze<LocalServiceToolNode<THandle>>({
        type: 'node:service-tool',
        name: interaction.toolName,
        description: interaction.description,
        inputSchema: interaction.inputSchema,
        effectTracking: 'subprocess-post-flight',
        serviceId: node.id,
      }),
    );
  }
  return Object.freeze(tools);
}

/**
 * Extracts the string command line input from validated `.interact()` tool arguments.
 *
 * Accepts either a direct string or an object carrying a string `input` property.
 *
 * @param {unknown} validatedArgs - Schema-validated tool arguments.
 *
 * @returns {string} Command string to send to the interactive PTY session.
 */
export function extractInteractiveInputString(validatedArgs: unknown): string {
  if (typeof validatedArgs === 'string') return validatedArgs;
  if (
    typeof validatedArgs === 'object' &&
    validatedArgs !== null &&
    'input' in validatedArgs &&
    typeof validatedArgs.input === 'string'
  ) {
    return validatedArgs.input;
  }
  return JSON.stringify(validatedArgs);
}

/**
 * Boots the daemon process, verifies stdout and TCP port readiness, and constructs the `ServiceSession`.
 *
 * Releases leased ports and the daemon slot if startup fails or when `ServiceSession.stop()` completes.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LocalServiceNode}              node              - Passive service AST node.
 * @param {string}                        rawScopeKey       - Raw isolation scope key.
 * @param {ResolvedSubprocessEnvironment} resolvedEnv       - Resolved worktree cwd and environment.
 * @param {() => void}                    releaseDaemonSlot - Callback releasing the runner daemon slot.
 *
 * @returns {Promise<ServiceSession<THandle>>} Live daemon `ServiceSession`.
 */
export async function bootLocalDaemonSession<THandle = unknown>(
  node: LocalServiceNode,
  rawScopeKey: string,
  resolvedEnv: ResolvedSubprocessEnvironment,
  releaseDaemonSlot: () => void,
): Promise<ServiceSession<THandle>> {
  const scopeKey = sanitizeDaemonScopeKey(rawScopeKey);
  const ports = await allocateDynamicPorts(node.ports);
  const cmdCtx: LocalDaemonCommandContext = { ports, scopeKey, worktreePath: resolvedEnv.worktreePath };
  await runBestEffortStopCommand(node.stopArgv?.(cmdCtx), resolvedEnv);
  const daemonChild = spawnDetachedSubprocess({ argv: node.startArgv(cmdCtx), resolvedEnv });
  try {
    await waitForDaemonStdoutReady(daemonChild, node.readyWhenStdoutRegex, node.id);
    for (const port of Object.values(ports)) await waitForTcpPortReady(port);
  } catch (error) {
    await terminateProcessGroupWithGrace(daemonChild);
    for (const port of Object.values(ports)) ACTIVE_LEASED_DAEMON_PORTS.delete(port);
    throw error;
  }
  return createActiveDaemonSessionObject(node, cmdCtx, resolvedEnv, daemonChild, releaseDaemonSlot);
}

/**
 * Constructs the live `ServiceSession` object wrapping an active daemon child process and its PTY tools.
 *
 * Manages lazy `PtyFramedInteractiveSession` instantiation per tool and deterministic teardown on `stop()`.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {LocalServiceNode}              node              - Passive service AST node.
 * @param {LocalDaemonCommandContext}     cmdCtx            - Allocated ports and sanitized scope key context.
 * @param {ResolvedSubprocessEnvironment} resolvedEnv       - Resolved worktree cwd and environment.
 * @param {ChildProcess}                  daemonChild       - Spawned daemon process.
 * @param {() => void}                    releaseDaemonSlot - Callback releasing the runner daemon slot.
 *
 * @returns {ServiceSession<THandle>} Frozen `ServiceSession` implementation.
 */
export function createActiveDaemonSessionObject<THandle = unknown>(
  node: LocalServiceNode,
  cmdCtx: LocalDaemonCommandContext,
  resolvedEnv: ResolvedSubprocessEnvironment,
  daemonChild: ChildProcess,
  releaseDaemonSlot: () => void,
): ServiceSession<THandle> {
  const interactionsByName = new Map<string, LocalServiceInteractionConfig>();
  for (const item of node.interactions) interactionsByName.set(item.toolName, item);
  const ptySessions = new Map<string, PtyFramedInteractiveSession>();
  let stopped = false;
  return Object.freeze<ServiceSession<THandle>>({
    id: node.id,
    tools: buildServiceToolNodes<THandle>(node),
    async invokeTool(toolName: string, args: unknown, ctx: StepExecutionContext<THandle>): Promise<ToolExecutionResult> {
      const spec = interactionsByName.get(toolName);
      if (spec === undefined) throw new Error(`Unknown interaction tool '${toolName}' on daemon '${node.id}'.`);
      const validated = spec.inputSchema.parse(args);
      let session = ptySessions.get(toolName);
      if (session === undefined) {
        session = new PtyFramedInteractiveSession({ toolName, argv: spec.command(cmdCtx), resolvedEnv, frameDelimiter: spec.frameDelimiter, idleSettleMs: spec.idleSettleMs, timeoutSeconds: spec.timeoutSeconds });
        ptySessions.set(toolName, session);
      }
      const content = await session.sendTurn(extractInteractiveInputString(validated), ctx.signal);
      return Object.freeze<ToolExecutionResult>({ content });
    },
    async stop(): Promise<void> {
      if (stopped) return;
      stopped = true;
      for (const session of ptySessions.values()) await session.close();
      ptySessions.clear();
      await runBestEffortStopCommand(node.stopArgv?.(cmdCtx), resolvedEnv);
      await terminateProcessGroupWithGrace(daemonChild);
      for (const port of Object.values(cmdCtx.ports)) ACTIVE_LEASED_DAEMON_PORTS.delete(port);
      releaseDaemonSlot();
    },
  });
}
