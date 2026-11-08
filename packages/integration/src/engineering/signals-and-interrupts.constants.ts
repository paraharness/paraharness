import { M, z } from '@metaharness/core';
import { partitionEnum } from './engineering-schemas.schema.js';

/**
 * External steering signal (`steer`) emitted when the owner provides mid-flight guidance (`CODING_SAMPLE.md` §6.1).
 *
 * Triggers `engineeringLane` to update the active `workItem` description with the owner note,
 * promote `routingTier` to `'deep'`, and rewind the flow to `'execute-work'` while preserving the worktree.
 */
export const steerSignal = M.signal('steer').payload(
  z.object({ note: z.string() }),
);

/**
 * External lifecycle signal (`change-shipped`) emitted when a `fix/<ref>` pull request merges (`CODING_SAMPLE.md` §6.1).
 *
 * Correlates by `ref` and `baseBranch` to commit sealed `repoTopology` overlays, advance lesson creation epochs,
 * and schedule cold-tier ledger compaction after the configured grace period.
 */
export const changeShippedSignal = M.signal('change-shipped').payload(
  z.object({ ref: z.string(), mergeCommitSha: z.string(), baseBranch: z.string() }),
);

/**
 * External lifecycle signal (`pr-closed-unmerged`) emitted when a `fix/<ref>` pull request closes without merging (`CODING_SAMPLE.md` §6.1).
 *
 * Correlates by `ref` to discard any uncommitted `repoTopology` contract overlay for the abandoned run.
 */
export const prClosedUnmergedSignal = M.signal('pr-closed-unmerged').payload(
  z.object({ ref: z.string() }),
);

/**
 * Empirical lesson graduation signal (`high-leverage-lesson`) emitted when a lesson crosses high-confidence thresholds (`CODING_SAMPLE.md` §6.1).
 *
 * Notifies `owner` via `appHarness.onSignal` so high-performing empirical lessons can be promoted to static `repoRules` or checks.
 */
export const highLeverageLessonSignal = M.signal('high-leverage-lesson').payload(
  z.object({
    lessonId: z.string(),
    directive: z.string(),
    partition: partitionEnum.optional(),
    cleanPassCount: z.number(),
    violatedCount: z.number(),
  }),
);

/**
 * Fast-path tripwire interrupt (`scope-exceeded`) raised when an optimistic attempt exceeds file or turn bounds (`CODING_SAMPLE.md` §6.1).
 *
 * Flushes structured reconnaissance (`reason`, `implicatedPartitions`, `findings`), snapshots the dirty worktree
 * to `refs/harness/aborted/<run-id>/<stepExecId>`, and promotes execution to `coordinator`.
 */
export const scopeTripwire = M.interrupt('scope-exceeded').payload(
  z.object({
    reason: z.string(),
    implicatedPartitions: z.array(partitionEnum),
    findings: z.string(),
  }),
);

/**
 * Pre-flight write-guard interrupt (`lease-request`) raised when a worker attempts to mutate an existing test file (`CODING_SAMPLE.md` §6.1).
 *
 * Intercepts the blocked tool call inside `PendingToolBatch` and routes the requested paths and justification
 * to `leaseAdjudicator` without losing the worker's in-progress turn state.
 */
export const leaseRequest = M.interrupt('lease-request').payload(
  z.object({
    requestedPaths: z.array(z.string()),
    justification: z.string(),
  }),
);

/**
 * Upward architectural interrupt (`contract-violation`) raised when a worker or evaluator detects a broken partition boundary (`CODING_SAMPLE.md` §6.1).
 *
 * Suspends the raising fork's continuation stack, pauses sibling forks in `repoTopology.affectedBy(partition)`,
 * and returns a structured `SUSPENDED_ON_INTERRUPT` tool result to `coordinator`.
 */
export const contractViolation = M.interrupt('contract-violation').payload(
  z.object({
    partition: partitionEnum,
    brokenInvariant: z.string(),
    proof: z.string(),
    proposedPatch: z.string(),
  }),
);

/**
 * Exogenous product/specification trade-off interrupt (`normative-tradeoff`) requiring an `owner` decision (`CODING_SAMPLE.md` §6.1).
 *
 * Parks automatically inside speculative tournaments (`PARKED_ON_ESCALATION`) unless `candidateArbiter`
 * explicitly unparks the branch, and pages `owner` when raised from a non-speculative execution path.
 */
export const normativeEscalation = M.interrupt('normative-tradeoff').payload(
  z.object({
    question: z.string(),
    options: z.array(
      z.object({
        id: z.string(),
        summary: z.string(),
        tradeoffs: z.string(),
        proposedSpecDiff: z.string().optional(),
        candidateCommitRef: z.string().optional(),
      }),
    ),
    recommendation: z.string(),
  }),
);
