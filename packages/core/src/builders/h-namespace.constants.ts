import type { z } from 'zod';
import type { ASTNode } from '../ast/ast-node.js';
import type { EnvRef } from '../ast/env-ref.js';
import type { InterruptBuilder } from '../ast/interrupt-builder.js';
import type { SignalBuilder } from '../ast/signal-builder.js';
import {
  BudgetApprovalSchema,
  DistilledLessonCandidateSchema,
  ResumeForkInputSchema,
} from '../schemas/budget-and-lesson.schema.js';
import {
  GlobalRuleSchema,
  ScopePredicateSchema,
  ScopedRuleSchema,
} from '../schemas/core-rules.schema.js';
import {
  SpeculationCandidateSchema,
  SpeculationInputSchema,
} from '../schemas/speculation-schemas.js';
import type { AgentBuilder } from './agent-builder.js';
import type { CommandBuilder } from './command-builder.js';
import type { CommandConfigOptions } from './command-config-options.js';
import { createAgentBuilder } from './create-agent-builder.js';
import { createCommandBuilder } from './create-command-builder.js';
import { createFlowBuilder } from './create-flow-builder.js';
import { createHarnessBuilder } from './create-harness-builder.js';
import { createHumanBuilder } from './create-human-builder.js';
import { createInterruptBuilder } from './create-interrupt-builder.js';
import { createLaneBuilder } from './create-lane-builder.js';
import { createLessonsBuilder } from './create-lessons-builder.js';
import { createLoopBuilder } from './create-loop-builder.js';
import { createPolicyBuilder } from './create-policy-builder.js';
import { createPoolBuilder } from './create-pool-builder.js';
import { createPrefixGroupBuilder } from './create-prefix-group-builder.js';
import { createRulesBuilder } from './create-rules-builder.js';
import { createScopedRuleBuilder } from './create-scoped-rule-builder.js';
import { createSignalBuilder } from './create-signal-builder.js';
import { createSkillBuilder } from './create-skill-builder.js';
import { createStreamBuilder } from './create-stream-builder.js';
import { createTopologyBuilder } from './create-topology-builder.js';
import type { FlowBuilder } from './flow-builder.js';
import type { HarnessBuilder } from './harness-builder.js';
import type { HarnessNamespace } from './harness-namespace.js';
import type { HumanBuilder } from './human-builder.js';
import { assertNonEmptyIdentifier, deepFreeze } from './internal/deep-freeze.js';
import type { LaneBuilder } from './lane-builder.js';
import type { LessonsBuilder } from './lessons-builder.js';
import type { LoopBuilder } from './loop-builder.js';
import type { PolicyBuilder } from './policy-builder.js';
import type { PoolBuilder } from './pool-builder.js';
import type { PrefixGroupBuilder } from './prefix-group-builder.js';
import type { RulesBuilder } from './rules-builder.js';
import type { ScopedRuleBuilder } from './scoped-rule-builder.js';
import type { SkillBuilder } from './skill-builder.js';
import type { StreamBuilder } from './stream-builder.js';
import type { TopologyConfigBuilder } from './topology-config-builder.js';

/**
 * Root declarative builder namespace (`H`) for constructing passive MetaHarness AST definitions.
 *
 * All builders under `H` are pure, copy-on-write immutable, and produce deeply frozen passive AST nodes.
 */
export const H: HarnessNamespace = Object.freeze<HarnessNamespace>({
  env(key: string): EnvRef {
    assertNonEmptyIdentifier('H.env', key);
    return deepFreeze<EnvRef>({
      type: 'harness:env-ref',
      key,
    });
  },
  signal<TPayload = unknown>(id: string, schema?: z.ZodType<TPayload, z.ZodTypeDef, unknown>): SignalBuilder<TPayload> {
    return createSignalBuilder<TPayload>(id, schema);
  },
  interrupt<TPayload = unknown>(id: string, schema?: z.ZodType<TPayload, z.ZodTypeDef, unknown>): InterruptBuilder<TPayload> {
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
  scopedRule(id: string): ScopedRuleBuilder {
    return createScopedRuleBuilder(id);
  },
  skill<THandle = unknown>(id: string): SkillBuilder<THandle> {
    return createSkillBuilder<THandle>(id);
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
