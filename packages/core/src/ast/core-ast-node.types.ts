import type { AgentCapabilitiesNode } from './agent-capabilities-node.js';
import type { AgentNode } from './agent-node.js';
import type { ChildInterruptHandlerNode } from './child-interrupt-handler-node.js';
import type { CommandNode } from './command-node.js';
import type { CompactionConfigNode } from './compaction-config-node.js';
import type { EnvRef } from './env-ref.js';
import type { EscalateCapabilityNode } from './escalate-capability-node.js';
import type { FlowBranchNode } from './flow-branch-node.js';
import type { FlowNode } from './flow-node.js';
import type { FlowStepNode } from './flow-step-node.js';
import type { ForkCapabilityNode } from './fork-capability-node.js';
import type { HarnessNode } from './harness-node.js';
import type { HumanNode } from './human-node.js';
import type { InterruptHandlerNode } from './interrupt-handler-node.js';
import type { InterruptNode } from './interrupt-node.js';
import type { LaneNode } from './lane-node.js';
import type { LessonsNode } from './lessons-node.js';
import type { LoopNode } from './loop-node.js';
import type { MutatePlanCapabilityNode } from './mutate-plan-capability-node.js';
import type { PolicyGuardClauseNode } from './policy-guard-clause-node.js';
import type { PolicyNode } from './policy-node.js';
import type { PoolNode } from './pool-node.js';
import type { PoolStrategyNode } from './pool-strategy-node.js';
import type { PrefixGroupNode } from './prefix-group-node.js';
import type { RulesNode } from './rules-node.js';
import type { ScopedHumanTargetNode } from './scoped-human-target-node.js';
import type { ScopedRuleNode } from './scoped-rule-node.js';
import type { SignalNode } from './signal-node.js';
import type { SkillNode } from './skill-node.js';
import type { SpeculateCapabilityNode } from './speculate-capability-node.js';
import type { StreamNode } from './stream-node.js';
import type { TopologyNode } from './topology-node.js';

/** Complete union of all `@harness-dsl/core` passive AST nodes. */
export type CoreASTNode =
  | HarnessNode
  | LaneNode
  | FlowNode
  | FlowStepNode
  | FlowBranchNode
  | AgentNode
  | LoopNode
  | CommandNode
  | PolicyNode
  | PolicyGuardClauseNode
  | ForkCapabilityNode
  | SpeculateCapabilityNode
  | MutatePlanCapabilityNode
  | EscalateCapabilityNode
  | AgentCapabilitiesNode
  | ChildInterruptHandlerNode
  | InterruptHandlerNode
  | PoolNode
  | PoolStrategyNode
  | TopologyNode
  | RulesNode
  | ScopedRuleNode
  | SkillNode
  | LessonsNode
  | PrefixGroupNode
  | SignalNode
  | InterruptNode
  | StreamNode
  | HumanNode
  | ScopedHumanTargetNode
  | CompactionConfigNode
  | EnvRef;
