import type { ArbiterVerdict, WorkItem } from '../engineering-schemas.schema.js';

/**
 * Projects a winning speculative branch and losing branch diff summary into a refinement `WorkItem` (`CODING_SAMPLE.md` §6.8).
 *
 * Scans `candidates` in a single pass to locate the winning branch input and losing completed branch's
 * pinned `headRef` and `diffStat`, appending `verdict.followUpDeficits` so the refinement loop can
 * cross-pollinate via `git.candidateComparisonTools`.
 *
 * @param {WorkItem}       parentItem - Parent coordinator `WorkItem`.
 * @param {ArbiterVerdict} verdict    - Arbiter verdict triggering winner refinement.
 * @param {ReadonlyArray<{ readonly status: string; readonly branchIndex: number; readonly input: WorkItem; readonly scopeReceipt?: { readonly headRef: string; readonly diffStat: string } }>} candidates - Inspected tournament candidate records.
 *
 * @returns {WorkItem} Monomorphic `WorkItem` input for the post-arbitration refinement worker loop.
 */
export function buildRefinedWinnerWorkItem(
  parentItem: WorkItem,
  verdict: ArbiterVerdict,
  candidates: ReadonlyArray<{
    readonly status: string;
    readonly branchIndex: number;
    readonly input: WorkItem;
    readonly scopeReceipt?: {
      readonly headRef: string;
      readonly diffStat: string;
    };
  }>,
): WorkItem {
  const selectedWinnerIndex =
    verdict.decision === 'select-winner' ? verdict.winnerBranchIndex : 0;
  const followUpDeficits =
    verdict.decision === 'select-winner' ? verdict.followUpDeficits : [];
  let baseWinnerInput = parentItem;
  let loserSummaryLines: readonly string[] = [];
  for (const candidate of candidates) {
    if (candidate.status !== 'COMPLETED') continue;
    if (candidate.branchIndex === selectedWinnerIndex) {
      baseWinnerInput = candidate.input;
    } else if (candidate.scopeReceipt !== undefined) {
      loserSummaryLines = [
        `Losing branch (branchIndex: ${candidate.branchIndex}, git ref: ${candidate.scopeReceipt.headRef}) for inspection via candidateComparisonTools.`,
        `Losing branch diff stat:\n${candidate.scopeReceipt.diffStat}`,
      ];
    }
  }
  const descriptionLines: string[] = [
    baseWinnerInput.description,
    '',
    'Apply cross-pollination deficits from speculative arbitration:',
  ];
  for (const deficit of followUpDeficits) {
    descriptionLines.push(`- ${deficit}`);
  }
  for (const line of loserSummaryLines) {
    descriptionLines.push(line);
  }
  return {
    ref: baseWinnerInput.ref,
    title: baseWinnerInput.title,
    description: descriptionLines.join('\n'),
    routingTier: 'leaf-only',
    targetPartitions: baseWinnerInput.targetPartitions,
    dependsOn: baseWinnerInput.dependsOn,
  };
}
