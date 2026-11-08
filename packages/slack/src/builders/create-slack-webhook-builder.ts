import type { EnvRef, SlackNotifierNode } from '@metaharness/core';

/**
 * Compiles a passive `SlackNotifierNode` for a one-way Slack incoming webhook (`slack.webhook`).
 *
 * Produces a frozen AST node with `type: 'slack:notifier'` and `interactionMode: 'notify-only'`
 * used for outbound signal alerts without interactive human decision prompts.
 *
 * @param {string | EnvRef} webhookUrl - Slack incoming webhook URL or symbolic `M.env(...)` reference.
 *
 * @returns {SlackNotifierNode} Frozen passive Slack webhook notifier AST node.
 *
 * @throws {Error} If a literal `webhookUrl` string is empty.
 */
export function createSlackWebhookBuilder(webhookUrl: string | EnvRef): SlackNotifierNode {
  if (typeof webhookUrl === 'string' && webhookUrl.trim().length === 0) {
    throw new Error('Invalid webhookUrl in slack.webhook: literal webhookUrl must be non-empty.');
  }
  return Object.freeze<SlackNotifierNode>({
    type: 'slack:notifier',
    interactionMode: 'notify-only',
    webhookUrl,
  });
}
