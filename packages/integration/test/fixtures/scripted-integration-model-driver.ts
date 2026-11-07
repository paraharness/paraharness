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

/**
 * Deterministic `ModelDriver` test double orchestrating scripted multi-turn tool calls and structured outputs (`M4-integration.md` §5).
 *
 * Records every `ModelTurnRequest` received across actors, supports role-aware and turn-indexed scripted
 * responses, and implements KV-cache-preserving `prepareFork` and in-place `appendToolResultNotes`.
 */
export class ScriptedIntegrationModelDriver implements ModelDriver {
  /** Primary vendor identifier (`'anthropic'`). */
  readonly vendorId = 'anthropic' as const;

  /** Vendor alias matching `vendorId`. */
  readonly vendor = 'anthropic' as const;

  /** Ordered list of all `ModelTurnRequest` payloads received by this driver instance. */
  readonly recordedRequests: ModelTurnRequest[] = [];

  /** Recorded `prepareFork` calls for verifying fork history modes and tombstone substitution. */
  readonly recordedForkCalls: Array<{ readonly ctx: ForkContext; readonly target: PrepareForkTarget }> = [];

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
  prepareFork(ctx: ForkContext, target: PrepareForkTarget): Promise<readonly WireFrameRecord[]> {
    const forkSeq = this.recordedForkCalls.length + 1;
    this.recordedForkCalls.push(Object.freeze({ ctx, target }));
    if (ctx.historyMode === 'shared-prefix-only') {
      return Promise.resolve(Object.freeze([]));
    }
    let prevId: string | null = null;
    const cloned: WireFrameRecord[] = [];
    for (const frame of ctx.parentChain) {
      const nextId = `${frame.messageId}:fork:${String(forkSeq)}`;
      cloned.push(Object.freeze<WireFrameRecord>({ ...frame, messageId: nextId, parentMessageId: prevId }));
      prevId = nextId;
    }
    return Promise.resolve(Object.freeze(cloned));
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
    const joinedNotes = notes.join('\n');
    const prevResults = frame.canonical.toolResults ?? [];
    const nextResults: Array<{ readonly callId: string; readonly content: string; readonly isError: boolean }> = [];
    for (const tr of prevResults) {
      if (targetCallId === undefined || tr.callId === targetCallId) {
        nextResults.push(
          Object.freeze({
            callId: tr.callId,
            content: `${tr.content}\n${joinedNotes}`,
            isError: opts?.isError ?? tr.isError,
          }),
        );
      } else {
        nextResults.push(tr);
      }
    }
    const nextVisibleText =
      prevResults.length === 0
        ? `${frame.canonical.visibleText}\n${joinedNotes}`.trim()
        : frame.canonical.visibleText;
    const nextCanonical: CanonicalMessage = Object.freeze({
      role: frame.canonical.role,
      visibleText: nextVisibleText,
      toolCalls: frame.canonical.toolCalls,
      toolResults: nextResults.length > 0 ? Object.freeze(nextResults) : frame.canonical.toolResults,
    });
    const rawBytes = new TextEncoder().encode(JSON.stringify(nextCanonical));
    return Promise.resolve(
      Object.freeze<WireFrameRecord>({
        ...frame,
        rawWireFrame: rawBytes,
        canonical: nextCanonical,
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
