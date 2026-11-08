import { z } from 'zod';
import type { DistilledLessonCandidate } from '../ports/distilled-lesson-candidate.js';

/**
 * Zod schema validating a human budget approval response (`M.lane.maxCostUsd`).
 */
export const BudgetApprovalSchema = z.object({
  approved: z.boolean(),
  increaseLimitToUsd: z.number().optional(),
});

/**
 * Validated human budget approval decision payload.
 */
export type BudgetApproval = z.infer<typeof BudgetApprovalSchema>;

/**
 * Zod schema validating a contrastive distiller agent's structured lesson candidate output.
 */
export const DistilledLessonCandidateSchema: z.ZodType<DistilledLessonCandidate> = z.object({
  admit: z.boolean(),
  partition: z.string().optional(),
  directive: z.string().optional(),
});

/**
 * Zod schema validating the built-in `resumeFork` capability tool input for parent agents declaring `.onChildInterrupt()`.
 */
export const ResumeForkInputSchema = z.object({
  suspendedForkIds: z.array(z.string()).min(1),
  action: z.enum(['resume', 'abort']).default('resume'),
  resolutionSummary: z.string(),
});

/**
 * Validated input payload for the built-in `resumeFork` capability tool.
 */
export type ResumeForkInput = z.infer<typeof ResumeForkInputSchema>;
