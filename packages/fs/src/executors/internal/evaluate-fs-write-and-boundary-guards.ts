import type {
  FsBoundaryGuardNode,
  FsScopedWriteGuardNode,
  FsWriteGuardNode,
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  StepExecutionContext,
} from '@paraharness/core';
import { compileGlobOrExactMatcher } from './compile-glob-or-exact-matcher.js';
import { createEffectBaseRefPathLookup } from './create-effect-base-ref-path-lookup.js';
import { CACHED_BOUNDARY_GUARD_MATCHERS } from './glob-matcher-cache.constants.js';
import { projectViolatedWriteEffects } from './project-violated-write-effects.js';

/**
 * Pre-compiles and memoizes a boundary path matcher across all partitions in `node.partitionMap` (`Rules 4.2 & 4.4`).
 *
 * Iterates `Object.keys(node.partitionMap.mapping)` once on a cold `WeakMap` miss, compiling each
 * partition's frozen `boundaryGlobs` slice via `compileGlobOrExactMatcher` and caching the composed predicate on `node`.
 *
 * @param {FsBoundaryGuardNode} node - Boundary guard AST node.
 *
 * @returns {(candidatePath: string) => boolean} Memoized synchronous predicate returning `true` when `candidatePath` is a boundary file.
 */
function compileBoundaryGuardMatcher(
  node: FsBoundaryGuardNode,
): (candidatePath: string) => boolean {
  const cached = CACHED_BOUNDARY_GUARD_MATCHERS.get(node);
  if (cached !== undefined) {
    return cached;
  }
  const partitionMatchers: Array<(candidatePath: string) => boolean> = [];
  for (const partitionKey of Object.keys(node.partitionMap.mapping)) {
    const entry = node.partitionMap.mapping[partitionKey];
    if (entry !== undefined) {
      partitionMatchers.push(compileGlobOrExactMatcher(entry.boundaryGlobs));
    }
  }
  const compiled = (candidatePath: string): boolean => {
    for (const isMatch of partitionMatchers) {
      if (isMatch(candidatePath)) return true;
    }
    return false;
  };
  CACHED_BOUNDARY_GUARD_MATCHERS.set(node, compiled);
  return compiled;
}

/**
 * Evaluates `FsBoundaryGuardNode` partition `boundaryGlobs` against proposed write effects.
 *
 * @param {FsBoundaryGuardNode}        node  - Boundary guard AST node.
 * @param {PolicyGuardEvaluationInput} input - Proposed effects and active capability leases.
 *
 * @returns {PolicyGuardEvaluationResult} Frozen policy guard evaluation result.
 */
export function evaluateFsBoundaryPaths(
  node: FsBoundaryGuardNode,
  input: PolicyGuardEvaluationInput,
): PolicyGuardEvaluationResult {
  const isBoundaryMatch = compileBoundaryGuardMatcher(node);
  return projectViolatedWriteEffects(
    input,
    (relPath) => isBoundaryMatch(relPath),
    (paths) => `Protected partition boundary write denied on [${paths.join(', ')}]`,
  );
}

/**
 * Evaluates `FsWriteGuardNode` (`denyGlobs`, `allowGlobs`, `onlyExistingAtBaseRef`) against proposed write effects.
 *
 * @param {FsWriteGuardNode}              node  - Write guard AST node.
 * @param {PolicyGuardEvaluationInput}    input - Proposed effects and active capability leases.
 * @param {StepExecutionContext<unknown>} ctx   - Step execution context.
 *
 * @returns {PolicyGuardEvaluationResult} Frozen policy guard evaluation result.
 */
export function evaluateFsWriteGuardPaths(
  node: FsWriteGuardNode,
  input: PolicyGuardEvaluationInput,
  ctx: StepExecutionContext<unknown>,
): PolicyGuardEvaluationResult {
  const isDenied = compileGlobOrExactMatcher(node.denyGlobs);
  const isAllowed =
    node.allowGlobs !== undefined ? compileGlobOrExactMatcher(node.allowGlobs) : (): boolean => false;
  const existsAtBaseRef = createEffectBaseRefPathLookup(ctx.scopeHandle);
  return projectViolatedWriteEffects(
    input,
    (relPath, eff) => {
      if (isAllowed(relPath) || !isDenied(relPath)) return false;
      if (node.onlyExistingAtBaseRef !== true) return true;
      return existsAtBaseRef(eff, relPath);
    },
    (paths) => `Write guard '${node.id}' denied mutation on [${paths.join(', ')}]`,
  );
}

/**
 * Tests whether `relPath` matches at least one active partition's `globs` in `node.partitionMap` (`Rules 4.2 & 4.4`).
 *
 * @param {FsScopedWriteGuardNode} node             - Scoped write guard AST node.
 * @param {readonly string[]}      activePartitions - Active partition identifiers for the step.
 * @param {string}                 relPath          - Normalized worktree-relative file path.
 *
 * @returns {boolean} True when `relPath` belongs to at least one active partition.
 */
function isPathInActivePartitions(
  node: FsScopedWriteGuardNode,
  activePartitions: readonly string[],
  relPath: string,
): boolean {
  for (const partitionId of activePartitions) {
    const entry = node.partitionMap.mapping[partitionId];
    if (entry !== undefined && compileGlobOrExactMatcher(entry.globs)(relPath)) {
      return true;
    }
  }
  return false;
}

/**
 * Evaluates `FsScopedWriteGuardNode` active partition member `globs` against proposed write effects.
 *
 * @param {FsScopedWriteGuardNode}        node  - Scoped write guard AST node.
 * @param {PolicyGuardEvaluationInput}    input - Proposed effects and active capability leases.
 * @param {StepExecutionContext<unknown>} ctx   - Step execution context providing `activePartitions`.
 *
 * @returns {PolicyGuardEvaluationResult} Frozen policy guard evaluation result.
 */
export function evaluateFsScopedWritePaths(
  node: FsScopedWriteGuardNode,
  input: PolicyGuardEvaluationInput,
  ctx: StepExecutionContext<unknown>,
): PolicyGuardEvaluationResult {
  return projectViolatedWriteEffects(
    input,
    (relPath) => !isPathInActivePartitions(node, ctx.activePartitions, relPath),
    (paths) =>
      `Scoped write denied outside active partitions [${ctx.activePartitions.join(', ')}] on [${paths.join(', ')}]`,
  );
}
