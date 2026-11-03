declare module 'harness-dsl/kernel' {
  import type { ZodType } from 'zod';

  export type Scalar = string | number | boolean;
  export type Attributes = Readonly<Record<string, Scalar>>;
  export type Position = 'pending' | 'active' | 'waiting' | 'terminal';
  export type Verdict = 'success' | 'failure' | 'neutral';
  export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled';
  export type AttemptStatus = 'running' | 'blocked' | 'waiting' | AttemptOutcome;
  export type BlockReason = 'decision' | 'stepFailure' | 'budget' | 'interrupted' | 'definitionChanged';
  export type KeyUniqueness = 'forever' | 'whileOpen';
  export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
  export type Intent = 'read' | 'write' | 'execute' | 'search' | 'browse' | 'ask' | 'remember';
  export type Effect = 'repeatable' | 'unrepeatable' | 'external';
  export type Crossing = 'breach' | 'recovery';
  export type Band = { readonly below: number } | { readonly above: number };

  export interface Named { readonly name: string }
  export interface EnvRef { readonly ref: 'env'; readonly name: string }
  export interface PortRef { readonly ref: 'port'; readonly index: number }
  export type Secret = string | EnvRef;

  export interface Resolver {
    secret(secret: Secret): string;
    port(ref: PortRef): number;
  }
  export interface Stop { stop(): Promise<void> }

  export interface Duration { readonly minutes?: number; readonly hours?: number; readonly days?: number }
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
  export interface TimerPayload { readonly firedAt: number; readonly dueAt: number }

  export interface StateSpec extends Named {
    readonly position: Position;
    readonly verdict: Verdict | null;
  }

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

  export interface BlockView {
    readonly reason: BlockReason;
    readonly step: string;
    readonly question: string;
    readonly choices: readonly string[];
  }
  export interface WaitView {
    readonly on: 'timer' | 'children' | 'batch' | 'capacity';
    readonly step: string;
    readonly until: number | null;
  }
  export interface AttemptView {
    readonly id: string;
    readonly unitId: string;
    readonly lane: string;
    readonly number: number;
    readonly status: AttemptStatus;
    readonly step: string | null;
    readonly block: BlockView | null;
    readonly wait: WaitView | null;
    readonly definition: string;
    readonly startedAt: number;
    readonly endedAt: number | null;
    readonly durationMs: number;
    readonly costUsd: number;
    readonly interruptions: number;
    readonly models: Readonly<Record<string, string>>;
  }
  export interface ChildView {
    readonly unitId: string;
    readonly key: string;
    readonly state: string;
    readonly position: Position;
    readonly verdict: Verdict | null;
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
    readonly kind: 'command' | 'agent' | 'external';
    readonly number: number;
    readonly status: 'succeeded' | 'failed' | 'timedOut' | 'cancelled' | 'interrupted';
    readonly durationMs: number;
    readonly account: string | null;
    readonly model: string | null;
    readonly agent: string | null;
    readonly batchId: string | null;
  }

  export type Register =
    | 'position'
    | 'attempt'
    | 'capacity'
    | 'spend'
    | 'quota'
    | 'effect'
    | 'timer'
    | 'latch'
    | 'admission'
    | 'lease'
    | 'writer';
  export interface Leg {
    readonly register: Register;
    readonly bucket: string;
    readonly amount: number;
  }
  export interface Cause {
    readonly by: 'supplier' | 'clock' | 'operator' | 'trigger' | 'flow' | 'policy' | 'scheduler' | 'budget' | 'restart' | 'executable';
    readonly actor: string;
    readonly entry: number | null;
  }
  export interface MetricRead {
    readonly metric: string;
    readonly query: string;
    readonly rate: number | null;
    readonly hits: number;
    readonly n: number;
  }
  export type Resolution = 'rerun' | 'confirmed' | 'parked' | 'collected' | 'reconciled' | 'replayed';

  export type Fact =
    | { readonly type: 'unit.created'; readonly unit: UnitView }
    | { readonly type: 'unit.moved'; readonly unitId: string; readonly lane: string; readonly from: string; readonly to: string; readonly position: Position; readonly verdict: Verdict | null; readonly attemptId: string | null }
    | { readonly type: 'unit.attributes'; readonly unitId: string; readonly lane: string; readonly set: Attributes }
    | { readonly type: 'attempt.status'; readonly attempt: AttemptView }
    | { readonly type: 'step.recorded'; readonly attemptId: string; readonly unitId: string; readonly lane: string; readonly step: string; readonly status: 'succeeded' | 'failed' | 'skipped'; readonly resolvedBy: 'executable' | 'human' | 'policy'; readonly output: unknown }
    | { readonly type: 'effect.opened'; readonly invocationId: string; readonly attemptId: string; readonly step: string; readonly effect: Effect; readonly input: unknown }
    | { readonly type: 'effect.settled'; readonly invocation: InvocationView; readonly output: unknown }
    | { readonly type: 'batch.submitted'; readonly attemptId: string; readonly step: string; readonly batchId: string; readonly invocationIds: readonly string[] }
    | { readonly type: 'event.received'; readonly unitId: string; readonly event: string; readonly payload: unknown; readonly reaction: { readonly from: string; readonly to: string } | null }
    | { readonly type: 'timer.armed'; readonly unitId: string; readonly timer: string; readonly dueAt: number }
    | { readonly type: 'timer.disarmed'; readonly unitId: string; readonly timer: string; readonly dueAt: number }
    | { readonly type: 'halt.opened'; readonly attemptId: string; readonly block: BlockView }
    | { readonly type: 'halt.resolved'; readonly attemptId: string; readonly step: string; readonly actor: string; readonly decision: unknown }
    | { readonly type: 'threshold.crossed'; readonly threshold: string; readonly group: Scalar | null; readonly direction: Crossing; readonly reading: MetricRead }
    | { readonly type: 'lane.admission'; readonly lane: string; readonly open: boolean; readonly reading: MetricRead | null }
    | { readonly type: 'restart.resolved'; readonly attemptId: string; readonly invocationId: string | null; readonly resolution: Resolution }
    | { readonly type: 'operation.recorded'; readonly operation: string; readonly actor: string; readonly input: unknown }
    | { readonly type: 'policy.decided'; readonly policy: string; readonly reads: readonly MetricRead[]; readonly result: unknown }
    | { readonly type: 'trigger.fired'; readonly trigger: string; readonly consequences: readonly string[]; readonly suppressed: readonly string[] }
    | { readonly type: 'writer.claimed'; readonly holder: string; readonly epoch: number; readonly tookOverFrom: string | null };

  export interface NewEntry {
    readonly at: number;
    readonly cause: Cause;
    readonly legs: readonly Leg[];
    readonly fact: Fact;
  }
  export interface Entry extends NewEntry {
    readonly seq: number;
    readonly epoch: number;
  }

  export interface QueueEntry {
    readonly id: string;
    readonly unitId: string;
    readonly lane: string;
    readonly reason: 'start' | 'resume' | 'timer';
    readonly attemptId: string | null;
    readonly timer: string | null;
    readonly readyAt: number;
    readonly enqueuedAt: number;
  }
  export interface QueueChange { readonly put?: readonly QueueEntry[]; readonly remove?: readonly string[] }
  export interface EntryQuery {
    readonly afterSeq?: number;
    readonly types?: readonly Fact['type'][];
    readonly unitId?: string;
    readonly attemptId?: string;
    readonly lane?: string;
    readonly sinceMs?: number;
  }
  export interface UnitQuery {
    readonly kind?: string;
    readonly lane?: string;
    readonly positions?: readonly Position[];
    readonly where?: Attributes;
    readonly parentId?: string;
    readonly limit?: number;
  }
  export interface AttemptQuery { readonly unitId?: string; readonly lane?: string; readonly statuses?: readonly AttemptStatus[] }

  export interface WriterClaim {
    readonly holder: string;
    readonly epoch: number;
    readonly expiresAt: number;
  }

  export interface Ledger extends Named {
    readonly ledger: true;
    open(resolve: Resolver): Promise<void>;
    close(): Promise<void>;
    claim(holder: string, ttlMs: number): Promise<WriterClaim | null>;
    renew(claim: WriterClaim): Promise<WriterClaim | null>;
    post(claim: WriterClaim, entries: readonly NewEntry[], queue?: QueueChange): Promise<readonly Entry[]>;
    entries(query: EntryQuery): AsyncIterable<Entry>;
    balances(register: Register, bucketPrefix?: string): Promise<Readonly<Record<string, number>>>;
    unit(id: string): Promise<UnitView | null>;
    unitByKey(kind: string, key: string): Promise<UnitView | null>;
    units(query: UnitQuery): Promise<readonly UnitView[]>;
    attempts(query: AttemptQuery): Promise<readonly AttemptView[]>;
    queue(query: { readyBy?: number; lane?: string }): Promise<readonly QueueEntry[]>;
  }

  export interface AccountState {
    readonly account: string;
    readonly windowStartedAt: number;
    readonly windowEndsAt: number;
    readonly utilization: number;
    readonly cooldownUntil: number | null;
    readonly observedAt: number;
  }
  export interface Quota extends Named {
    readonly quota: true;
    open(resolve: Resolver): Promise<void>;
    close(): Promise<void>;
    state(account: string): Promise<AccountState>;
    consume(account: string, usage: Usage): Promise<{ readonly utilizationDelta: number }>;
    cooldown(account: string, untilMs: number, reason: string): Promise<void>;
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
    transition(ref: StoreRef, state: string, position: Position, verdict: Verdict | null): Promise<void>;
  }

  export interface MemoryKindSpec extends Named { readonly sort: 'experience' | 'taste'; readonly curation: boolean }
  export interface JournalSpec extends Named { readonly kind: MemoryKindSpec }
  export interface MemoryScope {
    readonly kinds: readonly string[];
    readonly roles: readonly string[];
    readonly attributes: Attributes;
  }
  export interface MemoryDraft {
    readonly rule: string;
    readonly because: string;
    readonly when?: {
      readonly kinds?: readonly Named[];
      readonly roles?: readonly Named[];
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
  export interface Confirmation { readonly data: { readonly happened: boolean } }

  export interface Executable<I, O> extends Named {
    readonly executable: 'command' | 'agent' | 'external';
    readonly io?: (input: I) => O;
  }
  export type Reconciled<O> =
    | { readonly status: 'finished'; readonly output: O; readonly usage: Usage }
    | { readonly status: 'failed'; readonly error: string }
    | { readonly status: 'running' }
    | { readonly status: 'unknown' };
  export interface External<I, O> extends Executable<I, O> {
    readonly executable: 'external';
    invoke(input: I, context: { resolve: Resolver; invocationId: string }): Promise<O>;
    reconcile?(invocationId: string, input: I, resolve: Resolver): Promise<Reconciled<O>>;
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
    reconcile(invocationId: string, resolve: Resolver): Promise<Reconciled<unknown>>;
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
  export interface PauseStat { readonly totalMs: number; readonly pauses: number; readonly pausedNow: boolean }
  export interface MetricSpec extends Named {
    readonly over: 'step' | 'transition' | 'invocation';
    readonly source: string;
    test(entry: Entry): boolean | null;
  }
  export interface ThresholdSpec extends Named {
    readonly metric: MetricSpec;
    readonly lane: string | null;
    readonly per: string | null;
    readonly window: Duration;
    readonly minN: number;
    readonly breach: Band;
    readonly recovery: Band;
  }
  export interface TriggerSpec extends Named {
    readonly sourceKind: 'transition' | 'streak' | 'step' | 'event' | 'crossing';
  }
  export interface Metrics {
    success(query: MetricQuery): Rate;
    outcomes(query: MetricQuery): OutcomeCounts;
    attempts(query: MetricQuery): Rate;
    cost(query: MetricQuery & { verdict?: Verdict }): CostStat;
    spentUsd(query: { sinceMs: number; lane?: Named }): number;
    created(query: MetricQuery): number;
    paused(lane: Named, window: Duration): PauseStat;
    read(metric: MetricSpec, query: MetricQuery): Rate;
  }

  export interface Clock { readonly now: number; startOfDay(timeZone?: string): number }
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
    readonly from: string;
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
    readonly resolvedBy: 'executable' | 'human' | 'policy';
    readonly output: O;
  }
  export interface ReceivedEvent<A, P> {
    readonly unit: UnitView<A>;
    readonly event: string;
    readonly payload: P;
    readonly at: number;
    readonly reaction: { readonly from: string; readonly to: string } | null;
  }
  export interface CrossingEvent<G> {
    readonly threshold: string;
    readonly direction: Crossing;
    readonly group: G;
    readonly reading: Rate;
    readonly at: number;
  }

  export type BuiltinOperation =
    | 'readWork' | 'createWork' | 'updateWork' | 'sendEvents' | 'resolveBlocks'
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
    readonly ledger: Pick<Ledger, 'unit' | 'units' | 'attempts' | 'queue' | 'entries' | 'balances'>;
    readonly metrics: Metrics;
  }
  export interface Projection extends Named {
    readonly projection: true;
    open(read: LedgerReader, resolve: Resolver): Promise<void>;
    project(entry: Entry, read: LedgerReader): Promise<void>;
  }

  export interface Running {
    readonly control: ControlApi;
    readonly writer: WriterClaim;
    stop(): Promise<void>;
  }
}
