import type { EnvRef } from '@paraharness/core';

/**
 * Configuration options for the bidirectional Slack Socket Mode bot builder (`slack.bot`).
 *
 * Specifies the Slack Socket Mode app-level token (`xapp-...`), bot token (`xoxb-...`),
 * and target Slack channel ID or symbolic `P.env(...)` references.
 */
export interface SlackBotOptions {
  /** Slack Socket Mode app-level token (`xapp-...`) or symbolic `P.env(...)` reference. */
  readonly appToken: string | EnvRef;
  /** Slack bot user OAuth token (`xoxb-...`) or symbolic `P.env(...)` reference. */
  readonly botToken: string | EnvRef;
  /** Target Slack channel ID or symbolic `P.env(...)` reference. */
  readonly channel: string | EnvRef;
}
