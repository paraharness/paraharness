import type {
  HumanAdapter,
  HumanDecisionRequest,
  RuntimeDriverContext,
  SlackNotifierNode,
} from '@harness-dsl/core';
import { defaultSlackTransport } from './default-slack-transport.constants.js';
import { resolveRequiredSlackSecret } from './internal/resolve-slack-env.js';
import type { SlackTransport } from './slack-transport.js';

/**
 * One-way notify-only Slack incoming webhook `HumanAdapter` (`slack:notifier`).
 *
 * Delivers outbound notifications via `transport.postWebhook` and rejects any attempt
 * to invoke interactive `requestDecision` prompts on a `'notify-only'` channel.
 */
export class SlackNotifierAdapter implements HumanAdapter {
  /** Passive `SlackNotifierNode` configuration. */
  private readonly node: SlackNotifierNode;

  /** Runtime driver context used for late-bound `EnvRef` resolution. */
  private readonly ctx: RuntimeDriverContext;

  /** Slack transport implementation. */
  private readonly transport: SlackTransport;

  /**
   * Initializes a `SlackNotifierAdapter` bound to `node`, `ctx`, and `transport`.
   *
   * Resolves `node.webhookUrl` lazily on each `notify()` call via `ctx.resolveEnv`.
   *
   * @param {SlackNotifierNode}    node                              - Passive Slack notifier AST node.
   * @param {RuntimeDriverContext} ctx                               - Runtime driver context.
   * @param {SlackTransport}       [transport=defaultSlackTransport] - Pluggable Slack transport.
   */
  constructor(
    node: SlackNotifierNode,
    ctx: RuntimeDriverContext,
    transport: SlackTransport = defaultSlackTransport,
  ) {
    this.node = node;
    this.ctx = ctx;
    this.transport = transport;
  }

  /**
   * Sends a one-way notification message to `node.webhookUrl`.
   *
   * Resolves `webhookUrl` from `ctx.resolveEnv` before invoking `transport.postWebhook`.
   *
   * @param {string} message - Formatted notification text to deliver.
   *
   * @returns {Promise<void>} Resolves once the incoming webhook POST completes.
   */
  async notify(message: string): Promise<void> {
    const webhookUrl = resolveRequiredSlackSecret(
      this.node.webhookUrl,
      (val) => this.ctx.resolveEnv(val),
      'webhookUrl',
    );
    await this.transport.postWebhook(webhookUrl, message);
  }

  /**
   * Rejects interactive decision requests on a one-way `'notify-only'` Slack webhook channel.
   *
   * Enforces at runtime the same `'notify-only'` invariant verified statically by `@harness-dsl/core`.
   *
   * @template TRequest  Request brief payload type.
   * @template TResponse Validated response payload type.
   *
   * @param {HumanDecisionRequest<TRequest, TResponse>} req - Attempted decision request.
   *
   * @returns {Promise<TResponse>} Always rejects with an actionable domain error.
   */
  async requestDecision<TRequest, TResponse>(
    req: HumanDecisionRequest<TRequest, TResponse>,
  ): Promise<TResponse> {
    throw new Error(
      `SlackNotifierAdapter ('slack:notifier', interactionMode 'notify-only') cannot handle interactive requestDecision '${req.requestId}' for run '${req.runId}' (human '${req.humanId}'). Use slack.bot(...) ('slack:approver') for bidirectional decisions.`,
    );
  }
}
