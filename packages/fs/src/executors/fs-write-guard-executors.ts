import type {
  FsRequireReadBeforeWriteGuardNode,
  FsScopedWriteGuardNode,
  FsSecretLiteralsGuardNode,
  FsWriteGuardNode,
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  StepExecutionContext,
} from '@harness-dsl/core';
import {
  collectReadPathsFromEffects,
  compileSecretPatterns,
  projectViolatedWriteEffects,
} from './internal/guard-evaluation-helpers.js';
import {
  checkPathsExistAtBaseRef,
  compileGlobOrExactMatcher,
} from './internal/jail-and-glob-helpers.js';

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
  const isDenied = compileGlobOrExactMatcher(node.denyGlobs);
  const isAllowed =
    node.allowGlobs !== undefined ? compileGlobOrExactMatcher(node.allowGlobs) : (): boolean => false;
  return projectViolatedWriteEffects(
    input.proposedEffects,
    input.activeLeases,
    (relPath, eff) => {
      if (isAllowed(relPath) || !isDenied(relPath)) return false;
      if (node.onlyExistingAtBaseRef !== true) return true;
      const declaredBase = eff.attributes?.['existingPathsAtBaseRef'];
      const existingList = Array.isArray(declaredBase)
        ? (declaredBase as readonly string[])
        : checkPathsExistAtBaseRef(ctx.scopeHandle, [relPath]);
      return existingList.some((p) => p.replace(/\\/g, '/').replace(/^\.\//, '') === relPath);
    },
    (paths) => `Write guard '${node.id}' denied mutation on [${paths.join(', ')}]`,
  );
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
  const readPaths = collectReadPathsFromEffects(ctx.observedEffects);
  return projectViolatedWriteEffects(
    input.proposedEffects,
    input.activeLeases,
    (relPath, eff) => {
      if (readPaths.has(relPath)) return false;
      const declaredBase = eff.attributes?.['existingPathsAtBaseRef'];
      const existingList = Array.isArray(declaredBase)
        ? (declaredBase as readonly string[])
        : checkPathsExistAtBaseRef(ctx.scopeHandle, [relPath]);
      return existingList.some((p) => p.replace(/\\/g, '/').replace(/^\.\//, '') === relPath);
    },
    (paths) => `Read-before-write required prior to mutating existing file(s) [${paths.join(', ')}]`,
  );
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
  const activeGlobs: string[] = [];
  for (const partitionId of ctx.activePartitions) {
    const entry = node.partitionMap.mapping[partitionId];
    if (entry !== undefined) {
      for (const glob of entry.globs) activeGlobs.push(glob);
    }
  }
  const isInActivePartition = compileGlobOrExactMatcher(activeGlobs);
  return projectViolatedWriteEffects(
    input.proposedEffects,
    input.activeLeases,
    (relPath) => !isInActivePartition(relPath),
    (paths) =>
      `Scoped write denied outside active partitions [${ctx.activePartitions.join(', ')}] on [${paths.join(', ')}]`,
  );
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
  const secretRegexes = compileSecretPatterns(node.patterns);
  return projectViolatedWriteEffects(
    input.proposedEffects,
    input.activeLeases,
    (relPath, eff) => {
      const proposedMap = eff.attributes?.['proposedContent'] as
        | Readonly<Record<string, string>>
        | undefined;
      if (proposedMap === undefined) return false;
      const content = proposedMap[relPath];
      if (typeof content !== 'string' || content.length === 0) return false;
      for (const regex of secretRegexes) {
        if (regex.test(content)) return true;
      }
      return false;
    },
    (paths) => `Secret literal detected in proposed write to [${paths.join(', ')}]`,
  );
}
