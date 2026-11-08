import type { AppendToolResultNotesOptions } from './append-tool-result-notes-options.js';
import type { ForkContext } from './fork-context.js';
import type { ModelTurnRequest } from './model-turn-request.js';
import type { ModelTurnResponse } from './model-turn-response.js';
import type { PrepareForkTarget } from './prepare-fork-target.js';
import type { WireFrameRecord } from './wire-frame-record.js';

/**
 * Runtime port for LLM provider protocol drivers (`@paraharness/claude`, `@paraharness/openai`, `@paraharness/gemini`).
 *
 * Manages wire-accurate turn invocation, KV-cache-preserving fork preparation, and in-place
 * synchronization note injection on `tool` and `user` frames.
 */
export interface ModelDriver {
  /** Primary vendor identifier (`'anthropic' | 'openai' | 'google' | string`). */
  readonly vendorId: 'anthropic' | 'openai' | 'google' | string;
  /** Optional alias matching `vendorId`. */
  readonly vendor?: 'anthropic' | 'openai' | 'google' | string;

  /**
   * Invokes a single model turn over `req.history` and returns the raw wire frame and canonical projection.
   *
   * Transmits the pinned wire prefix and conversation history to the provider and extracts tool calls or structured output.
   *
   * @param {ModelTurnRequest} req - Turn request payload and wire prefix configuration.
   *
   * @returns {Promise<ModelTurnResponse>} Raw wire response, canonical message, structured output, and usage.
   */
  invokeTurn(req: ModelTurnRequest): Promise<ModelTurnResponse>;

  /**
   * Synthesizes the initial `WireFrameRecord[]` chain for a downward fork or cross-model escalation.
   *
   * Preserves byte-identical parent wire frames on same-model forks and re-encodes from `CanonicalMessage`
   * (substituting compacted skill tombstones) when escalating across distinct models.
   *
   * @param {ForkContext}       ctx    - Fork lineage, history mode, and turn-batch pairing metadata.
   * @param {PrepareForkTarget} target - Target model configuration and tombstone substitution flag.
   *
   * @returns {Promise<readonly WireFrameRecord[]>} Synthesized wire frame chain to persist in `LedgerStore`.
   */
  prepareFork(ctx: ForkContext, target: PrepareForkTarget): Promise<readonly WireFrameRecord[]>;

  /**
   * Appends synchronization or recovery notes to a `role: 'tool'` or `role: 'user'` frame in-place.
   *
   * Updates both `rawWireFrame` and `frame.canonical` so subsequent turns see the appended notes
   * without breaking role alternation.
   *
   * @param {WireFrameRecord}              frame          - Existing `tool` or `user` wire frame record.
   * @param {readonly string[]}            notes          - Synchronization note strings to append.
   * @param {string}                       [targetCallId] - Optional tool `callId` to target on a multi-tool frame.
   * @param {AppendToolResultNotesOptions} [opts]         - Optional error status override.
   *
   * @returns {Promise<WireFrameRecord>} Updated wire frame record to persist via `LedgerStore.replaceMessageFrame()`.
   */
  appendToolResultNotes(
    frame: WireFrameRecord,
    notes: readonly string[],
    targetCallId?: string,
    opts?: AppendToolResultNotesOptions,
  ): Promise<WireFrameRecord>;
}
