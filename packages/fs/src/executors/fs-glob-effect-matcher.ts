import type {
  FsGlobMatcherNode,
  StepExecutionContext,
  ToolEffect,
} from '@paraharness/core';
import { compileGlobOrExactMatcher } from './internal/compile-glob-or-exact-matcher.js';

/**
 * Evaluates an `FsGlobMatcherNode` (`fs:match-globs`) against a `ToolEffect` (`SPEC.md` §3.5 & §4.3).
 *
 * Matches both exact normalized file paths (including bracketed routes like `app/users/[id]/page.test.tsx`)
 * and `picomatch` glob patterns, checking access mode compatibility (`'read' | 'write' | 'any'`).
 *
 * @param {FsGlobMatcherNode}             node   - Passive glob matcher AST node.
 * @param {ToolEffect}                    effect - Observed or proposed tool effect to test.
 * @param {StepExecutionContext<unknown>} _ctx   - Step execution context.
 *
 * @returns {boolean} True when `effect` is a matching `fs:effect` covered by `node`.
 */
export function evaluateFsGlobEffectMatcher(
  node: FsGlobMatcherNode,
  effect: ToolEffect,
  _ctx: StepExecutionContext<unknown>,
): boolean {
  if (effect.kind !== 'fs:effect') {
    return false;
  }
  const effectMode = effect.attributes?.['mode'];
  if (node.mode === 'read' && effectMode !== 'read') {
    return false;
  }
  if (node.mode === 'write' && effectMode !== 'write' && effect.mutatesScope !== true) {
    return false;
  }
  const rawPaths = effect.attributes?.['paths'];
  if (!Array.isArray(rawPaths) || rawPaths.length === 0) {
    return false;
  }
  const isMatch = compileGlobOrExactMatcher(node.globs);
  for (const rawPath of rawPaths) {
    if (typeof rawPath === 'string' && isMatch(rawPath)) {
      return true;
    }
  }
  return false;
}
