import type { AppendToolResultNotesOptions } from '../../src/ports/append-tool-result-notes-options.js';
import type { ForkContext } from '../../src/ports/fork-context.js';
import type { ModelDriver } from '../../src/ports/model-driver.js';
import type { ModelTurnRequest } from '../../src/ports/model-turn-request.js';
import type { ModelTurnResponse } from '../../src/ports/model-turn-response.js';
import type { PrepareForkTarget } from '../../src/ports/prepare-fork-target.js';
import type { WireFrameRecord } from '../../src/ports/wire-frame-record.js';

/**
 * Deterministic `ModelDriver` test fixture supporting scripted turn queues, HTTP `429` rate limits, `prepareFork`, and `appendToolResultNotes` (`SPEC.md` §3.2).
 *
 * Records all `ModelTurnRequest` and `prepareFork` calls for behavioral test assertions.
 */
export class ScriptedModelDriver implements ModelDriver {
  /** Provider vendor identifier. */
  readonly vendorId: string = 'anthropic';
  /** Queue of scripted turn responses or error-throwing callbacks. */
  private readonly turnQueue: Array<ModelTurnResponse | ((req: ModelTurnRequest) => ModelTurnResponse | Promise<ModelTurnResponse>)>;
  /** Recorded `invokeTurn` requests in chronological order. */
  readonly recordedRequests: ModelTurnRequest[] = [];
  /** Recorded `prepareFork` calls in chronological order. */
  readonly recordedForks: Array<{ readonly ctx: ForkContext; readonly target: PrepareForkTarget }> = [];
  /** Monotonic fork frame counter. */
  private forkSeq = 0;

  /**
   * Creates a `ScriptedModelDriver` with an initial queue of responses or turn handlers.
   *
   * Pops one entry from `responses` on each `invokeTurn` call.
   *
   * @param {ReadonlyArray<ModelTurnResponse | ((req: ModelTurnRequest) => ModelTurnResponse | Promise<ModelTurnResponse>)>} [responses] - Scripted turn responses.
   */
  constructor(
    responses: ReadonlyArray<ModelTurnResponse | ((req: ModelTurnRequest) => ModelTurnResponse | Promise<ModelTurnResponse>)> = [],
  ) {
    this.turnQueue = [...responses];
  }

  /**
   * Enqueues an additional scripted turn response or callback.
   *
   * Appends `entry` to the end of `turnQueue`.
   *
   * @param {ModelTurnResponse | ((req: ModelTurnRequest) => ModelTurnResponse | Promise<ModelTurnResponse>)} entry - Response or callback to enqueue.
   */
  enqueueTurn(entry: ModelTurnResponse | ((req: ModelTurnRequest) => ModelTurnResponse | Promise<ModelTurnResponse>)): void {
    this.turnQueue.push(entry);
  }

  /**
   * Invokes the next scripted turn from `turnQueue` and records `req` in `recordedRequests`.
   *
   * Throws an actionable error if `turnQueue` is empty.
   *
   * @param {ModelTurnRequest} req - Turn request payload.
   *
   * @returns {Promise<ModelTurnResponse>} Scripted turn response.
   */
  async invokeTurn(req: ModelTurnRequest): Promise<ModelTurnResponse> {
    this.recordedRequests.push(req);
    const next = this.turnQueue.shift();
    if (next === undefined) {
      throw new Error(`ScriptedModelDriver queue exhausted on model '${req.modelId}' (roleKey '${req.roleKey ?? 'default'}').`);
    }
    return typeof next === 'function' ? await next(req) : next;
  }

  /**
   * Synthesizes a forked `WireFrameRecord[]` chain, substituting `compactedTombstones` when `target.substituteTombstones` is `true`.
   *
   * Assigns new deterministic `messageId` values (`fork:${seq}:${oldId}`) and links `parentMessageId`.
   *
   * @param {ForkContext}       ctx    - Fork lineage and history mode.
   * @param {PrepareForkTarget} target - Target model and tombstone substitution options.
   *
   * @returns {Promise<readonly WireFrameRecord[]>} Synthesized wire frame chain.
   */
  async prepareFork(ctx: ForkContext, target: PrepareForkTarget): Promise<readonly WireFrameRecord[]> {
    this.recordedForks.push(Object.freeze({ ctx, target }));
    if (ctx.historyMode === 'shared-prefix-only') return Object.freeze([]);
    this.forkSeq += 1;
    const out: WireFrameRecord[] = [];
    let prevId: string | null = null;
    for (const srcFrame of ctx.parentChain) {
      const newMsgId = `fork:${String(this.forkSeq)}:${srcFrame.messageId}`;
      let updatedCanonical = srcFrame.canonical;
      if (target.substituteTombstones && srcFrame.compactedTombstones !== undefined && srcFrame.canonical.toolResults !== undefined) {
        const tombstones = srcFrame.compactedTombstones;
        const nextResults = srcFrame.canonical.toolResults.map((tr) => {
          const tomb = tombstones[tr.callId];
          return tomb !== undefined ? Object.freeze({ ...tr, content: tomb }) : tr;
        });
        updatedCanonical = Object.freeze({ ...srcFrame.canonical, toolResults: Object.freeze(nextResults) });
      }
      out.push(Object.freeze<WireFrameRecord>({
        ...srcFrame,
        messageId: newMsgId,
        parentMessageId: prevId,
        canonical: updatedCanonical,
      }));
      prevId = newMsgId;
    }
    return Object.freeze(out);
  }

  /**
   * Appends synchronization or recovery `notes` to `frame` in-place.
   *
   * Updates both `canonical.visibleText` and any targeted `toolResults` entry.
   *
   * @param {WireFrameRecord}              frame          - Existing `tool` or `user` wire frame record.
   * @param {readonly string[]}            notes          - Synchronization note strings to append.
   * @param {string}                       [targetCallId] - Optional tool `callId` to target.
   * @param {AppendToolResultNotesOptions} [opts]         - Optional error status override.
   *
   * @returns {Promise<WireFrameRecord>} Updated wire frame record.
   */
  async appendToolResultNotes(
    frame: WireFrameRecord,
    notes: readonly string[],
    targetCallId?: string,
    opts?: AppendToolResultNotesOptions,
  ): Promise<WireFrameRecord> {
    const suffix = notes.join('\n');
    const updatedText = `${frame.canonical.visibleText}\n${suffix}`;
    const results = frame.canonical.toolResults;
    const updatedResults = results?.map((tr, idx) => {
      if ((targetCallId === undefined && idx === results.length - 1) || tr.callId === targetCallId) {
        return Object.freeze({ ...tr, content: `${tr.content}\n${suffix}`, isError: opts?.isError ?? tr.isError });
      }
      return tr;
    });
    return Object.freeze<WireFrameRecord>({
      ...frame,
      rawWireFrame: new TextEncoder().encode(updatedText),
      canonical: Object.freeze({
        ...frame.canonical,
        visibleText: updatedText,
        toolResults: updatedResults !== undefined ? Object.freeze(updatedResults) : undefined,
      }),
    });
  }
}
