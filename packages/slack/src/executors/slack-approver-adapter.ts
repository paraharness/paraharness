import type {
  ActiveRunSummary,
  ControlPlaneAdapter,
  ControlPlaneHandle,
  HarnessRuntimeController,
  HumanAdapter,
  HumanDecisionRequest,
  RuntimeDriverContext,
  SlackApproverNode,
} from '@metaharness/core';
import { defaultSlackTransport } from './default-slack-transport.constants.js';
import { buildSlackDecisionKey } from './internal/build-slack-decision-key.js';
import { buildSlackDecisionMessagePayload } from './internal/build-slack-decision-message-payload.js';
import { cleanupPendingSlackDecision } from './internal/cleanup-pending-slack-decision.js';
import type { PendingSlackDecisionEntry } from './internal/pending-slack-decision-entry.js';
import { registerPendingSlackDecisionAbortListener } from './internal/register-pending-slack-decision-abort-listener.js';
import { resolveRequiredSlackSecret } from './internal/resolve-required-slack-secret.js';
import { startSlackDecisionHeartbeat } from './internal/start-slack-decision-heartbeat.js';
import type { SlackTransport } from './slack-transport.js';

/**
 * Bidirectional Slack Socket Mode `HumanAdapter` and `ControlPlaneAdapter` (`slack:approver`).
 *
 * Delivers outbound notifications, posts interactive Block Kit decision blocks with optional keep-alive
 * heartbeats, cancels superseded prompts via `cancelDecision`, and bridges Socket Mode control-plane signals.
 */
export class SlackApproverAdapter implements HumanAdapter, ControlPlaneAdapter {
  /** Passive `SlackApproverNode` configuration. */
  private readonly node: SlackApproverNode;
  /** Runtime driver context used for late-bound `EnvRef` resolution. */
  private readonly ctx: RuntimeDriverContext;
  /** Slack Web API and Socket Mode transport implementation. */
  private readonly transport: SlackTransport;
  /** Pre-indexed map of pending interactive decisions keyed by `"${runId}:${requestId}"`. */
  private readonly pendingByKey = new Map<string, PendingSlackDecisionEntry>();
  /** Pre-indexed lookup from `requestId` to composite `"${runId}:${requestId}"` key for $O(1)$ Socket Mode routing. */
  private readonly pendingKeyByRequestId = new Map<string, string>();
  /** Active `HarnessRuntimeController` bound while the Socket Mode control plane is running. */
  private activeController: HarnessRuntimeController | undefined;

  /**
   * Initializes a `SlackApproverAdapter` bound to `node`, `ctx`, and `transport`.
   *
   * Resolves `appToken`, `botToken`, and `channel` lazily at invocation time via `ctx.resolveEnv`.
   *
   * @param {SlackApproverNode}    node                              - Passive Slack approver AST node.
   * @param {RuntimeDriverContext} ctx                               - Runtime driver context.
   * @param {SlackTransport}       [transport=defaultSlackTransport] - Pluggable Slack transport.
   */
  constructor(
    node: SlackApproverNode,
    ctx: RuntimeDriverContext,
    transport: SlackTransport = defaultSlackTransport,
  ) {
    this.node = node;
    this.ctx = ctx;
    this.transport = transport;
  }

  /**
   * Sends a one-way notification message to `node.channel` via `chat.postMessage`.
   *
   * Resolves `botToken` and `channel` from `ctx.resolveEnv` before invoking `transport.postMessage`.
   *
   * @param {string} message - Formatted notification text to post.
   *
   * @returns {Promise<void>} Resolves once the message is delivered to Slack.
   *
   * @throws {Error} If `botToken` or `channel` resolution fails or Slack delivery fails.
   */
  async notify(message: string): Promise<void> {
    const botToken = resolveRequiredSlackSecret(
      this.node.botToken,
      (v) => this.ctx.resolveEnv(v),
      'botToken',
    );
    const channel = resolveRequiredSlackSecret(
      this.node.channel,
      (v) => this.ctx.resolveEnv(v),
      'channel',
    );
    await this.transport.postMessage(botToken, channel, {
      kind: 'notification',
      text: message,
    });
  }

  /**
   * Posts an interactive Block Kit decision block to Slack and awaits a schema-validated human response.
   *
   * Emits periodic thread heartbeat pings when `req.keepAliveSeconds` is configured and cleans
   * up deterministic timers and `AbortSignal` listeners inside `finally`.
   *
   * @template TRequest  Request brief payload type.
   * @template TResponse Validated response payload type.
   *
   * @param {HumanDecisionRequest<TRequest, TResponse>} req - Decision request descriptor and response schema.
   *
   * @returns {Promise<TResponse>} Schema-validated human decision response.
   *
   * @throws {Error} If `req.signal` aborts, `cancelDecision` supersedes the request, or credential resolution fails.
   */
  async requestDecision<TRequest, TResponse>(
    req: HumanDecisionRequest<TRequest, TResponse>,
  ): Promise<TResponse> {
    req.signal?.throwIfAborted();
    const botToken = resolveRequiredSlackSecret(
      this.node.botToken,
      (v) => this.ctx.resolveEnv(v),
      'botToken',
    );
    const channel = resolveRequiredSlackSecret(
      this.node.channel,
      (v) => this.ctx.resolveEnv(v),
      'channel',
    );
    const key = buildSlackDecisionKey(req.runId, req.requestId);
    const posted = await this.transport.postMessage(
      botToken,
      channel,
      buildSlackDecisionMessagePayload(req),
    );
    const target = Object.freeze({ botToken, channel, messageTs: posted.ts });
    const heartbeatTimer = startSlackDecisionHeartbeat(req, this.transport, target);
    let onAbort: (() => void) | undefined;
    try {
      return await new Promise<TResponse>((resolve, reject) => {
        this.pendingByKey.set(key, {
          runId: req.runId,
          requestId: req.requestId,
          botToken,
          channel,
          messageTs: posted.ts,
          responseSchema: req.responseSchema,
          heartbeatTimer,
          resolve: (val: unknown) => resolve(val as TResponse),
          reject,
        });
        this.pendingKeyByRequestId.set(req.requestId, key);
        onAbort = registerPendingSlackDecisionAbortListener({
          req,
          key,
          pendingByKey: this.pendingByKey,
          pendingKeyByRequestId: this.pendingKeyByRequestId,
          transport: this.transport,
          target,
          reject,
        });
      });
    } finally {
      if (onAbort !== undefined && req.signal !== undefined) {
        req.signal.removeEventListener('abort', onAbort);
      }
      this.pendingKeyByRequestId.delete(req.requestId);
      cleanupPendingSlackDecision(this.pendingByKey, key);
    }
  }

  /**
   * Cancels an in-flight decision request, marks the Slack message superseded, and rejects the pending promise.
   *
   * Safe to call idempotently when `(runId, requestId)` has already settled.
   *
   * @param {string} runId     - Identifier of the harness run owning the request.
   * @param {string} requestId - Identifier of the decision request to cancel.
   *
   * @returns {Promise<void>} Resolves once the Slack message has been updated and pending state cleared.
   */
  async cancelDecision(runId: string, requestId: string): Promise<void> {
    const key = buildSlackDecisionKey(runId, requestId);
    this.pendingKeyByRequestId.delete(requestId);
    const removed = cleanupPendingSlackDecision(this.pendingByKey, key);
    if (removed === undefined) {
      return;
    }
    await this.transport.updateMessage(removed.botToken, removed.channel, {
      ts: removed.messageTs,
      status: 'cancelled',
      runId,
      requestId,
      text: `[CANCELLED] Decision request '${requestId}' for run '${runId}' was superseded.`,
    });
    removed.reject(
      new Error(
        `Slack decision request '${requestId}' for run '${runId}' was cancelled and superseded.`,
      ),
    );
  }

  /**
   * Submits an interactive human response for `(runId, requestId)` and validates it against `responseSchema`.
   *
   * Invoked by the Socket Mode interaction handler when a human operator submits a decision block.
   *
   * @param {string}  runId       - Enclosing harness run identifier (or `''` to resolve via `requestId` index).
   * @param {string}  requestId   - Decision request identifier.
   * @param {unknown} rawResponse - Raw response payload submitted by the human operator.
   *
   * @returns {void}
   *
   * @throws {Error} If no pending decision exists for `(runId, requestId)` or `rawResponse` fails `responseSchema`.
   */
  submitDecision(runId: string, requestId: string, rawResponse: unknown): void {
    const directKey = buildSlackDecisionKey(runId, requestId);
    const resolvedKey = this.pendingByKey.has(directKey)
      ? directKey
      : (this.pendingKeyByRequestId.get(requestId) ?? directKey);
    const entry = this.pendingByKey.get(resolvedKey);
    if (entry === undefined) {
      throw new Error(
        `No pending Slack decision request found for run '${runId}', request '${requestId}'.`,
      );
    }
    const validated = entry.responseSchema.parse(rawResponse);
    this.pendingKeyByRequestId.delete(entry.requestId);
    cleanupPendingSlackDecision(this.pendingByKey, resolvedKey);
    entry.resolve(validated);
  }

  /**
   * Starts the Slack Socket Mode control-plane listener bound to `runtime`.
   *
   * Resolves `appToken` via `ctx.resolveEnv` and connects Socket Mode for inbound interactive actions and signals.
   *
   * @param {HarnessRuntimeController} runtime - Active runtime controller for signals and run queries.
   *
   * @returns {Promise<ControlPlaneHandle>} Handle with `.close()` to stop the Socket Mode listener.
   *
   * @throws {Error} If `appToken` resolution fails or Socket Mode connection fails.
   */
  async start(runtime: HarnessRuntimeController): Promise<ControlPlaneHandle> {
    const appToken = resolveRequiredSlackSecret(
      this.node.appToken,
      (v) => this.ctx.resolveEnv(v),
      'appToken',
    );
    this.activeController = runtime;
    const underlyingHandle =
      this.transport.connectSocketMode !== undefined
        ? await this.transport.connectSocketMode(
            appToken,
            runtime,
            (runId, requestId, responsePayload) => {
              this.submitDecision(runId, requestId, responsePayload);
            },
          )
        : undefined;
    return Object.freeze<ControlPlaneHandle>({
      close: async (): Promise<void> => {
        this.activeController = undefined;
        if (underlyingHandle !== undefined) {
          await underlyingHandle.close();
        }
      },
    });
  }

  /**
   * Dispatches an inbound control-plane signal received over Slack Socket Mode into the active runtime.
   *
   * Throws an actionable error if the control plane has not been started or has already been closed.
   *
   * @template TPayload Signal payload type.
   *
   * @param {string}   signalId - Target signal identifier.
   * @param {TPayload} payload  - Signal payload emitted by the Slack operator.
   *
   * @returns {Promise<void>} Resolves once `runtime.emitSignal` completes.
   *
   * @throws {Error} If the Slack Socket Mode control plane is not currently active.
   */
  async dispatchSignal<TPayload>(signalId: string, payload: TPayload): Promise<void> {
    if (this.activeController === undefined) {
      throw new Error(
        `Cannot dispatch signal '${signalId}': Slack Socket Mode control plane is not active.`,
      );
    }
    await this.activeController.emitSignal(signalId, payload);
  }

  /**
   * Queries active harness runs through the bound `HarnessRuntimeController`.
   *
   * Used by Slack control-plane slash commands to inspect active lane runs.
   *
   * @returns {Promise<ReadonlyArray<ActiveRunSummary>>} Active run summaries from the runtime controller.
   *
   * @throws {Error} If the Slack Socket Mode control plane is not currently active.
   */
  async getActiveRuns(): Promise<ReadonlyArray<ActiveRunSummary>> {
    if (this.activeController === undefined) {
      throw new Error('Cannot query active runs: Slack Socket Mode control plane is not active.');
    }
    return this.activeController.getActiveRuns();
  }
}
