import type { WorkItem } from '../engineering-schemas.schema.js';

/**
 * Promotes a `'leaf-only'` work item that raised `contractViolation` into a `'deep'` coordinator `WorkItem` (`CODING_SAMPLE.md` §6.9).
 *
 * Merges `violation.partition` into `item.targetPartitions` and appends the broken invariant, proof,
 * proposed patch, and `abortedSnapshotRef` to `description`.
 *
 * @param {WorkItem} item - Original `'leaf-only'` work item.
 * @param {{ readonly partition: 'db' | 'api' | 'web'; readonly brokenInvariant: string; readonly proof: string; readonly proposedPatch: string }} violation - Raised `contractViolation` payload.
 * @param {{ readonly abortMeta?: { readonly abortedSnapshotRef?: string } }} telemetry - Aborted step telemetry containing `abortedSnapshotRef`.
 *
 * @returns {WorkItem} Promoted `'deep'` work item for `coordinator`.
 */
export function promoteLeafContractViolationToCoordinator(
  item: WorkItem,
  violation: {
    readonly partition: 'db' | 'api' | 'web';
    readonly brokenInvariant: string;
    readonly proof: string;
    readonly proposedPatch: string;
  },
  telemetry: {
    readonly abortMeta?: {
      readonly abortedSnapshotRef?: string;
    };
  },
): WorkItem {
  const mergedPartitions = new Set<'db' | 'api' | 'web'>(item.targetPartitions);
  mergedPartitions.add(violation.partition);
  return {
    ref: item.ref,
    title: item.title,
    description: [
      item.description,
      `--- ESCALATED CONTRACT VIOLATION (${violation.partition}) ---`,
      `Broken invariant: ${violation.brokenInvariant}`,
      `Proof: ${violation.proof}`,
      `Proposed patch: ${violation.proposedPatch}`,
      `Aborted snapshot ref (inspect via git.refReaderTools): ${telemetry.abortMeta?.abortedSnapshotRef ?? 'none'}`,
    ].join('\n'),
    routingTier: 'deep',
    targetPartitions: Array.from(mergedPartitions),
    dependsOn: item.dependsOn,
  };
}
