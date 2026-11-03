declare module 'harness-dsl/kernel' {
  import type { ZodType } from 'zod';

  export type Scalar = string | number | boolean;
  export type Attributes = Record<string, Scalar>;
  export type Position = 'pending' | 'active' | 'waiting' | 'terminal';
  export type Verdict = 'success' | 'failure' | 'neutral';
  export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled';
  export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
  export type Intent = 'read' | 'write' | 'execute' | 'search' | 'browse' | 'ask' | 'remember';
  export type RestartRule = 'rerun' | 'park' | 'reconcile';

  export interface Named { readonly name: string }
  export interface EnvRef { readonly ref: 'env'; readonly name: string }
  export interface PortRef { readonly ref: 'port'; readonly index: number }
  export type Secret = string | EnvRef;

  export interface Duration { readonly minutes?: number; readonly hours?: number; readonly days?: number }
  export type Bound = { readonly below: number } | { readonly above: number };

  export interface Resolver {
    secret(secret: Secret): string;
    port(ref: PortRef): number;
  }
  export interface Stop { stop(): Promise<void> }

  export interface Recurrence {
    readonly timing: 'recurrence';
    readonly every:
      | { readonly intervalMs: number }
      | { readonly daily: string }
      | { readonly weekly: Weekday; readonly at: string }
      | { readonly monthly: number; readonly at: string };
    readonly timeZone: string | null;
  }
  export interface Delay { readonly timing: 'delay'; readonly ms: number }
  export interface AttributeTime { readonly timing: 'attribute'; readonly key: string }
  export type Timing = Recurrence | Delay | AttributeTime;
  export interface TimerPayload { readonly firedAt: number }

  export type Create<A, F> =
    ({} extends A ? { readonly attributes?: A } : { readonly attributes: A }) &
    ({} extends F ? { readonly fields?: F } : { readonly fields: F });
  export type EventSupply<Ev> = {
    [N in keyof Ev & string]: { readonly key: string; readonly event: N; readonly payload: Ev[N] };
  }[keyof Ev & string];
  export type Supply<A, F, Ev> = { readonly create: Create<A, F> } | EventSupply<Ev>;

  export interface UnitView<A = Attributes> {
    readonly id: string;
    readonly key: string;
    readonly kind: string;
    readonly lane: string;
    readonly state: string;
    readonly position: Position;
    readonly verdict: Verdict | null;
    readonly attributes: A;
    readonly parentId: string | null;
    readonly createdAt: number;
    readonly updatedAt: number;
    readonly attemptCount: number;
    readonly costUsd: number;
  }

  export type AttemptStatus = 'running' | 'blocked' | 'waiting' | AttemptOutcome;
  export interface WaitView {
    readonly on: 'human' | 'recovery' | 'timer' | 'children' | 'batch' | 'capacity';
    readonly step: string;
    readonly until: number | null;
    readonly question: string | null;
  }
  export interface AttemptView {
    readonly id: string;
    readonly unitId: string;
    readonly lane: string;
    readonly number: number;
    readonly status: AttemptStatus;
    readonly step: string | null;
    readonly waiting: WaitView | null;
    readonly flowFingerprint: string;
    readonly startedAt: number;
    readonly endedAt: number | null;
    readonly durationMs: number;
    readonly costUsd: number;
    readonly models: Readonly<Record<string, string>>;
  }
  export interface ChildView {
    readonly unitId: string;
    readonly key: string;
    readonly state: string;
    readonly position: Position;
    readonly verdict: Verdict | null;
  }
  export interface EventRecord {
    readonly name: string;
    readonly payload: unknown;
    readonly at: number;
    readonly source: string;
  }
  export interface Usage {
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly costUsd: number;
    readonly pricing: 'standard' | 'batch' | 'subscription';
  }
  export interface InvocationView extends Usage {
    readonly id: string;
    readonly attemptId: string;
    readonly step: string;
    readonly executable: string;
    readonly number: number;
    readonly status: 'running' | 'succeeded' | 'failed' | 'timedOut' | 'cancelled' | 'interrupted';
    readonly durationMs: number;
    readonly account: string | null;
    readonly model: string | null;
    readonly batchId: string | null;
  }

  export interface Cause {
    readonly by: 'flow' | 'event' | 'trigger' | 'operator' | 'supplier' | 'budget' | 'scheduler' | 'recovery';
    readonly ref: string;
  }
  export interface MetricRead { readonly metric: string; readonly query: string; readonly rate: number | null; readonly n: number }

  export type NewEvent =
    | { readonly type: 'harness.claimed'; readonly at: number; readonly holder: string; readonly takenOverFrom: string | null }
    | { readonly type: 'unit.created'; readonly at: number; readonly unit: UnitView; readonly cause: Cause }
    | { readonly type: 'unit.deduped'; readonly at: number; readonly unitId: string; readonly cause: Cause }
    | { readonly type: 'unit.transition'; readonly at: number; readonly unitId: string; readonly lane: string; readonly from: string | null; readonly to: string; readonly position: Position; readonly verdict: Verdict | null; readonly attemptId: string | null; readonly cause: Cause }
    | { readonly type: 'unit.attributes'; readonly at: number; readonly unitId: string; readonly lane: string; readonly attemptId: string | null; readonly attributes: Attributes; readonly cause: Cause }
    | { readonly type: 'attempt.status'; readonly at: number; readonly attempt: AttemptView; readonly cause: Cause; readonly reason: string | null }
    | { readonly type: 'step.recorded'; readonly at: number; readonly attemptId: string; readonly unitId: string; readonly lane: string; readonly step: string; readonly status: 'succeeded' | 'failed' | 'skipped'; readonly output: unknown }
    | { readonly type: 'invocation.recorded'; readonly at: number; readonly invocation: InvocationView }
    | { readonly type: 'batch.submitted'; readonly at: number; readonly attemptId: string; readonly step: string; readonly batchId: string }
    | { readonly type: 'event.received'; readonly at: number; readonly unitId: string; readonly event: EventRecord; readonly moved: { readonly from: string; readonly to: string } | null }
    | { readonly type: 'halt.resolved'; readonly at: number; readonly attemptId: string; readonly step: string; readonly actor: string; readonly decision: unknown }
    | { readonly type: 'operation.recorded'; readonly at: number; readonly operation: string; readonly actor: string; readonly input: unknown }
    | { readonly type: 'policy.decided'; readonly at: number; readonly policy: string; readonly reads: readonly MetricRead[]; readonly result: unknown }
    | { readonly type: 'metric.crossed'; readonly at: number; readonly trigger: string; readonly group: Attributes; readonly direction: 'enter' | 'exit'; readonly rate: number; readonly n: number }
    | { readonly type: 'lane.paused'; readonly at: number; readonly lane: string; readonly firingSeq: number; readonly reason: string }
    | { readonly type: 'lane.resumed'; readonly at: number; readonly lane: string; readonly firingSeq: number; readonly reason: string }
    | { readonly type: 'trigger.fired'; readonly at: number; readonly trigger: string; readonly sourceSeq: number; readonly consequences: readonly string[] };
  export type LedgerEvent = NewEvent & { readonly seq: number };

  export interface QueueEntry {
    readonly id: string;
    readonly unitId: string;
    readonly lane: string;
    readonly reason: 'start' | 'resume' | 'timer';
    readonly attemptId: string | null;
    readonly event: string | null;
    readonly readyAt: number;
    readonly enqueuedAt: number;
  }
  export interface QueueChange { readonly put?: readonly QueueEntry[]; readonly remove?: readonly string[] }
  export interface EventQuery { readonly afterSeq?: number; readonly types?: readonly NewEvent['type'][]; readonly unitId?: string; readonly lane?: string; readonly sinceMs?: number }
  export interface UnitQuery { readonly kind?: string; readonly lane?: string; readonly positions?: readonly Position[]; readonly where?: Attributes; readonly parentId?: string; readonly limit?: number }
  export interface AttemptQuery { readonly unitId?: string; readonly lane?: string; readonly statuses?: readonly AttemptStatus[] }

  export interface AccountState {
    readonly account: string;
    readonly windowStartedAt: number;
    readonly windowEndsAt: number;
    readonly utilization: number;
    readonly cooldownUntil: number | null;
    readonly observedAt: number;
  }
  export interface QuotaUsage { readonly account: string; readonly harness: string; readonly at: number; readonly usage: Usage }

  export interface Quota extends Named {
    readonly quota: true;
    open(resolve: Resolver): Promise<void>;
    close(): Promise<void>;
    state(account: string): Promise<AccountState>;
    consume(usage: QuotaUsage): Promise<void>;
    cooldown(account: string, untilMs: number, reason: string): Promise<void>;
    harnessUtilization(account: string, harness: string, windowStartedAt: number): Promise<number>;
  }

  export interface Claim { readonly granted: boolean; readonly heldBy: string | null; readonly expiresAt: number }

  export interface Ledger extends Named {
    readonly ledger: true;
    readonly quota: Quota;
    open(resolve: Resolver): Promise<void>;
    close(): Promise<void>;
    claim(holder: string, ttlMs: number): Promise<Claim>;
    renew(holder: string, ttlMs: number): Promise<Claim>;
    append(holder: string, events: readonly NewEvent[], queue?: QueueChange): Promise<readonly LedgerEvent[]>;
    events(query: EventQuery): AsyncIterable<LedgerEvent>;
    unit(id: string): Promise<UnitView | null>;
    unitByKey(kind: string, key: string): Promise<UnitView | null>;
    units(query: UnitQuery): Promise<readonly UnitView[]>;
    attempts(query: AttemptQuery): Promise<readonly AttemptView[]>;
    queue(query: { readyBy?: number; lane?: string }): Promise<readonly QueueEntry[]>;
    lease(attemptId: string, keys: readonly string[]): Promise<{ granted: boolean; heldBy: string | null }>;
    release(attemptId: string): Promise<void>;
  }

  export interface ScheduleSupplyContext<A> {
    readonly now: number;
    readonly units: readonly UnitView<A>[];
  }
  export interface SupplySink<Out> { emit(item: Out): Promise<void> }
  export interface Supplier<Out> extends Named {
    readonly supplier: true;
    start(sink: SupplySink<Out>, context: { resolve: Resolver; ledger: Pick<Ledger, 'units' | 'unitByKey'> }): Promise<Stop>;
  }

  export interface StoreRef { readonly kind: string; readonly key: string; readonly unitId: string; readonly lane: string }
  export interface Store extends Named {
    readonly store: true;
    open(resolve: Resolver): Promise<void>;
    close(): Promise<void>;
    create(ref: StoreRef, fields: Readonly<Record<string, unknown>>, state: string): Promise<void>;
    load(ref: StoreRef): Promise<Readonly<Record<string, unknown>> | null>;
    save(ref: StoreRef, fields: Readonly<Record<string, unknown>>): Promise<void>;
    transition(ref: StoreRef, state: string, position: Position): Promise<void>;
  }

  export interface MemoryKindSpec extends Named { readonly sort: 'experience' | 'taste'; readonly curation: boolean }
  export interface JournalSpec extends Named { readonly kind: MemoryKindSpec }
  export interface MemoryScope {
    readonly kinds: readonly string[];
    readonly roles: readonly string[];
    readonly resources: readonly string[];
    readonly attributes: Attributes;
  }
  export interface MemoryDraft {
    readonly rule: string;
    readonly because: string;
    readonly when?: {
      readonly kinds?: readonly Named[];
      readonly roles?: readonly Named[];
      readonly resources?: readonly Named[];
      readonly attributes?: Attributes;
    };
  }
  export interface MemoryItem {
    readonly id: string;
    readonly kind: string;
    readonly sort: 'experience' | 'taste';
    readonly created: number;
    readonly status: 'candidate' | 'accepted';
    readonly when: MemoryScope;
    readonly rule: string;
    readonly because: string;
    readonly source: string;
    readonly mergedFrom: readonly string[];
  }
  export interface MemoryStore extends Named {
    readonly memoryStore: true;
    open(resolve: Resolver): Promise<void>;
    close(): Promise<void>;
    put(item: MemoryItem): Promise<void>;
    update(id: string, patch: Partial<Pick<MemoryItem, 'status' | 'rule' | 'because' | 'when' | 'mergedFrom'>>): Promise<void>;
    remove(id: string): Promise<void>;
    search(query: {
      kinds: readonly string[];
      scope: MemoryScope;
      text: string | null;
      statuses: readonly MemoryItem['status'][];
      limit: number;
    }): Promise<readonly { item: MemoryItem; similarity: number | null }[]>;
  }

  export interface CommandInput { readonly args?: readonly string[]; readonly stdin?: string; readonly env?: Readonly<Record<string, Secret>> }
  export interface CommandResult<D = null> { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly durationMs: number; readonly data: D }
  export interface CommandSpec extends Named { readonly argv: readonly string[]; readonly parse: ZodType<unknown> | null }

  export type Reconciled<O> =
    | { readonly status: 'finished'; readonly output: O }
    | { readonly status: 'notStarted' }
    | { readonly status: 'unknown' };

  export interface Executable<I, O> extends Named {
    readonly executable: 'command' | 'agent' | 'external';
    readonly io?: (input: I) => O;
  }
  export interface External<I, O> extends Executable<I, O> {
    readonly executable: 'external';
    invoke(input: I, context: { resolve: Resolver; attemptId: string | null; invocationId: string }): Promise<O>;
    reconcile?(invocationId: string, resolve: Resolver): Promise<Reconciled<O>>;
  }

  export interface Slot {
    readonly id: string;
    readonly host: string;
    readonly workdir: string | null;
    exec(command: CommandSpec, input: CommandInput, timeoutMs: number | null): Promise<CommandResult<unknown>>;
    release(): Promise<void>;
  }
  export interface Runner extends Named {
    readonly runner: true;
    readonly slots: number;
    open(resolve: Resolver): Promise<void>;
    acquire(request: { attemptId: string; unitId: string; lane: string }): Promise<Slot | null>;
    reacquire(attemptId: string): Promise<Slot | null>;
  }

  export interface RetrySpec {
    readonly maxRetries: number;
    readonly backoff: 'exponential' | 'fixed';
    readonly initialDelayMs: number;
    readonly maxDelayMs: number | null;
  }

  export interface Account extends Named {
    readonly account: true;
    readonly provider: string;
    readonly credentials: Readonly<Record<string, Secret>>;
    readonly quota: Quota | null;
  }
  export interface RoleSpec extends Named {
    readonly allowedIntents: readonly Intent[];
    readonly text: string;
    readonly inputSchema: ZodType<unknown>;
    readonly outputSchema: ZodType<unknown>;
  }
  export interface InvocationTools {
    ask(question: string): Promise<string>;
    record(draft: MemoryDraft): Promise<void>;
    lease(paths: readonly string[]): Promise<boolean>;
  }
  export interface InvocationRequest {
    readonly invocationId: string;
    readonly model: string;
    readonly account: Account;
    readonly role: RoleSpec;
    readonly input: unknown;
    readonly memory: readonly MemoryItem[];
    readonly slot: Slot | null;
    readonly leaseWrites: boolean;
    readonly mustPass: CommandSpec | null;
    readonly remainingUsd: number | null;
    readonly tools: InvocationTools;
  }
  export interface InvocationResult { readonly output: unknown; readonly usage: Usage }
  export interface BatchHandle { readonly batchId: string }
  export interface Driver extends Named {
    invoke(request: InvocationRequest, resolve: Resolver): Promise<InvocationResult>;
    reconcile?(invocationId: string, resolve: Resolver): Promise<Reconciled<InvocationResult>>;
    submitBatch?(requests: readonly InvocationRequest[], resolve: Resolver): Promise<BatchHandle>;
    collectBatch?(handle: BatchHandle, resolve: Resolver): Promise<readonly InvocationResult[] | null>;
  }
  export interface Model extends Named {
    readonly model: true;
    readonly provider: string;
    readonly batch: boolean;
    readonly driver: Driver;
    readonly pricing: { readonly inputPerMTokUsd: number; readonly outputPerMTokUsd: number; readonly batchDiscount: number };
  }

  export interface MetricQuery {
    readonly lane?: Named;
    readonly kind?: Named | string;
    readonly model?: Named;
    readonly agent?: Named;
    readonly window: Duration;
    readonly where?: Attributes;
  }
  export interface Rate { readonly rate: number | null; readonly hits: number; readonly n: number; readonly window: Duration }
  export interface OutcomeCounts {
    readonly n: number;
    readonly byVerdict: Readonly<Record<Verdict, number>>;
    readonly byState: Readonly<Record<string, number>>;
    share(state: Named | string): Rate;
  }
  export interface CostStat { readonly meanUsd: number | null; readonly totalUsd: number; readonly n: number }
  export interface MetricSpec extends Named {
    readonly over: 'step' | 'transition' | 'invocation';
    readonly source: string;
    test(event: LedgerEvent): boolean | null;
  }
  export interface Metrics {
    success(query: MetricQuery): Rate;
    outcomes(query: MetricQuery): OutcomeCounts;
    cost(query: MetricQuery & { attempt?: AttemptOutcome }): CostStat;
    spentUsd(query: { sinceMs: number; lane?: Named }): number;
    read(metric: MetricSpec, query: MetricQuery): Rate;
    created(query: { lane: Named; sinceMs: number; where?: Attributes }): number;
    pausedMs(query: { lane: Named; sinceMs: number }): number;
  }

  export interface Clock { readonly now: number; startOfDay(timeZone?: string): number; startOfMonth(timeZone?: string): number }
  export interface PolicyContext {
    readonly clock: Clock;
    readonly metrics: Metrics;
    readonly unit: UnitView | null;
    readonly agent: string | null;
    readonly lane: string | null;
  }
  export interface LaneLike<A> extends Named {
    readonly entity: 'lane';
    readonly types?: { attributes: A };
  }
  export interface Candidate<A = Attributes> {
    readonly unit: UnitView<A>;
    readonly entry: QueueEntry;
    readonly waitedMs: number;
    readonly timers: Readonly<Record<string, number>>;
    is<B>(lane: LaneLike<B>): this is Candidate<B>;
  }
  export interface ScheduleContext {
    readonly clock: Clock;
    readonly metrics: Metrics;
    readonly candidates: readonly Candidate[];
    readonly open: readonly AttemptView[];
    readonly paused: readonly string[];
    inLane(attempt: AttemptView, lane: Named): boolean;
  }
  export interface ScheduleDecision {
    readonly start: readonly Candidate[];
    readonly preempt?: readonly AttemptView[];
  }
  export interface AccountView extends AccountState {
    readonly share: number;
    readonly harnessUtilization: number;
    readonly eligible: boolean;
  }
  export interface AccountContext extends PolicyContext { readonly eligible: readonly AccountView[] }
  export interface RecallCandidate {
    readonly item: MemoryItem;
    readonly specificity: number;
    readonly track: { readonly present: number; readonly succeeded: number };
    readonly similarity: number | null;
  }
  export interface RecallContext extends PolicyContext {
    readonly role: string;
    readonly query: string | null;
    readonly candidates: readonly RecallCandidate[];
    readonly limit: number;
  }

  export interface Policy<C, R> extends Named {
    readonly policy: 'schedule' | 'choice' | 'account' | 'gate' | 'recall';
    decide(context: C): R;
  }
  export type SchedulePolicy = Policy<ScheduleContext, ScheduleDecision>;
  export interface ChoicePolicy<T> extends Policy<PolicyContext, T> { readonly options: readonly T[] }
  export type AccountPolicy = Policy<AccountContext, AccountView | null>;
  export type GatePolicy = Policy<PolicyContext, boolean>;
  export type RecallPolicy = Policy<RecallContext, readonly RecallCandidate[]>;

  export interface TransitionEvent<A, Out> {
    readonly unit: UnitView<A>;
    readonly from: string | null;
    readonly to: string;
    readonly position: Position;
    readonly verdict: Verdict | null;
    readonly attempt: AttemptView | null;
    readonly outputs: Partial<Out>;
    readonly cause: Cause;
  }
  export interface StreakEvent<A> {
    readonly unit: UnitView<A>;
    readonly count: number;
    readonly units: readonly UnitView<A>[];
  }
  export interface StepEvent<A, O> {
    readonly unit: UnitView<A>;
    readonly attempt: AttemptView;
    readonly step: string;
    readonly status: 'succeeded' | 'failed' | 'skipped';
    readonly output: O;
  }
  export interface EventEvent<A, P> {
    readonly before: UnitView<A>;
    readonly moved: { readonly from: string; readonly to: string } | null;
    readonly event: string;
    readonly payload: P;
    readonly at: number;
  }
  export interface CrossingEvent<A> {
    readonly direction: 'enter' | 'exit';
    readonly group: Partial<A>;
    readonly rate: number;
    readonly hits: number;
    readonly n: number;
    readonly at: number;
  }

  export type BuiltinOperation =
    | 'readWork' | 'createWork' | 'updateWork' | 'deliverEvents' | 'resolveBlocks' | 'recoverAttempts'
    | 'readMemory' | 'writeMemory' | 'curateMemory'
    | 'readTelemetry' | 'readAccounts' | 'setShares';
  export interface OperationSpec extends Named {
    readonly builtin: BuiltinOperation | null;
    readonly inputSchema: ZodType<unknown> | null;
    readonly executable: Executable<never, unknown> | null;
    prepare(input: unknown): unknown;
  }
  export interface AccessSpec extends Named { readonly operations: readonly OperationSpec[] }
  export type OperationResult = { readonly ok: true; readonly output: unknown } | { readonly ok: false; readonly error: string };
  export interface ControlApi {
    readonly harness: string;
    operations(access: AccessSpec): readonly OperationSpec[];
    invoke(access: AccessSpec, actor: string, operation: string, input: unknown): Promise<OperationResult>;
  }
  export interface Client extends Named {
    readonly client: true;
    readonly access: AccessSpec;
    serve(api: ControlApi, resolve: Resolver): Promise<Stop>;
  }

  export interface LedgerReader {
    readonly ledger: Pick<Ledger, 'unit' | 'units' | 'attempts' | 'queue' | 'events'>;
    readonly metrics: Metrics;
  }
  export interface Projection extends Named {
    readonly projection: true;
    open(read: LedgerReader, resolve: Resolver): Promise<void>;
    project(event: LedgerEvent, read: LedgerReader): Promise<void>;
  }

  export interface Running {
    readonly control: ControlApi;
    stop(): Promise<void>;
  }
}
