import type { z } from 'zod';
import type { BaseServiceASTNode } from '../base/base-service-ast-node.js';
import type { NodeRunnerNode } from './node-runner-node.js';

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
  readonly interactions: ReadonlyArray<{
    readonly toolName: string;
    readonly description: string;
    readonly inputSchema: z.ZodTypeAny;
    readonly command: (ctx: {
      readonly ports: Readonly<Record<string, number>>;
      readonly scopeKey: string;
      readonly worktreePath?: string;
    }) => readonly string[];
    readonly frameDelimiter: string | { readonly pattern: string; readonly flags?: string };
    readonly idleSettleMs: number;
    readonly timeoutSeconds: number;
  }>;
}
