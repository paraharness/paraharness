import { z } from 'zod';

/**
 * Discriminator for the three record kinds stored in the unified memory ledger.
 */
export const MemoryRecordTypeSchema = z.enum(['rule', 'lesson', 'note']);

/**
 * Inferred union type for memory record kinds (`'rule' | 'lesson' | 'note'`).
 */
export type MemoryRecordType = z.infer<typeof MemoryRecordTypeSchema>;

/**
 * Lifecycle mode names supported on `type: 'note'` records.
 */
export const NoteLifecycleModeSchema = z.enum([
  'persistent',
  'read-count',
  'hard-expiry',
  'soft-expiry',
]);

/**
 * Inferred note lifecycle mode union type.
 */
export type NoteLifecycleMode = z.infer<typeof NoteLifecycleModeSchema>;

/**
 * Four-variant discriminated union governing when a `type: 'note'` record is lazily drained.
 */
export const NoteLifecycleSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('persistent'),
  }),
  z.object({
    mode: z.literal('read-count'),
    remainingReads: z.number().int().min(1),
  }),
  z.object({
    mode: z.literal('hard-expiry'),
    expiresAt: z.iso.datetime(),
  }),
  z.object({
    mode: z.literal('soft-expiry'),
    expiresAt: z.iso.datetime(),
  }),
]);

/**
 * Inferred note lifecycle union type.
 */
export type NoteLifecycle = z.infer<typeof NoteLifecycleSchema>;

/**
 * Shared base fields present on every record in `memory.jsonl`.
 */
const MemoryRecordBaseFields = {
  role: z.string().min(1),
  text: z.string().min(1),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime().optional(),
  context: z.array(z.string().min(1)).min(1).optional(),
  repos: z.array(z.string().min(1)).min(1).optional(),
};

/**
 * Owner-mandated rule record (`R1, R2, ...`).
 */
export const MemoryRuleRecordSchema = z.object({
  id: z.string().regex(/^R[1-9]\d*$/),
  type: z.literal('rule'),
  ...MemoryRecordBaseFields,
});

/**
 * Inferred rule record type.
 */
export type MemoryRuleRecord = z.infer<typeof MemoryRuleRecordSchema>;

/**
 * Agent-distilled empirical lesson record (`L1, L2, ...`).
 */
export const MemoryLessonRecordSchema = z.object({
  id: z.string().regex(/^L[1-9]\d*$/),
  type: z.literal('lesson'),
  ...MemoryRecordBaseFields,
});

/**
 * Inferred lesson record type.
 */
export type MemoryLessonRecord = z.infer<typeof MemoryLessonRecordSchema>;

/**
 * Operational or design decision note record (`N1, N2, ...`) with mandatory lifecycle.
 */
export const MemoryNoteRecordSchema = z.object({
  id: z.string().regex(/^N[1-9]\d*$/),
  type: z.literal('note'),
  ...MemoryRecordBaseFields,
  lifecycle: NoteLifecycleSchema,
});

/**
 * Inferred note record type.
 */
export type MemoryNoteRecord = z.infer<typeof MemoryNoteRecordSchema>;

/**
 * Discriminated union of all records stored in `memory.jsonl`.
 */
export const MemoryRecordSchema = z.discriminatedUnion('type', [
  MemoryRuleRecordSchema,
  MemoryLessonRecordSchema,
  MemoryNoteRecordSchema,
]);

/**
 * Inferred memory record union type.
 */
export type MemoryRecord = z.infer<typeof MemoryRecordSchema>;

/**
 * Persistent monotonic ID high-water-mark metadata stored alongside `memory.jsonl`.
 */
export const MemoryMetaSchema = z.object({
  schemaVersion: z.literal(1),
  highWaterMarks: z.object({
    R: z.number().int().min(0),
    L: z.number().int().min(0),
    N: z.number().int().min(0),
  }),
});

/**
 * Inferred monotonic ID high-water-mark metadata type.
 */
export type MemoryMeta = z.infer<typeof MemoryMetaSchema>;
