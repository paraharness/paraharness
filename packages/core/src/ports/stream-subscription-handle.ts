/**
 * Active subscription handle returned by `StreamSource.subscribe()`.
 *
 * Exposes a deterministic `close()` method to unsubscribe from the event stream cleanly.
 */
export interface StreamSubscriptionHandle {
  /**
   * Closes the event stream subscription and releases any underlying network or webhook listeners.
   *
   * Invoked by `HarnessRuntime.stop()` during graceful runtime shutdown.
   *
   * @returns {Promise<void>} Resolves once the subscription is closed.
   */
  close(): Promise<void>;
}
