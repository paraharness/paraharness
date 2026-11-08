import type { WorkItem } from '../engineering-schemas.schema.js';

/**
 * Promotes an `'auto'` fast-path work item that tripped `scopeTripwire` into a `'deep'` coordinator `WorkItem` (`CODING_SAMPLE.md` §6.9).
 *
 * Replaces `targetPartitions` with `tripwire.implicatedPartitions` and embeds the fast-path file-read trace,
 * `abortedSnapshotRef`, and reconnaissance `findings` into `description`.
 *
 * @param {WorkItem} item - Original fast-path work item.
 * @param {{ readonly reason: string; readonly implicatedPartitions: Array<'db' | 'api' | 'web'>; readonly findings: string }} tripwire - Flushed `scopeTripwire` payload.
 * @param {{ readonly custom: { readonly filesRead: readonly string[] }; readonly abortMeta?: { readonly abortedSnapshotRef?: string } }} telemetry - Aborted step telemetry with `filesRead` and `abortedSnapshotRef`.
 *
 * @returns {WorkItem} Promoted `'deep'` work item for `coordinator`.
 */
export function promoteFastPathTripwireToCoordinator(
  item: WorkItem,
  tripwire: {
    readonly reason: string;
    readonly implicatedPartitions: Array<'db' | 'api' | 'web'>;
    readonly findings: string;
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
  return {
    ref: item.ref,
    title: item.title,
    description: [
      item.description,
      '--- FAST-PATH RECONNAISSANCE ---',
      `Reason aborted: ${tripwire.reason}`,
      `Partitions implicated: ${tripwire.implicatedPartitions.join(', ')}`,
      `Files inspected: ${telemetry.custom.filesRead.join(', ')}`,
      `Aborted snapshot ref (inspect via git.refReaderTools): ${telemetry.abortMeta?.abortedSnapshotRef ?? 'none'}`,
      `Findings: ${tripwire.findings}`,
    ].join('\n'),
    routingTier: 'deep',
    targetPartitions: tripwire.implicatedPartitions,
    dependsOn: item.dependsOn,
  };
}
