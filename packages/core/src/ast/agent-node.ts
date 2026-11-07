import type { z } from 'zod';
import type { AgentCapabilitiesNode } from './agent-capabilities-node.js';
import type { BivariantCallback, SourceValue } from './ast-foundation.types.js';
import type { ChildInterruptHandlerNode } from './child-interrupt-handler-node.js';
import type {
  CheckASTNode,
  ModelASTNode,
  SourceASTNode,
  ToolASTNode,
} from './domain-ast.types.js';
import type { InterruptHandlerNode } from './interrupt-handler-node.types.js';
import type { InterruptNode } from './interrupt-node.js';
import type { LessonsNode } from './lessons-node.js';
import type { PolicyNode } from './policy-node.js';
import type { PoolNode } from './pool-node.js';
import type { PrefixGroupNode } from './prefix-group-node.js';
import type { RulesNode } from './rules-node.js';
import type { SkillNode } from './skill-node.types.js';
import type { TopologyNode } from './topology-node.js';

/**
 * Lesson subsystem mount descriptor on an `AgentNode`.
 *
 * Pairs the backing `LessonsNode` with the `recordOutcomes` flag controlling whether the agent's
 * clean-pass, recovery, and violation outcomes are attributed back to the lesson store.
 */
export interface AgentLessonsMount {
  /** Mounted `LessonsNode` used for recalling relevant lessons at session start. */
  readonly node: LessonsNode<unknown>;
  /** True when the agent's execution outcomes should be attributed back to `LessonStore`. */
  readonly recordOutcomes: boolean;
}

/**
 * Passive AST node representing the universal LLM actor primitive (`H.agent(id)`).
 *
 * Contains zero execution methods and is dispatched at runtime via `executeStepNode` (`switch (node.type)`).
 *
 * @template TIn     Validated actor input payload type.
 * @template TOut    Validated actor output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface AgentNode<TIn = unknown, TOut = unknown, THandle = unknown> {
  /** Discriminant identifying an LLM agent step AST node. */
  readonly type: 'harness:agent';
  /** Unique identifier of the base agent definition. */
  readonly id: string;
  /** Canonical role key (`id` or `"${id}+tools:${sortedExtraToolNames.join(',')}"`) indexing `CompiledWirePrefix.wireToolSchemasByRoleKey`. */
  readonly roleKey: string;
  /** Optional shared `PrefixGroupNode` for byte-identical wire system prompts. */
  readonly prefixGroup?: PrefixGroupNode;
  /** Model or model pool powering this agent's turns. */
  readonly model: ModelASTNode | PoolNode<ModelASTNode>;
  /** Optional relational topology whose live partition contracts are injected into the Turn-0 context frame. */
  readonly topology?: TopologyNode;
  /** Optional rules registry mounted on this agent. */
  readonly rules?: RulesNode;
  /** Optional empirical lessons mount descriptor. */
  readonly lessons?: AgentLessonsMount;
  /** Mounted inline skills or source-backed skill bundles. */
  readonly skills: ReadonlyArray<
    SkillNode<THandle> | SourceASTNode<readonly SkillNode<THandle>[]>
  >;
  /** Optional capability and sandbox policy governing tool execution and quantitative limits. */
  readonly policy?: PolicyNode<THandle>;
  /** Always-unlocked tools mounted directly on this agent. */
  readonly tools: readonly ToolASTNode<THandle>[];
  /** Grounding sources resolved and injected into the agent's context. */
  readonly grounding: readonly SourceValue<string>[];
  /** Role instruction sources resolved and injected into the agent's context. */
  readonly instructions: readonly SourceValue<string>[];
  /** Optional wall-clock timeout in minutes for the agent step. */
  readonly timeoutMinutes?: number;
  /** Deterministic `beforeStop` checks verified whenever the agent emits a completion turn. */
  readonly beforeStopChecks: readonly CheckASTNode<THandle>[];
  /** Zod schema validating the agent's input payload. */
  readonly inputSchema: z.ZodType<TIn>;
  /** Zod schema validating the agent's structured output payload. */
  readonly outputSchema: z.ZodType<TOut>;
  /** Optional synchronous extractor mapping `TIn` to `ResolutionContext.activePartitions`. */
  readonly extractPartitions?: BivariantCallback<[input: TIn], readonly string[]>;
  /** Voluntary interrupts the agent may raise via synthetic interrupt tool calls. */
  readonly canRaiseInterrupts: readonly InterruptNode<unknown>[];
  /** Optional hierarchical capabilities (`.fork()`, `.speculate()`, `.mutatePlan()`, `.escalate()`). */
  readonly capabilities?: AgentCapabilitiesNode<TIn, THandle>;
  /** Upward child interrupt handlers (`.onChildInterrupt(...)`). */
  readonly onChildInterruptHandlers: readonly ChildInterruptHandlerNode<unknown>[];
  /** Actor-level default interrupt handlers (`.onInterrupt(...)`). */
  readonly onInterruptHandlers: readonly InterruptHandlerNode<TIn, unknown, THandle>[];
}
