import type {
  LessonRetirementConfig,
  LessonScoringConfig,
} from '../../ast/lessons-node.js';
import type { LessonOutcome } from '../../ports/lesson-outcome.types.js';
import type { LessonRecord } from '../../ports/lesson-record.js';
import type { LessonScoreContextParams } from './lesson-distillation-params.js';
import {
  DEFAULT_LESSON_SCORING_WEIGHTS,
  LESSON_OUTCOME_PRECEDENCE_RANK,
} from './lesson-scoring.constants.js';

/**
 * Merges two 4-state `LessonOutcome` values using strict severity precedence (`SPEC.md` §3.4.3).
 *
 * Enforces `violated > gate_rejected_unrecovered > gate_rejected_recovered > clean_pass` so
 * each `(stepExecId, lessonId)` records at most one worst-case outcome.
 *
 * @param {LessonOutcome | undefined} current  - Previously recorded outcome for the lesson in the active step, if any.
 * @param {LessonOutcome}             incoming - Newly observed outcome for the lesson.
 *
 * @returns {LessonOutcome} Higher-severity outcome according to the 4-state precedence order.
 */
export function mergeLessonOutcomePrecedence(
  current: LessonOutcome | undefined,
  incoming: LessonOutcome,
): LessonOutcome {
  if (current === undefined) {
    return incoming;
  }
  return LESSON_OUTCOME_PRECEDENCE_RANK[incoming] >= LESSON_OUTCOME_PRECEDENCE_RANK[current]
    ? incoming
    : current;
}

/**
 * Computes the Bayesian sliding-window score $\text{Score}(L, Q)$ for a candidate `LessonRecord` (`SPEC.md` §3.4.3).
 *
 * Combines text relevance $R(L, Q)$, partition-affinity boost $(1 + \beta \cdot \mathbb{I}(L.\text{partition} \in P))$,
 * contract epoch decay $\gamma^{\max(0, E_{\text{now}} - E_0)}$, and sliding-window empirical reliability
 * $(c_W + 1) / (c_W + 2v_W + 0.5g_W + 2)$.
 *
 * @param {LessonRecord}                                  lesson    - Candidate lesson record to score.
 * @param {LessonScoringConfig}                           scoring   - Lesson scoring and sliding-window configuration.
 * @param {LessonScoreContextParams | readonly string[]}  [context] - Active partitions and current partition epochs.
 *
 * @returns {number} Computed lesson score $\text{Score}(L, Q) \ge 0$.
 */
export function computeLessonScore(
  lesson: LessonRecord,
  scoring: LessonScoringConfig,
  context?: LessonScoreContextParams | readonly string[],
): number {
  const isArrayContext = Array.isArray(context);
  const activePartitions: readonly string[] = isArrayContext
    ? (context as readonly string[])
    : ((context as LessonScoreContextParams | undefined)?.activePartitions ?? []);
  const currentEpoch = isArrayContext
    ? 0
    : ((context as LessonScoreContextParams | undefined)?.currentPartitionEpoch ??
      (lesson.partition !== undefined
        ? (context as LessonScoreContextParams | undefined)?.partitionEpochs?.get(lesson.partition)
        : undefined) ??
      0);
  const relevance = lesson.relevanceScore ?? 1;
  const partitionMatched =
    lesson.partition !== undefined && activePartitions.includes(lesson.partition);
  const partitionFactor = 1 + (partitionMatched ? scoring.partitionMatchBoost : 0);
  const epochDelta =
    lesson.partition === undefined ? 0 : Math.max(0, currentEpoch - lesson.epochAtCreation);
  const decayFactor = Math.pow(scoring.decayOnPartitionEpochChange, epochDelta);
  const windowSize = Math.max(1, scoring.slidingWindowInjections);
  const windowOutcomes = lesson.recentOutcomes.slice(-windowSize);
  let cleanCount = 0, gateCount = 0, violatedCount = 0;
  for (const outcome of windowOutcomes) {
    if (outcome === 'clean_pass') cleanCount += 1;
    else if (outcome === 'violated') violatedCount += 1;
    else gateCount += 1;
  }
  const reliability =
    (cleanCount + DEFAULT_LESSON_SCORING_WEIGHTS.CLEAN_PASS_PRIOR_NUMERATOR) /
    (cleanCount +
      DEFAULT_LESSON_SCORING_WEIGHTS.VIOLATED_PENALTY_WEIGHT * violatedCount +
      DEFAULT_LESSON_SCORING_WEIGHTS.GATE_REJECTED_PENALTY_WEIGHT * gateCount +
      DEFAULT_LESSON_SCORING_WEIGHTS.PRIOR_DENOMINATOR);
  return relevance * partitionFactor * decayFactor * reliability;
}

/**
 * Evaluates the 3-way disjunction determining whether `lesson` must be retired (`SPEC.md` §3.4.3).
 *
 * Retires when `totalViolated >= v`, or $(N_{\text{eff}} \ge m \land c_W / N_{\text{eff}} < \text{minRate})$,
 * or $(|W| \ge m \land c_W / |W| < \text{minRate})$ where $N_{\text{eff}} = c_W + v_W + g_W^{\text{unrecovered}}$.
 *
 * @param {LessonRecord}                       lesson             - Lesson record with updated outcome counters.
 * @param {LessonRetirementConfig | undefined} retirement         - Optional retirement thresholds from `LessonsNode`.
 * @param {number}                             [slidingWindow=20] - Sliding window size $K$ (defaults to `20`).
 *
 * @returns {boolean} True when `lesson` satisfies any of the three retirement conditions.
 */
export function shouldRetireLesson(
  lesson: LessonRecord,
  retirement: LessonRetirementConfig | undefined,
  slidingWindow: number = DEFAULT_LESSON_SCORING_WEIGHTS.DEFAULT_SLIDING_WINDOW_SIZE,
): boolean {
  if (retirement === undefined) return false;
  if (retirement.maxViolations !== undefined && lesson.totalViolated >= retirement.maxViolations) {
    return true;
  }
  if (retirement.minCleanPassRate === undefined) return false;
  const minRate = retirement.minCleanPassRate.minRate;
  const minInjections = Math.max(1, retirement.minCleanPassRate.afterInjections);
  const windowOutcomes = lesson.recentOutcomes.slice(-Math.max(1, slidingWindow));
  let cleanCount = 0, violatedCount = 0, unrecoveredCount = 0;
  for (const outcome of windowOutcomes) {
    if (outcome === 'clean_pass') cleanCount += 1;
    else if (outcome === 'violated') violatedCount += 1;
    else if (outcome === 'gate_rejected_unrecovered') unrecoveredCount += 1;
  }
  const nEff = cleanCount + violatedCount + unrecoveredCount;
  if (nEff >= minInjections && cleanCount / nEff < minRate) return true;
  const totalWindow = windowOutcomes.length;
  if (totalWindow >= minInjections && cleanCount / totalWindow < minRate) return true;
  return false;
}

/**
 * Scores, filters, and ranks candidate lessons for Turn-0 recall (`SPEC.md` §3.4.3).
 *
 * Evaluates `computeLessonScore` for each candidate, retains lessons with `score >= recall.minScore`,
 * sorts descending by score (tie-breaking by `id`), and slices to `recall.maxItems`.
 *
 * @param {readonly LessonRecord[]}                      candidates - Candidate lessons returned by `LessonStore.queryCandidates()`.
 * @param {LessonScoringConfig}                          scoring    - Lesson scoring and recall thresholds.
 * @param {LessonScoreContextParams | readonly string[]} [context]  - Active partitions and partition epoch map.
 *
 * @returns {readonly LessonRecord[]} Frozen top-$N$ recalled lessons ordered by descending score.
 */
export function selectRecalledLessons(
  candidates: readonly LessonRecord[],
  scoring: LessonScoringConfig,
  context?: LessonScoreContextParams | readonly string[],
): readonly LessonRecord[] {
  const scored: Array<{ readonly lesson: LessonRecord; readonly score: number }> = [];
  for (const candidate of candidates) {
    const score = computeLessonScore(candidate, scoring, context);
    if (score >= scoring.recall.minScore) {
      scored.push({ lesson: candidate, score });
    }
  }
  scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.lesson.id.localeCompare(b.lesson.id)));
  const selected: LessonRecord[] = [];
  const limit = Math.min(scored.length, scoring.recall.maxItems);
  for (let i = 0; i < limit; i += 1) {
    const entry = scored[i];
    if (entry !== undefined) selected.push(entry.lesson);
  }
  return Object.freeze(selected);
}
