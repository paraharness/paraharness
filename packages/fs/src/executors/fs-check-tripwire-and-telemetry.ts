import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type {
  CheckEvaluationResult,
  FsQuotaTripwireNode,
  FsRegexCheckNode,
  FsTelemetryCollectorNode,
  QuotaTripwireEvaluationInput,
  QuotaTripwireEvaluationResult,
  StepExecutionContext,
  ToolEffect,
} from '@metaharness/core';
import { addMutatedPathsFromEffects } from './internal/add-mutated-paths-from-effects.js';
import { collectMutatedPathsSinceBaseRef } from './internal/collect-mutated-paths-since-base-ref.js';
import { compileGlobOrExactMatcher } from './internal/compile-glob-or-exact-matcher.js';
import { resolveJailedWorktreePath } from './internal/resolve-jailed-worktree-path.js';

/**
 * Evaluates an `FsRegexCheckNode` (`fs:regex-check`) strictly over mutated files matching `targetGlobs` (`SPEC.md` §4.3).
 *
 * Inspects files mutated in `ctx.observedEffects` or modified since `scopeHandle.baseRef` so
 * pre-existing untouched repository files never trigger false deficits.
 *
 * @template THandle Runtime handle type of the active isolation scope.
 *
 * @param {FsRegexCheckNode<THandle>}     node   - Passive regex check AST node.
 * @param {void}                          _input - Unused check input parameter.
 * @param {StepExecutionContext<THandle>} ctx    - Step execution context.
 *
 * @returns {Promise<CheckEvaluationResult>} Check evaluation result with any matched deficits.
 */
export async function executeFsRegexCheck<THandle = unknown>(
  node: FsRegexCheckNode<THandle>,
  _input: void,
  ctx: StepExecutionContext<THandle>,
): Promise<CheckEvaluationResult> {
  const mutatedPaths = collectMutatedPathsSinceBaseRef(ctx.observedEffects, ctx.scopeHandle);
  const isTargetMatch = compileGlobOrExactMatcher(node.targetGlobs);
  const cleanFlags = (node.forbidFlags ?? '').replace(/g/g, '');
  const forbidRegex = new RegExp(node.forbidPattern, cleanFlags);
  const deficits: string[] = [];
  for (const relPath of mutatedPaths) {
    if (!isTargetMatch(relPath)) continue;
    const { absolutePath } = resolveJailedWorktreePath(ctx.scopeHandle, relPath, 'read');
    if (!existsSync(absolutePath)) continue;
    const content = await readFile(absolutePath, 'utf8');
    if (forbidRegex.test(content)) {
      deficits.push(`${relPath}: ${node.violationMessage}`);
    }
  }
  return Object.freeze<CheckEvaluationResult>({
    ok: deficits.length === 0,
    deficits: Object.freeze(deficits),
  });
}

/**
 * Evaluates an `FsQuotaTripwireNode` (`fs:quota-tripwire`) after tool execution (`SPEC.md` §4.3).
 *
 * Trips when the total count of distinct mutated file paths across `accumulatedEffects`
 * and `newEffects` exceeds `node.maxFilesMutated`.
 *
 * @param {FsQuotaTripwireNode}           node  - Quota tripwire AST node.
 * @param {QuotaTripwireEvaluationInput}  input - Accumulated and newly recorded tool effects.
 * @param {StepExecutionContext<unknown>} _ctx  - Step execution context.
 *
 * @returns {QuotaTripwireEvaluationResult} Tripwire result indicating whether the quota was exceeded.
 */
export function evaluateFsQuotaTripwire(
  node: FsQuotaTripwireNode,
  input: QuotaTripwireEvaluationInput,
  _ctx: StepExecutionContext<unknown>,
): QuotaTripwireEvaluationResult {
  const mutatedPaths = new Set<string>();
  addMutatedPathsFromEffects(input.accumulatedEffects, mutatedPaths);
  addMutatedPathsFromEffects(input.newEffects, mutatedPaths);
  if (mutatedPaths.size > node.maxFilesMutated) {
    return Object.freeze<QuotaTripwireEvaluationResult>({
      tripped: true,
      reason: `Mutated ${String(mutatedPaths.size)} distinct files, exceeding maxFilesMutated(${String(node.maxFilesMutated)}).`,
    });
  }
  return Object.freeze<QuotaTripwireEvaluationResult>({ tripped: false });
}

/**
 * Collects deduplicated `filesRead` and `filesMutated` arrays from `observedEffects` (`fs:telemetry`).
 *
 * Populates `UniversalStepTelemetry.custom` for step receipts and interrupt mappers (`SPEC.md` §4.3).
 *
 * @param {FsTelemetryCollectorNode}      _node           - Telemetry collector AST node.
 * @param {readonly ToolEffect[]}         observedEffects - Observed tool effects in the step session.
 * @param {StepExecutionContext<unknown>} _ctx            - Step execution context.
 *
 * @returns {{ readonly filesRead: readonly string[]; readonly filesMutated: readonly string[] }} Frozen telemetry metrics object.
 */
export function collectFsTelemetry(
  _node: FsTelemetryCollectorNode,
  observedEffects: readonly ToolEffect[],
  _ctx: StepExecutionContext<unknown>,
): { readonly filesRead: readonly string[]; readonly filesMutated: readonly string[] } {
  const filesRead = new Set<string>();
  const filesMutated = new Set<string>();
  for (const eff of observedEffects) {
    if (eff.kind !== 'fs:effect') continue;
    const mode = eff.attributes?.['mode'];
    const paths = eff.attributes?.['paths'];
    if (!Array.isArray(paths)) continue;
    const targetSet = eff.mutatesScope === true || mode === 'write' ? filesMutated : filesRead;
    for (const p of paths) {
      if (typeof p === 'string') targetSet.add(p.replace(/\\/g, '/').replace(/^\.\//, ''));
    }
  }
  return Object.freeze({
    filesRead: Object.freeze([...filesRead]),
    filesMutated: Object.freeze([...filesMutated]),
  });
}
