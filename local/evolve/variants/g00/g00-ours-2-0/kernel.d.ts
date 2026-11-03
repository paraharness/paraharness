declare module 'harness-dsl/kernel' {
  export type Duration = `${number}${'s' | 'm' | 'h' | 'd'}`;
  export type Position = 'pending' | 'active' | 'waiting' | 'terminal';
  export type Verdict = 'success' | 'failure' | 'neutral';
  export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled';
  export type BlockedReason = 'decision' | 'stepFailure' | 'budget' | 'interrupted' | 'definitionChanged';
  export type Effect = 'repeatable' | 'unrepeatable' | 'external';
  export type Intent = 'read' | 'edit' | 'shell' | 'web';
  export type Trust = 'experience' | 'taste';
  export type LeaseMode = 'exclusive' | 'shared';
  export type ResolverSort = 'human' | 'policy' | 'clock';
  export type PolicySort = 'pool' | 'seat' | 'schedule' | 'recall' | 'halt';
  export type Column =
    | 'kind' | 'lane' | 'state' | 'model' | 'seat' | 'resource' | 'halt'
    | 'resolver' | 'account' | 'runner' | 'step';
  export type Field = 'costUsd' | 'durationSeconds' | 'waitSeconds' | 'tokens';

  export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

  export interface EntityRef<E extends string = string> {
    readonly entity: E;
    readonly name: string;
  }

  export interface ModelRef extends EntityRef<'model'> {
    readonly id: string;
  }

  export interface EnvRef { readonly ref: 'env'; readonly name: string }
  export interface PortRef { readonly ref: 'port'; readonly index: number }
  export type Setting = string | EnvRef | PortRef;

  export interface ResolveContext {
    resolve(setting: Setting): string;
  }

  export interface Closer {
    close(): Promise<void>;
  }

  export interface Retry {
    readonly tries: number;
    readonly backoff: 'none' | 'linear' | 'exponential';
    readonly delaySeconds?: number;
  }

  export interface UnitRef {
    readonly id: string;
    readonly key: string;
    readonly kind: EntityRef<'work'>;
    readonly lane: EntityRef<'lane'>;
  }

  export interface UnitView<D> extends UnitRef {
    readonly data: D;
    readonly state: string;
    readonly position: Position;
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly facets: Readonly<Record<string, string>>;
  }

  export interface AttemptView {
    readonly id: string;
    readonly unit: UnitRef;
    readonly startedAt: Date;
    readonly endedAt: Date | undefined;
    readonly outcome: AttemptOutcome | undefined;
    readonly costUsd: number;
    readonly durationSeconds: number;
    readonly step: string | undefined;
  }

  export interface ChildResult {
    readonly unit: UnitRef;
    readonly state: string;
    readonly verdict: Verdict | undefined;
  }

  export interface StoredUnit {
    readonly data: unknown;
    readonly state: string;
  }

  export interface CeilingContext { readonly spentUsd: number; readonly maxUsd: number }
  export interface CeilingDecision { readonly continue: boolean; readonly extraUsd?: number }

  export interface Entered<D> {
    readonly unit: UnitView<D>;
    readonly state: string;
    readonly attempt: AttemptView | undefined;
  }
  export interface Streak<D> {
    readonly units: readonly UnitView<D>[];
    readonly key: string | undefined;
  }
  export interface Due<D> {
    readonly unit: UnitView<D>;
    readonly deadline: Date;
  }
  export interface Crossed {
    readonly metric: EntityRef<'metric'>;
    readonly direction: 'falls' | 'rises';
    readonly value: number;
    readonly samples: number;
    readonly key: string | undefined;
  }
  export interface HaltOpened<C> {
    readonly halt: EntityRef<'halt'>;
    readonly unit: UnitView<unknown>;
    readonly attempt: AttemptView;
    readonly context: C;
    readonly openedAt: Date;
  }
  export interface HaltResolved<C, D> {
    readonly halt: EntityRef<'halt'>;
    readonly unit: UnitView<unknown>;
    readonly attempt: AttemptView;
    readonly context: C;
    readonly decision: D;
    readonly resolver: ResolverSort;
    readonly client: string | undefined;
    readonly openedAt: Date;
    readonly resolvedAt: Date;
  }

  export interface Scope {
    readonly kinds?: ReadonlyArray<EntityRef<'work'>>;
    readonly roles?: ReadonlyArray<EntityRef<'role'>>;
    readonly skills?: ReadonlyArray<EntityRef<'skill'>>;
    readonly resources?: ReadonlyArray<EntityRef<'resource'>>;
  }

  export interface MemoryItem<C> {
    readonly id: string;
    readonly kind: EntityRef<'memory'>;
    readonly trust: Trust;
    readonly created: Date;
    readonly when: Scope;
    readonly status: 'candidate' | 'accepted';
    readonly content: C;
  }

  export interface MemoryDraft<C> {
    readonly content: C;
    readonly when?: Scope;
    readonly status?: 'candidate' | 'accepted';
  }

  export interface JournalRef<C> extends EntityRef<'journal'> {
    readonly __content?: (content: C) => void;
  }

  export interface ShResult {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
  }

  export interface CommandContext extends ResolveContext {
    readonly now: Date;
    readonly unit: UnitRef;
    readonly attempt: { readonly id: string; readonly step: string };
    readonly runner: string;
    readonly signal: AbortSignal;
    sh(command: string, options?: { readonly cwd?: string; readonly timeoutSeconds?: number; readonly stdin?: string }): Promise<ShResult>;
    record<C>(journal: JournalRef<C>, draft: MemoryDraft<C>): Promise<void>;
  }

  export type JobStatus<O> =
    | { readonly status: 'running' }
    | { readonly status: 'done'; readonly output: O }
    | { readonly status: 'failed'; readonly reason: string };

  export interface Reading {
    readonly value: number | undefined;
    readonly samples: number;
  }

  export interface GroupReading extends Reading {
    readonly key: string;
  }

  export interface Where {
    readonly kind?: EntityRef<'work'>;
    readonly lane?: EntityRef<'lane'>;
    readonly state?: EntityRef<'state'>;
    readonly seat?: EntityRef<'seat'>;
    readonly model?: ModelRef;
    readonly resource?: EntityRef<'resource'>;
    readonly halt?: EntityRef<'halt'>;
    readonly account?: EntityRef<'account'>;
    readonly resolver?: ResolverSort;
    readonly facet?: { readonly facet: EntityRef<'facet'>; readonly value: string };
  }

  export interface MetricQuery {
    readonly window?: Duration | { readonly since: Date };
    readonly where?: Where;
  }

  export interface MetricsView {
    read(metric: EntityRef<'metric'>, query?: MetricQuery): Reading;
    group(metric: EntityRef<'metric'>, query: MetricQuery & { readonly by: Column | EntityRef<'facet'> }): readonly GroupReading[];
  }

  export type EventSet =
    | { readonly events: 'attempts'; readonly outcome?: AttemptOutcome }
    | { readonly events: 'terminal'; readonly verdict?: Verdict }
    | { readonly events: 'entered'; readonly states: ReadonlyArray<EntityRef<'state'>> }
    | { readonly events: 'created' }
    | { readonly events: 'steps'; readonly step: string; readonly outcome?: AttemptOutcome }
    | { readonly events: 'decisions'; readonly halt: EntityRef<'halt'>; readonly match?: (decision: unknown) => boolean; readonly resolver?: ResolverSort }
    | { readonly events: 'invocations'; readonly outcome?: 'succeeded' | 'failed' }
    | { readonly events: 'pauses' }
    | { readonly events: 'jobs' }
    | { readonly events: 'leases' };

  export interface MetricDefinition extends EntityRef<'metric'> {
    readonly formula: 'rate' | 'count' | 'sum' | 'mean' | 'median';
    readonly events: EventSet;
    readonly of?: EventSet;
    readonly field?: Field;
  }

  export interface AccountView {
    readonly account: EntityRef<'account'>;
    readonly eligible: boolean;
    readonly utilization: number;
    readonly usedShare: number;
    readonly maxQuotaShare: number;
    readonly windowResetsAt: Date | undefined;
    readonly cooldownUntil: Date | undefined;
  }

  export interface Candidate {
    readonly unit: UnitView<unknown>;
    readonly lane: EntityRef<'lane'>;
    readonly waitingSeconds: number;
  }

  export interface RunningView {
    readonly unit: UnitRef;
    readonly lane: EntityRef<'lane'>;
    readonly startedAt: Date;
    readonly step: string | undefined;
  }

  export interface RecallCandidate {
    readonly item: MemoryItem<unknown>;
    readonly specificity: number;
    readonly similarity: number | undefined;
    readonly trackRecord: { readonly present: number; readonly succeeded: number };
  }

  export interface PoolPolicyInput {
    readonly candidates: readonly AccountView[];
    readonly model: ModelRef;
    readonly metrics: MetricsView;
    readonly now: Date;
  }

  export interface SeatPolicyInput {
    readonly candidates: readonly ModelRef[];
    readonly seat: EntityRef<'seat'>;
    readonly unit: UnitView<unknown>;
    readonly metrics: MetricsView;
    readonly now: Date;
  }

  export interface SchedulePolicyInput {
    readonly candidates: readonly Candidate[];
    readonly running: readonly RunningView[];
    readonly metrics: MetricsView;
    readonly now: Date;
  }

  export interface RecallInput {
    readonly candidates: readonly RecallCandidate[];
    readonly scope: Scope;
    readonly query: string;
    readonly metrics: MetricsView;
    readonly now: Date;
  }

  export interface HaltPolicyInput<C> {
    readonly context: C;
    readonly unit: UnitView<unknown>;
    readonly metrics: MetricsView;
    readonly now: Date;
  }

  export interface PolicyRecord {
    readonly policy: EntityRef<'policy'>;
    readonly sort: PolicySort;
    readonly reads: ReadonlyArray<{ readonly metric: string; readonly query: Json; readonly value: number | null; readonly samples: number }>;
    readonly decision: Json;
  }

  export interface StepAddress {
    readonly attempt: string;
    readonly path: string;
    readonly flowHash: string;
  }

  export interface StepRecord {
    readonly address: StepAddress;
    readonly status: 'started' | 'submitted' | 'completed' | 'failed';
    readonly effect: Effect | 'invocation' | 'job' | 'halt' | 'spawn';
    readonly output: Json | undefined;
    readonly ref: string | undefined;
  }

  export type LedgerEventType =
    | 'run.started' | 'run.stopped'
    | 'unit.created' | 'unit.updated' | 'unit.moved'
    | 'attempt.started' | 'attempt.blocked' | 'attempt.unblocked' | 'attempt.ended'
    | 'step.started' | 'step.completed' | 'step.failed'
    | 'invocation' | 'job.submitted' | 'job.collected'
    | 'halt.opened' | 'halt.resolved'
    | 'lease.requested' | 'lease.acquired' | 'lease.released'
    | 'timer.armed' | 'timer.fired'
    | 'trigger.fired' | 'policy.decided'
    | 'lane.paused' | 'lane.resumed'
    | 'facet.set'
    | 'memory.recorded' | 'memory.curated'
    | 'operation.called';

  export interface LedgerEventInput {
    readonly type: LedgerEventType;
    readonly unit?: string;
    readonly attempt?: string;
    readonly address?: StepAddress;
    readonly columns: Partial<Readonly<Record<Column, string>>>;
    readonly facets: Readonly<Record<string, string>>;
    readonly data: Json;
  }

  export interface LedgerEvent extends LedgerEventInput {
    readonly seq: number;
    readonly at: Date;
    readonly run: string;
  }

  export interface LedgerQuery {
    readonly types?: readonly LedgerEventType[];
    readonly unit?: string;
    readonly attempt?: string;
    readonly afterSeq?: number;
    readonly since?: Date;
  }

  export interface Claim {
    readonly instance: string;
    readonly host: string;
    readonly acquiredAt: Date;
  }

  export type ClaimResult =
    | { readonly granted: true; readonly claim: Claim; readonly tookOverFrom: Claim | undefined }
    | { readonly granted: false; readonly holder: Claim; readonly lastHeartbeat: Date };

  export interface Ledger {
    readonly name: string;
    claim(instance: string, staleAfterSeconds: number): Promise<ClaimResult>;
    heartbeat(claim: Claim): Promise<void>;
    append(claim: Claim, events: readonly LedgerEventInput[]): Promise<readonly LedgerEvent[]>;
    read(query: LedgerQuery): AsyncIterable<LedgerEvent>;
    step(address: StepAddress): Promise<StepRecord | undefined>;
    release(claim: Claim): Promise<void>;
  }

  export interface QuotaEvent {
    readonly account: string;
    readonly harness: string;
    readonly at: Date;
    readonly type: 'consumed' | 'limited' | 'reset';
    readonly tokens?: number;
    readonly utilization?: number;
    readonly resetsAt?: Date;
    readonly cooldownUntil?: Date;
  }

  export interface QuotaPartition {
    readonly name: string;
    append(event: QuotaEvent): Promise<void>;
    read(account: string, since: Date): Promise<readonly QuotaEvent[]>;
  }

  export interface Store {
    readonly name: string;
    load(unit: UnitRef): Promise<StoredUnit | undefined>;
    save(unit: UnitRef, change: StoredUnit): Promise<void>;
  }

  export interface SupplySink<R> {
    offer(raw: R): Promise<void>;
  }

  export interface Supplier<R> {
    readonly name: string;
    open(sink: SupplySink<R>, ctx: ResolveContext & { readonly signal: AbortSignal }): Promise<Closer>;
  }

  export interface MemoryStore {
    readonly name: string;
    put(item: MemoryItem<unknown>): Promise<void>;
    list(filter: { readonly kind: string; readonly status?: 'candidate' | 'accepted' }): Promise<readonly MemoryItem<unknown>[]>;
    search?(query: string, filter: { readonly kind: string; readonly limit: number }): Promise<ReadonlyArray<{ readonly id: string; readonly similarity: number }>>;
    update(id: string, patch: { readonly content?: unknown; readonly when?: Scope; readonly status?: 'candidate' | 'accepted' }): Promise<void>;
    remove(id: string): Promise<void>;
  }

  export interface Policy<I, O> extends EntityRef<'policy'> {
    readonly sort: PolicySort;
    decide(input: I): O;
  }

  export interface Usage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly batch: boolean;
  }

  export interface Pricing {
    costUsd(model: ModelRef, usage: Usage): number;
  }

  export interface InvocationRequest {
    readonly address: StepAddress;
    readonly model: ModelRef;
    readonly role: { readonly name: string; readonly prompt: string; readonly intents: readonly Intent[] };
    readonly skill: { readonly name: string; readonly prompt: string; readonly outputSchema: Json };
    readonly memory: ReadonlyArray<MemoryItem<unknown>>;
    readonly recordable: ReadonlyArray<EntityRef<'memory'>>;
  }

  export interface InvocationResult {
    readonly outcome: 'succeeded' | 'failed';
    readonly output: unknown;
    readonly usage: Usage;
    readonly error: string | undefined;
    readonly sessionRef: string | undefined;
  }

  export interface DriverContext extends ResolveContext {
    readonly account: EntityRef<'account'>;
    readonly cwd: string | undefined;
    readonly plugins: readonly AgentPlugin[];
    readonly plugin: PluginContext;
    readonly signal: AbortSignal;
    reportQuota(event: Omit<QuotaEvent, 'account' | 'harness' | 'at'>): void;
  }

  export interface ModelDriver {
    readonly name: string;
    invoke(request: InvocationRequest, ctx: DriverContext): Promise<InvocationResult>;
    recover(address: StepAddress, sessionRef: string | undefined, ctx: DriverContext): Promise<InvocationResult | 'running' | 'unknown'>;
    submitBatch?(requests: readonly InvocationRequest[], ctx: DriverContext): Promise<string>;
    collectBatch?(ref: string, ctx: DriverContext): Promise<JobStatus<readonly InvocationResult[]>>;
  }

  export interface PluginContext {
    readonly unit: UnitRef;
    readonly attempt: { readonly id: string; readonly step: string };
    sh(command: string, options?: { readonly cwd?: string }): Promise<ShResult>;
    lease(resource: EntityRef<'resource'>, mode: LeaseMode): Promise<boolean>;
  }

  export interface AgentPlugin {
    readonly name: string;
    prepare?(ctx: PluginContext): Promise<{ readonly cwd?: string }>;
    beforeWrite?(path: string, ctx: PluginContext): Promise<{ readonly allow: true } | { readonly allow: false; readonly reason: string }>;
    beforeStop?(ctx: PluginContext): Promise<{ readonly stop: true } | { readonly stop: false; readonly feedback: string }>;
    finish?(ctx: PluginContext, outcome: AttemptOutcome): Promise<void>;
  }

  export interface Runner {
    readonly name: string;
    readonly slots: number;
    exec(command: string, options: { readonly cwd?: string; readonly env: Readonly<Record<string, string>>; readonly stdin?: string; readonly signal: AbortSignal }): Promise<ShResult>;
  }

  export interface OperationInfo {
    readonly name: string;
    readonly description: string;
    readonly input: Json;
  }

  export interface ControlApi {
    readonly harness: string;
    readonly client: string;
    readonly operations: readonly OperationInfo[];
    call(operation: string, input: unknown): Promise<unknown>;
  }

  export interface Client extends EntityRef<'client'> {
    readonly transport: string;
    serve(api: ControlApi): Promise<Closer>;
  }

  export interface BlockedView {
    readonly attempt: AttemptView;
    readonly reason: BlockedReason;
    readonly halt: EntityRef<'halt'> | undefined;
    readonly since: Date;
    readonly detail: string;
  }

  export interface LaneBoard {
    readonly lane: EntityRef<'lane'>;
    readonly paused: { readonly since: Date; readonly reason: string; readonly value: number | undefined; readonly samples: number | undefined } | undefined;
    readonly units: Readonly<Record<Position, ReadonlyArray<UnitView<unknown>>>>;
    readonly blocked: readonly BlockedView[];
  }

  export interface BoardView {
    readonly harness: string;
    readonly lanes: readonly LaneBoard[];
    readonly metrics: MetricsView;
  }

  export interface Observer {
    readonly name: string;
    observe(event: LedgerEvent, board: BoardView): Promise<void>;
  }

  export interface RunningHarness {
    readonly name: string;
    readonly metrics: MetricsView;
    stop(): Promise<void>;
  }
}
