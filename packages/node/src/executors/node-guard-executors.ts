import path from 'node:path';
import type {
  NodeAllowBinariesNode,
  NodeDenyNetworkNode,
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  StepExecutionContext,
  ToolEffect,
} from '@metaharness/core';
import { extractEffectBinaryName } from './internal/extract-effect-binary-name.js';
import { isBinaryInAllowlist } from './internal/is-binary-in-allowlist.js';
import { isNetworkToolEffect } from './internal/is-network-tool-effect.js';

/**
 * Evaluates a `NodeAllowBinariesNode` (`type: 'node:allow-binaries'`) policy guard against proposed tool effects.
 *
 * Inspects subprocess/command `ToolEffect` entries and rejects any invocation whose binary name
 * or basename is not present in `node.binaries`.
 *
 * @param {NodeAllowBinariesNode}      node  - Passive allow-binaries policy guard AST node.
 * @param {PolicyGuardEvaluationInput} input - Tool name, proposed effects, and active capability leases.
 * @param {StepExecutionContext}       _ctx  - Active step execution context.
 *
 * @returns {PolicyGuardEvaluationResult} Guard evaluation result and any violated subprocess effects.
 */
export function evaluateNodeAllowBinariesGuard(
  node: NodeAllowBinariesNode,
  input: PolicyGuardEvaluationInput,
  _ctx: StepExecutionContext,
): PolicyGuardEvaluationResult {
  const allowedSet = new Set<string>();
  for (const bin of node.binaries) {
    allowedSet.add(bin);
    allowedSet.add(path.basename(bin));
  }
  const violatedEffects: ToolEffect[] = [];
  const disallowedNames: string[] = [];
  for (const effect of input.proposedEffects) {
    const binary = extractEffectBinaryName(effect);
    if (binary !== undefined && !isBinaryInAllowlist(binary, allowedSet)) {
      violatedEffects.push(effect);
      disallowedNames.push(binary);
    }
  }
  if (violatedEffects.length === 0) {
    return Object.freeze<PolicyGuardEvaluationResult>({
      allowed: true,
      violatedEffects: Object.freeze([]),
      violationSummary: '',
    });
  }
  return Object.freeze<PolicyGuardEvaluationResult>({
    allowed: false,
    violatedEffects: Object.freeze(violatedEffects),
    violationSummary: `Tool '${input.toolName}' attempted to execute disallowed binary [${disallowedNames.join(', ')}]; allowed: [${node.binaries.join(', ')}].`,
  });
}

/**
 * Evaluates a `NodeDenyNetworkNode` (`type: 'node:deny-network'`) policy guard against proposed tool effects.
 *
 * Blocks any `ToolEffect` representing outbound network access and reports the violating effects.
 *
 * @param {NodeDenyNetworkNode}        node  - Passive deny-network policy guard AST node.
 * @param {PolicyGuardEvaluationInput} input - Tool name, proposed effects, and active capability leases.
 * @param {StepExecutionContext}       _ctx  - Active step execution context.
 *
 * @returns {PolicyGuardEvaluationResult} Guard evaluation result and any violated network effects.
 */
export function evaluateNodeDenyNetworkGuard(
  node: NodeDenyNetworkNode,
  input: PolicyGuardEvaluationInput,
  _ctx: StepExecutionContext,
): PolicyGuardEvaluationResult {
  const violatedEffects: ToolEffect[] = [];
  for (const effect of input.proposedEffects) {
    if (isNetworkToolEffect(effect)) {
      violatedEffects.push(effect);
    }
  }
  if (violatedEffects.length === 0) {
    return Object.freeze<PolicyGuardEvaluationResult>({
      allowed: true,
      violatedEffects: Object.freeze([]),
      violationSummary: '',
    });
  }
  return Object.freeze<PolicyGuardEvaluationResult>({
    allowed: false,
    violatedEffects: Object.freeze(violatedEffects),
    violationSummary: `Policy guard '${node.id}' denied outbound network access for tool '${input.toolName}'.`,
  });
}
