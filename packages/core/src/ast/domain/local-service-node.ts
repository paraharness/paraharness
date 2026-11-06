import type { z } from 'zod';
import type { BaseServiceASTNode } from '../base/base-service-ast-node.js';
import type { NodeRunnerNode } from './node-runner-node.js';

/**
 * Framed pseudo-terminal (PTY) interaction tool specification exposed by a `LocalServiceNode`.
 *
 * Defines the tool name, input schema, command factory, frame delimiter, idle settle window, and timeout.
 */
export interface LocalServiceInteractionConfig {
  /** Unique tool name exposed to the agent when the service is mounted. */
  readonly toolName: string;
  /** Human-readable description of the interaction tool. */
  readonly description: string;
  /** Zod schema validating the tool call arguments. */
  readonly inputSchema: z.ZodTypeAny;
  /** Pure factory mapping active daemon ports, `scopeKey`, and `worktreePath` to the interaction command `argv`. */
  readonly command: (ctx: {
    readonly ports: Readonly<Record<string, number>>;
    readonly scopeKey: string;
    readonly worktreePath?: string;
  }) => readonly string[];
  /** Output frame delimiter string or regex descriptor terminating each interaction frame. */
  readonly frameDelimiter: string | { readonly pattern: string; readonly flags?: string };
  /** Quiet period in milliseconds required before settling a delimited output frame. */
  readonly idleSettleMs: number;
  /** Maximum execution timeout in seconds for a single interaction call. */
  readonly timeoutSeconds: number;
}

/**
 * Passive AST node representing a lifecycle-bound background daemon service (`local.daemon`).
 *
 * Manages dynamic conflict-free port allocation, hash-suffixed `scopeKey` sanitization, TCP readiness
 * verification, and framed pseudo-terminal (PTY) interaction tools.
 */
export interface LocalServiceNode extends BaseServiceASTNode<'node:service'> {
  /** Runner pool governing daemon slot concurrency (`maxDaemons`). */
  readonly runner: NodeRunnerNode;
  /** Named dynamic TCP port identifiers allocated for each daemon session. */
  readonly ports: readonly string[];
  /** Pure factory mapping allocated ports, sanitized `scopeKey`, and `worktreePath` to the startup `argv`. */
  readonly startArgv: (ctx: {
    readonly ports: Readonly<Record<string, number>>;
    readonly scopeKey: string;
    readonly worktreePath?: string;
  }) => readonly string[];
  /** Optional pure factory mapping session context to a cleanup/stop command `argv`. */
  readonly stopArgv?: (ctx: {
    readonly ports: Readonly<Record<string, number>>;
    readonly scopeKey: string;
    readonly worktreePath?: string;
  }) => readonly string[];
  /** Optional regex pattern over combined `stdout`/`stderr` indicating daemon readiness. */
  readonly readyWhenStdoutRegex?: { readonly pattern: string; readonly flags?: string };
  /** Framed PTY interaction tool specifications exposed by this service. */
  readonly interactions: readonly LocalServiceInteractionConfig[];
}
