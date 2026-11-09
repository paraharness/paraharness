import type { HarnessRuntimeController } from './harness-runtime-controller.js';

/**
 * Lifecycle handle for an instantiated Paraharness runtime engine.
 *
 * Manages background tracker polling, event stream subscriptions, crash recovery, and control-plane servers.
 */
export interface HarnessRuntime {
  /**
   * Boots the runtime engine, recovers interrupted runs from the ledger, and starts trackers, streams, and control planes.
   *
   * Reattaches root and child isolation scopes for non-terminal runs before enabling new intake polling.
   *
   * @returns {Promise<void>} Resolves once the runtime is started.
   */
  start(): Promise<void>;

  /**
   * Gracefully stops all active trackers, stream subscriptions, control-plane listeners, and in-flight runs.
   *
   * Drains active execution slots and releases bound transport handles deterministically.
   *
   * @returns {Promise<void>} Resolves once all runtime resources have been released.
   */
  stop(): Promise<void>;

  /** Programmatic controller for emitting signals and inspecting active runs. */
  readonly controller: HarnessRuntimeController;
}
