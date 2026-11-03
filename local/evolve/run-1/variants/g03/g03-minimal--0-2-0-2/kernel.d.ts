declare module 'harness-dsl/kernel' {
  import { z } from 'zod';

  export type Position = 'pending' | 'active' | 'waiting' | 'terminal';
  export type Verdict = 'success' | 'failure' | 'neutral';
  export type AttemptOutcome = 'succeeded' | 'failed' | 'cancelled';

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
  export interface LaneRef extends Named {
    readonly entity: 'lane';
  }
  export interface TriggerRef extends Named {
    readonly entity: 'trigger';
  }
  export interface HaltRef extends Named {
    readonly entity: 'halt';
  }
  export interface RoleRef extends Named {
    readonly entity: 'role';
  }
  export interface FacetRef extends Named {
    readonly entity: 'facet';
  }
  export interface ExecutableRef extends Named {
    readonly entity: 'agent' | 'command';
  }
  export interface ModelRef extends Named {
    readonly entity: 'model';
  }

  export interface FacetValue {
    readonly facet: string;
    readonly value: string;
  }

  export interface Facet<V extends string = string> extends FacetRef {
    readonly values?: readonly V[];
    is(value: V): FacetValue;
  }

  export interface Kind<T, S extends string> extends KindRef {
    readonly schema: Schema<T>;
    readonly states: readonly State<S>[];
    readonly initial: S;
    readonly failure?: S;
  }

  export type Intent = 'read' | 'edit' | 'execute' | 'browse';

  export interface Role<I, O> extends RoleRef {
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

  export interface Scope {
    readonly kinds?: readonly KindRef[];
    readonly roles?: readonly RoleRef[];
    readonly facets?: readonly FacetValue[];
  }

  export interface ScopeRecord {
    readonly kinds: readonly string[];
    readonly roles: readonly string[];
    readonly facets: readonly FacetValue[];
  }

  export interface ItemFields {
    readonly text: string;
    readonly because?: string;
    readonly status?: 'candidate' | 'accepted';
  }

  export interface MemoryDraft extends ItemFields {
    readonly when?: Scope;
  }

  export interface MemoryItem extends ItemFields {
    readonly id: string;
    readonly created: Date;
    readonly memory: string;
    readonly archive: string;
    readonly when: ScopeRecord;
    readonly status: 'candidate' | 'accepted';
  }

  export interface Recalled extends MemoryItem {
    readonly sort: MemorySort;
    readonly ageDays: number;
    readonly specificity: number;
    readonly similarity?: number;
    readonly trackRecord: Rate;
  }

  export interface MemoryStore extends Named {
    put(item: MemoryItem): Promise<void>;
    get(id: string): Promise<MemoryItem | undefined>;
    remove(id: string): Promise<void>;
    list(archive: string): Promise<readonly MemoryItem[]>;
    search(query: {
      readonly archive: string;
      readonly scope: ScopeRecord;
      readonly text: string;
      readonly limit: number;
    }): Promise<readonly (MemoryItem & { readonly similarity?: number })[]>;
  }

  export interface RecallView {
    readonly items: readonly Recalled[];
    readonly scope: ScopeRecord;
    readonly query: string;
    readonly now: Date;
    readonly metrics: Metrics;
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
  export interface Total {
    readonly value: number;
    readonly samples: number;
  }
  export interface Window {
    readonly days?: number;
    readonly hours?: number;
    readonly since?: Date;
  }
  export type Measure = 'costUsd' | 'durationMs';
  export type EntryType = LedgerEntry['entry'];

  export interface EntryFilter {
    readonly entry?: EntryType | readonly EntryType[];
    readonly status?: string | readonly string[];
    readonly kind?: KindRef;
    readonly lane?: LaneRef;
    readonly state?: State<string> | readonly State<string>[];
    readonly position?: Position;
    readonly verdict?: Verdict | readonly Verdict[];
    readonly outcome?: AttemptOutcome | readonly AttemptOutcome[];
    readonly executable?: ExecutableRef;
    readonly model?: ModelRef;
    readonly trigger?: TriggerRef;
    readonly mode?: InvocationMode | readonly InvocationMode[];
    readonly ok?: boolean;
    readonly halt?: HaltRef;
    readonly route?: string;
    readonly facets?: readonly FacetValue[];
    readonly decision?: Readonly<Record<string, string | number | boolean | undefined>>;
  }

  export interface Metrics {
    successRate(query: { readonly kind: KindRef; readonly model?: ModelRef } & Window): Rate;
    rate(query: { readonly among: EntryFilter; readonly count: EntryFilter } & Window): Rate;
    rateBy<V extends string>(query: { readonly among: EntryFilter; readonly count: EntryFilter; readonly by: Facet<V> } & Window): Readonly<Partial<Record<V, Rate>>>;
    mean(query: { readonly of: Measure; readonly among: EntryFilter } & Window): Mean;
    sum(query: { readonly of: Measure; readonly among: EntryFilter } & Window): Total;
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
  }
  export interface AttemptEntry extends EntryBase {
    readonly entry: 'attempt';
    readonly status: 'started' | 'blocked' | 'resumed' | 'interrupted' | 'ended';
    readonly flow: string;
    readonly phase: string;
    readonly fingerprint: string;
    readonly outcome?: AttemptOutcome;
    readonly reason?: string;
    readonly costUsd: number;
    readonly durationMs: number;
  }
  export type InvocationMode = 'model' | 'batch' | 'command';
  export interface InvocationEntry extends EntryBase {
    readonly entry: 'invocation';
    readonly seq: number;
    readonly status: 'started' | 'submitted' | 'ended';
    readonly executable: string;
    readonly inputHash: string;
    readonly handle?: string;
    readonly agent?: string;
    readonly model?: string;
    readonly account?: string;
    readonly runner?: string;
    readonly mode: InvocationMode;
    readonly ok?: boolean;
    readonly interrupted?: true;
    readonly costUsd: number;
    readonly durationMs: number;
    readonly output?: unknown;
    readonly error?: string;
    readonly memoryIds: readonly string[];
  }
  export interface ObservationEntry extends EntryBase {
    readonly entry: 'observation';
    readonly seq: number;
    readonly of: 'clock' | 'facet' | 'children';
    readonly value: unknown;
  }
  export interface HaltEntry extends EntryBase {
    readonly entry: 'halt';
    readonly seq: number;
    readonly halt: string;
    readonly status: 'raised' | 'routed' | 'resolved' | 'cancelled';
    readonly route?: string;
    readonly show?: string;
    readonly reason?: string;
    readonly decision?: Readonly<Record<string, unknown>>;
    readonly by?: string;
    readonly durationMs: number;
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
  export interface ExcludedItem {
    readonly item: string;
    readonly trackRecord: Rate;
  }
  export interface DecisionEntry extends EntryBase {
    readonly entry: 'decision';
    readonly seq?: number;
    readonly policy: string;
    readonly reads: readonly MetricRead[];
    readonly result: string;
    readonly excluded?: readonly ExcludedItem[];
  }
  export interface OperationEntry extends EntryBase {
    readonly entry: 'operation';
    readonly status: 'requested' | 'applied';
    readonly operation: string;
    readonly client: string;
    readonly input: unknown;
  }
  export type LedgerEntry =
    | RunEntry | TransitionEntry | AttemptEntry | InvocationEntry | ObservationEntry | HaltEntry
    | FiringEntry | LaneEntry | DecisionEntry | OperationEntry;

  export interface UnitView<T, S extends string> {
    readonly key: string;
    readonly kind: string;
    readonly lane: string;
    readonly state: S;
    readonly position: Position;
    readonly data: T;
    readonly parent?: string;
    readonly created: Date;
    readonly spentUsd: number;
  }

  export interface UnitRecord extends UnitView<unknown, string> {
    readonly id: string;
    readonly failures: number;
    readonly retryAt?: Date;
    readonly wakeAt?: Date;
    readonly wakeOnChildren?: boolean;
    readonly wakeTo?: string;
  }

  export interface QuotaEvent {
    readonly account: string;
    readonly harness: string;
    readonly at: Date;
    readonly tokens?: number;
    readonly costUsd?: number;
    readonly windowEndsAt?: Date;
    readonly coolingUntil?: Date;
  }

  export interface QuotaPartition extends Named {
    append(event: QuotaEvent): Promise<void>;
    events(account: string, since: Date): Promise<readonly QuotaEvent[]>;
  }

  export interface AccountState {
    readonly utilization: number;
    readonly windowEndsAt?: Date;
    readonly coolingUntil?: Date;
    readonly byHarness: Readonly<Record<string, number>>;
  }

  export interface Ledger extends Named {
    readonly quota: QuotaPartition;
    append(entries: readonly LedgerEntry[]): Promise<void>;
    read(query: { readonly filter: EntryFilter; readonly since?: Date; readonly until?: Date }): Promise<readonly LedgerEntry[]>;
    unit(key: string): Promise<UnitRecord | undefined>;
    units(query: { readonly kind?: string; readonly lane?: string; readonly parent?: string; readonly position?: Position | readonly Position[] }): Promise<readonly UnitRecord[]>;
    putUnit(unit: UnitRecord): Promise<void>;
    replay(attempt: string): Promise<readonly (InvocationEntry | ObservationEntry | HaltEntry | DecisionEntry | AttemptEntry)[]>;
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
    preflight(): Promise<boolean>;
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
    | { readonly status: 'done'; readonly output: unknown; readonly usage: Usage; readonly memories: readonly ItemFields[] }
    | { readonly status: 'failed'; readonly error: string; readonly usage: Usage };

  export interface Model extends ModelRef {
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

  export interface Failed {
    readonly failed: string;
  }

  export interface InvocationContext {
    readonly attempt: string;
    readonly unit: string;
    readonly seq: number;
    readonly cancellation: Cancellation;
    workspace(runner: Runner): Promise<Workspace>;
    lease(resource: string): Promise<boolean>;
  }

  export type CommandRecovery<I> = 'rerun' | 'park' | Executable<I, boolean>;
  export type Recovery<I> = CommandRecovery<I> | 'ask-driver';

  export interface Executable<I, O> extends ExecutableRef {
    readonly recovery: Recovery<I>;
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
    readonly runners: readonly string[];
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

  export type PolicyDomain = 'model' | 'account' | 'scheduler' | 'retry' | 'recall' | 'rule';

  export interface Policy<C, D> extends Named {
    readonly entity: 'policy';
    readonly decides: PolicyDomain;
    decide(context: C): D;
  }

  export interface ModelChoice {
    readonly kind: KindRef;
    readonly lane: string;
    readonly unit: string;
    readonly facets: readonly FacetValue[];
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

  export interface RetryView {
    readonly failures: number;
    readonly error: string;
    readonly now: Date;
  }
  export type RetryDecision = { readonly retryInMs: number } | 'stop';

  export interface HaltView {
    readonly attempt: string;
    readonly unit: string;
    readonly halt: string;
    readonly route?: string;
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
      list(query?: { readonly route?: string }): Promise<readonly HaltView[]>;
      resolve(attempt: string, decision: unknown): Promise<void>;
    };
    readonly memory: {
      list(archive: string): Promise<readonly MemoryItem[]>;
      write(archive: string, item: ItemFields & { readonly when?: ScopeRecord }): Promise<string>;
      accept(id: string): Promise<void>;
      merge(ids: readonly string[], into: ItemFields & { readonly when?: ScopeRecord }): Promise<string>;
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
    readonly on?: EntryFilter;
    notify(entry: LedgerEntry, view: HarnessView): Promise<void>;
  }

  export interface Running {
    readonly run: string;
    readonly control: ControlApi;
    stop(): Promise<void>;
  }
}
