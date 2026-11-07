import type {
  AppendToolResultNotesOptions,
  CanonicalMessage,
  CanonicalToolCall,
  ForkContext,
  ModelDriver,
  ModelTurnRequest,
  ModelTurnResponse,
  PrepareForkTarget,
  WireFrameRecord,
} from '@harness-dsl/core';
import { appendNotesToWireFrame } from './internal/append-notes-to-wire-frame.js';
import { cloneForkWireFrames } from './internal/clone-fork-wire-frames.js';

/**
 * Deterministic `ModelDriver` test double orchestrating scripted multi-turn tool calls and structured outputs (`M4-integration.md` §5).
 *
 * Records every `ModelTurnRequest` received across actors, supports role-aware and turn-indexed scripted
 * responses, and implements KV-cache-preserving `prepareFork` and in-place `appendToolResultNotes`.
 */
export class ScriptedIntegrationModelDriver implements ModelDriver {
  /** Primary vendor identifier (`'anthropic'`). */
  readonly vendorId: 'anthropic' = 'anthropic';

  /** Vendor alias matching `vendorId`. */
  readonly vendor: 'anthropic' = 'anthropic';

  /** Ordered list of all `ModelTurnRequest` payloads received by this driver instance. */
  readonly recordedRequests: ModelTurnRequest[] = [];

  /** Recorded `prepareFork` calls for verifying fork history modes and tombstone substitution. */
  readonly recordedForkCalls: Array<{
    readonly ctx: ForkContext;
    readonly target: PrepareForkTarget;
  }> = [];

  /** User-supplied turn responder callback invoked on each `invokeTurn` call. */
  private readonly turnResponder: (
    req: ModelTurnRequest,
    turnIndex: number,
    driver: ScriptedIntegrationModelDriver,
  ) => ModelTurnResponse | Promise<ModelTurnResponse>;

  /**
   * Initializes a `ScriptedIntegrationModelDriver` with a deterministic turn responder callback.
   *
   * Invokes `turnResponder(req, turnIndex, this)` on each model turn and appends `req` to `recordedRequests`.
   *
   * @param {(req: ModelTurnRequest, turnIndex: number, driver: ScriptedIntegrationModelDriver) => ModelTurnResponse | Promise<ModelTurnResponse>} turnResponder - Callback producing each turn's `ModelTurnResponse`.
   */
  constructor(
    turnResponder: (
      req: ModelTurnRequest,
      turnIndex: number,
      driver: ScriptedIntegrationModelDriver,
    ) => ModelTurnResponse | Promise<ModelTurnResponse>,
  ) {
    this.turnResponder = turnResponder;
  }

  /**
   * Executes a single scripted model turn and records the incoming `ModelTurnRequest`.
   *
   * Delegates response construction to `this.turnResponder` with the 0-based global turn index.
   *
   * @param {ModelTurnRequest} req - Incoming turn request containing `wirePrefix`, `roleKey`, and `history`.
   *
   * @returns {Promise<ModelTurnResponse>} Scripted wire frame, canonical message, structured output, and usage.
   */
  async invokeTurn(req: ModelTurnRequest): Promise<ModelTurnResponse> {
    const turnIndex = this.recordedRequests.length;
    this.recordedRequests.push(req);
    return await this.turnResponder(req, turnIndex, this);
  }

  /**
   * Synthesizes initial `WireFrameRecord[]` frames for a downward fork or cross-model escalation.
   *
   * Preserves `parentFrames` on `'clone-transcript'` and returns an empty frame array on `'shared-prefix-only'`.
   *
   * @param {ForkContext}       ctx    - Fork context with `historyMode` and `parentFrames`.
   * @param {PrepareForkTarget} target - Target model and tombstone substitution descriptor.
   *
   * @returns {Promise<readonly WireFrameRecord[]>} Initial child fork wire frames.
   */
  prepareFork(
    ctx: ForkContext,
    target: PrepareForkTarget,
  ): Promise<readonly WireFrameRecord[]> {
    const forkSeq = this.recordedForkCalls.length + 1;
    this.recordedForkCalls.push(Object.freeze({ ctx, target }));
    if (ctx.historyMode === 'shared-prefix-only') {
      return Promise.resolve(Object.freeze([]));
    }
    return Promise.resolve(cloneForkWireFrames(ctx.parentChain, forkSeq));
  }

  /**
   * Appends synchronization or recovery notes in-place to a `role: 'tool'` or `role: 'user'` wire frame.
   *
   * Updates both `canonical` and `rawWireFrame` so subsequent turns observe `[WORKTREE_SYNC]` and grounding notes.
   *
   * @param {WireFrameRecord}              frame          - Target `tool` or `user` wire frame record.
   * @param {readonly string[]}            notes          - Synchronization notes to append.
   * @param {string}                       [targetCallId] - Optional tool `callId` on a `tool` frame.
   * @param {AppendToolResultNotesOptions} [opts]         - Optional error flag override.
   *
   * @returns {Promise<WireFrameRecord>} Updated immutable `WireFrameRecord`.
   */
  appendToolResultNotes(
    frame: WireFrameRecord,
    notes: readonly string[],
    targetCallId?: string,
    opts?: AppendToolResultNotesOptions,
  ): Promise<WireFrameRecord> {
    return Promise.resolve(
      appendNotesToWireFrame({
        frame,
        notes,
        targetCallId,
        opts,
      }),
    );
  }

  /**
   * Constructs a `ModelTurnResponse` containing one or more tool calls (`canonical.toolCalls`).
   *
   * Encodes both the `CanonicalMessage` and raw UTF-8 `wireFrame` with deterministic token usage.
   *
   * @param {readonly CanonicalToolCall[]} toolCalls        - Tool calls to emit in this assistant turn.
   * @param {string}                       [visibleText=''] - Optional assistant reasoning text accompanying the tool calls.
   * @param {number}                       [costUsd=0.01]   - Optional USD cost to report for budget/tripwire tests.
   *
   * @returns {ModelTurnResponse} Frozen `ModelTurnResponse` carrying `toolCalls`.
   */
  buildToolCallResponse(
    toolCalls: readonly CanonicalToolCall[],
    visibleText = '',
    costUsd = 0.01,
  ): ModelTurnResponse {
    const canonical: CanonicalMessage = Object.freeze({
      role: 'assistant',
      visibleText,
      toolCalls: Object.freeze([...toolCalls]),
      toolResults: undefined,
    });
    return Object.freeze<ModelTurnResponse>({
      wireFrame: new TextEncoder().encode(JSON.stringify(canonical)),
      canonical,
      structuredOutput: undefined,
      usage: Object.freeze({
        inputTokens: 100,
        cachedInputTokens: 80,
        outputTokens: 50,
        costUsd,
      }),
    });
  }

  /**
   * Constructs a terminal `ModelTurnResponse` returning a structured output object (`structuredOutput`).
   *
   * Emits an assistant message with zero tool calls and serializes `structuredOutput` into `canonical.visibleText`.
   *
   * @param {unknown} structuredOutput - Validated structured output payload for the actor or flush turn.
   * @param {number}  [costUsd=0.01]   - Optional USD cost to report for the turn.
   *
   * @returns {ModelTurnResponse} Frozen terminal `ModelTurnResponse`.
   */
  buildStructuredResponse(structuredOutput: unknown, costUsd = 0.01): ModelTurnResponse {
    const visibleText = JSON.stringify(structuredOutput);
    const canonical: CanonicalMessage = Object.freeze({
      role: 'assistant',
      visibleText,
      toolCalls: Object.freeze([]),
      toolResults: undefined,
    });
    return Object.freeze<ModelTurnResponse>({
      wireFrame: new TextEncoder().encode(visibleText),
      canonical,
      structuredOutput,
      usage: Object.freeze({
        inputTokens: 100,
        cachedInputTokens: 80,
        outputTokens: 40,
        costUsd,
      }),
    });
  }
}
