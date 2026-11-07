/**
 * Target Slack message coordinates for periodic thread heartbeats and abort updates.
 *
 * Identifies the bot token, channel ID, and parent Slack message timestamp (`ts`).
 */
export interface SlackDecisionMessageTarget {
  /** Resolved Slack bot token (`xoxb-...`). */
  readonly botToken: string;
  /** Resolved Slack channel identifier. */
  readonly channel: string;
  /** Parent Slack message timestamp (`ts`). */
  readonly messageTs: string;
}
