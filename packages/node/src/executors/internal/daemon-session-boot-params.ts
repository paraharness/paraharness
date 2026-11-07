import type { LocalServiceNode } from '@harness-dsl/core';
import type { ResolvedSubprocessEnvironment } from './spawn-detached-subprocess-params.js';

/**
 * Parameter object for booting a local daemon service session (`bootLocalDaemonSession`).
 *
 * Bundles the passive service AST node, raw isolation scope key, resolved worktree environment,
 * and runner daemon-slot release callback so daemon startup helpers obey the 3-parameter ceiling.
 */
export interface DaemonSessionBootParams {
  /** Passive daemon service AST node to start. */
  readonly node: LocalServiceNode;
  /** Raw unsanitized isolation scope key (`${runId}:${forkId ?? 'root'}`). */
  readonly rawScopeKey: string;
  /** Resolved working directory and environment variables for the daemon subprocess. */
  readonly resolvedEnv: ResolvedSubprocessEnvironment;
  /** Callback releasing the acquired long-lived daemon slot on the runner pool. */
  readonly releaseDaemonSlot: () => void;
}
