import type {
  AppendToolResultNotesOptions,
  ForkContext,
  GeminiModelNode,
  ModelDriver,
  ModelTurnRequest,
  ModelTurnResponse,
  PrepareForkTarget,
  RuntimeDriverContext,
  WireFrameRecord,
} from '@harness-dsl/core';
import {
  GEMINI_API_BASE_URL,
  defaultGeminiHttpTransport,
} from './default-gemini-http-transport.constants.js';
import type { GeminiHttpTransport } from './gemini-http-transport.js';
import { extractGeminiResponseBody } from './internal/extract-gemini-response-body.js';
import { geminiAppendToolResultNotes } from './internal/gemini-append-tool-result-notes.js';
import { geminiPrepareFork } from './internal/gemini-prepare-fork.js';
import {
  buildGeminiGenerateContentRequest,
  parseGeminiGenerateContentResponse,
} from './internal/gemini-wire-converter.js';
import { resolveGeminiSeatAuth } from './internal/resolve-gemini-seat-auth.js';

/**
 * Runtime `ModelDriver` implementation for the Google Gemini `generateContent` HTTP protocol (`@harness-dsl/gemini`).
 *
 * Maps `CompiledWirePrefix` to `systemInstruction` and `tools: [{ functionDeclarations }]`, preserves
 * `thought: true` and cryptographic `thoughtSignature` fields on same-model turns and forks, enforces
 * strict `user` / `model` role alternation, and supports native `responseJsonSchema` structured output.
 */
export class GeminiModelDriver implements ModelDriver {
  /** Primary vendor identifier (`'google'`). */
  readonly vendorId = 'google' as const;

  /** Vendor alias matching `vendorId` (`'google'`). */
  readonly vendor = 'google' as const;

  /** Underlying HTTP transport used to dispatch `generateContent` requests. */
  private readonly transport: GeminiHttpTransport;

  /** Optional passive `GeminiModelNode` bound to this driver instance. */
  private readonly modelNode: GeminiModelNode | undefined;

  /** Optional runtime driver context providing `resolveEnv` for symbolic `EnvRef` keys. */
  private readonly driverCtx: RuntimeDriverContext | undefined;

  /**
   * Initializes a `GeminiModelDriver` with an HTTP transport, optional `GeminiModelNode`, and runtime context.
   *
   * Defers all credential and environment variable lookups until `invokeTurn()` is executed.
   *
   * @param {GeminiHttpTransport}              [transport=defaultGeminiHttpTransport] - HTTP transport for `generateContent`.
   * @param {GeminiModelNode | undefined}      [modelNode]                            - Optional bound `GeminiModelNode`.
   * @param {RuntimeDriverContext | undefined} [driverCtx]                            - Optional runtime driver context.
   */
  constructor(
    transport: GeminiHttpTransport = defaultGeminiHttpTransport,
    modelNode?: GeminiModelNode,
    driverCtx?: RuntimeDriverContext,
  ) {
    this.transport = transport;
    this.modelNode = modelNode;
    this.driverCtx = driverCtx;
  }

  /**
   * Invokes a single Gemini `/v1beta/models/{model}:generateContent` turn and returns the raw wire frame and canonical projection.
   *
   * Validates HTTP status codes before parsing `bodyText` so non-JSON error payloads never crash with `SyntaxError`,
   * and propagates HTTP `429` rate-limit responses with `{ status: 429, resetAtMs }`.
   *
   * @param {ModelTurnRequest} req - Turn request payload, wire prefix, and structured output schema.
   *
   * @returns {Promise<ModelTurnResponse>} Raw wire response, canonical message, structured output, and usage metrics.
   *
   * @throws {Error} On HTTP `429` rate limits, non-2xx statuses, aborted signals, or `outputSchema` validation failures.
   */
  async invokeTurn(req: ModelTurnRequest): Promise<ModelTurnResponse> {
    req.signal?.throwIfAborted();
    const auth = resolveGeminiSeatAuth({
      accountConfig: req.accountConfig,
      modelNode: this.modelNode,
      driverCtx: this.driverCtx,
    });
    const body = buildGeminiGenerateContentRequest(req);
    const url = `${GEMINI_API_BASE_URL}/${req.modelId}:generateContent`;
    const response = await this.transport.sendGenerateContentRequest({
      url,
      headers: auth.headers,
      body,
      seatId: auth.seatId,
      authSource: auth.authSource,
      signal: req.signal,
    });
    const responseBody = extractGeminiResponseBody({
      response,
      modelId: req.modelId,
      seatId: auth.seatId,
    });
    return parseGeminiGenerateContentResponse(responseBody, req);
  }

  /**
   * Synthesizes the initial `WireFrameRecord[]` chain for a downward fork or cross-model escalation.
   *
   * Preserves `thought: true` and `thoughtSignature` fields when `target.substituteTombstones === false`
   * and strips them while substituting `compactedTombstones` when `target.substituteTombstones === true`.
   *
   * @param {ForkContext}       ctx    - Fork lineage, history mode, and assistant turn-batch pairing metadata.
   * @param {PrepareForkTarget} target - Target model configuration and tombstone substitution flag.
   *
   * @returns {Promise<readonly WireFrameRecord[]>} Synthesized wire frame chain to persist in `LedgerStore`.
   */
  prepareFork(ctx: ForkContext, target: PrepareForkTarget): Promise<readonly WireFrameRecord[]> {
    return Promise.resolve(geminiPrepareFork(ctx, target));
  }

  /**
   * Appends synchronization or recovery notes in-place to a Gemini `role: 'tool'` or `role: 'user'` frame.
   *
   * Updates both `rawWireFrame` (`functionResponse` or `{ text }` parts) and `frame.canonical`.
   *
   * @param {WireFrameRecord}                          frame          - Existing `tool` or `user` wire frame record.
   * @param {readonly string[]}                        notes          - Synchronization note strings to append.
   * @param {string | undefined}                       [targetCallId] - Optional tool `callId` to target on a `tool` frame.
   * @param {AppendToolResultNotesOptions | undefined} [opts]         - Optional error status override.
   *
   * @returns {Promise<WireFrameRecord>} Updated wire frame record to persist via `LedgerStore.replaceMessageFrame()`.
   */
  appendToolResultNotes(
    frame: WireFrameRecord,
    notes: readonly string[],
    targetCallId?: string,
    opts?: AppendToolResultNotesOptions,
  ): Promise<WireFrameRecord> {
    return Promise.resolve(
      geminiAppendToolResultNotes({ frame, notes, targetCallId, opts }),
    );
  }
}
