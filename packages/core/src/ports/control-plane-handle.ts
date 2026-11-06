/**
 * Active handle returned when a control-plane adapter starts listening for external commands or webhooks.
 *
 * Exposes a deterministic `close()` method to shut down the control-plane server cleanly.
 */
export interface ControlPlaneHandle {
  /**
   * Stops the control-plane server and releases all bound network sockets or transport resources.
   *
   * Invoked by `HarnessRuntime.stop()` during graceful runtime shutdown.
   *
   * @returns {Promise<void>} Resolves when the control-plane listener has closed.
   */
  close(): Promise<void>;
}
