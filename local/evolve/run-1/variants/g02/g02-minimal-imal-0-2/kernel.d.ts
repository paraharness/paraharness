declare module 'harness-dsl/kernel' {
  import { z } from 'zod';

  export type Position = 'pending' | 'active' | 'waiting' | 'terminal';
  export type Verdict = 'success' | 'failure' | 'neutral';
  export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled';

  export type Schema<T> = z.ZodType<T, unknown>;

  export interface Ref<T> {
    readonly ref: 'env' | 'port';
    readonly key: string | number;
    readonly resolved?: T;
  }
  export type Arg = string | Ref<string>;

  export interface Named {
    readonly name: string;
  }

  export interface State<N extends string, P extends Position> {
    readonly entity: 'state';
    readonly name: N;
    readonly position: P;
    readonly verdict?: Verdict;
  }
  export type AnyState = State<string, Position>;

  export interface Kind<T, St extends AnyState> extends Named {
    readonly entity: 'kind';
    readonly schema: Schema<T>;
    readonly states: readonly St[];
    readonly initial: St['name'];
    readonly failure?: St['name'];
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

  export interface MemoryKind<M> extends Named {
    readonly entity: 'memory';
    readonly trust: Trust;
    readonly schema?: Schema<M>;
  }

  export interface When {
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

  export type MemoryDraft<M> = {
    readonly text: string;
    readonly because?: string;
    readonly when?: When;
    readonly status?: 'candidate' | 'accepted';
  } & ([M] extends [void] ? {} : { readonly data: M });

  export interface RawMemory {
    readonly text: string;
    readonly because?: string;
    readonly when?: Partial<Scope>;
    readonly status?: 'candidate' | 'accepted';
    readonly data?: unknown;
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
    readonly data?: unknown;
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
    readonly hours?: number;
    readonly days?: number;
    readonly since?: Date;
  }
  export type Measure = 'costUsd' | 'durationMs';
  export type GroupBy =
    | 'model' | 'agent' | 'kind' | 'lane' | 'state' | 'executable'
    | { readonly tag: string }
    | { readonly field: string };
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
    readonly agent?: string;
    readonly model?: string;
    readonly mode?: 'live' | 'batch' | 'command';
    readonly ok?: boolean;
    readonly halt?: string;
    readonly trigger?: string;
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
    tally(query: { readonly among: EntryFilter; readonly by: GroupBy } & Window): Readonly<Record<string, number>>;
    mean(query: { readonly of: Measure; readonly among: EntryFilter } & Window): Mean;
    sum(query: { readonly of: Measure; readonly among: EntryFilter } & Window): Mean;
    paused(query: { readonly lane: string } & Window): Mean;
  }

  export interface MetricRead {
    readonly query: string;
    readonly value: number | null;
    readonly samples: number;
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
    readonly holder: string;
  }
  export interface TransitionEntry extends EntryBase {
    readonly entry: 'transition';
    readonly from?: string;
    readonly to: string;
    readonly position: Position;
    readonly verdict?: Verdict;
    readonly cause: 'flow' | 'supply' | 'trigger' | 'operation' | 'kernel';
  }
  export interface AttemptEntry extends EntryBase {
    readonly entry: 'attempt';
    readonly status: 'started' | 'blocked' | 'suspended' | 'resumed' | 'interrupted' | 'ended';
    readonly outcome?: AttemptOutcome;
    readonly reason?: string;
    readonly flowVersion: string;
    readonly costUsd: number;
    readonly durationMs: number;
  }
  export interface InvocationEntry extends EntryBase {
    readonly entry: 'invocation';
    readonly status: 'started' | 'ended';
    readonly seq: number;
    readonly executable: string;
    readonly agent?: string;
    readonly model?: string;
    readonly account?: string;
    readonly mode: 'live' | 'batch' | 'command';
    readonly session?: string;
    readonly batchId?: string;
    readonly ok?: boolean;
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
    readonly origin: 'flow' | 'agent' | 'kernel';
    readonly status: 'raised' | 'resolved';
    readonly show?: string;
    readonly decision?: Readonly<Record<string, unknown>>;
    readonly by?: string;
  }
  export interface FiringEntry extends EntryBase {
    readonly entry: 'firing';
    readonly trigger: string;
    readonly group?: string;
    readonly reading?: MetricRead;
    readonly effects: readonly string[];
  }
  export interface LaneEntry extends EntryBase {
    readonly entry: 'lane';
    readonly status: 'paused' | 'resumed';
    readonly reason: string;
    readonly trigger?: string;
    readonly reading?: MetricRead;
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
    | RunEntry | TransitionEntry | AttemptEntry | InvocationEntry | HaltEntry
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
    readonly openGroup?: string;
    readonly wake?: {
      readonly armedIn: string;
      readonly at?: Date;
      readonly children?: boolean;
      readonly then?: string;
      readonly attempt?: string;
    };
  }

  export interface QuotaEvent {
    readonly account: string;
    readonly harness: string;
    readonly at: Date;
    readonly event: 'usage' | 'cooldown' | 'window';
    readonly tokens?: number;
    readonly costUsd?: number;
    readonly until?: Date;
    readonly windowEndsAt?: Date;
    readonly reportedUtilization?: number;
  }

  export interface QuotaPartition extends Named {
    append(events: readonly QuotaEvent[]): Promise<void>;
    read(query: { readonly account: string; readonly since: Date }): Promise<readonly QuotaEvent[]>;
  }

  export interface Ledger extends Named {
    readonly quota: QuotaPartition;
    claimWriter(holder: string, ttlMs: number): Promise<{ readonly acquired: boolean; readonly holder: string; readonly tookOver: boolean }>;
    renewWriter(holder: string, ttlMs: number): Promise<boolean>;
    releaseWriter(holder: string): Promise<void>;
    append(entries: readonly LedgerEntry[]): Promise<void>;
    read(query: { readonly filter: EntryFilter; readonly since?: Date; readonly until?: Date }): Promise<readonly LedgerEntry[]>;
    unit(key: string): Promise<UnitRecord | undefined>;
    units(query: { readonly kind?: string; readonly lane?: string; readonly position?: Position | readonly Position[]; readonly openGroup?: string }): Promise<readonly UnitRecord[]>;
    putUnit(unit: UnitRecord): Promise<void>;
    replay(attempt: string): Promise<readonly (InvocationEntry | HaltEntry | AttemptEntry)[]>;
    lease(resource: string, holder: string, ttlMs: number): Promise<boolean>;
    unlease(resource: string, holder: string): Promise<void>;
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

  export type Cadence =
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
    readonly reportedUtilization?: number;
    readonly windowEndsAt?: Date;
  }

  export interface ModelRequest {
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
    onSession(session: string): Promise<void>;
  }

  export type ModelResponse =
    | { readonly status: 'done'; readonly output: unknown; readonly usage: Usage; readonly memories: readonly RawMemory[] }
    | { readonly status: 'asked'; readonly question: string; readonly usage: Usage }
    | { readonly status: 'failed'; readonly error: string; readonly usage: Usage };

  export interface Model extends Named {
    readonly provider: string;
    readonly price: Price;
    call(request: ModelRequest, account: Account): Promise<ModelResponse>;
    reconcile?(session: string, account: Account): Promise<ModelResponse | 'running' | 'unknown'>;
    submit?(requests: readonly ModelRequest[], account: Account): Promise<string>;
    collect?(batchId: string, account: Account): Promise<readonly ModelResponse[] | 'running'>;
  }

  export type Result<O> =
    | { readonly ok: true; readonly value: O; readonly costUsd: number; readonly model?: string }
    | { readonly ok: false; readonly error: string; readonly costUsd: number; readonly model?: string };

  export interface InvocationContext {
    readonly attempt: string;
    readonly unit: string;
    readonly seq: number;
    readonly cancellation: Cancellation;
    readonly runner?: Runner;
    workspace(runner: Runner): Promise<Workspace>;
    lease(resource: string): Promise<boolean>;
  }

  export type RestartRule =
    | 'rerun'
    | 'park'
    | 'reconcile'
    | { readonly check: Executable<unknown, unknown> };

  export interface Executable<I, O> extends Named {
    readonly entity: 'agent' | 'command';
    readonly afterCrash: RestartRule;
    invoke(input: I, ctx: InvocationContext): Promise<Result<O>>;
  }

  export interface PendingView<T = unknown, S extends string = string> extends UnitView<T, S> {
    readonly waitedMs: number;
    is<T2, St2 extends AnyState>(kind: Kind<T2, St2>): this is PendingView<T2, St2['name']>;
  }

  export interface ActiveView<T = unknown, S extends string = string> extends UnitView<T, S> {
    readonly attempt: string;
    readonly startedAt: Date;
    readonly blocked: boolean;
    is<T2, St2 extends AnyState>(kind: Kind<T2, St2>): this is ActiveView<T2, St2['name']>;
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
    readonly unit?: string;
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
    readonly origin: 'flow' | 'agent' | 'kernel';
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
