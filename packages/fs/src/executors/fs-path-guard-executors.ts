import type {
  FsAllowOnlyGuardNode,
  FsBoundaryGuardNode,
  FsProtectGuardNode,
  FsReadOnlyGuardNode,
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  StepExecutionContext,
} from '@paraharness/core';
import {
  evaluateFsAllowOnlyPaths,
  evaluateFsProtectPaths,
  evaluateFsReadOnlyPaths,
} from './internal/evaluate-fs-allow-and-protect-guards.js';
import { evaluateFsBoundaryPaths } from './internal/evaluate-fs-write-and-boundary-guards.js';

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
  return evaluateFsBoundaryPaths(node, input);
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
  return evaluateFsProtectPaths(node, input);
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
  return evaluateFsReadOnlyPaths(input);
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
  return evaluateFsAllowOnlyPaths(node, input);
}
