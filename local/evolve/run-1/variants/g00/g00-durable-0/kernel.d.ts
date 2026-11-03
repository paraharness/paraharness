declare module 'harness-dsl' {
  export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };
  export type JsonObject = { readonly [key: string]: Json };

  export interface Named { readonly name: string }

  export type Outcome = 'pending' | 'active' | 'succeeded' | 'failed' | 'cancelled' | 'ended';
  export type TerminalOutcome = 'succeeded' | 'failed' | 'cancelled' | 'ended';

  export type WaitReason = 'slot' | 'decision' | 'signal' | 'timer' | 'children';

  export interface AttemptView {
    readonly number: number;
    readonly status: 'running' | 'blocked';
    readonly step: string;
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
    readonly outcome: Outcome;
    readonly attributes: A;
    readonly createdAt: Date;
    readonly enteredStateAt: Date;
    readonly attempts: number;
    readonly costUsd: number;
    readonly waitingFor?: WaitReason;
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
    readonly body: JsonObject;
    readonly mergedInto?: string;
    readonly trackRecord: { readonly used: number; readonly succeeded: number };
  }

  export interface Rate {
    readonly rate: number;
    readonly successes: number;
    readonly samples: number;
  }

  export interface OutcomeCounts {
    readonly samples: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly ended: number;
    readonly successRate: number;
    readonly byState: Readonly<Record<string, number>>;
  }

  export interface MetricWindow {
    readonly windowDays?: number;
  }

  export interface Metrics {
    outcomes(query: MetricWindow & { readonly of: Named; readonly model?: Named }): OutcomeCounts;
    rate(metric: Named, query?: MetricWindow & { readonly group?: string }): Rate;
    meanCostUsd(query: MetricWindow & { readonly of: Named; readonly outcome?: TerminalOutcome }): {
      readonly meanUsd: number;
      readonly samples: number;
    };
  }

  export interface Policy<C, R> extends Named {
    decide(ctx: C): R;
  }

  export interface Resolver {
    env(ref: EnvRef): string;
    port(ref: PortRef): number;
  }

  export type LedgerEvent =
    | { readonly type: 'unitCreated'; readonly unitId: string; readonly lane: string; readonly kind: string; readonly key: string; readonly parentId?: string; readonly attributes: JsonObject; readonly at: Date }
    | { readonly type: 'attributesUpdated'; readonly unitId: string; readonly attributes: JsonObject; readonly at: Date }
    | { readonly type: 'transition'; readonly unitId: string; readonly from: string; readonly to: string; readonly outcome: Outcome; readonly attempt?: number; readonly at: Date }
    | { readonly type: 'attemptStarted'; readonly unitId: string; readonly attempt: number; readonly fromStep: string; readonly at: Date }
    | { readonly type: 'attemptBlocked'; readonly unitId: string; readonly attempt: number; readonly step: string; readonly ask: string; readonly at: Date }
    | { readonly type: 'attemptResumed'; readonly unitId: string; readonly attempt: number; readonly decision: Json; readonly by: string; readonly at: Date }
    | { readonly type: 'attemptEnded'; readonly unitId: string; readonly attempt: number; readonly result: 'exited' | 'suspended' | 'failed' | 'cancelled'; readonly waitingFor?: WaitReason; readonly at: Date }
    | { readonly type: 'stepStarted'; readonly unitId: string; readonly attempt: number; readonly step: string; readonly iteration: number; readonly at: Date }
    | { readonly type: 'invocation'; readonly unitId: string; readonly attempt: number; readonly step: string; readonly number: number; readonly executable: string; readonly model?: string; readonly account?: string; readonly runner?: string; readonly batch: boolean; readonly ok: boolean; readonly costUsd: number; readonly tokens?: number; readonly durationMs: number; readonly at: Date }
    | { readonly type: 'stepEnded'; readonly unitId: string; readonly attempt: number; readonly step: string; readonly iteration: number; readonly ok: boolean; readonly output?: Json; readonly at: Date }
    | { readonly type: 'decision'; readonly unitId?: string; readonly attempt?: number; readonly policy: string; readonly value: Json; readonly at: Date }
    | { readonly type: 'signalDelivered'; readonly unitId: string; readonly signal: string; readonly payload: Json; readonly source: string; readonly at: Date }
    | { readonly type: 'timerSet'; readonly timerId: string; readonly unitId: string; readonly owner: string; readonly fireAt: Date; readonly at: Date }
    | { readonly type: 'timerFired'; readonly timerId: string; readonly unitId: string; readonly at: Date }
    | { readonly type: 'triggerFired'; readonly trigger: string; readonly sourceEvent: number; readonly consequence: 'create' | 'signal' | 'record'; readonly targetId: string; readonly at: Date }
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
    readonly outcome?: readonly Outcome[];
    readonly waitingFor?: readonly WaitReason[];
    readonly key?: string;
  }

  export interface UnitRecord {
    readonly view: UnitView<JsonObject>;
    readonly cursor?: { readonly step: string; readonly iteration: number };
    readonly stepOutputs: Readonly<Record<string, Json>>;
  }

  export interface Ledger {
    append(events: readonly LedgerEvent[]): Promise<readonly number[]>;
    read(query: LedgerQuery): AsyncIterable<SequencedEvent>;
    unit(id: string): Promise<UnitRecord | undefined>;
    units(query: UnitQuery): Promise<readonly UnitRecord[]>;
    dueTimers(now: Date): Promise<readonly { readonly timerId: string; readonly unitId: string; readonly owner: string }[]>;
    takeLease(unitId: string, attempt: number, resource: string): Promise<boolean>;
    spentUsd(lanes: readonly string[], since: Date): Promise<number>;
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

  export interface AccountLedger {
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
    readonly ledger?: AccountLedger;
    readonly credential: EnvRef;
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
    readonly recorded?: readonly { readonly journal: string; readonly body: JsonObject; readonly when: Scope }[];
    readonly cooldownUntil?: Date;
  }

  export interface ModelDriver {
    invoke(request: ModelRequest, resolver: Resolver): Promise<ModelResponse>;
    submitBatch?(requests: readonly ModelRequest[], resolver: Resolver): Promise<{ readonly batchId: string }>;
    collectBatch?(batchId: string, resolver: Resolver): Promise<readonly ModelResponse[] | undefined>;
    enforce(guard: 'lease' | 'beforeStop', hook: (path: string) => Promise<boolean>): void;
  }

  export interface Model extends Named {
    readonly id: string;
    readonly driver: ModelDriver;
    readonly pool: Named;
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
