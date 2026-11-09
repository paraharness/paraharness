import type { MemoryNoteRecord } from '../schemas/memory-record.schema.js';
import type { MemoryLoadedNoteRecord } from '../schemas/memory-tools.schema.js';

/**
 * Outcome of evaluating a `MemoryNoteRecord`'s lifecycle during a matching read operation (§3.3).
 */
export interface NoteLifecycleEvaluationResult {
  /** Projected note record returned to the caller (`null` when silently purged by `hard-expiry`). */
  readonly loadedNote: MemoryLoadedNoteRecord | null;
  /** Note record retained in `memory.jsonl` after the read (`null` when drained or purged). */
  readonly retainedNote: MemoryNoteRecord | null;
  /** Whether the evaluation modified or deleted the note in `memory.jsonl`. */
  readonly mutatedLedger: boolean;
}
