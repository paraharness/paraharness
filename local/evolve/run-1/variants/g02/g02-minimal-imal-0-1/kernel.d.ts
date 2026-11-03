declare module 'harness-dsl/kernel' {
  import { z } from 'zod';

  export type Schema<T> = z.ZodType<T, unknown>;

  export interface Ref<T> {
    readonly ref: 'env';
    readonly key: string;
    readonly resolved?: T;
  }
  export type Arg = string | Ref<string>;

  export interface Named {
    readonly name: string;
  }

  export type Position = 'pending' | 'active' | 'waiting' | 'terminal';
  export type Verdict = 'success' | 'failure' | 'neutral';
  export type StatePosition = 'pending' | 'active' | 'waiting' | { readonly terminal: Verdict };
  export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled';

  export interface State<N extends string> extends Named {
    readonly entity: 'state';
    readonly name: N;
    readonly position: StatePosition;
  }

  export interface Kind<T, S extends string> extends Named {
    readonly entity: 'kind';
    readonly schema: Schema<T>;
    readonly states: readonly State<S>[];
    readonly initial: S;
    readonly failureState?: S;
  }

  export interface Resource extends Named {
    readonly entity: 'resource';
  }

  export type Intent = 'read' | 'edit' | 'execute' | 'browse' | 'ask';

  export interface Role<I, O> extends Named {
    readonly entity: 'role';
    readonly input: Schema<I>;
    readonly output: Schema<O>;
    readonly prompt: (input: I) => string;
    readonly intentList: readonly Intent[];
  }

  export type Trust = 'fallible' | 'owner';

  export interface MemoryKind extends Named {
    readonly entity: 'memory';
    readonly trust: Trust;
  }

  export interface Scope {
    readonly kinds: readonly string[];
    readonly roles: readonly string[];
    readonly skills: readonly string[];
    readonly resources: readonly string[];
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
  export type Measure = 'costUsd' | 'durationMs' | 'entries';
  export type GroupBy = 'state' | { readonly tag: string };
  export type EntryType = LedgerEntry['entry'];
  export type TransitionCause = 'flow' | 'supply' | 'trigger' | 'operation' | 'failure' | 'kernel';

  export interface EntryFilter {
    readonly entry?: EntryType | readonly EntryType[];
    readonly status?: string | readonly string[];
    readonly kind?: string;
    readonly lane?: string;
    readonly state?: string | readonly string[];
    readonly position?: Position | readonly Position[];
    readonly verdict?: Verdict | readonly Verdict[];
    readonly outcome?: AttemptOutcome | readonly AttemptOutcome[];
    readonly cause?: TransitionCause | readonly TransitionCause[];
    readonly executable?: string;
    readonly mode?: InvocationMode | readonly InvocationMode[];
    readonly ok?: boolean;
    readonly halt?: string;
    readonly tags?: Readonly<Record<string, string>>;
    readonly decision?: Readonly<Record<string, string | number | boolean>>;
  }

  export interface Metrics {
    successRate(query: { readonly kind: string; readonly model?: string } & Window): Rate;
    rate(query: { readonly among: EntryFilter; readonly count: EntryFilter } & Window): Rate;
    rateBy(query: { readonly among: EntryFilter; readonly count: EntryFilter; readonly by: GroupBy } & Window): Readonly<Record<string, Rate>>;
    mean(query: { readonly of: Measure; readonly among: EntryFilter } & Window): Mean;
    sum(query: { readonly of: Measure; readonly among: EntryFilter } & Window): Mean;
  }

  export interface MetricRead {
    readonly query: string;
    readonly value: number | null;
    readonly samples: number;
  }

  export type InvocationMode = 'live' | 'batch' | 'command';

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
    readonly holder: string;
  }
  export interface TransitionEntry extends EntryBase {
    readonly entry: 'transition';
    readonly from?: string;
    readonly to: string;
    readonly position: Position;
    readonly verdict?: Verdict;
    readonly cause: TransitionCause;
  }
  export interface AttemptEntry extends EntryBase {
    readonly entry: 'attempt';
    readonly status: 'started' | 'blocked' | 'resumed' | 'interrupted' | 'ended';
    readonly outcome?: AttemptOutcome;
    readonly definition: string;
    readonly costUsd: number;
    readonly durationMs: number;
  }
  export interface InvocationEntry extends EntryBase {
    readonly entry: 'invocation';
    readonly seq: number;
    readonly executable: string;
    readonly agent?: string;
    readonly model?: string;
    readonly account?: string;
    readonly mode: InvocationMode;
    readonly status: 'started' | 'submitted' | 'ended';
    readonly ok?: boolean;
    readonly interrupted?: boolean;
    readonly batch?: string;
    readonly costUsd: number;
    readonly durationMs: number;
    readonly output?: unknown;
    readonly error?: string;
    readonly memoryIds: readonly string[];
  }
  export interface HaltEntry extends EntryBase {
    readonly entry: 'halt';
    readonly seq: number;
    readonly halt: string;
    readonly status: 'raised' | 'resolved';
    readonly show?: string;
    readonly decision?: Readonly<Record<string, unknown>>;
    readonly by?: string;
  }
  export interface SpawnEntry extends EntryBase {
    readonly entry: 'spawn';
    readonly seq: number;
    readonly children: readonly string[];
  }
  export interface FiringEntry extends EntryBase {
    readonly entry: 'firing';
    readonly trigger: string;
    readonly group?: string;
    readonly phase?: 'crossed' | 'recovered';
    readonly value?: Rate;
    readonly effects: readonly string[];
  }
  export interface LaneEntry extends EntryBase {
    readonly entry: 'lane';
    readonly status: 'paused' | 'resumed';
    readonly reason: string;
    readonly firing?: string;
    readonly value?: Rate;
    readonly durationMs: number;
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
  export type LedgerEntry =
    | RunEntry | TransitionEntry | AttemptEntry | InvocationEntry | HaltEntry | SpawnEntry
    | FiringEntry | LaneEntry | DecisionEntry | OperationEntry;

  export interface UnitView<T, S extends string> {
    readonly key: string;
    readonly kind: string;
    readonly lane: string;
    readonly state: S;
    readonly position: Position;
    readonly verdict?: Verdict;
    readonly data: T;
    readonly parent?: string;
    readonly created: Date;
    readonly spentUsd: number;
  }

  export interface UnitRecord extends UnitView<unknown, string> {
    readonly tags: Readonly<Record<string, string>>;
    readonly wakeAt?: Date;
    readonly wakeOnChildren?: boolean;
    readonly wakeTo?: string;
    readonly failures: number;
    readonly retryAt?: Date;
    readonly retriesExhausted: boolean;
  }

  export interface QuotaEvent {
    readonly account: string;
    readonly harness: string;
    readonly at: Date;
    readonly tokens: number;
    readonly costUsd: number;
    readonly windowEndsAt?: Date;
    readonly coolingUntil?: Date;
  }

  export interface AccountState {
    readonly utilization: number;
    readonly windowEndsAt?: Date;
    readonly coolingUntil?: Date;
    readonly byHarness: Readonly<Record<string, number>>;
  }

  export interface QuotaPartition {
    append(event: QuotaEvent): Promise<void>;
    fold(account: string, now: Date): Promise<AccountState>;
  }

  export interface Ledger extends Named {
    readonly quota: QuotaPartition;
    claim(holder: string, ttlMs: number): Promise<'claimed' | 'took-over' | 'held'>;
    renew(holder: string, ttlMs: number): Promise<boolean>;
    append(entries: readonly LedgerEntry[]): Promise<void>;
    read(query: { readonly filter: EntryFilter; readonly since?: Date; readonly until?: Date }): Promise<readonly LedgerEntry[]>;
    unit(key: string): Promise<UnitRecord | undefined>;
    units(query: { readonly kind?: string; readonly lane?: string; readonly position?: Position | readonly Position[] }): Promise<readonly UnitRecord[]>;
    putUnit(unit: UnitRecord): Promise<void>;
    replay(attempt: string): Promise<readonly (InvocationEntry | HaltEntry | SpawnEntry | TransitionEntry)[]>;
    lease(resource: string, holder: string, ttlMs: number): Promise<boolean>;
    release(resource: string, holder: string): Promise<void>;
    transaction<R>(work: () => Promise<R>): Promise<R>;
  }

  export interface Store<T> extends Named {
    get(key: string): Promise<{ readonly data: T; readonly state?: string } | undefined>;
    put(key: string, data: T, state: string): Promise<void>;
  }

  export type Supply<T, S extends string> =
    | { readonly create: T; readonly key?: string; readonly state?: S }
    | { readonly update: string; readonly patch?: Partial<T>; readonly state?: S };

  export interface Stoppable {
    stop(): Promise<void>;
  }

  export interface Supplier<T, S extends string> extends Named {
    readonly kind: string;
    readonly operator?: true;
    start(sink: (supply: Supply<T, S>) => Promise<void>): Promise<Stoppable>;
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
    readonly invocation: string;
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
    submitBatch?(requests: readonly ModelRequest[], account: Account): Promise<string>;
    collectBatch?(batch: string, account: Account): Promise<readonly ModelResponse[] | 'running'>;
    recover?(invocation: string, account: Account): Promise<ModelResponse | 'unknown'>;
  }

  export type Result<O> =
    | { readonly ok: true; readonly value: O; readonly costUsd: number; readonly model?: string }
    | { readonly ok: false; readonly error: string; readonly costUsd: number; readonly model?: string };

  export interface InvocationContext {
    readonly attempt: string;
    readonly unit: string;
    readonly seq: number;
    readonly invocation: string;
    readonly cancellation: Cancellation;
    workspace(runner: Runner): Promise<Workspace>;
    lease(resource: string): Promise<boolean>;
  }

  export type RestartRule<I> = 'rerun' | 'park' | 'ask' | Executable<I, boolean>;

  export interface Executable<I, O> extends Named {
    readonly entity: 'agent' | 'command';
    readonly restartRule: RestartRule<I>;
    invoke(input: I, ctx: InvocationContext): Promise<Result<O>>;
  }

  export interface PendingView<T = unknown, S extends string = string> extends UnitView<T, S> {
    readonly waitedMs: number;
    is<T2, S2 extends string>(kind: Kind<T2, S2>): this is PendingView<T2, S2>;
  }

  export interface ActiveView<T = unknown, S extends string = string> extends UnitView<T, S> {
    readonly attempt: string;
    readonly startedAt: Date;
    readonly blocked: boolean;
    is<T2, S2 extends string>(kind: Kind<T2, S2>): this is ActiveView<T2, S2>;
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
    readonly now: Date;
    readonly metrics: Metrics;
  }

  export interface AccountChoice {
    readonly model: Model;
    readonly accounts: readonly AccountView[];
    readonly now: Date;
    readonly metrics: Metrics;
  }

  export interface SchedulerView {
    readonly now: Date;
    readonly pending: readonly PendingView[];
    readonly active: readonly ActiveView[];
    readonly lanes: Readonly<Record<string, { readonly active: number; readonly wip?: number; readonly paused: boolean }>>;
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
    readonly kernel: boolean;
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
