import { z } from '@metaharness/core';
import { git } from '@metaharness/git';

/**
 * Zod enumeration of repository architectural partitions (`'db'`, `'api'`, `'web'`).
 *
 * Constrains partition references across work items, fork requests, speculative tournaments,
 * contract violations, and high-leverage lesson signals.
 */
export const partitionEnum = z.enum(['db', 'api', 'web']);

/**
 * Zod schema validating an incoming engineering work item (`CODING_SAMPLE.md` §6.1).
 *
 * Captures the issue reference, title, description, routing tier (`'auto'`, `'leaf-only'`, `'deep'`),
 * target repository partitions, and upstream prerequisite references.
 */
export const workItem = z.object({
  ref: z.string(),
  title: z.string(),
  description: z.string(),
  routingTier: z.enum(['auto', 'leaf-only', 'deep']).default('auto'),
  targetPartitions: z.array(partitionEnum).default([]),
  dependsOn: z.array(z.string()).default([]),
});

/** Validated engineering work item payload inferred from `workItem`. */
export type WorkItem = z.infer<typeof workItem>;

/**
 * Zod schema validating a completed worker or coordinator execution receipt (`CODING_SAMPLE.md` §6.1).
 *
 * Records the change summary, newly discovered domain invariants, and any residual risks.
 */
export const workReceipt = z.object({
  summary: z.string(),
  discoveredInvariants: z.array(z.string()).default([]),
  residualRisks: z.array(z.string()).default([]),
});

/** Validated worker or coordinator execution receipt inferred from `workReceipt`. */
export type WorkReceipt = z.infer<typeof workReceipt>;

/**
 * Zod schema validating the independent `evaluator` verdict inside `verifiedWorkerLoop` (`CODING_SAMPLE.md` §6.1).
 *
 * Indicates whether the candidate work receipt and diff satisfy all specifications or lists concrete deficits.
 */
export const evaluationResult = z.object({
  accepted: z.boolean(),
  deficits: z.array(z.string()).default([]),
});

/** Validated evaluation verdict payload inferred from `evaluationResult`. */
export type EvaluationResult = z.infer<typeof evaluationResult>;

/**
 * Zod schema validating a downward partition fork request (`delegate-partition`) from `coordinator` (`CODING_SAMPLE.md` §6.1).
 *
 * Specifies the target partition, scoped objective, estimated turn count for break-even model routing, and context notes.
 */
export const forkRequestSchema = z.object({
  partition: partitionEnum,
  objective: z.string(),
  estimatedTurns: z.number().int().min(1).max(30).default(8),
  contextNotes: z.string().default(''),
});

/** Validated downward partition fork request payload inferred from `forkRequestSchema`. */
export type ForkRequest = z.infer<typeof forkRequestSchema>;

/**
 * Zod schema validating a 2-branch speculative tournament request (`explore-candidates`) (`CODING_SAMPLE.md` §6.1).
 *
 * Defines the target partition, shared problem statement, and competing implementation strategies A and B.
 */
export const speculateRequestSchema = z.object({
  partition: partitionEnum,
  problemStatement: z.string(),
  strategyA: z.string(),
  strategyB: z.string(),
});

/** Validated speculative tournament request payload inferred from `speculateRequestSchema`. */
export type SpeculateRequest = z.infer<typeof speculateRequestSchema>;

/**
 * Zod discriminated union schema for `candidateArbiter` tournament verdicts (`CODING_SAMPLE.md` §6.1).
 *
 * Supports selecting a winning branch (with optional cross-pollination deficits), unparking a deferred
 * normative escalation branch, or rejecting all candidate branches.
 */
export const arbiterVerdictSchema = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('select-winner'),
    winnerBranchIndex: z.union([z.literal(0), z.literal(1)]),
    rationale: z.string(),
    followUpDeficits: z.array(z.string()).default([]),
  }),
  z.object({
    decision: z.literal('unpark-escalation'),
    parkedBranchIndex: z.union([z.literal(0), z.literal(1)]),
    rationale: z.string(),
  }),
  z.object({
    decision: z.literal('reject-all'),
    rationale: z.string(),
  }),
]);

/** Validated speculative tournament arbiter verdict inferred from `arbiterVerdictSchema`. */
export type ArbiterVerdict = z.infer<typeof arbiterVerdictSchema>;

/**
 * Zod schema validating an owner ruling on a `normativeEscalation` interrupt (`CODING_SAMPLE.md` §6.1).
 *
 * Captures the chosen option identifier, whether exogenous specification mutation is approved,
 * which specification files are unlocked for writing, and an optional guidance note.
 */
export const ownerDecisionSchema = z.object({
  selectedOptionId: z.string(),
  approveSpecMutation: z.boolean().default(false),
  unlockedSpecFiles: z.array(z.enum(['PRODUCT_SPEC.md', 'openapi.yaml'])).default([]),
  note: z.string().optional(),
});

/** Validated owner normative decision payload inferred from `ownerDecisionSchema`. */
export type OwnerDecision = z.infer<typeof ownerDecisionSchema>;

/**
 * Zod schema validating the input to the post-execution delivery steps (`landChanges`, `checkExistingPr`, `publishPr`).
 *
 * Bundles the originating `workItem`, the accepted `workReceipt`, and the CoW worktree `scopeReceipt`.
 */
export const deliveryInputSchema = z.object({
  item: workItem,
  receipt: workReceipt,
  scopeReceipt: git.ScopeReceiptSchema,
});

/** Validated delivery pipeline step input inferred from `deliveryInputSchema`. */
export type DeliveryInput = z.infer<typeof deliveryInputSchema>;
