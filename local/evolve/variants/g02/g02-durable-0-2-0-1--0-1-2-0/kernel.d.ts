declare module 'harness-dsl/kernel' {
  export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
  export type JsonObject = { readonly [key: string]: Json };

  export interface Named { readonly name: string }
  export interface Entity<E extends string> extends Named { readonly entity: E }

  export interface EnvRef { readonly ref: 'env'; readonly name: string }
  export interface PortRef { readonly ref: 'port'; readonly slot: number }

  export type Position = 'pending' | 'active' | 'waiting' | 'terminal';
  export type Verdict = 'success' | 'failure' | 'neutral';
  export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled';
  export type AttemptStatus = 'running' | 'blocked';
  export type BlockReason = 'decision' | 'timer' | 'children' | 'job' | 'recovery' | 'capacity';
  export type ResolvedBy = 'human' | 'policy' | 'timeout';
  export type LeaseMode = 'exclusive' | 'shared';
  export type ServiceClass = 'expedite' | 'fixedDate' | 'standard';

  export interface State<N extends string = string, P extends Position = Position> extends Named {
    readonly entity: 'state';
    readonly name: N;
    readonly position: P;
    readonly verdict?: Verdict;
  }

  export interface WorkRef<S extends State = State> extends Named {
    readonly entity: 'kind' | 'lane';
    readonly _states?: S;
  }

  export type KindRef = Entity<'kind'>;
  export type RoleRef = Entity<'role'>;
  export type ResourceRef = Entity<'resource'>;
  export type HaltRef = Entity<'halt'>;
  export type SeatRef = Entity<'seat'>;
  export type JobRef = Entity<'job'>;
  export type FacetRef = Entity<'facet'>;

  export interface FacetValue<V extends string = string> {
    readonly facet: FacetRef;
    readonly value: V;
  }

  export interface StoredFacetValue {
    readonly facet: string;
    readonly value: string;
  }

  export interface Model extends Named {
    readonly id: string;
    readonly driver: ModelDriver;
  }

  export interface Dimensions {
    readonly seat?: SeatRef;
    readonly model?: Model;
    readonly resource?: ResourceRef;
    readonly halt?: HaltRef;
    readonly facets?: readonly FacetValue[];
  }

  export type Measure = 'rate' | 'total';

  export interface MetricRef<M extends Measure> extends Named {
    readonly entity: 'metric';
    readonly measure: M;
  }

  export type Window =
    | { readonly lastDays: number }
    | { readonly lastHours: number }
    | { readonly calendar: 'day' | 'week' | 'month'; readonly tz?: string };

  export interface UnitView<A, S extends State = State> {
    readonly id: string;
    readonly key: string;
    readonly state: S;
    readonly position: Position;
    readonly attributes: A;
    readonly createdAt: Date;
  }

  export interface Scope {
    readonly kinds?: readonly KindRef[];
    readonly roles?: readonly RoleRef[];
    readonly skills?: readonly string[];
    readonly resources?: readonly ResourceRef[];
  }

  export interface StoredScope {
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
    readonly when: StoredScope;
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

  export interface OutcomeCounts<S extends State> {
    readonly terminal: number;
    readonly success: number;
    readonly failure: number;
    readonly neutral: number;
    readonly successRate: number;
    readonly samples: number;
    inState(state: S): number;
  }

  export interface AttemptCounts {
    readonly succeeded: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly retried: number;
    readonly successRate: number;
    readonly samples: number;
  }

  export interface DecisionCounts {
    readonly samples: number;
    readonly medianMs: number;
    readonly byResolver: readonly {
      readonly resolvedBy: ResolvedBy;
      readonly resolver: string;
      readonly samples: number;
      readonly medianMs: number;
    }[];
  }

  export interface LeaseWaits {
    readonly samples: number;
    readonly medianWaitMs: number;
    readonly totalWaitMs: number;
  }

  export interface JobHours {
    readonly hoursInFlight: number;
    readonly samples: number;
    readonly running: number;
  }

  export interface MetricQuery extends Dimensions {
    readonly of?: WorkRef;
    readonly window?: Window;
  }

  export interface Metrics {
    outcomes<S extends State>(query: { readonly of: WorkRef<S>; readonly window?: Window }): OutcomeCounts<S>;
    attempts(query: {
      readonly of: WorkRef;
      readonly seat?: SeatRef;
      readonly model?: Model;
      readonly window?: Window;
    }): AttemptCounts;
    rate(metric: MetricRef<'rate'>, query?: MetricQuery): Rate;
    total(metric: MetricRef<'total'>, query?: MetricQuery): Total;
    paused(query: { readonly lane: WorkRef; readonly window?: Window }): {
      readonly totalMs: number;
      readonly samples: number;
    };
    decisions(query: { readonly halt: HaltRef; readonly window?: Window }): DecisionCounts;
    leases(query: { readonly resource: ResourceRef; readonly window?: Window }): LeaseWaits;
    jobs(query: { readonly job: JobRef; readonly window: Window }): JobHours;
  }

  export interface Policy<C, R> extends Named {
    decide(ctx: C): R;
  }

  export interface Resolver {
    env(ref: EnvRef): string;
    port(ref: PortRef): number;
  }

  export type CeilingDecision =
    | { readonly action: 'raise'; readonly maxUsd: number }
    | { readonly action: 'fail' };

  export interface StoredDimensions {
    readonly kind?: string;
    readonly lane?: string;
    readonly state?: string;
    readonly seat?: string;
    readonly model?: string;
    readonly resource?: string;
    readonly halt?: string;
    readonly facets?: readonly StoredFacetValue[];
  }

  export interface MetricRead {
    readonly metric: string;
    readonly dimensions: StoredDimensions;
    readonly value: number;
    readonly samples: number;
  }

  export type LedgerEvent =
    | { readonly type: 'unitCreated'; readonly unitId: string; readonly lane: string; readonly kind: string; readonly key: string; readonly parentId?: string; readonly attributes: JsonObject; readonly source: string; readonly at: Date }
    | { readonly type: 'createSkipped'; readonly lane: string; readonly key: string; readonly openUnitId: string; readonly source: string; readonly at: Date }
    | { readonly type: 'attributesUpdated'; readonly unitId: string; readonly attributes: JsonObject; readonly by: string; readonly at: Date }
    | { readonly type: 'transition'; readonly unitId: string; readonly from?: string; readonly to: string; readonly position: Position; readonly verdict?: Verdict; readonly attemptId?: string; readonly at: Date }
    | { readonly type: 'attemptStarted'; readonly unitId: string; readonly attemptId: string; readonly number: number; readonly flow: string; readonly flowVersion: string; readonly serviceClass: ServiceClass; readonly at: Date }
    | { readonly type: 'attemptBlocked'; readonly attemptId: string; readonly step: string; readonly on: BlockReason; readonly halt?: string; readonly ask?: string; readonly facets?: readonly StoredFacetValue[]; readonly at: Date }
    | { readonly type: 'attemptResumed'; readonly attemptId: string; readonly step: string; readonly at: Date }
    | { readonly type: 'attemptRewound'; readonly attemptId: string; readonly fromStep: string; readonly toStep: string; readonly signal: string; readonly at: Date }
    | { readonly type: 'attemptInterrupted'; readonly attemptId: string; readonly step: string; readonly holder: string; readonly at: Date }
    | { readonly type: 'attemptParked'; readonly attemptId: string; readonly step: string; readonly reason: 'unsafeToRerun' | 'definitionChanged' | 'driverLost'; readonly detail: string; readonly at: Date }
    | { readonly type: 'attemptRecovered'; readonly attemptId: string; readonly action: 'restartFromTop' | 'abandon' | 'continue'; readonly by: string; readonly at: Date }
    | { readonly type: 'attemptEnded'; readonly attemptId: string; readonly outcome: AttemptOutcome; readonly exit?: string; readonly costUsd: number; readonly at: Date }
    | { readonly type: 'retryScheduled'; readonly unitId: string; readonly failedAttempts: number; readonly notBefore: Date; readonly at: Date }
    | { readonly type: 'decisionRecorded'; readonly attemptId: string; readonly step: string; readonly halt: string; readonly decision: Json; readonly resolvedBy: ResolvedBy; readonly by: string; readonly facets?: readonly StoredFacetValue[]; readonly reads?: readonly MetricRead[]; readonly at: Date }
    | { readonly type: 'haltNotAsked'; readonly attemptId: string; readonly step: string; readonly halt: string; readonly at: Date }
    | { readonly type: 'haltEscalated'; readonly attemptId: string; readonly step: string; readonly halt: string; readonly at: Date }
    | { readonly type: 'stepStarted'; readonly attemptId: string; readonly step: string; readonly iteration: number; readonly at: Date }
    | { readonly type: 'stepEnded'; readonly attemptId: string; readonly step: string; readonly iteration: number; readonly ok: boolean; readonly output?: Json; readonly durationMs: number; readonly at: Date }
    | { readonly type: 'iterationEnded'; readonly attemptId: string; readonly loop: string; readonly iteration: number; readonly counted: boolean; readonly feedback?: Json; readonly at: Date }
    | { readonly type: 'invocation'; readonly attemptId: string; readonly step: string; readonly number: number; readonly executable: string; readonly seat?: string; readonly model?: string; readonly account?: string; readonly runner?: string; readonly viaJob: boolean; readonly ok: boolean; readonly costUsd: number; readonly tokens?: number; readonly sessionId?: string; readonly durationMs: number; readonly at: Date }
    | { readonly type: 'jobSubmitted'; readonly attemptId: string; readonly step: string; readonly job: string; readonly jobId: string; readonly requests: number; readonly at: Date }
    | { readonly type: 'jobCollected'; readonly attemptId: string; readonly step: string; readonly job: string; readonly jobId: string; readonly ok: boolean; readonly reason?: string; readonly at: Date }
    | { readonly type: 'policyDecision'; readonly unitId?: string; readonly attemptId?: string; readonly policy: string; readonly value: Json; readonly reads?: readonly MetricRead[]; readonly at: Date }
    | { readonly type: 'signalDelivered'; readonly unitId: string; readonly signal: string; readonly payload: Json; readonly source: string; readonly applied: readonly ('update' | 'rewind' | 'enter')[]; readonly gatedAtStep?: string; readonly at: Date }
    | { readonly type: 'signalSkipped'; readonly lane: string; readonly key: string; readonly signal: string; readonly source: string; readonly at: Date }
    | { readonly type: 'timerSet'; readonly timerId: string; readonly unitId: string; readonly owner: string; readonly fireAt: Date; readonly at: Date }
    | { readonly type: 'timerCleared'; readonly timerId: string; readonly reason: 'rearmed' | 'leftState'; readonly at: Date }
    | { readonly type: 'timerFired'; readonly timerId: string; readonly unitId: string; readonly at: Date }
    | { readonly type: 'crossing'; readonly metric: string; readonly band: string; readonly value?: string; readonly edge: 'entered' | 'exited'; readonly rate: number; readonly hits: number; readonly samples: number; readonly at: Date }
    | { readonly type: 'triggerFired'; readonly trigger: string; readonly sourceSeq: number; readonly consequence: 'create' | 'signal' | 'record' | 'pause' | 'resume'; readonly targetId: string; readonly at: Date }
    | { readonly type: 'lanePaused'; readonly lane: string; readonly reason: string; readonly by: string; readonly at: Date }
    | { readonly type: 'laneResumed'; readonly lane: string; readonly reason: string; readonly by: string; readonly at: Date }
    | { readonly type: 'expediteHold'; readonly lane: string; readonly heldBy: string; readonly released: boolean; readonly at: Date }
    | { readonly type: 'orderHeld'; readonly unitId: string; readonly predecessorKey: string; readonly reason: string; readonly at: Date }
    | { readonly type: 'leaseTaken'; readonly attemptId: string; readonly resource: string; readonly mode: LeaseMode; readonly waitedMs: number; readonly at: Date }
    | { readonly type: 'leaseReleased'; readonly attemptId: string; readonly resource: string; readonly at: Date };

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

  export interface StoredUnit {
    readonly id: string;
    readonly key: string;
    readonly kind: string;
    readonly lane: string;
    readonly state: string;
    readonly position: Position;
    readonly attributes: JsonObject;
    readonly createdAt: Date;
  }

  export interface UnitQuery {
    readonly lane?: string;
    readonly position?: readonly Position[];
    readonly attemptStatus?: readonly AttemptStatus[];
    readonly key?: string;
  }

  export interface UnitRecord {
    readonly unit: StoredUnit;
    readonly attempt?: {
      readonly id: string;
      readonly number: number;
      readonly status: AttemptStatus;
      readonly step: string;
      readonly iteration: number;
      readonly flowVersion: string;
      readonly blockedOn?: BlockReason;
      readonly halt?: string;
      readonly startedAt: Date;
    };
    readonly stepOutputs: Readonly<Record<string, Json>>;
    readonly feedback: Readonly<Record<string, readonly Json[]>>;
    readonly notBefore?: Date;
  }

  export interface WriterClaim {
    readonly acquired: boolean;
    readonly holder: string;
    readonly expiresAt: Date;
  }

  export interface Ledger {
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
    join(harness: string, holder: string, ttlMs: number): Promise<{ readonly accepted: boolean; readonly heldBy?: string }>;
    append(events: readonly QuotaEvent[]): Promise<void>;
    read(query: { readonly accounts: readonly string[]; readonly since: Date }): AsyncIterable<QuotaEvent>;
  }

  export interface Account extends Named {
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
    readonly seat: string;
    readonly model: string;
    readonly account: Account;
    readonly role: { readonly name: string; readonly intents: readonly string[]; readonly instructions: string };
    readonly task: string;
    readonly memory: readonly MemoryItem[];
    readonly outputSchema?: Json;
    readonly workspacePath?: string;
    readonly idempotencyKey: string;
  }

  export interface ModelResponse {
    readonly output: Json;
    readonly costUsd: number;
    readonly tokens: number;
    readonly sessionId?: string;
    readonly recorded?: readonly { readonly journal: string; readonly text: string; readonly when: StoredScope }[];
    readonly cooldownUntil?: Date;
  }

  export type SessionStatus =
    | { readonly status: 'finished'; readonly response: ModelResponse }
    | { readonly status: 'running' }
    | { readonly status: 'lost' };

  export interface ModelDriver {
    serves(account: Account): boolean;
    invoke(request: ModelRequest, resolver: Resolver): Promise<ModelResponse>;
    session?(idempotencyKey: string, resolver: Resolver): Promise<SessionStatus>;
    submitBatch?(requests: readonly ModelRequest[], resolver: Resolver): Promise<{ readonly jobId: string }>;
    collectBatch?(jobId: string, resolver: Resolver): Promise<readonly ModelResponse[] | undefined>;
    enforce(guard: 'leaseFiles' | 'beforeStop', hook: (path: string) => Promise<boolean>): void;
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

  export interface ControlApi {
    readonly harness: string;
    operations(): readonly { readonly name: string; readonly inputSchema: Json }[];
    call(operation: string, input: Json, caller: string): Promise<Json>;
    subscribe(listener: (event: SequencedEvent) => void): () => void;
  }

  export interface ClientEndpoint {
    readonly transport: string;
    readonly port: PortRef;
  }

  export interface Client extends Named {
    readonly grants: readonly string[];
    readonly endpoint: ClientEndpoint;
    serve(api: ControlApi, resolver: Resolver): Promise<{ stop(): Promise<void> }>;
  }

  export interface Observer extends Named {
    observe(event: SequencedEvent, query: {
      unit(id: string): Promise<UnitRecord | undefined>;
      readonly metrics: Metrics;
    }): Promise<void>;
  }
}
