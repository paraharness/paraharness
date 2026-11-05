import { z } from 'zod';
import type {
  AbortHook,
  Check,
  ControlPlaneAdapter,
  CrossVerifier,
  EffectMatcher,
  EnvRef,
  ExecutionContext,
  HumanAdapter,
  IsolationScope,
  LeaseDelta,
  LedgerStore,
  LessonRecord,
  LessonStore,
  MaybeSource,
  PolicyGuard,
  PoolCandidateState,
  PoolSelectionContext,
  PoolSelectorFn,
  PoolStrategyPort,
  QuotaTripwire,
  ScopeRewindHook,
  Service,
  Source,
  StepExecutable,
  StreamSource,
  TelemetryCollector,
  ToolDefinition,
  TopologyStore,
  TrackerAdapter,
  UniversalStepTelemetry,
} from './ports.js';
import {
  BudgetApprovalSchema,
  DistilledLessonCandidateSchema,
  GlobalRule,
  ResumeForkInputSchema,
  ScopedRule,
  SkillDefinition,
  SpeculationCandidateSchema,
  SpeculationInputSchema,
} from './schemas.js';
import type {
  AgentCapabilitiesBuilder,
  AgentCapabilitiesConfig,
  AgentDef,
  ArbiterDecision,
  ChildInterruptBuilder,
  ChildInterruptHandlerConfig,
  CommitOverlayOptions,
  EscalateCapabilityBuilder,
  EscalateCapabilityConfig,
  FlowBranchBuilder,
  FlowBranchNodeConfig,
  FlowDef,
  FlowNodeConfig,
  FlowStepBuilder,
  FlowStepNodeConfig,
  FlowSubBranchBuilder,
  ForkCapabilityBuilder,
  ForkCapabilityConfig,
  ForkModelRoutingBuilder,
  ForkModelRoutingConfig,
  HarnessDef,
  HarnessSignalBuilder,
  HarnessSignalHandlerConfig,
  HumanDef,
  HumanNameBuilder,
  InterruptDef,
  InterruptEdgeBuilder,
  InterruptEdgeConfig,
  LaneDef,
  LaneRetryBuilder,
  LaneRetryConfig,
  LaneSignalBuilder,
  LaneSignalHandlerConfig,
  LaneTrackerBuilder,
  LaneTrackerConfig,
  LessonDistillBuilder,
  LessonDistillConfig,
  LessonEmitSignalBuilder,
  LessonRetireBuilder,
  LessonRetireConfig,
  LessonScoringBuilder,
  LessonScoringConfig,
  LessonsDef,
  LessonSignalTriggerConfig,
  LimitExceededBuilder,
  LimitExceededConfig,
  LoopDef,
  LoopEvaluateConfig,
  MutatePlanBuilder,
  MutatePlanCapabilityConfig,
  NestedHumanInterruptBuilder,
  NestedHumanInterruptConfig,
  PolicyDef,
  PolicyGuardChainBuilder,
  PolicyGuardClauseConfig,
  PolicyViolation,
  PoolDef,
  PoolStrategyBuilder,
  PoolStrategyConfig,
  PrefixGroupDef,
  RulesDef,
  ScopedHumanTarget,
  ScopedRuleDef,
  SignalDef,
  SkillDef,
  SpawnTasksCapabilityConfig,
  SpeculateCapabilityBuilder,
  SpeculateCapabilityConfig,
  StepExecutors,
  StreamDef,
  TopologyDef,
} from './ast.js';

class AsyncCallbackError extends Error {
  constructor(context: string) {
    super(`Async callback is forbidden in ${context}; callbacks must be synchronous.`);
    this.name = 'AsyncCallbackError';
  }
}

function assertSyncCallback(fn: unknown, context: string): void {
  if (typeof fn === 'function' && fn.constructor.name === 'AsyncFunction') {
    throw new AsyncCallbackError(context);
  }
}

function isToolArray<THandle>(
  item: ToolDefinition<THandle> | readonly ToolDefinition<THandle>[],
): item is readonly ToolDefinition<THandle>[] {
  return Array.isArray(item);
}

function flattenTools<THandle>(
  items: ReadonlyArray<ToolDefinition<THandle> | readonly ToolDefinition<THandle>[]>,
): ToolDefinition<THandle>[] {
  const out: ToolDefinition<THandle>[] = [];
  for (const item of items) {
    if (isToolArray(item)) {
      out.push(...item);
    } else {
      out.push(item);
    }
  }
  return out;
}

let registeredExecutors: StepExecutors | undefined;

export function registerStepExecutors(executors: StepExecutors): void {
  registeredExecutors = executors;
}

class SignalDefImpl<TPayload> implements SignalDef<TPayload> {
  readonly kind = 'harness:signal' as const;
  readonly id: string;
  readonly schema: z.ZodType<TPayload, z.ZodTypeDef, unknown>;

  constructor(id: string, schema: z.ZodType<TPayload, z.ZodTypeDef, unknown>) {
    this.id = id;
    this.schema = schema;
  }

  payload<TSchema extends z.ZodTypeAny>(schema: TSchema): SignalDef<z.infer<TSchema>> {
    return new SignalDefImpl<z.infer<TSchema>>(this.id, schema);
  }
}

class InterruptDefImpl<TPayload> implements InterruptDef<TPayload> {
  readonly kind = 'harness:interrupt' as const;
  readonly id: string;
  readonly schema: z.ZodType<TPayload, z.ZodTypeDef, unknown>;

  constructor(id: string, schema: z.ZodType<TPayload, z.ZodTypeDef, unknown>) {
    this.id = id;
    this.schema = schema;
  }

  payload<TSchema extends z.ZodTypeAny>(schema: TSchema): InterruptDef<z.infer<TSchema>> {
    return new InterruptDefImpl<z.infer<TSchema>>(this.id, schema);
  }
}

class StreamDefImpl<TEvent, TPayload> implements StreamDef<TEvent, TPayload> {
  readonly kind = 'harness:stream' as const;
  readonly id: string;
  readonly streamSource?: StreamSource<TEvent>;
  readonly predicate?: (ev: TEvent) => boolean;
  readonly targetSignal?: SignalDef<TPayload>;
  readonly payloadMapper?: (ev: TEvent) => TPayload;

  constructor(opts: {
    readonly id: string;
    readonly streamSource?: StreamSource<TEvent>;
    readonly predicate?: (ev: TEvent) => boolean;
    readonly targetSignal?: SignalDef<TPayload>;
    readonly payloadMapper?: (ev: TEvent) => TPayload;
  }) {
    this.id = opts.id;
    this.streamSource = opts.streamSource;
    this.predicate = opts.predicate;
    this.targetSignal = opts.targetSignal;
    this.payloadMapper = opts.payloadMapper;
  }

  source<TEv>(src: StreamSource<TEv>): StreamDef<TEv, TPayload> {
    return new StreamDefImpl<TEv, TPayload>({
      id: this.id,
      streamSource: src,
      targetSignal: this.targetSignal,
    });
  }

  filter(pred: (ev: TEvent) => boolean): StreamDef<TEvent, TPayload> {
    assertSyncCallback(pred, 'H.stream.filter');
    return new StreamDefImpl<TEvent, TPayload>({
      id: this.id,
      streamSource: this.streamSource,
      predicate: pred,
      targetSignal: this.targetSignal,
      payloadMapper: this.payloadMapper,
    });
  }

  emitSignal<TP>(signal: SignalDef<TP>, mapper: (ev: TEvent) => TP): StreamDef<TEvent, TP> {
    assertSyncCallback(mapper, 'H.stream.emitSignal');
    return new StreamDefImpl<TEvent, TP>({
      id: this.id,
      streamSource: this.streamSource,
      predicate: this.predicate,
      targetSignal: signal,
      payloadMapper: mapper,
    });
  }
}

class PoolStrategyBuilderImpl<TItem> implements PoolStrategyBuilder<TItem> {
  private mode: PoolStrategyConfig<TItem>['mode'] = 'round-robin';
  private minRate?: number;
  private samples?: number;
  private customStrat?: PoolStrategyPort<TItem> | PoolSelectorFn<TItem>;
  wasUsed = false;

  escalateOnRetry(): PoolStrategyBuilder<TItem> {
    this.wasUsed = true;
    this.mode = 'escalate-on-retry';
    return this;
  }

  minSuccessRate(rate: number): PoolStrategyBuilder<TItem> {
    this.wasUsed = true;
    this.minRate = rate;
    return this;
  }

  minSamples(samples: number): PoolStrategyBuilder<TItem> {
    this.wasUsed = true;
    this.samples = samples;
    return this;
  }

  custom(strategy: PoolStrategyPort<TItem> | PoolSelectorFn<TItem>): PoolStrategyBuilder<TItem> {
    this.wasUsed = true;
    if (typeof strategy === 'function') {
      assertSyncCallback(strategy, 'H.pool.strategy.custom');
    }
    this.mode = 'custom';
    this.customStrat = strategy;
    return this;
  }

  buildConfig(): PoolStrategyConfig<TItem> {
    return {
      mode: this.mode,
      minSuccessRate: this.minRate,
      minSamples: this.samples,
      customStrategy: this.customStrat,
    };
  }
}

function isPoolBuilderCallback<TItem>(
  _fn: (($: PoolStrategyBuilder<TItem>) => PoolStrategyBuilder<TItem>) | PoolSelectorFn<TItem>,
  wasUsed: boolean,
): _fn is ($: PoolStrategyBuilder<TItem>) => PoolStrategyBuilder<TItem> {
  return wasUsed;
}

class PoolDefImpl<TItem> implements PoolDef<TItem> {
  readonly kind = 'harness:pool' as const;
  readonly id: string;
  readonly items: readonly TItem[];
  readonly strategyConfig: PoolStrategyConfig<TItem>;
  readonly fallbackItem?: TItem;

  constructor(opts: {
    readonly id: string;
    readonly items: readonly TItem[];
    readonly strategyConfig: PoolStrategyConfig<TItem>;
    readonly fallbackItem?: TItem;
  }) {
    this.id = opts.id;
    this.items = opts.items;
    this.strategyConfig = opts.strategyConfig;
    this.fallbackItem = opts.fallbackItem;
  }

  with<T>(...items: T[]): PoolDef<T> {
    return new PoolDefImpl<T>({
      id: this.id,
      items: [...items],
      strategyConfig: { mode: 'round-robin' },
    });
  }

  strategy(
    modeOrBuilder:
      | 'soonest-reset'
      | 'round-robin'
      | 'least-used'
      | (($: PoolStrategyBuilder<TItem>) => PoolStrategyBuilder<TItem>)
      | PoolStrategyPort<TItem>
      | PoolSelectorFn<TItem>,
  ): PoolDef<TItem> {
    if (typeof modeOrBuilder === 'string') {
      return new PoolDefImpl<TItem>({
        id: this.id,
        items: this.items,
        strategyConfig: { mode: modeOrBuilder },
        fallbackItem: this.fallbackItem,
      });
    }

    if (typeof modeOrBuilder === 'object') {
      return new PoolDefImpl<TItem>({
        id: this.id,
        items: this.items,
        strategyConfig: { mode: 'custom', customStrategy: modeOrBuilder },
        fallbackItem: this.fallbackItem,
      });
    }

    assertSyncCallback(modeOrBuilder, 'H.pool.strategy');
    const builder = new PoolStrategyBuilderImpl<TItem>();
    const probe: PoolStrategyBuilder<TItem> & readonly PoolCandidateState<TItem>[] = Object.assign(
      [] as PoolCandidateState<TItem>[],
      {
        escalateOnRetry: () => builder.escalateOnRetry(),
        minSuccessRate: (rate: number) => builder.minSuccessRate(rate),
        minSamples: (samples: number) => builder.minSamples(samples),
        custom: (strategy: PoolStrategyPort<TItem> | PoolSelectorFn<TItem>) => builder.custom(strategy),
      },
    );
    const dummyCtx: PoolSelectionContext = {
      poolId: this.id,
      runId: '',
      retryAttempt: 0,
      nowMs: 0,
    };

    try {
      modeOrBuilder(probe, dummyCtx);
    } catch (err) {
      if (err instanceof AsyncCallbackError) {
        throw err;
      }
    }

    if (isPoolBuilderCallback(modeOrBuilder, builder.wasUsed)) {
      return new PoolDefImpl<TItem>({
        id: this.id,
        items: this.items,
        strategyConfig: builder.buildConfig(),
        fallbackItem: this.fallbackItem,
      });
    }

    return new PoolDefImpl<TItem>({
      id: this.id,
      items: this.items,
      strategyConfig: { mode: 'custom', customStrategy: modeOrBuilder },
      fallbackItem: this.fallbackItem,
    });
  }

  fallback(item: TItem): PoolDef<TItem> {
    return new PoolDefImpl<TItem>({
      id: this.id,
      items: this.items,
      strategyConfig: this.strategyConfig,
      fallbackItem: item,
    });
  }
}

class HumanDefImpl implements HumanDef {
  readonly kind = 'harness:human' as const;
  readonly id: string;
  readonly keepAliveSec?: number;
  readonly adapter?: HumanAdapter;

  constructor(opts: {
    readonly id: string;
    readonly keepAliveSec?: number;
    readonly adapter?: HumanAdapter;
  }) {
    this.id = opts.id;
    this.keepAliveSec = opts.keepAliveSec;
    this.adapter = opts.adapter;
  }

  keepAliveSeconds(seconds: number): HumanDef {
    return new HumanDefImpl({
      id: this.id,
      keepAliveSec: seconds,
      adapter: this.adapter,
    });
  }

  notify(adapter: HumanAdapter): HumanDef {
    return new HumanDefImpl({
      id: this.id,
      keepAliveSec: this.keepAliveSec,
      adapter,
    });
  }

  withName(alias: string): HumanNameBuilder {
    const human = this;
    return {
      output<TSchema extends z.ZodTypeAny>(schema: TSchema): ScopedHumanTarget<z.infer<TSchema>> {
        return {
          kind: 'harness:scoped-human',
          human,
          alias,
          responseSchema: schema,
        };
      },
    };
  }
}

class PrefixGroupDefImpl implements PrefixGroupDef {
  readonly kind = 'harness:prefix-group' as const;
  readonly id: string;
  readonly mode: 'role-scoped' | 'union';
  readonly groundingSources: readonly MaybeSource<string>[];
  readonly instructionSources: readonly MaybeSource<string>[];
  readonly sharedRulesDef?: RulesDef;

  constructor(opts: {
    readonly id: string;
    readonly mode: 'role-scoped' | 'union';
    readonly groundingSources: readonly MaybeSource<string>[];
    readonly instructionSources: readonly MaybeSource<string>[];
    readonly sharedRulesDef?: RulesDef;
  }) {
    this.id = opts.id;
    this.mode = opts.mode;
    this.groundingSources = opts.groundingSources;
    this.instructionSources = opts.instructionSources;
    this.sharedRulesDef = opts.sharedRulesDef;
  }

  toolsMode(mode: 'role-scoped' | 'union'): PrefixGroupDef {
    return new PrefixGroupDefImpl({
      id: this.id,
      mode,
      groundingSources: this.groundingSources,
      instructionSources: this.instructionSources,
      sharedRulesDef: this.sharedRulesDef,
    });
  }

  sharedGrounding(...sources: MaybeSource<string>[]): PrefixGroupDef {
    return new PrefixGroupDefImpl({
      id: this.id,
      mode: this.mode,
      groundingSources: [...this.groundingSources, ...sources],
      instructionSources: this.instructionSources,
      sharedRulesDef: this.sharedRulesDef,
    });
  }

  sharedInstructions(...sources: MaybeSource<string>[]): PrefixGroupDef {
    return new PrefixGroupDefImpl({
      id: this.id,
      mode: this.mode,
      groundingSources: this.groundingSources,
      instructionSources: [...this.instructionSources, ...sources],
      sharedRulesDef: this.sharedRulesDef,
    });
  }

  sharedRules(rules: RulesDef): PrefixGroupDef {
    return new PrefixGroupDefImpl({
      id: this.id,
      mode: this.mode,
      groundingSources: this.groundingSources,
      instructionSources: this.instructionSources,
      sharedRulesDef: rules,
    });
  }
}

function validateTopologyAcyclic(
  topologyId: string,
  graph: Readonly<Record<string, { readonly dependsOn?: readonly string[] }>>,
): void {
  const keys = Object.keys(graph);
  const keySet = new Set(keys);
  for (const key of keys) {
    const entry = graph[key];
    const deps = entry?.dependsOn ?? [];
    for (const dep of deps) {
      if (!keySet.has(dep)) {
        throw new Error(`Topology '${topologyId}' partition '${key}' depends on unknown partition '${dep}'.`);
      }
    }
  }

  const state = new Map<string, 0 | 1 | 2>();
  for (const key of keys) {
    state.set(key, 0);
  }

  const visit = (node: string): void => {
    state.set(node, 1);
    const deps = graph[node]?.dependsOn ?? [];
    for (const dep of deps) {
      const depState = state.get(dep) ?? 0;
      if (depState === 1) {
        throw new Error(`Cycle detected in topology '${topologyId}' involving partition '${dep}'.`);
      }
      if (depState === 0) {
        visit(dep);
      }
    }
    state.set(node, 2);
  };

  for (const key of keys) {
    if ((state.get(key) ?? 0) === 0) {
      visit(key);
    }
  }
}

class TopologyDefImpl<TPartition extends string = string> implements TopologyDef<TPartition> {
  readonly kind = 'harness:topology' as const;
  readonly id: string;
  readonly topologyStore?: TopologyStore;
  readonly partitionGraph: Readonly<Record<TPartition, { readonly dependsOn?: readonly TPartition[] }>>;
  readonly overlayOptions?: CommitOverlayOptions<any, any>;

  constructor(opts: {
    readonly id: string;
    readonly topologyStore?: TopologyStore;
    readonly partitionGraph: Readonly<Record<TPartition, { readonly dependsOn?: readonly TPartition[] }>>;
    readonly overlayOptions?: CommitOverlayOptions<any, any>;
  }) {
    this.id = opts.id;
    this.topologyStore = opts.topologyStore;
    this.partitionGraph = opts.partitionGraph;
    this.overlayOptions = opts.overlayOptions;
  }

  store(store: TopologyStore): TopologyDef<TPartition> {
    return new TopologyDefImpl<TPartition>({
      id: this.id,
      topologyStore: store,
      partitionGraph: this.partitionGraph,
      overlayOptions: this.overlayOptions,
    });
  }

  partitions<TMap extends Record<string, { readonly dependsOn?: readonly string[] }>>(
    map: TMap,
  ): TopologyDef<Extract<keyof TMap, string>> {
    validateTopologyAcyclic(this.id, map);
    type TKey = Extract<keyof TMap, string>;
    const normalized: Record<string, { readonly dependsOn?: readonly TKey[] }> = {};
    for (const key of Object.keys(map)) {
      const entry = map[key];
      const deps = entry?.dependsOn ? entry.dependsOn.filter((d): d is TKey => d in map) : undefined;
      normalized[key] = deps ? { dependsOn: deps } : {};
    }
    return new TopologyDefImpl<TKey>({
      id: this.id,
      topologyStore: this.topologyStore,
      partitionGraph: normalized as Readonly<Record<TKey, { readonly dependsOn?: readonly TKey[] }>>,
      overlayOptions: this.overlayOptions,
    });
  }

  commitOverlayWhen<TOnSig = any, TDiscardSig = any>(
    opts?: CommitOverlayOptions<TOnSig, TDiscardSig>,
  ): TopologyDef<TPartition> {
    if (opts?.onSignal) {
      assertSyncCallback(opts.onSignal.correlateBy, 'H.topology.commitOverlayWhen.onSignal.correlateBy');
      assertSyncCallback(opts.onSignal.baseBranch, 'H.topology.commitOverlayWhen.onSignal.baseBranch');
    }
    if (opts?.discardOnSignal) {
      assertSyncCallback(opts.discardOnSignal.correlateBy, 'H.topology.commitOverlayWhen.discardOnSignal.correlateBy');
    }
    return new TopologyDefImpl<TPartition>({
      id: this.id,
      topologyStore: this.topologyStore,
      partitionGraph: this.partitionGraph,
      overlayOptions: opts ?? {},
    });
  }

  dependentsOf(partitionId: TPartition): readonly TPartition[] {
    const allPartitions = Object.keys(this.partitionGraph) as TPartition[];
    const visited = new Set<TPartition>([partitionId]);
    const queue: TPartition[] = [partitionId];
    const dependents: TPartition[] = [];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      for (const candidate of allPartitions) {
        if (visited.has(candidate)) continue;
        const entry = this.partitionGraph[candidate];
        if (entry?.dependsOn?.includes(current)) {
          visited.add(candidate);
          dependents.push(candidate);
          queue.push(candidate);
        }
      }
    }

    return dependents;
  }

  affectedBy(partitionId: TPartition): readonly TPartition[] {
    return [partitionId, ...this.dependentsOf(partitionId)];
  }
}

class ScopedRuleDefImpl implements ScopedRuleDef {
  readonly kind = 'harness:scoped-rule' as const;
  readonly idOrSource: string | Source<ScopedRule>;
  readonly predicate?: {
    readonly partitions?: readonly string[];
    readonly effects?: EffectMatcher;
  };
  readonly directiveSource?: MaybeSource<string>;
  readonly beforeStopChecks: readonly Check<any>[];

  constructor(opts: {
    readonly idOrSource: string | Source<ScopedRule>;
    readonly predicate?: {
      readonly partitions?: readonly string[];
      readonly effects?: EffectMatcher;
    };
    readonly directiveSource?: MaybeSource<string>;
    readonly beforeStopChecks: readonly Check<any>[];
  }) {
    this.idOrSource = opts.idOrSource;
    this.predicate = opts.predicate;
    this.directiveSource = opts.directiveSource;
    this.beforeStopChecks = opts.beforeStopChecks;
  }

  when(predicate: {
    readonly partitions?: readonly string[];
    readonly effects?: EffectMatcher;
  }): ScopedRuleDef {
    return new ScopedRuleDefImpl({
      idOrSource: this.idOrSource,
      predicate,
      directiveSource: this.directiveSource,
      beforeStopChecks: this.beforeStopChecks,
    });
  }

  directive(textOrSource: MaybeSource<string>): ScopedRuleDef {
    return new ScopedRuleDefImpl({
      idOrSource: this.idOrSource,
      predicate: this.predicate,
      directiveSource: textOrSource,
      beforeStopChecks: this.beforeStopChecks,
    });
  }

  enforceBeforeStop(...checks: Check<any>[]): ScopedRuleDef {
    return new ScopedRuleDefImpl({
      idOrSource: this.idOrSource,
      predicate: this.predicate,
      directiveSource: this.directiveSource,
      beforeStopChecks: [...this.beforeStopChecks, ...checks],
    });
  }
}

class RulesDefImpl implements RulesDef {
  readonly kind = 'harness:rules' as const;
  readonly id: string;
  readonly globalSources: readonly MaybeSource<GlobalRule | readonly GlobalRule[]>[];
  readonly scopedEntries: ReadonlyArray<MaybeSource<ScopedRule | readonly ScopedRule[]> | ScopedRuleDef>;

  constructor(opts: {
    readonly id: string;
    readonly globalSources: readonly MaybeSource<GlobalRule | readonly GlobalRule[]>[];
    readonly scopedEntries: ReadonlyArray<MaybeSource<ScopedRule | readonly ScopedRule[]> | ScopedRuleDef>;
  }) {
    this.id = opts.id;
    this.globalSources = opts.globalSources;
    this.scopedEntries = opts.scopedEntries;
  }

  global(...sources: MaybeSource<GlobalRule | readonly GlobalRule[]>[]): RulesDef {
    return new RulesDefImpl({
      id: this.id,
      globalSources: [...this.globalSources, ...sources],
      scopedEntries: this.scopedEntries,
    });
  }

  scoped(...entries: Array<MaybeSource<ScopedRule | readonly ScopedRule[]> | ScopedRuleDef>): RulesDef {
    return new RulesDefImpl({
      id: this.id,
      globalSources: this.globalSources,
      scopedEntries: [...this.scopedEntries, ...entries],
    });
  }
}

class SkillDefImpl implements SkillDef {
  readonly kind = 'harness:skill' as const;
  readonly idOrSource: string | Source<SkillDefinition>;
  readonly predicate?: {
    readonly partitions?: readonly string[];
    readonly effects?: EffectMatcher;
  };
  readonly descriptionText?: string;
  readonly instructionSource?: MaybeSource<string>;
  readonly unlockedTools: readonly ToolDefinition<any>[];
  readonly unlockedServices: readonly Service<any>[];
  readonly leaseMode: 'until-completed-or-fork-exit';

  constructor(opts: {
    readonly idOrSource: string | Source<SkillDefinition>;
    readonly predicate?: {
      readonly partitions?: readonly string[];
      readonly effects?: EffectMatcher;
    };
    readonly descriptionText?: string;
    readonly instructionSource?: MaybeSource<string>;
    readonly unlockedTools: readonly ToolDefinition<any>[];
    readonly unlockedServices: readonly Service<any>[];
    readonly leaseMode: 'until-completed-or-fork-exit';
  }) {
    this.idOrSource = opts.idOrSource;
    this.predicate = opts.predicate;
    this.descriptionText = opts.descriptionText;
    this.instructionSource = opts.instructionSource;
    this.unlockedTools = opts.unlockedTools;
    this.unlockedServices = opts.unlockedServices;
    this.leaseMode = opts.leaseMode;
  }

  when(predicate: {
    readonly partitions?: readonly string[];
    readonly effects?: EffectMatcher;
  }): SkillDef {
    return new SkillDefImpl({
      idOrSource: this.idOrSource,
      predicate,
      descriptionText: this.descriptionText,
      instructionSource: this.instructionSource,
      unlockedTools: this.unlockedTools,
      unlockedServices: this.unlockedServices,
      leaseMode: this.leaseMode,
    });
  }

  description(text: string): SkillDef {
    return new SkillDefImpl({
      idOrSource: this.idOrSource,
      predicate: this.predicate,
      descriptionText: text,
      instructionSource: this.instructionSource,
      unlockedTools: this.unlockedTools,
      unlockedServices: this.unlockedServices,
      leaseMode: this.leaseMode,
    });
  }

  instructions(textOrSource: MaybeSource<string>): SkillDef {
    return new SkillDefImpl({
      idOrSource: this.idOrSource,
      predicate: this.predicate,
      descriptionText: this.descriptionText,
      instructionSource: textOrSource,
      unlockedTools: this.unlockedTools,
      unlockedServices: this.unlockedServices,
      leaseMode: this.leaseMode,
    });
  }

  unlocksTools(...tools: Array<ToolDefinition<any> | readonly ToolDefinition<any>[]>): SkillDef {
    return new SkillDefImpl({
      idOrSource: this.idOrSource,
      predicate: this.predicate,
      descriptionText: this.descriptionText,
      instructionSource: this.instructionSource,
      unlockedTools: [...this.unlockedTools, ...flattenTools(tools)],
      unlockedServices: this.unlockedServices,
      leaseMode: this.leaseMode,
    });
  }

  unlocksServices(...services: Service<any>[]): SkillDef {
    return new SkillDefImpl({
      idOrSource: this.idOrSource,
      predicate: this.predicate,
      descriptionText: this.descriptionText,
      instructionSource: this.instructionSource,
      unlockedTools: this.unlockedTools,
      unlockedServices: [...this.unlockedServices, ...services],
      leaseMode: this.leaseMode,
    });
  }

  lease(mode: 'until-completed-or-fork-exit'): SkillDef {
    return new SkillDefImpl({
      idOrSource: this.idOrSource,
      predicate: this.predicate,
      descriptionText: this.descriptionText,
      instructionSource: this.instructionSource,
      unlockedTools: this.unlockedTools,
      unlockedServices: this.unlockedServices,
      leaseMode: mode,
    });
  }
}

class LessonDistillBuilderImpl implements LessonDistillBuilder {
  private loopRec = false;
  private gateRec = false;
  private minFailed = 1;
  private guideSource?: MaybeSource<string>;

  onLoopRecovery(): LessonDistillBuilder {
    this.loopRec = true;
    return this;
  }

  onGateRecovery(opts?: { readonly minFailedChecks?: number }): LessonDistillBuilder {
    this.gateRec = true;
    this.minFailed = opts?.minFailedChecks ?? 1;
    return this;
  }

  guidelines(source: MaybeSource<string>): LessonDistillBuilder {
    this.guideSource = source;
    return this;
  }

  buildConfig(model: unknown): LessonDistillConfig {
    return {
      model,
      onLoopRecovery: this.loopRec,
      onGateRecovery: this.gateRec,
      minFailedChecks: this.minFailed,
      guidelinesSource: this.guideSource,
    };
  }
}

class LessonScoringBuilderImpl implements LessonScoringBuilder {
  private windowCount: number;
  private boost: number;
  private gamma: number;
  private minScoreVal: number;
  private maxItemsVal: number;

  constructor(base: LessonScoringConfig) {
    this.windowCount = base.slidingWindowInjections;
    this.boost = base.partitionMatchBoost;
    this.gamma = base.decayOnPartitionEpochChange;
    this.minScoreVal = base.minScore;
    this.maxItemsVal = base.maxItems;
  }

  slidingWindowInjections(count: number): LessonScoringBuilder {
    this.windowCount = count;
    return this;
  }

  partitionMatchBoost(boost: number): LessonScoringBuilder {
    this.boost = boost;
    return this;
  }

  decayOnPartitionEpochChange(gamma: number): LessonScoringBuilder {
    this.gamma = gamma;
    return this;
  }

  recall(opts: { readonly minScore: number; readonly maxItems: number }): LessonScoringBuilder {
    this.minScoreVal = opts.minScore;
    this.maxItemsVal = opts.maxItems;
    return this;
  }

  buildConfig(): LessonScoringConfig {
    return {
      slidingWindowInjections: this.windowCount,
      partitionMatchBoost: this.boost,
      decayOnPartitionEpochChange: this.gamma,
      minScore: this.minScoreVal,
      maxItems: this.maxItemsVal,
    };
  }
}

class LessonRetireBuilderImpl implements LessonRetireBuilder {
  private maxViolationsVal?: number;
  private minRateVal?: number;
  private afterInjVal?: number;

  maxViolations(count: number): LessonRetireBuilder {
    this.maxViolationsVal = count;
    return this;
  }

  orMinCleanPassRate(minRate: number, opts: { readonly afterInjections: number }): LessonRetireBuilder {
    this.minRateVal = minRate;
    this.afterInjVal = opts.afterInjections;
    return this;
  }

  buildConfig(): LessonRetireConfig {
    return {
      maxViolations: this.maxViolationsVal,
      minCleanPassRate: this.minRateVal,
      afterInjections: this.afterInjVal,
    };
  }
}

class LessonEmitSignalBuilderImpl implements LessonEmitSignalBuilder {
  private minClean = 1;
  private maxViol = 0;
  private cooldown = 24;

  minCleanPasses(count: number): LessonEmitSignalBuilder {
    this.minClean = count;
    return this;
  }

  maxViolations(count: number): LessonEmitSignalBuilder {
    this.maxViol = count;
    return this;
  }

  cooldownHours(hours: number): LessonEmitSignalBuilder {
    this.cooldown = hours;
    return this;
  }

  buildConfig<TPayload>(
    signal: SignalDef<TPayload>,
    mapper: (lesson: LessonRecord) => TPayload,
  ): LessonSignalTriggerConfig<TPayload> {
    return {
      signal,
      minCleanPasses: this.minClean,
      maxViolations: this.maxViol,
      cooldownHours: this.cooldown,
      mapper,
    };
  }
}

const DEFAULT_LESSON_SCORING: LessonScoringConfig = {
  slidingWindowInjections: 20,
  partitionMatchBoost: 0.25,
  decayOnPartitionEpochChange: 0.85,
  minScore: 0.2,
  maxItems: 5,
};

class LessonsDefImpl<TIn> implements LessonsDef<TIn> {
  readonly kind = 'harness:lessons' as const;
  readonly id: string;
  readonly lessonStore?: LessonStore;
  readonly querySchema?: z.ZodType<TIn, z.ZodTypeDef, unknown>;
  readonly queryExtractor?: (input: TIn) => string;
  readonly distillConfig?: LessonDistillConfig;
  readonly scoringConfig: LessonScoringConfig;
  readonly retireConfig?: LessonRetireConfig;
  readonly signalTriggers: readonly LessonSignalTriggerConfig<any>[];

  constructor(opts: {
    readonly id: string;
    readonly lessonStore?: LessonStore;
    readonly querySchema?: z.ZodType<TIn, z.ZodTypeDef, unknown>;
    readonly queryExtractor?: (input: TIn) => string;
    readonly distillConfig?: LessonDistillConfig;
    readonly scoringConfig: LessonScoringConfig;
    readonly retireConfig?: LessonRetireConfig;
    readonly signalTriggers: readonly LessonSignalTriggerConfig<any>[];
  }) {
    this.id = opts.id;
    this.lessonStore = opts.lessonStore;
    this.querySchema = opts.querySchema;
    this.queryExtractor = opts.queryExtractor;
    this.distillConfig = opts.distillConfig;
    this.scoringConfig = opts.scoringConfig;
    this.retireConfig = opts.retireConfig;
    this.signalTriggers = opts.signalTriggers;
  }

  store(store: LessonStore): LessonsDef<TIn> {
    return new LessonsDefImpl<TIn>({
      id: this.id,
      lessonStore: store,
      querySchema: this.querySchema,
      queryExtractor: this.queryExtractor,
      distillConfig: this.distillConfig,
      scoringConfig: this.scoringConfig,
      retireConfig: this.retireConfig,
      signalTriggers: this.signalTriggers,
    });
  }

  queryFrom<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    extractor: (input: z.infer<TSchema>) => string,
  ): LessonsDef<z.infer<TSchema>> {
    assertSyncCallback(extractor, 'H.lessons.queryFrom');
    return new LessonsDefImpl<z.infer<TSchema>>({
      id: this.id,
      lessonStore: this.lessonStore,
      querySchema: schema,
      queryExtractor: extractor,
      distillConfig: this.distillConfig,
      scoringConfig: this.scoringConfig,
      retireConfig: this.retireConfig,
      signalTriggers: this.signalTriggers,
    });
  }

  distillWith(
    model: unknown,
    configure: ($d: LessonDistillBuilder) => LessonDistillBuilder,
  ): LessonsDef<TIn> {
    assertSyncCallback(configure, 'H.lessons.distillWith');
    const builder = new LessonDistillBuilderImpl();
    configure(builder);
    return new LessonsDefImpl<TIn>({
      id: this.id,
      lessonStore: this.lessonStore,
      querySchema: this.querySchema,
      queryExtractor: this.queryExtractor,
      distillConfig: builder.buildConfig(model),
      scoringConfig: this.scoringConfig,
      retireConfig: this.retireConfig,
      signalTriggers: this.signalTriggers,
    });
  }

  scoring(configure: ($s: LessonScoringBuilder) => LessonScoringBuilder): LessonsDef<TIn> {
    assertSyncCallback(configure, 'H.lessons.scoring');
    const builder = new LessonScoringBuilderImpl(this.scoringConfig);
    configure(builder);
    return new LessonsDefImpl<TIn>({
      id: this.id,
      lessonStore: this.lessonStore,
      querySchema: this.querySchema,
      queryExtractor: this.queryExtractor,
      distillConfig: this.distillConfig,
      scoringConfig: builder.buildConfig(),
      retireConfig: this.retireConfig,
      signalTriggers: this.signalTriggers,
    });
  }

  retireAfter(configure: ($r: LessonRetireBuilder) => LessonRetireBuilder): LessonsDef<TIn> {
    assertSyncCallback(configure, 'H.lessons.retireAfter');
    const builder = new LessonRetireBuilderImpl();
    configure(builder);
    return new LessonsDefImpl<TIn>({
      id: this.id,
      lessonStore: this.lessonStore,
      querySchema: this.querySchema,
      queryExtractor: this.queryExtractor,
      distillConfig: this.distillConfig,
      scoringConfig: this.scoringConfig,
      retireConfig: builder.buildConfig(),
      signalTriggers: this.signalTriggers,
    });
  }

  emitSignalWhen<TPayload>(
    signal: SignalDef<TPayload>,
    configure: ($t: LessonEmitSignalBuilder) => LessonEmitSignalBuilder,
    mapper: (lesson: LessonRecord) => TPayload,
  ): LessonsDef<TIn> {
    assertSyncCallback(configure, 'H.lessons.emitSignalWhen.configure');
    assertSyncCallback(mapper, 'H.lessons.emitSignalWhen.mapper');
    const builder = new LessonEmitSignalBuilderImpl();
    configure(builder);
    return new LessonsDefImpl<TIn>({
      id: this.id,
      lessonStore: this.lessonStore,
      querySchema: this.querySchema,
      queryExtractor: this.queryExtractor,
      distillConfig: this.distillConfig,
      scoringConfig: this.scoringConfig,
      retireConfig: this.retireConfig,
      signalTriggers: [...this.signalTriggers, builder.buildConfig(signal, mapper)],
    });
  }
}

class LimitExceededBuilderImpl implements LimitExceededBuilder {
  private flushIntr?: InterruptDef<any>;
  private hook?: AbortHook<any, any>;

  flushWithInterrupt(interrupt: InterruptDef<any>): LimitExceededBuilder {
    this.flushIntr = interrupt;
    return this;
  }

  onAbort(hook: AbortHook<any, any>): LimitExceededBuilder {
    this.hook = hook;
    return this;
  }

  buildConfig(): LimitExceededConfig {
    return {
      flushInterrupt: this.flushIntr,
      abortHook: this.hook,
    };
  }
}

class PolicyDefImpl implements PolicyDef {
  readonly kind = 'harness:policy' as const;
  readonly id: string;
  readonly guardClauses: readonly PolicyGuardClauseConfig<any>[];
  readonly tripwires: readonly QuotaTripwire[];
  readonly maxTurnsLimit?: number;
  readonly maxCostUsdLimit?: number;
  readonly maxDurationSecondsLimit?: number;
  readonly abortHook?: AbortHook<any, any>;
  readonly limitExceededConfig?: LimitExceededConfig;

  constructor(opts: {
    readonly id: string;
    readonly guardClauses: readonly PolicyGuardClauseConfig<any>[];
    readonly tripwires: readonly QuotaTripwire[];
    readonly maxTurnsLimit?: number;
    readonly maxCostUsdLimit?: number;
    readonly maxDurationSecondsLimit?: number;
    readonly abortHook?: AbortHook<any, any>;
    readonly limitExceededConfig?: LimitExceededConfig;
  }) {
    this.id = opts.id;
    this.guardClauses = opts.guardClauses;
    this.tripwires = opts.tripwires;
    this.maxTurnsLimit = opts.maxTurnsLimit;
    this.maxCostUsdLimit = opts.maxCostUsdLimit;
    this.maxDurationSecondsLimit = opts.maxDurationSecondsLimit;
    this.abortHook = opts.abortHook;
    this.limitExceededConfig = opts.limitExceededConfig;
  }

  guard(...guards: PolicyGuard[]): PolicyGuardChainBuilder {
    const policy = this;
    const clauseId = `${this.id}:clause-${this.guardClauses.length + 1}`;
    const builder: PolicyGuardChainBuilder = {
      onViolation<TPayload>(
        mode: 'deny-with-error' | 'raise-interrupt',
        secondArg?: ((violation: PolicyViolation) => string) | InterruptDef<TPayload>,
        thirdArg?: (violation: PolicyViolation) => TPayload,
      ): PolicyDef {
        if (mode === 'deny-with-error') {
          const messageMapper = typeof secondArg === 'function' ? secondArg : undefined;
          assertSyncCallback(messageMapper, 'H.policy.guard.onViolation');
          const clause: PolicyGuardClauseConfig<never> = {
            id: clauseId,
            guards: [...guards],
            mode: 'deny-with-error',
            messageMapper,
          };
          return new PolicyDefImpl({
            id: policy.id,
            guardClauses: [...policy.guardClauses, clause],
            tripwires: policy.tripwires,
            maxTurnsLimit: policy.maxTurnsLimit,
            maxCostUsdLimit: policy.maxCostUsdLimit,
            maxDurationSecondsLimit: policy.maxDurationSecondsLimit,
            abortHook: policy.abortHook,
            limitExceededConfig: policy.limitExceededConfig,
          });
        }

        assertSyncCallback(thirdArg, 'H.policy.guard.onViolation');
        const interrupt = typeof secondArg === 'object' && secondArg !== null ? secondArg : undefined;
        const clause: PolicyGuardClauseConfig<TPayload> = {
          id: clauseId,
          guards: [...guards],
          mode: 'raise-interrupt',
          interrupt,
          interruptMapper: thirdArg,
        };
        return new PolicyDefImpl({
          id: policy.id,
          guardClauses: [...policy.guardClauses, clause],
          tripwires: policy.tripwires,
          maxTurnsLimit: policy.maxTurnsLimit,
          maxCostUsdLimit: policy.maxCostUsdLimit,
          maxDurationSecondsLimit: policy.maxDurationSecondsLimit,
          abortHook: policy.abortHook,
          limitExceededConfig: policy.limitExceededConfig,
        });
      },
    };
    return builder;
  }

  tripwire(...tripwires: QuotaTripwire[]): PolicyDef {
    return new PolicyDefImpl({
      id: this.id,
      guardClauses: this.guardClauses,
      tripwires: [...this.tripwires, ...tripwires],
      maxTurnsLimit: this.maxTurnsLimit,
      maxCostUsdLimit: this.maxCostUsdLimit,
      maxDurationSecondsLimit: this.maxDurationSecondsLimit,
      abortHook: this.abortHook,
      limitExceededConfig: this.limitExceededConfig,
    });
  }

  maxTurns(turns: number): PolicyDef {
    return new PolicyDefImpl({
      id: this.id,
      guardClauses: this.guardClauses,
      tripwires: this.tripwires,
      maxTurnsLimit: turns,
      maxCostUsdLimit: this.maxCostUsdLimit,
      maxDurationSecondsLimit: this.maxDurationSecondsLimit,
      abortHook: this.abortHook,
      limitExceededConfig: this.limitExceededConfig,
    });
  }

  maxCostUsd(costUsd: number): PolicyDef {
    return new PolicyDefImpl({
      id: this.id,
      guardClauses: this.guardClauses,
      tripwires: this.tripwires,
      maxTurnsLimit: this.maxTurnsLimit,
      maxCostUsdLimit: costUsd,
      maxDurationSecondsLimit: this.maxDurationSecondsLimit,
      abortHook: this.abortHook,
      limitExceededConfig: this.limitExceededConfig,
    });
  }

  maxDurationSeconds(seconds: number): PolicyDef {
    return new PolicyDefImpl({
      id: this.id,
      guardClauses: this.guardClauses,
      tripwires: this.tripwires,
      maxTurnsLimit: this.maxTurnsLimit,
      maxCostUsdLimit: this.maxCostUsdLimit,
      maxDurationSecondsLimit: seconds,
      abortHook: this.abortHook,
      limitExceededConfig: this.limitExceededConfig,
    });
  }

  onAbort(hook: AbortHook<any, any>): PolicyDef {
    return new PolicyDefImpl({
      id: this.id,
      guardClauses: this.guardClauses,
      tripwires: this.tripwires,
      maxTurnsLimit: this.maxTurnsLimit,
      maxCostUsdLimit: this.maxCostUsdLimit,
      maxDurationSecondsLimit: this.maxDurationSecondsLimit,
      abortHook: hook,
      limitExceededConfig: this.limitExceededConfig,
    });
  }

  onLimitExceeded(configure: ($l: LimitExceededBuilder) => LimitExceededBuilder): PolicyDef {
    assertSyncCallback(configure, 'H.policy.onLimitExceeded');
    const builder = new LimitExceededBuilderImpl();
    configure(builder);
    return new PolicyDefImpl({
      id: this.id,
      guardClauses: this.guardClauses,
      tripwires: this.tripwires,
      maxTurnsLimit: this.maxTurnsLimit,
      maxCostUsdLimit: this.maxCostUsdLimit,
      maxDurationSecondsLimit: this.maxDurationSecondsLimit,
      abortHook: this.abortHook,
      limitExceededConfig: builder.buildConfig(),
    });
  }

  extend(newId: string): PolicyDef {
    return new PolicyDefImpl({
      id: newId,
      guardClauses: [...this.guardClauses],
      tripwires: [...this.tripwires],
      maxTurnsLimit: this.maxTurnsLimit,
      maxCostUsdLimit: this.maxCostUsdLimit,
      maxDurationSecondsLimit: this.maxDurationSecondsLimit,
      abortHook: this.abortHook,
      limitExceededConfig: this.limitExceededConfig ? { ...this.limitExceededConfig } : undefined,
    });
  }
}

class ForkModelRoutingBuilderImpl<TIn, TReq> implements ForkModelRoutingBuilder<TIn, TReq> {
  private effortVal?: 'low' | 'medium' | 'high';
  private whenFn?: (parentInput: TIn, req: TReq) => boolean;
  private poolVal?: unknown;

  inheritParentWithEffort(
    effort: 'low' | 'medium' | 'high',
    opts: { readonly when: (parentInput: TIn, req: TReq) => boolean },
  ): ForkModelRoutingBuilder<TIn, TReq> {
    assertSyncCallback(opts.when, 'H.agent.capabilities.fork.modelRouting.when');
    this.effortVal = effort;
    this.whenFn = opts.when;
    return this;
  }

  otherwisePool(pool: unknown): ForkModelRoutingBuilder<TIn, TReq> {
    this.poolVal = pool;
    return this;
  }

  buildConfig(): ForkModelRoutingConfig<TIn, TReq> {
    return {
      inheritEffort: this.effortVal,
      inheritWhen: this.whenFn,
      fallbackPool: this.poolVal,
    };
  }
}

class ForkCapabilityBuilderImpl<TIn, TChildIn, TReq> implements ForkCapabilityBuilder<TIn, TChildIn, TReq> {
  private readonly toolName: string;
  private readonly childExecutable: StepExecutable<TChildIn, any, any>;
  private modeVal: 'shared-prefix-only' | 'clone-transcript' = 'shared-prefix-only';
  private reqSchema?: z.ZodType<any, z.ZodTypeDef, any>;
  private mapperFn?: (parentInput: TIn, req: any) => TChildIn;
  private routingCfg?: ForkModelRoutingConfig<TIn, any>;

  constructor(toolName: string, childExecutable: StepExecutable<TChildIn, any, any>) {
    this.toolName = toolName;
    this.childExecutable = childExecutable;
  }

  historyMode(mode: 'shared-prefix-only' | 'clone-transcript'): ForkCapabilityBuilder<TIn, TChildIn, TReq> {
    this.modeVal = mode;
    return this;
  }

  requestSchema<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
  ): ForkCapabilityBuilder<TIn, TChildIn, z.infer<TSchema>> {
    this.reqSchema = schema;
    return this;
  }

  mapInput(
    mapper: (parentInput: TIn, req: TReq) => TChildIn,
  ): ForkCapabilityBuilder<TIn, TChildIn, TReq> {
    assertSyncCallback(mapper, 'H.agent.capabilities.fork.mapInput');
    this.mapperFn = mapper;
    return this;
  }

  modelRouting(
    configure: ($m: ForkModelRoutingBuilder<TIn, TReq>) => ForkModelRoutingBuilder<TIn, TReq>,
  ): ForkCapabilityBuilder<TIn, TChildIn, TReq> {
    assertSyncCallback(configure, 'H.agent.capabilities.fork.modelRouting');
    const builder = new ForkModelRoutingBuilderImpl<TIn, TReq>();
    configure(builder);
    this.routingCfg = builder.buildConfig();
    return this;
  }

  buildConfig(): ForkCapabilityConfig<TIn, TChildIn, TReq> {
    return {
      toolName: this.toolName,
      childExecutable: this.childExecutable,
      historyMode: this.modeVal,
      requestSchema: this.reqSchema,
      mapInput: this.mapperFn,
      modelRoutingConfig: this.routingCfg,
    };
  }
}

class SpeculateCapabilityBuilderImpl implements SpeculateCapabilityBuilder<any, any, any, any, any, any> {
  private readonly toolName: string;
  private reqSchema?: z.ZodType<any, z.ZodTypeDef, any>;
  private workerExec?: StepExecutable<any, any, any>;
  private countVal = 2;
  private branchesMap?: (parentInput: any, req: any) => readonly any[];
  private singleVerifier?: {
    readonly evaluator: StepExecutable<any, any, any>;
    readonly mapInput?: (branchInput: any, branchOutput: any, scopeReceipt: any) => any;
    readonly acceptWhen?: (evalOut: any) => boolean;
  };
  private crossVer?: CrossVerifier<any, any, any>;
  private arbiterCfg?: {
    readonly arbiterAgent: StepExecutable<any, any, any>;
    readonly resolveDecision: (verdict: any) => ArbiterDecision;
  };
  private refineCfg?: {
    readonly predicate: (verdict: any) => boolean;
    readonly refinementExecutable: StepExecutable<any, any, any>;
    readonly mapper: (parentInput: any, verdict: any, candidates: ReadonlyArray<any>) => any;
  };

  constructor(toolName: string) {
    this.toolName = toolName;
  }

  requestSchema<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
  ): SpeculateCapabilityBuilder<any, z.infer<TSchema>, any, any, any, any> {
    this.reqSchema = schema;
    return this;
  }

  worker<TWIn, TWOut, TH>(
    executable: StepExecutable<TWIn, TWOut, TH>,
  ): SpeculateCapabilityBuilder<any, any, TWIn, TWOut, TH, any> {
    this.workerExec = executable;
    return this;
  }

  branches(
    count: number,
    mapper: (parentInput: any, req: any) => readonly any[],
  ): SpeculateCapabilityBuilder<any, any, any, any, any, any> {
    assertSyncCallback(mapper, 'H.agent.capabilities.speculate.branches');
    this.countVal = count;
    this.branchesMap = mapper;
    return this;
  }

  verifyWinnerWith<TEvalIn, TEvalOut>(
    evaluator: StepExecutable<TEvalIn, TEvalOut, any>,
    opts?: {
      readonly mapInput: (branchInput: any, branchOutput: any, scopeReceipt: any) => TEvalIn;
      readonly acceptWhen: (evalOut: TEvalOut) => boolean;
    },
  ): SpeculateCapabilityBuilder<any, any, any, any, any, any> {
    if (opts) {
      assertSyncCallback(opts.mapInput, 'H.agent.capabilities.speculate.verifyWinnerWith.mapInput');
      assertSyncCallback(opts.acceptWhen, 'H.agent.capabilities.speculate.verifyWinnerWith.acceptWhen');
    }
    this.singleVerifier = {
      evaluator,
      mapInput: opts?.mapInput,
      acceptWhen: opts?.acceptWhen,
    };
    return this;
  }

  crossVerifyWith(
    verifier: CrossVerifier<any, any, any>,
  ): SpeculateCapabilityBuilder<any, any, any, any, any, any> {
    this.crossVer = verifier;
    return this;
  }

  arbiter<TArbIn, TArbOut extends ArbiterDecision>(
    arbiterAgent: StepExecutable<TArbIn, TArbOut, any>,
    opts: {
      readonly resolveDecision: (verdict: TArbOut) => ArbiterDecision;
    },
  ): SpeculateCapabilityBuilder<any, any, any, any, any, TArbOut> {
    assertSyncCallback(opts.resolveDecision, 'H.agent.capabilities.speculate.arbiter.resolveDecision');
    this.arbiterCfg = {
      arbiterAgent,
      resolveDecision: opts.resolveDecision,
    };
    return this;
  }

  refineWinnerWhen(
    predicate: (verdict: any) => boolean,
    refinementExecutable: StepExecutable<any, any, any>,
    mapper: (parentInput: any, verdict: any, candidates: ReadonlyArray<any>) => any,
  ): SpeculateCapabilityBuilder<any, any, any, any, any, any> {
    assertSyncCallback(predicate, 'H.agent.capabilities.speculate.refineWinnerWhen.predicate');
    assertSyncCallback(mapper, 'H.agent.capabilities.speculate.refineWinnerWhen.mapper');
    this.refineCfg = {
      predicate,
      refinementExecutable,
      mapper,
    };
    return this;
  }

  buildConfig(): SpeculateCapabilityConfig<any, any, any, any, any, any> {
    return {
      toolName: this.toolName,
      requestSchema: this.reqSchema,
      workerExecutable: this.workerExec,
      branchCount: this.countVal,
      branchesMapper: this.branchesMap,
      singleWinnerVerifier: this.singleVerifier,
      crossVerifier: this.crossVer,
      arbiterConfig: this.arbiterCfg,
      refineWinnerConfig: this.refineCfg,
    };
  }
}

class MutatePlanBuilderImpl implements MutatePlanBuilder {
  private spawnCfg?: SpawnTasksCapabilityConfig<any>;
  private allowDeps = false;
  private topology?: TopologyDef<any>;

  canSpawnTasks<TSchema extends z.ZodTypeAny>(
    itemSchema: TSchema,
    opts: {
      readonly maxSpawnedPerRun: number;
      readonly maxPrerequisiteDepth?: number;
      readonly enforcePatch?: Partial<z.infer<TSchema>>;
      readonly onPrerequisiteSpawned: 'suspend-and-yield-slot';
      readonly priorityStrategy?: 'inherit-parent-with-boost' | 'normal';
      readonly resumeWhen?:
        | 'prerequisite-exit'
        | {
            readonly signal: SignalDef<any>;
            readonly correlateBy: (sig: any) => string;
          };
    },
  ): MutatePlanBuilder {
    if (typeof opts.resumeWhen === 'object' && opts.resumeWhen !== null) {
      assertSyncCallback(
        opts.resumeWhen.correlateBy,
        'H.agent.capabilities.mutatePlan.canSpawnTasks.resumeWhen.correlateBy',
      );
    }
    this.spawnCfg = {
      itemSchema,
      maxSpawnedPerRun: opts.maxSpawnedPerRun,
      maxPrerequisiteDepth: opts.maxPrerequisiteDepth ?? 3,
      enforcePatch: opts.enforcePatch,
      onPrerequisiteSpawned: opts.onPrerequisiteSpawned,
      priorityStrategy: opts.priorityStrategy ?? 'inherit-parent-with-boost',
      resumeWhen: opts.resumeWhen ?? 'prerequisite-exit',
    };
    return this;
  }

  canAddDependencies(): MutatePlanBuilder {
    this.allowDeps = true;
    return this;
  }

  canUpdateTopologyContracts(topology: TopologyDef<any>): MutatePlanBuilder {
    this.topology = topology;
    return this;
  }

  buildConfig(): MutatePlanCapabilityConfig {
    return {
      spawnTasksConfig: this.spawnCfg,
      allowAddDependencies: this.allowDeps,
      writableTopology: this.topology,
    };
  }
}

class EscalateCapabilityBuilderImpl<TPayload, TDecision> implements EscalateCapabilityBuilder<TDecision> {
  private readonly interrupt: InterruptDef<TPayload>;
  private humanDef?: HumanDef;
  private respSchema?: z.ZodType<any, z.ZodTypeDef, any>;
  private readonly elevations: Array<{
    readonly predicate: (decision: any) => boolean;
    readonly leaseMapper: (decision: any) => LeaseDelta;
  }> = [];

  constructor(interrupt: InterruptDef<TPayload>) {
    this.interrupt = interrupt;
  }

  to(human: HumanDef): EscalateCapabilityBuilder<TDecision> {
    this.humanDef = human;
    return this;
  }

  response<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
  ): EscalateCapabilityBuilder<z.infer<TSchema>> {
    this.respSchema = schema;
    return this;
  }

  elevateLeaseWhen(
    predicate: (decision: TDecision) => boolean,
    leaseMapper: (decision: TDecision) => LeaseDelta,
  ): EscalateCapabilityBuilder<TDecision> {
    assertSyncCallback(predicate, 'H.agent.capabilities.escalate.elevateLeaseWhen.predicate');
    assertSyncCallback(leaseMapper, 'H.agent.capabilities.escalate.elevateLeaseWhen.leaseMapper');
    this.elevations.push({ predicate, leaseMapper });
    return this;
  }

  buildConfig(): EscalateCapabilityConfig<TPayload, TDecision> {
    return {
      interrupt: this.interrupt,
      human: this.humanDef,
      responseSchema: this.respSchema,
      leaseElevations: [...this.elevations],
    };
  }
}

class AgentCapabilitiesBuilderImpl<TIn, THandle> implements AgentCapabilitiesBuilder<TIn, THandle> {
  private readonly forksMap: Record<string, ForkCapabilityConfig<TIn, any, any>>;
  private readonly speculationsMap: Record<string, SpeculateCapabilityConfig<TIn, any, any, any, THandle, any>>;
  private mutateCfg?: MutatePlanCapabilityConfig;
  private readonly escalationsMap: Record<string, EscalateCapabilityConfig<any, any>>;

  constructor(base: AgentCapabilitiesConfig<TIn, THandle>) {
    this.forksMap = { ...base.forks };
    this.speculationsMap = { ...base.speculations };
    this.mutateCfg = base.mutatePlanConfig;
    this.escalationsMap = { ...base.escalations };
  }

  fork<TChildIn, TChildOut>(
    toolName: string,
    childExecutable: StepExecutable<TChildIn, TChildOut, THandle>,
    configure: ($f: ForkCapabilityBuilder<TIn, TChildIn, any>) => ForkCapabilityBuilder<TIn, TChildIn, any>,
  ): AgentCapabilitiesBuilder<TIn, THandle> {
    assertSyncCallback(configure, 'H.agent.capabilities.fork');
    const builder = new ForkCapabilityBuilderImpl<TIn, TChildIn, any>(toolName, childExecutable);
    configure(builder);
    this.forksMap[toolName] = builder.buildConfig();
    return this;
  }

  speculate(
    toolName: string,
    configure: (
      $s: SpeculateCapabilityBuilder<TIn, any, any, any, THandle, any>,
    ) => SpeculateCapabilityBuilder<TIn, any, any, any, THandle, any>,
  ): AgentCapabilitiesBuilder<TIn, THandle> {
    assertSyncCallback(configure, 'H.agent.capabilities.speculate');
    const builder = new SpeculateCapabilityBuilderImpl(toolName);
    configure(builder);
    this.speculationsMap[toolName] = builder.buildConfig();
    return this;
  }

  mutatePlan(configure: ($m: MutatePlanBuilder) => MutatePlanBuilder): AgentCapabilitiesBuilder<TIn, THandle> {
    assertSyncCallback(configure, 'H.agent.capabilities.mutatePlan');
    const builder = new MutatePlanBuilderImpl();
    configure(builder);
    this.mutateCfg = builder.buildConfig();
    return this;
  }

  escalate<TPayload>(
    interrupt: InterruptDef<TPayload>,
    configure: ($esc: EscalateCapabilityBuilder<any>) => EscalateCapabilityBuilder<any>,
  ): AgentCapabilitiesBuilder<TIn, THandle> {
    assertSyncCallback(configure, 'H.agent.capabilities.escalate');
    const builder = new EscalateCapabilityBuilderImpl<TPayload, any>(interrupt);
    configure(builder);
    this.escalationsMap[interrupt.id] = builder.buildConfig();
    return this;
  }

  buildConfig(): AgentCapabilitiesConfig<TIn, THandle> {
    return {
      forks: { ...this.forksMap },
      speculations: { ...this.speculationsMap },
      mutatePlanConfig: this.mutateCfg,
      escalations: { ...this.escalationsMap },
    };
  }
}

class ChildInterruptBuilderImpl<TPayload> implements ChildInterruptBuilder<TPayload> {
  private readonly interrupt: InterruptDef<TPayload>;
  private pauseMapper?: (payload: TPayload) => readonly string[];
  private suspend = false;

  constructor(interrupt: InterruptDef<TPayload>) {
    this.interrupt = interrupt;
  }

  pauseSiblingForksInPartitions(
    mapper: (payload: TPayload) => readonly string[],
  ): ChildInterruptBuilder<TPayload> {
    assertSyncCallback(mapper, 'H.agent.onChildInterrupt.pauseSiblingForksInPartitions');
    this.pauseMapper = mapper;
    return this;
  }

  suspendAndReturnToParent(): ChildInterruptBuilder<TPayload> {
    this.suspend = true;
    return this;
  }

  buildConfig(): ChildInterruptHandlerConfig<TPayload> {
    return {
      interrupt: this.interrupt,
      pausePartitionsMapper: this.pauseMapper,
      suspendAndReturn: this.suspend,
    };
  }
}

class NestedHumanInterruptBuilderImpl<TDecision> implements NestedHumanInterruptBuilder<TDecision> {
  private humanDef?: HumanDef;
  private respSchema?: z.ZodType<any, z.ZodTypeDef, any>;
  private readonly elevations: Array<{
    readonly predicate: (decision: any) => boolean;
    readonly leaseMapper: (decision: any) => LeaseDelta;
  }> = [];
  private feedbackFn?: (decision: any) => string;

  ask<TSchema extends z.ZodTypeAny>(
    human: HumanDef,
    responseSchema: TSchema,
  ): NestedHumanInterruptBuilder<z.infer<TSchema>> {
    this.humanDef = human;
    this.respSchema = responseSchema;
    return this;
  }

  elevateLeaseWhen(
    predicate: (decision: TDecision) => boolean,
    leaseMapper: (decision: TDecision) => LeaseDelta,
  ): NestedHumanInterruptBuilder<TDecision> {
    assertSyncCallback(predicate, 'NestedHumanInterruptBuilder.elevateLeaseWhen.predicate');
    assertSyncCallback(leaseMapper, 'NestedHumanInterruptBuilder.elevateLeaseWhen.leaseMapper');
    this.elevations.push({ predicate, leaseMapper });
    return this;
  }

  resumeWith(feedbackMapper: (decision: TDecision) => string): NestedHumanInterruptBuilder<TDecision> {
    assertSyncCallback(feedbackMapper, 'NestedHumanInterruptBuilder.resumeWith');
    this.feedbackFn = feedbackMapper;
    return this;
  }

  buildConfig(): NestedHumanInterruptConfig<TDecision> {
    return {
      human: this.humanDef,
      responseSchema: this.respSchema,
      leaseElevations: [...this.elevations],
      feedbackMapper: this.feedbackFn,
    };
  }
}

class InterruptEdgeBuilderImpl implements InterruptEdgeBuilder<any, any, any, any, any> {
  private readonly interrupt: InterruptDef<any>;
  private adjudicatorCfg?: {
    readonly adjudicator: StepExecutable<any, any, any>;
    readonly mapInput: (input: any, payload: any) => any;
  };
  private directHumanBuilder?: NestedHumanInterruptBuilderImpl<any>;
  private readonly nestedHandlers: Record<string, NestedHumanInterruptConfig<any>> = {};
  private readonly elevations: Array<{
    readonly predicate: (input: any, payload: any, verdict: any) => boolean;
    readonly leaseMapper: (input: any, payload: any, verdict: any) => LeaseDelta;
  }> = [];
  private resumeFn?: (input: any, payload: any, verdict: any) => string;
  private abortHookVal?: AbortHook<any, any>;
  private replacementCfg?: {
    readonly replacement: StepExecutable<any, any, any>;
    readonly mapInput: (
      input: any,
      payload: any,
      telemetry: UniversalStepTelemetry<any, any>,
    ) => any;
  };

  constructor(interrupt: InterruptDef<any>) {
    this.interrupt = interrupt;
  }

  adjudicateWith<TAdjIn, TAdjOut>(
    adjudicator: StepExecutable<TAdjIn, TAdjOut, any>,
    mapInput: (input: any, payload: any) => TAdjIn,
  ): InterruptEdgeBuilder<any, any, TAdjOut, any, any> {
    assertSyncCallback(mapInput, 'InterruptEdgeBuilder.adjudicateWith');
    this.adjudicatorCfg = { adjudicator, mapInput };
    return this;
  }

  ask<TSchema extends z.ZodTypeAny>(
    human: HumanDef,
    responseSchema: TSchema,
  ): NestedHumanInterruptBuilder<z.infer<TSchema>> {
    const nested = new NestedHumanInterruptBuilderImpl<z.infer<TSchema>>();
    nested.ask(human, responseSchema);
    this.directHumanBuilder = nested;
    return nested;
  }

  onInterrupt<TNestedPayload>(
    nestedInterrupt: InterruptDef<TNestedPayload>,
    configure: ($esc: NestedHumanInterruptBuilder<any>) => NestedHumanInterruptBuilder<any>,
  ): InterruptEdgeBuilder<any, any, any, any, any> {
    assertSyncCallback(configure, 'InterruptEdgeBuilder.onInterrupt');
    const nested = new NestedHumanInterruptBuilderImpl<any>();
    configure(nested);
    this.nestedHandlers[nestedInterrupt.id] = nested.buildConfig();
    return this;
  }

  elevateLeaseWhen(
    predicate: (input: any, payload: any, verdict: any) => boolean,
    leaseMapper: (input: any, payload: any, verdict: any) => LeaseDelta,
  ): InterruptEdgeBuilder<any, any, any, any, any> {
    assertSyncCallback(predicate, 'InterruptEdgeBuilder.elevateLeaseWhen.predicate');
    assertSyncCallback(leaseMapper, 'InterruptEdgeBuilder.elevateLeaseWhen.leaseMapper');
    this.elevations.push({ predicate, leaseMapper });
    return this;
  }

  resumeWith(
    feedbackMapper: (input: any, payload: any, verdict: any) => string,
  ): InterruptEdgeBuilder<any, any, any, any, any> {
    assertSyncCallback(feedbackMapper, 'InterruptEdgeBuilder.resumeWith');
    this.resumeFn = feedbackMapper;
    return this;
  }

  onAbort<TNewAbortMeta extends Record<string, unknown>>(
    hook: AbortHook<any, TNewAbortMeta>,
  ): InterruptEdgeBuilder<any, any, any, any, TNewAbortMeta> {
    this.abortHookVal = hook;
    return this;
  }

  replaceWith<TRepIn, TRepOut>(
    replacement: StepExecutable<TRepIn, TRepOut, any>,
    mapInput: (
      input: any,
      payload: any,
      telemetry: UniversalStepTelemetry<any, any>,
    ) => TRepIn,
  ): InterruptEdgeBuilder<any, any, any, any, any> {
    assertSyncCallback(mapInput, 'InterruptEdgeBuilder.replaceWith');
    this.replacementCfg = { replacement, mapInput };
    return this;
  }

  buildConfig(): InterruptEdgeConfig<any, any, any, any, any> {
    return {
      interrupt: this.interrupt,
      adjudicatorConfig: this.adjudicatorCfg,
      directHumanConfig: this.directHumanBuilder?.buildConfig(),
      nestedInterruptHandlers: { ...this.nestedHandlers },
      leaseElevations: [...this.elevations],
      resumeFeedbackMapper: this.resumeFn,
      abortHook: this.abortHookVal,
      replacementConfig: this.replacementCfg,
    };
  }
}

interface AgentDefState {
  readonly id: string;
  readonly roleKey: string;
  readonly inputSchema: z.ZodType<any, z.ZodTypeDef, any>;
  readonly outputSchema: z.ZodType<any, z.ZodTypeDef, any>;
  readonly extractPartitions?: (input: any) => readonly string[];
  readonly prefixGroupDef?: PrefixGroupDef;
  readonly modelOrPool?: unknown;
  readonly topologyDef?: TopologyDef<any>;
  readonly rulesDef?: RulesDef;
  readonly lessonsConfig?: {
    readonly lessons: LessonsDef<any>;
    readonly recordOutcomes: boolean;
  };
  readonly skillEntries: ReadonlyArray<SkillDef | MaybeSource<SkillDefinition | readonly SkillDefinition[]>>;
  readonly policyDef?: PolicyDef;
  readonly mountedTools: readonly ToolDefinition<any>[];
  readonly extraToolNames: readonly string[];
  readonly groundingSources: readonly MaybeSource<string>[];
  readonly instructionSources: readonly MaybeSource<string>[];
  readonly timeoutMins?: number;
  readonly beforeStopChecks: readonly Check<any>[];
  readonly raisableInterrupts: readonly InterruptDef<any>[];
  readonly capabilitiesConfig: AgentCapabilitiesConfig<any, any>;
  readonly childInterruptHandlers: Readonly<Record<string, ChildInterruptHandlerConfig<any>>>;
  readonly interruptHandlers: Readonly<Record<string, InterruptEdgeConfig<any, any, any, any, any>>>;
}

class AgentDefImpl<TIn, TOut, THandle> implements AgentDef<TIn, TOut, THandle> {
  readonly kind = 'harness:step-executable' as const;
  readonly id: string;
  readonly roleKey: string;
  readonly inputSchema: z.ZodType<TIn, z.ZodTypeDef, any>;
  readonly outputSchema: z.ZodType<TOut, z.ZodTypeDef, any>;
  readonly extractPartitions?: (input: TIn) => readonly string[];
  readonly prefixGroupDef?: PrefixGroupDef;
  readonly modelOrPool?: unknown;
  readonly topologyDef?: TopologyDef<any>;
  readonly rulesDef?: RulesDef;
  readonly lessonsConfig?: {
    readonly lessons: LessonsDef<any>;
    readonly recordOutcomes: boolean;
  };
  readonly skillEntries: ReadonlyArray<SkillDef | MaybeSource<SkillDefinition | readonly SkillDefinition[]>>;
  readonly policyDef?: PolicyDef;
  readonly mountedTools: readonly ToolDefinition<any>[];
  readonly groundingSources: readonly MaybeSource<string>[];
  readonly instructionSources: readonly MaybeSource<string>[];
  readonly timeoutMins?: number;
  readonly beforeStopChecks: readonly Check<any>[];
  readonly raisableInterrupts: readonly InterruptDef<any>[];
  readonly capabilitiesConfig: AgentCapabilitiesConfig<TIn, THandle>;
  readonly childInterruptHandlers: Readonly<Record<string, ChildInterruptHandlerConfig<any>>>;
  readonly interruptHandlers: Readonly<Record<string, InterruptEdgeConfig<TIn, any, any, any, any>>>;
  private readonly state: AgentDefState;

  constructor(state: AgentDefState) {
    this.state = state;
    this.id = state.id;
    this.roleKey = state.roleKey;
    this.inputSchema = state.inputSchema;
    this.outputSchema = state.outputSchema;
    this.extractPartitions = state.extractPartitions;
    this.prefixGroupDef = state.prefixGroupDef;
    this.modelOrPool = state.modelOrPool;
    this.topologyDef = state.topologyDef;
    this.rulesDef = state.rulesDef;
    this.lessonsConfig = state.lessonsConfig;
    this.skillEntries = state.skillEntries;
    this.policyDef = state.policyDef;
    this.mountedTools = state.mountedTools;
    this.groundingSources = state.groundingSources;
    this.instructionSources = state.instructionSources;
    this.timeoutMins = state.timeoutMins;
    this.beforeStopChecks = state.beforeStopChecks;
    this.raisableInterrupts = state.raisableInterrupts;
    this.capabilitiesConfig = state.capabilitiesConfig;
    this.childInterruptHandlers = state.childInterruptHandlers;
    this.interruptHandlers = state.interruptHandlers;
  }

  async execute(input: TIn, ctx: ExecutionContext<THandle>): Promise<TOut> {
    if (!registeredExecutors) {
      throw new Error(
        `Cannot execute agent '${this.id}': StepExecutors have not been registered via registerStepExecutors().`,
      );
    }
    return registeredExecutors.executeAgent(this, input, ctx);
  }

  prefixGroup(group: PrefixGroupDef): AgentDef<TIn, TOut, THandle> {
    return new AgentDefImpl<TIn, TOut, THandle>({ ...this.state, prefixGroupDef: group });
  }

  model(modelOrPool: unknown): AgentDef<TIn, TOut, THandle> {
    return new AgentDefImpl<TIn, TOut, THandle>({ ...this.state, modelOrPool });
  }

  topology(topology: TopologyDef<any>): AgentDef<TIn, TOut, THandle> {
    return new AgentDefImpl<TIn, TOut, THandle>({ ...this.state, topologyDef: topology });
  }

  rules(rules: RulesDef): AgentDef<TIn, TOut, THandle> {
    return new AgentDefImpl<TIn, TOut, THandle>({ ...this.state, rulesDef: rules });
  }

  lessons(lessons: LessonsDef<any>, opts?: { readonly recordOutcomes?: boolean }): AgentDef<TIn, TOut, THandle> {
    return new AgentDefImpl<TIn, TOut, THandle>({
      ...this.state,
      lessonsConfig: {
        lessons,
        recordOutcomes: opts?.recordOutcomes ?? true,
      },
    });
  }

  skills(
    ...skills: Array<SkillDef | MaybeSource<SkillDefinition | readonly SkillDefinition[]>>
  ): AgentDef<TIn, TOut, THandle> {
    return new AgentDefImpl<TIn, TOut, THandle>({
      ...this.state,
      skillEntries: [...this.state.skillEntries, ...skills],
    });
  }

  policy(policy: PolicyDef): AgentDef<TIn, TOut, THandle> {
    return new AgentDefImpl<TIn, TOut, THandle>({ ...this.state, policyDef: policy });
  }

  tools(...tools: Array<ToolDefinition<any> | readonly ToolDefinition<any>[]>): AgentDef<TIn, TOut, THandle> {
    return new AgentDefImpl<TIn, TOut, THandle>({
      ...this.state,
      mountedTools: [...this.state.mountedTools, ...flattenTools(tools)],
    });
  }

  grounding(...sources: MaybeSource<string>[]): AgentDef<TIn, TOut, THandle> {
    return new AgentDefImpl<TIn, TOut, THandle>({
      ...this.state,
      groundingSources: [...this.state.groundingSources, ...sources],
    });
  }

  instructions(...sources: MaybeSource<string>[]): AgentDef<TIn, TOut, THandle> {
    return new AgentDefImpl<TIn, TOut, THandle>({
      ...this.state,
      instructionSources: [...this.state.instructionSources, ...sources],
    });
  }

  timeoutMinutes(minutes: number): AgentDef<TIn, TOut, THandle> {
    return new AgentDefImpl<TIn, TOut, THandle>({ ...this.state, timeoutMins: minutes });
  }

  beforeStop(...checks: Check<any>[]): AgentDef<TIn, TOut, THandle> {
    return new AgentDefImpl<TIn, TOut, THandle>({
      ...this.state,
      beforeStopChecks: [...this.state.beforeStopChecks, ...checks],
    });
  }

  input<TSchema extends z.ZodTypeAny>(schema: TSchema): AgentDef<z.infer<TSchema>, TOut, THandle> {
    return new AgentDefImpl<z.infer<TSchema>, TOut, THandle>({
      ...this.state,
      inputSchema: schema,
    });
  }

  partitions(extractor: (input: TIn) => readonly string[]): AgentDef<TIn, TOut, THandle> {
    assertSyncCallback(extractor, 'H.agent.partitions');
    return new AgentDefImpl<TIn, TOut, THandle>({
      ...this.state,
      extractPartitions: extractor,
    });
  }

  output<TSchema extends z.ZodTypeAny>(schema: TSchema): AgentDef<TIn, z.infer<TSchema>, THandle> {
    return new AgentDefImpl<TIn, z.infer<TSchema>, THandle>({
      ...this.state,
      outputSchema: schema,
    });
  }

  canRaise(...interrupts: InterruptDef<any>[]): AgentDef<TIn, TOut, THandle> {
    return new AgentDefImpl<TIn, TOut, THandle>({
      ...this.state,
      raisableInterrupts: [...this.state.raisableInterrupts, ...interrupts],
    });
  }

  capabilities(
    configure: ($cap: AgentCapabilitiesBuilder<TIn, THandle>) => AgentCapabilitiesBuilder<TIn, THandle>,
  ): AgentDef<TIn, TOut, THandle> {
    assertSyncCallback(configure, 'H.agent.capabilities');
    const builder = new AgentCapabilitiesBuilderImpl<TIn, THandle>(this.capabilitiesConfig);
    configure(builder);
    return new AgentDefImpl<TIn, TOut, THandle>({
      ...this.state,
      capabilitiesConfig: builder.buildConfig(),
    });
  }

  onChildInterrupt<TPayload>(
    interrupt: InterruptDef<TPayload>,
    configure: ($intr: ChildInterruptBuilder<TPayload>) => ChildInterruptBuilder<TPayload>,
  ): AgentDef<TIn, TOut, THandle> {
    assertSyncCallback(configure, 'H.agent.onChildInterrupt');
    const builder = new ChildInterruptBuilderImpl<TPayload>(interrupt);
    configure(builder);
    return new AgentDefImpl<TIn, TOut, THandle>({
      ...this.state,
      childInterruptHandlers: {
        ...this.state.childInterruptHandlers,
        [interrupt.id]: builder.buildConfig(),
      },
    });
  }

  onInterrupt<TPayload>(
    interrupt: InterruptDef<TPayload>,
    configure: ($intr: InterruptEdgeBuilder<TIn, TPayload, any>) => unknown,
  ): AgentDef<TIn, TOut, THandle> {
    assertSyncCallback(configure, 'H.agent.onInterrupt');
    const builder = new InterruptEdgeBuilderImpl(interrupt);
    configure(builder);
    return new AgentDefImpl<TIn, TOut, THandle>({
      ...this.state,
      interruptHandlers: {
        ...this.state.interruptHandlers,
        [interrupt.id]: builder.buildConfig(),
      },
    });
  }

  withPolicy(newPolicy: PolicyDef): AgentDef<TIn, TOut, THandle> {
    return new AgentDefImpl<TIn, TOut, THandle>({
      ...this.state,
      policyDef: newPolicy,
    });
  }

  withTools(...extraTools: Array<ToolDefinition<any> | readonly ToolDefinition<any>[]>): AgentDef<TIn, TOut, THandle> {
    const flatExtra = flattenTools(extraTools);
    const allExtraNames = [...this.state.extraToolNames, ...flatExtra.map((t) => t.name)];
    const roleKey = allExtraNames.length > 0 ? `${this.id}+tools:${allExtraNames.join(',')}` : this.id;
    return new AgentDefImpl<TIn, TOut, THandle>({
      ...this.state,
      roleKey,
      mountedTools: [...this.state.mountedTools, ...flatExtra],
      extraToolNames: allExtraNames,
    });
  }
}

export function isAgentDef(exec: StepExecutable<any, any, any>): exec is AgentDef<any, any, any> {
  return 'capabilitiesConfig' in exec && 'mountedTools' in exec && 'roleKey' in exec;
}

export function isLoopDef(exec: StepExecutable<any, any, any>): exec is LoopDef<any, any, any> {
  return 'maxIterationsLimit' in exec && 'preserveSession' in exec && 'extraTools' in exec;
}

interface LoopDefState {
  readonly id: string;
  readonly roleKey: string;
  readonly inputSchema: z.ZodType<any, z.ZodTypeDef, any>;
  readonly outputSchema: z.ZodType<any, z.ZodTypeDef, any>;
  readonly extractPartitions?: (input: any) => readonly string[];
  readonly maxIterationsLimit: number;
  readonly preserveSession: boolean;
  readonly lessonsDef?: LessonsDef<any>;
  readonly actStep?: {
    readonly stepId: string;
    readonly actor: StepExecutable<any, any, any>;
  };
  readonly evaluateStep?: LoopEvaluateConfig<any, any, any, any, any>;
  readonly returnOutputStepId?: string;
  readonly policyOverride?: PolicyDef;
  readonly extraTools: readonly ToolDefinition<any>[];
}

class LoopDefImpl<TIn, TOut, THandle> implements LoopDef<TIn, TOut, THandle> {
  readonly kind = 'harness:step-executable' as const;
  readonly id: string;
  readonly roleKey: string;
  readonly inputSchema: z.ZodType<TIn, z.ZodTypeDef, any>;
  readonly outputSchema: z.ZodType<TOut, z.ZodTypeDef, any>;
  readonly extractPartitions?: (input: TIn) => readonly string[];
  readonly maxIterationsLimit: number;
  readonly preserveSession: boolean;
  readonly lessonsDef?: LessonsDef<any>;
  readonly actStep?: {
    readonly stepId: string;
    readonly actor: StepExecutable<TIn, any, THandle>;
  };
  readonly evaluateStep?: LoopEvaluateConfig<TIn, TOut, any, any, THandle>;
  readonly returnOutputStepId?: string;
  readonly policyOverride?: PolicyDef;
  readonly extraTools: readonly ToolDefinition<any>[];
  private readonly state: LoopDefState;

  constructor(state: LoopDefState) {
    this.state = state;
    this.id = state.id;
    this.roleKey = state.roleKey;
    this.inputSchema = state.inputSchema;
    this.outputSchema = state.outputSchema;
    this.extractPartitions = state.extractPartitions;
    this.maxIterationsLimit = state.maxIterationsLimit;
    this.preserveSession = state.preserveSession;
    this.lessonsDef = state.lessonsDef;
    this.actStep = state.actStep;
    this.evaluateStep = state.evaluateStep;
    this.returnOutputStepId = state.returnOutputStepId;
    this.policyOverride = state.policyOverride;
    this.extraTools = state.extraTools;
  }

  async execute(input: TIn, ctx: ExecutionContext<THandle>): Promise<TOut> {
    if (!registeredExecutors) {
      throw new Error(
        `Cannot execute loop '${this.id}': StepExecutors have not been registered via registerStepExecutors().`,
      );
    }
    return registeredExecutors.executeLoop(this, input, ctx);
  }

  input<TSchema extends z.ZodTypeAny>(schema: TSchema): LoopDef<z.infer<TSchema>, TOut, THandle> {
    return new LoopDefImpl<z.infer<TSchema>, TOut, THandle>({
      ...this.state,
      inputSchema: schema,
    });
  }

  output<TSchema extends z.ZodTypeAny>(schema: TSchema): LoopDef<TIn, z.infer<TSchema>, THandle> {
    return new LoopDefImpl<TIn, z.infer<TSchema>, THandle>({
      ...this.state,
      outputSchema: schema,
    });
  }

  partitions(extractor: (input: TIn) => readonly string[]): LoopDef<TIn, TOut, THandle> {
    assertSyncCallback(extractor, 'H.loop.partitions');
    return new LoopDefImpl<TIn, TOut, THandle>({
      ...this.state,
      extractPartitions: extractor,
    });
  }

  maxIterations(count: number): LoopDef<TIn, TOut, THandle> {
    return new LoopDefImpl<TIn, TOut, THandle>({
      ...this.state,
      maxIterationsLimit: count,
    });
  }

  preserveActorSession(preserve: boolean): LoopDef<TIn, TOut, THandle> {
    return new LoopDefImpl<TIn, TOut, THandle>({
      ...this.state,
      preserveSession: preserve,
    });
  }

  distillLessonsInto(lessons: LessonsDef<any>): LoopDef<TIn, TOut, THandle> {
    return new LoopDefImpl<TIn, TOut, THandle>({
      ...this.state,
      lessonsDef: lessons,
    });
  }

  act<TActOut>(
    stepId: string,
    actor: StepExecutable<TIn, TActOut, THandle>,
    configure?: ($act: unknown) => unknown,
  ): LoopDef<TIn, TOut, THandle> {
    assertSyncCallback(configure, 'H.loop.act');
    if (configure) {
      configure({});
    }
    let resolvedActor: StepExecutable<TIn, any, THandle> = actor;
    if (this.state.policyOverride && (isAgentDef(resolvedActor) || isLoopDef(resolvedActor))) {
      resolvedActor = resolvedActor.withPolicy(this.state.policyOverride);
    }
    if (this.state.extraTools.length > 0 && (isAgentDef(resolvedActor) || isLoopDef(resolvedActor))) {
      resolvedActor = resolvedActor.withTools(...this.state.extraTools);
    }
    return new LoopDefImpl<TIn, TOut, THandle>({
      ...this.state,
      actStep: {
        stepId,
        actor: resolvedActor,
      },
    });
  }

  evaluate<TEvalIn, TEvalOut>(
    stepId: string,
    evaluator: StepExecutable<TEvalIn, TEvalOut, THandle>,
    opts: {
      readonly mapInput: (loopInput: TIn, candidate: TOut, scopeReceipt: any) => TEvalIn;
      readonly acceptWhen: (evalOut: TEvalOut) => boolean;
      readonly feedbackMapper: (evalOut: TEvalOut) => string;
    },
  ): LoopDef<TIn, TOut, THandle> {
    assertSyncCallback(opts.mapInput, 'H.loop.evaluate.mapInput');
    assertSyncCallback(opts.acceptWhen, 'H.loop.evaluate.acceptWhen');
    assertSyncCallback(opts.feedbackMapper, 'H.loop.evaluate.feedbackMapper');
    return new LoopDefImpl<TIn, TOut, THandle>({
      ...this.state,
      evaluateStep: {
        stepId,
        evaluator,
        mapInput: opts.mapInput,
        acceptWhen: opts.acceptWhen,
        feedbackMapper: opts.feedbackMapper,
      },
    });
  }

  returnOutputFrom(actStepId: string): LoopDef<TIn, TOut, THandle> {
    return new LoopDefImpl<TIn, TOut, THandle>({
      ...this.state,
      returnOutputStepId: actStepId,
    });
  }

  withPolicy(newPolicy: PolicyDef): LoopDef<TIn, TOut, THandle> {
    const updatedActStep = this.state.actStep
      ? {
          stepId: this.state.actStep.stepId,
          actor:
            isAgentDef(this.state.actStep.actor) || isLoopDef(this.state.actStep.actor)
              ? this.state.actStep.actor.withPolicy(newPolicy)
              : this.state.actStep.actor,
        }
      : undefined;
    return new LoopDefImpl<TIn, TOut, THandle>({
      ...this.state,
      policyOverride: newPolicy,
      actStep: updatedActStep,
    });
  }

  withTools(...extraTools: Array<ToolDefinition<any> | readonly ToolDefinition<any>[]>): LoopDef<TIn, TOut, THandle> {
    const flatExtra = flattenTools(extraTools);
    const allExtra = [...this.state.extraTools, ...flatExtra];
    const roleKey =
      allExtra.length > 0 ? `${this.id}+tools:${allExtra.map((t) => t.name).join(',')}` : this.id;
    const updatedActStep = this.state.actStep
      ? {
          stepId: this.state.actStep.stepId,
          actor:
            isAgentDef(this.state.actStep.actor) || isLoopDef(this.state.actStep.actor)
              ? this.state.actStep.actor.withTools(...flatExtra)
              : this.state.actStep.actor,
        }
      : undefined;
    return new LoopDefImpl<TIn, TOut, THandle>({
      ...this.state,
      roleKey,
      extraTools: allExtra,
      actStep: updatedActStep,
    });
  }
}

class FlowStepBuilderImpl<
  TFlowIn,
  TStepIn,
  TSteps extends Record<string, any>,
  TReceipt,
  TCustomMetrics extends Record<string, unknown>,
> implements FlowStepBuilder<TFlowIn, TStepIn, TSteps, TReceipt, TCustomMetrics> {
  private readonly stepId: string;
  private readonly executable: StepExecutable<TStepIn, any, any>;
  private mapperFn?: (flowInput: TFlowIn, priorSteps: TSteps, scopeReceipt: TReceipt) => TStepIn;
  private readonly handlers: Record<string, InterruptEdgeConfig<TFlowIn, any, any, TCustomMetrics, any>> = {};

  constructor(stepId: string, executable: StepExecutable<TStepIn, any, any>) {
    this.stepId = stepId;
    this.executable = executable;
  }

  inputFrom(
    mapper: (flowInput: TFlowIn, priorSteps: TSteps, scopeReceipt: TReceipt) => TStepIn,
  ): FlowStepBuilder<TFlowIn, TStepIn, TSteps, TReceipt, TCustomMetrics> {
    assertSyncCallback(mapper, 'H.flow.step.inputFrom');
    this.mapperFn = mapper;
    return this;
  }

  onInterrupt<TPayload>(
    interrupt: InterruptDef<TPayload>,
    configure: (
      $intr: InterruptEdgeBuilder<TFlowIn, TPayload, any, TCustomMetrics, Record<string, unknown>>,
    ) => unknown,
  ): FlowStepBuilder<TFlowIn, TStepIn, TSteps, TReceipt, TCustomMetrics> {
    assertSyncCallback(configure, 'H.flow.step.onInterrupt');
    const builder = new InterruptEdgeBuilderImpl(interrupt);
    configure(builder);
    this.handlers[interrupt.id] = builder.buildConfig();
    return this;
  }

  buildConfig(): FlowStepNodeConfig<TFlowIn, TStepIn, TSteps, TReceipt, TCustomMetrics> {
    return {
      kind: 'step',
      stepId: this.stepId,
      executable: this.executable,
      inputMapper: this.mapperFn,
      interruptHandlers: { ...this.handlers },
    };
  }
}

class FlowSubBranchBuilderImpl<
  TFlowIn,
  TBranchOut,
  TSteps extends Record<string, any>,
  TReceipt,
  TCustomMetrics extends Record<string, unknown>,
> implements FlowSubBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics> {
  stepNode?: FlowStepNodeConfig<TFlowIn, any, TSteps, TReceipt, TCustomMetrics>;

  step<TStepIn>(
    stepId: string,
    executable: StepExecutable<TStepIn, TBranchOut, any>,
    configure?: (
      $step: FlowStepBuilder<TFlowIn, TStepIn, TSteps, TReceipt, TCustomMetrics>,
    ) => FlowStepBuilder<TFlowIn, TStepIn, TSteps, TReceipt, TCustomMetrics>,
  ): FlowSubBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics> {
    assertSyncCallback(configure, 'H.flow.branch.step');
    const builder = new FlowStepBuilderImpl<TFlowIn, TStepIn, TSteps, TReceipt, TCustomMetrics>(
      stepId,
      executable,
    );
    if (configure) {
      configure(builder);
    }
    this.stepNode = builder.buildConfig();
    return this;
  }
}

class FlowBranchBuilderImpl<
  TFlowIn,
  TBranchOut,
  TSteps extends Record<string, any>,
  TReceipt,
  TCustomMetrics extends Record<string, unknown>,
> implements FlowBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics> {
  private readonly branchStepId: string;
  outputSchema?: z.ZodType<TBranchOut, z.ZodTypeDef, any>;
  private readonly armList: Array<{
    readonly predicate?: (input: TFlowIn) => boolean;
    readonly step: FlowStepNodeConfig<TFlowIn, any, TSteps, TReceipt, TCustomMetrics>;
  }> = [];

  constructor(branchStepId: string) {
    this.branchStepId = branchStepId;
  }

  output<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
  ): FlowBranchBuilder<TFlowIn, z.infer<TSchema>, TSteps, TReceipt, TCustomMetrics> {
    this.outputSchema = schema;
    return this;
  }

  when(
    predicate: (input: TFlowIn) => boolean,
    configure: (
      $sub: FlowSubBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>,
    ) => FlowSubBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>,
  ): FlowBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics> {
    assertSyncCallback(predicate, 'H.flow.branch.when.predicate');
    assertSyncCallback(configure, 'H.flow.branch.when.configure');
    const sub = new FlowSubBranchBuilderImpl<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>();
    configure(sub);
    if (!sub.stepNode) {
      throw new Error(`Flow branch '${this.branchStepId}' .when() arm must declare a .step().`);
    }
    this.armList.push({
      predicate,
      step: sub.stepNode,
    });
    return this;
  }

  otherwise(
    configure: (
      $sub: FlowSubBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>,
    ) => FlowSubBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>,
  ): FlowBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics> {
    assertSyncCallback(configure, 'H.flow.branch.otherwise');
    const sub = new FlowSubBranchBuilderImpl<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>();
    configure(sub);
    if (!sub.stepNode) {
      throw new Error(`Flow branch '${this.branchStepId}' .otherwise() arm must declare a .step().`);
    }
    this.armList.push({
      step: sub.stepNode,
    });
    return this;
  }

  buildConfig(): FlowBranchNodeConfig<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics> {
    return {
      kind: 'branch',
      branchStepId: this.branchStepId,
      outputSchema: this.outputSchema,
      arms: [...this.armList],
    };
  }
}

function collectExecutableAgents(executable: StepExecutable<any, any, any>): AgentDef<any, any, any>[] {
  if (isAgentDef(executable)) {
    return [executable];
  }
  if (isLoopDef(executable)) {
    const out: AgentDef<any, any, any>[] = [];
    if (executable.actStep) {
      out.push(...collectExecutableAgents(executable.actStep.actor));
    }
    if (executable.evaluateStep) {
      out.push(...collectExecutableAgents(executable.evaluateStep.evaluator));
    }
    return out;
  }
  return [];
}

function validateExecutableAgainstScope(
  flowId: string,
  stepId: string,
  executable: StepExecutable<any, any, any>,
  stepInterruptHandlers: Readonly<Record<string, InterruptEdgeConfig<any, any, any, any, any>>>,
  isCheckpointable: boolean,
  isBranchable: boolean,
): void {
  const agents = collectExecutableAgents(executable);

  for (const agent of agents) {
    const hasActiveGuards =
      agent.policyDef !== undefined &&
      agent.policyDef.guardClauses.some((clause) => clause.guards.length > 0);

    if (hasActiveGuards && !isCheckpointable) {
      const skillTools: ToolDefinition<any>[] = [];
      for (const entry of agent.skillEntries) {
        if (typeof entry === 'object' && entry !== null && 'kind' in entry && entry.kind === 'harness:skill') {
          skillTools.push(...entry.unlockedTools);
        }
      }
      const allTools = [...agent.mountedTools, ...skillTools];
      for (const tool of allTools) {
        if (typeof tool.describeEffects !== 'function') {
          throw new Error(
            `Flow '${flowId}' step '${stepId}' actor '${agent.id}' mounts tool '${tool.name}' without static describeEffects() under policy '${agent.policyDef?.id}', which requires a CheckpointableScope (supportsCheckpoints: true).`,
          );
        }
      }
    }

    const usesFork = Object.keys(agent.capabilitiesConfig.forks).length > 0;
    const usesSpeculate = Object.keys(agent.capabilitiesConfig.speculations).length > 0;
    const usesSuspendSpawn =
      agent.capabilitiesConfig.mutatePlanConfig?.spawnTasksConfig?.onPrerequisiteSpawned ===
      'suspend-and-yield-slot';

    if ((usesFork || usesSpeculate || usesSuspendSpawn) && !isBranchable) {
      throw new Error(
        `Flow '${flowId}' step '${stepId}' actor '${agent.id}' uses branching capabilities (.fork, .speculate, or suspend-and-yield-slot), which requires a BranchableScope (supportsBranching: true).`,
      );
    }

    for (const forkCfg of Object.values(agent.capabilitiesConfig.forks)) {
      validateExecutableAgainstScope(
        flowId,
        `${stepId}:fork:${forkCfg.toolName}`,
        forkCfg.childExecutable,
        {},
        isCheckpointable,
        isBranchable,
      );
    }

    for (const specCfg of Object.values(agent.capabilitiesConfig.speculations)) {
      if (specCfg.workerExecutable) {
        validateExecutableAgainstScope(
          flowId,
          `${stepId}:speculate:${specCfg.toolName}`,
          specCfg.workerExecutable,
          {},
          isCheckpointable,
          isBranchable,
        );
      }
    }

    for (const edge of Object.values(agent.interruptHandlers)) {
      if (edge.replacementConfig) {
        const hasAbortHook =
          edge.abortHook !== undefined ||
          agent.policyDef?.abortHook !== undefined ||
          (agent.policyDef?.limitExceededConfig?.flushInterrupt?.id === edge.interrupt.id &&
            agent.policyDef?.limitExceededConfig?.abortHook !== undefined);
        if (!hasAbortHook && !isCheckpointable) {
          throw new Error(
            `Flow '${flowId}' step '${stepId}' actor '${agent.id}' uses .replaceWith() on interrupt '${edge.interrupt.id}' without an AbortHook, which requires a CheckpointableScope (supportsCheckpoints: true).`,
          );
        }
        validateExecutableAgainstScope(
          flowId,
          `${stepId}:replace:${edge.interrupt.id}`,
          edge.replacementConfig.replacement,
          {},
          isCheckpointable,
          isBranchable,
        );
      }
    }
  }

  const primaryPolicyAbortHook = agents.find((a) => a.policyDef?.abortHook !== undefined)?.policyDef?.abortHook;

  for (const edge of Object.values(stepInterruptHandlers)) {
    if (edge.replacementConfig) {
      const hasLimitAbortHook = agents.some(
        (a) =>
          a.policyDef?.limitExceededConfig?.flushInterrupt?.id === edge.interrupt.id &&
          a.policyDef?.limitExceededConfig?.abortHook !== undefined,
      );
      const hasAbortHook =
        edge.abortHook !== undefined || primaryPolicyAbortHook !== undefined || hasLimitAbortHook;
      if (!hasAbortHook && !isCheckpointable) {
        throw new Error(
          `Flow '${flowId}' step '${stepId}' uses .replaceWith() on interrupt '${edge.interrupt.id}' without an AbortHook, which requires a CheckpointableScope (supportsCheckpoints: true).`,
        );
      }
      validateExecutableAgainstScope(
        flowId,
        `${stepId}:replace:${edge.interrupt.id}`,
        edge.replacementConfig.replacement,
        {},
        isCheckpointable,
        isBranchable,
      );
    }
  }
}

function validateFlowScope(
  flowId: string,
  scope: IsolationScope<any, any> | undefined,
  nodes: readonly FlowNodeConfig<any, any, any, any>[],
): void {
  if (!scope) return;
  const isCheckpointable =
    ('supportsCheckpoints' in scope && scope.supportsCheckpoints === true) ||
    ('serializeCheckpoint' in scope && typeof scope.serializeCheckpoint === 'function');
  const isBranchable =
    ('supportsBranching' in scope && scope.supportsBranching === true) ||
    ('forkChild' in scope && typeof scope.forkChild === 'function');

  for (const node of nodes) {
    if (node.kind === 'step') {
      validateExecutableAgainstScope(
        flowId,
        node.stepId,
        node.executable,
        node.interruptHandlers,
        isCheckpointable,
        isBranchable,
      );
    } else {
      for (const arm of node.arms) {
        validateExecutableAgainstScope(
          flowId,
          arm.step.stepId,
          arm.step.executable,
          arm.step.interruptHandlers,
          isCheckpointable,
          isBranchable,
        );
      }
    }
  }
}

class FlowDefImpl<
  TIn,
  THandle,
  TReceipt extends Record<string, unknown>,
  TSteps extends Record<string, any>,
  TCustomMetrics extends Record<string, unknown>,
> implements FlowDef<TIn, THandle, TReceipt, TSteps, TCustomMetrics> {
  readonly kind = 'harness:flow' as const;
  readonly id: string;
  readonly inputSchema: z.ZodType<TIn, z.ZodTypeDef, any>;
  readonly isolationScope?: IsolationScope<THandle, TReceipt>;
  readonly telemetryCollector?: TelemetryCollector<TCustomMetrics>;
  readonly nodes: readonly FlowNodeConfig<TIn, any, TReceipt, TCustomMetrics>[];
  readonly terminalState?: string;
  private readonly rawNodes: readonly FlowNodeConfig<any, any, any, any>[];

  constructor(opts: {
    readonly id: string;
    readonly inputSchema: z.ZodType<TIn, z.ZodTypeDef, any>;
    readonly isolationScope?: IsolationScope<THandle, TReceipt>;
    readonly telemetryCollector?: TelemetryCollector<TCustomMetrics>;
    readonly nodes: readonly FlowNodeConfig<any, any, any, any>[];
    readonly terminalState?: string;
  }) {
    validateFlowScope(opts.id, opts.isolationScope, opts.nodes);
    this.id = opts.id;
    this.inputSchema = opts.inputSchema;
    this.isolationScope = opts.isolationScope;
    this.telemetryCollector = opts.telemetryCollector;
    this.rawNodes = opts.nodes;
    this.nodes = opts.nodes;
    this.terminalState = opts.terminalState;
  }

  input<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
  ): FlowDef<z.infer<TSchema>, THandle, TReceipt, TSteps, TCustomMetrics> {
    return new FlowDefImpl<z.infer<TSchema>, THandle, TReceipt, TSteps, TCustomMetrics>({
      id: this.id,
      inputSchema: schema,
      isolationScope: this.isolationScope,
      telemetryCollector: this.telemetryCollector,
      nodes: this.rawNodes,
      terminalState: this.terminalState,
    });
  }

  scope<TH, TR extends Record<string, unknown>>(
    scope: IsolationScope<TH, TR>,
  ): FlowDef<TIn, TH, TR, TSteps, TCustomMetrics> {
    return new FlowDefImpl<TIn, TH, TR, TSteps, TCustomMetrics>({
      id: this.id,
      inputSchema: this.inputSchema,
      isolationScope: scope,
      telemetryCollector: this.telemetryCollector,
      nodes: this.rawNodes,
      terminalState: this.terminalState,
    });
  }

  telemetry<TCustom extends Record<string, unknown>>(
    collector: TelemetryCollector<TCustom>,
  ): FlowDef<TIn, THandle, TReceipt, TSteps, TCustom> {
    return new FlowDefImpl<TIn, THandle, TReceipt, TSteps, TCustom>({
      id: this.id,
      inputSchema: this.inputSchema,
      isolationScope: this.isolationScope,
      telemetryCollector: collector,
      nodes: this.rawNodes,
      terminalState: this.terminalState,
    });
  }

  step<TStepId extends string, TStepIn, TStepOut>(
    stepId: TStepId,
    executable: StepExecutable<TStepIn, TStepOut, THandle>,
    configure?: (
      $s: FlowStepBuilder<TIn, TStepIn, TSteps, TReceipt, TCustomMetrics>,
    ) => FlowStepBuilder<TIn, TStepIn, TSteps, TReceipt, TCustomMetrics>,
  ): FlowDef<TIn, THandle, TReceipt, TSteps & Record<TStepId, TStepOut>, TCustomMetrics> {
    assertSyncCallback(configure, 'H.flow.step');
    const builder = new FlowStepBuilderImpl<TIn, TStepIn, TSteps, TReceipt, TCustomMetrics>(
      stepId,
      executable,
    );
    if (configure) {
      configure(builder);
    }
    return new FlowDefImpl<TIn, THandle, TReceipt, TSteps & Record<TStepId, TStepOut>, TCustomMetrics>({
      id: this.id,
      inputSchema: this.inputSchema,
      isolationScope: this.isolationScope,
      telemetryCollector: this.telemetryCollector,
      nodes: [...this.nodes, builder.buildConfig()],
      terminalState: this.terminalState,
    });
  }

  branch<TBranchId extends string, TBranchOut>(
    branchStepId: TBranchId,
    configure: (
      $b: FlowBranchBuilder<TIn, any, TSteps, TReceipt, TCustomMetrics>,
    ) => FlowBranchBuilder<TIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>,
  ): FlowDef<TIn, THandle, TReceipt, TSteps & Record<TBranchId, TBranchOut>, TCustomMetrics> {
    assertSyncCallback(configure, 'H.flow.branch');
    const builder = new FlowBranchBuilderImpl<TIn, any, TSteps, TReceipt, TCustomMetrics>(branchStepId);
    configure(builder);
    return new FlowDefImpl<TIn, THandle, TReceipt, TSteps & Record<TBranchId, TBranchOut>, TCustomMetrics>({
      id: this.id,
      inputSchema: this.inputSchema,
      isolationScope: this.isolationScope,
      telemetryCollector: this.telemetryCollector,
      nodes: [...this.nodes, builder.buildConfig()],
      terminalState: this.terminalState,
    });
  }

  exit(terminalState: string): FlowDef<TIn, THandle, TReceipt, TSteps, TCustomMetrics> {
    return new FlowDefImpl<TIn, THandle, TReceipt, TSteps, TCustomMetrics>({
      id: this.id,
      inputSchema: this.inputSchema,
      isolationScope: this.isolationScope,
      telemetryCollector: this.telemetryCollector,
      nodes: this.nodes,
      terminalState,
    });
  }
}

class LaneTrackerBuilderImpl<TExternal, TIn, TExternalState extends string>
  implements LaneTrackerBuilder<TExternal, TIn, TExternalState>
{
  private readonly adapter: TrackerAdapter<TExternal, TExternalState>;
  private pollSec = 60;
  private mapperFn?: (externalItem: TExternal) => TIn | undefined;
  private queuedState?: TExternalState;
  private runningState?: TExternalState;
  private waitingState?: TExternalState;
  private erroredState?: TExternalState;
  private cancelledState?: TExternalState;
  private readonly exitStates: Record<string, TExternalState> = {};

  constructor(adapter: TrackerAdapter<TExternal, TExternalState>) {
    this.adapter = adapter;
  }

  everySeconds(seconds: number): LaneTrackerBuilder<TExternal, TIn, TExternalState> {
    this.pollSec = seconds;
    return this;
  }

  from(mapper: (externalItem: TExternal) => TIn | undefined): LaneTrackerBuilder<TExternal, TIn, TExternalState> {
    assertSyncCallback(mapper, 'H.lane.tracker.from');
    this.mapperFn = mapper;
    return this;
  }

  onQueued(state: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState> {
    this.queuedState = state;
    return this;
  }

  onRunning(state: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState> {
    this.runningState = state;
    return this;
  }

  onWaiting(state: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState> {
    this.waitingState = state;
    return this;
  }

  onErrored(state: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState> {
    this.erroredState = state;
    return this;
  }

  onCancelled(state: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState> {
    this.cancelledState = state;
    return this;
  }

  onExit(terminalState: string, externalState: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState> {
    this.exitStates[terminalState] = externalState;
    return this;
  }

  buildConfig(): LaneTrackerConfig<TExternal, TIn, TExternalState> {
    return {
      adapter: this.adapter,
      pollIntervalSeconds: this.pollSec,
      mapper: this.mapperFn,
      stateMapping: {
        onQueued: this.queuedState,
        onRunning: this.runningState,
        onWaiting: this.waitingState,
        onErrored: this.erroredState,
        onCancelled: this.cancelledState,
        onExit: { ...this.exitStates },
      },
    };
  }
}

class LaneRetryBuilderImpl implements LaneRetryBuilder {
  private triesCount = 1;
  private delayMs = 1000;
  private failState = 'failed';

  tries(count: number): LaneRetryBuilder {
    this.triesCount = count;
    return this;
  }

  exponential(baseDelayMs: number): LaneRetryBuilder {
    this.delayMs = baseDelayMs;
    return this;
  }

  orFail(terminalState: string): LaneRetryBuilder {
    this.failState = terminalState;
    return this;
  }

  buildConfig(): LaneRetryConfig {
    return {
      tries: this.triesCount,
      exponentialBaseDelayMs: this.delayMs,
      failTerminalState: this.failState,
    };
  }
}

class LaneSignalBuilderImpl<TIn, TPayload> implements LaneSignalBuilder<TIn, TPayload> {
  private readonly signal: SignalDef<TPayload>;
  private updateFn?: (current: TIn, signalPayload: TPayload) => TIn;
  private rewindStep?: string;
  private rewindHook?: ScopeRewindHook<any>;

  constructor(signal: SignalDef<TPayload>) {
    this.signal = signal;
  }

  update(mapper: (current: TIn, signalPayload: TPayload) => TIn): LaneSignalBuilder<TIn, TPayload> {
    assertSyncCallback(mapper, 'H.lane.onSignal.update');
    this.updateFn = mapper;
    return this;
  }

  rewindTo(stepId: string, opts?: { readonly onRewind?: ScopeRewindHook<any> }): LaneSignalBuilder<TIn, TPayload> {
    this.rewindStep = stepId;
    this.rewindHook = opts?.onRewind;
    return this;
  }

  buildConfig(): LaneSignalHandlerConfig<TIn, TPayload> {
    return {
      signal: this.signal,
      updateMapper: this.updateFn,
      rewindToStepId: this.rewindStep,
      onRewindHook: this.rewindHook,
    };
  }
}

interface LaneDefState {
  readonly id: string;
  readonly inputSchema: z.ZodType<any, z.ZodTypeDef, any>;
  readonly keyMapper?: (item: any) => string;
  readonly trackerConfig?: LaneTrackerConfig<any, any, any>;
  readonly flowDef?: FlowDef<any, any, any, any, any>;
  readonly concurrencyLimit: number;
  readonly priorityLevel: 'low' | 'normal' | 'high' | 'critical';
  readonly agingMins?: number;
  readonly waitForConfig?: {
    readonly depsMapper: (item: any) => readonly string[];
    readonly onAbandonedState: string;
  };
  readonly maxCostConfig?: {
    readonly limitUsd: number;
    readonly approver: ScopedHumanTarget<z.infer<typeof BudgetApprovalSchema>>;
  };
  readonly retryConfig?: LaneRetryConfig;
  readonly signalHandlers: Readonly<Record<string, LaneSignalHandlerConfig<any, any>>>;
}

class LaneDefImpl<TIn> implements LaneDef<TIn> {
  readonly kind = 'harness:lane' as const;
  readonly id: string;
  readonly inputSchema: z.ZodType<TIn, z.ZodTypeDef, any>;
  readonly keyMapper?: (item: TIn) => string;
  readonly trackerConfig?: LaneTrackerConfig<any, TIn, any>;
  readonly flowDef?: FlowDef<TIn, any, any, any, any>;
  readonly concurrencyLimit: number;
  readonly priorityLevel: 'low' | 'normal' | 'high' | 'critical';
  readonly agingMins?: number;
  readonly waitForConfig?: {
    readonly depsMapper: (item: TIn) => readonly string[];
    readonly onAbandonedState: string;
  };
  readonly maxCostConfig?: {
    readonly limitUsd: number;
    readonly approver: ScopedHumanTarget<z.infer<typeof BudgetApprovalSchema>>;
  };
  readonly retryConfig?: LaneRetryConfig;
  readonly signalHandlers: Readonly<Record<string, LaneSignalHandlerConfig<TIn, any>>>;
  private readonly state: LaneDefState;

  constructor(state: LaneDefState) {
    this.state = state;
    this.id = state.id;
    this.inputSchema = state.inputSchema;
    this.keyMapper = state.keyMapper;
    this.trackerConfig = state.trackerConfig;
    this.flowDef = state.flowDef;
    this.concurrencyLimit = state.concurrencyLimit;
    this.priorityLevel = state.priorityLevel;
    this.agingMins = state.agingMins;
    this.waitForConfig = state.waitForConfig;
    this.maxCostConfig = state.maxCostConfig;
    this.retryConfig = state.retryConfig;
    this.signalHandlers = state.signalHandlers;
  }

  input<TSchema extends z.ZodTypeAny>(schema: TSchema): LaneDef<z.infer<TSchema>> {
    return new LaneDefImpl<z.infer<TSchema>>({
      ...this.state,
      inputSchema: schema,
    });
  }

  key(mapper: (item: TIn) => string): LaneDef<TIn> {
    assertSyncCallback(mapper, 'H.lane.key');
    return new LaneDefImpl<TIn>({
      ...this.state,
      keyMapper: mapper,
    });
  }

  tracker<TExternal, TExternalState extends string>(
    adapter: TrackerAdapter<TExternal, TExternalState>,
    configure: (
      $: LaneTrackerBuilder<TExternal, TIn, TExternalState>,
    ) => LaneTrackerBuilder<TExternal, TIn, TExternalState>,
  ): LaneDef<TIn> {
    assertSyncCallback(configure, 'H.lane.tracker');
    const builder = new LaneTrackerBuilderImpl<TExternal, TIn, TExternalState>(adapter);
    configure(builder);
    return new LaneDefImpl<TIn>({
      ...this.state,
      trackerConfig: builder.buildConfig(),
    });
  }

  flow(flow: FlowDef<TIn, any, any, any, any>): LaneDef<TIn> {
    return new LaneDefImpl<TIn>({
      ...this.state,
      flowDef: flow,
    });
  }

  concurrency(limit: number): LaneDef<TIn> {
    return new LaneDefImpl<TIn>({
      ...this.state,
      concurrencyLimit: limit,
    });
  }

  priority(level: 'low' | 'normal' | 'high' | 'critical'): LaneDef<TIn> {
    return new LaneDefImpl<TIn>({
      ...this.state,
      priorityLevel: level,
    });
  }

  agingMinutes(minutes: number): LaneDef<TIn> {
    return new LaneDefImpl<TIn>({
      ...this.state,
      agingMins: minutes,
    });
  }

  waitFor(depsMapper: (item: TIn) => readonly string[], onAbandonedState: string): LaneDef<TIn> {
    assertSyncCallback(depsMapper, 'H.lane.waitFor');
    return new LaneDefImpl<TIn>({
      ...this.state,
      waitForConfig: {
        depsMapper,
        onAbandonedState,
      },
    });
  }

  maxCostUsd(
    limitUsd: number,
    approver: ScopedHumanTarget<z.infer<typeof BudgetApprovalSchema>>,
  ): LaneDef<TIn> {
    return new LaneDefImpl<TIn>({
      ...this.state,
      maxCostConfig: {
        limitUsd,
        approver,
      },
    });
  }

  retry(configure: ($: LaneRetryBuilder) => LaneRetryBuilder): LaneDef<TIn> {
    assertSyncCallback(configure, 'H.lane.retry');
    const builder = new LaneRetryBuilderImpl();
    configure(builder);
    return new LaneDefImpl<TIn>({
      ...this.state,
      retryConfig: builder.buildConfig(),
    });
  }

  onSignal<TPayload>(
    signal: SignalDef<TPayload>,
    configure: ($s: LaneSignalBuilder<TIn, TPayload>) => LaneSignalBuilder<TIn, TPayload>,
  ): LaneDef<TIn> {
    assertSyncCallback(configure, 'H.lane.onSignal');
    const builder = new LaneSignalBuilderImpl<TIn, TPayload>(signal);
    configure(builder);
    return new LaneDefImpl<TIn>({
      ...this.state,
      signalHandlers: {
        ...this.state.signalHandlers,
        [signal.id]: builder.buildConfig(),
      },
    });
  }
}

class HarnessSignalBuilderImpl<TPayload> implements HarnessSignalBuilder<TPayload> {
  private readonly signal: SignalDef<TPayload>;
  private readonly notifyList: Array<{
    readonly human: HumanDef;
    readonly mapper: (sig: TPayload) => string;
  }> = [];

  constructor(signal: SignalDef<TPayload>) {
    this.signal = signal;
  }

  notify(human: HumanDef, mapper: (sig: TPayload) => string): HarnessSignalBuilder<TPayload> {
    assertSyncCallback(mapper, 'H.harness.onSignal.notify');
    this.notifyList.push({ human, mapper });
    return this;
  }

  buildConfig(): HarnessSignalHandlerConfig<TPayload> {
    return {
      signal: this.signal,
      notifications: [...this.notifyList],
    };
  }
}

class HarnessDefImpl implements HarnessDef {
  readonly kind = 'harness:root' as const;
  readonly id: string;
  readonly ledgerStore?: LedgerStore;
  readonly registeredPools: readonly unknown[];
  readonly registeredStreams: readonly StreamDef<any, any>[];
  readonly registeredLanes: readonly LaneDef<any>[];
  readonly signalHandlers: Readonly<Record<string, HarnessSignalHandlerConfig<any>>>;
  readonly controlPlaneAdapters: readonly ControlPlaneAdapter[];

  constructor(opts: {
    readonly id: string;
    readonly ledgerStore?: LedgerStore;
    readonly registeredPools: readonly unknown[];
    readonly registeredStreams: readonly StreamDef<any, any>[];
    readonly registeredLanes: readonly LaneDef<any>[];
    readonly signalHandlers: Readonly<Record<string, HarnessSignalHandlerConfig<any>>>;
    readonly controlPlaneAdapters: readonly ControlPlaneAdapter[];
  }) {
    this.id = opts.id;
    this.ledgerStore = opts.ledgerStore;
    this.registeredPools = opts.registeredPools;
    this.registeredStreams = opts.registeredStreams;
    this.registeredLanes = opts.registeredLanes;
    this.signalHandlers = opts.signalHandlers;
    this.controlPlaneAdapters = opts.controlPlaneAdapters;
  }

  ledger(store: LedgerStore): HarnessDef {
    return new HarnessDefImpl({
      id: this.id,
      ledgerStore: store,
      registeredPools: this.registeredPools,
      registeredStreams: this.registeredStreams,
      registeredLanes: this.registeredLanes,
      signalHandlers: this.signalHandlers,
      controlPlaneAdapters: this.controlPlaneAdapters,
    });
  }

  pools(...pools: unknown[]): HarnessDef {
    return new HarnessDefImpl({
      id: this.id,
      ledgerStore: this.ledgerStore,
      registeredPools: [...this.registeredPools, ...pools],
      registeredStreams: this.registeredStreams,
      registeredLanes: this.registeredLanes,
      signalHandlers: this.signalHandlers,
      controlPlaneAdapters: this.controlPlaneAdapters,
    });
  }

  streams(...streams: StreamDef<any, any>[]): HarnessDef {
    return new HarnessDefImpl({
      id: this.id,
      ledgerStore: this.ledgerStore,
      registeredPools: this.registeredPools,
      registeredStreams: [...this.registeredStreams, ...streams],
      registeredLanes: this.registeredLanes,
      signalHandlers: this.signalHandlers,
      controlPlaneAdapters: this.controlPlaneAdapters,
    });
  }

  lanes(...lanes: LaneDef<any>[]): HarnessDef {
    return new HarnessDefImpl({
      id: this.id,
      ledgerStore: this.ledgerStore,
      registeredPools: this.registeredPools,
      registeredStreams: this.registeredStreams,
      registeredLanes: [...this.registeredLanes, ...lanes],
      signalHandlers: this.signalHandlers,
      controlPlaneAdapters: this.controlPlaneAdapters,
    });
  }

  onSignal<TPayload>(
    signal: SignalDef<TPayload>,
    configure: ($sig: HarnessSignalBuilder<TPayload>) => HarnessSignalBuilder<TPayload>,
  ): HarnessDef {
    assertSyncCallback(configure, 'H.harness.onSignal');
    const builder = new HarnessSignalBuilderImpl<TPayload>(signal);
    configure(builder);
    return new HarnessDefImpl({
      id: this.id,
      ledgerStore: this.ledgerStore,
      registeredPools: this.registeredPools,
      registeredStreams: this.registeredStreams,
      registeredLanes: this.registeredLanes,
      signalHandlers: {
        ...this.signalHandlers,
        [signal.id]: builder.buildConfig(),
      },
      controlPlaneAdapters: this.controlPlaneAdapters,
    });
  }

  expose(...adapters: ControlPlaneAdapter[]): HarnessDef {
    return new HarnessDefImpl({
      id: this.id,
      ledgerStore: this.ledgerStore,
      registeredPools: this.registeredPools,
      registeredStreams: this.registeredStreams,
      registeredLanes: this.registeredLanes,
      signalHandlers: this.signalHandlers,
      controlPlaneAdapters: [...this.controlPlaneAdapters, ...adapters],
    });
  }
}

export const H = {
  env(key: string): EnvRef {
    return {
      kind: 'harness:env-ref',
      key,
    };
  },

  signal(id: string): SignalDef<unknown> {
    return new SignalDefImpl<unknown>(id, z.unknown());
  },

  interrupt(id: string): InterruptDef<unknown> {
    return new InterruptDefImpl<unknown>(id, z.unknown());
  },

  stream(id: string): StreamDef<unknown, unknown> {
    return new StreamDefImpl<unknown, unknown>({ id });
  },

  pool(id: string): PoolDef<unknown> {
    return new PoolDefImpl<unknown>({
      id,
      items: [],
      strategyConfig: { mode: 'round-robin' },
    });
  },

  human(id: string): HumanDef {
    return new HumanDefImpl({ id });
  },

  prefixGroup(id: string): PrefixGroupDef {
    return new PrefixGroupDefImpl({
      id,
      mode: 'role-scoped',
      groundingSources: [],
      instructionSources: [],
    });
  },

  topology(id: string): TopologyDef<string> {
    return new TopologyDefImpl<string>({
      id,
      partitionGraph: {},
    });
  },

  rules(id: string): RulesDef {
    return new RulesDefImpl({
      id,
      globalSources: [],
      scopedEntries: [],
    });
  },

  scopedRule(idOrSource: string | Source<ScopedRule>): ScopedRuleDef {
    return new ScopedRuleDefImpl({
      idOrSource,
      beforeStopChecks: [],
    });
  },

  skill(idOrSource: string | Source<SkillDefinition>): SkillDef {
    return new SkillDefImpl({
      idOrSource,
      unlockedTools: [],
      unlockedServices: [],
      leaseMode: 'until-completed-or-fork-exit',
    });
  },

  lessons(id: string): LessonsDef<unknown> {
    return new LessonsDefImpl<unknown>({
      id,
      scoringConfig: DEFAULT_LESSON_SCORING,
      signalTriggers: [],
    });
  },

  policy(id: string): PolicyDef {
    return new PolicyDefImpl({
      id,
      guardClauses: [],
      tripwires: [],
    });
  },

  agent(id: string): AgentDef<unknown, unknown, any> {
    return new AgentDefImpl<unknown, unknown, any>({
      id,
      roleKey: id,
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      skillEntries: [],
      mountedTools: [],
      extraToolNames: [],
      groundingSources: [],
      instructionSources: [],
      beforeStopChecks: [],
      raisableInterrupts: [],
      capabilitiesConfig: {
        forks: {},
        speculations: {},
        escalations: {},
      },
      childInterruptHandlers: {},
      interruptHandlers: {},
    });
  },

  loop(id: string): LoopDef<unknown, unknown, any> {
    return new LoopDefImpl<unknown, unknown, any>({
      id,
      roleKey: id,
      inputSchema: z.unknown(),
      outputSchema: z.unknown(),
      maxIterationsLimit: 3,
      preserveSession: false,
      extraTools: [],
    });
  },

  flow(
    id: string,
  ): FlowDef<unknown, any, Record<string, unknown>, Record<never, never>, Record<string, unknown>> {
    return new FlowDefImpl<unknown, any, Record<string, unknown>, Record<never, never>, Record<string, unknown>>({
      id,
      inputSchema: z.unknown(),
      nodes: [],
    });
  },

  lane(id: string): LaneDef<unknown> {
    return new LaneDefImpl<unknown>({
      id,
      inputSchema: z.unknown(),
      concurrencyLimit: 1,
      priorityLevel: 'normal',
      signalHandlers: {},
    });
  },

  harness(id: string): HarnessDef {
    return new HarnessDefImpl({
      id,
      registeredPools: [],
      registeredStreams: [],
      registeredLanes: [],
      signalHandlers: {},
      controlPlaneAdapters: [],
    });
  },

  command<TIn = unknown, TOut = unknown, THandle = any>(
    id: string,
    opts?: {
      readonly inputSchema?: z.ZodType<TIn, z.ZodTypeDef, any>;
      readonly outputSchema?: z.ZodType<TOut, z.ZodTypeDef, any>;
      readonly execute?: (input: TIn, ctx: ExecutionContext<THandle>) => Promise<TOut>;
    },
  ): StepExecutable<TIn, TOut, THandle> {
    const inputSchema: z.ZodType<TIn, z.ZodTypeDef, any> = opts?.inputSchema ?? z.any();
    const outputSchema: z.ZodType<TOut, z.ZodTypeDef, any> = opts?.outputSchema ?? z.any();
    return {
      kind: 'harness:step-executable',
      id,
      inputSchema,
      outputSchema,
      async execute(input: TIn, ctx: ExecutionContext<THandle>): Promise<TOut> {
        if (!opts?.execute) {
          throw new Error(`Command '${id}' has no execute implementation.`);
        }
        return opts.execute(input, ctx);
      },
    };
  },

  check<THandle = any>(id: string, run: Check<THandle>['run']): Check<THandle> {
    return {
      kind: 'harness:check',
      id,
      run,
    };
  },

  SpeculationCandidateSchema,
  SpeculationInputSchema,
  ResumeForkInputSchema,
  BudgetApprovalSchema,
  DistilledLessonCandidateSchema,
};
