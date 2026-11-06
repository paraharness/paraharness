import type { ControlPlaneHandle } from './control-plane-handle.js';
import type { HarnessRuntimeController } from './harness-runtime-controller.js';

/**
 * Runtime port for inbound control-plane servers (such as HTTP webhook listeners, MCP servers, or Slack bots).
 *
 * Dispatched via `RuntimeExecutorRegistry.controlPlanes[node.type]` when `HarnessRuntime.start()` boots.
 */
export interface ControlPlaneAdapter {
  /**
   * Starts the control-plane listener bound to the active `HarnessRuntimeController`.
   *
   * Registers inbound transport routes so external operators can trigger signals and inspect active runs.
   *
   * @param {HarnessRuntimeController} runtime - Controller handle for emitting signals and inspecting active runs.
   *
   * @returns {Promise<ControlPlaneHandle>} Handle used to close the control-plane listener on shutdown.
   */
  start(runtime: HarnessRuntimeController): Promise<ControlPlaneHandle>;
}
