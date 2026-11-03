declare module 'harness-dsl/kernel' {
  export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
  export type JsonObject = { readonly [key: string]: Json };

  export interface Named { readonly name: string }
  export interface EntityRef<E extends string> extends Named { readonly entity: E }

  export interface EnvRef { readonly ref: 'env'; readonly name: string }
  export interface PortRef { readonly ref: 'port'; readonly slot: number }

  export type Position = 'pending' | 'active' | 'waiting' | 'terminal';
  export type Verdict = 'success' | 'failure' | 'neutral';
  export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled';
  export type AttemptStatus = 'running' | 'blocked';
  export type BlockReason = 'decision' | 'timer' | 'children' | 'job' | 'recovery';
  export type ResolvedBy = 'human' | 'policy' | 'timeout';
  export type LeaseMode = 'exclusive' | 'shared';
  export type OrderReason = 'predecessorOpen' | 'predecessorMissing' | 'predecessorFailed';

  export interface State<N extends string = string, P extends Position = Position> extends EntityRef<'state'> {
    readonly name: N;
    readonly position: P;
    readonly verdict?: Verdict;
  }

  export interface WorkRef<SN extends string = string, XN extends string = string> extends Named {
    readonly entity: 'kind' | 'lane';
    readonly _stateNames?: SN;
    readonly _exitNames?: XN;
  }

  export interface Resource extends EntityRef<'resource'> {}
  export interface HaltRef extends EntityRef<'halt'> {}
  export interface RoleRef extends EntityRef<'role'> {}
  export interface SeatRef extends EntityRef<'seat'> {}
  export interface FacetRef extends EntityRef<'facet'> {}

  export type ColumnName = 'kind' | 'lane' | 'state' | 'model' | 'seat' | 'resource' | 'halt';

  export interface FacetValue {
    readonly facet: FacetRef;
    readonly value: string;
  }

  export interface Dims {
    readonly kind?: WorkRef;
    readonly lane?: WorkRef;
    readonly state?: State;
    readonly model?: Model;
    readonly seat?: SeatRef;
    readonly resource?: Resource;
    readonly halt?: HaltRef;
    readonly facets?: readonly FacetValue[];
  }

  export type DimKey = { readonly [column: string]: string };

  export type Measure = 'rate' | 'total';

  export interface MetricRef<M extends Measure> extends EntityRef<'metric'> {
    readonly measure: M;
  }

  export type Window =
    | { readonly lastDays: number }
    | { readonly lastHours: number }
    | { readonly calendar: 'day' | 'week' | 'month'; readonly tz?: string };

  export interface AttemptView<StepN extends string = string> {
    readonly id: string;
    readonly number: number;
    readonly status: AttemptStatus;
    readonly step: StepN;
    readonly blockedOn?: BlockReason;
    readonly startedAt: Date;
  }

  export interface UnitView<A, SN extends string = string, StepN extends string = string> {
    readonly id: string;
    readonly key: string;
    readonly kind: WorkRef;
    readonly lane: WorkRef;
    readonly state: SN;
    readonly position: Position;
    readonly attributes: A;
    readonly createdAt: Date;
    readonly costUsd: number;
    readonly attempts: number;
    readonly failedAttempts: number;
    readonly attempt?: AttemptView<StepN>;
  }

  export interface Scope {
    readonly kinds?: readonly WorkRef[];
    readonly roles?: readonly RoleRef[];
    readonly skills?: readonly string[];
    readonly resources?: readonly Resource[];
  }

  export interface ScopeRecord {
    readonly kinds: readonly string[];
    readonly roles: readonly string[];
    readonly skills: readonly string[];
    readonly resources: readonly string[];
  }

  export interface MemoryItem {
    readonly id: string;
    readonly memoryKind: string;
    readonly journal: string;
    readonly createdAt: Date;
    readonly status: 'candidate' | 'active' | 'retired';
    readonly when: ScopeRecord;
    readonly text: string;
    readonly mergedInto?: string;
    readonly trackRecord: { readonly used: number; readonly succeeded: number };
  }

  export interface Rate {
    readonly rate: number;
    readonly hits: number;
    readonly samples: number;
  }

  export interface Total {
    readonly total: number;
    readonly samples: number;
  }

  export interface OutcomeCounts<SN extends string> {
    readonly terminal: number;
    readonly success: number;
    readonly failure: number;
    readonly neutral: number;
    readonly successRate: number;
    readonly samples: number;
    readonly byState: { readonly [K in SN]: number };
  }

  export interface AttemptCounts<XN extends string> {
    readonly succeeded: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly retried: number;
    readonly exhausted: number;
    readonly successRate: number;
    readonly samples: number;
    readonly byExit: { readonly [K in XN]: number };
  }

  export interface DecisionCounts {
    readonly samples: number;
    readonly medianMs: number;
    readonly byResolver: readonly {
      readonly resolvedBy: ResolvedBy;
      readonly resolver: string;
      readonly count: number;
      readonly medianMs: number;
    }[];
  }

  export interface LeaseWaits {
    readonly samples: number;
    readonly medianWaitMs: number;
    readonly totalWaitMs: number;
  }

  export interface Metrics {
    outcomes<SN extends string>(query: { readonly of: WorkRef<SN>; readonly window?: Window }): OutcomeCounts<SN>;
    attempts<XN extends string>(query: {
      readonly of: WorkRef<string, XN>;
      readonly seat?: SeatRef;
      readonly model?: Model;
      readonly window?: Window;
    }): AttemptCounts<XN>;
    rate(metric: MetricRef<'rate'>, query?: { readonly by?: Dims; readonly window?: Window }): Rate;
    total(metric: MetricRef<'total'>, query?: { readonly by?: Dims; readonly window?: Window }): Total;
    paused(query: { readonly lane: WorkRef; readonly window?: Window }): {
      readonly totalMs: number;
      readonly count: number;
    };
    decisions(query: { readonly halt: HaltRef; readonly window?: Window }): DecisionCounts;
    leases(query: { readonly resource: Resource; readonly window?: Window }): LeaseWaits;
  }

  export interface Policy<C, R> extends Named {
    decide(ctx: C): R;
  }

  export interface Resolver {
    env(ref: EnvRef): string;
    port(ref: PortRef): number;
  }

  export interface MetricRead {
    readonly metric: string;
    readonly by?: DimKey;
    readonly value: number;
    readonly samples: number;
  }

  export type LedgerEvent =
    | { readonly type: 'unitCreated'; readonly unitId: string; readonly lane: string; readonly kind: string; readonly key: string; readonly parentId?: string; readonly attributes: JsonObject; readonly at: Date }
    | { readonly type: 'createSkipped'; readonly lane: string; readonly key: string; readonly openUnitId: string; readonly source: string; readonly at: Date }
    | { readonly type: 'attributesUpdated'; readonly unitId: string; readonly attributes: JsonObject; readonly by: string; readonly at: Date }
    | { readonly type: 'transition'; readonly unitId: string; readonly from?: string; readonly to: string; readonly position: Position; readonly verdict?: Verdict; readonly attemptId?: string; readonly cause: 'exit' | 'during' | 'reaction' | 'retryExhausted' | 'order' | 'supplied'; readonly at: Date }
    | { readonly type: 'attemptStarted'; readonly unitId: string; readonly attemptId: string; readonly number: number; readonly fromStep: string; readonly flow: string; readonly flowVersion: string; readonly at: Date }
    | { readonly type: 'attemptBlocked'; readonly attemptId: string; readonly step: string; readonly on: BlockReason; readonly halt?: string; readonly ask?: string; readonly at: Date }
    | { readonly type: 'attemptResumed'; readonly attemptId: string; readonly step: string; readonly at: Date }
    | { readonly type: 'attemptInterrupted'; readonly attemptId: string; readonly step: string; readonly holder: string; readonly at: Date }
    | { readonly type: 'attemptParked'; readonly attemptId: string; readonly step: string; readonly reason: 'unsafeToRerun' | 'definitionChanged' | 'driverLost'; readonly detail: string; readonly at: Date }
    | { readonly type: 'attemptRecovered'; readonly attemptId: string; readonly action: 'restartFromTop' | 'abandon' | 'continue'; readonly by: string; readonly at: Date }
    | { readonly type: 'attemptEnded'; readonly attemptId: string; readonly outcome: AttemptOutcome; readonly exit?: string; readonly costUsd: number; readonly at: Date }
    | { readonly type: 'retryScheduled'; readonly unitId: string; readonly failedAttempts: number; readonly notBefore: Date; readonly at: Date }
    | { readonly type: 'retryExhausted'; readonly unitId: string; readonly lane: string; readonly to: string; readonly failedAttempts: number; readonly at: Date }
    | { readonly type: 'decisionRecorded'; readonly attemptId: string; readonly step: string; readonly halt: string; readonly decision: Json; readonly resolvedBy: ResolvedBy; readonly by: string; readonly input?: Json; readonly reads?: readonly MetricRead[]; readonly at: Date }
    | { readonly type: 'haltEscalated'; readonly attemptId: string; readonly step: string; readonly halt: string; readonly at: Date }
    | { readonly type: 'stepStarted'; readonly attemptId: string; readonly step: string; readonly iteration: number; readonly at: Date }
    | { readonly type: 'stepEnded'; readonly attemptId: string; readonly step: string; readonly iteration: number; readonly ok: boolean; readonly output?: Json; readonly durationMs: number; readonly at: Date }
    | { readonly type: 'invocation'; readonly attemptId: string; readonly step: string; readonly number: number; readonly executable: string; readonly seat?: string; readonly model?: string; readonly account?: string; readonly runner?: string; readonly batch: boolean; readonly ok: boolean; readonly costUsd: number; readonly tokens?: number; readonly sessionId?: string; readonly durationMs: number; readonly at: Date }
    | { readonly type: 'jobSubmitted'; readonly attemptId: string; readonly step: string; readonly job: string; readonly jobId: string; readonly via: 'driver' | 'command'; readonly at: Date }
    | { readonly type: 'jobPolled'; readonly attemptId: string; readonly step: string; readonly jobId: string; readonly state: 'running' | 'succeeded' | 'failed'; readonly at: Date }
    | { readonly type: 'policyDecision'; readonly unitId?: string; readonly attemptId?: string; readonly policy: string; readonly input?: Json; readonly value: Json; readonly reads?: readonly MetricRead[]; readonly at: Date }
    | { readonly type: 'signalDelivered'; readonly unitId: string; readonly signal: string; readonly payload: Json; readonly source: string; readonly at: Date }
    | { readonly type: 'signalSkipped'; readonly lane: string; readonly key: string; readonly signal: string; readonly source: string; readonly at: Date }
    | { readonly type: 'reactionDeferred'; readonly unitId: string; readonly attemptId: string; readonly signal: string; readonly enter: string; readonly at: Date }
    | { readonly type: 'reactionDropped'; readonly unitId: string; readonly attemptId: string; readonly signal: string; readonly reason: 'unitTerminal'; readonly at: Date }
    | { readonly type: 'timerSet'; readonly timerId: string; readonly unitId: string; readonly owner: string; readonly fireAt: Date; readonly at: Date }
    | { readonly type: 'timerCleared'; readonly timerId: string; readonly reason: 'rearmed' | 'disarmed' | 'unitTerminal'; readonly at: Date }
    | { readonly type: 'timerFired'; readonly timerId: string; readonly unitId: string; readonly at: Date }
    | { readonly type: 'crossing'; readonly metric: string; readonly band: string; readonly by: DimKey; readonly edge: 'entered' | 'exited'; readonly value: number; readonly hits: number; readonly samples: number; readonly at: Date }
    | { readonly type: 'triggerFired'; readonly trigger: string; readonly sourceSeq: number; readonly consequence: 'create' | 'signal' | 'record' | 'pause' | 'resume'; readonly targetId: string; readonly at: Date }
    | { readonly type: 'lanePaused'; readonly lane: string; readonly reason: string; readonly by: string; readonly at: Date }
    | { readonly type: 'laneResumed'; readonly lane: string; readonly reason: string; readonly by: string; readonly at: Date }
    | { readonly type: 'orderHeld'; readonly unitId: string; readonly sequence: number; readonly within?: string; readonly predecessorId?: string; readonly reason: OrderReason; readonly at: Date }
    | { readonly type: 'orderReleased'; readonly unitId: string; readonly predecessorId?: string; readonly at: Date }
    | { readonly type: 'leaseTaken'; readonly attemptId: string; readonly resource: string; readonly mode: LeaseMode; readonly waitedMs: number; readonly at: Date }
    | { readonly type: 'leaseReleased'; readonly attemptId: string; readonly resource: string; readonly at: Date }
    | { readonly type: 'memoryOrphaned'; readonly itemId: string; readonly journal: string; readonly names: readonly string[]; readonly at: Date };

  export interface SequencedEvent {
    readonly seq: number;
    readonly event: LedgerEvent;
  }

  export interface LedgerQuery {
    readonly afterSeq?: number;
    readonly unitId?: string;
    readonly attemptId?: string;
    readonly types?: readonly LedgerEvent['type'][];
    readonly since?: Date;
  }

  export interface UnitQuery {
    readonly lane?: string;
    readonly position?: readonly Position[];
    readonly attemptStatus?: readonly AttemptStatus[];
    readonly key?: string;
  }

  export interface UnitRow {
    readonly id: string;
    readonly key: string;
    readonly kind: string;
    readonly lane: string;
    readonly state: string;
    readonly position: Position;
    readonly attributes: JsonObject;
    readonly createdAt: Date;
    readonly costUsd: number;
    readonly attempts: number;
    readonly failedAttempts: number;
    readonly attempt?: AttemptView;
  }

  export interface UnitRecord {
    readonly row: UnitRow;
    readonly cursor?: { readonly step: string; readonly iteration: number; readonly flowVersion: string };
    readonly stepOutputs: Readonly<Record<string, Json>>;
    readonly notBefore?: Date;
    readonly deferredEnter?: { readonly signal: string; readonly state: string };
  }

  export interface WriterClaim {
    readonly acquired: boolean;
    readonly holder: string;
    readonly expiresAt: Date;
  }

  export interface Ledger {
    readonly id: string;
    append(events: readonly LedgerEvent[], writer: string): Promise<readonly number[]>;
    read(query: LedgerQuery): AsyncIterable<SequencedEvent>;
    unit(id: string): Promise<UnitRecord | undefined>;
    units(query: UnitQuery): Promise<readonly UnitRecord[]>;
    dueTimers(now: Date): Promise<readonly { readonly timerId: string; readonly unitId: string; readonly owner: string }[]>;
    takeLease(attemptId: string, resource: string, mode: LeaseMode): Promise<boolean>;
    claimWriter(holder: string, ttlMs: number): Promise<WriterClaim>;
    releaseWriter(holder: string): Promise<void>;
  }

  export type QuotaEvent =
    | { readonly type: 'consumed'; readonly account: string; readonly harness: string; readonly tokens: number; readonly costUsd: number; readonly at: Date }
    | { readonly type: 'cooldown'; readonly account: string; readonly harness: string; readonly until: Date; readonly at: Date }
    | { readonly type: 'windowObserved'; readonly account: string; readonly harness: string; readonly utilization: number; readonly resetsAt: Date; readonly at: Date };

  export interface QuotaPartition extends Named {
    register(harness: string, ledgerId: string): Promise<{ readonly accepted: boolean; readonly heldBy?: string }>;
    append(events: readonly QuotaEvent[]): Promise<void>;
    read(query: { readonly accounts: readonly string[]; readonly since: Date }): AsyncIterable<QuotaEvent>;
  }

  export interface Account extends EntityRef<'account'> {
    readonly credential: EnvRef;
    readonly quota: QuotaPartition;
  }

  export interface AccountState {
    readonly account: Account;
    readonly utilization: number;
    readonly shareUsed: number;
    readonly shareCap: number;
    readonly windowResetsAt: Date;
    readonly cooldownUntil?: Date;
  }

  export interface ModelRequest {
    readonly model: string;
    readonly seat: string;
    readonly account: Account;
    readonly role: { readonly name: string; readonly intents: readonly string[]; readonly instructions: string };
    readonly task: string;
    readonly memory: readonly MemoryItem[];
    readonly halts: readonly { readonly halt: string; readonly decisionSchema: Json }[];
    readonly outputSchema?: Json;
    readonly workspacePath?: string;
    readonly idempotencyKey: string;
    readonly resume?: { readonly sessionId: string; readonly halt: string; readonly decision: Json };
  }

  export interface ModelResponse {
    readonly output: Json;
    readonly costUsd: number;
    readonly tokens: number;
    readonly sessionId?: string;
    readonly halt?: { readonly halt: string; readonly ask: string };
    readonly recorded?: readonly {
      readonly journal: string;
      readonly text: string;
      readonly when: ScopeRecord;
    }[];
    readonly cooldownUntil?: Date;
  }

  export type SessionStatus =
    | { readonly status: 'finished'; readonly response: ModelResponse }
    | { readonly status: 'running' }
    | { readonly status: 'lost' };

  export type BatchStatus =
    | { readonly state: 'running' }
    | { readonly state: 'succeeded'; readonly responses: readonly ModelResponse[] }
    | { readonly state: 'failed'; readonly reason: string };

  export interface ModelDriver {
    serves(account: Account): boolean;
    invoke(request: ModelRequest, resolver: Resolver): Promise<ModelResponse>;
    session?(idempotencyKey: string, resolver: Resolver): Promise<SessionStatus>;
    submitBatch?(requests: readonly ModelRequest[], resolver: Resolver): Promise<{ readonly jobId: string }>;
    pollBatch?(jobId: string, resolver: Resolver): Promise<BatchStatus>;
    enforce(guard: 'leaseFiles' | 'beforeStop', hook: (path: string) => Promise<boolean>): boolean;
  }

  export interface Model extends EntityRef<'model'> {
    readonly id: string;
    readonly driver: ModelDriver;
  }

  export interface Embedder extends Named {
    readonly id: string;
    embed(texts: readonly string[], resolver: Resolver): Promise<readonly (readonly number[])[]>;
  }

  export interface RunnerBackend {
    exec(
      command: { readonly argv: readonly string[]; readonly env: Readonly<Record<string, string>> },
      cancel: AbortSignal,
      resolver: Resolver,
    ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly durationMs: number }>;
  }

  export interface WorkspaceBackend {
    prepare(attemptId: string): Promise<{ readonly path: string }>;
    release(attemptId: string): Promise<void>;
  }

  export interface Workspace extends Named {
    readonly backend: WorkspaceBackend;
  }

  export interface SupplySink<E> {
    emit(event: E, externalId: string): Promise<void>;
  }

  export interface Supplier<E> extends Named {
    start(sink: SupplySink<E>, resolver: Resolver): Promise<{ stop(): Promise<void> }>;
  }

  export interface Store<M extends string = never> extends Named {
    readonly _statesMapTo?: M;
    create(kind: string, state: string, attributes: JsonObject, resolver: Resolver): Promise<{ readonly key: string }>;
    load(key: string, resolver: Resolver): Promise<{ readonly state: string; readonly attributes: JsonObject } | undefined>;
    save(key: string, attributes: JsonObject, resolver: Resolver): Promise<void>;
    transition(key: string, state: string, resolver: Resolver): Promise<void>;
  }

  export interface MemoryFilter {
    readonly journal: string;
    readonly status?: readonly MemoryItem['status'][];
  }

  export interface MemoryStore extends Named {
    put(item: MemoryItem): Promise<void>;
    list(filter: MemoryFilter): Promise<readonly MemoryItem[]>;
    update(id: string, change: {
      readonly status?: MemoryItem['status'];
      readonly text?: string;
      readonly mergedInto?: string;
      readonly trackRecord?: MemoryItem['trackRecord'];
    }): Promise<void>;
    similar?(filter: MemoryFilter, text: string, limit: number): Promise<readonly { readonly item: MemoryItem; readonly score: number }[]>;
  }

  export interface GrantRecord {
    readonly operation: string;
    readonly halt?: string;
    readonly onceEscalated?: boolean;
  }

  export interface ControlApi {
    readonly harness: string;
    operations(): readonly { readonly name: string; readonly inputSchema: Json }[];
    call(operation: string, input: Json, caller: string): Promise<Json>;
    subscribe(listener: (event: SequencedEvent) => void): () => void;
  }

  export interface Client extends Named {
    readonly grants: readonly GrantRecord[];
    serve(api: ControlApi, resolver: Resolver): Promise<{ stop(): Promise<void> }>;
  }

  export interface Observer extends Named {
    observe(event: SequencedEvent, query: {
      unit(id: string): Promise<UnitRecord | undefined>;
      readonly metrics: Metrics;
    }): Promise<void>;
  }
}
