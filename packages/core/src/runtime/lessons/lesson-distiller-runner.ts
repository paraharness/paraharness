import type { LessonDistillationParams } from './lesson-distillation-params.js';
import { invokeDistillerAndAdmit } from './internal/invoke-distiller-and-admit.js';

/**
 * Executes contrastive lesson distillation for an accepted loop or gate recovery pair (`SPEC.md` §3.4.3).
 *
 * Invokes the configured distiller model with `DistilledLessonCandidateSchema`, applies the
 * `admit: boolean` noise filter, and admits reusable lessons with active-overlay `epochAtCreation`
 * and `createdByRunId` attribution.
 *
 * @param {LessonDistillationParams} params - Distillation parameters, stores, and trajectory pair.
 *
 * @returns {Promise<string | undefined>} Admitted lesson ID, or `undefined` when filtered or disabled.
 */
export async function runContrastiveLessonDistillation(
  params: LessonDistillationParams,
): Promise<string | undefined> {
  const dist = params.lessonsNode.distillation;
  if (dist === undefined) {
    return undefined;
  }
  if (params.trajectory.source === 'loop' && !dist.onLoopRecovery) {
    return undefined;
  }
  if (params.trajectory.source === 'gate') {
    if (dist.onGateRecovery === undefined) {
      return undefined;
    }
    const failedCount =
      params.trajectory.rejected.failedChecks?.length ?? params.trajectory.rejected.deficits.length;
    if (failedCount < dist.onGateRecovery.minFailedChecks) {
      return undefined;
    }
  }
  return invokeDistillerAndAdmit(params);
}
