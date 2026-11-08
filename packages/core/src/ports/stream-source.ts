import type { StreamSubscriptionHandle } from './stream-subscription-handle.js';

/**
 * Runtime port for asynchronous event stream sources (`@paraharness/github`).
 *
 * Resolved from `StreamSourceASTNode` via `RuntimeExecutorRegistry.streamSources[node.type]`.
 *
 * @template TEvent Raw event payload type emitted by the stream.
 */
export interface StreamSource<TEvent = unknown> {
  /**
   * Subscribes `onEvent` to incoming events from the external stream source.
   *
   * Forwards each incoming event to `onEvent` for stream filter evaluation and signal correlation.
   *
   * @param {(event: TEvent) => Promise<void>} onEvent - Async handler invoked for each incoming event.
   *
   * @returns {Promise<StreamSubscriptionHandle>} Subscription handle with `.close()`.
   */
  subscribe(onEvent: (event: TEvent) => Promise<void>): Promise<StreamSubscriptionHandle>;
}
