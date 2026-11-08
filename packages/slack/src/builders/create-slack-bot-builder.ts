import type { SlackApproverNode } from '@metaharness/core';
import type { SlackBotOptions } from './slack-bot-options.js';

/**
 * Compiles a passive `SlackApproverNode` from `SlackBotOptions` (`slack.bot`).
 *
 * Produces a frozen AST node with `type: 'slack:approver'` and `interactionMode: 'bidirectional'`
 * that satisfies both `HumanChannelASTNode<'bidirectional'>` and `ControlPlaneASTNode`.
 *
 * @param {SlackBotOptions} options - App token, bot token, and target Slack channel configuration.
 *
 * @returns {SlackApproverNode} Frozen passive Slack Socket Mode approver AST node.
 *
 * @throws {Error} If any literal `appToken`, `botToken`, or `channel` string is empty.
 */
export function createSlackBotBuilder(options: SlackBotOptions): SlackApproverNode {
  if (typeof options.appToken === 'string' && options.appToken.trim().length === 0) {
    throw new Error('Invalid appToken in slack.bot: literal appToken must be non-empty.');
  }
  if (typeof options.botToken === 'string' && options.botToken.trim().length === 0) {
    throw new Error('Invalid botToken in slack.bot: literal botToken must be non-empty.');
  }
  if (typeof options.channel === 'string' && options.channel.trim().length === 0) {
    throw new Error('Invalid channel in slack.bot: literal channel must be non-empty.');
  }
  return Object.freeze<SlackApproverNode>({
    type: 'slack:approver',
    interactionMode: 'bidirectional',
    appToken: options.appToken,
    botToken: options.botToken,
    channel: options.channel,
  });
}
