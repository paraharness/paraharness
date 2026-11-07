import type {
  FsBoundaryGuardNode,
  FsScopedWriteGuardNode,
  FsWriteGuardNode,
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  StepExecutionContext,
} from '@harness-dsl/core';
import { compileGlobOrExactMatcher } from './compile-glob-or-exact-matcher.js';
import { createEffectBaseRefPathLookup } from './create-effect-base-ref-path-lookup.js';
import { projectViolatedWriteEffects } from './project-violated-write-effects.js';

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
  const boundaryGlobs: string[] = [];
  for (const partitionKey of Object.keys(node.partitionMap.mapping)) {
    const entry = node.partitionMap.mapping[partitionKey];
    if (entry !== undefined) {
      for (const glob of entry.boundaryGlobs) boundaryGlobs.push(glob);
    }
  }
  const isBoundaryMatch = compileGlobOrExactMatcher(boundaryGlobs);
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
  const activeGlobs: string[] = [];
  for (const partitionId of ctx.activePartitions) {
    const entry = node.partitionMap.mapping[partitionId];
    if (entry !== undefined) {
      for (const glob of entry.globs) activeGlobs.push(glob);
    }
  }
  const isInActivePartition = compileGlobOrExactMatcher(activeGlobs);
  return projectViolatedWriteEffects(
    input,
    (relPath) => !isInActivePartition(relPath),
    (paths) =>
      `Scoped write denied outside active partitions [${ctx.activePartitions.join(', ')}] on [${paths.join(', ')}]`,
  );
}
