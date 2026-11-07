import { createTwoFilesPatch } from 'diff';
import type { InRunGroundingDiffParams } from '../in-run-grounding-diff-params.js';
import type { InRunGroundingDiffRecord } from '../in-run-grounding-diff-record.js';
import { resolveSourceStringValue } from './collect-prefix-tools.js';

/**
 * Computes in-run grounding diffs against a run's pinned `CompiledWirePrefix.groundingSnapshots` (`SPEC.md` §3.2.1).
 *
 * Re-loads `.sharedGrounding()` sources with `scopeHandle` attached to `ResolutionContext` so
 * mid-run edits to grounding files are surfaced in `[ROLE_AND_SCOPE_CONTEXT]` and `[TOPOLOGY_SYNC]`
 * without mutating byte 0 of `systemPromptText`.
 *
 * @param {InRunGroundingDiffParams} params - Prefix group, pinned prefix, and active scope handle.
 *
 * @returns {Promise<readonly InRunGroundingDiffRecord[]>} Frozen array of grounding diff records for modified sources.
 */
export async function computeInRunGroundingDiffs(
  params: InRunGroundingDiffParams,
): Promise<readonly InRunGroundingDiffRecord[]> {
  const diffs: InRunGroundingDiffRecord[] = [];
  const scopedCtx = Object.freeze({
    runId: params.resolutionContext.runId,
    activePartitions: params.resolutionContext.activePartitions,
    observedEffects: params.resolutionContext.observedEffects,
    scopeHandle: params.scopeHandle,
    resolveEnv: (v: Parameters<typeof params.resolutionContext.resolveEnv>[0]) =>
      params.resolutionContext.resolveEnv(v),
  });
  for (let i = 0; i < params.prefixGroup.sharedGrounding.length; i += 1) {
    const gSource = params.prefixGroup.sharedGrounding[i];
    const snap = params.compiledPrefix.groundingSnapshots[i];
    if (gSource === undefined || snap === undefined) {
      continue;
    }
    const current = await resolveSourceStringValue(gSource, params.registry, scopedCtx);
    if (current.digest !== snap.digest) {
      diffs.push(
        Object.freeze<InRunGroundingDiffRecord>({
          sourceId: snap.sourceId,
          previousDigest: snap.digest,
          currentDigest: current.digest,
          updatedText: createTwoFilesPatch(
            snap.sourceId,
            snap.sourceId,
            snap.text,
            current.text,
            'run-start-snapshot',
            'working-copy',
          ),
        }),
      );
    }
  }
  return Object.freeze(diffs);
}
