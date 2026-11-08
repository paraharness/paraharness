import type { EnvRef, SlackApproverNode, SlackNotifierNode } from '@metaharness/core';
import type { SlackBotOptions } from './slack-bot-options.js';

/**
 * Public DSL builder namespace for `@metaharness/slack` (`slack.*`).
 *
 * Exposes declarative factories for bidirectional Slack Socket Mode bots (`slack.bot`)
 * and one-way incoming webhook notification channels (`slack.webhook`).
 */
export interface SlackNamespace {
  /**
   * Creates a passive `SlackApproverNode` with `interactionMode: 'bidirectional'`.
   *
   * Supports outbound notifications, interactive `.ask()` / `.escalate()` decisions,
   * keep-alive heartbeats, `cancelDecision`, and Socket Mode control-plane signals.
   *
   * @param {SlackBotOptions} options - App token, bot token, and target Slack channel configuration.
   *
   * @returns {SlackApproverNode} Frozen passive bidirectional Slack bot AST node.
   */
  bot(options: SlackBotOptions): SlackApproverNode;

  /**
   * Creates a passive `SlackNotifierNode` with `interactionMode: 'notify-only'`.
   *
   * Dispatches outbound notifications via Slack incoming webhooks while statically forbidding
   * bidirectional `.ask()` or `.escalate()` usage at AST validation time.
   *
   * @param {string | EnvRef} webhookUrl - Slack incoming webhook URL or symbolic `M.env(...)` reference.
   *
   * @returns {SlackNotifierNode} Frozen passive notify-only Slack webhook AST node.
   */
  webhook(webhookUrl: string | EnvRef): SlackNotifierNode;
}
