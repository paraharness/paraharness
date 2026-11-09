import type { MemoryNoteRecord } from '../schemas/memory-record.schema.js';
import type { MemoryLoadedNoteRecord } from '../schemas/memory-tools.schema.js';
import { FINAL_READ_DRAINED_PREFIX } from './memory-protocol.constants.js';
import type { NoteLifecycleEvaluationResult } from './note-lifecycle-evaluation-result.js';

/**
 * Evaluates a `read-count` note lifecycle transition on read without mutating `note.updatedAt` (§3.3).
 *
 * @param {MemoryNoteRecord} note            - Note record with `lifecycle.mode === 'read-count'`.
 * @param {number}           remainingReads  - Current positive `remainingReads` counter.
 *
 * @returns {NoteLifecycleEvaluationResult} Decremented or final-read drained evaluation result.
 */
function evaluateReadCountNote(
  note: MemoryNoteRecord,
  remainingReads: number,
): NoteLifecycleEvaluationResult {
  if (remainingReads > 1) {
    const retainedNote: MemoryNoteRecord = Object.freeze({
      ...note,
      lifecycle: Object.freeze({
        mode: 'read-count',
        remainingReads: remainingReads - 1,
      }),
    });
    const loadedNote: MemoryLoadedNoteRecord = Object.freeze({
      ...retainedNote,
      drainedOnThisRead: false,
      renderedText: note.text,
    });
    return Object.freeze<NoteLifecycleEvaluationResult>({
      loadedNote,
      retainedNote,
      mutatedLedger: true,
    });
  }
  const loadedNote: MemoryLoadedNoteRecord = Object.freeze({
    ...note,
    lifecycle: Object.freeze({
      mode: 'read-count',
      remainingReads: 1,
    }),
    drainedOnThisRead: true,
    renderedText: `${FINAL_READ_DRAINED_PREFIX}${note.text}`,
  });
  return Object.freeze<NoteLifecycleEvaluationResult>({
    loadedNote,
    retainedNote: null,
    mutatedLedger: true,
  });
}

/**
 * Evaluates the 4-mode lifecycle state machine (`persistent`, `read-count`, `hard-expiry`, `soft-expiry`)
 * for a matched `MemoryNoteRecord` at timestamp `nowMs` per §3.3.
 *
 * @param {MemoryNoteRecord} note  - Matched note record being read.
 * @param {number}           nowMs - Current UTC timestamp in epoch milliseconds.
 *
 * @returns {NoteLifecycleEvaluationResult} Caller projection (`loadedNote`), ledger retention (`retainedNote`), and mutation flag.
 */
export function evaluateNoteLifecycleOnRead(
  note: MemoryNoteRecord,
  nowMs: number,
): NoteLifecycleEvaluationResult {
  switch (note.lifecycle.mode) {
    case 'persistent': {
      const loadedNote: MemoryLoadedNoteRecord = Object.freeze({
        ...note,
        drainedOnThisRead: false,
        renderedText: note.text,
      });
      return Object.freeze<NoteLifecycleEvaluationResult>({
        loadedNote,
        retainedNote: note,
        mutatedLedger: false,
      });
    }
    case 'read-count': {
      return evaluateReadCountNote(note, note.lifecycle.remainingReads);
    }
    case 'hard-expiry': {
      const expiresAtMs = Date.parse(note.lifecycle.expiresAt);
      if (nowMs >= expiresAtMs) {
        return Object.freeze<NoteLifecycleEvaluationResult>({
          loadedNote: null,
          retainedNote: null,
          mutatedLedger: true,
        });
      }
      const loadedNote: MemoryLoadedNoteRecord = Object.freeze({
        ...note,
        drainedOnThisRead: false,
        renderedText: note.text,
      });
      return Object.freeze<NoteLifecycleEvaluationResult>({
        loadedNote,
        retainedNote: note,
        mutatedLedger: false,
      });
    }
    case 'soft-expiry': {
      const expiresAtMs = Date.parse(note.lifecycle.expiresAt);
      if (nowMs >= expiresAtMs) {
        const loadedNote: MemoryLoadedNoteRecord = Object.freeze({
          ...note,
          drainedOnThisRead: true,
          renderedText: `${FINAL_READ_DRAINED_PREFIX}${note.text}`,
        });
        return Object.freeze<NoteLifecycleEvaluationResult>({
          loadedNote,
          retainedNote: null,
          mutatedLedger: true,
        });
      }
      const loadedNote: MemoryLoadedNoteRecord = Object.freeze({
        ...note,
        drainedOnThisRead: false,
        renderedText: note.text,
      });
      return Object.freeze<NoteLifecycleEvaluationResult>({
        loadedNote,
        retainedNote: note,
        mutatedLedger: false,
      });
    }
  }
}
