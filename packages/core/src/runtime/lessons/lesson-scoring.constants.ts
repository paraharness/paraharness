import type { LessonOutcome } from '../../ports/lesson-outcome.types.js';

/**
 * Strict 4-state precedence rank table for deduplicating per-step lesson outcomes (`SPEC.md` §3.4.3).
 */
export const LESSON_OUTCOME_PRECEDENCE_RANK: Readonly<Record<LessonOutcome, number>> =
  Object.freeze({
    clean_pass: 1,
    gate_rejected_recovered: 2,
    gate_rejected_unrecovered: 3,
    violated: 4,
  });

/**
 * Default constants for the Bayesian sliding-window lesson scoring formula and signal cooldowns (`SPEC.md` §3.4.3).
 */
export const DEFAULT_LESSON_SCORING_WEIGHTS = Object.freeze({
  CLEAN_PASS_PRIOR_NUMERATOR: 1,
  PRIOR_DENOMINATOR: 2,
  VIOLATED_PENALTY_WEIGHT: 2,
  GATE_REJECTED_PENALTY_WEIGHT: 0.5,
  DEFAULT_SLIDING_WINDOW_SIZE: 20,
  MS_PER_HOUR: 3_600_000,
});
