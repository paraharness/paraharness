declare module 'harness-dsl' {
  export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
  export type JsonObject = { readonly [key: string]: Json };

  export interface Named { readonly name: string }

  export type Position = 'pending' | 'active' | 'waiting' | 'terminal';
  export type Verdict = 'success' | 'failure' | 'neutral';
  export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled';
  export type AttemptStatus = 'running' | 'blocked' | 'waiting';
  export type BlockReason = 'decision' | 'restart' | 'ceiling';
  export type WaitReason = 'signal' | 'timer' | 'children';

  export interface AttemptView {
    readonly number: number;
    readonly status: AttemptStatus;
    readonly step: string;
    readonly blockedFor?: BlockReason;
    readonly waitingFor?: WaitReason;
    readonly startedAt: Date;
    readonly costUsd: number;
  }

  export interface UnitView<A> {
    readonly id: string;
    readonly key: string;
    readonly kind: string;
    readonly lane: string;
    readonly parentId?: string;
    readonly state: string;
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
    readonly playbook: string;
    readonly createdAt: Date;
    readonly status: 'candidate' | 'active' | 'retired';
    readonly when: Scope;
    readonly body: JsonObject;
    readonly mergedInto?: string;
    readonly trackRecord: { readonly used: number; readonly succeeded: number };
  }

  export interface Rate {
    readonly rate: number;
    readonly hits: number;
    readonly samples: number;
  }

  export interface AttemptCounts {
    readonly samples: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly successRate: number;
  }

  export interface UnitCounts<N extends string> {
    readonly samples: number;
    readonly success: number;
    readonly failure: number;
    readonly neutral: number;
    readonly terminal: number;
    readonly successRate: number;
    readonly byState: { readonly [K in N]: number };
  }

  export interface Outcomes<N extends string> {
    readonly attempts: AttemptCounts;
    readonly units: UnitCounts<N>;
  }

  export interface MetricWindow {
    readonly windowDays?: number;
    readonly windowHours?: number;
  }

  export interface Metrics {
    outcomes<S extends State>(
      query: MetricWindow & { readonly of: LaneShape<unknown, S, unknown>; readonly model?: Named },
    ): Outcomes<S['name']>;
    rate(metric: Named, query?: MetricWindow & { readonly group?: string }): Rate;
    meanCostUsd(query: MetricWindow & { readonly of: LaneRef; readonly verdict?: Verdict }): {
      readonly meanUsd: number;
      readonly samples: number;
    };
    pausedMs(query: MetricWindow & { readonly lane: LaneRef }): number;
  }

  export interface Policy<C, R> extends Named {
    decide(ctx: C): R;
  }

  export interface Resolver {
    env(ref: EnvRef): string;
    port(ref: PortRef): number;
  }

  export type RestartRule = 'rerun' | 'park' | 'ask' | 'parkUnless';

  export type LedgerEvent =
    | { readonly type: 'writerClaimed'; readonly holder: string; readonly fence: number; readonly at: Date }
    | { readonly type: 'unitCreated'; readonly unitId: string; readonly lane: string; readonly kind: string; readonly key: string; readonly parentId?: string; readonly attributes: JsonObject; readonly at: Date }
    | { readonly type: 'attributesUpdated'; readonly unitId: string; readonly attributes: JsonObject; readonly by: string; readonly at: Date }
    | { readonly type: 'transition'; readonly unitId: string; readonly from?: string; readonly to: string; readonly position: Position; readonly verdict?: Verdict; readonly attempt?: number; readonly at: Date }
    | { readonly type: 'attemptStarted'; readonly unitId: string; readonly attempt: number; readonly fromStep: string; readonly flow: string; readonly flowHash: string; readonly stepPath: readonly string[]; readonly at: Date }
    | { readonly type: 'attemptStatus'; readonly unitId: string; readonly attempt: number; readonly status: AttemptStatus; readonly step: string; readonly blockedFor?: BlockReason; readonly waitingFor?: WaitReason; readonly ask?: string; readonly at: Date }
    | { readonly type: 'decisionRecorded'; readonly unitId: string; readonly attempt: number; readonly step: string; readonly decision: Json; readonly by: string; readonly at: Date }
    | { readonly type: 'attemptEnded'; readonly unitId: string; readonly attempt: number; readonly outcome: AttemptOutcome; readonly exit?: string; readonly reason?: string; readonly at: Date }
    | { readonly type: 'stepStarted'; readonly unitId: string; readonly attempt: number; readonly step: string; readonly iteration: number; readonly restart: RestartRule; readonly at: Date }
    | { readonly type: 'stepEnded'; readonly unitId: string; readonly attempt: number; readonly step: string; readonly iteration: number; readonly ok: boolean; readonly output?: Json; readonly at: Date }
    | { readonly type: 'invocationStarted'; readonly unitId: string; readonly attempt: number; readonly step: string; readonly invocation: number; readonly executable: string; readonly model?: string; readonly account?: string; readonly runner?: string; readonly at: Date }
    | { readonly type: 'invocationHandle'; readonly unitId: string; readonly attempt: number; readonly invocation: number; readonly handle: string; readonly batch: boolean; readonly at: Date }
    | { readonly type: 'invocationEnded'; readonly unitId: string; readonly attempt: number; readonly invocation: number; readonly result: 'ok' | 'error' | 'interrupted'; readonly costUsd: number; readonly tokens?: number; readonly durationMs: number; readonly at: Date }
    | { readonly type: 'decision'; readonly unitId?: string; readonly attempt?: number; readonly policy: string; readonly value: Json; readonly at: Date }
    | { readonly type: 'signalDelivered'; readonly unitId: string; readonly signal: string; readonly payload: Json; readonly source: string; readonly at: Date }
    | { readonly type: 'timerSet'; readonly timerId: string; readonly unitId: string; readonly owner: string; readonly fireAt: Date; readonly at: Date }
    | { readonly type: 'timerCancelled'; readonly timerId: string; readonly reason: 'rearmed' | 'unitTerminal' | 'conditionFalse'; readonly at: Date }
    | { readonly type: 'timerFired'; readonly timerId: string; readonly unitId: string; readonly at: Date }
    | { readonly type: 'thresholdCrossed'; readonly metric: string; readonly group: string; readonly crossing: 'breached' | 'recovered'; readonly rate: number; readonly hits: number; readonly samples: number; readonly at: Date }
    | { readonly type: 'triggerFired'; readonly trigger: string; readonly sourceSeq: number; readonly consequence: 'create' | 'signal' | 'record' | 'pause' | 'resume'; readonly targetId?: string; readonly skipped?: 'duplicateKey' | 'noTarget' | 'alreadyPaused' | 'notPaused'; readonly at: Date }
    | { readonly type: 'lanePaused'; readonly lane: string; readonly by: string; readonly sourceSeq?: number; readonly value?: number; readonly at: Date }
    | { readonly type: 'laneResumed'; readonly lane: string; readonly by: string; readonly sourceSeq?: number; readonly value?: number; readonly at: Date }
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
    readonly attemptStatus?: readonly AttemptStatus[];
    readonly key?: string;
  }

  export interface UnitRecord {
    readonly view: UnitView<JsonObject>;
    readonly cursor?: { readonly step: string; readonly iteration: number; readonly flowHash: string; readonly stepPath: readonly string[] };
    readonly stepOutputs: Readonly<Record<string, Json>>;
    readonly openInvocation?: { readonly step: string; readonly invocation: number; readonly restart: RestartRule; readonly handle?: string; readonly batch: boolean };
  }

  export interface WriterToken {
    readonly holder: string;
    readonly fence: number;
  }

  export interface Ledger {
    claimWriter(holder: string, ttlMs: number): Promise<WriterToken | undefined>;
    renewWriter(token: WriterToken, ttlMs: number): Promise<boolean>;
    append(events: readonly LedgerEvent[], writer: WriterToken): Promise<readonly number[]>;
    read(query: LedgerQuery): AsyncIterable<SequencedEvent>;
    unit(id: string): Promise<UnitRecord | undefined>;
    units(query: UnitQuery): Promise<readonly UnitRecord[]>;
    dueTimers(now: Date): Promise<readonly { readonly timerId: string; readonly unitId: string; readonly owner: string }[]>;
    takeLease(unitId: string, attempt: number, resource: string, writer: WriterToken): Promise<boolean>;
    spentUsd(lanes: readonly string[], since: Date): Promise<number>;
    pausedLanes(): Promise<readonly string[]>;
    readonly quota: QuotaLedger;
  }

  export interface AccountState {
    readonly account: Account;
    readonly utilization: number;
    readonly shareUsed: number;
    readonly shareCap: number;
    readonly windowResetsAt: Date;
    readonly cooldownUntil?: Date;
  }

  export interface AccountUsage {
    readonly account: string;
    readonly harness: string;
    readonly tokens: number;
    readonly costUsd: number;
    readonly at: Date;
  }

  export interface QuotaLedger {
    state(account: string, harness: string): Promise<{
      readonly utilization: number;
      readonly harnessUtilization: number;
      readonly windowResetsAt: Date;
      readonly cooldownUntil?: Date;
    }>;
    reserve(account: string, harness: string, estimatedTokens: number, shareCap: number): Promise<{ readonly reservationId: string } | undefined>;
    settle(reservationId: string, usage: AccountUsage): Promise<void>;
    cooldown(account: string, until: Date): Promise<void>;
  }

  export interface Account extends Named {
    readonly credential: EnvRef;
    serves(model: Model): boolean;
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
    readonly resume?: { readonly handle: string; readonly decision: Json };
  }

  export interface ModelResponse {
    readonly output: Json;
    readonly costUsd: number;
    readonly tokens: number;
    readonly halt?: { readonly ask: string };
    readonly recorded?: readonly { readonly playbook: string; readonly body: JsonObject; readonly when: Scope }[];
    readonly cooldownUntil?: Date;
  }

  export type DriverStatus =
    | { readonly status: 'finished'; readonly response: ModelResponse }
    | { readonly status: 'running' }
    | { readonly status: 'unknown' };

  export interface ModelDriver {
    invoke(request: ModelRequest, resolver: Resolver, started: (handle: string) => Promise<void>): Promise<ModelResponse>;
    status?(handle: string, resolver: Resolver): Promise<DriverStatus>;
    submitBatch?(requests: readonly ModelRequest[], resolver: Resolver): Promise<{ readonly handle: string }>;
    collectBatch?(handle: string, resolver: Resolver): Promise<readonly ModelResponse[] | undefined>;
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
    readonly playbook: string;
    readonly status?: readonly MemoryItem['status'][];
  }

  export interface MemoryStore extends Named {
    put(item: MemoryItem): Promise<void>;
    list(filter: MemoryFilter): Promise<readonly MemoryItem[]>;
    update(id: string, change: { readonly status?: MemoryItem['status']; readonly body?: JsonObject; readonly mergedInto?: string; readonly trackRecord?: MemoryItem['trackRecord'] }): Promise<void>;
    similar?(filter: MemoryFilter, text: string, limit: number): Promise<readonly { readonly item: MemoryItem; readonly score: number }[]>;
  }

  export interface ControlApi {
    readonly harness: string;
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
