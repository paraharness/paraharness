import type { BaseHumanChannelASTNode } from '../base/base-human-channel-ast-node.js';
import type { EnvRef } from '../env-ref.js';

/**
 * Passive AST node configuring a one-way notify-only Slack incoming webhook channel (`slack.webhook`).
 *
 * Dispatches outbound signal notifications to `webhookUrl` without supporting bidirectional
 * `.ask()` or `.escalate()` decision prompts.
 */
export interface SlackNotifierNode
  extends BaseHumanChannelASTNode<'slack:notifier', 'notify-only'> {
  /** Slack incoming webhook URL or symbolic `EnvRef`. */
  readonly webhookUrl: string | EnvRef;
}
