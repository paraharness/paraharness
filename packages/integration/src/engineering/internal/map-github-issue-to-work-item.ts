import type { WorkItem } from '../engineering-schemas.schema.js';

/**
 * Projects a polled GitHub issue into a `WorkItem` when labeled `'agent-ready'`, or `undefined` to skip (`CODING_SAMPLE.md` §6.9).
 *
 * Extracts `partition:db`, `partition:api`, and `partition:web` labels in a single pass and assigns
 * `routingTier: 'deep'` when `'epic'`, `'architecture'`, `'deep'`, or multiple partitions are present.
 *
 * @param {{ readonly number: number; readonly title: string; readonly body?: string | null; readonly labels: readonly string[] }} issue - Polled GitHub issue record.
 *
 * @returns {WorkItem | undefined} Mapped `WorkItem` or `undefined` if not `'agent-ready'`.
 */
export function mapGithubIssueToWorkItem(issue: {
  readonly number: number;
  readonly title: string;
  readonly body?: string | null;
  readonly labels: readonly string[];
}): WorkItem | undefined {
  const labelSet = new Set<string>(issue.labels);
  if (!labelSet.has('agent-ready')) {
    return undefined;
  }
  const partitions: Array<'db' | 'api' | 'web'> = [];
  for (const label of issue.labels) {
    if (label === 'partition:db') {
      partitions.push('db');
    } else if (label === 'partition:api') {
      partitions.push('api');
    } else if (label === 'partition:web') {
      partitions.push('web');
    }
  }
  const hasDeepLabel =
    labelSet.has('epic') || labelSet.has('architecture') || labelSet.has('deep');
  const routingTier: 'deep' | 'auto' =
    hasDeepLabel || partitions.length > 1 ? 'deep' : 'auto';
  return {
    ref: `#${issue.number}`,
    title: issue.title,
    description: issue.body ?? '',
    routingTier,
    targetPartitions: partitions,
    dependsOn: [],
  };
}
