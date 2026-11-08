import type {
  FsSecretLiteralsGuardNode,
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  StepExecutionContext,
} from '@metaharness/core';
import { collectReadPathsFromEffects } from './collect-read-paths-from-effects.js';
import { compileSecretPatterns } from './compile-secret-patterns.js';
import { createEffectBaseRefPathLookup } from './create-effect-base-ref-path-lookup.js';
import { projectViolatedWriteEffects } from './project-violated-write-effects.js';

/**
 * Evaluates `FsRequireReadBeforeWriteGuardNode` against `ctx.observedEffects` and `existingPathsAtBaseRef`.
 *
 * @param {PolicyGuardEvaluationInput}    input - Proposed effects and active capability leases.
 * @param {StepExecutionContext<unknown>} ctx   - Step execution context providing `observedEffects`.
 *
 * @returns {PolicyGuardEvaluationResult} Frozen policy guard evaluation result.
 */
export function evaluateFsReadBeforeWritePaths(
  input: PolicyGuardEvaluationInput,
  ctx: StepExecutionContext<unknown>,
): PolicyGuardEvaluationResult {
  const readPaths = collectReadPathsFromEffects(ctx.observedEffects);
  const existsAtBaseRef = createEffectBaseRefPathLookup(ctx.scopeHandle);
  return projectViolatedWriteEffects(
    input,
    (relPath, eff) => {
      if (readPaths.has(relPath)) return false;
      return existsAtBaseRef(eff, relPath);
    },
    (paths) => `Read-before-write required prior to mutating existing file(s) [${paths.join(', ')}]`,
  );
}

/**
 * Evaluates `FsSecretLiteralsGuardNode` against `proposedContent` in proposed write effects.
 *
 * @param {FsSecretLiteralsGuardNode}  node  - Secret literals guard AST node.
 * @param {PolicyGuardEvaluationInput} input - Proposed effects and active capability leases.
 *
 * @returns {PolicyGuardEvaluationResult} Frozen policy guard evaluation result.
 */
export function evaluateFsSecretLiteralPaths(
  node: FsSecretLiteralsGuardNode,
  input: PolicyGuardEvaluationInput,
): PolicyGuardEvaluationResult {
  const secretRegexes = compileSecretPatterns(node.patterns);
  return projectViolatedWriteEffects(
    input,
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
