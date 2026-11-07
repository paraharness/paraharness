import type {
  FsAllowOnlyGuardNode,
  FsBoundaryGuardNode,
  FsProtectGuardNode,
  FsReadOnlyGuardNode,
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  StepExecutionContext,
} from '@harness-dsl/core';
import { projectViolatedWriteEffects } from './internal/guard-evaluation-helpers.js';
import { compileGlobOrExactMatcher } from './internal/jail-and-glob-helpers.js';

/**
 * Evaluates an `FsBoundaryGuardNode` (`fs:boundary-guard`) against proposed tool effects (`SPEC.md` §4.3).
 *
 * Blocks any write effect matching a partition's `boundaryGlobs` unless covered by `input.activeLeases`,
 * projecting `violatedEffects` strictly to the violating boundary file paths.
 *
 * @param {FsBoundaryGuardNode}           node  - Boundary guard AST node.
 * @param {PolicyGuardEvaluationInput}    input - Tool name, proposed effects, and active leases.
 * @param {StepExecutionContext<unknown>} _ctx  - Step execution context.
 *
 * @returns {PolicyGuardEvaluationResult} Guard evaluation result and projected `violatedEffects`.
 */
export function evaluateFsBoundaryGuard(
  node: FsBoundaryGuardNode,
  input: PolicyGuardEvaluationInput,
  _ctx: StepExecutionContext<unknown>,
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
 * Evaluates an `FsProtectGuardNode` (`fs:protect`) against proposed tool effects (`SPEC.md` §4.3).
 *
 * Rejects write mutations targeting paths matching `node.globs` unless covered by `input.activeLeases`.
 *
 * @param {FsProtectGuardNode}            node  - Protect guard AST node.
 * @param {PolicyGuardEvaluationInput}    input - Tool name, proposed effects, and active leases.
 * @param {StepExecutionContext<unknown>} _ctx  - Step execution context.
 *
 * @returns {PolicyGuardEvaluationResult} Guard evaluation result and projected `violatedEffects`.
 */
export function evaluateFsProtectGuard(
  node: FsProtectGuardNode,
  input: PolicyGuardEvaluationInput,
  _ctx: StepExecutionContext<unknown>,
): PolicyGuardEvaluationResult {
  const isProtectedMatch = compileGlobOrExactMatcher(node.globs);
  return projectViolatedWriteEffects(
    input,
    (relPath) => isProtectedMatch(relPath),
    (paths) => `Protected file write denied on [${paths.join(', ')}]`,
  );
}

/**
 * Evaluates an `FsReadOnlyGuardNode` (`fs:read-only`) against proposed tool effects (`SPEC.md` §4.3).
 *
 * Rejects all filesystem write mutations not explicitly covered by `input.activeLeases`.
 *
 * @param {FsReadOnlyGuardNode}           _node - Read-only guard AST node.
 * @param {PolicyGuardEvaluationInput}    input - Tool name, proposed effects, and active leases.
 * @param {StepExecutionContext<unknown>} _ctx  - Step execution context.
 *
 * @returns {PolicyGuardEvaluationResult} Guard evaluation result and projected `violatedEffects`.
 */
export function evaluateFsReadOnlyGuard(
  _node: FsReadOnlyGuardNode,
  input: PolicyGuardEvaluationInput,
  _ctx: StepExecutionContext<unknown>,
): PolicyGuardEvaluationResult {
  return projectViolatedWriteEffects(
    input,
    () => true,
    (paths) => `Read-only policy violation: write denied on [${paths.join(', ')}]`,
  );
}

/**
 * Evaluates an `FsAllowOnlyGuardNode` (`fs:allow-only`) against proposed tool effects (`SPEC.md` §4.3).
 *
 * Rejects any write mutation whose path does not match `node.globs` (or `input.activeLeases`).
 *
 * @param {FsAllowOnlyGuardNode}          node  - Allow-only guard AST node.
 * @param {PolicyGuardEvaluationInput}    input - Tool name, proposed effects, and active leases.
 * @param {StepExecutionContext<unknown>} _ctx  - Step execution context.
 *
 * @returns {PolicyGuardEvaluationResult} Guard evaluation result and projected `violatedEffects`.
 */
export function evaluateFsAllowOnlyGuard(
  node: FsAllowOnlyGuardNode,
  input: PolicyGuardEvaluationInput,
  _ctx: StepExecutionContext<unknown>,
): PolicyGuardEvaluationResult {
  const isAllowedMatch = compileGlobOrExactMatcher(node.globs);
  return projectViolatedWriteEffects(
    input,
    (relPath) => !isAllowedMatch(relPath),
    (paths) => `Write outside allowOnly globs denied on [${paths.join(', ')}]`,
  );
}
