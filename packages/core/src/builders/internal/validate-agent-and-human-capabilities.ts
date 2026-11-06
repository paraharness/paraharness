import type { AgentNode } from '../../ast/agent-node.js';
import type { HumanChannelASTNode, ToolASTNode } from '../../ast/domain-ast.types.js';
import type { HumanNode } from '../../ast/human-node.js';
import { deepFreeze } from './deep-freeze.js';

/**
 * Statically verifies that a `HumanNode` bound to an interactive decision point uses a `'bidirectional'` channel.
 *
 * Rejects `'notify-only'` channels at build time with a diagnostic error naming the human role
 * and the operation that required bidirectional approval.
 *
 * @template TMode Interaction mode of the target human node (`'bidirectional' | 'notify-only'`).
 *
 * @param {HumanNode<TMode>} humanNode      - Target `HumanNode` AST node to validate.
 * @param {string}           operationLabel - Name of the builder operation requiring bidirectional interaction.
 *
 * @returns {HumanNode<'bidirectional'>} Validated bidirectional `HumanNode`.
 *
 * @throws {Error} If `humanNode.channel.interactionMode !== 'bidirectional'`.
 */
export function validateBidirectionalHumanChannel<
  TMode extends 'bidirectional' | 'notify-only' = 'bidirectional' | 'notify-only',
>(humanNode: HumanNode<TMode>, operationLabel: string): HumanNode<'bidirectional'> {
  const channel: HumanChannelASTNode<'bidirectional' | 'notify-only'> = humanNode.channel;
  if (channel.interactionMode !== 'bidirectional') {
    throw new Error(
      `Invalid human channel on '${humanNode.id}' in ${operationLabel}: channel '${channel.type}' has interactionMode '${channel.interactionMode}', but interactive decisions require 'bidirectional'.`,
    );
  }
  return deepFreeze<HumanNode<'bidirectional'>>({
    type: 'harness:human',
    id: humanNode.id,
    keepAliveSeconds: humanNode.keepAliveSeconds,
    channel,
  });
}

/**
 * Statically verifies that an `AgentNode` using `historyMode: 'clone-transcript'` across distinct roles binds a `'union'` prefix group.
 *
 * Prevents wire tool-schema cache invalidation when cloning parent conversation history into a
 * child fork that mounts a different role toolset.
 *
 * @param {AgentNode} agentNode - Compiled `AgentNode` to validate.
 *
 * @throws {Error} If `agentNode.prefixGroup?.toolsMode === 'role-scoped'` and a `'clone-transcript'` fork targets a distinct `roleKey`.
 */
export function validatePrefixGroupCloneTranscriptMode(agentNode: AgentNode): void {
  const prefixGroup = agentNode.prefixGroup;
  if (prefixGroup === undefined || prefixGroup.toolsMode !== 'role-scoped') {
    return;
  }
  const forks = agentNode.capabilities?.forks ?? [];
  for (const fork of forks) {
    if (
      fork.historyMode === 'clone-transcript' &&
      fork.childExecutable.roleKey !== agentNode.roleKey
    ) {
      throw new Error(
        `Agent '${agentNode.id}' (roleKey '${agentNode.roleKey}') cannot use historyMode 'clone-transcript' on fork '${fork.toolName}' targeting '${fork.childExecutable.id}' (roleKey '${fork.childExecutable.roleKey}') when prefixGroup '${prefixGroup.id}' has toolsMode 'role-scoped'; configure toolsMode('union') on the prefixGroup or use historyMode('shared-prefix-only').`,
      );
    }
  }
}

/**
 * Checks whether an `AgentNode` declares any capability requiring a Tier-3 `'branchable'` isolation scope.
 *
 * Inspects registered forks, speculative tournaments, and dynamic lane task or dependency
 * mutation capabilities on the agent.
 *
 * @param {AgentNode} agentNode - Agent AST node to inspect.
 *
 * @returns {boolean} True when the agent declares `.fork()`, `.speculate()`, `spawnTasks`, or `canAddDependencies`.
 */
export function agentRequiresBranchableScope(agentNode: AgentNode): boolean {
  const caps = agentNode.capabilities;
  if (caps === undefined) {
    return false;
  }
  if (caps.forks.length > 0 || caps.speculations.length > 0) {
    return true;
  }
  return (
    caps.mutatePlan !== undefined &&
    (caps.mutatePlan.spawnTasks !== undefined || caps.mutatePlan.canAddDependencies)
  );
}

/**
 * Finds the first `ToolASTNode` mounted on an `AgentNode` that declares `effectTracking === 'subprocess-post-flight'`.
 *
 * Scans both always-unlocked base/extra tools and tools unlocked via inline `SkillNode` definitions.
 *
 * @param {AgentNode} agentNode - Agent AST node to inspect.
 *
 * @returns {ToolASTNode | undefined} First post-flight subprocess tool node, or `undefined` if none is mounted.
 */
export function findPostFlightSubprocessTool(agentNode: AgentNode): ToolASTNode | undefined {
  for (const tool of agentNode.tools) {
    if (tool.effectTracking === 'subprocess-post-flight') {
      return tool;
    }
  }
  for (const skillEntry of agentNode.skills) {
    if (skillEntry.type === 'harness:skill') {
      for (const tool of skillEntry.unlockedTools) {
        if (tool.effectTracking === 'subprocess-post-flight') {
          return tool;
        }
      }
    }
  }
  return undefined;
}
