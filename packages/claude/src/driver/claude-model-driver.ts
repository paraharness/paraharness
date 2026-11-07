import type {
  AppendToolResultNotesOptions,
  ClaudeModelNode,
  ForkContext,
  ModelDriver,
  ModelTurnRequest,
  ModelTurnResponse,
  PrepareForkTarget,
  RuntimeDriverContext,
  WireFrameRecord,
} from '@harness-dsl/core';
import type { ClaudeHttpTransport } from './claude-http-transport.js';
import {
  ANTHROPIC_MESSAGES_ENDPOINT,
  defaultClaudeHttpTransport,
} from './default-claude-http-transport.constants.js';
import {
  appendClaudeToolResultNotes,
  prepareClaudeForkFrames,
} from './internal/claude-fork-and-notes.js';
import { parseClaudeRetryAfterResetAtMs } from './internal/claude-http-transport.js';
import {
  buildAnthropicMessagesRequest,
  parseAnthropicMessagesResponse,
} from './internal/claude-wire-converter.js';
import { resolveClaudeSeatAuth } from './internal/claude-wire-helpers.js';

/**
 * Runtime `ModelDriver` implementation for the Anthropic `/v1/messages` HTTP protocol (`@harness-dsl/claude`).
 *
 * Resolves CLI subscription `configDir` OAuth tokens and `EnvRef` API keys at turn invocation time,
 * preserves `thinking` blocks and cryptographic `signature` fields in `rawWireFrame`, enforces native
 * `output_config.format` JSON-schema structured output, and prepares KV-cache-preserving forks.
 */
export class ClaudeModelDriver implements ModelDriver {
  /** Primary vendor identifier (`'anthropic'`). */
  readonly vendorId = 'anthropic' as const;

  /** Vendor alias matching `vendorId` (`'anthropic'`). */
  readonly vendor = 'anthropic' as const;

  /** Underlying HTTP transport used to dispatch `/v1/messages` requests. */
  private readonly transport: ClaudeHttpTransport;

  /** Optional passive `ClaudeModelNode` bound to this driver instance. */
  private readonly modelNode: ClaudeModelNode | undefined;

  /** Optional runtime driver context providing `resolveEnv` for symbolic `EnvRef` keys. */
  private readonly driverCtx: RuntimeDriverContext | undefined;

  /**
   * Initializes a `ClaudeModelDriver` with an HTTP transport, optional `ClaudeModelNode`, and runtime context.
   *
   * Defers all credential and environment variable lookups until `invokeTurn()` is executed.
   *
   * @param {ClaudeHttpTransport}              [transport=defaultClaudeHttpTransport] - HTTP transport for `/v1/messages`.
   * @param {ClaudeModelNode | undefined}      [modelNode]                            - Optional bound `ClaudeModelNode`.
   * @param {RuntimeDriverContext | undefined} [driverCtx]                            - Optional runtime driver context.
   */
  constructor(
    transport: ClaudeHttpTransport = defaultClaudeHttpTransport,
    modelNode?: ClaudeModelNode,
    driverCtx?: RuntimeDriverContext,
  ) {
    this.transport = transport;
    this.modelNode = modelNode;
    this.driverCtx = driverCtx;
  }

  /**
   * Invokes a single Anthropic `/v1/messages` turn over `req.history` and returns the raw wire frame and canonical projection.
   *
   * Validates HTTP status codes before parsing `bodyText` so non-JSON error payloads (`502 Bad Gateway`) never crash
   * with `SyntaxError`, and propagates HTTP `429` rate-limit responses with `{ status: 429, resetAtMs }`.
   *
   * @param {ModelTurnRequest} req - Turn request payload, wire prefix, and structured output schema.
   *
   * @returns {Promise<ModelTurnResponse>} Raw wire response, canonical message, structured output, and usage metrics.
   */
  async invokeTurn(req: ModelTurnRequest): Promise<ModelTurnResponse> {
    const auth = resolveClaudeSeatAuth(req.accountConfig, this.modelNode, (val) =>
      this.driverCtx?.resolveEnv(val),
    );
    const body = buildAnthropicMessagesRequest(req);
    const response = await this.transport.sendMessagesRequest({
      url: ANTHROPIC_MESSAGES_ENDPOINT,
      headers: auth.headers,
      body,
      seatId: auth.seatId,
      authSource: auth.authSource,
      signal: req.signal,
    });
    const resetAtMs =
      response.resetAtMs ??
      parseClaudeRetryAfterResetAtMs(
        response.headers?.['retry-after'] ?? response.headers?.['Retry-After'],
      );
    if (response.status === 429) {
      throw Object.assign(
        new Error(
          `Anthropic /v1/messages rate limit (429) on model '${req.modelId}' (seat '${auth.seatId ?? 'default'}').`,
        ),
        { status: 429, resetAtMs: resetAtMs ?? Date.now() + 60_000 },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      const detail =
        response.bodyText !== undefined && response.bodyText.trim().length > 0
          ? `: ${response.bodyText.trim()}`
          : '';
      throw Object.assign(
        new Error(
          `Anthropic /v1/messages failed with HTTP ${String(response.status)} for model '${req.modelId}'${detail}.`,
        ),
        { status: response.status },
      );
    }
    const parsedBody =
      response.body ??
      (response.bodyText !== undefined && response.bodyText.trim().length > 0
        ? (JSON.parse(response.bodyText) as Readonly<Record<string, unknown>>)
        : Object.freeze({}));
    return parseAnthropicMessagesResponse(parsedBody, req);
  }

  /**
   * Synthesizes the initial `WireFrameRecord[]` chain for a downward fork or cross-model escalation.
   *
   * Preserves byte-identical `rawWireFrame` payloads with `cache_control: { type: 'ephemeral' }` when
   * `target.substituteTombstones === false`, and re-projects `CanonicalMessage` frames with compacted
   * tombstones when `target.substituteTombstones === true`.
   *
   * @param {ForkContext}       ctx    - Fork lineage, history mode, and assistant turn-batch pairing metadata.
   * @param {PrepareForkTarget} target - Target model configuration and tombstone substitution flag.
   *
   * @returns {Promise<readonly WireFrameRecord[]>} Synthesized wire frame chain to persist in `LedgerStore`.
   */
  prepareFork(ctx: ForkContext, target: PrepareForkTarget): Promise<readonly WireFrameRecord[]> {
    return Promise.resolve(prepareClaudeForkFrames(ctx, target));
  }

  /**
   * Appends synchronization or recovery notes in-place to an Anthropic `role: 'tool'` or `role: 'user'` frame.
   *
   * Updates both `rawWireFrame` and `frame.canonical` without breaking conversation role alternation.
   *
   * @param {WireFrameRecord}                          frame        - Existing `tool` or `user` wire frame record.
   * @param {readonly string[]}                        notes        - Synchronization note strings to append.
   * @param {string | undefined}                       targetCallId - Optional tool `callId` to target on a `tool` frame.
   * @param {AppendToolResultNotesOptions | undefined} opts         - Optional error status override.
   *
   * @returns {Promise<WireFrameRecord>} Updated wire frame record to persist via `LedgerStore.replaceMessageFrame()`.
   */
  appendToolResultNotes(
    frame: WireFrameRecord,
    notes: readonly string[],
    targetCallId?: string,
    opts?: AppendToolResultNotesOptions,
  ): Promise<WireFrameRecord> {
    return Promise.resolve(appendClaudeToolResultNotes(frame, notes, targetCallId, opts));
  }
}
