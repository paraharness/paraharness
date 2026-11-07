import type { PolicyViolation } from '@harness-dsl/core';

/**
 * Extracts violated file paths and the violation summary from a pre-flight test-file `PolicyViolation` (`CODING_SAMPLE.md` §6.6).
 *
 * Iterates `violation.violatedEffects` in a single pass and collects string path entries from `eff.attributes.paths`
 * to construct the `leaseRequest` interrupt payload.
 *
 * @param {PolicyViolation} violation - Pre-flight policy violation emitted by `fs.writeGuard`.
 *
 * @returns {{ readonly requestedPaths: string[]; readonly justification: string }} Structured `leaseRequest` payload.
 */
export function mapLeaseRequestViolation(violation: PolicyViolation): {
  readonly requestedPaths: string[];
  readonly justification: string;
} {
  const requestedPaths: string[] = [];
  for (const eff of violation.violatedEffects) {
    const rawPaths = eff.attributes?.['paths'];
    if (!Array.isArray(rawPaths)) continue;
    for (const candidatePath of rawPaths) {
      if (typeof candidatePath === 'string') {
        requestedPaths.push(candidatePath);
      }
    }
  }
  return {
    requestedPaths,
    justification: violation.violationSummary,
  };
}
