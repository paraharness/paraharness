declare module 'harness-dsl/kernel' {
  import { z } from 'zod';

  export type Position = 'pending' | 'active' | 'waiting' | 'terminal';
  export type Verdict = 'success' | 'failure' | 'neutral';
  export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled';
  export type Resolver = 'human' | 'policy' | 'clock';
  export type LockMode = 'exclusive' | 'shared';

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

  export interface State<N extends string> extends Named {
    readonly entity: 'state';
    readonly name: N;
    readonly position: Position;
    readonly verdict?: Verdict;
  }

  export interface KindRef extends Named {
    readonly entity: 'kind';
  }
  export interface Kind<T, S extends string> extends KindRef {
    readonly schema: Schema<T>;
    readonly states: readonly State<S>[];
    readonly initial: S;
  }

  export interface Resource extends Named {
    readonly entity: 'resource';
  }

  export interface Lock {
    readonly resource: Resource;
    readonly mode: LockMode;
  }

  export interface FacetRef extends Named {
    readonly entity: 'facet';
  }
  export interface FacetValue {
    readonly facet: string;
    readonly value: string;
  }

  export type Intent = 'read' | 'edit' | 'execute' | 'browse';

  export interface RoleRef extends Named {
    readonly entity: 'role';
  }
  export interface Role<I, O> extends RoleRef {
    readonly input: Schema<I>;
    readonly output: Schema<O>;
    readonly prompt: (input: I) => string;
    readonly intentList: readonly Intent[];
  }

  export interface SeatRef extends Named {
    readonly entity: 'seat';
  }

  export interface JournalRef extends Named {
    readonly entity: 'journal';
  }

  export type MemorySort = 'experience' | 'taste';

  export interface MemoryKind extends Named {
    readonly entity: 'memory';
    readonly sort: MemorySort;
  }

  export interface Scope {
    readonly kinds?: readonly KindRef[];
    readonly roles?: readonly RoleRef[];
    readonly resources?: readonly Resource[];
    readonly facets?: readonly FacetValue[];
  }

  export interface ScopeRecord {
    readonly kinds: readonly string[];
    readonly roles: readonly string[];
    readonly resources: readonly string[];
    readonly facets: readonly FacetValue[];
  }

  export interface MemoryDraft {
    readonly text: string;
    readonly because?: string;
    readonly when?: Scope;
    readonly status?: 'candidate' | 'accepted';
  }

  export interface MemoryItem {
    readonly id: string;
    readonly created: Date;
    readonly memory: string;
    readonly journal: string;
    readonly text: string;
    readonly because?: string;
    readonly when: ScopeRecord;
    readonly status: 'candidate' | 'accepted';
  }

  export interface MemoryStore extends Named {
    put(item: MemoryItem): Promise<void>;
    get(id: string): Promise<MemoryItem | undefined>;
    remove(id: string): Promise<void>;
    list(journal: string): Promise<readonly MemoryItem[]>;
    search(query: {
      readonly journal: string;
      readonly scope: ScopeRecord;
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
  export type Measure = 'costUsd' | 'durationMs' | 'decisionMs' | 'lockWaitMs';
  export type EntryType = LedgerEntry['entry'];
  export type InvocationMode = 'model' | 'batch' | 'command' | 'job';

  export type Dimension =
    | 'kind' | 'lane' | 'state' | 'model' | 'seat' | 'resource' | 'halt' | 'resolver' | 'group'
    | FacetRef
    | { readonly modelOf: SeatRef };

  export interface EntryFilter {
    readonly entry?: EntryType | readonly EntryType[];
    readonly status?: string | readonly string[];
    readonly kind?: KindRef;
    readonly lane?: Named;
    readonly state?: string | readonly string[];
    readonly position?: Position;
    readonly outcome?: AttemptOutcome | readonly AttemptOutcome[];
    readonly executable?: Named;
    readonly seat?: SeatRef;
    readonly model?: Named;
    readonly trigger?: Named;
    readonly group?: string;
    readonly halt?: Named;
    readonly resolver?: Resolver | readonly Resolver[];
    readonly resource?: Resource;
    readonly mode?: InvocationMode | readonly InvocationMode[];
    readonly ok?: boolean;
    readonly facets?: readonly FacetValue[];
    readonly decision?: Readonly<Record<string, unknown>>;
  }

  export interface Metrics {
    successRate(query: { readonly kind: KindRef; readonly model?: Named; readonly seat?: SeatRef } & Window): Rate;
    rate(query: { readonly among: EntryFilter; readonly count: EntryFilter } & Window): Rate;
    rateBy(query: { readonly among: EntryFilter; readonly count: EntryFilter; readonly by: Dimension } & Window): Readonly<Record<string, Rate>>;
    mean(query: { readonly of: Measure; readonly among: EntryFilter } & Window): Mean;
    median(query: { readonly of: Measure; readonly among: EntryFilter } & Window): Mean;
    sum(query: { readonly of: Measure; readonly among: EntryFilter } & Window): Mean;
    count(query: { readonly of: EntryFilter } & Window): number;
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
    readonly facets: readonly FacetValue[];
  }
  export interface RunEntry extends EntryBase {
    readonly entry: 'run';
    readonly status: 'started' | 'stopped' | 'took-over';
  }
  export interface TransitionEntry extends EntryBase {
    readonly entry: 'transition';
    readonly from?: string;
    readonly to: string;
    readonly position: Position;
    readonly verdict?: Verdict;
    readonly cause: 'flow' | 'supply' | 'trigger' | 'operation' | 'kernel';
    readonly reason?: string;
  }
  export interface AttemptEntry extends EntryBase {
    readonly entry: 'attempt';
    readonly status: 'started' | 'blocked' | 'waiting' | 'resumed' | 'interrupted' | 'ended' | 'retrying' | 'exhausted';
    readonly flow: string;
    readonly fingerprint: string;
    readonly outcome?: AttemptOutcome;
    readonly reason?: string;
    readonly wakeAt?: Date;
    readonly wakeOnChildren?: readonly string[];
    readonly costUsd: number;
    readonly durationMs: number;
  }
  export interface InvocationEntry extends EntryBase {
    readonly entry: 'invocation';
    readonly seq: number;
    readonly status: 'started' | 'submitted' | 'polled' | 'retrying' | 'ended';
    readonly executable: string;
    readonly handle?: string;
    readonly seat?: string;
    readonly role?: string;
    readonly model?: string;
    readonly account?: string;
    readonly mode: InvocationMode;
    readonly ok?: boolean;
    readonly interrupted?: true;
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
    readonly about?: unknown;
    readonly decision?: Readonly<Record<string, unknown>>;
    readonly resolver?: Resolver;
    readonly by?: string;
    readonly reads: readonly MetricRead[];
    readonly decisionMs?: number;
  }
  export interface FiringEntry extends EntryBase {
    readonly entry: 'firing';
    readonly status: 'fired' | 'tripped' | 'reset';
    readonly trigger: string;
    readonly group?: string;
    readonly reads: readonly MetricRead[];
    readonly effects: readonly string[];
  }
  export interface LaneEntry extends EntryBase {
    readonly entry: 'lane';
    readonly status: 'paused' | 'resumed';
    readonly trigger?: string;
    readonly reads: readonly MetricRead[];
    readonly durationMs: number;
  }
  export interface LeaseEntry extends EntryBase {
    readonly entry: 'lease';
    readonly status: 'requested' | 'acquired' | 'released';
    readonly resource: string;
    readonly mode: LockMode;
    readonly lockWaitMs: number;
  }
  export interface DecisionEntry extends EntryBase {
    readonly entry: 'decision';
    readonly policy: string;
    readonly reads: readonly MetricRead[];
    readonly result: string;
  }
  export interface OperationEntry extends EntryBase {
    readonly entry: 'operation';
    readonly status: 'requested' | 'applied';
    readonly operation: string;
    readonly client: string;
    readonly input: unknown;
  }
  export type LedgerEntry =
    | RunEntry | TransitionEntry | AttemptEntry | InvocationEntry | HaltEntry
    | FiringEntry | LaneEntry | LeaseEntry | DecisionEntry | OperationEntry;

  export interface UnitView<T, S extends string> {
    readonly key: string;
    readonly kind: string;
    readonly lane: string;
    readonly state: S;
    readonly position: Position;
    readonly data: T;
  }

  export interface UnitRecord extends UnitView<unknown, string> {
    readonly id: string;
    readonly parent?: string;
    readonly created: Date;
    readonly spentUsd: number;
    readonly failedAttempts: number;
    readonly retryAt?: Date;
    readonly parkedReason?: string;
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

  export interface QuotaPartition extends Named {
    append(event: QuotaEvent): Promise<void>;
    read(account: string, since: Date): Promise<readonly QuotaEvent[]>;
  }

  export interface Ledger extends Named {
    readonly quota: QuotaPartition;
    append(entries: readonly LedgerEntry[]): Promise<void>;
    read(query: { readonly filter: EntryFilter; readonly since?: Date; readonly until?: Date }): Promise<readonly LedgerEntry[]>;
    unit(key: string): Promise<UnitRecord | undefined>;
    units(query: { readonly kind?: string; readonly lane?: string; readonly position?: Position | readonly Position[] }): Promise<readonly UnitRecord[]>;
    putUnit(unit: UnitRecord): Promise<void>;
    replay(attempt: string): Promise<readonly (InvocationEntry | HaltEntry | AttemptEntry)[]>;
    claimWriter(run: string, ttlMs: number): Promise<boolean>;
    lease(resource: string, holder: string, mode: LockMode): Promise<boolean>;
    release(resource: string, holder: string): Promise<void>;
    transaction<R>(work: () => Promise<R>): Promise<R>;
  }

  export interface Store<T> extends Named {
    get(key: string): Promise<{ readonly data: T; readonly state?: string } | undefined>;
    put(key: string, data: T, state: string): Promise<void>;
  }

  export type Supply<T, S extends string> =
    | { readonly create: T; readonly key?: string; readonly state?: S }
    | { readonly update: string; readonly patch?: Partial<T>; readonly state?: S; readonly deferred?: true };

  export interface Stoppable {
    stop(): Promise<void>;
  }

  export interface Supplier<T, S extends string> extends Named {
    readonly kind: string;
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
    readonly quota?: QuotaPartition;
  }

  export interface GuardContext {
    readonly attempt: string;
    readonly unit: string;
    readonly workspace?: Workspace;
    leasePath(path: string): Promise<boolean>;
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
    readonly mode: 'model' | 'batch';
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
    readonly records: boolean;
    readonly maxUsd?: number;
    readonly cancellation: Cancellation;
  }

  export type ModelResponse =
    | { readonly status: 'done'; readonly output: unknown; readonly usage: Usage; readonly memories: readonly MemoryDraft[] }
    | { readonly status: 'failed'; readonly error: string; readonly usage: Usage };

  export interface Model extends Named {
    readonly provider: string;
    readonly price: Price;
    call(request: ModelRequest, account: Account): Promise<ModelResponse>;
    recover(invocation: string, account: Account): Promise<ModelResponse | 'running' | 'unknown'>;
    submit?(requests: readonly ModelRequest[], account: Account): Promise<string>;
    collect?(batch: string, account: Account): Promise<readonly ModelResponse[] | 'running'>;
  }

  export type Result<O> =
    | { readonly ok: true; readonly value: O; readonly costUsd: number; readonly model?: string }
    | { readonly ok: false; readonly error: string; readonly costUsd: number; readonly model?: string };

  export type JobPoll<O> =
    | { readonly status: 'running' }
    | { readonly status: 'done'; readonly result: O }
    | { readonly status: 'failed'; readonly error: string };

  export interface Failed {
    readonly failed: string;
  }

  export interface InvocationContext {
    readonly attempt: string;
    readonly unit: string;
    readonly seq: number;
    readonly cancellation: Cancellation;
    workspace(runner: Runner): Promise<Workspace>;
  }

  export type Recovery<I> = 'rerun' | 'park' | Executable<I, boolean>;

  export type Recovered<O> =
    | { readonly finished: Result<O> }
    | { readonly rerun: true }
    | { readonly park: string };

  export interface Executable<I, O> extends Named {
    readonly entity: 'seat' | 'command' | 'job';
    invoke(input: I, ctx: InvocationContext): Promise<Result<O>>;
    recover(input: I, ctx: InvocationContext): Promise<Recovered<O>>;
  }

  export interface PendingView<T = unknown, S extends string = string> extends UnitView<T, S> {
    readonly waitedMs: number;
    is<T2, S2 extends string>(kind: Kind<T2, S2>): this is PendingView<T2, S2>;
  }

  export interface ActiveView<T = unknown, S extends string = string> extends UnitView<T, S> {
    readonly attempt: string;
    is<T2, S2 extends string>(kind: Kind<T2, S2>): this is ActiveView<T2, S2>;
  }

  export interface WaitingView<T = unknown, S extends string = string> extends UnitView<T, S> {
    readonly attempt?: string;
    readonly waitingOn?: string;
    is<T2, S2 extends string>(kind: Kind<T2, S2>): this is WaitingView<T2, S2>;
  }

  export interface AccountView {
    readonly account: Account;
    readonly eligible: boolean;
    readonly share: number;
    readonly usedShare: number;
    readonly windowEndsAt?: Date;
  }

  export type PolicyDomain = 'model' | 'account' | 'scheduler' | 'retry' | 'rule';

  export interface Policy<C, D> extends Named {
    readonly entity: 'policy';
    readonly decides: PolicyDomain;
    decide(context: C): D;
  }

  export interface ModelChoice {
    readonly kind: KindRef;
    readonly seat: SeatRef;
    readonly metrics: Metrics;
  }

  export interface AccountChoice {
    readonly accounts: readonly AccountView[];
  }

  export interface SchedulerView {
    readonly now: Date;
    readonly pending: readonly PendingView[];
    readonly active: readonly ActiveView[];
    readonly waiting: readonly WaitingView[];
    readonly metrics: Metrics;
  }

  export interface ScheduleDecision {
    readonly start: readonly PendingView[];
    readonly preempt?: readonly ActiveView[];
  }

  export interface RetryView {
    readonly failures: number;
    readonly counting: 'attempts' | 'invocations';
  }
  export type RetryDecision = { readonly retryInMs: number } | 'stop';

  export interface HaltView {
    readonly id: string;
    readonly attempt: string;
    readonly unit: string;
    readonly halt: string;
    readonly show: string;
    readonly about: unknown;
    readonly raised: Date;
  }

  export interface ControlApi {
    readonly work: {
      list(query: { readonly lane?: string; readonly position?: Position | readonly Position[] }): Promise<readonly UnitRecord[]>;
      get(key: string): Promise<UnitRecord | undefined>;
      create(lane: string, data: unknown, key?: string): Promise<string>;
      update(key: string, patch: unknown): Promise<void>;
      move(key: string, state: string, reason: string): Promise<void>;
    };
    readonly halts: {
      list(): Promise<readonly HaltView[]>;
      resolve(halt: string, decision: unknown): Promise<void>;
    };
    readonly memory: {
      list(journal: string): Promise<readonly MemoryItem[]>;
      write(journal: string, item: MemoryDraft): Promise<string>;
      accept(id: string): Promise<void>;
      merge(ids: readonly string[], into: MemoryDraft): Promise<string>;
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
    readonly halts?: readonly Named[];
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
