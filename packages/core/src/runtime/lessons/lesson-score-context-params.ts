/**
 * Optional partition and epoch context passed to `computeLessonScore()` and `selectRecalledLessons()`.
 *
 * Supplies the active task partitions and live partition contract epochs without exceeding
 * three positional parameters on scoring functions.
 */
export interface LessonScoreContextParams {
  /** Active logical partitions unlocked for the current actor or loop. */
  readonly activePartitions?: readonly string[];
  /** Explicit current epoch $E_{\text{now}}$ for `lesson.partition`. */
  readonly currentPartitionEpoch?: number;
  /** Map of `partitionId` to current epoch $E_{\text{now}}$ loaded from `TopologyStore`. */
  readonly partitionEpochs?: ReadonlyMap<string, number>;
}
