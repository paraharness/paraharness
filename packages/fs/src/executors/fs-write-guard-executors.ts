import type {
  FsRequireReadBeforeWriteGuardNode,
  FsScopedWriteGuardNode,
  FsSecretLiteralsGuardNode,
  FsWriteGuardNode,
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  StepExecutionContext,
} from '@metaharness/core';
import {
  evaluateFsReadBeforeWritePaths,
  evaluateFsSecretLiteralPaths,
} from './internal/evaluate-fs-content-and-read-guards.js';
import {
  evaluateFsScopedWritePaths,
  evaluateFsWriteGuardPaths,
} from './internal/evaluate-fs-write-and-boundary-guards.js';

/**
 * Evaluates an `FsWriteGuardNode` (`fs:write-guard`) against proposed tool effects (`SPEC.md` §3.5 & §4.3).
 *
 * Blocks paths matching `node.denyGlobs` unless exempted by `node.allowGlobs` or `input.activeLeases`,
 * and when `onlyExistingAtBaseRef: true` is configured, restricts denials strictly to files present
 * in `existingPathsAtBaseRef`.
 *
 * @param {FsWriteGuardNode}              node  - Write guard AST node.
 * @param {PolicyGuardEvaluationInput}    input - Tool name, proposed effects, and active leases.
 * @param {StepExecutionContext<unknown>} ctx   - Step execution context.
 *
 * @returns {PolicyGuardEvaluationResult} Guard evaluation result and projected `violatedEffects`.
 */
export function evaluateFsWriteGuard(
  node: FsWriteGuardNode,
  input: PolicyGuardEvaluationInput,
  ctx: StepExecutionContext<unknown>,
): PolicyGuardEvaluationResult {
  return evaluateFsWriteGuardPaths(node, input, ctx);
}

/**
 * Evaluates an `FsRequireReadBeforeWriteGuardNode` (`fs:require-read-before-write`) (`SPEC.md` §4.3).
 *
 * Rejects mutating any file that existed at `baseRef` unless `ctx.observedEffects` contains a prior
 * read effect for that path in the current session.
 *
 * @param {FsRequireReadBeforeWriteGuardNode} _node - Read-before-write guard AST node.
 * @param {PolicyGuardEvaluationInput}        input - Tool name, proposed effects, and active leases.
 * @param {StepExecutionContext<unknown>}     ctx   - Step execution context providing `observedEffects`.
 *
 * @returns {PolicyGuardEvaluationResult} Guard evaluation result and projected `violatedEffects`.
 */
export function evaluateFsRequireReadBeforeWriteGuard(
  _node: FsRequireReadBeforeWriteGuardNode,
  input: PolicyGuardEvaluationInput,
  ctx: StepExecutionContext<unknown>,
): PolicyGuardEvaluationResult {
  return evaluateFsReadBeforeWritePaths(input, ctx);
}

/**
 * Evaluates an `FsScopedWriteGuardNode` (`fs:scoped-write`) against `ctx.activePartitions` (`SPEC.md` §4.3).
 *
 * Rejects write mutations to any file path outside the union of member `globs` for the actor's
 * `activePartitions` in `node.partitionMap`.
 *
 * @param {FsScopedWriteGuardNode}        node  - Scoped write guard AST node.
 * @param {PolicyGuardEvaluationInput}    input - Tool name, proposed effects, and active leases.
 * @param {StepExecutionContext<unknown>} ctx   - Step execution context providing `activePartitions`.
 *
 * @returns {PolicyGuardEvaluationResult} Guard evaluation result and projected `violatedEffects`.
 */
export function evaluateFsScopedWriteGuard(
  node: FsScopedWriteGuardNode,
  input: PolicyGuardEvaluationInput,
  ctx: StepExecutionContext<unknown>,
): PolicyGuardEvaluationResult {
  return evaluateFsScopedWritePaths(node, input, ctx);
}

/**
 * Evaluates an `FsSecretLiteralsGuardNode` (`fs:secret-literals`) against `proposedContent` (`SPEC.md` §4.3).
 *
 * Scans proposed post-mutation file contents against built-in and custom secret regular expressions
 * and blocks writes containing secret literals.
 *
 * @param {FsSecretLiteralsGuardNode}     node  - Secret literals guard AST node.
 * @param {PolicyGuardEvaluationInput}    input - Tool name, proposed effects, and active leases.
 * @param {StepExecutionContext<unknown>} _ctx  - Step execution context.
 *
 * @returns {PolicyGuardEvaluationResult} Guard evaluation result and projected `violatedEffects`.
 */
export function evaluateFsSecretLiteralsGuard(
  node: FsSecretLiteralsGuardNode,
  input: PolicyGuardEvaluationInput,
  _ctx: StepExecutionContext<unknown>,
): PolicyGuardEvaluationResult {
  return evaluateFsSecretLiteralPaths(node, input);
}
