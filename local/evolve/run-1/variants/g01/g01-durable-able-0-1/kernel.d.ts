declare module 'harness-dsl/kernel' {
  export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
  export type JsonObject = { readonly [key: string]: Json };

  export interface Named { readonly name: string }

  export interface EnvRef { readonly ref: 'env'; readonly name: string }
  export interface PortRef { readonly ref: 'port'; readonly slot: number }

  export type Position = 'pending' | 'active' | 'waiting' | 'terminal';
  export type Verdict = 'success' | 'failure' | 'neutral';
  export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled';
  export type AttemptStatus = 'running' | 'blocked' | 'parked';

  export interface State<N extends string = string> extends Named {
    readonly name: N;
    readonly position: Position;
    readonly verdict?: Verdict;
  }

  export interface LaneShape<A, S extends State, St> {
    readonly name: string;
    readonly lane: true;
    readonly _types?: { readonly attrs: A; readonly states: S; readonly steps: St };
  }

  export type AnyLane = LaneShape<unknown, State, unknown>;

  export interface MetricRef extends Named { readonly metric: true }

  export interface AttemptView {
    readonly number: number;
    readonly status: AttemptStatus;
    readonly step: string;
    readonly startedAt: Date;
    readonly costUsd: number;
  }

  export interface UnitView<A, S extends string = string> {
    readonly id: string;
    readonly key: string;
    readonly kind: string;
    readonly lane: string;
    readonly parentId?: string;
    readonly state: S;
    readonly position: Position;
    readonly verdict?: Verdict;
    readonly attributes: A;
    readonly createdAt: Date;
    readonly enteredStateAt: Date;
    readonly attempts: number;
    readonly costUsd: number;
    readonly attempt?: AttemptView;
  }

  export interface Scope {
    readonly kinds?: readonly Named[];
    readonly roles?: readonly Named[];
    readonly skills?: readonly string[];
    readonly resources?: readonly string[];
  }

  export interface MemoryItem {
    readonly id: string;
    readonly memoryKind: string;
    readonly journal: string;
    readonly createdAt: Date;
    readonly status: 'candidate' | 'active' | 'retired';
    readonly when: Scope;
    readonly text: string;
    readonly mergedInto?: string;
    readonly trackRecord: { readonly used: number; readonly succeeded: number };
  }

  export interface MetricWindow {
    readonly windowDays?: number;
    readonly windowHours?: number;
  }

  export interface Rate {
    readonly rate: number;
    readonly hits: number;
    readonly samples: number;
  }

  export interface OutcomeCounts<N extends string> {
    readonly samples: number;
    readonly success: number;
    readonly failure: number;
    readonly neutral: number;
    readonly successRate: number;
    readonly byState: { readonly [K in N]: number };
  }

  export interface Metrics {
    outcomes<S extends State>(
      query: MetricWindow & { readonly of: LaneShape<unknown, S, unknown>; readonly model?: Named },
    ): OutcomeCounts<S['name']>;
    rate(metric: MetricRef, query?: MetricWindow & { readonly group?: string }): Rate;
    meanCostUsd(query: MetricWindow & { readonly of: AnyLane }): { readonly meanUsd: number; readonly samples: number };
    pausedMs(lane: AnyLane, query: MetricWindow): { readonly totalMs: number; readonly pauses: number };
  }

  export interface Policy<C, R> extends Named {
    decide(ctx: C): R;
  }

  export interface Resolver {
    env(ref: EnvRef): string;
    port(ref: PortRef): number;
  }

  export type ParkReason = 'definitionChanged' | 'unsafeRerun' | 'driverUnknown' | 'ceilingExceeded';

  export type LedgerEvent =
    | { readonly type: 'writerClaimed'; readonly harness: string; readonly holder: string; readonly tookOverFrom?: string; readonly at: Date }
    | { readonly type: 'unitCreated'; readonly unitId: string; readonly lane: string; readonly kind: string; readonly key: string; readonly parentId?: string; readonly attributes: JsonObject; readonly at: Date }
    | { readonly type: 'unitDeduplicated'; readonly lane: string; readonly key: string; readonly existingUnitId: string; readonly source: string; readonly at: Date }
    | { readonly type: 'attributesUpdated'; readonly unitId: string; readonly attributes: JsonObject; readonly by: string; readonly at: Date }
    | { readonly type: 'transition'; readonly unitId: string; readonly from?: string; readonly to: string; readonly position: Position; readonly verdict?: Verdict; readonly attempt?: number; readonly at: Date }
    | { readonly type: 'attemptStarted'; readonly unitId: string; readonly attempt: number; readonly fromStep: string; readonly flowFingerprint: string; readonly at: Date }
    | { readonly type: 'attemptStatus'; readonly unitId: string; readonly attempt: number; readonly status: AttemptStatus; readonly step: string; readonly ask?: string; readonly at: Date }
    | { readonly type: 'decision'; readonly unitId?: string; readonly attempt?: number; readonly step?: string; readonly policy: string; readonly value: Json; readonly by: string; readonly at: Date }
    | { readonly type: 'attemptInterrupted'; readonly unitId: string; readonly attempt: number; readonly step: string; readonly at: Date }
    | { readonly type: 'attemptRecovered'; readonly unitId: string; readonly attempt: number; readonly step: string; readonly how: 'rerun' | 'confirmedDone' | 'collected' | 'foundResolved'; readonly at: Date }
    | { readonly type: 'attemptParked'; readonly unitId: string; readonly attempt: number; readonly step: string; readonly reason: ParkReason; readonly detail: string; readonly at: Date }
    | { readonly type: 'attemptEnded'; readonly unitId: string; readonly attempt: number; readonly outcome: AttemptOutcome; readonly at: Date }
    | { readonly type: 'stepStarted'; readonly unitId: string; readonly attempt: number; readonly step: string; readonly iteration: number; readonly at: Date }
    | { readonly type: 'invocationStarted'; readonly unitId: string; readonly attempt: number; readonly step: string; readonly number: number; readonly executable: string; readonly sessionId?: string; readonly batchId?: string; readonly at: Date }
    | { readonly type: 'invocation'; readonly unitId: string; readonly attempt: number; readonly step: string; readonly number: number; readonly executable: string; readonly model?: string; readonly account?: string; readonly runner?: string; readonly batch: boolean; readonly ok: boolean; readonly costUsd: number; readonly tokens?: number; readonly durationMs: number; readonly at: Date }
    | { readonly type: 'stepEnded'; readonly unitId: string; readonly attempt: number; readonly step: string; readonly iteration: number; readonly ok: boolean; readonly output?: Json; readonly at: Date }
    | { readonly type: 'signalDelivered'; readonly unitId: string; readonly signal: string; readonly payload: Json; readonly source: string; readonly at: Date }
    | { readonly type: 'timerSet'; readonly timerId: string; readonly unitId: string; readonly owner: string; readonly fireAt: Date; readonly supersedes?: string; readonly at: Date }
    | { readonly type: 'timerFired'; readonly timerId: string; readonly unitId: string; readonly at: Date }
    | { readonly type: 'thresholdCrossed'; readonly metric: string; readonly group: string; readonly edge: 'tripped' | 'reset'; readonly rate: number; readonly samples: number; readonly at: Date }
    | { readonly type: 'triggerFired'; readonly trigger: string; readonly sourceSeq: number; readonly consequence: 'create' | 'signal' | 'record' | 'pause' | 'resume'; readonly target: string; readonly at: Date }
    | { readonly type: 'lanePaused'; readonly lane: string; readonly trigger: string; readonly sourceSeq: number; readonly at: Date }
    | { readonly type: 'laneResumed'; readonly lane: string; readonly trigger: string; readonly sourceSeq: number; readonly at: Date }
    | { readonly type: 'leaseTaken'; readonly unitId: string; readonly attempt: number; readonly resource: string; readonly at: Date }
    | { readonly type: 'leaseReleased'; readonly unitId: string; readonly attempt: number; readonly resource: string; readonly at: Date };

  export interface SequencedEvent {
    readonly seq: number;
    readonly event: LedgerEvent;
  }

  export interface LedgerQuery {
    readonly afterSeq?: number;
    readonly unitId?: string;
    readonly types?: readonly LedgerEvent['type'][];
    readonly since?: Date;
  }

  export interface UnitQuery {
    readonly lane?: string;
    readonly position?: readonly Position[];
    readonly key?: string;
  }

  export interface UnitRecord {
    readonly view: UnitView<JsonObject>;
    readonly cursor?: { readonly step: string; readonly iteration: number; readonly flowFingerprint: string };
    readonly stepOutputs: Readonly<Record<string, Json>>;
    readonly openInvocation?: { readonly step: string; readonly executable: string; readonly sessionId?: string; readonly batchId?: string };
  }

  export type InboxEvent =
    | { readonly type: 'decision'; readonly unitId: string; readonly attempt: number; readonly step: string; readonly value: Json; readonly by: string; readonly at: Date }
    | { readonly type: 'operation'; readonly operation: string; readonly input: Json; readonly by: string; readonly at: Date };

  export interface WriterLease {
    renew(): Promise<boolean>;
    release(): Promise<void>;
  }

  export interface QuotaLedger {
    state(account: string, harness: string): Promise<{
      readonly utilization: number;
      readonly harnessUtilization: number;
      readonly windowResetsAt: Date;
      readonly cooldownUntil?: Date;
    }>;
    reserve(account: string, harness: string, estimatedTokens: number, shareCap: number): Promise<{ readonly reservationId: string } | undefined>;
    settle(reservationId: string, usage: { readonly tokens: number; readonly costUsd: number; readonly at: Date }): Promise<void>;
    cooldown(account: string, until: Date): Promise<void>;
  }

  export interface Ledger {
    claimWriter(harness: string, holder: string, ttlMs: number): Promise<WriterLease | undefined>;
    append(events: readonly LedgerEvent[]): Promise<readonly number[]>;
    read(query: LedgerQuery): AsyncIterable<SequencedEvent>;
    unit(id: string): Promise<UnitRecord | undefined>;
    units(query: UnitQuery): Promise<readonly UnitRecord[]>;
    dueTimers(now: Date): Promise<readonly { readonly timerId: string; readonly unitId: string; readonly owner: string }[]>;
    takeLease(unitId: string, attempt: number, resource: string): Promise<boolean>;
    spentUsd(lanes: readonly string[], since: Date): Promise<number>;
    deposit(event: InboxEvent): Promise<void>;
    takeInbox(): Promise<readonly InboxEvent[]>;
    readonly quota: QuotaLedger;
  }

  export interface Account extends Named {
    readonly credential: EnvRef;
    accepts(model: Model): boolean;
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
    readonly account: Account;
    readonly role: { readonly name: string; readonly intents: readonly string[]; readonly instructions: string };
    readonly task: string;
    readonly memory: readonly MemoryItem[];
    readonly outputSchema?: Json;
    readonly workspacePath?: string;
    readonly budgetTokens?: number;
    readonly resume?: { readonly sessionId: string; readonly decision: Json };
  }

  export interface ModelResponse {
    readonly output: Json;
    readonly costUsd: number;
    readonly tokens: number;
    readonly sessionId?: string;
    readonly halt?: { readonly ask: string };
    readonly recorded?: readonly { readonly text: string; readonly when: Scope }[];
    readonly cooldownUntil?: Date;
  }

  export interface ModelDriver {
    invoke(request: ModelRequest, resolver: Resolver, onSession: (sessionId: string) => Promise<void>): Promise<ModelResponse>;
    recover(sessionId: string, resolver: Resolver): Promise<ModelResponse | 'running' | 'unknown'>;
    submitBatch?(requests: readonly ModelRequest[], resolver: Resolver): Promise<{ readonly batchId: string }>;
    collectBatch?(batchId: string, resolver: Resolver): Promise<readonly ModelResponse[] | undefined>;
    enforce(guard: 'lease' | 'beforeStop', hook: (path: string) => Promise<boolean>): void;
  }

  export interface Model extends Named {
    readonly id: string;
    readonly driver: ModelDriver;
  }

  export interface RunnerBackend {
    exec(
      command: { readonly argv: readonly string[]; readonly env: Readonly<Record<string, string>>; readonly timeoutMs?: number },
      cancel: AbortSignal,
      resolver: Resolver,
    ): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly durationMs: number }>;
  }

  export interface WorkspaceBackend {
    prepare(unitId: string, attempt: number): Promise<{ readonly path: string }>;
    release(unitId: string, attempt: number): Promise<void>;
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

  export interface Store extends Named {
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
    readonly live: boolean;
    operations(): readonly { readonly name: string; readonly inputSchema: Json }[];
    call(operation: string, input: Json, caller: string): Promise<Json>;
    subscribe(listener: (event: SequencedEvent) => void): () => void;
  }

  export interface Client extends Named {
    readonly grants: readonly string[];
    serve(api: ControlApi, resolver: Resolver): Promise<{ stop(): Promise<void> }>;
  }

  export interface Observer extends Named {
    observe(event: SequencedEvent, query: { unit(id: string): Promise<UnitRecord | undefined>; readonly metrics: Metrics }): Promise<void>;
  }
}
