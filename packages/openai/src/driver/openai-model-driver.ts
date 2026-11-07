import type {
  AppendToolResultNotesOptions,
  ForkContext,
  ModelDriver,
  ModelTurnRequest,
  ModelTurnResponse,
  OpenAiModelNode,
  PrepareForkTarget,
  RuntimeDriverContext,
  WireFrameRecord,
} from '@harness-dsl/core';
import {
  OPENAI_RESPONSES_ENDPOINT,
  defaultOpenAiHttpTransport,
} from './default-openai-http-transport.constants.js';
import {
  appendOpenAiToolResultNotes,
  prepareOpenAiForkFrames,
} from './internal/openai-fork-and-notes.js';
import { parseOpenAiRetryAfterResetAtMs } from './internal/openai-http-transport.js';
import {
  buildOpenAiResponsesRequest,
  parseOpenAiResponsesOutput,
} from './internal/openai-wire-converter.js';
import { resolveOpenAiSeatAuth } from './internal/openai-wire-helpers.js';
import type { OpenAiHttpTransport } from './openai-http-transport.js';

/**
 * Runtime `ModelDriver` implementation for the OpenAI `/v1/responses` HTTP protocol (`@harness-dsl/openai`).
 *
 * Supports native `text.format` JSON-schema structured output, `previous_response_id` server-side branching,
 * automatic cross-seat failover stripping of account-bound `previous_response_id`, item IDs (`rs_...`, `fc_...`, `msg_...`),
 * and `encrypted_content`, and full-turn `(1..k)` `function_call_output` pairing in `prepareFork()`.
 */
export class OpenAiModelDriver implements ModelDriver {
  /** Primary vendor identifier (`'openai'`). */
  readonly vendorId = 'openai' as const;

  /** Vendor alias matching `vendorId` (`'openai'`). */
  readonly vendor = 'openai' as const;

  /** Underlying HTTP transport used to dispatch `/v1/responses` requests. */
  private readonly transport: OpenAiHttpTransport;

  /** Optional passive `OpenAiModelNode` bound to this driver instance. */
  private readonly modelNode: OpenAiModelNode | undefined;

  /** Optional runtime driver context providing `resolveEnv` for symbolic `EnvRef` keys. */
  private readonly driverCtx: RuntimeDriverContext | undefined;

  /**
   * Initializes an `OpenAiModelDriver` with an HTTP transport, optional `OpenAiModelNode`, and runtime context.
   *
   * Defers all credential and environment variable lookups until `invokeTurn()` is executed.
   *
   * @param {OpenAiHttpTransport}              [transport] - HTTP transport for `/v1/responses`.
   * @param {OpenAiModelNode | undefined}      [modelNode] - Optional bound `OpenAiModelNode`.
   * @param {RuntimeDriverContext | undefined} [driverCtx] - Optional runtime driver context.
   */
  constructor(
    transport: OpenAiHttpTransport = defaultOpenAiHttpTransport,
    modelNode?: OpenAiModelNode,
    driverCtx?: RuntimeDriverContext,
  ) {
    this.transport = transport;
    this.modelNode = modelNode;
    this.driverCtx = driverCtx;
  }

  /**
   * Invokes a single OpenAI `/v1/responses` turn over `req.history` and returns the raw wire frame and canonical projection.
   *
   * Validates HTTP status codes before parsing `bodyText` so non-JSON error payloads never crash with `SyntaxError`,
   * automatically strips account-bound state on cross-seat failover, and propagates HTTP `429` with `{ status: 429, resetAtMs }`.
   *
   * @param {ModelTurnRequest} req - Turn request payload, wire prefix, and structured output schema.
   *
   * @returns {Promise<ModelTurnResponse>} Raw wire response, canonical message, structured output, and usage metrics.
   */
  async invokeTurn(req: ModelTurnRequest): Promise<ModelTurnResponse> {
    const auth = resolveOpenAiSeatAuth(req.accountConfig, this.modelNode, (val) =>
      this.driverCtx?.resolveEnv(val),
    );
    const body = buildOpenAiResponsesRequest(req, auth.seatId);
    const response = await this.transport.sendResponsesRequest({
      url: OPENAI_RESPONSES_ENDPOINT,
      headers: auth.headers,
      body,
      seatId: auth.seatId,
      authSource: auth.authSource,
      signal: req.signal,
    });
    const resetAtMs =
      response.resetAtMs ??
      parseOpenAiRetryAfterResetAtMs(
        response.headers?.['retry-after'] ?? response.headers?.['Retry-After'],
      );
    if (response.status === 429) {
      throw Object.assign(
        new Error(
          `OpenAI /v1/responses rate limit (429) on model '${req.modelId}' (seat '${auth.seatId ?? 'default'}').`,
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
          `OpenAI /v1/responses failed with HTTP ${String(response.status)} for model '${req.modelId}'${detail}.`,
        ),
        { status: response.status },
      );
    }
    const parsedBody =
      response.body ??
      (response.bodyText !== undefined && response.bodyText.trim().length > 0
        ? (JSON.parse(response.bodyText) as Readonly<Record<string, unknown>>)
        : Object.freeze({}));
    return parseOpenAiResponsesOutput(parsedBody, req, auth.seatId);
  }

  /**
   * Synthesizes the initial `WireFrameRecord[]` chain for a downward fork or cross-model escalation.
   *
   * Preserves `previous_response_id`, server item IDs, and `encrypted_content` on same-model, same-seat forks
   * (`substituteTombstones: false`) and strips them when `substituteTombstones: true` or across distinct seats.
   *
   * @param {ForkContext}       ctx    - Fork lineage, history mode, and assistant turn-batch pairing metadata.
   * @param {PrepareForkTarget} target - Target model configuration and tombstone substitution flag.
   *
   * @returns {Promise<readonly WireFrameRecord[]>} Synthesized wire frame chain to persist in `LedgerStore`.
   */
  prepareFork(ctx: ForkContext, target: PrepareForkTarget): Promise<readonly WireFrameRecord[]> {
    return Promise.resolve(prepareOpenAiForkFrames(ctx, target));
  }

  /**
   * Appends synchronization or recovery notes in-place to an OpenAI `role: 'tool'` or `role: 'user'` frame.
   *
   * Updates both `rawWireFrame` (`function_call_output` or user message items) and `frame.canonical`.
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
    return Promise.resolve(appendOpenAiToolResultNotes(frame, notes, targetCallId, opts));
  }
}
