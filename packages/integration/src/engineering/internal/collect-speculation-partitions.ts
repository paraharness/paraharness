/**
 * Collects the deduplicated union of target partitions across all speculative tournament candidates (`CODING_SAMPLE.md` §6.7).
 *
 * Iterates each candidate's `input.targetPartitions` in a single pass and returns the ordered unique partitions
 * for `candidateArbiter` scope context resolution.
 *
 * @param {{ readonly candidates: ReadonlyArray<{ readonly input: { readonly targetPartitions: ReadonlyArray<'db' | 'api' | 'web'> } }> }} speculationInput - Arbiter speculation input payload.
 *
 * @returns {Array<'db' | 'api' | 'web'>} Deduplicated partition list across all candidates.
 */
export function collectSpeculationPartitions(speculationInput: {
  readonly candidates: ReadonlyArray<{
    readonly input: {
      readonly targetPartitions: ReadonlyArray<'db' | 'api' | 'web'>;
    };
  }>;
}): Array<'db' | 'api' | 'web'> {
  const partitions = new Set<'db' | 'api' | 'web'>();
  for (const candidate of speculationInput.candidates) {
    for (const partition of candidate.input.targetPartitions) {
      partitions.add(partition);
    }
  }
  return Array.from(partitions);
}
