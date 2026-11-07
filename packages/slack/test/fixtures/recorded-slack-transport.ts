import type { ControlPlaneHandle, HarnessRuntimeController } from '@harness-dsl/core';
import type { SlackTransport } from '../../src/executors/slack-transport.js';

/**
 * Deterministic in-memory `SlackTransport` test double for `@harness-dsl/slack` unit tests.
 *
 * Records all `postMessage`, `updateMessage`, `postWebhook`, and `connectSocketMode` invocations
 * and assigns monotonically increasing message timestamps (`1000.1`, `1000.2`, ...).
 */
export class RecordedSlackTransport implements SlackTransport {
  /** Recorded `postMessage` calls in invocation order. */
  public readonly postedMessages: Array<{
    readonly botToken: string;
    readonly channel: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly ts: string;
  }> = [];

  /** Recorded `updateMessage` calls in invocation order. */
  public readonly updatedMessages: Array<{
    readonly botToken: string;
    readonly channel: string;
    readonly payload: Readonly<Record<string, unknown>>;
  }> = [];

  /** Recorded `postWebhook` calls in invocation order. */
  public readonly webhookMessages: Array<{
    readonly webhookUrl: string;
    readonly message: string;
  }> = [];

  /** Recorded Socket Mode connection events. */
  public readonly socketModeConnections: Array<{
    readonly appToken: string;
    readonly closed: boolean;
    readonly onInteractiveAction?: (
      runId: string,
      requestId: string,
      responsePayload: unknown,
    ) => void;
  }> = [];

  /** Monotonic message counter for deterministic Slack `ts` values. */
  private seq = 0;

  /**
   * Records a `chat.postMessage` call and returns a deterministic message timestamp.
   *
   * Increments the internal sequence counter on each posted message.
   *
   * @param {string}                            botToken - Resolved Slack bot token.
   * @param {string}                            channel  - Resolved Slack channel identifier.
   * @param {Readonly<Record<string, unknown>>} payload  - Message body and block payload.
   *
   * @returns {Promise<{ readonly ts: string }>} Deterministic Slack message timestamp receipt.
   */
  async postMessage(
    botToken: string,
    channel: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly ts: string }> {
    this.seq += 1;
    const ts = `1000.${this.seq}`;
    this.postedMessages.push(Object.freeze({ botToken, channel, payload, ts }));
    return Object.freeze({ ts });
  }

  /**
   * Records a `chat.update` call for a previously posted Slack message.
   *
   * Appends the update entry to `updatedMessages` for test verification.
   *
   * @param {string}                            botToken - Resolved Slack bot token.
   * @param {string}                            channel  - Resolved Slack channel identifier.
   * @param {Readonly<Record<string, unknown>>} payload  - Message timestamp and updated fields.
   *
   * @returns {Promise<void>} Resolves immediately after recording the update.
   */
  async updateMessage(
    botToken: string,
    channel: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    this.updatedMessages.push(Object.freeze({ botToken, channel, payload }));
  }

  /**
   * Records an outbound Slack incoming webhook POST call.
   *
   * Appends the webhook URL and message text to `webhookMessages`.
   *
   * @param {string} webhookUrl - Resolved Slack incoming webhook URL.
   * @param {string} message    - Notification message text.
   *
   * @returns {Promise<void>} Resolves immediately after recording the webhook call.
   */
  async postWebhook(webhookUrl: string, message: string): Promise<void> {
    this.webhookMessages.push(Object.freeze({ webhookUrl, message }));
  }

  /**
   * Records a Socket Mode connection lifecycle and returns a closeable handle.
   *
   * Flips the connection entry's `closed` flag to `true` when `.close()` is invoked.
   *
   * @param {string}                   appToken              - Resolved Slack app-level token.
   * @param {HarnessRuntimeController} _controller           - Runtime controller bound to Socket Mode.
   * @param {Function}                 [onInteractiveAction] - Optional interactive decision callback.
   *
   * @returns {Promise<ControlPlaneHandle>} Handle marking the connection closed on `.close()`.
   */
  async connectSocketMode(
    appToken: string,
    _controller: HarnessRuntimeController,
    onInteractiveAction?: (
      runId: string,
      requestId: string,
      responsePayload: unknown,
    ) => void,
  ): Promise<ControlPlaneHandle> {
    const entry = { appToken, closed: false, onInteractiveAction };
    this.socketModeConnections.push(entry);
    return Object.freeze<ControlPlaneHandle>({
      async close(): Promise<void> {
        entry.closed = true;
      },
    });
  }
}
