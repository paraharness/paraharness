import type { BaseControlPlaneASTNode } from '../base/base-control-plane-ast-node.js';
import type { BaseHumanChannelASTNode } from '../base/base-human-channel-ast-node.js';
import type { EnvRef } from '../env-ref.js';

/**
 * Passive AST node configuring a bidirectional Slack Socket Mode human approver and control plane (`slack.bot`).
 *
 * Connects over Slack Socket Mode using `appToken` and `botToken` to deliver interactive
 * escalation/approval prompts and receive validated human decisions in `channel`.
 */
export interface SlackApproverNode
  extends BaseHumanChannelASTNode<'slack:approver', 'bidirectional'>,
    BaseControlPlaneASTNode<'slack:approver'> {
  /** Slack Socket Mode app-level token (`xapp-...`) or symbolic `EnvRef`. */
  readonly appToken: string | EnvRef;
  /** Slack bot token (`xoxb-...`) or symbolic `EnvRef`. */
  readonly botToken: string | EnvRef;
  /** Target Slack channel ID or symbolic `EnvRef`. */
  readonly channel: string | EnvRef;
}
