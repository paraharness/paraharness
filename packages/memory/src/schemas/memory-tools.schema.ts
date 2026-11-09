import { z } from 'zod';
import {
  MemoryLessonRecordSchema,
  MemoryNoteRecordSchema,
  MemoryRecordSchema,
  MemoryRecordTypeSchema,
  MemoryRuleRecordSchema,
  NoteLifecycleSchema,
} from './memory-record.schema.js';

/**
 * Safe single-segment session identifier schema preventing path traversal and reserved filename collisions.
 */
export const SessionIdSchema = z
  .string()
  .regex(/^[A-Za-z0-9._-]+$/)
  .refine((s) => s !== 'latest-role', {
    message: 'sessionId cannot be the reserved identifier "latest-role".',
  });

/**
 * Inferred session identifier type.
 */
export type SessionId = z.infer<typeof SessionIdSchema>;

/**
 * Deterministic machine-readable error codes thrown by `MemoryHarnessError`.
 */
export const MemoryErrorCodeSchema = z.enum([
  'CONFIG_NOT_FOUND',
  'CONFIG_VALIDATION_FAILED',
  'INVALID_ROLE',
  'VALIDATION_FAILED',
  'LESSON_FORMAT_INVALID',
  'CAP_EXCEEDED',
  'RECORD_NOT_FOUND',
  'RULE_PROTECTION_VIOLATION',
  'DISTILLER_EXECUTION_FAILED',
  'GIT_SYNC_FAILED',
]);

/**
 * Inferred error code union type.
 */
export type MemoryErrorCode = z.infer<typeof MemoryErrorCodeSchema>;

/**
 * Note record returned by read tools, augmented with whether the read triggered final drainage.
 */
export const MemoryLoadedNoteRecordSchema = MemoryNoteRecordSchema.extend({
  drainedOnThisRead: z.boolean(),
  renderedText: z.string().min(1),
});

/**
 * Inferred loaded note record type.
 */
export type MemoryLoadedNoteRecord = z.infer<typeof MemoryLoadedNoteRecordSchema>;

/**
 * Capacity status of the target bucket evaluated during `memory_propose` and `memory_commit`.
 */
export const MemoryBucketStatusSchema = z.object({
  bucketId: z.string().min(1),
  currentCount: z.number().int().min(0),
  bucketRecordIds: z.array(z.string().regex(/^[RLN][1-9]\d*$/)),
  softCap: z.number().int().min(1).nullable(),
  hardCap: z.number().int().min(1).nullable(),
  zone: z.enum(['UNCAPPED', 'UNDER_SOFT_CAP', 'SOFT_CAP_PRESSURE', 'AT_HARD_CAP']),
  totalRecordsCount: z.number().int().min(0),
  maxTotalRecords: z.number().int().min(1).nullable(),
  maxTotalRecordsReached: z.boolean(),
});

/**
 * Inferred capacity bucket status type.
 */
export type MemoryBucketStatus = z.infer<typeof MemoryBucketStatusSchema>;

/**
 * Input schema for `memory_init`.
 */
export const MemoryInitInputSchema = z.object({
  role: z.string().min(1),
  sessionId: SessionIdSchema.optional(),
});

/**
 * Inferred input type for `memory_init`.
 */
export type MemoryInitInput = z.infer<typeof MemoryInitInputSchema>;

/**
 * Output schema for `memory_init`.
 */
export const MemoryInitOutputSchema = z.object({
  role: z.string().min(1),
  repoId: z.string().min(1),
  protocol: z.string().min(1),
  rules: z.array(MemoryRuleRecordSchema),
  lessons: z.array(MemoryLessonRecordSchema),
  notes: z.array(MemoryLoadedNoteRecordSchema),
});

/**
 * Inferred output type for `memory_init`.
 */
export type MemoryInitOutput = z.infer<typeof MemoryInitOutputSchema>;

/**
 * Input schema for `memory_load_scoped`.
 */
export const MemoryLoadScopedInputSchema = z.object({
  role: z.string().min(1),
  paths: z.array(z.string().min(1)).min(1),
  sessionId: SessionIdSchema.optional(),
});

/**
 * Inferred input type for `memory_load_scoped`.
 */
export type MemoryLoadScopedInput = z.infer<typeof MemoryLoadScopedInputSchema>;

/**
 * Output schema for `memory_load_scoped`.
 */
export const MemoryLoadScopedOutputSchema = z.object({
  role: z.string().min(1),
  normalizedPaths: z.array(z.string().min(1)).min(1),
  rules: z.array(MemoryRuleRecordSchema),
  lessons: z.array(MemoryLessonRecordSchema),
  notes: z.array(MemoryLoadedNoteRecordSchema),
});

/**
 * Inferred output type for `memory_load_scoped`.
 */
export type MemoryLoadScopedOutput = z.infer<typeof MemoryLoadScopedOutputSchema>;

/**
 * Consolidation merge payload attached to an `op: 'add'` choice when two existing records of the
 * same type in a bucket at or above `softCap` genuinely share the same underlying mechanism.
 */
export const MemoryCapMergeProposalSchema = z
  .object({
    keepId: z.string().regex(/^[RL][1-9]\d*$/),
    removeId: z.string().regex(/^[RL][1-9]\d*$/),
    mergedText: z.string().trim().min(1),
    whyMerged: z.string().trim().min(1),
  })
  .refine((m) => m.keepId !== m.removeId && m.keepId[0] === m.removeId[0], {
    message: 'keepId and removeId must be distinct IDs with the same type prefix.',
  });

/**
 * Inferred capacity-merge proposal type.
 */
export type MemoryCapMergeProposal = z.infer<typeof MemoryCapMergeProposalSchema>;

/**
 * Choice item produced directly by the Distiller LLM (referencing `targetId` without echoing full record metadata).
 */
export const DistillerChoiceOutputSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('update'),
      targetId: z.string().regex(/^[RL][1-9]\d*$/),
      whyMatched: z.string().trim().min(1),
      proposedText: z.string().trim().min(1),
      proposedRole: z.string().min(1),
      proposedContext: z.array(z.string().min(1)).min(1).nullable().optional(),
      proposedRepos: z.array(z.string().min(1)).min(1).nullable().optional(),
      alsoRemoveIds: z.array(z.string().regex(/^[RL][1-9]\d*$/)).optional(),
    })
    .refine(
      (val) =>
        val.alsoRemoveIds === undefined ||
        (new Set(val.alsoRemoveIds).size === val.alsoRemoveIds.length &&
          val.alsoRemoveIds.every((id) => id !== val.targetId && id[0] === val.targetId[0])),
      {
        message: 'alsoRemoveIds must be unique, distinct from targetId, and share targetId type prefix',
      },
    ),
  z.object({
    op: z.literal('add'),
    proposedText: z.string().trim().min(1),
    proposedRole: z.string().min(1),
    proposedContext: z.array(z.string().min(1)).min(1).optional(),
    proposedRepos: z.array(z.string().min(1)).min(1).optional(),
    capMerge: MemoryCapMergeProposalSchema.optional(),
  }),
]);

/**
 * Inferred Distiller choice output type.
 */
export type DistillerChoiceOutput = z.infer<typeof DistillerChoiceOutputSchema>;

/**
 * Hydrated proposal choice returned to the caller by `memory_propose` in `resolved` mode.
 */
export const MemoryProposalChoiceSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('update'),
      targetId: z.string().regex(/^[RL][1-9]\d*$/),
      existingRecord: z.union([MemoryRuleRecordSchema, MemoryLessonRecordSchema]),
      whyMatched: z.string().trim().min(1),
      proposedText: z.string().trim().min(1),
      proposedRole: z.string().min(1),
      proposedContext: z.array(z.string().min(1)).min(1).nullable().optional(),
      proposedRepos: z.array(z.string().min(1)).min(1).nullable().optional(),
      alsoRemoveIds: z.array(z.string().regex(/^[RL][1-9]\d*$/)).optional(),
    })
    .refine(
      (val) =>
        val.alsoRemoveIds === undefined ||
        (new Set(val.alsoRemoveIds).size === val.alsoRemoveIds.length &&
          val.alsoRemoveIds.every((id) => id !== val.targetId && id[0] === val.targetId[0])),
      {
        message: 'alsoRemoveIds must be unique, distinct from targetId, and share targetId type prefix',
      },
    ),
  z.object({
    op: z.literal('add'),
    proposedText: z.string().trim().min(1),
    proposedRole: z.string().min(1),
    proposedContext: z.array(z.string().min(1)).min(1).optional(),
    proposedRepos: z.array(z.string().min(1)).min(1).optional(),
    capMerge: MemoryCapMergeProposalSchema.optional(),
  }),
]);

/**
 * Inferred hydrated proposal choice union type.
 */
export type MemoryProposalChoice = z.infer<typeof MemoryProposalChoiceSchema>;

/**
 * Structured output schema that the Distiller LLM must produce.
 */
export const DistillerStructuredOutputSchema = z
  .object({
    matchStatus: z.enum([
      'NO_MATCH',
      'LIKELY_MATCH',
      'EXACT_DUPLICATE',
      'REJECTED_TIER_1_OR_2',
    ]),
    tierRejectionReason: z.string().trim().min(1).optional(),
    recommendedChoiceIndex: z.number().int().min(-1),
    choices: z.array(DistillerChoiceOutputSchema),
  })
  .superRefine((val, ctx) => {
    if (val.matchStatus === 'REJECTED_TIER_1_OR_2') {
      if (val.tierRejectionReason === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['tierRejectionReason'],
          message: 'tierRejectionReason is required when matchStatus is REJECTED_TIER_1_OR_2.',
        });
      }
      if (val.choices.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['choices'],
          message: 'choices must be empty when matchStatus is REJECTED_TIER_1_OR_2.',
        });
      }
    } else if (val.tierRejectionReason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tierRejectionReason'],
        message: 'tierRejectionReason is only permitted when matchStatus is REJECTED_TIER_1_OR_2.',
      });
    }
    if (val.matchStatus === 'EXACT_DUPLICATE' && val.choices.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'choices must be empty when matchStatus is EXACT_DUPLICATE.',
      });
    }
    if (val.matchStatus === 'LIKELY_MATCH' && !val.choices.some((c) => c.op === 'update')) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message:
          'choices must include at least one op: "update" choice when matchStatus is LIKELY_MATCH.',
      });
    }
    if (val.choices.length === 0 && val.recommendedChoiceIndex !== -1) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendedChoiceIndex'],
        message: 'recommendedChoiceIndex must be -1 when choices is empty.',
      });
    }
    if (
      val.choices.length > 0 &&
      (val.recommendedChoiceIndex < 0 || val.recommendedChoiceIndex >= val.choices.length)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendedChoiceIndex'],
        message: 'recommendedChoiceIndex must be a valid index into choices.',
      });
    }
  });

/**
 * Inferred Distiller structured output type.
 */
export type DistillerStructuredOutput = z.infer<typeof DistillerStructuredOutputSchema>;

/**
 * Input schema for `memory_propose`.
 *
 * @note
 * `type` is restricted to `'rule' | 'lesson'`. Operational `'note'` records are committed directly via `memory_commit`.
 */
export const MemoryProposeInputSchema = z.object({
  callerRole: z.string().min(1),
  targetRole: z.string().min(1),
  type: z.enum(['rule', 'lesson']),
  rawText: z.string().trim().min(1),
  context: z.array(z.string().min(1)).min(1).optional(),
  repos: z.array(z.string().min(1)).min(1).optional(),
  incident: z.string().trim().min(1).max(1000).optional(),
});

/**
 * Inferred input type for `memory_propose`.
 */
export type MemoryProposeInput = z.infer<typeof MemoryProposeInputSchema>;

/**
 * Output schema for `memory_propose`, discriminated by `executionMode`.
 */
export const MemoryProposeOutputSchema = z
  .discriminatedUnion('executionMode', [
    z.object({
      executionMode: z.literal('resolved'),
      type: z.enum(['rule', 'lesson']),
      requiresOwnerGo: z.boolean(),
      bucketStatus: MemoryBucketStatusSchema,
      matchStatus: z.enum([
        'NO_MATCH',
        'LIKELY_MATCH',
        'EXACT_DUPLICATE',
        'REJECTED_TIER_1_OR_2',
      ]),
      tierRejectionReason: z.string().trim().min(1).optional(),
      recommendedChoiceIndex: z.number().int().min(-1),
      choices: z.array(MemoryProposalChoiceSchema),
    }),
    z.object({
      executionMode: z.literal('delegate_to_subagent'),
      type: z.enum(['rule', 'lesson']),
      requiresOwnerGo: z.boolean(),
      bucketStatus: MemoryBucketStatusSchema,
      delegateToSubagent: z.object({
        model: z.string().min(1),
        effort: z.enum(['low', 'medium', 'high']),
        timeoutMs: z.number().int().min(1000).max(600000),
        systemPrompt: z.string().min(1),
        userPrompt: z.string().min(1),
        outputJsonSchema: z.record(z.string(), z.unknown()),
      }),
    }),
  ])
  .superRefine((val, ctx) => {
    if (val.executionMode !== 'resolved') return;
    if (val.type === 'rule' && val.matchStatus === 'REJECTED_TIER_1_OR_2') {
      ctx.addIssue({
        code: 'custom',
        path: ['matchStatus'],
        message: 'matchStatus cannot be REJECTED_TIER_1_OR_2 when type is "rule".',
      });
    }
    if (val.matchStatus === 'REJECTED_TIER_1_OR_2') {
      if (val.tierRejectionReason === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['tierRejectionReason'],
          message: 'tierRejectionReason is required when matchStatus is REJECTED_TIER_1_OR_2.',
        });
      }
      if (val.choices.length > 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['choices'],
          message: 'choices must be empty when matchStatus is REJECTED_TIER_1_OR_2.',
        });
      }
    } else if (val.tierRejectionReason !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['tierRejectionReason'],
        message: 'tierRejectionReason is only permitted when matchStatus is REJECTED_TIER_1_OR_2.',
      });
    }
    if (val.matchStatus === 'EXACT_DUPLICATE' && val.choices.length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message: 'choices must be empty when matchStatus is EXACT_DUPLICATE.',
      });
    }
    if (val.matchStatus === 'LIKELY_MATCH' && !val.choices.some((c) => c.op === 'update')) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message:
          'choices must include at least one op: "update" choice when matchStatus is LIKELY_MATCH.',
      });
    }
    if (
      val.matchStatus === 'NO_MATCH' &&
      val.choices.length === 0 &&
      val.bucketStatus.zone !== 'AT_HARD_CAP'
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['choices'],
        message:
          'choices must not be empty when matchStatus is NO_MATCH unless bucketStatus.zone is AT_HARD_CAP.',
      });
    }
    if (val.choices.length === 0 && val.recommendedChoiceIndex !== -1) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendedChoiceIndex'],
        message: 'recommendedChoiceIndex must be -1 when choices is empty.',
      });
    }
    if (
      val.choices.length > 0 &&
      (val.recommendedChoiceIndex < 0 || val.recommendedChoiceIndex >= val.choices.length)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['recommendedChoiceIndex'],
        message: 'recommendedChoiceIndex must be a valid index into choices.',
      });
    }
  });

/**
 * Inferred output type for `memory_propose`.
 */
export type MemoryProposeOutput = z.infer<typeof MemoryProposeOutputSchema>;

/**
 * Input schema for `memory_commit`, discriminated by `op` (`'add' | 'update' | 'remove'`).
 */
export const MemoryCommitInputSchema = z
  .discriminatedUnion('op', [
    z.object({
      op: z.literal('add'),
      callerRole: z.string().min(1),
      type: MemoryRecordTypeSchema,
      role: z.string().min(1),
      text: z.string().trim().min(1),
      context: z.array(z.string().min(1)).min(1).optional(),
      repos: z.array(z.string().min(1)).min(1).optional(),
      lifecycle: NoteLifecycleSchema.optional(),
      capMerge: z
        .object({
          keepId: z.string().regex(/^[RLN][1-9]\d*$/),
          removeId: z.string().regex(/^[RLN][1-9]\d*$/),
          mergedText: z.string().trim().min(1),
        })
        .optional(),
    }),
    z.object({
      op: z.literal('update'),
      callerRole: z.string().min(1),
      id: z.string().regex(/^[RLN][1-9]\d*$/),
      text: z.string().trim().min(1),
      role: z.string().min(1).optional(),
      context: z.array(z.string().min(1)).min(1).nullable().optional(),
      repos: z.array(z.string().min(1)).min(1).nullable().optional(),
      lifecycle: NoteLifecycleSchema.optional(),
      alsoRemoveIds: z.array(z.string().regex(/^[RLN][1-9]\d*$/)).optional(),
    }),
    z.object({
      op: z.literal('remove'),
      callerRole: z.string().min(1),
      id: z.string().regex(/^[RLN][1-9]\d*$/),
      reason: z.enum([
        'owner_veto',
        'promoted_to_tier1_or_tier2',
        'merged_into_wider_record',
        'note_settled_or_obsolete',
      ]),
    }),
  ])
  .superRefine((val, ctx) => {
    if (val.op === 'add') {
      if (val.type === 'note' && val.lifecycle === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['lifecycle'],
          message: 'lifecycle is required when adding a record with type "note".',
        });
      }
      if (val.type !== 'note' && val.lifecycle !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['lifecycle'],
          message: 'lifecycle is only permitted on records with type "note".',
        });
      }
      if (val.capMerge !== undefined) {
        if (val.capMerge.keepId === val.capMerge.removeId) {
          ctx.addIssue({
            code: 'custom',
            path: ['capMerge', 'removeId'],
            message: 'capMerge.keepId and capMerge.removeId must be distinct IDs.',
          });
        }
        const expectedPrefix = val.type === 'rule' ? 'R' : val.type === 'lesson' ? 'L' : 'N';
        if (
          !val.capMerge.keepId.startsWith(expectedPrefix) ||
          !val.capMerge.removeId.startsWith(expectedPrefix)
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['capMerge'],
            message: `capMerge IDs must match the added record prefix '${expectedPrefix}'.`,
          });
        }
      }
    }
    if (val.op === 'update') {
      if (val.lifecycle !== undefined && !val.id.startsWith('N')) {
        ctx.addIssue({
          code: 'custom',
          path: ['lifecycle'],
          message:
            'lifecycle is only permitted when updating a note record (ID starting with "N").',
        });
      }
      if (val.alsoRemoveIds !== undefined) {
        const seen = new Set<string>();
        const targetPrefix = val.id[0];
        for (let i = 0; i < val.alsoRemoveIds.length; i += 1) {
          const remId = val.alsoRemoveIds[i];
          if (remId === undefined) continue;
          if (remId === val.id || seen.has(remId)) {
            ctx.addIssue({
              code: 'custom',
              path: ['alsoRemoveIds', i],
              message: 'alsoRemoveIds must contain unique IDs distinct from target id.',
            });
          }
          seen.add(remId);
          if (targetPrefix !== undefined && !remId.startsWith(targetPrefix)) {
            ctx.addIssue({
              code: 'custom',
              path: ['alsoRemoveIds', i],
              message: `alsoRemoveIds entry '${remId}' must match target record prefix '${targetPrefix}'.`,
            });
          }
        }
      }
    }
  });

/**
 * Inferred input type for `memory_commit`.
 */
export type MemoryCommitInput = z.infer<typeof MemoryCommitInputSchema>;

/**
 * Output schema for `memory_commit`.
 */
export const MemoryCommitOutputSchema = z.object({
  op: z.enum(['add', 'update', 'remove']),
  committedRecord: MemoryRecordSchema.nullable(),
  previousRecord: MemoryRecordSchema.nullable(),
  mergedKeepRecord: MemoryRecordSchema.nullable(),
  removedIds: z.array(z.string().regex(/^[RLN][1-9]\d*$/)),
  bucketStatusAfter: MemoryBucketStatusSchema.nullable(),
  gitCommitted: z.boolean(),
  gitPushed: z.boolean(),
});

/**
 * Inferred output type for `memory_commit`.
 */
export type MemoryCommitOutput = z.infer<typeof MemoryCommitOutputSchema>;

/**
 * Selector for note lifecycle modes in `memory_drain_notes`, where `'*'` selects all modes.
 */
export const DrainNoteModeSelectorSchema = z.enum([
  'persistent',
  'read-count',
  'hard-expiry',
  'soft-expiry',
  '*',
]);

/**
 * Inferred note lifecycle mode selector type.
 */
export type DrainNoteModeSelector = z.infer<typeof DrainNoteModeSelectorSchema>;

/**
 * Input schema for `memory_drain_notes`.
 *
 * @note
 * `modes` is required and must contain at least one mode (or `'*'` to explicitly select all modes).
 * `dryRun` defaults to `true` so callers inspect candidate notes before draining.
 */
export const MemoryDrainNotesInputSchema = z.object({
  callerRole: z.string().min(1),
  modes: z.array(DrainNoteModeSelectorSchema).min(1),
  role: z.string().min(1).optional(),
  paths: z.array(z.string().min(1)).min(1).optional(),
  ids: z.array(z.string().regex(/^N[1-9]\d*$/)).min(1).optional(),
  dryRun: z.boolean().default(true),
});

/**
 * Inferred input type for `memory_drain_notes`.
 */
export type MemoryDrainNotesInput = z.infer<typeof MemoryDrainNotesInputSchema>;

/**
 * Output schema for `memory_drain_notes`.
 */
export const MemoryDrainNotesOutputSchema = z.object({
  dryRun: z.boolean(),
  matchedNotes: z.array(MemoryNoteRecordSchema),
  drainedIds: z.array(z.string().regex(/^N[1-9]\d*$/)),
  gitCommitted: z.boolean(),
  gitPushed: z.boolean(),
});

/**
 * Inferred output type for `memory_drain_notes`.
 */
export type MemoryDrainNotesOutput = z.infer<typeof MemoryDrainNotesOutputSchema>;

/**
 * Normalized input payload passed to `MemoryHarness.handleFileInteractionHook`.
 */
export const FileInteractionHookInputSchema = z.object({
  sessionId: SessionIdSchema,
  role: z.string().min(1).optional(),
  transcriptPath: z.string().min(1).optional(),
  touchedPaths: z.array(z.string().min(1)).min(1),
});

/**
 * Inferred input type for the file-interaction hook handler.
 */
export type FileInteractionHookInput = z.infer<typeof FileInteractionHookInputSchema>;

/**
 * Output payload returned by `MemoryHarness.handleFileInteractionHook`.
 */
export const FileInteractionHookOutputSchema = z.object({
  injected: z.boolean(),
  compactionEpochId: z.string().min(1),
  formattedContext: z.string().nullable(),
  rules: z.array(MemoryRuleRecordSchema),
  lessons: z.array(MemoryLessonRecordSchema),
  notes: z.array(MemoryLoadedNoteRecordSchema),
});

/**
 * Inferred output type for the file-interaction hook handler.
 */
export type FileInteractionHookOutput = z.infer<typeof FileInteractionHookOutputSchema>;

/**
 * Fallback active session role persisted at `.memory/.session-state/latest-role.json`.
 */
export const MemoryLatestRoleStateSchema = z.object({
  role: z.string().min(1),
  updatedAt: z.iso.datetime(),
});

/**
 * Inferred fallback latest-role state type.
 */
export type MemoryLatestRoleState = z.infer<typeof MemoryLatestRoleStateSchema>;

/**
 * Per-session deduplication state persisted at `.memory/.session-state/<sessionId>.json`.
 */
export const MemorySessionEpochStateSchema = z.object({
  sessionId: SessionIdSchema,
  role: z.string().min(1),
  lastCompactionCheckpointId: z.string().min(1),
  seenRecordIds: z.array(z.string().regex(/^[RLN][1-9]\d*$/)).default([]),
  lastScannedTranscriptOffset: z.number().int().min(0).default(0),
  transcriptPath: z.string().min(1).optional(),
  updatedAt: z.iso.datetime(),
});

/**
 * Inferred per-session compaction-epoch deduplication state type.
 */
export type MemorySessionEpochState = z.infer<typeof MemorySessionEpochStateSchema>;
