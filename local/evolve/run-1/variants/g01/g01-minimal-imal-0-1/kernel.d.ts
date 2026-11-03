declare module 'harness-dsl/kernel' {
  import { z } from 'zod';

  export type Schema<T> = z.ZodType<T, unknown>;

  export interface Named {
    readonly name: string;
  }

  export interface Ref<T> {
    readonly ref: 'env';
    readonly key: string;
    readonly resolved?: T;
  }
  export type Arg = string | Ref<string>;

  export type Position = 'pending' | 'active' | 'waiting' | 'terminal';
  export type Verdict = 'success' | 'failure' | 'neutral';
  export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled';

  export interface State<N extends string, P extends Position> extends Named {
    readonly entity: 'state';
    readonly name: N;
    readonly position: P;
    readonly verdict?: Verdict;
  }
  export type AnyState = State<string, Position>;

  export type NamesAt<St, P extends Position> =
    St extends State<infer N extends string, infer Q extends Position> ? (Q extends P ? N : never) : never;

  export interface Shape {
    readonly pending: string;
    readonly active: string;
    readonly waiting: string;
    readonly terminal: string;
  }
  export type ShapeOf<St> = {
    readonly pending: NamesAt<St, 'pending'>;
    readonly active: NamesAt<St, 'active'>;
    readonly waiting: NamesAt<St, 'waiting'>;
    readonly terminal: NamesAt<St, 'terminal'>;
  };
  export type Settable<Sh extends Shape> = Sh['pending'] | Sh['waiting'] | Sh['terminal'];
  export type StateName<Sh extends Shape> = Sh[keyof Shape];
  export type ShapeLists<Sh extends Shape> = { readonly [P in keyof Shape]: readonly Sh[P][] };

  export interface Kind<T, Sh extends Shape> extends Named {
    readonly entity: 'kind';
    readonly schema: Schema<T>;
    readonly states: readonly AnyState[];
    readonly shape: ShapeLists<Sh>;
    readonly initial: Sh['pending'];
    readonly afterFailure: Settable<Sh>;
  }

  export interface Resource extends Named {
    readonly entity: 'resource';
    readonly group: string;
    readonly id: string;
  }

  export type Intent = 'read' | 'edit' | 'execute' | 'browse' | 'halt';

  export interface Role<I, O> extends Named {
    readonly entity: 'role';
    readonly input: Schema<I>;
    readonly output: Schema<O>;
    readonly prompt: (input: I) => string;
    readonly intentList: readonly Intent[];
  }

  export type MemorySort = 'experience' | 'taste';

  export interface MemoryKind extends Named {
    readonly entity: 'memory';
    readonly sort: MemorySort;
  }

  export interface ScopeRefs {
    readonly kinds?: readonly Named[];
    readonly roles?: readonly Named[];
    readonly skills?: readonly string[];
    readonly resources?: readonly Resource[];
  }

  export interface Scope {
    readonly kinds: readonly string[];
    readonly roles: readonly string[];
    readonly skills: readonly string[];
    readonly resources: readonly string[];
  }

  export interface MemoryDraft {
    readonly text: string;
    readonly because?: string;
    readonly when?: ScopeRefs;
    readonly status?: 'candidate' | 'accepted';
  }

  export interface RawMemory {
    readonly text: string;
    readonly because?: string;
    readonly when?: Partial<Scope>;
    readonly status?: 'candidate' | 'accepted';
  }

  export interface MemoryItem {
    readonly id: string;
    readonly created: Date;
    readonly memory: string;
    readonly library: string;
    readonly when: Scope;
    readonly text: string;
    readonly because?: string;
    readonly status: 'candidate' | 'accepted';
  }

  export interface Recalled extends MemoryItem {
    readonly specificity: number;
    readonly similarity?: number;
    readonly trackRecord: Rate;
  }

  export interface MemoryStore extends Named {
    put(item: MemoryItem): Promise<void>;
    get(id: string): Promise<MemoryItem | undefined>;
    remove(id: string): Promise<void>;
    list(library: string): Promise<readonly MemoryItem[]>;
    search(query: {
      readonly library: string;
      readonly scope: Scope;
      readonly text: string;
      readonly limit: number;
    }): Promise<readonly (MemoryItem & { readonly similarity?: number })[]>;
  }

  export interface Rate {
    readonly value: number | null;
    readonly hits: number;
    readonly samples: number;
  }
  export interface Mean {
    readonly value: number | null;
    readonly samples: number;
  }
  export interface Window {
    readonly days?: number;
    readonly hours?: number;
    readonly since?: Date;
  }
  export type Measure = 'costUsd' | 'durationMs';
  export type GroupBy = 'model' | 'kind' | 'lane' | 'state' | 'executable' | 'group' | { readonly tag: string };
  export type EntryType = LedgerEntry['entry'];

  export interface EntryFilter {
    readonly entry?: EntryType | readonly EntryType[];
    readonly status?: string | readonly string[];
    readonly kind?: string;
    readonly lane?: string;
    readonly state?: string | readonly string[];
    readonly position?: Position | readonly Position[];
    readonly verdict?: Verdict | readonly Verdict[];
    readonly outcome?: AttemptOutcome | readonly AttemptOutcome[];
    readonly executable?: string;
    readonly model?: string;
    readonly ok?: boolean;
    readonly halt?: string;
    readonly trigger?: string;
    readonly group?: string;
    readonly edge?: 'entered' | 'exited';
    readonly tags?: Readonly<Record<string, string>>;
    readonly decision?: Readonly<Record<string, string | number | boolean>>;
  }

  export interface Metrics {
    successRate(query: {
      readonly kind: string;
      readonly model?: string;
      readonly agent?: string;
      readonly tags?: Readonly<Record<string, string>>;
    } & Window): Rate;
    rate(query: { readonly among: EntryFilter; readonly count: EntryFilter } & Window): Rate;
    rateBy(query: { readonly among: EntryFilter; readonly count: EntryFilter; readonly by: GroupBy } & Window): Readonly<Record<string, Rate>>;
    mean(query: { readonly of: Measure; readonly among: EntryFilter } & Window): Mean;
    sum(query: { readonly of: Measure; readonly among: EntryFilter } & Window): Mean;
    count(query: { readonly among: EntryFilter } & Window): number;
    countBy(query: { readonly among: EntryFilter; readonly by: GroupBy } & Window): Readonly<Record<string, number>>;
    duration(query: { readonly lane: string; readonly condition: 'paused' } & Window): { readonly totalMs: number; readonly spans: number };
  }

  export interface MetricRead {
    readonly query: string;
    readonly value: number | null;
    readonly samples: number;
  }

  export interface Condition {
    readonly type: 'Blocked' | 'Interrupted' | 'DefinitionChanged' | 'CostCeiling' | 'Superseded' | 'Paused';
    readonly status: boolean;
    readonly reason?: string;
    readonly since: Date;
  }

  interface EntryBase {
    readonly id: string;
    readonly at: Date;
    readonly harness: string;
    readonly run: string;
    readonly unit?: string;
    readonly kind?: string;
    readonly lane?: string;
    readonly attempt?: string;
    readonly tags: Readonly<Record<string, string>>;
  }
  export interface RunEntry extends EntryBase {
    readonly entry: 'run';
    readonly status: 'started' | 'stopped' | 'took-over';
    readonly previous?: string;
  }
  export interface TransitionEntry extends EntryBase {
    readonly entry: 'transition';
    readonly from?: string;
    readonly to: string;
    readonly position: Position;
    readonly verdict?: Verdict;
    readonly generation: number;
    readonly cause: 'flow' | 'supply' | 'trigger' | 'operation' | 'kernel';
  }
  export interface AttemptEntry extends EntryBase {
    readonly entry: 'attempt';
    readonly status: 'started' | 'blocked' | 'resumed' | 'interrupted' | 'parked' | 'ended';
    readonly outcome?: AttemptOutcome;
    readonly reason?: string;
    readonly flowFingerprint: string;
    readonly costUsd: number;
    readonly durationMs: number;
  }
  export interface StepEntry extends EntryBase {
    readonly entry: 'step';
    readonly seq: number;
    readonly step: string;
    readonly does: 'run' | 'batch' | 'halt' | 'spawn' | 'remember' | 'decide' | 'move' | 'update';
    readonly status: 'begun' | 'done';
    readonly result?: unknown;
    readonly batchId?: string;
  }
  export interface InvocationEntry extends EntryBase {
    readonly entry: 'invocation';
    readonly seq: number;
    readonly invocation: string;
    readonly executable: string;
    readonly agent?: string;
    readonly model?: string;
    readonly account?: string;
    readonly runner?: string;
    readonly mode: 'live' | 'batch' | 'command';
    readonly status: 'ok' | 'failed' | 'timed-out' | 'interrupted' | 'recovered';
    readonly ok: boolean;
    readonly costUsd: number;
    readonly durationMs: number;
    readonly output: unknown;
    readonly error?: string;
    readonly memoryIds: readonly string[];
  }
  export interface HaltEntry extends EntryBase {
    readonly entry: 'halt';
    readonly seq: number;
    readonly halt: string;
    readonly status: 'raised' | 'resolved';
    readonly raisedBy: 'flow' | 'executable' | 'kernel';
    readonly show?: string;
    readonly decision?: Readonly<Record<string, unknown>>;
    readonly by?: string;
  }
  export interface FiringEntry extends EntryBase {
    readonly entry: 'firing';
    readonly trigger: string;
    readonly source: 'enters' | 'streak' | 'deadline' | 'time' | 'metric';
    readonly group?: string;
    readonly edge?: 'entered' | 'exited';
    readonly value?: number | null;
    readonly samples?: number;
    readonly effects: readonly string[];
  }
  export interface DecisionEntry extends EntryBase {
    readonly entry: 'decision';
    readonly policy: string;
    readonly reads: readonly MetricRead[];
    readonly result: string;
  }
  export interface OperationEntry extends EntryBase {
    readonly entry: 'operation';
    readonly operation: string;
    readonly client: string;
    readonly input: unknown;
  }
  export interface LaneEntry extends EntryBase {
    readonly entry: 'lane';
    readonly condition: 'paused';
    readonly status: boolean;
    readonly firing?: string;
    readonly reason?: string;
  }
  export type LedgerEntry =
    | RunEntry | TransitionEntry | AttemptEntry | StepEntry | InvocationEntry
    | HaltEntry | FiringEntry | DecisionEntry | OperationEntry | LaneEntry;

  export interface UnitView<T, Sh extends Shape> {
    readonly key: string;
    readonly kind: string;
    readonly lane: string;
    readonly state: StateName<Sh>;
    readonly position: Position;
    readonly data: T;
    readonly generation: number;
    readonly owner?: string;
    readonly touches: readonly Resource[];
    readonly created: Date;
    readonly spentUsd: number;
  }

  export interface Timer {
    readonly trigger: string;
    readonly dueAt: Date;
    readonly generation: number;
  }

  export interface UnitRecord extends UnitView<unknown, Shape> {
    readonly wake?: { readonly at?: Date; readonly children?: boolean; readonly then: string };
    readonly timers: readonly Timer[];
  }

  export interface AttemptRecord {
    readonly id: string;
    readonly unit: string;
    readonly lane: string;
    readonly flow: string;
    readonly flowFingerprint: string;
    readonly startedFrom: string;
    readonly generation: number;
    readonly status: 'running' | 'blocked' | 'parked' | 'ended';
    readonly outcome?: AttemptOutcome;
    readonly conditions: readonly Condition[];
  }

  export interface AccountState {
    readonly utilization: number;
    readonly windowEndsAt?: Date;
    readonly coolingUntil?: Date;
    readonly byHarness: Readonly<Record<string, number>>;
  }

  export interface QuotaBook extends Named {
    accountState(account: string): Promise<AccountState>;
    recordUsage(usage: {
      readonly account: string;
      readonly harness: string;
      readonly at: Date;
      readonly tokens: number;
      readonly costUsd: number;
      readonly windowEndsAt?: Date;
    }): Promise<void>;
    recordCooldown(account: string, until: Date): Promise<void>;
  }

  export interface InboxMessage {
    readonly id: string;
    readonly at: Date;
    readonly client: string;
    readonly does: 'resolve-halt' | 'operation';
    readonly attempt?: string;
    readonly halt?: string;
    readonly operation?: string;
    readonly input: unknown;
  }

  export type WriterClaim =
    | { readonly granted: true; readonly tookOverFrom?: string }
    | { readonly granted: false; readonly heldBy: string; readonly until: Date };

  export interface Ledger extends Named {
    readonly quota: QuotaBook;
    claimWriter(claim: { readonly harness: string; readonly run: string; readonly ttlMs: number }): Promise<WriterClaim>;
    renewWriter(run: string, ttlMs: number): Promise<boolean>;
    append(entries: readonly LedgerEntry[]): Promise<void>;
    read(query: { readonly filter: EntryFilter; readonly since?: Date; readonly until?: Date }): Promise<readonly LedgerEntry[]>;
    unit(key: string): Promise<UnitRecord | undefined>;
    units(query: { readonly kind?: string; readonly lane?: string; readonly owner?: string; readonly position?: Position | readonly Position[] }): Promise<readonly UnitRecord[]>;
    putUnit(unit: UnitRecord): Promise<void>;
    attempt(id: string): Promise<AttemptRecord | undefined>;
    attempts(query: { readonly status?: AttemptRecord['status'] | readonly AttemptRecord['status'][]; readonly unit?: string }): Promise<readonly AttemptRecord[]>;
    putAttempt(attempt: AttemptRecord): Promise<void>;
    steps(attempt: string): Promise<readonly (StepEntry | InvocationEntry | HaltEntry)[]>;
    post(message: InboxMessage): Promise<void>;
    take(): Promise<readonly InboxMessage[]>;
    lease(resource: string, holder: string, ttlMs: number): Promise<boolean>;
    release(resource: string, holder: string): Promise<void>;
    transaction<R>(work: () => Promise<R>): Promise<R>;
  }

  export interface Store<T> extends Named {
    get(key: string): Promise<{ readonly data: T; readonly state?: string } | undefined>;
    put(key: string, data: T, state: string): Promise<void>;
  }

  export type Supply<T, Sh extends Shape> =
    | { readonly create: T; readonly key?: string; readonly state?: Settable<Sh> }
    | { readonly update: string; readonly patch?: Partial<T>; readonly state?: Settable<Sh> };

  export interface Stoppable {
    stop(): Promise<void>;
  }

  export interface Supplier<T, Sh extends Shape> extends Named {
    readonly kind: string;
    readonly operator?: true;
    start(sink: (supply: Supply<T, Sh>) => Promise<void>): Promise<Stoppable>;
  }

  export interface Interval {
    readonly minutes?: number;
    readonly hours?: number;
  }

  export type TimeSpec =
    | { readonly every: Interval }
    | { readonly daily: string }
    | { readonly weekly: { readonly day: 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun'; readonly at: string } };

  export interface Cancellation {
    readonly cancelled: boolean;
    onCancel(listener: () => void): void;
  }

  export interface Workspace {
    readonly root?: string;
    exec(argv: readonly string[], cancellation: Cancellation): Promise<{ readonly exitCode: number; readonly stdout: string; readonly stderr: string }>;
    release(): Promise<void>;
  }

  export interface Runner extends Named {
    readonly slots: number;
    readonly hosts: readonly Resource[];
    acquire(attempt: string): Promise<Workspace>;
  }

  export interface Price {
    readonly inputUsdPerMTok: number;
    readonly outputUsdPerMTok: number;
    readonly batchDiscount: number;
  }

  export interface Account extends Named {
    readonly provider: string;
    readonly plan: 'subscription' | 'metered';
    readonly credential: Ref<string>;
    readonly quota?: QuotaBook;
  }

  export interface GuardContext {
    readonly attempt: string;
    readonly unit: string;
    readonly workspace?: Workspace;
    lease(resource: string): Promise<boolean>;
    run(executable: Executable<void, unknown>): Promise<Result<unknown>>;
  }

  export interface Guard extends Named {
    beforeWrite?(path: string, ctx: GuardContext): Promise<boolean>;
    beforeStop?(ctx: GuardContext): Promise<{ readonly ok: boolean; readonly feedback?: string }>;
  }

  export interface Usage {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
    readonly mode: 'live' | 'batch';
  }

  export interface ModelRequest {
    readonly session: string;
    readonly prompt: string;
    readonly output: Schema<unknown>;
    readonly intents: readonly Intent[];
    readonly memory: readonly MemoryItem[];
    readonly guards: readonly Guard[];
    readonly guardContext: GuardContext;
    readonly workspace?: Workspace;
    readonly answer?: string;
    readonly records: boolean;
    readonly maxUsd?: number;
    readonly cancellation: Cancellation;
  }

  export type ModelResponse =
    | { readonly status: 'done'; readonly output: unknown; readonly usage: Usage; readonly memories: readonly RawMemory[] }
    | { readonly status: 'asked'; readonly question: string; readonly usage: Usage }
    | { readonly status: 'failed'; readonly error: string; readonly usage: Usage };

  export interface Model extends Named {
    readonly provider: string;
    readonly price: Price;
    call(request: ModelRequest, account: Account): Promise<ModelResponse>;
    submit?(requests: readonly ModelRequest[], account: Account): Promise<string>;
    collect?(batchId: string, account: Account): Promise<readonly ModelResponse[] | 'pending'>;
    recover?(session: string, account: Account): Promise<ModelResponse | 'running' | 'unknown'>;
  }

  export type Result<O> =
    | { readonly ok: true; readonly value: O; readonly costUsd: number; readonly model?: string }
    | { readonly ok: false; readonly error: string; readonly timedOut: boolean; readonly costUsd: number; readonly model?: string };

  export type Interrupt = 'rerun' | 'park' | 'ask';

  export interface InvocationRecord {
    readonly invocation: string;
    readonly attempt: string;
    readonly seq: number;
    readonly startedAt: Date;
    readonly session?: string;
    readonly account?: string;
  }

  export type Recovery<O> = Result<O> | 'not-finished' | 'unknown';

  export interface InvocationContext {
    readonly attempt: string;
    readonly unit: string;
    readonly seq: number;
    readonly invocation: string;
    readonly touches: readonly Resource[];
    readonly deadline?: Date;
    readonly cancellation: Cancellation;
    workspace(runners: readonly Runner[]): Promise<Workspace>;
    lease(resource: string): Promise<boolean>;
    halt(question: string): Promise<string>;
  }

  export interface Executable<I, O> extends Named {
    readonly entity: 'agent' | 'command';
    readonly interrupted: Interrupt;
    invoke(input: I, ctx: InvocationContext): Promise<Result<O>>;
    recover?(input: I, record: InvocationRecord, ctx: InvocationContext): Promise<Recovery<O>>;
  }

  export interface PendingView<T = unknown, Sh extends Shape = Shape> extends UnitView<T, Sh> {
    readonly waitedMs: number;
    is<T2, Sh2 extends Shape>(kind: Kind<T2, Sh2>): this is PendingView<T2, Sh2>;
  }

  export interface ActiveView<T = unknown, Sh extends Shape = Shape> extends UnitView<T, Sh> {
    readonly attempt: string;
    readonly startedAt: Date;
    readonly blocked: boolean;
    is<T2, Sh2 extends Shape>(kind: Kind<T2, Sh2>): this is ActiveView<T2, Sh2>;
  }

  export interface AccountView {
    readonly account: Account;
    readonly pool: string;
    readonly eligible: boolean;
    readonly share: number;
    readonly usedShare: number;
    readonly windowEndsAt?: Date;
    readonly coolingUntil?: Date;
  }

  export type PolicyDomain = 'model' | 'account' | 'scheduler' | 'recall' | 'retry' | 'rule';

  export interface Policy<C, D> extends Named {
    readonly entity: 'policy';
    readonly decides: PolicyDomain;
    decide(context: C): D;
  }

  export interface ModelChoice {
    readonly agent: string;
    readonly role: string;
    readonly kind: string;
    readonly lane: string;
    readonly unit: string;
    readonly tags: Readonly<Record<string, string>>;
    readonly now: Date;
    readonly metrics: Metrics;
  }

  export interface AccountChoice {
    readonly model: Model;
    readonly accounts: readonly AccountView[];
    readonly now: Date;
    readonly metrics: Metrics;
  }

  export interface LaneStatus {
    readonly active: number;
    readonly wip?: number;
    readonly paused: boolean;
  }

  export interface SchedulerView {
    readonly now: Date;
    readonly pending: readonly PendingView[];
    readonly active: readonly ActiveView[];
    readonly lanes: Readonly<Record<string, LaneStatus>>;
    readonly metrics: Metrics;
  }

  export interface ScheduleDecision {
    readonly start: readonly PendingView[];
    readonly preempt?: readonly ActiveView[];
  }

  export interface RecallView {
    readonly items: readonly Recalled[];
    readonly scope: Scope & { readonly agent: string };
    readonly query: string;
    readonly now: Date;
    readonly metrics: Metrics;
  }

  export interface RetryView {
    readonly failures: number;
    readonly error: string;
    readonly timedOut: boolean;
  }
  export type RetryDecision = { readonly retryInMs: number } | 'stop';

  export interface RuleView<I> {
    readonly input: I;
    readonly metrics: Metrics;
  }

  export interface HaltView {
    readonly attempt: string;
    readonly unit: string;
    readonly halt: string;
    readonly show: string;
    readonly raised: Date;
  }

  export interface ControlApi {
    readonly work: {
      list(query: { readonly lane?: string; readonly position?: Position | readonly Position[] }): Promise<readonly UnitRecord[]>;
      get(key: string): Promise<UnitRecord | undefined>;
      create(lane: string, data: unknown, key?: string): Promise<string>;
      update(key: string, patch: unknown, state?: string): Promise<void>;
    };
    readonly halts: {
      list(): Promise<readonly HaltView[]>;
      resolve(attempt: string, decision: unknown): Promise<void>;
    };
    readonly attempts: {
      parked(): Promise<readonly AttemptRecord[]>;
      restart(attempt: string): Promise<void>;
      abandon(attempt: string): Promise<void>;
    };
    readonly memory: {
      list(library: string): Promise<readonly MemoryItem[]>;
      write(library: string, item: RawMemory): Promise<string>;
      accept(id: string): Promise<void>;
      merge(ids: readonly string[], into: RawMemory): Promise<string>;
      drop(id: string): Promise<void>;
    };
    readonly telemetry: {
      readonly metrics: Metrics;
      entries(query: { readonly filter: EntryFilter; readonly since?: Date }): Promise<readonly LedgerEntry[]>;
    };
    readonly accounts: {
      list(): Promise<readonly AccountView[]>;
      setShare(pool: string, account: string, share: number): Promise<void>;
    };
    readonly custom: {
      invoke(operation: string, input: unknown): Promise<Result<unknown>>;
    };
  }

  export interface Operation extends Named {
    readonly entity: 'operation';
    readonly methods: readonly string[];
    readonly executable?: Executable<unknown, unknown>;
  }

  export interface Client extends Named {
    readonly grants: readonly Operation[];
    serve(api: ControlApi): Promise<Stoppable>;
  }

  export interface HarnessView {
    readonly harness: string;
    units(query: { readonly kind?: string; readonly position?: Position | readonly Position[] }): Promise<readonly UnitRecord[]>;
    lanes(): Promise<Readonly<Record<string, LaneStatus>>>;
    readonly metrics: Metrics;
  }

  export interface Observer extends Named {
    notify(entry: LedgerEntry, view: HarnessView): Promise<void>;
  }

  export interface Running {
    readonly run: string;
    readonly control: ControlApi;
    stop(): Promise<void>;
  }
}
