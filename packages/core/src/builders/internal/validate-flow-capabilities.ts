import type { AgentNode } from '../../ast/agent-node.js';
import type { StepASTNode } from '../../ast/domain-ast.types.js';
import type { FlowBranchNode } from '../../ast/flow-branch-node.js';
import type { FlowNode } from '../../ast/flow-node.js';
import type { FlowStepNode } from '../../ast/flow-step-node.js';
import type { InterruptHandlerNode } from '../../ast/interrupt-handler-node.types.js';
import {
  agentRequiresBranchableScope,
  findPostFlightSubprocessTool,
  validateBidirectionalHumanChannel,
  validatePrefixGroupCloneTranscriptMode,
} from './validate-agent-and-human-capabilities.js';

export { validateBidirectionalHumanChannel, validatePrefixGroupCloneTranscriptMode };

/**
 * Validates that every `'replace'` interrupt handler has either an explicit `abortHook` or a checkpointable/branchable scope.
 *
 * Recursively checks replacement executables and nested adjudicator interrupt handlers against
 * the enclosing flow's `scope.capabilityTier`.
 *
 * @param {FlowNode}                                                  flowNode - Enclosing flow node.
 * @param {{ readonly id: string; readonly hasPolicyAbort: boolean }} owner    - Step or actor owning the handlers.
 * @param {readonly InterruptHandlerNode[]}                           handlers - Interrupt handlers to inspect.
 *
 * @throws {Error} If a `'replace'` handler on a Tier-1 `'scope'` lacks both `handler.abortHook` and `policy.abortHook`.
 */
function validateReplaceHandlersHaveAbortSupport(
  flowNode: FlowNode,
  owner: { readonly id: string; readonly hasPolicyAbort: boolean },
  handlers: readonly InterruptHandlerNode[],
): void {
  const scopeTier = flowNode.scope.capabilityTier;
  const scopeType = flowNode.scope.type;
  for (const handler of handlers) {
    if (handler.mode === 'replace') {
      if (scopeTier === 'scope' && handler.abortHook === undefined && !owner.hasPolicyAbort) {
        throw new Error(
          `Flow '${flowNode.id}' step '${owner.id}' configures .replaceWith() on interrupt '${handler.interrupt.id}' without .onAbort() on a Tier-1 'scope' (${scopeType}); bind .onAbort() or use a 'checkpointable' or 'branchable' scope.`,
        );
      }
      validateStepExecutableAgainstScope(flowNode, handler.replacementExecutable);
    } else if (handler.mode === 'adjudicate') {
      validateStepExecutableAgainstScope(flowNode, handler.adjudicator);
      validateReplaceHandlersHaveAbortSupport(
        flowNode,
        { id: owner.id, hasPolicyAbort: false },
        handler.onInterruptHandlers,
      );
    }
  }
}

/**
 * Validates a single `AgentNode`'s capabilities, post-flight tools, and interrupt handlers against `flowNode.scope.capabilityTier`.
 *
 * Enforces that branching capabilities require `'branchable'` scopes and that post-flight subprocess
 * tools under policy guards require `'checkpointable'` or `'branchable'` scopes.
 *
 * @param {FlowNode}  flowNode  - Enclosing flow node.
 * @param {AgentNode} agentNode - Agent AST node to validate.
 *
 * @throws {Error} If the agent requires a higher capability tier than `flowNode.scope.capabilityTier`.
 */
function validateAgentAgainstScopeTier(flowNode: FlowNode, agentNode: AgentNode): void {
  const scopeTier = flowNode.scope.capabilityTier;
  const scopeType = flowNode.scope.type;
  validatePrefixGroupCloneTranscriptMode(agentNode);

  if (agentRequiresBranchableScope(agentNode) && scopeTier !== 'branchable') {
    throw new Error(
      `Flow '${flowNode.id}' scope '${scopeType}' has capabilityTier '${scopeTier}', but actor '${agentNode.id}' declares branching capabilities (.fork, .speculate, or .mutatePlan) requiring capabilityTier 'branchable'.`,
    );
  }

  const hasPolicyGuards = agentNode.policy !== undefined && agentNode.policy.clauses.length > 0;
  const postFlightTool = findPostFlightSubprocessTool(agentNode);
  if (hasPolicyGuards && postFlightTool !== undefined && scopeTier === 'scope') {
    throw new Error(
      `Flow '${flowNode.id}' scope '${scopeType}' has capabilityTier 'scope', but actor '${agentNode.id}' mounts subprocess-post-flight tool '${postFlightTool.name}' under policy '${agentNode.policy?.id ?? ''}' requiring capabilityTier 'checkpointable' or 'branchable'.`,
    );
  }

  validateReplaceHandlersHaveAbortSupport(
    flowNode,
    { id: agentNode.id, hasPolicyAbort: agentNode.policy?.abortHook !== undefined },
    agentNode.onInterruptHandlers,
  );
}

/**
 * Recursively validates a `StepASTNode` and any inner loop, fork, or speculate executables against `flowNode.scope.capabilityTier`.
 *
 * Traverses child fork executables, speculative tournament workers, arbiters, sole-survivor verifiers,
 * winner refinement executables, and loop action/evaluation actors.
 *
 * @param {FlowNode}    flowNode - Enclosing flow node.
 * @param {StepASTNode} stepNode - Step AST node to validate.
 */
function validateStepExecutableAgainstScope(flowNode: FlowNode, stepNode: StepASTNode): void {
  if (stepNode.type === 'harness:agent') {
    validateAgentAgainstScopeTier(flowNode, stepNode);
    for (const fork of stepNode.capabilities?.forks ?? []) {
      validateStepExecutableAgainstScope(flowNode, fork.childExecutable);
    }
    for (const spec of stepNode.capabilities?.speculations ?? []) {
      validateStepExecutableAgainstScope(flowNode, spec.workerExecutable);
      validateStepExecutableAgainstScope(flowNode, spec.arbiter.actor);
      if (spec.verifyWinnerWith !== undefined) {
        validateStepExecutableAgainstScope(flowNode, spec.verifyWinnerWith.evaluator);
      }
      if (spec.refineWinnerWhen !== undefined) {
        validateStepExecutableAgainstScope(flowNode, spec.refineWinnerWhen.refinementExecutable);
      }
    }
  } else if (stepNode.type === 'harness:loop') {
    validateStepExecutableAgainstScope(flowNode, stepNode.actStep.actor);
    validateStepExecutableAgainstScope(flowNode, stepNode.evaluateStep.evaluator);
  }
}

/**
 * Statically validates all steps, branches, actors, tools, and interrupt edges in a `FlowNode` against `flowNode.scope.capabilityTier`.
 *
 * Walks sequential flow steps and nested conditional branch cases to ensure every mounted capability
 * and interrupt replacement edge is supported by the flow's isolation scope tier.
 *
 * @param {FlowNode} flowNode - Compiled `FlowNode` to validate.
 *
 * @throws {Error} If any actor, tool, or interrupt edge violates the flow scope's `capabilityTier` or prefix group invariants.
 */
export function validateFlowScopeCapabilities(flowNode: FlowNode): void {
  const visitNodes = (nodes: ReadonlyArray<FlowStepNode | FlowBranchNode>): void => {
    for (const node of nodes) {
      if (node.type === 'harness:flow-step') {
        validateStepExecutableAgainstScope(flowNode, node.step);
        const hasPolicyAbort =
          (node.step.type === 'harness:agent' && node.step.policy?.abortHook !== undefined) ||
          (node.step.type === 'harness:loop' &&
            node.step.actStep.actor.policy?.abortHook !== undefined);
        validateReplaceHandlersHaveAbortSupport(
          flowNode,
          { id: node.id, hasPolicyAbort },
          node.onInterruptHandlers,
        );
      } else {
        for (const branchCase of node.cases) {
          visitNodes(branchCase.steps);
        }
        visitNodes(node.otherwiseSteps);
      }
    }
  };
  visitNodes(flowNode.nodes);
}
