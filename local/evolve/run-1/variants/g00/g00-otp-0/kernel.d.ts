declare module 'harness-dsl/kernel' {
  export interface Ref<T> {
    readonly source: 'env' | 'slot';
    readonly key: string;
    readonly sample?: T;
  }

  export type Skeleton = 'pending' | 'active' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'ended';

  export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

  export interface Rate {
    readonly value: number | null;
    readonly samples: number;
  }

  export interface Outcomes {
    readonly samples: number;
    readonly byState: { readonly [state: string]: number };
    readonly bySkeleton: { readonly [S in Skeleton]: number };
    readonly successRate: Rate;
  }

  export interface Metrics {
    successRate(query: { readonly kind: { readonly name: string }; readonly days: number; readonly model?: { readonly name: string }; readonly agent?: string }): Rate;
    outcomes(query: { readonly kind: { readonly name: string }; readonly days: number }): Outcomes;
    meanCostUsd(query: { readonly kind: { readonly name: string }; readonly days: number; readonly outcome?: Skeleton; readonly state?: string }): Rate;
    spendUsd(query: { readonly since: Date }): number;
    read(metric: { readonly name: string }, query: { readonly days: number; readonly group?: string }): Rate;
  }

  export interface PolicyContext {
    readonly now: Date;
    readonly metrics: Metrics;
  }

  export type AttemptEnd = 'exited' | 'crashed' | 'cancelled' | 'preempted';
  export type TransitionCause = 'exit' | 'message' | 'timeout' | 'crash' | 'preempt' | 'operator' | 'trigger';

  export type LedgerEvent =
    | { readonly type: 'run.started'; readonly runId: string; readonly harness: string; readonly at: string }
    | { readonly type: 'run.stopped'; readonly runId: string; readonly at: string; readonly reason: string }
    | { readonly type: 'child.restarted'; readonly child: string; readonly reason: string; readonly at: string }
    | { readonly type: 'unit.registered'; readonly kind: string; readonly key: string; readonly lane: string; readonly state: string; readonly parent: { readonly kind: string; readonly key: string } | null; readonly supplier: string; readonly at: string }
    | { readonly type: 'unit.transitioned'; readonly kind: string; readonly key: string; readonly from: string; readonly to: string; readonly outcome: Skeleton; readonly event: string; readonly cause: TransitionCause; readonly attemptId: string | null; readonly at: string }
    | { readonly type: 'message.received'; readonly kind: string; readonly key: string; readonly event: string; readonly payload: Json; readonly at: string }
    | { readonly type: 'timer.armed'; readonly kind: string; readonly key: string; readonly event: string; readonly fireAt: string }
    | { readonly type: 'timer.fired'; readonly kind: string; readonly key: string; readonly event: string; readonly at: string }
    | { readonly type: 'attempt.started'; readonly attemptId: string; readonly kind: string; readonly key: string; readonly lane: string; readonly state: string; readonly flow: string; readonly number: number; readonly at: string }
    | { readonly type: 'attempt.blocked'; readonly attemptId: string; readonly step: string; readonly question: string; readonly report: string | null; readonly decisionSchema: Json; readonly at: string }
    | { readonly type: 'attempt.resumed'; readonly attemptId: string; readonly step: string; readonly decision: Json; readonly by: string; readonly at: string }
    | { readonly type: 'attempt.ended'; readonly attemptId: string; readonly end: AttemptEnd; readonly exit: string | null; readonly error: string | null; readonly at: string }
    | { readonly type: 'step.recorded'; readonly attemptId: string; readonly step: string; readonly result: Json; readonly at: string }
    | { readonly type: 'invocation.ended'; readonly invocationId: string; readonly attemptId: string; readonly step: string; readonly executable: string; readonly model: string | null; readonly account: string | null; readonly batch: boolean; readonly ok: boolean; readonly costUsd: number; readonly tokensIn: number; readonly tokensOut: number; readonly memoryIds: readonly string[]; readonly startedAt: string; readonly at: string }
    | { readonly type: 'trigger.fired'; readonly trigger: string; readonly sourceSeq: number; readonly consequence: string; readonly at: string }
    | { readonly type: 'memory.noted'; readonly journal: string; readonly itemId: string; readonly by: string; readonly at: string }
    | { readonly type: 'operation.performed'; readonly client: string; readonly operation: string; readonly input: Json; readonly at: string };

  export interface Sequenced<E> {
    readonly seq: number;
    readonly event: E;
  }

  export interface LedgerQuery {
    readonly afterSeq?: number;
    readonly types?: readonly LedgerEvent['type'][];
    readonly kind?: string;
    readonly key?: string;
    readonly attemptId?: string;
    readonly since?: string;
  }

  export interface Ledger {
    readonly name: string;
    append(events: readonly LedgerEvent[]): Promise<readonly number[]>;
    read(query: LedgerQuery): AsyncIterable<Sequenced<LedgerEvent>>;
    close(): Promise<void>;
  }

  export interface ProducerIO<R> {
    demand(): number;
    waitForDemand(): Promise<number>;
    emit(records: readonly R[]): Promise<void>;
    loadCursor(): Promise<string | null>;
    saveCursor(cursor: string): Promise<void>;
    stopped(): boolean;
    readonly whenStopped: Promise<void>;
  }

  export interface Producer<R> {
    readonly name: string;
    run(io: ProducerIO<R>): Promise<void>;
  }

  export interface StoredUnit {
    readonly key: string;
    readonly state: string;
    readonly data: Json;
    readonly version: string | null;
  }

  export interface Store {
    readonly name: string;
    load(kind: string, key: string): Promise<StoredUnit | null>;
    save(kind: string, unit: StoredUnit): Promise<StoredUnit>;
    list(kind: string, filter: { readonly states?: readonly string[] }): AsyncIterable<StoredUnit>;
  }

  export interface MemoryScope {
    readonly kinds: readonly string[];
    readonly roles: readonly string[];
    readonly skills: readonly string[];
    readonly resources: readonly { readonly resource: string; readonly key: string | null }[];
  }

  export interface MemoryItem {
    readonly id: string;
    readonly memoryKind: string;
    readonly created: string;
    readonly status: 'candidate' | 'active';
    readonly when: MemoryScope;
    readonly body: { readonly do: string; readonly condition: string; readonly because: string };
    readonly mergedFrom: readonly string[];
  }

  export interface MemoryFilter {
    readonly memoryKind: string;
    readonly status?: 'candidate' | 'active';
    readonly overlaps?: MemoryScope;
  }

  export interface Embedder {
    readonly name: string;
    embed(texts: readonly string[]): Promise<readonly (readonly number[])[]>;
  }

  export interface MemoryStore {
    readonly name: string;
    put(item: MemoryItem): Promise<void>;
    list(filter: MemoryFilter): AsyncIterable<MemoryItem>;
    similar?(text: string, limit: number, filter: MemoryFilter): Promise<readonly { readonly item: MemoryItem; readonly score: number }[]>;
    setStatus(id: string, status: 'candidate' | 'active'): Promise<void>;
    remove(id: string): Promise<void>;
  }

  export interface Usage {
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly costUsd: number;
  }

  export interface AccountState {
    readonly account: string;
    readonly windows: readonly { readonly name: string; readonly utilization: number; readonly resetsAt: string | null }[];
    readonly cooldownUntil: string | null;
    readonly byHarness: { readonly [harness: string]: number };
  }

  export interface Reservation {
    readonly id: string;
    readonly account: string;
    readonly harness: string;
  }

  export interface Meter {
    readonly name: string;
    read(account: string): Promise<AccountState>;
    reserve(account: string, request: { readonly harness: string; readonly shareCap: number; readonly estimate: Usage }): Promise<Reservation | null>;
    settle(reservation: Reservation, actual: Usage): Promise<void>;
    cooldown(account: string, untilIso: string, reason: string): Promise<void>;
  }

  export interface Credential {
    readonly account: string;
    readonly secret: Ref<string>;
  }

  export interface InvocationRequest {
    readonly invocationId: string;
    readonly model: string;
    readonly credential: Credential;
    readonly system: string;
    readonly intents: readonly string[];
    readonly memory: readonly MemoryItem[];
    readonly input: Json;
    readonly outputSchema: Json;
    readonly workspacePath: string | null;
    readonly hooks: readonly GuardHook[];
    readonly maxUsd: number | null;
    readonly answers: readonly { readonly question: string; readonly answer: Json }[];
  }

  export type InvocationResult =
    | { readonly status: 'output'; readonly output: Json; readonly usage: Usage }
    | { readonly status: 'asked'; readonly question: string; readonly usage: Usage }
    | { readonly status: 'error'; readonly error: string; readonly retryable: boolean; readonly cooldownUntil: string | null; readonly usage: Usage };

  export interface Driver {
    readonly name: string;
    invoke(request: InvocationRequest): Promise<InvocationResult>;
    submitBatch?(requests: readonly InvocationRequest[]): Promise<string>;
    collectBatch?(batchId: string): Promise<readonly InvocationResult[] | null>;
    estimate(request: InvocationRequest): Usage;
  }

  export interface Account {
    readonly name: string;
    readonly driver: Driver;
    readonly secret: Ref<string>;
    readonly meter: Meter | null;
  }

  export interface Model {
    readonly name: string;
    readonly driver: Driver;
    readonly batch: boolean;
    readonly usdPerMillionIn: number;
    readonly usdPerMillionOut: number;
    readonly batchDiscount: number;
  }

  export interface ExecRequest {
    readonly argv: readonly string[];
    readonly cwd: string | null;
    readonly env: { readonly [name: string]: string };
    readonly timeoutSeconds: number | null;
  }

  export interface Runner {
    readonly name: string;
    readonly slots: number;
    preflight(): Promise<{ readonly ok: boolean; readonly reason: string | null }>;
    exec(request: ExecRequest): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
  }

  export interface Workspace {
    readonly name: string;
    acquire(attemptId: string): Promise<{ readonly path: string; release(end: AttemptEnd): Promise<void> }>;
  }

  export type Verdict = { readonly allow: true } | { readonly allow: false; readonly reason: string };

  export interface GuardHook {
    readonly guard: string;
    readonly on: 'write' | 'stop';
    check(context: { readonly attemptId: string; readonly workspacePath: string | null; readonly resourceKey: string | null }): Promise<Verdict>;
  }

  export interface Blocker {
    readonly attemptId: string;
    readonly kind: string;
    readonly key: string;
    readonly step: string;
    readonly question: string;
    readonly report: string | null;
    readonly decisionSchema: Json;
  }

  export interface ControlApi {
    describe(): readonly { readonly operation: string; readonly inputSchema: Json }[];
    readWork(query: { readonly kind?: string; readonly states?: readonly string[] }): Promise<readonly StoredUnit[]>;
    createUnit(input: { readonly lane: string; readonly data: Json }): Promise<string>;
    sendMessage(input: { readonly kind: string; readonly key: string; readonly event: string; readonly payload: Json }): Promise<void>;
    cancelUnit(input: { readonly kind: string; readonly key: string; readonly reason: string }): Promise<void>;
    listBlockers(): Promise<readonly Blocker[]>;
    resolveBlocker(input: { readonly attemptId: string; readonly decision: Json; readonly by: string }): Promise<void>;
    readMemory(filter: MemoryFilter & { readonly journal: string }): Promise<readonly MemoryItem[]>;
    writeMemory(input: { readonly journal: string; readonly item: Omit<MemoryItem, 'id' | 'created' | 'mergedFrom'> }): Promise<string>;
    curateMemory(input: { readonly journal: string } & ({ readonly accept: string } | { readonly drop: string } | { readonly merge: readonly string[]; readonly into: MemoryItem['body'] })): Promise<void>;
    readTelemetry(query: { readonly days: number }): Promise<{ readonly kinds: { readonly [kind: string]: Outcomes }; readonly spendUsd: number }>;
    readAccounts(): Promise<readonly AccountState[]>;
    writeShares(input: { readonly pool: string; readonly account: string; readonly share: number }): Promise<void>;
    custom(input: { readonly operation: string; readonly input: Json }): Promise<Json>;
  }

  export interface Transport {
    readonly name: string;
    serve(api: ControlApi, granted: readonly string[]): Promise<{ stop(): Promise<void> }>;
  }

  export interface Client {
    readonly name: string;
    readonly transport: Transport;
    readonly granted: readonly string[];
  }

  export interface ObserverView {
    readonly metrics: Metrics;
    units(kind: string): AsyncIterable<{ readonly key: string; readonly state: string; readonly outcome: Skeleton; readonly blocked: boolean }>;
  }

  export interface Observer {
    readonly name: string;
    observe(event: Sequenced<LedgerEvent>, view: ObserverView): Promise<void>;
  }

  export interface Policy<I, O> {
    readonly name: string;
    readonly decide: (input: I, context: PolicyContext) => O;
  }
}
