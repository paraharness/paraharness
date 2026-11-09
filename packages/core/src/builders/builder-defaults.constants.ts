import type { NodeRunnerNode } from '../ast/domain/node-runner-node.js';
import type { LessonScoringConfig } from '../ast/lessons-node.js';
import { deepFreeze } from './internal/deep-freeze.js';

/** Default subprocess and PTY runner pool AST descriptor (`id: 'default-runner'`, `slots: 4`, `maxDaemons: 4`). */
export const DEFAULT_NODE_RUNNER_AST_NODE: NodeRunnerNode = Object.freeze<NodeRunnerNode>({
  type: 'node:runner',
  id: 'default-runner',
  slots: 4,
  maxDaemons: 4,
});

/** Default maximum number of turns allowed per agent invocation when unspecified (`25`). */
export const DEFAULT_AGENT_MAX_TURNS = 25;

/** Default maximum number of top-ranked lessons recalled per session start (`5`). */
export const DEFAULT_LESSON_TOP_K = 5;

/** Default minimum empirical score threshold required to recall a lesson (`0.2`). */
export const DEFAULT_LESSON_MIN_SCORE = 0.2;

/** Default empirical lesson scoring weights (`slidingWindowInjections`, `partitionMatchBoost`, `decayOnPartitionEpochChange`). */
export const DEFAULT_LESSON_WEIGHTS = Object.freeze({
  slidingWindowInjections: 10,
  partitionMatchBoost: 1.5,
  decayOnPartitionEpochChange: 0.7,
});

/** Default 4-state empirical lesson scoring and recall configuration for `P.lessons(id)`. */
export const DEFAULT_LESSON_SCORING: LessonScoringConfig = deepFreeze<LessonScoringConfig>({
  slidingWindowInjections: DEFAULT_LESSON_WEIGHTS.slidingWindowInjections,
  partitionMatchBoost: DEFAULT_LESSON_WEIGHTS.partitionMatchBoost,
  decayOnPartitionEpochChange: DEFAULT_LESSON_WEIGHTS.decayOnPartitionEpochChange,
  recall: {
    minScore: DEFAULT_LESSON_MIN_SCORE,
    maxItems: DEFAULT_LESSON_TOP_K,
  },
});
