/**
 * Objective 4-state execution outcome recorded for an injected lesson after a step completes or fails.
 *
 * Governed by the strict precedence order:
 * `'violated' > 'gate_rejected_unrecovered' > 'gate_rejected_recovered' > 'clean_pass'`.
 */
export type LessonOutcome =
  | 'clean_pass'
  | 'gate_rejected_recovered'
  | 'gate_rejected_unrecovered'
  | 'violated';
