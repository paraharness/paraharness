import type { z } from 'zod';
import type { AgentNode } from '../ast/agent-node.js';
import type { MaybeBuilder, MaybeSource } from '../ast/ast-foundation.types.js';
import type { AstBuilder } from '../ast/ast-builder.js';
import type { CheckASTNode, ModelASTNode, SourceASTNode, ToolASTNode } from '../ast/domain-ast.types.js';
import type { InterruptHandlerNode } from '../ast/interrupt-handler-node.types.js';
import type { InterruptNode } from '../ast/interrupt-node.js';
import type { LessonsNode } from '../ast/lessons-node.js';
import type { PolicyNode } from '../ast/policy-node.js';
import type { PoolNode } from '../ast/pool-node.js';
import type { PrefixGroupNode } from '../ast/prefix-group-node.js';
import type { RulesNode } from '../ast/rules-node.js';
import type { SkillNode } from '../ast/skill-node.types.js';
import type { TopologyNode } from '../ast/topology-node.js';
import type { AgentCapabilitiesBuilder } from './agent-capabilities-builder.js';
import type { ChildInterruptHandlerBuilder as ChildInterruptBuilder } from './child-interrupt-handler-builder.js';
import type { InterruptEdgeBuilder } from './interrupt-edge-builder.js';

/**
 * Fluent builder for the universal LLM actor primitive (`P.agent(id)`).
 *
 * Compiles to a passive, deeply frozen `AgentNode` with canonical `roleKey` derivation.
 *
 * @template TIn     Validated actor input payload type.
 * @template TOut    Validated actor output payload type.
 * @template THandle Runtime handle type of the active isolation scope.
 */
export interface AgentBuilder<TIn = unknown, TOut = unknown, THandle = unknown>
  extends AstBuilder<AgentNode<TIn, TOut, THandle>> {
  /** Unique identifier of the base agent definition. */
  readonly id: string;
  /** Canonical role key (`id` or `"${id}+tools:${sortedExtraToolNames.join(',')}"`). */
  readonly roleKey: string;
  /**
   * Binds a shared `PrefixGroupNode` for byte-identical wire system prompts.
   *
   * Pins shared grounding, instructions, and global rules into Slot 1 of the wire prompt.
   * @param {MaybeBuilder<PrefixGroupNode>} group - Shared prefix group AST node or builder.
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  prefixGroup(group: MaybeBuilder<PrefixGroupNode>): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Binds the LLM model or model pool powering this agent's turns.
   *
   * Required before `.toAST()` can compile a valid `AgentNode`.
   * @param {MaybeBuilder<ModelASTNode> | MaybeBuilder<PoolNode<ModelASTNode>>} modelOrPool - Model or pool AST node.
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  model(modelOrPool: MaybeBuilder<ModelASTNode> | MaybeBuilder<PoolNode<ModelASTNode>>): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Binds a relational `TopologyNode` whose live partition contracts are injected into the Turn-0 context frame.
   *
   * Enables automatic partition contract injection and epoch tracking for active partitions.
   * @template TPart Literal partition identifier union of `topology`.
   * @param {MaybeBuilder<TopologyNode<TPart>>} topology - Relational topology AST node or builder.
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  topology<TPart extends string = string>(topology: MaybeBuilder<TopologyNode<TPart>>): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Mounts a global and scoped `RulesNode` registry on this agent.
   *
   * Evaluates scoped rules pre-flight on active partitions and post-call on tool effects.
   * @param {MaybeBuilder<RulesNode>} rules - Rules AST node or builder.
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  rules(rules: MaybeBuilder<RulesNode>): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Mounts an empirical `LessonsNode` on this agent for recalling relevant lessons at session start.
   *
   * Defaults `recordOutcomes` to `true` when `options` is omitted.
   * @template TLessonIn Query input payload type of `lessons`.
   * @param {MaybeBuilder<LessonsNode<TLessonIn>>}  lessons   - Lessons AST node or builder.
   * @param {{ readonly recordOutcomes?: boolean }} [options] - Outcome attribution toggle (`recordOutcomes: true` default).
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  lessons<TLessonIn = unknown>(lessons: MaybeBuilder<LessonsNode<TLessonIn>>, options?: { readonly recordOutcomes?: boolean }): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Mounts one or more inline `SkillNode` definitions or source-backed skill bundles.
   *
   * Populates the Turn-0 skill catalog and unlocks the native `activateSkill` tool.
   * @param {...ReadonlyArray<MaybeBuilder<SkillNode<THandle>> | MaybeBuilder<SourceASTNode<readonly SkillNode<THandle>[]>> | ReadonlyArray<MaybeBuilder<SkillNode<THandle>>>>} items - Skills or skill bundle sources.
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  skills(...items: ReadonlyArray<MaybeBuilder<SkillNode<THandle>> | MaybeBuilder<SourceASTNode<readonly SkillNode<THandle>[]>> | ReadonlyArray<MaybeBuilder<SkillNode<THandle>>>>): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Binds the capability and sandbox `PolicyNode` governing tool execution and quantitative limits.
   *
   * Evaluates pre-flight and post-flight guard clauses on every tool invocation.
   * @param {MaybeBuilder<PolicyNode<THandle>>} policy - Policy AST node or builder.
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  policy(policy: MaybeBuilder<PolicyNode<THandle>>): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Mounts always-unlocked `ToolASTNode` entries directly on this base agent.
   *
   * Base tools are included in the base agent's `id` role without appending `+tools:...` to `roleKey`.
   * @param {...ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>>>>} items - Tools or tool arrays.
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  tools(...items: ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>>>>): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Appends grounding text or source-backed grounding documents to the agent's context.
   *
   * Injected into the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` user frame in declaration order.
   * @param {...ReadonlyArray<MaybeSource<string> | ReadonlyArray<MaybeSource<string>>>} sources - Grounding strings or source AST nodes.
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  grounding(...sources: ReadonlyArray<MaybeSource<string> | ReadonlyArray<MaybeSource<string>>>): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Appends role instruction text or source-backed prompt documents to the agent's context.
   *
   * Injected into the Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` user frame after role grounding.
   * @param {...ReadonlyArray<MaybeSource<string> | ReadonlyArray<MaybeSource<string>>>} sources - Instruction strings or source AST nodes.
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  instructions(...sources: ReadonlyArray<MaybeSource<string> | ReadonlyArray<MaybeSource<string>>>): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Sets the wall-clock timeout in minutes for the agent step.
   *
   * Enforces an upper bound on the agent's total execution duration.
   * @param {number} minutes - Positive wall-clock timeout in minutes.
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  timeoutMinutes(minutes: number): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Appends deterministic `beforeStop` checks verified whenever the agent emits a completion turn.
   *
   * Failed checks reject the completion turn in-band and return structured diagnostics to the model.
   * @param {...ReadonlyArray<MaybeBuilder<CheckASTNode<THandle>> | ReadonlyArray<MaybeBuilder<CheckASTNode<THandle>>>>} checks - Check AST nodes or builders.
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  beforeStop(...checks: ReadonlyArray<MaybeBuilder<CheckASTNode<THandle>> | ReadonlyArray<MaybeBuilder<CheckASTNode<THandle>>>>): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Binds the Zod validation schema for the agent's input payload.
   *
   * Preserves all previously configured `partitions`, `capabilities`, and `onInterrupt` bindings.
   * @template TNewIn Validated actor input payload type.
   * @param {z.ZodType<TNewIn>} schema - Zod schema validating agent input.
   * @returns {AgentBuilder<TNewIn, TOut, THandle>} New immutable agent builder.
   */
  input<TNewIn>(schema: z.ZodType<TNewIn>): AgentBuilder<TNewIn, TOut, THandle>;
  /**
   * Binds an optional synchronous extractor mapping `TIn` to `ResolutionContext.activePartitions`.
   *
   * Determines which topology contracts and partition-scoped rules are injected at Turn 0.
   * @param {(input: TIn) => readonly string[]} extractor - Partition ID extractor callback.
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  partitions(extractor: (input: TIn) => readonly string[]): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Binds the Zod validation schema for the agent's structured output payload.
   *
   * Validated automatically during the `beforeStop` completion gate.
   * @template TNewOut Validated actor output payload type.
   * @param {z.ZodType<TNewOut>} schema - Zod schema validating agent output.
   * @returns {AgentBuilder<TIn, TNewOut, THandle>} New immutable agent builder.
   */
  output<TNewOut>(schema: z.ZodType<TNewOut>): AgentBuilder<TIn, TNewOut, THandle>;
  /**
   * Declares voluntary interrupts the agent may raise via synthetic interrupt tool calls.
   *
   * Exposes each declared `InterruptNode` as a callable tool in the agent's toolset.
   * @param {...ReadonlyArray<MaybeBuilder<InterruptNode<unknown>> | ReadonlyArray<MaybeBuilder<InterruptNode<unknown>>>>} interrupts - Interrupt definitions.
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  canRaise(...interrupts: ReadonlyArray<MaybeBuilder<InterruptNode<unknown>> | ReadonlyArray<MaybeBuilder<InterruptNode<unknown>>>>): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Configures hierarchical orchestration capabilities (`.fork()`, `.speculate()`, `.mutatePlan()`, `.escalate()`).
   *
   * Invokes `configure` with an `AgentCapabilitiesBuilder<TIn, THandle>` and stores the compiled node.
   * @param {($cap: AgentCapabilitiesBuilder<TIn, THandle>) => AgentCapabilitiesBuilder<TIn, THandle>} configure - Capabilities configurator callback.
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  capabilities(configure: ($cap: AgentCapabilitiesBuilder<TIn, THandle>) => AgentCapabilitiesBuilder<TIn, THandle>): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Registers an upward child-interrupt handler (`.onChildInterrupt(interrupt, $intr => ...)`).
   *
   * Intercepts `interrupt` when raised inside a child fork and suspends the fork back to this parent agent,
   * defaulting to `.suspendAndReturnToParent()` when `configure` is omitted.
   * @template TPayload Interrupt payload type.
   * @param {MaybeBuilder<InterruptNode<TPayload>>}                                       interrupt   - Upward interrupt node or builder.
   * @param {($intr: ChildInterruptBuilder<TPayload>) => ChildInterruptBuilder<TPayload>} [configure] - Optional child interrupt configurator callback.
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  onChildInterrupt<TPayload>(
    interrupt: MaybeBuilder<InterruptNode<TPayload>>,
    configure?: ($intr: ChildInterruptBuilder<TPayload>) => ChildInterruptBuilder<TPayload>,
  ): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Registers an actor-level default interrupt handler preserved across `.withPolicy()` and `.withTools()` clones.
   *
   * Evaluated when `interrupt` is raised and no step-level `.onInterrupt()` override matches.
   * @template TPayload Interrupt payload type.
   * @param {MaybeBuilder<InterruptNode<TPayload>>}                                                                             interrupt - Target interrupt node or builder.
   * @param {($intr: InterruptEdgeBuilder<TIn, TPayload, THandle>) => AstBuilder<InterruptHandlerNode<TIn, TPayload, THandle>>} configure - Interrupt edge configurator callback.
   * @returns {AgentBuilder<TIn, TOut, THandle>} New immutable agent builder.
   */
  onInterrupt<TPayload>(interrupt: MaybeBuilder<InterruptNode<TPayload>>, configure: ($intr: InterruptEdgeBuilder<TIn, TPayload, THandle>) => AstBuilder<InterruptHandlerNode<TIn, TPayload, THandle>>): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Clones this agent with `newPolicy` while preserving `roleKey`, `.prefixGroup()`, `.partitions()`, and `.onInterrupt()` handlers.
   *
   * Produces a new immutable `AgentBuilder` without mutating the source agent definition.
   * @param {MaybeBuilder<PolicyNode<THandle>>} newPolicy - Replacement policy node or builder.
   * @returns {AgentBuilder<TIn, TOut, THandle>} Cloned immutable agent builder.
   */
  withPolicy(newPolicy: MaybeBuilder<PolicyNode<THandle>>): AgentBuilder<TIn, TOut, THandle>;
  /**
   * Clones this agent with additional tools and derives the canonical order-independent `roleKey` (`"${id}+tools:${sortedNames}"`).
   *
   * Preserves all existing configuration while appending `extraTools` to the cloned agent.
   * @param {...ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>>>>} extraTools - Additional tools to mount.
   * @returns {AgentBuilder<TIn, TOut, THandle>} Cloned immutable agent builder with updated `roleKey`.
   */
  withTools(...extraTools: ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>> | ReadonlyArray<MaybeBuilder<ToolASTNode<THandle>>>>): AgentBuilder<TIn, TOut, THandle>;
}
