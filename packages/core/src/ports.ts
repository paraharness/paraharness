import { z } from 'zod';

export interface EnvRef {
  readonly kind: 'harness:env-ref';
  readonly key: string;
}

export interface ResolutionContext {
  readonly runId: string;
  readonly activePartitions: readonly string[];
  readonly observedEffects: readonly ToolEffect[];
  readonly scopeHandle?: unknown;
}

export interface Source<T> {
  readonly kind: 'harness:source';
  readonly id: string;
  load(ctx: ResolutionContext): Promise<{
    readonly data: T;
    readonly digest: string;
  }>;
}

export type MaybeSource<T> = T | Source<T>;

export interface ToolEffect {
  readonly kind: string;
  readonly mutatesScope?: boolean;
  readonly attributes?: Readonly<Record<string, unknown>>;
}

export interface EffectMatcher {
  readonly kind: 'harness:effect-matcher';
  readonly id: string;
  matches(effect: ToolEffect): boolean;
}

export interface LeaseDelta {
  readonly kind: 'harness:lease-delta';
  readonly id: string;
  readonly grantedMatchers: readonly EffectMatcher[];
}

export interface PolicyGuard {
  readonly kind: 'harness:policy-guard';
  readonly id: string;
  evaluate(op: {
    readonly toolName: string;
    readonly proposedEffects: readonly ToolEffect[];
    readonly activeLeases: readonly LeaseDelta[];
  }): {
    readonly allowed: boolean;
    readonly violatedEffects: readonly ToolEffect[];
    readonly violationSummary: string;
  };
}

export interface QuotaTripwire {
  readonly kind: 'harness:quota-tripwire';
  readonly id: string;
  onToolEffects(
    accumulatedEffects: readonly ToolEffect[],
    newEffects: readonly ToolEffect[],
  ): {
    readonly tripped: boolean;
    readonly reason?: string;
  };
}

export interface TelemetryCollector<TMetrics extends Record<string, unknown> = Record<string, unknown>> {
  readonly kind: 'harness:telemetry-collector';
  readonly id: string;
  readonly schema: z.ZodType<TMetrics, z.ZodTypeDef, any>;
  collect(effects: readonly ToolEffect[]): TMetrics;
}

export interface AbortHook<THandle = any, TAbortMeta extends Record<string, unknown> = Record<string, unknown>> {
  readonly kind: 'harness:abort-hook';
  readonly id: string;
  readonly metaSchema: z.ZodType<TAbortMeta, z.ZodTypeDef, any>;
  execute(handle: THandle, runId: string, stepExecId?: string): Promise<TAbortMeta>;
}

export interface ScopeRewindHook<THandle = any> {
  readonly kind: 'harness:scope-rewind-hook';
  readonly id: string;
  onRewind(handle: THandle, targetCheckpoint?: string): Promise<void>;
}

export interface ExecutionContext<THandle = any> {
  readonly runId: string;
  readonly stepExecId: string;
  readonly scopeHandle: THandle;
  readonly activePartitions: readonly string[];
  readonly activeLeases: readonly LeaseDelta[];
  readonly seededHistory?: readonly WireFrameRecord[];
  readonly resumeContinuationStack?: readonly ContinuationFrame[];
  recordEffects(effects: readonly ToolEffect[]): void;
}

export type StepContext<THandle = any> = ExecutionContext<THandle>;

export interface StepExecutable<TIn = any, TOut = any, THandle = any> {
  readonly kind: 'harness:step-executable';
  readonly id: string;
  readonly inputSchema: z.ZodType<TIn, z.ZodTypeDef, any>;
  readonly outputSchema: z.ZodType<TOut, z.ZodTypeDef, any>;
  extractPartitions?(input: TIn): readonly string[];
  execute(input: TIn, ctx: ExecutionContext<THandle>): Promise<TOut>;
}

export interface Check<THandle = any> {
  readonly kind: 'harness:check';
  readonly id: string;
  run(ctx: {
    readonly scopeHandle: THandle;
    readonly observedEffects: readonly ToolEffect[];
  }): Promise<{
    readonly ok: boolean;
    readonly deficits: readonly string[];
  }>;
}

export interface ToolDefinition<THandle = any> {
  readonly kind: 'harness:tool';
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodTypeAny;
  describeEffects?(args: unknown, scopeHandle: THandle): readonly ToolEffect[] | Promise<readonly ToolEffect[]>;
  execute(args: unknown, ctx: ExecutionContext<THandle>): Promise<{
    readonly content: string;
    readonly isError?: boolean;
  }>;
}

export interface ServiceSession<THandle = any> {
  readonly id: string;
  readonly tools: readonly ToolDefinition<THandle>[];
  stop(): Promise<void>;
}

export interface Service<THandle = any> {
  readonly kind: 'harness:service';
  readonly id: string;
  readonly lifecycle: 'scope' | 'fork' | 'skill';
  readonly toolSchemas: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchema: z.ZodTypeAny;
  }>;
  acquire(ctx: {
    readonly runId: string;
    readonly scopeKey: string;
    readonly scopeHandle: THandle;
  }): Promise<ServiceSession<THandle>>;
}

export type ReconcileResult<TData> =
  | {
      readonly status: 'clean';
      readonly data: TData;
    }
  | {
      readonly status: 'conflict';
      readonly conflictedSummary: string;
      readonly conflictedPaths?: readonly string[];
      readonly data: TData;
    };

export interface IsolationScope<
  THandle = any,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly kind: 'harness:isolation-scope';
  readonly id: string;
  readonly receiptSchema: z.ZodType<TReceipt, z.ZodTypeDef, any>;
  acquireRoot(runId: string): Promise<THandle>;
  reattachRoot(runId: string, checkpoint?: string): Promise<THandle>;
  inspect(handle: THandle): Promise<TReceipt>;
  release(handle: THandle): Promise<void>;
}

export interface CheckpointableScope<
  THandle = any,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
> extends IsolationScope<THandle, TReceipt> {
  readonly supportsCheckpoints: true;
  serializeCheckpoint(handle: THandle): Promise<string>;
  restoreCheckpoint(handle: THandle, checkpoint: string): Promise<void>;
  diffEffects(fromCheckpoint: string, handle: THandle): Promise<readonly ToolEffect[]>;
}

export interface BranchableScope<
  THandle = any,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TSync extends Record<string, unknown> = Record<string, unknown>,
> extends IsolationScope<THandle, TReceipt> {
  readonly supportsBranching: true;
  readonly syncSchema: z.ZodType<TSync, z.ZodTypeDef, any>;
  forkChild(parent: THandle, forkId: string): Promise<THandle>;
  reattachChild(parent: THandle, forkId: string, checkpoint?: string): Promise<THandle>;
  commitChild(child: THandle, parent: THandle): Promise<ReconcileResult<TReceipt>>;
  syncChild(parent: THandle, pausedChild: THandle): Promise<ReconcileResult<TSync>>;
  syncRoot(rootHandle: THandle, prerequisiteReceipts: readonly TReceipt[]): Promise<ReconcileResult<TSync>>;
  conflictCleanCheck?: Check<THandle>;
}

export interface CrossVerifier<
  THandle = any,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TCrossReport = unknown,
> {
  readonly kind: 'harness:cross-verifier';
  readonly reportSchema: z.ZodType<TCrossReport, z.ZodTypeDef, any>;
  verifyCandidates(
    candidates: ReadonlyArray<{
      readonly branchIndex: number;
      readonly scopeHandle: THandle;
      readonly receipt: TReceipt;
    }>,
  ): Promise<ReadonlyArray<TCrossReport>>;
}

export interface PartitionGlobEntry {
  readonly globs: readonly string[];
  readonly boundaryGlobs: readonly string[];
}

export interface PartitionMap<TPartition extends string = string> {
  readonly kind: 'fs:partition-map';
  readonly topologyId: string;
  readonly partitions: Readonly<Record<TPartition, PartitionGlobEntry>>;
  getPartitionForPath(relativePath: string): TPartition | undefined;
  isBoundaryPath(relativePath: string): { readonly isBoundary: boolean; readonly partition?: TPartition };
}

export interface AccountSeatDescriptor {
  readonly kind: 'harness:account-seat' | 'claude:account-seat' | 'openai:account-seat' | 'gemini:account-seat';
  readonly id: string;
  readonly configDirPath?: string;
  readonly apiKeyRef?: EnvRef | string;
}

export interface ModelDescriptor {
  readonly kind: 'harness:model';
  readonly alias: string;
  readonly modelId: string;
  readonly driver: ModelDriver;
  readonly accountPoolDef?: unknown;
}

export interface PoolCandidateState<TItem = unknown> {
  readonly item: TItem;
  readonly index: number;
  readonly id: string;
  readonly rateLimitedUntilMs?: number;
  readonly usageCount: number;
  readonly lastUsedAtMs?: number;
  readonly successCount: number;
  readonly sampleCount: number;
  readonly empiricalSuccessRate: number;
}

export interface PoolSelectionContext {
  readonly poolId: string;
  readonly runId: string;
  readonly retryAttempt: number;
  readonly nowMs: number;
  readonly stickyCandidateId?: string;
}

export type PoolSelectorFn<TItem = unknown> = (
  candidates: readonly PoolCandidateState<TItem>[],
  ctx: PoolSelectionContext,
) => TItem | undefined;

export interface PoolStrategyPort<TItem = unknown> {
  readonly kind: 'harness:pool-strategy';
  readonly id: string;
  select(
    candidates: readonly PoolCandidateState<TItem>[],
    ctx: PoolSelectionContext,
  ): TItem | undefined;
}

export interface CanonicalMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool';
  readonly visibleText: string;
  readonly toolCalls?: ReadonlyArray<{ id: string; name: string; argsJson: string }>;
  readonly toolResults?: ReadonlyArray<{ callId: string; content: string; isError: boolean }>;
}

export interface WireFrameRecord {
  readonly messageId: string;
  readonly parentMessageId: string | null;
  readonly vendorId: string;
  readonly rawWireFrame: Uint8Array;
  readonly canonical: CanonicalMessage;
  readonly prefixDigest: string;
  readonly compactedTombstones?: Readonly<Record<string, string>>;
}

export interface WireToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputJsonSchema: Readonly<Record<string, unknown>>;
}

export interface CompiledWirePrefix {
  readonly prefixGroupId: string;
  readonly toolsMode: 'role-scoped' | 'union';
  readonly systemPromptText: string;
  readonly systemDigest: string;
  readonly groundingSnapshots: ReadonlyArray<{
    readonly sourceId: string;
    readonly text: string;
    readonly digest: string;
  }>;
  readonly wireToolSchemasByRoleKey: Readonly<Record<string, readonly WireToolSchema[]>>;
}

export interface ForkContext {
  readonly historyMode: 'shared-prefix-only' | 'clone-transcript';
  readonly parentChain: readonly WireFrameRecord[];
  readonly forkPointMessageId: string | null;
  readonly wirePrefix?: CompiledWirePrefix;
  readonly roleKey?: string;
  readonly childRoleContextFrameText?: string;
  readonly forkCallId?: string;
  readonly siblingForkCallIds?: readonly string[];
  readonly precedingCompletedResults?: ReadonlyArray<{
    readonly callId: string;
    readonly content: string;
    readonly isError?: boolean;
  }>;
  readonly childTaskPromptText?: string;
}

export interface ModelDriver {
  readonly kind: 'harness:model-driver';
  readonly vendorId: 'anthropic' | 'openai' | 'google' | string;
  readonly vendor?: 'anthropic' | 'openai' | 'google' | string;
  invokeTurn(req: {
    readonly modelId: string;
    readonly accountConfig?: unknown;
    readonly effort?: 'low' | 'medium' | 'high';
    readonly toolChoice?: 'auto' | 'none';
    readonly wirePrefix?: CompiledWirePrefix;
    readonly roleKey?: string;
    readonly history: readonly WireFrameRecord[];
    readonly wireToolSchemas?: readonly WireToolSchema[];
    readonly outputSchema?: z.ZodTypeAny;
  }): Promise<{
    readonly wireFrame: Uint8Array;
    readonly canonical: CanonicalMessage;
    readonly structuredOutput?: unknown;
    readonly usage: {
      readonly inputTokens: number;
      readonly cachedInputTokens: number;
      readonly outputTokens: number;
      readonly costUsd: number;
    };
  }>;
  prepareFork(
    ctx: ForkContext,
    target: {
      readonly modelId: string;
      readonly accountConfig?: unknown;
      readonly effort?: 'low' | 'medium' | 'high';
      readonly substituteTombstones: boolean;
    },
  ): Promise<readonly WireFrameRecord[]>;
  appendToolResultNotes(
    frame: WireFrameRecord,
    notes: readonly string[],
    targetCallId?: string,
    opts?: { readonly isError?: boolean },
  ): Promise<WireFrameRecord>;
}

export interface UniversalStepTelemetry<
  TCustomMetrics extends Record<string, unknown> = Record<string, unknown>,
  TAbortMeta extends Record<string, unknown> = Record<string, unknown>,
> {
  readonly turnsTaken: number;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly custom: TCustomMetrics;
  readonly abortMeta?: TAbortMeta;
}

export interface PendingPreFlightCall {
  readonly callId: string;
  readonly toolName: string;
  readonly argsJson: string;
  readonly violatedEffects: readonly ToolEffect[];
  readonly violationSummary: string;
}

export interface PendingToolBatch {
  readonly completedResults: ReadonlyArray<{
    readonly callId: string;
    readonly content: string;
    readonly isError?: boolean;
  }>;
  readonly blockedCalls: readonly PendingPreFlightCall[];
  readonly activeInterruptCallId?: string;
  readonly adjudicationFeedback?: string;
  readonly remainingCalls: ReadonlyArray<{
    readonly callId: string;
    readonly toolName: string;
    readonly argsJson: string;
    readonly blockedPreFlight?: boolean;
    readonly adjudicatedClauseIds?: readonly string[];
  }>;
}

export type ContinuationFrame =
  | {
      readonly kind: 'agent-frame';
      readonly agentId: string;
      readonly roleKey: string;
      readonly modelId: string;
      readonly stepExecId: string;
      readonly inputJson: string;
      readonly leafMessageId: string | null;
      readonly turnsTaken: number;
      readonly costUsd: number;
      readonly elapsedDurationMs: number;
      readonly activeLeases: readonly LeaseDelta[];
      readonly activeSkillIds: readonly string[];
      readonly activeSkillActivations: Readonly<Record<string, { readonly messageId: string; readonly callId: string }>>;
      readonly observedEffects: readonly ToolEffect[];
      readonly injectedScopedRuleIds: readonly string[];
      readonly pausedAtPhase: 'TOOL_BOUNDARY' | 'BEFORE_STOP_GATE' | 'LIMIT_EXCEEDED_FLUSH';
      readonly limitExceededInterruptId?: string;
      readonly flushedInterruptPayloadJson?: string;
      readonly conflictCheckArmed?: boolean;
      readonly neutralSyncContinuation?: boolean;
      readonly syncedToPrerequisiteCheckpoint?: string;
      readonly pendingToolBatch?: PendingToolBatch;
      readonly inFlightPreToolCheckpoint?: string;
      readonly lastGateFailureJson?: string;
      readonly bufferedGateRecoveries?: ReadonlyArray<unknown>;
      readonly accumulatedLessonOutcomes?: Readonly<Record<string, LessonOutcome>>;
      readonly pendingAdjudication?: {
        readonly interruptId: string;
        readonly interruptPayloadJson: string;
        readonly humanRequestId?: string;
        readonly adjudicatorStack?: readonly ContinuationFrame[];
      };
    }
  | {
      readonly kind: 'loop-frame';
      readonly loopId: string;
      readonly roleKey: string;
      readonly lastActModelId?: string;
      readonly stepExecId: string;
      readonly loopInputJson: string;
      readonly iteration: number;
      readonly phase: 'act' | 'evaluate';
      readonly preservedActLeafMessageId: string | null;
      readonly turnsTaken: number;
      readonly costUsd: number;
      readonly elapsedDurationMs: number;
      readonly actTurnsTaken: number;
      readonly actCostUsd: number;
      readonly actElapsedDurationMs: number;
      readonly grantedLoopLeases: readonly LeaseDelta[];
      readonly activeSkillIds: readonly string[];
      readonly activeSkillActivations: Readonly<Record<string, { readonly messageId: string; readonly callId: string }>>;
      readonly observedEffects: readonly ToolEffect[];
      readonly injectedScopedRuleIds: readonly string[];
      readonly conflictCheckArmed?: boolean;
      readonly recalledLessons: ReadonlyArray<{
        readonly id: string;
        readonly partition?: string;
        readonly directive: string;
      }>;
      readonly lastRejectedIterationJson?: string;
      readonly bufferedGateRecoveries?: ReadonlyArray<unknown>;
      readonly accumulatedLessonOutcomes: Readonly<Record<string, LessonOutcome>>;
    }
  | {
      readonly kind: 'fork-batch-frame';
      readonly parentStepExecId: string;
      readonly pendingPauseTrigger?: {
        readonly triggeredByForkId: string;
        readonly interruptId: string;
        readonly interruptPayloadJson: string;
        readonly affectedPartitions: readonly string[];
      };
      readonly forks: ReadonlyArray<{
        readonly forkId: string;
        readonly suspendedForkId?: string;
        readonly callId: string;
        readonly toolName: string;
        readonly activePartitions: readonly string[];
        readonly status: 'RUNNING' | 'CHILD_COMMITTED' | 'COMPLETED' | 'SUSPENDED' | 'FAILED' | 'ABORTED';
        readonly conflictRetryCount: number;
        readonly conflictCheckArmed: boolean;
        readonly suspensionEpoch: number;
        readonly syncedToParentCheckpoint?: string;
        readonly syncResultJson?: string;
        readonly resumeFrameInjected?: boolean;
        readonly childScopeCheckpoint?: string;
        readonly outputJson?: string;
        readonly committedReceiptJson?: string;
        readonly toolResultJson?: string;
        readonly lessonsFlushed?: boolean;
        readonly continuationStack: readonly ContinuationFrame[];
      }>;
    }
  | {
      readonly kind: 'speculate-frame';
      readonly parentStepExecId: string;
      readonly callId: string;
      readonly toolName: string;
      readonly phase: 'RACING' | 'CROSS_VERIFYING' | 'ARBITRATING' | 'REFINING_WINNER' | 'COMMITTING';
      readonly winnerBranchIndex?: number;
      readonly preRefinementCheckpoint?: string;
      readonly conflictRetryCount: number;
      readonly conflictCheckArmed: boolean;
      readonly lessonsFlushed?: boolean;
      readonly activeSubStack?: readonly ContinuationFrame[];
      readonly branches: ReadonlyArray<{
        readonly branchIndex: number;
        readonly forkId: string;
        readonly status:
          | 'RUNNING'
          | 'COMPLETED'
          | 'FAILED'
          | 'PARKED_ON_ESCALATION'
          | 'WINNER_COMMITTED';
        readonly childScopeCheckpoint?: string;
        readonly outputJson?: string;
        readonly scopeReceiptJson?: string;
        readonly errorSummary?: string;
        readonly parkedInterruptId?: string;
        readonly parkedEscalationPayloadJson?: string;
        readonly continuationStack: readonly ContinuationFrame[];
      }>;
      readonly humanRulingsHistory: ReadonlyArray<{
        readonly branchIndex: number;
        readonly interruptId: string;
        readonly rulingSummary: string;
      }>;
      readonly bufferedLessonOutcomes?: ReadonlyArray<{
        readonly branchIndex: number;
        readonly outcomes: ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>;
      }>;
    };

export interface SuspendedForkRecord {
  readonly suspendedForkId: string;
  readonly forkId: string;
  readonly suspensionEpoch: number;
  readonly runId: string;
  readonly parentStepExecId: string;
  readonly forkToolName: string;
  readonly activePartitions: readonly string[];
  readonly suspensionReason: 'INTERRUPT_RAISED' | 'PAUSED_BY_SIBLING_INTERRUPT';
  readonly triggeredByForkId?: string;
  readonly raisedByPhase?: 'act' | 'evaluate';
  readonly conflictRetryCount: number;
  readonly conflictCheckArmed: boolean;
  readonly syncedToParentCheckpoint?: string;
  readonly syncResultJson?: string;
  readonly resumeFrameInjected?: boolean;
  readonly interruptId?: string;
  readonly interruptPayloadJson?: string;
  readonly suspendedAtCallId?: string;
  readonly childScopeCheckpoint?: string;
  readonly continuationStack: readonly ContinuationFrame[];
}

export interface LedgerStore {
  readonly kind: 'harness:ledger-store';
  createOrResumeRun(run: {
    readonly runId: string;
    readonly laneId: string;
    readonly itemKey: string;
    readonly inputJson: string;
    readonly compiledPrefixesJson?: Readonly<Record<string, string>>;
    readonly costUsd?: number;
    readonly approvedMaxCostUsd?: number;
  }): Promise<{
    readonly status: string;
    readonly currentStepId: string | null;
    readonly inputJson: string;
    readonly rewindPendingToStepId?: string;
    readonly compiledPrefixesJson?: Readonly<Record<string, string>>;
    readonly costUsd: number;
    readonly approvedMaxCostUsd?: number;
    readonly completedStepOutputsJson: ReadonlyMap<string, string>;
  }>;
  recordStepStart(step: {
    readonly stepExecId: string;
    readonly runId: string;
    readonly stepId: string;
    readonly inputMsgId: string | null;
    readonly baseScopeCheckpoint?: string;
    readonly continuationStack: readonly ContinuationFrame[];
  }): Promise<void>;
  updateContinuationStack(
    runId: string,
    stepExecId: string,
    continuationStack: readonly ContinuationFrame[],
  ): Promise<void>;
  appendMessageFrame(runId: string, frame: WireFrameRecord): Promise<void>;
  replaceMessageFrame(runId: string, frame: WireFrameRecord): Promise<void>;
  markFrameTombstone(
    runId: string,
    messageId: string,
    callId: string,
    compactedTombstone: string,
  ): Promise<void>;
  getMessageChain(leafMessageId: string): Promise<readonly WireFrameRecord[]>;
  recordForkSuspension(record: SuspendedForkRecord): Promise<void>;
  getSuspendedForks(
    runId: string,
    opts?: { readonly forkIds?: readonly string[]; readonly parentStepExecId?: string },
  ): Promise<readonly SuspendedForkRecord[]>;
  resolveSuspendedFork(suspendedForkId: string, status: 'RESUMED' | 'ABORTED'): Promise<void>;
  recordStepTransition(transition: {
    readonly stepExecId: string;
    readonly status: 'COMPLETED' | 'INTERRUPTED' | 'FAILED' | 'SUSPENDED';
    readonly outputJson?: string;
    readonly headScopeCheckpoint?: string;
    readonly telemetryJson: string;
    readonly pendingToolBatch?: PendingToolBatch;
  }): Promise<void>;
  recordRunTerminalReceipt(
    runId: string,
    itemKey: string,
    terminalState: string,
    scopeReceiptJson?: string,
  ): Promise<void>;
  getRunTerminalReceipts(
    itemKeys: readonly string[],
  ): Promise<ReadonlyMap<string, { readonly runId: string; readonly terminalState: string; readonly scopeReceiptJson?: string }>>;
  getInterruptedStepsOnBoot(): Promise<
    ReadonlyArray<{
      readonly runId: string;
      readonly stepExecId: string | null;
      readonly stepId: string | null;
      readonly baseScopeCheckpoint?: string;
      readonly headScopeCheckpoint?: string;
      readonly continuationStack: readonly ContinuationFrame[];
    }>
  >;
  compactRunFrames(runId: string): Promise<void>;
}

export interface CompactionSignalRuleConfig<TPayload = any> {
  readonly signal: {
    readonly kind: 'harness:signal';
    readonly id: string;
    readonly schema: z.ZodType<TPayload, z.ZodTypeDef, any>;
  };
  readonly correlateBy: (sig: TPayload) => string;
  readonly afterGracePeriodHours: number;
}

export interface CompactionRuleConfig {
  readonly signalRules: readonly CompactionSignalRuleConfig<any>[];
  readonly terminalExitRules: ReadonlyArray<{
    readonly states: readonly string[];
    readonly afterGracePeriodHours: number;
  }>;
  readonly retainFailedRunsDays?: number;
}

export interface LedgerCompactionBuilder {
  onSignal<TPayload>(
    signal: {
      readonly kind: 'harness:signal';
      readonly id: string;
      readonly schema: z.ZodType<TPayload, z.ZodTypeDef, any>;
    },
    opts: {
      readonly correlateBy: (sig: TPayload) => string;
      readonly afterGracePeriodHours: number;
    },
  ): LedgerCompactionBuilder;
  onTerminalExit(
    states: readonly string[],
    opts: { readonly afterGracePeriodHours: number },
  ): LedgerCompactionBuilder;
  retainFailedRunsForDays(days: number): LedgerCompactionBuilder;
}

export interface ConfigurableLedgerStore extends LedgerStore {
  readonly compactionConfig?: CompactionRuleConfig;
  compactWhen(configure: ($c: LedgerCompactionBuilder) => LedgerCompactionBuilder): ConfigurableLedgerStore;
  scheduleCompactionDeadline(
    runId: string,
    itemKey: string,
    compactAfterIso: string,
    awaitingMainMergeFromBranch?: string,
  ): Promise<void>;
  processDueCompactions(nowIso?: string): Promise<readonly string[]>;
  close?(): void;
}

export interface TopologyPartitionState {
  readonly partitionId: string;
  readonly epoch: number;
  readonly contractText: string;
  readonly updatedAt: string;
}

export interface TopologyStore {
  readonly kind: 'harness:topology-store';
  getPartitions(runId?: string): Promise<ReadonlyMap<string, TopologyPartitionState>>;
  updateContract(
    runId: string,
    partitionId: string,
    newContractText: string,
    stepExecId?: string,
  ): Promise<{ readonly newEpoch: number }>;
  syncRunOverlays(targetRunId: string, prerequisiteRunIds: readonly string[]): Promise<void>;
  resetRunOverlay(
    runId: string,
    opts?: { readonly scope?: 'step' | 'run'; readonly stepExecId?: string },
  ): Promise<void>;
  sealRunOverlay(runId: string): Promise<void>;
  commitRunOverlay(runId: string): Promise<{
    readonly committedRunIds: readonly string[];
    readonly updatedEpochs: ReadonlyMap<string, number>;
  }>;
  discardRunOverlay(runId: string): Promise<void>;
}

export type LessonOutcome =
  | 'clean_pass'
  | 'gate_rejected_recovered'
  | 'gate_rejected_unrecovered'
  | 'violated';

export interface DistilledLessonCandidate {
  readonly admit: boolean;
  readonly partition?: string;
  readonly directive?: string;
}

export interface LessonRecord {
  readonly id: string;
  readonly partition?: string;
  readonly directive: string;
  readonly epochAtCreation: number;
  readonly createdByRunId?: string;
  readonly recentOutcomes: ReadonlyArray<LessonOutcome>;
  readonly totalCleanPasses: number;
  readonly totalViolated: number;
  readonly relevanceScore?: number;
  readonly signalLastEmittedAt?: Readonly<Record<string, string>>;
}

export interface LessonStore {
  readonly kind: 'harness:lesson-store';
  queryCandidates(req: {
    readonly queryText: string;
    readonly partitions: readonly string[];
  }): Promise<readonly LessonRecord[]>;
  admit(lesson: {
    readonly partition?: string;
    readonly directive: string;
    readonly epochAtCreation: number;
    readonly createdByRunId?: string;
  }): Promise<string>;
  recordOutcomes(
    outcomes: ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>,
  ): Promise<ReadonlyArray<LessonRecord>>;
  syncCreationEpochsForRuns(
    runIds: readonly string[],
    updatedEpochs: ReadonlyMap<string, number>,
  ): Promise<void>;
  markSignalEmitted(lessonId: string, signalId: string, emittedAt: string): Promise<void>;
  retire(lessonIds: readonly string[]): Promise<void>;
}

export interface TrackerAdapter<TExternal = any, TExternalState extends string = string> {
  readonly kind: 'harness:tracker-adapter';
  poll(): Promise<readonly TExternal[]>;
  setExternalState(itemKey: string, state: TExternalState): Promise<void>;
}

export interface StreamSource<TEvent = any> {
  readonly kind: 'harness:stream-source';
  subscribe(onEvent: (event: TEvent) => Promise<void>): Promise<{ close(): Promise<void> }>;
}

export interface HumanAdapter {
  readonly kind: 'harness:human-adapter';
  notify(message: string): Promise<void>;
  requestDecision<TRequest, TResponse>(req: {
    readonly runId: string;
    readonly requestId: string;
    readonly humanId: string;
    readonly payload: TRequest;
    readonly responseSchema: z.ZodType<TResponse, z.ZodTypeDef, any>;
    readonly keepAliveSeconds?: number;
    readonly signal?: AbortSignal;
  }): Promise<TResponse>;
  cancelDecision?(runId: string, requestId: string): Promise<void>;
}

export interface ControlPlaneAdapter {
  readonly kind: 'harness:control-plane-adapter';
  start(runtime: HarnessRuntimeController): Promise<{ close(): Promise<void> }>;
}

export interface HarnessRuntimeController {
  emitSignal<TPayload>(signalId: string, payload: TPayload): Promise<void>;
  getActiveRuns(): Promise<ReadonlyArray<{ runId: string; laneId: string; itemKey: string; status: string }>>;
}
