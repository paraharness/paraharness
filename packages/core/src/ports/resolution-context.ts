import type { EnvRef } from '../ast/env-ref.js';
import type { ToolEffect } from './tool-effect.js';

/**
 * Read-only context supplied to `SourceASTNode` executors when loading prompts, rules, skills, or guidelines.
 *
 * Provides the active run identifier, unlocked partition keys, observed tool effects, optional scope handle
 * for worktree-aware in-run grounding diffs, and symbolic `EnvRef` resolution.
 */
export interface ResolutionContext {
  /** Unique identifier of the active harness run. */
  readonly runId: string;
  /** Partition identifiers unlocked for the active step or actor. */
  readonly activePartitions: readonly string[];
  /** Tool effects observed so far within the active step or loop. */
  readonly observedEffects: readonly ToolEffect[];
  /** Optional active isolation scope handle used strictly when computing in-run grounding diffs. */
  readonly scopeHandle?: unknown;

  /**
   * Resolves a literal string or symbolic `H.env(key)` reference against the runtime environment map.
   *
   * Evaluates symbolic environment references against the injected runtime environment map without reading `process.env`.
   *
   * @param {string | EnvRef} value - Literal string or symbolic environment variable reference.
   *
   * @returns {string | undefined} Resolved environment variable value, or `undefined` if unset.
   */
  resolveEnv(value: string | EnvRef): string | undefined;
}
