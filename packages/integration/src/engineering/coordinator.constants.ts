import { P } from '@paraharness/core';
import { fs } from '@paraharness/fs';
import { git } from '@paraharness/git';
import {
  forkRequestSchema,
  ownerDecisionSchema,
  speculateRequestSchema,
  workItem,
  workReceipt,
} from './engineering-schemas.schema.js';
import { buildRefinedWinnerWorkItem } from './internal/build-refined-winner-work-item.js';
import { buildSpeculativeCandidateBranches } from './internal/build-speculative-candidate-branches.js';
import { coordinatorPolicy } from './policies.constants.js';
import {
  opus,
  owner,
  runner,
  verifySuite,
  workerModels,
} from './pools-and-services.constants.js';
import {
  engineeringPrefix,
  repoLessons,
  repoRules,
} from './rules-lessons-and-skills.constants.js';
import {
  contractViolation,
  normativeEscalation,
} from './signals-and-interrupts.constants.js';
import { repoTopology } from './topology-and-workspace.constants.js';
import {
  candidateArbiter,
  crossTester,
  verifiedWorkerLoop,
} from './worker-and-evaluators.constants.js';

/**
 * Long-horizon architectural coordinator agent (`coordinator`) orchestrating partition forks, speculation, and DAG mutation (`CODING_SAMPLE.md` §6.8).
 *
 * Owns endogenous architecture (`TECH_DESIGN.md` and `packages/<partition>/src/index.ts`), dispatches warm-prefix forks via
 * `delegate-partition`, runs 2-branch speculative tournaments via `explore-candidates`, spawns prerequisite tasks
 * via `mutatePlan`, escalates exogenous trade-offs via `normativeEscalation`, and handles upward `contractViolation`
 * interrupts across affected sibling forks.
 */
export const coordinator = P.agent('coordinator')
  .prefixGroup(engineeringPrefix)
  .model(opus)
  .topology(repoTopology)
  .rules(repoRules)
  .lessons(repoLessons, { recordOutcomes: false })
  .policy(coordinatorPolicy)
  .tools(fs.codingTools(runner), git.refReaderTools(runner))
  .instructions(fs.text('.harness/prompts/coordinator.md'))
  .input(workItem)
  .partitions((item) => item.targetPartitions)
  .output(workReceipt)
  .capabilities(($cap) =>
    $cap
      .fork('delegate-partition', verifiedWorkerLoop, ($f) =>
        $f
          .historyMode('shared-prefix-only')
          .requestSchema(forkRequestSchema)
          .mapInput((parentItem, req) => ({
            ref: parentItem.ref,
            title: `${parentItem.title} [${req.partition}]`,
            description: `${req.objective}\n\nContext:\n${req.contextNotes}`,
            routingTier: 'leaf-only',
            targetPartitions: [req.partition],
            dependsOn: [],
          }))
          .modelRouting(($m) =>
            $m
              .inheritParentWithEffort('medium', {
                when: (_parentItem, req) => req.estimatedTurns <= 6,
              })
              .otherwisePool(workerModels),
          ),
      )
      .speculate('explore-candidates', ($s) =>
        $s
          .requestSchema(speculateRequestSchema)
          .worker(verifiedWorkerLoop)
          .branches(2, buildSpeculativeCandidateBranches)
          .crossVerifyWith(crossTester)
          .arbiter(candidateArbiter, {
            resolveDecision: (verdict) => verdict,
          })
          .refineWinnerWhen(
            (verdict) => verdict.decision === 'select-winner' && verdict.followUpDeficits.length > 0,
            verifiedWorkerLoop.withTools(git.candidateComparisonTools(runner)),
            buildRefinedWinnerWorkItem,
          ),
      )
      .mutatePlan(($m) =>
        $m
          .canSpawnTasks(workItem, {
            maxSpawnedPerRun: 6,
            maxPrerequisiteDepth: 3,
            enforcePatch: { routingTier: 'leaf-only' },
            onPrerequisiteSpawned: 'suspend-and-yield-slot',
            priorityStrategy: 'inherit-parent-with-boost',
            resumeWhen: 'prerequisite-exit',
          })
          .canAddDependencies()
          .canUpdateTopologyContracts(repoTopology),
      )
      .escalate(normativeEscalation, ($esc) =>
        $esc
          .to(owner)
          .response(ownerDecisionSchema)
          .elevateLeaseWhen(
            (decision) => decision.approveSpecMutation && decision.unlockedSpecFiles.length > 0,
            (decision) => fs.allowWriteGlobs(decision.unlockedSpecFiles),
          ),
      ),
  )
  .onChildInterrupt(contractViolation, ($intr) =>
    $intr
      .pauseSiblingForksInPartitions((violation) => repoTopology.affectedBy(violation.partition))
      .suspendAndReturnToParent(),
  )
  .beforeStop(verifySuite);
