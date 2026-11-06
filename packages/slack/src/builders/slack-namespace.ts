import { createSlackBotBuilder } from './create-slack-bot-builder.js';
import { createSlackWebhookBuilder } from './create-slack-webhook-builder.js';
import type { SlackNamespace } from './slack-namespace-contract.js';

/** Frozen `@harness-dsl/slack` DSL namespace singleton (`slack.bot`, `slack.webhook`). */
export const slack: SlackNamespace = Object.freeze<SlackNamespace>({
  bot: createSlackBotBuilder,
  webhook: createSlackWebhookBuilder,
});
