import type { NetSuiteDraftHandle } from '../../nodes/netsuite-draft-handle.js';

/**
 * Type predicate verifying that an opaque runtime scope handle conforms to `NetSuiteDraftHandle`.
 *
 * Checks that `candidate` is a non-null object carrying string `runId` and `journalId` fields
 * and an `entries` array.
 *
 * @param {unknown} candidate - Opaque scope handle value to inspect.
 *
 * @returns {boolean} `true` when `candidate` is a valid `NetSuiteDraftHandle`.
 */
export function isNetSuiteDraftHandle(candidate: unknown): candidate is NetSuiteDraftHandle {
  if (typeof candidate !== 'object' || candidate === null) {
    return false;
  }
  const record = candidate as Record<string, unknown>;
  return (
    typeof record['runId'] === 'string' &&
    typeof record['journalId'] === 'string' &&
    Array.isArray(record['entries'])
  );
}
