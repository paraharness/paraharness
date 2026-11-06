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
import {
  appendGeminiToolResultNotes,
  prepareGeminiForkFrames,
} from './internal/gemini-fork-and-notes.js';
import {
  buildGeminiGenerateContentRequest,
  parseGeminiGenerateContentResponse,
} from './internal/gemini-wire-converter.js';
import { resolveGeminiSeatAuth } from './internal/gemini-wire-helpers.js';

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
   * @param {GeminiHttpTransport}              [transport] - HTTP transport for `generateContent`.
   * @param {GeminiModelNode | undefined}      [modelNode] - Optional bound `GeminiModelNode`.
   * @param {RuntimeDriverContext | undefined} [driverCtx] - Optional runtime driver context.
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
   * Propagates HTTP `429` rate-limit responses with `{ status: 429, resetAtMs }` so `PoolManager` can fail over across seats.
   *
   * @param {ModelTurnRequest} req - Turn request payload, wire prefix, and structured output schema.
   *
   * @returns {Promise<ModelTurnResponse>} Raw wire response, canonical message, structured output, and usage metrics.
   */
  async invokeTurn(req: ModelTurnRequest): Promise<ModelTurnResponse> {
    const auth = resolveGeminiSeatAuth(req.accountConfig, this.modelNode, (val) =>
      this.driverCtx?.resolveEnv(val),
    );
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
    if (response.status === 429) {
      throw Object.assign(
        new Error(
          `Gemini generateContent rate limit (429) on model '${req.modelId}' (seat '${auth.seatId ?? 'default'}').`,
        ),
        { status: 429, resetAtMs: response.resetAtMs ?? Date.now() + 60_000 },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(
        new Error(
          `Gemini generateContent failed with HTTP ${String(response.status)} for model '${req.modelId}'.`,
        ),
        { status: response.status },
      );
    }
    return parseGeminiGenerateContentResponse(response.body, req);
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
    return Promise.resolve(prepareGeminiForkFrames(ctx, target));
  }

  /**
   * Appends synchronization or recovery notes in-place to a Gemini `role: 'tool'` or `role: 'user'` frame.
   *
   * Updates both `rawWireFrame` (`functionResponse` or `{ text }` parts) and `frame.canonical`.
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
    return Promise.resolve(appendGeminiToolResultNotes(frame, notes, targetCallId, opts));
  }
}
