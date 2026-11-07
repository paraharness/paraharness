import { H, z } from '@harness-dsl/core';
import { fs } from '@harness-dsl/fs';
import { git } from '@harness-dsl/git';
import { local } from '@harness-dsl/node';
import { coordinator } from './coordinator.constants.js';
import {
  deliveryInputSchema,
  type DeliveryInput,
  workItem,
  workReceipt,
} from './engineering-schemas.schema.js';
import { fastPathPolicy } from './policies.constants.js';
import { runner } from './pools-and-services.constants.js';
import {
  contractViolation,
  scopeTripwire,
} from './signals-and-interrupts.constants.js';
import { workspace } from './topology-and-workspace.constants.js';
import { verifiedWorkerLoop } from './worker-and-evaluators.constants.js';

/**
 * Git commit-and-push delivery step (`land-changes`) pushing accepted work to `fix/<ref>` (`CODING_SAMPLE.md` §6.9).
 *
 * Commits staged changes with message `<ref>: <title>` and pushes the branch using symbolic `H.env('GITHUB_TOKEN')`.
 */
export const landChanges = git
  .commitAndPush('land-changes', {
    branch: ({ item }: DeliveryInput) => `fix/${item.ref}`,
    message: ({ item }) => `${item.ref}: ${item.title}`,
  })
  .input(deliveryInputSchema)
  .runner(runner)
  .env({ GH_TOKEN: H.env('GITHUB_TOKEN') });

/**
 * Idempotency probe command (`check-existing-pr`) checking whether an open or merged PR already exists for `fix/<ref>` (`CODING_SAMPLE.md` §6.9).
 *
 * Returns a boolean parsed by `publishPr.unrepeatable(...)` before attempting pull request creation.
 */
export const checkExistingPr = local
  .command('check-existing-pr')
  .input(deliveryInputSchema)
  .output(z.boolean())
  .runner(runner)
  .stdin('closed')
  .env({ GH_TOKEN: H.env('GITHUB_TOKEN') })
  .argv(({ item }) => [
    'sh',
    '-c',
    'gh pr view "fix/$1" --json state -q \'.state == "OPEN" or .state == "MERGED"\' 2>/dev/null | grep -q \'^true$\' && echo true || echo false',
    '_',
    item.ref,
  ]);

/**
 * Unrepeatable pull request creation command (`publish-pr`) targeting `scopeReceipt.baseBranch` (`CODING_SAMPLE.md` §6.9).
 *
 * Preserves stacked-PR base branch lineage (`fix/#102` vs `main`) and guards against duplicate PR creation via `checkExistingPr`.
 */
export const publishPr = local
  .command('publish-pr')
  .input(deliveryInputSchema)
  .runner(runner)
  .stdin('closed')
  .env({ GH_TOKEN: H.env('GITHUB_TOKEN') })
  .argv(({ item, receipt, scopeReceipt }) => [
    'gh', 'pr', 'create',
    '--base', scopeReceipt.baseBranch,
    '--head', `fix/${item.ref}`,
    '--title', `${item.ref}: ${item.title}`,
    '--body', receipt.summary,
  ])
  .unrepeatable(checkExistingPr, { key: ({ item }) => item.ref });

/**
 * Adaptive 3-route engineering execution flow (`adaptive-engineering`) over `workspace` (`CODING_SAMPLE.md` §6.9).
 *
 * Routes `'deep'` or multi-partition items directly to `coordinator`, `'leaf-only'` items to `verifiedWorkerLoop`
 * (promoting to `coordinator` on `contractViolation`), and `'auto'` items to the evaluated fast path
 * (`verifiedWorkerLoop.withPolicy(fastPathPolicy)`), followed by `landChanges` and `publishPr`.
 */
export const engineeringFlow = H.flow('adaptive-engineering')
  .input(workItem)
  .scope(workspace)
  .telemetry(fs.telemetry())
  .branch('execute-work', ($b) =>
    $b
      .output(workReceipt)
      .when(
        (item) => item.routingTier === 'deep' || item.targetPartitions.length > 1,
        ($deep) => $deep.step('coordinate', coordinator),
      )
      .when(
        (item) => item.routingTier === 'leaf-only',
        ($leaf) =>
          $leaf.step('leaf-execute', verifiedWorkerLoop, ($step) =>
            $step.onInterrupt(contractViolation, ($promote) =>
              $promote
                .onAbort(git.snapshotAndReset())
                .replaceWith(coordinator, (item, violation, telemetry) => ({
                  ...item,
                  routingTier: 'deep' as const,
                  targetPartitions: Array.from(
                    new Set([...item.targetPartitions, violation.partition]),
                  ),
                  description: [
                    item.description,
                    `--- ESCALATED CONTRACT VIOLATION (${violation.partition}) ---`,
                    `Broken invariant: ${violation.brokenInvariant}`,
                    `Proof: ${violation.proof}`,
                    `Proposed patch: ${violation.proposedPatch}`,
                    `Aborted snapshot ref (inspect via git.refReaderTools): ${telemetry.abortMeta?.abortedSnapshotRef ?? 'none'}`,
                  ].join('\n'),
                })),
            ),
          ),
      )
      .otherwise(($fast) =>
        $fast.step('fast-attempt', verifiedWorkerLoop.withPolicy(fastPathPolicy), ($step) =>
          $step
            .onInterrupt(scopeTripwire, ($promote) =>
              $promote
                .onAbort(git.snapshotAndReset())
                .replaceWith(coordinator, (item, tripwire, telemetry) => ({
                  ...item,
                  routingTier: 'deep' as const,
                  targetPartitions: tripwire.implicatedPartitions,
                  description: [
                    item.description,
                    `--- FAST-PATH RECONNAISSANCE ---`,
                    `Reason aborted: ${tripwire.reason}`,
                    `Partitions implicated: ${tripwire.implicatedPartitions.join(', ')}`,
                    `Files inspected: ${telemetry.custom.filesRead.join(', ')}`,
                    `Aborted snapshot ref (inspect via git.refReaderTools): ${telemetry.abortMeta?.abortedSnapshotRef ?? 'none'}`,
                    `Findings: ${tripwire.findings}`,
                  ].join('\n'),
                })),
            )
            .onInterrupt(contractViolation, ($promote) =>
              $promote
                .onAbort(git.snapshotAndReset())
                .replaceWith(coordinator, (item, violation, telemetry) => ({
                  ...item,
                  routingTier: 'deep' as const,
                  targetPartitions: Array.from(
                    new Set([...item.targetPartitions, violation.partition]),
                  ),
                  description: [
                    item.description,
                    `--- FAST-PATH CONTRACT VIOLATION (${violation.partition}) ---`,
                    `Broken invariant: ${violation.brokenInvariant}`,
                    `Proof: ${violation.proof}`,
                    `Proposed patch: ${violation.proposedPatch}`,
                    `Files inspected: ${telemetry.custom.filesRead.join(', ')}`,
                    `Aborted snapshot ref (inspect via git.refReaderTools): ${telemetry.abortMeta?.abortedSnapshotRef ?? 'none'}`,
                  ].join('\n'),
                })),
            ),
        ),
      ),
  )
  .step('push', landChanges, ($s) =>
    $s.inputFrom((item, steps, scopeReceipt) => ({
      item,
      receipt: steps['execute-work'],
      scopeReceipt,
    })),
  )
  .step('publish', publishPr, ($s) =>
    $s.inputFrom((item, steps, scopeReceipt) => ({
      item,
      receipt: steps['execute-work'],
      scopeReceipt,
    })),
  )
  .exit('done');
