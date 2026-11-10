import type { PolicyViolation } from '@paraharness/core';
import { fs } from '@paraharness/fs';

/**
 * Extracts violated file paths and the violation summary from a pre-flight test-file `PolicyViolation` (`CODING_SAMPLE.md` §6.6).
 *
 * Delegates path extraction and deduplication to `fs.violatedPaths(violation)` to construct
 * the `leaseRequest` interrupt payload.
 *
 * @param {PolicyViolation} violation - Pre-flight policy violation emitted by `fs.writeGuard`.
 *
 * @returns {{ readonly requestedPaths: string[]; readonly justification: string }} Structured `leaseRequest` payload.
 */
export function mapLeaseRequestViolation(violation: PolicyViolation): {
  readonly requestedPaths: string[];
  readonly justification: string;
} {
  return {
    requestedPaths: fs.violatedPaths(violation),
    justification: violation.violationSummary,
  };
}
