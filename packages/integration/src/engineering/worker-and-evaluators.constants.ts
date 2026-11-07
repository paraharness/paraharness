import { H, z } from '@harness-dsl/core';
import { fs } from '@harness-dsl/fs';
import { git } from '@harness-dsl/git';
import {
  arbiterVerdictSchema,
  evaluationResult,
  ownerDecisionSchema,
  workItem,
  workReceipt,
} from './engineering-schemas.schema.js';
import { readOnlyPolicy, workerBasePolicy } from './policies.constants.js';
import {
  opus,
  owner,
  runner,
  verifySuite,
  workerModels,
} from './pools-and-services.constants.js';
import {
  dbMigrationSkill,
  engineeringPrefix,
  repoLessons,
  repoRules,
  sharedProceduralSkills,
  uiVerificationSkill,
} from './rules-lessons-and-skills.constants.js';
import {
  contractViolation,
  leaseRequest,
  normativeEscalation,
} from './signals-and-interrupts.constants.js';
import { repoPartitions, repoTopology } from './topology-and-workspace.constants.js';

/**
 * Public-surface AST cross-tester (`crossTester`) comparing speculative candidate exports and tests (`CODING_SAMPLE.md` §6.7).
 *
 * Extracts public exports across `repoPartitions` and runs candidate test suites against competing implementations.
 */
export const crossTester = git.publicSurfaceCrossTester({
  runner,
  partitionMap: repoPartitions,
});

/**
 * Base implementation worker agent (`worker`) sharing `engineeringPrefix` and backed by `workerModels` (`CODING_SAMPLE.md` §6.7).
 *
 * Mounts coding tools, `verifySuite.asTool()`, progressive-disclosure skills, and `verifySuite` as a `.beforeStop` gate,
 * and can raise `contractViolation` when an upstream partition boundary must change.
 */
export const worker = H.agent('worker')
  .prefixGroup(engineeringPrefix)
  .model(workerModels)
  .topology(repoTopology)
  .rules(repoRules)
  .lessons(repoLessons)
  .skills(dbMigrationSkill, uiVerificationSkill, sharedProceduralSkills)
  .tools(fs.codingTools(runner), verifySuite.asTool())
  .instructions(fs.text('.harness/prompts/worker.md'))
  .timeoutMinutes(15)
  .beforeStop(verifySuite)
  .input(workItem)
  .partitions((item) => item.targetPartitions)
  .output(workReceipt)
  .canRaise(contractViolation);

/**
 * Read-only verification evaluator agent (`evaluator`) auditing candidate work receipts and diffs (`CODING_SAMPLE.md` §6.7).
 *
 * Shares `engineeringPrefix` with `'role-scoped'` tools, inspects the worktree using `fs.readOnlyTools(runner)`,
 * and emits an `evaluationResult` verdict or raises `contractViolation`.
 */
export const evaluator = H.agent('evaluator')
  .prefixGroup(engineeringPrefix)
  .model(opus)
  .topology(repoTopology)
  .rules(repoRules)
  .skills(uiVerificationSkill)
  .policy(readOnlyPolicy)
  .tools(fs.readOnlyTools(runner))
  .instructions(fs.text('.harness/prompts/evaluator.md'))
  .timeoutMinutes(10)
  .input(
    z.object({
      item: workItem,
      candidate: workReceipt,
      scopeReceipt: git.ScopeReceiptSchema,
    }),
  )
  .partitions(({ item }) => item.targetPartitions)
  .output(evaluationResult)
  .canRaise(contractViolation);

/**
 * Read-only test-lease adjudicator agent (`lease-adjudicator`) evaluating `leaseRequest` interrupts (`CODING_SAMPLE.md` §6.7).
 *
 * Verifies whether an existing `.test.ts`/`.test.tsx` mutation reflects an approved behavioral change or a broken test,
 * or raises `normativeEscalation` to `owner` when a specification change is required.
 */
export const leaseAdjudicator = H.agent('lease-adjudicator')
  .model(opus)
  .topology(repoTopology)
  .rules(repoRules)
  .policy(readOnlyPolicy)
  .tools(fs.readOnlyTools(runner))
  .instructions(fs.text('.harness/prompts/lease-adjudicator.md'))
  .input(z.object({ item: workItem, request: leaseRequest.schema }))
  .partitions(({ item }) => item.targetPartitions)
  .output(
    z.object({
      approved: z.boolean(),
      unlockedGlobs: z.array(z.string()),
      ruling: z.string(),
    }),
  )
  .canRaise(normativeEscalation);

/**
 * Read-only speculative tournament arbiter (`candidate-arbiter`) comparing candidate branches (`CODING_SAMPLE.md` §6.7).
 *
 * Inspects completed and parked branches alongside `crossTester` reports and `git.candidateComparisonTools(runner)`
 * to select a winner, unpark a deferred escalation, or reject all candidates.
 */
export const candidateArbiter = H.agent('candidate-arbiter')
  .model(opus)
  .topology(repoTopology)
  .rules(repoRules)
  .policy(readOnlyPolicy)
  .tools(fs.readOnlyTools(runner), git.candidateComparisonTools(runner))
  .instructions(fs.text('.harness/prompts/candidate-arbiter.md'))
  .input(
    H.SpeculationInputSchema(
      workItem,
      workReceipt,
      git.ScopeReceiptSchema,
      crossTester.reportSchema,
      z.union([normativeEscalation.schema, contractViolation.schema]),
    ),
  )
  .partitions((speculationInput) => {
    const partitions = new Set<'db' | 'api' | 'web'>();
    for (const candidate of speculationInput.candidates) {
      for (const partition of candidate.input.targetPartitions) {
        partitions.add(partition);
      }
    }
    return Array.from(partitions);
  })
  .output(arbiterVerdictSchema);

/**
 * Policy-guarded worker (`guardedWorker`) binding `workerBasePolicy` and actor-level `leaseRequest` adjudication (`CODING_SAMPLE.md` §6.7).
 *
 * Preserves its `.onInterrupt(leaseRequest, ...)` handler across `.withPolicy()` and `.withTools()` clones,
 * recording both owner spec leases and test-file write leases on the outer worker frame and enclosing loop frame.
 */
export const guardedWorker = worker
  .withPolicy(workerBasePolicy)
  .onInterrupt(leaseRequest, ($intr) =>
    $intr
      .adjudicateWith(leaseAdjudicator, (item, req) => ({ item, request: req }))
      .onInterrupt(normativeEscalation, ($esc) =>
        $esc
          .ask(owner, ownerDecisionSchema)
          .elevateLeaseWhen(
            (decision) => decision.approveSpecMutation && decision.unlockedSpecFiles.length > 0,
            (decision) => fs.allowWriteGlobs(decision.unlockedSpecFiles),
          )
          .resumeWith(
            (decision) =>
              `Owner selected option '${decision.selectedOptionId}'. Note: ${decision.note ?? 'None'}`,
          ),
      )
      .elevateLeaseWhen(
        (_item, req, verdict) => {
          if (!verdict.approved || verdict.unlockedGlobs.length === 0) return false;
          const requestedSet = new Set<string>(req.requestedPaths);
          for (const globPattern of verdict.unlockedGlobs) {
            if (!/\.test\.tsx?$/.test(globPattern) || !requestedSet.has(globPattern)) {
              return false;
            }
          }
          return true;
        },
        (_item, _req, verdict) => fs.allowWriteGlobs(verdict.unlockedGlobs),
      )
      .resumeWith((_item, _req, verdict) => verdict.ruling),
  );

/**
 * Iterative actor-evaluator refinement loop (`verified-worker-loop`) pairing `guardedWorker` with `evaluator` (`CODING_SAMPLE.md` §6.7).
 *
 * Runs up to 3 iterations while preserving the worker's multi-turn session and distilling failure-to-pass
 * trajectories into `repoLessons`.
 */
export const verifiedWorkerLoop = H.loop('verified-worker-loop')
  .input(workItem)
  .output(workReceipt)
  .partitions((item) => item.targetPartitions)
  .maxIterations(3)
  .preserveActorSession(true)
  .distillLessonsInto(repoLessons)
  .act('execute', guardedWorker)
  .evaluate('evaluate', evaluator, {
    mapInput: (item, candidate, scopeReceipt) => ({ item, candidate, scopeReceipt }),
    acceptWhen: (ev) => ev.accepted && ev.deficits.length === 0,
    feedbackMapper: (ev) => `Resolve these evaluation deficits:\n- ${ev.deficits.join('\n- ')}`,
  })
  .returnOutputFrom('execute');
