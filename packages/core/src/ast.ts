import { z } from 'zod';
import type {
  AbortHook,
  Check,
  ControlPlaneAdapter,
  CrossVerifier,
  EffectMatcher,
  HumanAdapter,
  IsolationScope,
  LeaseDelta,
  LedgerStore,
  LessonRecord,
  LessonStore,
  MaybeSource,
  PendingPreFlightCall,
  PolicyGuard,
  PoolSelectorFn,
  PoolStrategyPort,
  QuotaTripwire,
  ScopeRewindHook,
  Service,
  Source,
  StepContext,
  StepExecutable,
  StreamSource,
  TelemetryCollector,
  ToolDefinition,
  ToolEffect,
  TopologyStore,
  TrackerAdapter,
  UniversalStepTelemetry,
} from './ports.js';
import type {
  BudgetApprovalSchema,
  GlobalRule,
  ScopedRule,
  SkillDefinition,
} from './schemas.js';

export interface SignalDef<TPayload = any> {
  readonly kind: 'harness:signal';
  readonly id: string;
  readonly schema: z.ZodType<TPayload, z.ZodTypeDef, any>;
  payload<TSchema extends z.ZodTypeAny>(schema: TSchema): SignalDef<z.infer<TSchema>>;
}

export interface InterruptDef<TPayload = any> {
  readonly kind: 'harness:interrupt';
  readonly id: string;
  readonly schema: z.ZodType<TPayload, z.ZodTypeDef, any>;
  payload<TSchema extends z.ZodTypeAny>(schema: TSchema): InterruptDef<z.infer<TSchema>>;
}

export interface StreamDef<TEvent = any, TPayload = any> {
  readonly kind: 'harness:stream';
  readonly id: string;
  readonly streamSource?: StreamSource<TEvent>;
  readonly predicate?: (ev: TEvent) => boolean;
  readonly targetSignal?: SignalDef<TPayload>;
  readonly payloadMapper?: (ev: TEvent) => TPayload;
  source<TEv>(src: StreamSource<TEv>): StreamDef<TEv, TPayload>;
  filter(pred: (ev: TEvent) => boolean): StreamDef<TEvent, TPayload>;
  emitSignal<TP>(signal: SignalDef<TP>, mapper: (ev: TEvent) => TP): StreamDef<TEvent, TP>;
}

export interface PoolStrategyConfig<TItem = any> {
  readonly mode: 'soonest-reset' | 'round-robin' | 'least-used' | 'escalate-on-retry' | 'custom';
  readonly minSuccessRate?: number;
  readonly minSamples?: number;
  readonly customStrategy?: PoolStrategyPort<TItem> | PoolSelectorFn<TItem>;
}

export interface PoolStrategyBuilder<TItem = any> {
  escalateOnRetry(): PoolStrategyBuilder<TItem>;
  minSuccessRate(rate: number): PoolStrategyBuilder<TItem>;
  minSamples(samples: number): PoolStrategyBuilder<TItem>;
  custom(strategy: PoolStrategyPort<TItem> | PoolSelectorFn<TItem>): PoolStrategyBuilder<TItem>;
}

export interface PoolDef<TItem = any> {
  readonly kind: 'harness:pool';
  readonly id: string;
  readonly items: readonly TItem[];
  readonly strategyConfig: PoolStrategyConfig<TItem>;
  readonly fallbackItem?: TItem;
  with<T>(...items: T[]): PoolDef<T>;
  strategy(mode: 'soonest-reset' | 'round-robin' | 'least-used'): PoolDef<TItem>;
  strategy(builder: ($: PoolStrategyBuilder<TItem>) => PoolStrategyBuilder<TItem>): PoolDef<TItem>;
  strategy(port: PoolStrategyPort<TItem>): PoolDef<TItem>;
  strategy(selector: PoolSelectorFn<TItem>): PoolDef<TItem>;
  strategy(
    modeOrBuilder:
      | 'soonest-reset'
      | 'round-robin'
      | 'least-used'
      | (($: PoolStrategyBuilder<TItem>) => PoolStrategyBuilder<TItem>)
      | PoolStrategyPort<TItem>
      | PoolSelectorFn<TItem>,
  ): PoolDef<TItem>;
  fallback(item: TItem): PoolDef<TItem>;
}

export interface ScopedHumanTarget<TResponse = any> {
  readonly kind: 'harness:scoped-human';
  readonly human: HumanDef;
  readonly alias: string;
  readonly responseSchema: z.ZodType<TResponse, z.ZodTypeDef, any>;
}

export interface HumanNameBuilder {
  output<TSchema extends z.ZodTypeAny>(schema: TSchema): ScopedHumanTarget<z.infer<TSchema>>;
}

export interface HumanDef {
  readonly kind: 'harness:human';
  readonly id: string;
  readonly keepAliveSec?: number;
  readonly adapter?: HumanAdapter;
  keepAliveSeconds(seconds: number): HumanDef;
  notify(adapter: HumanAdapter): HumanDef;
  withName(alias: string): HumanNameBuilder;
}

export interface PrefixGroupDef {
  readonly kind: 'harness:prefix-group';
  readonly id: string;
  readonly mode: 'role-scoped' | 'union';
  readonly groundingSources: readonly MaybeSource<string>[];
  readonly instructionSources: readonly MaybeSource<string>[];
  readonly sharedRulesDef?: RulesDef;
  toolsMode(mode: 'role-scoped' | 'union'): PrefixGroupDef;
  sharedGrounding(...sources: MaybeSource<string>[]): PrefixGroupDef;
  sharedInstructions(...sources: MaybeSource<string>[]): PrefixGroupDef;
  sharedRules(rules: RulesDef): PrefixGroupDef;
}

export interface CommitOverlayOptions<TOnSig = any, TDiscardSig = any> {
  readonly onSignal?: {
    readonly signal: SignalDef<TOnSig>;
    readonly correlateBy: (sig: TOnSig) => string;
    readonly baseBranch?: (sig: TOnSig) => string;
  };
  readonly discardOnSignal?: {
    readonly signal: SignalDef<TDiscardSig>;
    readonly correlateBy: (sig: TDiscardSig) => string;
  };
  readonly maxSealedAgeHours?: number;
}

export interface TopologyDef<TPartition extends string = string> {
  readonly kind: 'harness:topology';
  readonly id: string;
  readonly topologyStore?: TopologyStore;
  readonly partitionGraph: Readonly<Record<TPartition, { readonly dependsOn?: readonly TPartition[] }>>;
  readonly overlayOptions?: CommitOverlayOptions<any, any>;
  store(store: TopologyStore): TopologyDef<TPartition>;
  partitions<TMap extends Record<string, { readonly dependsOn?: readonly string[] }>>(
    map: TMap,
  ): TopologyDef<Extract<keyof TMap, string>>;
  commitOverlayWhen<TOnSig = any, TDiscardSig = any>(
    opts?: CommitOverlayOptions<TOnSig, TDiscardSig>,
  ): TopologyDef<TPartition>;
  dependentsOf(partitionId: TPartition): readonly TPartition[];
  affectedBy(partitionId: TPartition): readonly TPartition[];
}

export interface ScopedRuleDef {
  readonly kind: 'harness:scoped-rule';
  readonly idOrSource: string | Source<ScopedRule>;
  readonly predicate?: {
    readonly partitions?: readonly string[];
    readonly effects?: EffectMatcher;
  };
  readonly directiveSource?: MaybeSource<string>;
  readonly beforeStopChecks: readonly Check<any>[];
  when(predicate: {
    readonly partitions?: readonly string[];
    readonly effects?: EffectMatcher;
  }): ScopedRuleDef;
  directive(textOrSource: MaybeSource<string>): ScopedRuleDef;
  enforceBeforeStop(...checks: Check<any>[]): ScopedRuleDef;
}

export interface RulesDef {
  readonly kind: 'harness:rules';
  readonly id: string;
  readonly globalSources: readonly MaybeSource<GlobalRule | readonly GlobalRule[]>[];
  readonly scopedEntries: ReadonlyArray<MaybeSource<ScopedRule | readonly ScopedRule[]> | ScopedRuleDef>;
  global(...sources: MaybeSource<GlobalRule | readonly GlobalRule[]>[]): RulesDef;
  scoped(...entries: Array<MaybeSource<ScopedRule | readonly ScopedRule[]> | ScopedRuleDef>): RulesDef;
}

export interface SkillDef {
  readonly kind: 'harness:skill';
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
  when(predicate: {
    readonly partitions?: readonly string[];
    readonly effects?: EffectMatcher;
  }): SkillDef;
  description(text: string): SkillDef;
  instructions(textOrSource: MaybeSource<string>): SkillDef;
  unlocksTools(...tools: Array<ToolDefinition<any> | readonly ToolDefinition<any>[]>): SkillDef;
  unlocksServices(...services: Service<any>[]): SkillDef;
  lease(mode: 'until-completed-or-fork-exit'): SkillDef;
}

export interface LessonDistillConfig {
  readonly model: unknown;
  readonly onLoopRecovery: boolean;
  readonly onGateRecovery: boolean;
  readonly minFailedChecks: number;
  readonly guidelinesSource?: MaybeSource<string>;
}

export interface LessonScoringConfig {
  readonly slidingWindowInjections: number;
  readonly partitionMatchBoost: number;
  readonly decayOnPartitionEpochChange: number;
  readonly minScore: number;
  readonly maxItems: number;
}

export interface LessonRetireConfig {
  readonly maxViolations?: number;
  readonly minCleanPassRate?: number;
  readonly afterInjections?: number;
}

export interface LessonSignalTriggerConfig<TPayload = any> {
  readonly signal: SignalDef<TPayload>;
  readonly minCleanPasses: number;
  readonly maxViolations: number;
  readonly cooldownHours: number;
  readonly mapper: (lesson: LessonRecord) => TPayload;
}

export interface LessonDistillBuilder {
  onLoopRecovery(): LessonDistillBuilder;
  onGateRecovery(opts?: { readonly minFailedChecks?: number }): LessonDistillBuilder;
  guidelines(source: MaybeSource<string>): LessonDistillBuilder;
}

export interface LessonScoringBuilder {
  slidingWindowInjections(count: number): LessonScoringBuilder;
  partitionMatchBoost(boost: number): LessonScoringBuilder;
  decayOnPartitionEpochChange(gamma: number): LessonScoringBuilder;
  recall(opts: { readonly minScore: number; readonly maxItems: number }): LessonScoringBuilder;
}

export interface LessonRetireBuilder {
  maxViolations(count: number): LessonRetireBuilder;
  orMinCleanPassRate(minRate: number, opts: { readonly afterInjections: number }): LessonRetireBuilder;
}

export interface LessonEmitSignalBuilder {
  minCleanPasses(count: number): LessonEmitSignalBuilder;
  maxViolations(count: number): LessonEmitSignalBuilder;
  cooldownHours(hours: number): LessonEmitSignalBuilder;
}

export interface LessonsDef<TIn = any> {
  readonly kind: 'harness:lessons';
  readonly id: string;
  readonly lessonStore?: LessonStore;
  readonly querySchema?: z.ZodType<TIn, z.ZodTypeDef, any>;
  readonly queryExtractor?: (input: TIn) => string;
  readonly distillConfig?: LessonDistillConfig;
  readonly scoringConfig: LessonScoringConfig;
  readonly retireConfig?: LessonRetireConfig;
  readonly signalTriggers: readonly LessonSignalTriggerConfig<any>[];
  store(store: LessonStore): LessonsDef<TIn>;
  queryFrom<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    extractor: (input: z.infer<TSchema>) => string,
  ): LessonsDef<z.infer<TSchema>>;
  distillWith(
    model: unknown,
    configure: ($d: LessonDistillBuilder) => LessonDistillBuilder,
  ): LessonsDef<TIn>;
  scoring(configure: ($s: LessonScoringBuilder) => LessonScoringBuilder): LessonsDef<TIn>;
  retireAfter(configure: ($r: LessonRetireBuilder) => LessonRetireBuilder): LessonsDef<TIn>;
  emitSignalWhen<TPayload>(
    signal: SignalDef<TPayload>,
    configure: ($t: LessonEmitSignalBuilder) => LessonEmitSignalBuilder,
    mapper: (lesson: LessonRecord) => TPayload,
  ): LessonsDef<TIn>;
}

export interface PolicyViolation {
  readonly blockedCalls: readonly PendingPreFlightCall[];
  readonly violatedEffects: readonly ToolEffect[];
  readonly violationSummary: string;
}

export interface PolicyGuardClauseConfig<TPayload = any> {
  readonly id: string;
  readonly guards: readonly PolicyGuard[];
  readonly mode: 'deny-with-error' | 'raise-interrupt';
  readonly messageMapper?: (violation: PolicyViolation) => string;
  readonly interrupt?: InterruptDef<TPayload>;
  readonly interruptMapper?: (violation: PolicyViolation) => TPayload;
}

export interface LimitExceededConfig {
  readonly flushInterrupt?: InterruptDef<any>;
  readonly abortHook?: AbortHook<any, any>;
}

export interface PolicyGuardChainBuilder {
  onViolation(
    mode: 'deny-with-error',
    messageMapper?: (violation: PolicyViolation) => string,
  ): PolicyDef;
  onViolation<TPayload>(
    mode: 'raise-interrupt',
    interrupt: InterruptDef<TPayload>,
    mapper: (violation: PolicyViolation) => TPayload,
  ): PolicyDef;
}

export interface LimitExceededBuilder {
  flushWithInterrupt(interrupt: InterruptDef<any>): LimitExceededBuilder;
  onAbort(hook: AbortHook<any, any>): LimitExceededBuilder;
}

export interface PolicyDef {
  readonly kind: 'harness:policy';
  readonly id: string;
  readonly guardClauses: readonly PolicyGuardClauseConfig<any>[];
  readonly tripwires: readonly QuotaTripwire[];
  readonly maxTurnsLimit?: number;
  readonly maxCostUsdLimit?: number;
  readonly maxDurationSecondsLimit?: number;
  readonly abortHook?: AbortHook<any, any>;
  readonly limitExceededConfig?: LimitExceededConfig;
  guard(...guards: PolicyGuard[]): PolicyGuardChainBuilder;
  tripwire(...tripwires: QuotaTripwire[]): PolicyDef;
  maxTurns(turns: number): PolicyDef;
  maxCostUsd(costUsd: number): PolicyDef;
  maxDurationSeconds(seconds: number): PolicyDef;
  onAbort(hook: AbortHook<any, any>): PolicyDef;
  onLimitExceeded(configure: ($l: LimitExceededBuilder) => LimitExceededBuilder): PolicyDef;
  extend(newId: string): PolicyDef;
}

export interface ForkModelRoutingConfig<TIn = any, TReq = any> {
  readonly inheritEffort?: 'low' | 'medium' | 'high';
  readonly inheritWhen?: (parentInput: TIn, req: TReq) => boolean;
  readonly fallbackPool?: unknown;
}

export interface ForkCapabilityConfig<TIn = any, TChildIn = any, TReq = any> {
  readonly toolName: string;
  readonly childExecutable: StepExecutable<TChildIn, any, any>;
  readonly historyMode: 'shared-prefix-only' | 'clone-transcript';
  readonly requestSchema?: z.ZodType<TReq, z.ZodTypeDef, any>;
  readonly mapInput?: (parentInput: TIn, req: TReq) => TChildIn;
  readonly modelRoutingConfig?: ForkModelRoutingConfig<TIn, TReq>;
}

export interface ForkModelRoutingBuilder<TIn = any, TReq = any> {
  inheritParentWithEffort(
    effort: 'low' | 'medium' | 'high',
    opts: { readonly when: (parentInput: TIn, req: TReq) => boolean },
  ): ForkModelRoutingBuilder<TIn, TReq>;
  otherwisePool(pool: unknown): ForkModelRoutingBuilder<TIn, TReq>;
}

export interface ForkCapabilityBuilder<TIn = any, TChildIn = any, TReq = any> {
  historyMode(mode: 'shared-prefix-only' | 'clone-transcript'): ForkCapabilityBuilder<TIn, TChildIn, TReq>;
  requestSchema<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
  ): ForkCapabilityBuilder<TIn, TChildIn, z.infer<TSchema>>;
  mapInput(
    mapper: (parentInput: TIn, req: TReq) => TChildIn,
  ): ForkCapabilityBuilder<TIn, TChildIn, TReq>;
  modelRouting(
    configure: ($m: ForkModelRoutingBuilder<TIn, TReq>) => ForkModelRoutingBuilder<TIn, TReq>,
  ): ForkCapabilityBuilder<TIn, TChildIn, TReq>;
}

export type ArbiterDecision =
  | {
      readonly decision: 'select-winner';
      readonly winnerBranchIndex: number;
      readonly rationale: string;
      readonly followUpDeficits?: readonly string[];
    }
  | {
      readonly decision: 'unpark-escalation';
      readonly parkedBranchIndex: number;
      readonly rationale: string;
    }
  | {
      readonly decision: 'reject-all';
      readonly rationale: string;
    };

export interface SpeculateCapabilityConfig<
  TIn = any,
  TReq = any,
  TWorkerIn = any,
  TWorkerOut = any,
  THandle = any,
  TVerdict extends ArbiterDecision = ArbiterDecision,
> {
  readonly toolName: string;
  readonly requestSchema?: z.ZodType<TReq, z.ZodTypeDef, any>;
  readonly workerExecutable?: StepExecutable<TWorkerIn, TWorkerOut, THandle>;
  readonly branchCount: number;
  readonly branchesMapper?: (parentInput: TIn, req: TReq) => readonly TWorkerIn[];
  readonly singleWinnerVerifier?: {
    readonly evaluator: StepExecutable<any, any, THandle>;
    readonly mapInput?: (branchInput: TWorkerIn, branchOutput: TWorkerOut, scopeReceipt: any) => any;
    readonly acceptWhen?: (evalOut: any) => boolean;
  };
  readonly crossVerifier?: CrossVerifier<THandle, any, any>;
  readonly arbiterConfig?: {
    readonly arbiterAgent: StepExecutable<any, TVerdict, THandle>;
    readonly resolveDecision: (verdict: TVerdict) => ArbiterDecision;
  };
  readonly refineWinnerConfig?: {
    readonly predicate: (verdict: TVerdict) => boolean;
    readonly refinementExecutable: StepExecutable<TWorkerIn, TWorkerOut, THandle>;
    readonly mapper: (parentInput: TIn, verdict: TVerdict, candidates: ReadonlyArray<any>) => TWorkerIn;
  };
}

export interface SpeculateCapabilityBuilder<
  TIn = any,
  TReq = any,
  TWorkerIn = any,
  TWorkerOut = any,
  THandle = any,
  TVerdict extends ArbiterDecision = ArbiterDecision,
> {
  requestSchema<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
  ): SpeculateCapabilityBuilder<TIn, z.infer<TSchema>, TWorkerIn, TWorkerOut, THandle, TVerdict>;
  worker<TWIn, TWOut, TH>(
    executable: StepExecutable<TWIn, TWOut, TH>,
  ): SpeculateCapabilityBuilder<TIn, TReq, TWIn, TWOut, TH, TVerdict>;
  branches(
    count: number,
    mapper: (parentInput: TIn, req: TReq) => readonly TWorkerIn[],
  ): SpeculateCapabilityBuilder<TIn, TReq, TWorkerIn, TWorkerOut, THandle, TVerdict>;
  verifyWinnerWith<TEvalIn, TEvalOut>(
    evaluator: StepExecutable<TEvalIn, TEvalOut, THandle>,
    opts?: {
      readonly mapInput: (branchInput: TWorkerIn, branchOutput: TWorkerOut, scopeReceipt: any) => TEvalIn;
      readonly acceptWhen: (evalOut: TEvalOut) => boolean;
    },
  ): SpeculateCapabilityBuilder<TIn, TReq, TWorkerIn, TWorkerOut, THandle, TVerdict>;
  crossVerifyWith(
    verifier: CrossVerifier<THandle, any, any>,
  ): SpeculateCapabilityBuilder<TIn, TReq, TWorkerIn, TWorkerOut, THandle, TVerdict>;
  arbiter<TArbIn, TArbOut extends ArbiterDecision>(
    arbiterAgent: StepExecutable<TArbIn, TArbOut, THandle>,
    opts: {
      readonly resolveDecision: (verdict: TArbOut) => ArbiterDecision;
    },
  ): SpeculateCapabilityBuilder<TIn, TReq, TWorkerIn, TWorkerOut, THandle, TArbOut>;
  refineWinnerWhen(
    predicate: (verdict: TVerdict) => boolean,
    refinementExecutable: StepExecutable<TWorkerIn, TWorkerOut, THandle>,
    mapper: (
      parentInput: TIn,
      verdict: TVerdict,
      candidates: ReadonlyArray<
        | {
            readonly status: 'COMPLETED';
            readonly branchIndex: number;
            readonly input: TWorkerIn;
            readonly output: TWorkerOut;
            readonly scopeReceipt: any;
            readonly crossVerifyReport?: any;
          }
        | {
            readonly status: 'PARKED_ON_ESCALATION';
            readonly branchIndex: number;
            readonly input: TWorkerIn;
            readonly scopeReceipt: any;
            readonly interruptId: string;
            readonly escalationPayload: any;
          }
      >,
    ) => TWorkerIn,
  ): SpeculateCapabilityBuilder<TIn, TReq, TWorkerIn, TWorkerOut, THandle, TVerdict>;
}

export interface SpawnTasksCapabilityConfig<TItem = any> {
  readonly itemSchema: z.ZodType<TItem, z.ZodTypeDef, any>;
  readonly maxSpawnedPerRun: number;
  readonly maxPrerequisiteDepth: number;
  readonly enforcePatch?: Partial<TItem>;
  readonly onPrerequisiteSpawned: 'suspend-and-yield-slot';
  readonly priorityStrategy: 'inherit-parent-with-boost' | 'normal';
  readonly resumeWhen:
    | 'prerequisite-exit'
    | {
        readonly signal: SignalDef<any>;
        readonly correlateBy: (sig: any) => string;
      };
}

export interface MutatePlanCapabilityConfig {
  readonly spawnTasksConfig?: SpawnTasksCapabilityConfig<any>;
  readonly allowAddDependencies: boolean;
  readonly writableTopology?: TopologyDef<any>;
}

export interface MutatePlanBuilder {
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
  ): MutatePlanBuilder;
  canAddDependencies(): MutatePlanBuilder;
  canUpdateTopologyContracts(topology: TopologyDef<any>): MutatePlanBuilder;
}

export interface EscalateCapabilityConfig<TPayload = any, TDecision = any> {
  readonly interrupt: InterruptDef<TPayload>;
  readonly human?: HumanDef;
  readonly responseSchema?: z.ZodType<TDecision, z.ZodTypeDef, any>;
  readonly leaseElevations: ReadonlyArray<{
    readonly predicate: (decision: TDecision) => boolean;
    readonly leaseMapper: (decision: TDecision) => LeaseDelta;
  }>;
}

export interface EscalateCapabilityBuilder<TDecision = any> {
  to(human: HumanDef): EscalateCapabilityBuilder<TDecision>;
  response<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
  ): EscalateCapabilityBuilder<z.infer<TSchema>>;
  elevateLeaseWhen(
    predicate: (decision: TDecision) => boolean,
    leaseMapper: (decision: TDecision) => LeaseDelta,
  ): EscalateCapabilityBuilder<TDecision>;
}

export interface AgentCapabilitiesConfig<TIn = any, THandle = any> {
  readonly forks: Readonly<Record<string, ForkCapabilityConfig<TIn, any, any>>>;
  readonly speculations: Readonly<Record<string, SpeculateCapabilityConfig<TIn, any, any, any, THandle, any>>>;
  readonly mutatePlanConfig?: MutatePlanCapabilityConfig;
  readonly escalations: Readonly<Record<string, EscalateCapabilityConfig<any, any>>>;
}

export interface AgentCapabilitiesBuilder<TIn = any, THandle = any> {
  fork<TChildIn, TChildOut>(
    toolName: string,
    childExecutable: StepExecutable<TChildIn, TChildOut, THandle>,
    configure: ($f: ForkCapabilityBuilder<TIn, TChildIn, any>) => ForkCapabilityBuilder<TIn, TChildIn, any>,
  ): AgentCapabilitiesBuilder<TIn, THandle>;
  speculate(
    toolName: string,
    configure: (
      $s: SpeculateCapabilityBuilder<TIn, any, any, any, THandle, any>,
    ) => SpeculateCapabilityBuilder<TIn, any, any, any, THandle, any>,
  ): AgentCapabilitiesBuilder<TIn, THandle>;
  mutatePlan(configure: ($m: MutatePlanBuilder) => MutatePlanBuilder): AgentCapabilitiesBuilder<TIn, THandle>;
  escalate<TPayload>(
    interrupt: InterruptDef<TPayload>,
    configure: ($esc: EscalateCapabilityBuilder<any>) => EscalateCapabilityBuilder<any>,
  ): AgentCapabilitiesBuilder<TIn, THandle>;
}

export interface ChildInterruptHandlerConfig<TPayload = any> {
  readonly interrupt: InterruptDef<TPayload>;
  readonly pausePartitionsMapper?: (payload: TPayload) => readonly string[];
  readonly suspendAndReturn: boolean;
}

export interface ChildInterruptBuilder<TPayload = any> {
  pauseSiblingForksInPartitions(
    mapper: (payload: TPayload) => readonly string[],
  ): ChildInterruptBuilder<TPayload>;
  suspendAndReturnToParent(): ChildInterruptBuilder<TPayload>;
}

export interface NestedHumanInterruptConfig<TDecision = any> {
  readonly human?: HumanDef;
  readonly responseSchema?: z.ZodType<TDecision, z.ZodTypeDef, any>;
  readonly leaseElevations: ReadonlyArray<{
    readonly predicate: (decision: TDecision) => boolean;
    readonly leaseMapper: (decision: TDecision) => LeaseDelta;
  }>;
  readonly feedbackMapper?: (decision: TDecision) => string;
}

export interface NestedHumanInterruptBuilder<TDecision = any> {
  ask<TSchema extends z.ZodTypeAny>(
    human: HumanDef,
    responseSchema: TSchema,
  ): NestedHumanInterruptBuilder<z.infer<TSchema>>;
  elevateLeaseWhen(
    predicate: (decision: TDecision) => boolean,
    leaseMapper: (decision: TDecision) => LeaseDelta,
  ): NestedHumanInterruptBuilder<TDecision>;
  resumeWith(feedbackMapper: (decision: TDecision) => string): NestedHumanInterruptBuilder<TDecision>;
}

export interface InterruptEdgeConfig<
  TInput = any,
  TPayload = any,
  TVerdict = any,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TAbortMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly interrupt: InterruptDef<TPayload>;
  readonly adjudicatorConfig?: {
    readonly adjudicator: StepExecutable<any, TVerdict, any>;
    readonly mapInput: (input: TInput, payload: TPayload) => any;
  };
  readonly directHumanConfig?: NestedHumanInterruptConfig<any>;
  readonly nestedInterruptHandlers: Readonly<Record<string, NestedHumanInterruptConfig<any>>>;
  readonly leaseElevations: ReadonlyArray<{
    readonly predicate: (input: TInput, payload: TPayload, verdict: TVerdict) => boolean;
    readonly leaseMapper: (input: TInput, payload: TPayload, verdict: TVerdict) => LeaseDelta;
  }>;
  readonly resumeFeedbackMapper?: (input: TInput, payload: TPayload, verdict: TVerdict) => string;
  readonly abortHook?: AbortHook<any, TAbortMeta>;
  readonly replacementConfig?: {
    readonly replacement: StepExecutable<any, any, any>;
    readonly mapInput: (
      input: TInput,
      payload: TPayload,
      telemetry: UniversalStepTelemetry<TCustomMetrics, TAbortMeta>,
    ) => any;
  };
}

export interface InterruptEdgeBuilder<
  TInput = any,
  TPayload = any,
  TVerdict = any,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TAbortMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  adjudicateWith<TAdjIn, TAdjOut>(
    adjudicator: StepExecutable<TAdjIn, TAdjOut, any>,
    mapInput: (input: TInput, payload: TPayload) => TAdjIn,
  ): InterruptEdgeBuilder<TInput, TPayload, TAdjOut, TCustomMetrics, TAbortMeta>;
  ask<TSchema extends z.ZodTypeAny>(
    human: HumanDef,
    responseSchema: TSchema,
  ): NestedHumanInterruptBuilder<z.infer<TSchema>>;
  onInterrupt<TNestedPayload>(
    nestedInterrupt: InterruptDef<TNestedPayload>,
    configure: ($esc: NestedHumanInterruptBuilder<any>) => NestedHumanInterruptBuilder<any>,
  ): InterruptEdgeBuilder<TInput, TPayload, TVerdict, TCustomMetrics, TAbortMeta>;
  elevateLeaseWhen(
    predicate: (input: TInput, payload: TPayload, verdict: TVerdict) => boolean,
    leaseMapper: (input: TInput, payload: TPayload, verdict: TVerdict) => LeaseDelta,
  ): InterruptEdgeBuilder<TInput, TPayload, TVerdict, TCustomMetrics, TAbortMeta>;
  resumeWith(
    feedbackMapper: (input: TInput, payload: TPayload, verdict: TVerdict) => string,
  ): InterruptEdgeBuilder<TInput, TPayload, TVerdict, TCustomMetrics, TAbortMeta>;
  onAbort<TNewAbortMeta extends Record<string, unknown>>(
    hook: AbortHook<any, TNewAbortMeta>,
  ): InterruptEdgeBuilder<TInput, TPayload, TVerdict, TCustomMetrics, TNewAbortMeta>;
  replaceWith<TRepIn, TRepOut>(
    replacement: StepExecutable<TRepIn, TRepOut, any>,
    mapInput: (
      input: TInput,
      payload: TPayload,
      telemetry: UniversalStepTelemetry<TCustomMetrics, TAbortMeta>,
    ) => TRepIn,
  ): InterruptEdgeBuilder<TInput, TPayload, TVerdict, TCustomMetrics, TAbortMeta>;
}

export interface AgentDef<TIn = any, TOut = any, THandle = any> extends StepExecutable<TIn, TOut, THandle> {
  readonly roleKey: string;
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
  prefixGroup(group: PrefixGroupDef): AgentDef<TIn, TOut, THandle>;
  model(modelOrPool: unknown): AgentDef<TIn, TOut, THandle>;
  topology(topology: TopologyDef<any>): AgentDef<TIn, TOut, THandle>;
  rules(rules: RulesDef): AgentDef<TIn, TOut, THandle>;
  lessons(lessons: LessonsDef<any>, opts?: { readonly recordOutcomes?: boolean }): AgentDef<TIn, TOut, THandle>;
  skills(
    ...skills: Array<SkillDef | MaybeSource<SkillDefinition | readonly SkillDefinition[]>>
  ): AgentDef<TIn, TOut, THandle>;
  policy(policy: PolicyDef): AgentDef<TIn, TOut, THandle>;
  tools(...tools: Array<ToolDefinition<any> | readonly ToolDefinition<any>[]>): AgentDef<TIn, TOut, THandle>;
  grounding(...sources: MaybeSource<string>[]): AgentDef<TIn, TOut, THandle>;
  instructions(...sources: MaybeSource<string>[]): AgentDef<TIn, TOut, THandle>;
  timeoutMinutes(minutes: number): AgentDef<TIn, TOut, THandle>;
  beforeStop(...checks: Check<any>[]): AgentDef<TIn, TOut, THandle>;
  input<TSchema extends z.ZodTypeAny>(schema: TSchema): AgentDef<z.infer<TSchema>, TOut, THandle>;
  partitions(extractor: (input: TIn) => readonly string[]): AgentDef<TIn, TOut, THandle>;
  output<TSchema extends z.ZodTypeAny>(schema: TSchema): AgentDef<TIn, z.infer<TSchema>, THandle>;
  canRaise(...interrupts: InterruptDef<any>[]): AgentDef<TIn, TOut, THandle>;
  capabilities(
    configure: ($cap: AgentCapabilitiesBuilder<TIn, THandle>) => AgentCapabilitiesBuilder<TIn, THandle>,
  ): AgentDef<TIn, TOut, THandle>;
  onChildInterrupt<TPayload>(
    interrupt: InterruptDef<TPayload>,
    configure: ($intr: ChildInterruptBuilder<TPayload>) => ChildInterruptBuilder<TPayload>,
  ): AgentDef<TIn, TOut, THandle>;
  onInterrupt<TPayload>(
    interrupt: InterruptDef<TPayload>,
    configure: ($intr: InterruptEdgeBuilder<TIn, TPayload, any>) => unknown,
  ): AgentDef<TIn, TOut, THandle>;
  withPolicy(newPolicy: PolicyDef): AgentDef<TIn, TOut, THandle>;
  withTools(...extraTools: Array<ToolDefinition<any> | readonly ToolDefinition<any>[]>): AgentDef<TIn, TOut, THandle>;
}

export interface LoopEvaluateConfig<TIn = any, TOut = any, TEvalIn = any, TEvalOut = any, THandle = any> {
  readonly stepId: string;
  readonly evaluator: StepExecutable<TEvalIn, TEvalOut, THandle>;
  readonly mapInput: (loopInput: TIn, candidate: TOut, scopeReceipt: any) => TEvalIn;
  readonly acceptWhen: (evalOut: TEvalOut) => boolean;
  readonly feedbackMapper: (evalOut: TEvalOut) => string;
}

export interface LoopDef<TIn = any, TOut = any, THandle = any> extends StepExecutable<TIn, TOut, THandle> {
  readonly roleKey: string;
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
  input<TSchema extends z.ZodTypeAny>(schema: TSchema): LoopDef<z.infer<TSchema>, TOut, THandle>;
  output<TSchema extends z.ZodTypeAny>(schema: TSchema): LoopDef<TIn, z.infer<TSchema>, THandle>;
  partitions(extractor: (input: TIn) => readonly string[]): LoopDef<TIn, TOut, THandle>;
  maxIterations(count: number): LoopDef<TIn, TOut, THandle>;
  preserveActorSession(preserve: boolean): LoopDef<TIn, TOut, THandle>;
  distillLessonsInto(lessons: LessonsDef<any>): LoopDef<TIn, TOut, THandle>;
  act<TActOut>(
    stepId: string,
    actor: StepExecutable<TIn, TActOut, THandle>,
    configure?: ($act: unknown) => unknown,
  ): LoopDef<TIn, TOut, THandle>;
  evaluate<TEvalIn, TEvalOut>(
    stepId: string,
    evaluator: StepExecutable<TEvalIn, TEvalOut, THandle>,
    opts: {
      readonly mapInput: (loopInput: TIn, candidate: TOut, scopeReceipt: any) => TEvalIn;
      readonly acceptWhen: (evalOut: TEvalOut) => boolean;
      readonly feedbackMapper: (evalOut: TEvalOut) => string;
    },
  ): LoopDef<TIn, TOut, THandle>;
  returnOutputFrom(actStepId: string): LoopDef<TIn, TOut, THandle>;
  withPolicy(newPolicy: PolicyDef): LoopDef<TIn, TOut, THandle>;
  withTools(...extraTools: Array<ToolDefinition<any> | readonly ToolDefinition<any>[]>): LoopDef<TIn, TOut, THandle>;
}

export interface FlowStepNodeConfig<
  TFlowIn = any,
  TStepIn = any,
  TSteps extends Record<string, any> = Record<never, never>,
  TReceipt = any,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: 'step';
  readonly stepId: string;
  readonly executable: StepExecutable<TStepIn, any, any>;
  readonly inputMapper?: (flowInput: TFlowIn, priorSteps: TSteps, scopeReceipt: TReceipt) => TStepIn;
  readonly interruptHandlers: Readonly<Record<string, InterruptEdgeConfig<TFlowIn, any, any, TCustomMetrics, any>>>;
}

export interface FlowBranchNodeConfig<
  TFlowIn = any,
  TBranchOut = any,
  TSteps extends Record<string, any> = Record<never, never>,
  TReceipt = any,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: 'branch';
  readonly branchStepId: string;
  readonly outputSchema?: z.ZodType<TBranchOut, z.ZodTypeDef, any>;
  readonly arms: ReadonlyArray<{
    readonly predicate?: (input: TFlowIn) => boolean;
    readonly step: FlowStepNodeConfig<TFlowIn, any, TSteps, TReceipt, TCustomMetrics>;
  }>;
}

export type FlowNodeConfig<
  TFlowIn = any,
  TSteps extends Record<string, any> = Record<never, never>,
  TReceipt = any,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
> =
  | FlowStepNodeConfig<TFlowIn, any, TSteps, TReceipt, TCustomMetrics>
  | FlowBranchNodeConfig<TFlowIn, any, TSteps, TReceipt, TCustomMetrics>;

export interface FlowStepBuilder<
  TFlowIn = any,
  TStepIn = any,
  TSteps extends Record<string, any> = Record<never, never>,
  TReceipt = any,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
> {
  inputFrom(
    mapper: (flowInput: TFlowIn, priorSteps: TSteps, scopeReceipt: TReceipt) => TStepIn,
  ): FlowStepBuilder<TFlowIn, TStepIn, TSteps, TReceipt, TCustomMetrics>;
  onInterrupt<TPayload>(
    interrupt: InterruptDef<TPayload>,
    configure: (
      $intr: InterruptEdgeBuilder<TFlowIn, TPayload, any, TCustomMetrics, Record<string, unknown>>,
    ) => unknown,
  ): FlowStepBuilder<TFlowIn, TStepIn, TSteps, TReceipt, TCustomMetrics>;
}

export interface FlowSubBranchBuilder<
  TFlowIn = any,
  TBranchOut = any,
  TSteps extends Record<string, any> = Record<never, never>,
  TReceipt = any,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
> {
  step<TStepIn>(
    stepId: string,
    executable: StepExecutable<TStepIn, TBranchOut, any>,
    configure?: (
      $step: FlowStepBuilder<TFlowIn, TStepIn, TSteps, TReceipt, TCustomMetrics>,
    ) => FlowStepBuilder<TFlowIn, TStepIn, TSteps, TReceipt, TCustomMetrics>,
  ): FlowSubBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>;
}

export interface FlowBranchBuilder<
  TFlowIn = any,
  TBranchOut = any,
  TSteps extends Record<string, any> = Record<never, never>,
  TReceipt = any,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly outputSchema?: z.ZodType<TBranchOut, z.ZodTypeDef, any>;
  output<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
  ): FlowBranchBuilder<TFlowIn, z.infer<TSchema>, TSteps, TReceipt, TCustomMetrics>;
  when(
    predicate: (input: TFlowIn) => boolean,
    configure: (
      $sub: FlowSubBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>,
    ) => FlowSubBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>,
  ): FlowBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>;
  otherwise(
    configure: (
      $sub: FlowSubBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>,
    ) => FlowSubBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>,
  ): FlowBranchBuilder<TFlowIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>;
}

export interface FlowDef<
  TIn = any,
  THandle = any,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TSteps extends Record<string, any> = Record<never, never>,
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: 'harness:flow';
  readonly id: string;
  readonly inputSchema: z.ZodType<TIn, z.ZodTypeDef, any>;
  readonly isolationScope?: IsolationScope<THandle, TReceipt>;
  readonly telemetryCollector?: TelemetryCollector<TCustomMetrics>;
  readonly nodes: readonly FlowNodeConfig<TIn, any, TReceipt, TCustomMetrics>[];
  readonly terminalState?: string;
  input<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
  ): FlowDef<z.infer<TSchema>, THandle, TReceipt, TSteps, TCustomMetrics>;
  scope<TH, TR extends Record<string, unknown>>(
    scope: IsolationScope<TH, TR>,
  ): FlowDef<TIn, TH, TR, TSteps, TCustomMetrics>;
  telemetry<TCustom extends Record<string, unknown>>(
    collector: TelemetryCollector<TCustom>,
  ): FlowDef<TIn, THandle, TReceipt, TSteps, TCustom>;
  step<TStepId extends string, TStepIn, TStepOut>(
    stepId: TStepId,
    executable: StepExecutable<TStepIn, TStepOut, THandle>,
    configure?: (
      $s: FlowStepBuilder<TIn, TStepIn, TSteps, TReceipt, TCustomMetrics>,
    ) => FlowStepBuilder<TIn, TStepIn, TSteps, TReceipt, TCustomMetrics>,
  ): FlowDef<TIn, THandle, TReceipt, TSteps & Record<TStepId, TStepOut>, TCustomMetrics>;
  branch<TBranchId extends string, TBranchOut>(
    branchStepId: TBranchId,
    configure: (
      $b: FlowBranchBuilder<TIn, any, TSteps, TReceipt, TCustomMetrics>,
    ) => FlowBranchBuilder<TIn, TBranchOut, TSteps, TReceipt, TCustomMetrics>,
  ): FlowDef<TIn, THandle, TReceipt, TSteps & Record<TBranchId, TBranchOut>, TCustomMetrics>;
  exit(terminalState: string): FlowDef<TIn, THandle, TReceipt, TSteps, TCustomMetrics>;
}

export interface LaneTrackerConfig<TExternal = any, TIn = any, TExternalState extends string = string> {
  readonly adapter: TrackerAdapter<TExternal, TExternalState>;
  readonly pollIntervalSeconds: number;
  readonly mapper?: (externalItem: TExternal) => TIn | undefined;
  readonly stateMapping: {
    readonly onQueued?: TExternalState;
    readonly onRunning?: TExternalState;
    readonly onWaiting?: TExternalState;
    readonly onErrored?: TExternalState;
    readonly onCancelled?: TExternalState;
    readonly onExit: Readonly<Record<string, TExternalState>>;
  };
}

export interface LaneRetryConfig {
  readonly tries: number;
  readonly exponentialBaseDelayMs: number;
  readonly failTerminalState: string;
}

export interface LaneSignalHandlerConfig<TIn = any, TPayload = any> {
  readonly signal: SignalDef<TPayload>;
  readonly updateMapper?: (current: TIn, signalPayload: TPayload) => TIn;
  readonly rewindToStepId?: string;
  readonly onRewindHook?: ScopeRewindHook<any>;
}

export interface LaneTrackerBuilder<TExternal = any, TIn = any, TExternalState extends string = string> {
  everySeconds(seconds: number): LaneTrackerBuilder<TExternal, TIn, TExternalState>;
  from(mapper: (externalItem: TExternal) => TIn | undefined): LaneTrackerBuilder<TExternal, TIn, TExternalState>;
  onQueued(state: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState>;
  onRunning(state: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState>;
  onWaiting(state: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState>;
  onErrored(state: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState>;
  onCancelled(state: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState>;
  onExit(terminalState: string, externalState: TExternalState): LaneTrackerBuilder<TExternal, TIn, TExternalState>;
}

export interface LaneRetryBuilder {
  tries(count: number): LaneRetryBuilder;
  exponential(baseDelayMs: number): LaneRetryBuilder;
  orFail(terminalState: string): LaneRetryBuilder;
}

export interface LaneSignalBuilder<TIn = any, TPayload = any> {
  update(mapper: (current: TIn, signalPayload: TPayload) => TIn): LaneSignalBuilder<TIn, TPayload>;
  rewindTo(stepId: string, opts?: { readonly onRewind?: ScopeRewindHook<any> }): LaneSignalBuilder<TIn, TPayload>;
}

export interface LaneDef<TIn = any> {
  readonly kind: 'harness:lane';
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
  input<TSchema extends z.ZodTypeAny>(schema: TSchema): LaneDef<z.infer<TSchema>>;
  key(mapper: (item: TIn) => string): LaneDef<TIn>;
  tracker<TExternal, TExternalState extends string>(
    adapter: TrackerAdapter<TExternal, TExternalState>,
    configure: (
      $: LaneTrackerBuilder<TExternal, TIn, TExternalState>,
    ) => LaneTrackerBuilder<TExternal, TIn, TExternalState>,
  ): LaneDef<TIn>;
  flow(flow: FlowDef<TIn, any, any, any, any>): LaneDef<TIn>;
  concurrency(limit: number): LaneDef<TIn>;
  priority(level: 'low' | 'normal' | 'high' | 'critical'): LaneDef<TIn>;
  agingMinutes(minutes: number): LaneDef<TIn>;
  waitFor(depsMapper: (item: TIn) => readonly string[], onAbandonedState: string): LaneDef<TIn>;
  maxCostUsd(
    limitUsd: number,
    approver: ScopedHumanTarget<z.infer<typeof BudgetApprovalSchema>>,
  ): LaneDef<TIn>;
  retry(configure: ($: LaneRetryBuilder) => LaneRetryBuilder): LaneDef<TIn>;
  onSignal<TPayload>(
    signal: SignalDef<TPayload>,
    configure: ($s: LaneSignalBuilder<TIn, TPayload>) => LaneSignalBuilder<TIn, TPayload>,
  ): LaneDef<TIn>;
}

export interface HarnessSignalHandlerConfig<TPayload = any> {
  readonly signal: SignalDef<TPayload>;
  readonly notifications: ReadonlyArray<{
    readonly human: HumanDef;
    readonly mapper: (sig: TPayload) => string;
  }>;
}

export interface HarnessSignalBuilder<TPayload = any> {
  notify(human: HumanDef, mapper: (sig: TPayload) => string): HarnessSignalBuilder<TPayload>;
}

export interface HarnessDef {
  readonly kind: 'harness:root';
  readonly id: string;
  readonly ledgerStore?: LedgerStore;
  readonly registeredPools: readonly unknown[];
  readonly registeredStreams: readonly StreamDef<any, any>[];
  readonly registeredLanes: readonly LaneDef<any>[];
  readonly signalHandlers: Readonly<Record<string, HarnessSignalHandlerConfig<any>>>;
  readonly controlPlaneAdapters: readonly ControlPlaneAdapter[];
  ledger(store: LedgerStore): HarnessDef;
  pools(...pools: unknown[]): HarnessDef;
  streams(...streams: StreamDef<any, any>[]): HarnessDef;
  lanes(...lanes: LaneDef<any>[]): HarnessDef;
  onSignal<TPayload>(
    signal: SignalDef<TPayload>,
    configure: ($sig: HarnessSignalBuilder<TPayload>) => HarnessSignalBuilder<TPayload>,
  ): HarnessDef;
  expose(...adapters: ControlPlaneAdapter[]): HarnessDef;
}

export interface StepExecutors {
  executeAgent: <TIn, TOut, TScope>(
    def: AgentDef<TIn, TOut, TScope>,
    input: TIn,
    ctx: StepContext<TScope>,
  ) => Promise<TOut>;
  executeLoop: <TIn, TOut, TScope>(
    def: LoopDef<TIn, TOut, TScope>,
    input: TIn,
    ctx: StepContext<TScope>,
  ) => Promise<TOut>;
}
