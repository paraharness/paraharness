import type { z } from 'zod';
import type { MaybeBuilder } from './ast/ast-foundation.types.js';
import type { ASTNode } from './ast/ast-node.js';
import type { SourceASTNode } from './ast/domain-ast.types.js';
import type { EnvRef } from './ast/env-ref.js';
import type { InterruptBuilder } from './ast/interrupt-builder.js';
import type { SignalBuilder } from './ast/signal-builder.js';
import type { SkillNode } from './ast/skill-node.types.js';
import type { AgentBuilder } from './builders/agent-builder.js';
import type { CommandBuilder } from './builders/command-builder.js';
import type { CommandConfigOptions } from './builders/command-config-options.js';
import type { FlowBuilder } from './builders/flow-builder.js';
import type { HarnessBuilder } from './builders/harness-builder.js';
import type { HumanBuilder } from './builders/human-builder.js';
import type { LaneBuilder } from './builders/lane-builder.js';
import type { LessonsBuilder } from './builders/lessons-builder.js';
import type { LoopBuilder } from './builders/loop-builder.js';
import type { PolicyBuilder } from './builders/policy-builder.js';
import type { PoolBuilder } from './builders/pool-builder.js';
import type { PrefixGroupBuilder } from './builders/prefix-group-builder.js';
import type { RulesBuilder } from './builders/rules-builder.js';
import type { ScopedRuleBuilder } from './builders/scoped-rule-builder.js';
import type { SkillBuilder } from './builders/skill-builder.js';
import type { StreamBuilder } from './builders/stream-builder.js';
import type { TopologyConfigBuilder } from './builders/topology-config-builder.js';
import type {
  BudgetApprovalSchema,
  DistilledLessonCandidateSchema,
  ResumeForkInputSchema,
} from './schemas/budget-and-lesson.schema.js';
import type {
  GlobalRuleSchema,
  ScopePredicateSchema,
  ScopedRule,
  ScopedRuleSchema,
} from './schemas/core-rules.schema.js';
import type {
  SpeculationCandidateSchema,
  SpeculationInputSchema,
} from './schemas/speculation-schemas.js';

/**
 * Root declarative builder namespace (`P`) for constructing passive ParaHarness AST definitions.
 *
 * Exposes factory methods for every core orchestration construct alongside canonical Zod schemas.
 */
export interface PNamespace {
  /**
   * Creates a symbolic environment variable reference (`EnvRef`) without reading `process.env`.
   *
   * Resolved exclusively at leaf adapter invocation from explicitly injected environment maps.
   * @param {string} key - Environment variable name.
   * @returns {EnvRef} Deeply frozen symbolic `EnvRef` node.
   */
  env(key: string): EnvRef;
  /**
   * Creates a fluent `SignalBuilder` for a cross-lane or external signal (`P.signal(id)`).
   *
   * Defaults the payload schema to `z.unknown()` when `schema` is omitted.
   * @template TPayload Validated signal payload type.
   * @param {string}              id       - Unique identifier of the signal.
   * @param {z.ZodType<TPayload>} [schema] - Optional initial Zod payload schema.
   * @returns {SignalBuilder<TPayload>} Frozen `SignalBuilder` instance.
   */
  signal<TPayload = unknown>(id: string, schema?: z.ZodType<TPayload>): SignalBuilder<TPayload>;
  /**
   * Creates a fluent `InterruptBuilder` for an upward or guard-triggered interrupt (`P.interrupt(id)`).
   *
   * Defaults the payload schema to `z.unknown()` when `schema` is omitted.
   * @template TPayload Validated interrupt payload type.
   * @param {string}              id       - Unique identifier of the interrupt.
   * @param {z.ZodType<TPayload>} [schema] - Optional initial Zod payload schema.
   * @returns {InterruptBuilder<TPayload>} Frozen `InterruptBuilder` instance.
   */
  interrupt<TPayload = unknown>(id: string, schema?: z.ZodType<TPayload>): InterruptBuilder<TPayload>;
  /**
   * Creates a fluent `StreamBuilder` for an inbound event stream (`P.stream(id)`).
   *
   * Connects an external stream source to a typed signal emission rule.
   * @template TEvent   Raw external event payload type.
   * @template TPayload Emitted signal payload type.
   * @param {string} id - Unique identifier of the stream.
   * @returns {StreamBuilder<TEvent, TPayload>} Frozen `StreamBuilder` instance.
   */
  stream<TEvent = unknown, TPayload = unknown>(id: string): StreamBuilder<TEvent, TPayload>;
  /**
   * Creates a fluent `PoolBuilder` for an account seat or model pool (`P.pool(id)`).
   *
   * Aggregates candidate items with a selection strategy and optional fallback item.
   * @template TItem Candidate AST node type managed by the pool.
   * @param {string} id - Unique identifier of the pool.
   * @returns {PoolBuilder<TItem>} Frozen `PoolBuilder` instance.
   */
  pool<TItem extends ASTNode = ASTNode>(id: string): PoolBuilder<TItem>;
  /**
   * Creates a fluent `PrefixGroupBuilder` for shared byte-identical wire system prompts (`P.prefixGroup(id)`).
   *
   * Pins shared grounding, instructions, and global rules across multiple agent roles.
   * @param {string} id - Unique identifier of the prefix group.
   * @returns {PrefixGroupBuilder} Frozen `PrefixGroupBuilder` instance.
   */
  prefixGroup(id: string): PrefixGroupBuilder;
  /**
   * Creates a fluent `TopologyConfigBuilder` for a relational partition DAG (`P.topology(id)`).
   *
   * Validates partition dependency graphs and configures signal-driven contract overlays.
   * @param {string} id - Unique identifier of the topology.
   * @returns {TopologyConfigBuilder<string>} Frozen `TopologyConfigBuilder` instance.
   */
  topology(id: string): TopologyConfigBuilder<string>;
  /**
   * Creates a fluent `HumanBuilder` for an external human authority or notification channel (`P.human(id)`).
   *
   * Tracks bidirectional versus notify-only channel capabilities at the type level.
   * @param {string} id - Unique identifier of the human authority.
   * @returns {HumanBuilder<'bidirectional' | 'notify-only'>} Frozen `HumanBuilder` instance.
   */
  human(id: string): HumanBuilder<'bidirectional' | 'notify-only'>;
  /**
   * Creates a fluent `RulesBuilder` for global and scoped rules (`P.rules(id)`).
   *
   * Aggregates always-active global rules and partition- or effect-scoped rules.
   * @param {string} id - Unique identifier of the rules registry.
   * @returns {RulesBuilder} Frozen `RulesBuilder` instance.
   */
  rules(id: string): RulesBuilder;
  /**
   * Creates a fluent `ScopedRuleBuilder` for a path/partition-activated rule (`P.scopedRule(idOrSource)`).
   *
   * Binds activation predicates, directives, and optional `beforeStop` check gates.
   * @param {string | MaybeBuilder<SourceASTNode<ScopedRule>>} idOrSource - Unique identifier or frontmatter rule source.
   * @returns {ScopedRuleBuilder} Frozen `ScopedRuleBuilder` instance.
   */
  scopedRule(idOrSource: string | MaybeBuilder<SourceASTNode<ScopedRule>>): ScopedRuleBuilder;
  /**
   * Creates a fluent `SkillBuilder` for a dynamically unlocked skill (`P.skill(idOrSource)`).
   *
   * Configures pull-based instructions, unlocked tools, and background daemon services.
   * @template THandle Isolation scope handle type.
   * @param {string | MaybeBuilder<SourceASTNode<SkillNode<THandle>>>} idOrSource - Unique identifier or frontmatter skill source.
   * @returns {SkillBuilder<THandle>} Frozen `SkillBuilder` instance.
   */
  skill<THandle = unknown>(
    idOrSource: string | MaybeBuilder<SourceASTNode<SkillNode<THandle>>>,
  ): SkillBuilder<THandle>;
  /**
   * Creates a fluent `LessonsBuilder` for empirical lesson recall, distillation, and scoring (`P.lessons(id)`).
   *
   * Configures contrastive distillation, 4-state utility scoring, retirement, and promotion signals.
   * @template TIn Actor input payload type for `.queryFrom(...)`.
   * @param {string} id - Unique identifier of the lessons subsystem.
   * @returns {LessonsBuilder<TIn>} Frozen `LessonsBuilder` instance.
   */
  lessons<TIn = unknown>(id: string): LessonsBuilder<TIn>;
  /**
   * Creates a fluent `PolicyBuilder` for capability guards and quantitative limits (`P.policy(id)`).
   *
   * Configures pre-flight/post-flight guard clauses, tripwires, and resource ceilings.
   * @template THandle Isolation scope handle type.
   * @param {string} id - Unique identifier of the policy.
   * @returns {PolicyBuilder<THandle>} Frozen `PolicyBuilder` instance.
   */
  policy<THandle = unknown>(id: string): PolicyBuilder<THandle>;
  /**
   * Creates a fluent `CommandBuilder` for a deterministic TypeScript step command (`P.command(id)` or `P.command(id, options)`).
   *
   * Supports both fluent method chaining and the 2-argument `CommandConfigOptions` overload.
   * @template TIn     Validated command input payload type.
   * @template TOut    Validated command output payload type.
   * @template THandle Isolation scope handle type.
   * @param {string}                                   id        - Unique identifier of the command step.
   * @param {CommandConfigOptions<TIn, TOut, THandle>} [options] - Optional direct command configuration.
   * @returns {CommandBuilder<TIn, TOut, THandle>} Frozen `CommandBuilder` instance.
   */
  command<TIn = unknown, TOut = unknown, THandle = unknown>(id: string, options?: CommandConfigOptions<TIn, TOut, THandle>): CommandBuilder<TIn, TOut, THandle>;
  /**
   * Creates a fluent `AgentBuilder` for the universal LLM actor primitive (`P.agent(id)`).
   *
   * Compiles to a passive `AgentNode` with canonical `roleKey` derivation.
   * @template THandle Isolation scope handle type.
   * @param {string} id - Unique identifier of the base agent.
   * @returns {AgentBuilder<unknown, unknown, THandle>} Frozen `AgentBuilder` instance.
   */
  agent<THandle = unknown>(id: string): AgentBuilder<unknown, unknown, THandle>;
  /**
   * Creates a fluent `LoopBuilder` for an iterative action-and-evaluation refinement loop (`P.loop(id)`).
   *
   * Pairs a write-capable `.act()` agent with a read-only adversarial `.evaluate()` agent.
   * @template THandle Isolation scope handle type.
   * @param {string} id - Unique identifier of the loop.
   * @returns {LoopBuilder<unknown, unknown, THandle, string>} Frozen `LoopBuilder` instance.
   */
  loop<THandle = unknown>(id: string): LoopBuilder<unknown, unknown, THandle, string>;
  /**
   * Creates a fluent `FlowBuilder` for a declarative multi-step workflow (`P.flow(id)`).
   *
   * Threads scope handles, receipts, telemetry metrics, and step outputs across sequential steps and branches.
   * @param {string} id - Unique identifier of the flow.
   * @returns {FlowBuilder<unknown, unknown, never, unknown, Record<string, unknown>, Record<string, never>>} Frozen `FlowBuilder` instance.
   */
  flow(id: string): FlowBuilder<unknown, unknown, never, unknown, Record<string, unknown>, Record<string, never>>;
  /**
   * Creates a fluent `LaneBuilder` for a concurrent work execution lane (`P.lane(id)`).
   *
   * Configures tracker polling, flow execution, concurrency, priority aging, and signal rewinds.
   * @param {string} id - Unique identifier of the lane.
   * @returns {LaneBuilder<unknown, string>} Frozen `LaneBuilder` instance.
   */
  lane(id: string): LaneBuilder<unknown, string>;
  /**
   * Creates a fluent `HarnessBuilder` for a root ParaHarness application (`P.harness(id)`).
   *
   * Binds the state ledger, pools, streams, lanes, signal notifications, and control planes.
   * @param {string} id - Unique identifier of the harness application.
   * @returns {HarnessBuilder} Frozen `HarnessBuilder` instance.
   */
  harness(id: string): HarnessBuilder;
  /** Canonical Zod schema for scope activation predicates (`ScopePredicateSchema`). */
  readonly ScopePredicateSchema: typeof ScopePredicateSchema;
  /** Canonical Zod schema for global rules (`GlobalRuleSchema`). */
  readonly GlobalRuleSchema: typeof GlobalRuleSchema;
  /** Canonical Zod schema for scoped rules (`ScopedRuleSchema`). */
  readonly ScopedRuleSchema: typeof ScopedRuleSchema;
  /** Canonical Zod schema for human budget approvals (`BudgetApprovalSchema`). */
  readonly BudgetApprovalSchema: typeof BudgetApprovalSchema;
  /** Canonical Zod schema for distilled lesson candidates (`DistilledLessonCandidateSchema`). */
  readonly DistilledLessonCandidateSchema: typeof DistilledLessonCandidateSchema;
  /** Canonical Zod schema for the native `resumeFork` tool (`ResumeForkInputSchema`). */
  readonly ResumeForkInputSchema: typeof ResumeForkInputSchema;
  /** Canonical Zod schema factory for a single speculative candidate (`SpeculationCandidateSchema`). */
  readonly SpeculationCandidateSchema: typeof SpeculationCandidateSchema;
  /** Canonical Zod schema factory for arbiter speculation input (`SpeculationInputSchema`). */
  readonly SpeculationInputSchema: typeof SpeculationInputSchema;
}
