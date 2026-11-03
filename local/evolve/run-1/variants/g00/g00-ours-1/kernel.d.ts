declare module 'harness-dsl/kernel' {
  import type {
    Actor,
    AgentPlugin as AgentPluginDescriptor,
    AccountDriver as AccountDriverDescriptor,
    Endpoint as EndpointDescriptor,
    Intent,
    Json,
    Ledger as LedgerDescriptor,
    MemoryItem,
    MemoryStore as MemoryStoreDescriptor,
    Metrics as MetricsShape,
    Outcome,
    Policy as PolicyShape,
    Pricing as PricingDescriptor,
    Projection as ProjectionDescriptor,
    QuotaStore as QuotaStoreDescriptor,
    Runner as RunnerDescriptor,
    Store as StoreDescriptor,
    Supplier as SupplierDescriptor,
    When,
  } from 'harness-dsl';

  export type Metrics = MetricsShape;
  export type Policy<Ctx, Out> = PolicyShape<Ctx, Out>;

  export interface Stoppable {
    stop(): Promise<void>;
  }

  export interface UnitRecord {
    readonly lane: string;
    readonly kind: string;
    readonly key: string;
    readonly state: string;
    readonly outcome: Outcome;
    readonly data: Json;
    readonly parentKey: string | null;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  }

  export interface StepCursor {
    readonly path: readonly string[];
    readonly iterations: Readonly<Record<string, number>>;
  }

  export type AttemptStatus = 'running' | 'blocked' | 'succeeded' | 'failed' | 'cancelled' | 'parked';

  export interface AttemptRecord {
    readonly id: string;
    readonly runId: string;
    readonly lane: string;
    readonly unitKey: string;
    readonly number: number;
    readonly status: AttemptStatus;
    readonly cursor: StepCursor;
    readonly outputs: Readonly<Record<string, Json>>;
    readonly blocker: BlockerRecord | null;
    readonly startedAt: Date;
    readonly endedAt: Date | null;
  }

  export interface BlockerRecord {
    readonly id: string;
    readonly attemptId: string;
    readonly step: string;
    readonly question: string;
    readonly decisionSchema: Json;
    readonly origin: 'flow' | 'agent' | 'cost-ceiling';
    readonly resumeToken: string | null;
    readonly openedAt: Date;
  }

  export interface Usage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheWriteTokens: number;
  }

  export type LedgerEvent =
    | { readonly type: 'run.started'; readonly runId: string; readonly harness: string; readonly at: Date }
    | { readonly type: 'run.stopped'; readonly runId: string; readonly at: Date }
    | { readonly type: 'unit.created'; readonly unit: UnitRecord; readonly actor: Actor; readonly at: Date }
    | { readonly type: 'unit.updated'; readonly lane: string; readonly key: string; readonly data: Json; readonly previous: Json; readonly actor: Actor; readonly at: Date }
    | { readonly type: 'unit.transitioned'; readonly lane: string; readonly key: string; readonly from: string | null; readonly to: string; readonly outcome: Outcome; readonly attemptId: string | null; readonly actor: Actor; readonly at: Date }
    | { readonly type: 'unit.queued'; readonly lane: string; readonly key: string; readonly at: Date }
    | { readonly type: 'attempt.started'; readonly attempt: AttemptRecord; readonly at: Date }
    | { readonly type: 'attempt.stepped'; readonly attemptId: string; readonly cursor: StepCursor; readonly step: string; readonly output: Json; readonly at: Date }
    | { readonly type: 'attempt.blocked'; readonly blocker: BlockerRecord; readonly at: Date }
    | { readonly type: 'attempt.resumed'; readonly attemptId: string; readonly blockerId: string; readonly decision: Json; readonly actor: Actor; readonly at: Date }
    | { readonly type: 'attempt.ended'; readonly attemptId: string; readonly status: AttemptStatus; readonly reason: string | null; readonly actor: Actor; readonly at: Date }
    | { readonly type: 'invocation.ended'; readonly attemptId: string; readonly step: string; readonly iteration: number; readonly executable: string; readonly model: string | null; readonly account: string | null; readonly batched: boolean; readonly succeeded: boolean; readonly usage: Usage | null; readonly costUsd: number; readonly durationMs: number; readonly at: Date }
    | { readonly type: 'deadline.passed'; readonly lane: string; readonly key: string; readonly source: string; readonly deadline: Date; readonly at: Date }
    | { readonly type: 'trigger.fired'; readonly trigger: string; readonly causeSeq: number; readonly consequence: Json; readonly at: Date }
    | { readonly type: 'memory.injected'; readonly attemptId: string; readonly itemIds: readonly string[]; readonly at: Date }
    | { readonly type: 'operation.performed'; readonly operation: string; readonly actor: Actor; readonly input: Json; readonly at: Date };

  export interface SequencedEvent {
    readonly seq: number;
    readonly event: LedgerEvent;
  }

  export interface EventQuery {
    readonly afterSeq?: number;
    readonly types?: readonly LedgerEvent['type'][];
    readonly lane?: string;
    readonly unitKey?: string;
    readonly since?: Date;
  }

  export interface QuotaState {
    readonly account: string;
    readonly windowStartedAt: Date | null;
    readonly windowResetsAt: Date | null;
    readonly utilization: number;
    readonly utilizationByHarness: Readonly<Record<string, number>>;
    readonly coolingUntil: Date | null;
    readonly version: number;
  }

  export interface Reservation {
    readonly id: string;
    readonly account: string;
    readonly harness: string;
    readonly estimatedShare: number;
  }

  export interface QuotaStore {
    quota(account: string): Promise<QuotaState>;
    reserve(account: string, harness: string, estimatedShare: number, maxShare: number): Promise<Reservation | null>;
    settle(reservation: Reservation, observedShare: number): Promise<QuotaState>;
    cooldown(account: string, until: Date, reason: string): Promise<QuotaState>;
    observeWindow(account: string, startedAt: Date, resetsAt: Date, utilization: number): Promise<QuotaState>;
  }

  export interface Ledger extends QuotaStore {
    append(events: readonly LedgerEvent[]): Promise<readonly number[]>;
    read(query: EventQuery): AsyncIterable<SequencedEvent>;
    unit(lane: string, key: string): Promise<UnitRecord | null>;
    units(query: { readonly lane?: string; readonly outcomes?: readonly Outcome[] }): Promise<readonly UnitRecord[]>;
    attempt(id: string): Promise<AttemptRecord | null>;
    openAttempts(): Promise<readonly AttemptRecord[]>;
    queue(): Promise<readonly { readonly lane: string; readonly key: string; readonly queuedAt: Date }[]>;
  }

  export type SupplyOffer =
    | { readonly mode: 'create'; readonly data: Json }
    | { readonly mode: 'upsert'; readonly data: Json }
    | { readonly mode: 'update'; readonly key: string; readonly patch: Json };

  export interface SupplySink {
    offer(offer: SupplyOffer): Promise<{ readonly accepted: boolean; readonly key: string | null; readonly reason: string | null }>;
    readonly harness: string;
    readonly lane: string;
  }

  export interface Supplier {
    start(sink: SupplySink): Promise<Stoppable>;
  }

  export interface Store {
    load(kind: string, key: string): Promise<{ readonly data: Json; readonly state: string } | null>;
    save(kind: string, key: string, data: Json, state: string): Promise<void>;
  }

  export interface MemoryQuery {
    readonly kind: string;
    readonly statuses: readonly MemoryItem<Json>['status'][];
    readonly applicableTo: When;
    readonly near: string | null;
    readonly limit: number;
  }

  export interface MemoryStore {
    put(item: MemoryItem<Json>): Promise<void>;
    get(id: string): Promise<MemoryItem<Json> | null>;
    query(query: MemoryQuery): Promise<readonly { readonly item: MemoryItem<Json>; readonly similarity: number | null }[]>;
    revise(id: string, change: { readonly status?: MemoryItem<Json>['status']; readonly content?: Json; readonly when?: When; readonly mergedInto?: string | null }): Promise<void>;
  }

  export interface AgentTask {
    readonly attemptId: string;
    readonly modelId: string;
    readonly system: string;
    readonly prompt: string;
    readonly memory: readonly MemoryItem<Json>[];
    readonly intents: readonly Intent[];
    readonly outputSchema: Json;
    readonly workspace: string | null;
    readonly resources: readonly string[];
    readonly resumeToken: string | null;
    readonly answer: Json;
  }

  export type AgentResult =
    | { readonly status: 'done'; readonly output: Json; readonly usage: Usage }
    | { readonly status: 'asked'; readonly question: string; readonly resumeToken: string; readonly usage: Usage }
    | { readonly status: 'refused'; readonly reason: string; readonly usage: Usage };

  export interface AgentHooks {
    beforeWrite(path: string): Promise<{ readonly allowed: boolean; readonly reason: string | null }>;
    beforeStop(): Promise<{ readonly allowed: boolean; readonly feedback: string | null }>;
    recordMemory(kind: string, draft: { readonly content: Json; readonly when?: When }): Promise<string>;
  }

  export interface AccountDriver {
    invoke(task: AgentTask, hooks: AgentHooks): Promise<AgentResult>;
    submitBatch(tasks: readonly AgentTask[]): Promise<string>;
    collectBatch(batchId: string): Promise<readonly AgentResult[] | null>;
    probeQuota(): Promise<{ readonly utilization: number; readonly windowResetsAt: Date | null } | null>;
  }

  export interface Pricing {
    costUsd(modelId: string, usage: Usage, mode: 'interactive' | 'batch'): number;
  }

  export interface RunnerLease {
    exec(program: string, args: readonly string[], options: { readonly cwd?: string; readonly stdin?: string; readonly timeoutMs?: number; readonly env: Readonly<Record<string, string>> }): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly durationMs: number }>;
    release(): Promise<void>;
  }

  export interface Runner {
    acquire(attemptId: string): Promise<RunnerLease>;
    resolvePort(index: number, attemptId: string): Promise<number>;
  }

  export interface AttemptWorkspace {
    readonly path: string | null;
    dispose(outcome: Outcome): Promise<void>;
  }

  export interface AgentPlugin {
    beforeAttempt(attempt: { readonly id: string; readonly unitKey: string; readonly resources: readonly string[] }): Promise<AttemptWorkspace | null>;
    hooks(attemptId: string): Partial<AgentHooks>;
  }

  export interface OperationInfo {
    readonly name: string;
    readonly inputSchema: Json;
    readonly outputSchema: Json;
  }

  export interface ControlApi {
    operations(): readonly OperationInfo[];
    perform(operation: string, input: Json, actor: Actor): Promise<Json>;
  }

  export interface Endpoint {
    serve(api: ControlApi): Promise<Stoppable>;
  }

  export interface Snapshot {
    readonly harness: string;
    readonly seq: number;
    readonly units: readonly UnitRecord[];
    readonly openAttempts: readonly AttemptRecord[];
    readonly metrics: Metrics;
  }

  export interface Projection {
    project(snapshot: Snapshot): Promise<void>;
  }

  export const define: {
    ledger(name: string, implementation: Ledger): LedgerDescriptor;
    quotaStore(name: string, implementation: QuotaStore): QuotaStoreDescriptor;
    supplier<D>(name: string, implementation: Supplier): SupplierDescriptor<D>;
    store(name: string, implementation: Store): StoreDescriptor;
    memoryStore(name: string, implementation: MemoryStore): MemoryStoreDescriptor;
    accountDriver(name: string, implementation: AccountDriver): AccountDriverDescriptor;
    pricing(name: string, implementation: Pricing): PricingDescriptor;
    runner(name: string, implementation: Runner): RunnerDescriptor;
    agentPlugin(name: string, implementation: AgentPlugin): AgentPluginDescriptor;
    endpoint(name: string, implementation: Endpoint): EndpointDescriptor;
    projection(name: string, implementation: Projection): ProjectionDescriptor;
  };
}
