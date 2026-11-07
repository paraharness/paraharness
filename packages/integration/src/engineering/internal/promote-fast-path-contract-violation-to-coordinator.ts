import type { WorkItem } from '../engineering-schemas.schema.js';

/**
 * Promotes an `'auto'` fast-path work item that raised `contractViolation` into a `'deep'` coordinator `WorkItem` (`CODING_SAMPLE.md` §6.9).
 *
 * Merges `violation.partition` into `item.targetPartitions` and appends the fast-path `filesRead` trace,
 * `abortedSnapshotRef`, and contract violation proof to `description`.
 *
 * @param {WorkItem} item - Original fast-path work item.
 * @param {{ readonly partition: 'db' | 'api' | 'web'; readonly brokenInvariant: string; readonly proof: string; readonly proposedPatch: string }} violation - Raised `contractViolation` payload.
 * @param {{ readonly custom: { readonly filesRead: readonly string[] }; readonly abortMeta?: { readonly abortedSnapshotRef?: string } }} telemetry - Aborted step telemetry with `filesRead` and `abortedSnapshotRef`.
 *
 * @returns {WorkItem} Promoted `'deep'` work item for `coordinator`.
 */
export function promoteFastPathContractViolationToCoordinator(
  item: WorkItem,
  violation: {
    readonly partition: 'db' | 'api' | 'web';
    readonly brokenInvariant: string;
    readonly proof: string;
    readonly proposedPatch: string;
  },
  telemetry: {
    readonly custom: {
      readonly filesRead: readonly string[];
    };
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
      `--- FAST-PATH CONTRACT VIOLATION (${violation.partition}) ---`,
      `Broken invariant: ${violation.brokenInvariant}`,
      `Proof: ${violation.proof}`,
      `Proposed patch: ${violation.proposedPatch}`,
      `Files inspected: ${telemetry.custom.filesRead.join(', ')}`,
      `Aborted snapshot ref (inspect via git.refReaderTools): ${telemetry.abortMeta?.abortedSnapshotRef ?? 'none'}`,
    ].join('\n'),
    routingTier: 'deep',
    targetPartitions: Array.from(mergedPartitions),
    dependsOn: item.dependsOn,
  };
}
