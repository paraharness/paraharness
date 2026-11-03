declare module 'harness-dsl' {
  export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
  export type JsonObject = { readonly [key: string]: Json };

  export interface Named { readonly name: string }

  export type Position = 'pending' | 'active' | 'waiting' | 'terminal';
  export type Verdict = 'success' | 'failure' | 'neutral';
  export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled';
  export type BlockReason = 'decision' | 'crash' | 'definitionChanged' | 'ceiling';

  export interface State<
    N extends string = string,
    P extends Position = Position,
    V extends Verdict | undefined = Verdict | undefined,
  > extends Named {
    readonly entity: 'state';
    readonly name: N;
    readonly position: P;
    readonly verdict: V;
  }

  export type Window =
    | { readonly windowDays: number; readonly windowHours?: never }
    | { readonly windowHours: number; readonly windowDays?: never };

  export type OptionalWindow = Window | { readonly windowDays?: never; readonly windowHours?: never };

  export interface UnitRef {
    readonly entity: 'unit';
    readonly lane: string;
    readonly key: string;
  }

  export interface AttemptView<N extends string = string> {
    readonly id: string;
    readonly number: number;
    readonly status: 'running' | 'blocked';
    readonly blockedFor?: BlockReason;
    readonly step: N;
    readonly startedAt: Date;
    readonly costUsd: number;
  }

  export interface UnitView<A, SN extends string = string, N extends string = string> extends UnitRef {
    readonly id: string;
    readonly kind: string;
    readonly parentId?: string;
    readonly state: SN;
    readonly position: Position;
    readonly verdict?: Verdict;
    readonly attributes: A;
    readonly createdAt: Date;
    readonly enteredStateAt: Date;
    readonly attempts: number;
    readonly costUsd: number;
    readonly attempt?: AttemptView<N>;
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
    readonly body: JsonObject;
    readonly mergedInto?: string;
    readonly trackRecord: { readonly used: number; readonly succeeded: number };
  }

  export interface Rate {
    readonly rate: number;
    readonly successes: number;
    readonly samples: number;
  }

  export interface AttemptCounts {
    readonly succeeded: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly samples: number;
    readonly successRate: number;
  }

  export interface UnitCounts<SN extends string> {
    readonly success: number;
    readonly failure: number;
    readonly neutral: number;
    readonly terminal: number;
    readonly samples: number;
    readonly successRate: number;
    readonly byState: { readonly [K in SN]: number };
  }

  export interface Outcomes<SN extends string> {
    readonly attempts: AttemptCounts;
    readonly units: UnitCounts<SN>;
  }

  export interface Metrics {
    outcomes<S extends State>(
      query: OptionalWindow & { readonly of: LaneShape<unknown, S, unknown>; readonly model?: Model },
    ): Outcomes<S['name']>;
    rate(metric: AnyMetric, query?: OptionalWindow & { readonly group?: string }): Rate;
    meanCostUsd(query: OptionalWindow & { readonly of: AnyLane; readonly verdict?: Verdict }): {
      readonly meanUsd: number;
      readonly samples: number;
    };
    paused(lane: AnyLane, query?: OptionalWindow): { readonly totalMs: number; readonly pauses: number };
  }

  export interface Policy<C, R> extends Named {
    decide(ctx: C): R;
  }

  export interface Resolver {
    env(ref: EnvRef): string;
    port(ref: PortRef): number;
  }

  export type InboxEvent =
    | { readonly type: 'decisionDelivered'; readonly unitId: string; readonly attempt: string; readonly step: string; readonly decision: Json; readonly by: string; readonly at: Date }
    | { readonly type: 'blockerResolved'; readonly unitId: string; readonly attempt: string; readonly resolution: 'continue' | 'restartFromTop' | 'abandon'; readonly by: string; readonly at: Date }
    | { readonly type: 'signalDelivered'; readonly unitId: string; readonly signal: string; readonly payload: Json; readonly source: string; readonly at: Date }
    | { readonly type: 'attributesUpdated'; readonly unitId: string; readonly attributes: JsonObject; readonly by: string; readonly at: Date }
    | { readonly type: 'unitRequested'; readonly lane: string; readonly attributes: JsonObject; readonly by: string; readonly at: Date };

  export type LedgerEvent =
    | InboxEvent
    | { readonly type: 'claimTaken'; readonly holder: string; readonly tookOverFrom?: string; readonly at: Date }
    | { readonly type: 'unitCreated'; readonly unitId: string; readonly lane: string; readonly kind: string; readonly key: string; readonly parentId?: string; readonly state: string; readonly attributes: JsonObject; readonly at: Date }
    | { readonly type: 'unitDeduplicated'; readonly lane: string; readonly key: string; readonly existingUnitId: string; readonly source: string; readonly at: Date }
    | { readonly type: 'transition'; readonly unitId: string; readonly from?: string; readonly to: string; readonly position: Position; readonly verdict?: Verdict; readonly attempt?: string; readonly at: Date }
    | { readonly type: 'attemptStarted'; readonly unitId: string; readonly attempt: string; readonly number: number; readonly fromStep: string; readonly flowHash: string; readonly at: Date }
    | { readonly type: 'attemptBlocked'; readonly unitId: string; readonly attempt: string; readonly step: string; readonly reason: BlockReason; readonly ask: string; readonly at: Date }
    | { readonly type: 'attemptResumed'; readonly unitId: string; readonly attempt: string; readonly step: string; readonly afterCrash: boolean; readonly at: Date }
    | { readonly type: 'attemptEnded'; readonly unitId: string; readonly attempt: string; readonly outcome: AttemptOutcome; readonly suspendedAt?: string; readonly at: Date }
    | { readonly type: 'stepStarted'; readonly unitId: string; readonly attempt: string; readonly step: string; readonly iteration: number; readonly at: Date }
    | { readonly type: 'stepEnded'; readonly unitId: string; readonly attempt: string; readonly step: string; readonly iteration: number; readonly ok: boolean; readonly output?: Json; readonly at: Date }
    | { readonly type: 'invocationStarted'; readonly unitId: string; readonly attempt: string; readonly step: string; readonly invocation: string; readonly executable: string; readonly model?: string; readonly account?: string; readonly runner?: string; readonly batch: boolean; readonly at: Date }
    | { readonly type: 'invocationHandle'; readonly invocation: string; readonly sessionId?: string; readonly batchId?: string; readonly at: Date }
    | { readonly type: 'invocationEnded'; readonly invocation: string; readonly ok: boolean; readonly costUsd: number; readonly tokens?: number; readonly durationMs: number; readonly at: Date }
    | { readonly type: 'decision'; readonly unitId?: string; readonly attempt?: string; readonly policy: string; readonly value: Json; readonly at: Date }
    | { readonly type: 'timerSet'; readonly timerId: string; readonly unitId: string; readonly owner: string; readonly fireAt: Date; readonly supersedes?: string; readonly at: Date }
    | { readonly type: 'timerFired'; readonly timerId: string; readonly unitId: string; readonly at: Date }
    | { readonly type: 'bandCrossed'; readonly band: string; readonly group: string; readonly direction: 'down' | 'up'; readonly rate: number; readonly samples: number; readonly at: Date }
    | { readonly type: 'lanePaused'; readonly lane: string; readonly trigger: string; readonly reason: string; readonly sourceSeq: number; readonly at: Date }
    | { readonly type: 'laneResumed'; readonly lane: string; readonly trigger: string; readonly reason: string; readonly sourceSeq: number; readonly at: Date }
    | { readonly type: 'triggerFired'; readonly trigger: string; readonly sourceSeq: number; readonly consequence: 'create' | 'signal' | 'record' | 'pause' | 'resume'; readonly targetId: string; readonly at: Date }
    | { readonly type: 'leaseTaken'; readonly unitId: string; readonly attempt: string; readonly resource: string; readonly at: Date }
    | { readonly type: 'leaseReleased'; readonly unitId: string; readonly attempt: string; readonly resource: string; readonly at: Date };

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
    readonly positions?: readonly Position[];
    readonly key?: string;
  }

  export interface UnitRecord {
    readonly view: UnitView<JsonObject>;
    readonly cursor?: { readonly step: string; readonly iteration: number; readonly flowHash: string };
    readonly stepOutputs: Readonly<Record<string, Json>>;
    readonly openInvocation?: { readonly invocation: string; readonly step: string; readonly sessionId?: string; readonly batchId?: string };
  }

  export type Claim =
    | { readonly granted: true; readonly tookOverFrom?: string }
    | { readonly granted: false; readonly heldBy: string; readonly expiresAt: Date };

  export interface AccountWindow {
    readonly utilization: number;
    readonly harnessUtilization: number;
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

  export interface Ledger {
    claim(holder: string, ttlMs: number, now: Date): Promise<Claim>;
    renew(holder: string, ttlMs: number, now: Date): Promise<boolean>;
    release(holder: string): Promise<void>;
    append(holder: string, events: readonly LedgerEvent[]): Promise<readonly number[]>;
    deliver(event: InboxEvent): Promise<number>;
    read(query: LedgerQuery): AsyncIterable<SequencedEvent>;
    unit(id: string): Promise<UnitRecord | undefined>;
    units(query: UnitQuery): Promise<readonly UnitRecord[]>;
    dueTimers(now: Date): Promise<readonly { readonly timerId: string; readonly unitId: string; readonly owner: string }[]>;
    takeLease(unitId: string, attempt: string, resource: string): Promise<boolean>;
    spentUsd(lanes: readonly string[], since: Date): Promise<number>;
    accountWindow(account: string, harness: string): Promise<AccountWindow>;
    reserve(account: string, harness: string, estimatedTokens: number, shareCap: number): Promise<{ readonly reservationId: string } | undefined>;
    settle(reservationId: string, usage: AccountUsage): Promise<void>;
    cooldown(account: string, until: Date): Promise<void>;
  }

  export interface Account extends Named {
    readonly entity: 'account';
    readonly provider: string;
    readonly credential: EnvRef;
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
    readonly invocation: string;
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
    readonly recorded?: readonly { readonly journal: string; readonly body: JsonObject; readonly when: Scope }[];
    readonly cooldownUntil?: Date;
  }

  export type InvocationStatus =
    | { readonly status: 'finished'; readonly response: ModelResponse }
    | { readonly status: 'running' }
    | { readonly status: 'lost' };

  export interface ModelDriver {
    accepts(account: Account): boolean;
    invoke(request: ModelRequest, resolver: Resolver, started: (handle: { readonly sessionId: string }) => Promise<void>): Promise<ModelResponse>;
    status?(sessionId: string, resolver: Resolver): Promise<InvocationStatus>;
    submitBatch?(requests: readonly ModelRequest[], resolver: Resolver): Promise<{ readonly batchId: string }>;
    collectBatch?(batchId: string, resolver: Resolver): Promise<readonly ModelResponse[] | undefined>;
    enforce(guard: 'lease' | 'beforeStop', hook: (path: string) => Promise<boolean>): void;
  }

  export interface Model extends Named {
    readonly entity: 'model';
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
    prepare(unitId: string, attempt: string): Promise<{ readonly path: string }>;
    release(unitId: string, attempt: string): Promise<void>;
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
