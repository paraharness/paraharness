import type {
  FsAllowOnlyGuardNode,
  FsProtectGuardNode,
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
} from '@metaharness/core';
import { compileGlobOrExactMatcher } from './compile-glob-or-exact-matcher.js';
import { projectViolatedWriteEffects } from './project-violated-write-effects.js';

/**
 * Evaluates `FsProtectGuardNode` path globs against proposed write effects.
 *
 * @param {FsProtectGuardNode}         node  - Protect guard AST node.
 * @param {PolicyGuardEvaluationInput} input - Proposed effects and active capability leases.
 *
 * @returns {PolicyGuardEvaluationResult} Frozen policy guard evaluation result.
 */
export function evaluateFsProtectPaths(
  node: FsProtectGuardNode,
  input: PolicyGuardEvaluationInput,
): PolicyGuardEvaluationResult {
  const isProtectedMatch = compileGlobOrExactMatcher(node.globs);
  return projectViolatedWriteEffects(
    input,
    (relPath) => isProtectedMatch(relPath),
    (paths) => `Protected file write denied on [${paths.join(', ')}]`,
  );
}

/**
 * Evaluates `FsReadOnlyGuardNode` against proposed write effects.
 *
 * @param {PolicyGuardEvaluationInput} input - Proposed effects and active capability leases.
 *
 * @returns {PolicyGuardEvaluationResult} Frozen policy guard evaluation result.
 */
export function evaluateFsReadOnlyPaths(
  input: PolicyGuardEvaluationInput,
): PolicyGuardEvaluationResult {
  return projectViolatedWriteEffects(
    input,
    () => true,
    (paths) => `Read-only policy violation: write denied on [${paths.join(', ')}]`,
  );
}

/**
 * Evaluates `FsAllowOnlyGuardNode` path globs against proposed write effects.
 *
 * @param {FsAllowOnlyGuardNode}       node  - Allow-only guard AST node.
 * @param {PolicyGuardEvaluationInput} input - Proposed effects and active capability leases.
 *
 * @returns {PolicyGuardEvaluationResult} Frozen policy guard evaluation result.
 */
export function evaluateFsAllowOnlyPaths(
  node: FsAllowOnlyGuardNode,
  input: PolicyGuardEvaluationInput,
): PolicyGuardEvaluationResult {
  const isAllowedMatch = compileGlobOrExactMatcher(node.globs);
  return projectViolatedWriteEffects(
    input,
    (relPath) => !isAllowedMatch(relPath),
    (paths) => `Write outside allowOnly globs denied on [${paths.join(', ')}]`,
  );
}
