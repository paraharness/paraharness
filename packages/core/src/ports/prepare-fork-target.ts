export type { ModelForkTarget } from './model-fork-target.js';

/**
 * Target model and tombstone substitution options passed to `ModelDriver.prepareFork()`.
 *
 * Specifies the destination model identifier, account seat configuration, reasoning effort,
 * and whether compacted skill tombstones should be substituted (`sourceModelId !== targetModelId`).
 */
export interface PrepareForkTarget {
  /** Target provider model identifier for the forked or escalated session. */
  readonly modelId: string;
  /** Optional resolved account seat configuration for the target model. */
  readonly accountConfig?: unknown;
  /** Optional reasoning effort level for the target session. */
  readonly effort?: 'low' | 'medium' | 'high';
  /** Whether to substitute `compactedTombstones` (`true` only when `sourceModelId !== targetModelId`). */
  readonly substituteTombstones: boolean;
}
