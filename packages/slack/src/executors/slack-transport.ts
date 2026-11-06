import type { ControlPlaneHandle, HarnessRuntimeController } from '@harness-dsl/core';

/**
 * Pluggable transport abstraction for Slack Web API (`chat.postMessage`, `chat.update`),
 * incoming webhooks, and Socket Mode control-plane connections.
 *
 * Allows `SlackApproverAdapter` and `SlackNotifierAdapter` to operate over either
 * `defaultSlackTransport` (`fetch`) or deterministic recorded transports in tests.
 */
export interface SlackTransport {
  /**
   * Posts a message or interactive decision block to a Slack channel via `chat.postMessage`.
   *
   * Returns the Slack message timestamp (`ts`) used to correlate thread heartbeats and updates.
   *
   * @param {string}                            botToken - Resolved Slack bot token (`xoxb-...`).
   * @param {string}                            channel  - Resolved Slack channel identifier.
   * @param {Readonly<Record<string, unknown>>} payload  - Message body and interactive block fields.
   *
   * @returns {Promise<{ readonly ts: string }>} Slack message timestamp receipt.
   */
  postMessage(
    botToken: string,
    channel: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly ts: string }>;

  /**
   * Updates an existing Slack message via `chat.update` (such as marking a superseded decision request cancelled).
   *
   * Targets the message identified by `payload.ts` in `channel`.
   *
   * @param {string}                            botToken - Resolved Slack bot token (`xoxb-...`).
   * @param {string}                            channel  - Resolved Slack channel identifier.
   * @param {Readonly<Record<string, unknown>>} payload  - Message timestamp `ts` and updated text/status fields.
   *
   * @returns {Promise<void>} Resolves once the Slack message update completes.
   */
  updateMessage(
    botToken: string,
    channel: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void>;

  /**
   * Posts a one-way text notification to a Slack incoming webhook URL.
   *
   * Used by `SlackNotifierAdapter` (`slack.webhook(url)`).
   *
   * @param {string} webhookUrl - Resolved Slack incoming webhook URL.
   * @param {string} message    - Notification message text.
   *
   * @returns {Promise<void>} Resolves once the webhook request succeeds.
   */
  postWebhook(webhookUrl: string, message: string): Promise<void>;

  /**
   * Establishes an inbound Slack Socket Mode control-plane connection when provided.
   *
   * Invoked by `SlackApproverAdapter.start(controller)` to bind external slash commands and signals.
   *
   * @param {string}                   appToken   - Resolved Slack app-level token (`xapp-...`).
   * @param {HarnessRuntimeController} controller - Runtime controller for emitting signals and inspecting active runs.
   *
   * @returns {Promise<ControlPlaneHandle>} Handle with `.close()` to disconnect Socket Mode.
   */
  connectSocketMode?(
    appToken: string,
    controller: HarnessRuntimeController,
  ): Promise<ControlPlaneHandle>;
}
