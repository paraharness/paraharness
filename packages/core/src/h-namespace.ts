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
import { createAgentBuilder } from './builders/create-agent-builder.js';
import { createCommandBuilder } from './builders/create-command-builder.js';
import { createFlowBuilder } from './builders/create-flow-builder.js';
import { createHarnessBuilder } from './builders/create-harness-builder.js';
import { createHumanBuilder } from './builders/create-human-builder.js';
import { createInterruptBuilder } from './builders/create-interrupt-builder.js';
import { createLaneBuilder } from './builders/create-lane-builder.js';
import { createLessonsBuilder } from './builders/create-lessons-builder.js';
import { createLoopBuilder } from './builders/create-loop-builder.js';
import { createPolicyBuilder } from './builders/create-policy-builder.js';
import { createPoolBuilder } from './builders/create-pool-builder.js';
import { createPrefixGroupBuilder } from './builders/create-prefix-group-builder.js';
import { createRulesBuilder } from './builders/create-rules-builder.js';
import { createScopedRuleBuilder } from './builders/create-scoped-rule-builder.js';
import { createSignalBuilder } from './builders/create-signal-builder.js';
import { createSkillBuilder } from './builders/create-skill-builder.js';
import { createStreamBuilder } from './builders/create-stream-builder.js';
import { createTopologyBuilder } from './builders/create-topology-builder.js';
import type { FlowBuilder } from './builders/flow-builder.js';
import type { HarnessBuilder } from './builders/harness-builder.js';
import type { HumanBuilder } from './builders/human-builder.js';
import { assertNonEmptyIdentifier, deepFreeze } from './builders/internal/deep-freeze.js';
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
import type { HNamespace } from './h-namespace-contract.js';
import {
  BudgetApprovalSchema,
  DistilledLessonCandidateSchema,
  ResumeForkInputSchema,
} from './schemas/budget-and-lesson.schema.js';
import {
  GlobalRuleSchema,
  ScopePredicateSchema,
  type ScopedRule,
  ScopedRuleSchema,
} from './schemas/core-rules.schema.js';
import {
  SpeculationCandidateSchema,
  SpeculationInputSchema,
} from './schemas/speculation-schemas.js';

/**
 * Root declarative builder namespace (`H`) for constructing passive MetaHarness AST definitions.
 *
 * All builders under `H` are pure, copy-on-write immutable, and produce deeply frozen passive AST nodes.
 */
export const H: HNamespace = Object.freeze<HNamespace>({
  env(key: string): EnvRef {
    assertNonEmptyIdentifier('H.env', key);
    return deepFreeze<EnvRef>({
      type: 'harness:env-ref',
      key,
    });
  },
  signal<TPayload = unknown>(id: string, schema?: z.ZodType<TPayload>): SignalBuilder<TPayload> {
    return createSignalBuilder<TPayload>(id, schema);
  },
  interrupt<TPayload = unknown>(id: string, schema?: z.ZodType<TPayload>): InterruptBuilder<TPayload> {
    return createInterruptBuilder<TPayload>(id, schema);
  },
  stream<TEvent = unknown, TPayload = unknown>(id: string): StreamBuilder<TEvent, TPayload> {
    return createStreamBuilder<TEvent, TPayload>(id);
  },
  pool<TItem extends ASTNode = ASTNode>(id: string): PoolBuilder<TItem> {
    return createPoolBuilder<TItem>(id);
  },
  prefixGroup(id: string): PrefixGroupBuilder {
    return createPrefixGroupBuilder(id);
  },
  topology(id: string): TopologyConfigBuilder<string> {
    return createTopologyBuilder(id);
  },
  human(id: string): HumanBuilder<'bidirectional' | 'notify-only'> {
    return createHumanBuilder(id);
  },
  rules(id: string): RulesBuilder {
    return createRulesBuilder(id);
  },
  scopedRule(idOrSource: string | MaybeBuilder<SourceASTNode<ScopedRule>>): ScopedRuleBuilder {
    return createScopedRuleBuilder(idOrSource);
  },
  skill<THandle = unknown>(
    idOrSource: string | MaybeBuilder<SourceASTNode<SkillNode<THandle>>>,
  ): SkillBuilder<THandle> {
    return createSkillBuilder<THandle>(idOrSource);
  },
  lessons<TIn = unknown>(id: string): LessonsBuilder<TIn> {
    return createLessonsBuilder<TIn>(id);
  },
  policy<THandle = unknown>(id: string): PolicyBuilder<THandle> {
    return createPolicyBuilder<THandle>(id);
  },
  command<TIn = unknown, TOut = unknown, THandle = unknown>(
    id: string,
    options?: CommandConfigOptions<TIn, TOut, THandle>,
  ): CommandBuilder<TIn, TOut, THandle> {
    return createCommandBuilder<TIn, TOut, THandle>(id, options);
  },
  agent<THandle = unknown>(id: string): AgentBuilder<unknown, unknown, THandle> {
    return createAgentBuilder<THandle>(id);
  },
  loop<THandle = unknown>(id: string): LoopBuilder<unknown, unknown, THandle, string> {
    return createLoopBuilder<THandle>(id);
  },
  flow(
    id: string,
  ): FlowBuilder<unknown, unknown, never, unknown, Record<string, unknown>, Record<string, never>> {
    return createFlowBuilder(id);
  },
  lane(id: string): LaneBuilder<unknown, string> {
    return createLaneBuilder(id);
  },
  harness(id: string): HarnessBuilder {
    return createHarnessBuilder(id);
  },
  ScopePredicateSchema,
  GlobalRuleSchema,
  ScopedRuleSchema,
  BudgetApprovalSchema,
  DistilledLessonCandidateSchema,
  ResumeForkInputSchema,
  SpeculationCandidateSchema,
  SpeculationInputSchema,
});
