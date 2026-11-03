declare module 'harness-dsl' {
  import type {
    Verdict, State, DeclaredPosition, Ref, Arg, Schema, Named, Kind, Role, Intent, MemoryKind, MemorySort, MemoryDraft,
    Executable, Result, Failure, Model, Account, Runner, Guard, Supplier, Supply, Store, MemoryStore, Ledger,
    Observer, Client, Operation, Policy, ModelChoice, AccountChoice, SchedulerView, ScheduleDecision,
    Metrics, Rate, UnitView, TimeSpec, Running, Recovery, Failed, EntryFilter, Interval, Resource, Lock,
    JobPoll, Backoff, Facet, SeatRef, RecoveryDecision, ParkedFacts, RecallView, RecallCandidate, JournalRef
  } from 'harness-dsl/kernel';

  export type {
    Metrics, Model, Rate, ModelRates, EntryFilter, PendingView, LiveView, Facet, FacetValue, Resource, Lock,
    RecallView, RecallCandidate, Failure
  } from 'harness-dsl/kernel';

  type AnyState = State<string, DeclaredPosition>;
  type NameOf<X> = X extends State<infer N, DeclaredPosition> ? N : never;
  type NamesAt<X, P extends DeclaredPosition> = X extends State<infer N, infer Q> ? (Q extends P ? N : never) : never;

  export interface KindDraft {
    data<T>(schema: Schema<T>): KindData<T>;
  }
  export interface KindData<T> {
    states<A extends State<string, 'pending'>, R extends readonly AnyState[]>(
      initial: A,
      ...others: R
    ): Kind<T, NameOf<A | R[number]>, NamesAt<A | R[number], 'terminal'>, NamesAt<A | R[number], 'waiting'>>;
  }

  export interface RoleDraft {
    input<I>(schema: Schema<I>): RoleInput<I>;
  }
  export interface RoleInput<I> {
    output<O>(schema: Schema<O>): RoleShape<I, O>;
  }
  export interface RoleShape<I, O> {
    prompt(render: (input: I) => string): RoleDescriptor<I, O>;
  }
  export interface RoleDescriptor<I, O> extends Role<I, O> {
    intents(list: readonly Intent[]): RoleDescriptor<I, O>;
  }

  export interface HaltRef extends Named {
    readonly entity: 'halt';
  }
  export interface HaltPolicyView<D, C> {
    readonly about: C;
    readonly metrics: Metrics;
    resolved(match?: Partial<D>): EntryFilter;
  }
  export interface Halt<D, C = void> extends HaltRef {
    readonly decision: Schema<D>;
    about<C2>(schema: Schema<C2>): Halt<D, C2>;
    timeout(after: Interval, resolve: (about: C) => D): Halt<D, C>;
    policy(name: string, decide: (view: HaltPolicyView<D, C>) => D | null): Halt<D, C>;
    resolved(match?: Partial<D>): EntryFilter;
  }

  export type ModelPolicy = Policy<ModelChoice, Model>;
  export type AccountPolicy = Policy<AccountChoice, Account | null>;
  export type SchedulerPolicy = Policy<SchedulerView, ScheduleDecision>;
  export type RecallPolicy = Policy<RecallView, readonly RecallCandidate[]>;
  export interface RuleView<I> {
    readonly input: I;
    readonly metrics: Metrics;
  }
  export interface RulePolicy<I, O> extends Policy<RuleView<I>, O> {
    readonly input: Schema<I>;
  }

  export interface Journal extends JournalRef {
    readonly memory: MemoryKind;
    readonly recall: RecallPolicy;
  }

  export interface SeatDraft<I, O> {
    model(choice: Model | ModelPolicy): Seat<I, O>;
  }
  export interface Seat<I, O> extends Executable<I, O>, SeatRef {
    readonly entity: 'seat';
    on(runner: Runner): Seat<I, O>;
    recalls(...journals: readonly Journal[]): Seat<I, O>;
    records(journal: Journal): Seat<I, O>;
    guards(...guards: readonly Guard[]): Seat<I, O>;
  }

  export interface Command<I, O> extends Executable<I, O> {
    readonly entity: 'command';
    input<I2>(schema: Schema<I2>): Command<I2, O>;
    output<O2>(schema: Schema<O2>): Command<I, O2>;
    argv(render: (input: I) => readonly Arg[]): Command<I, O>;
    on(...runners: readonly Runner[]): Command<I, O>;
    locks(select: (input: I) => readonly Lock[]): Command<I, O>;
    recovery(recovery: Recovery<I>): Command<I, O>;
    retries(times: number, backoff?: Backoff): Command<I, O>;
  }

  export interface JobDraft {
    output<O>(schema: Schema<O>): JobShape<O>;
  }
  export interface JobShape<O> {
    submit<I>(command: Executable<I, string>): JobSubmitted<I, O>;
  }
  export interface JobSubmitted<I, O> {
    collect(command: Executable<string, JobPoll<O>>, every: Interval): Job<I, O>;
  }
  export interface Job<I, O> extends Executable<I, O> {
    readonly entity: 'job';
  }

  export interface PoolMember {
    readonly account: Account;
    readonly share: number;
  }
  export interface Pool extends Named {
    readonly entity: 'pool';
  }

  export type RunArgs<I> = [I] extends [void] ? [] : [input: I];

  export interface Children<T, S extends string> {
    readonly entity: 'children';
    readonly lane: string;
    readonly keys: readonly string[];
    readonly view?: (unit: UnitView<T, S>) => void;
  }

  export interface FlowContext<T, S extends string, W extends string, P> {
    readonly unit: UnitView<T, S>;
    readonly params: P;
    now(): Date;
    run<I, O>(executable: Executable<I, O>, ...args: RunArgs<I>): Promise<Result<O>>;
    batch<I, O, const L extends readonly I[]>(seat: Seat<I, O>, inputs: L): Promise<{ readonly [K in keyof L]: Result<O> }>;
    update(patch: Partial<T>): Promise<void>;
    halt<D>(halt: Halt<D, void>, show: string): Promise<D>;
    halt<D, C>(halt: Halt<D, C>, show: string, about: C): Promise<D>;
    decide<I, O>(rule: RulePolicy<I, O>, input: NoInfer<I>): Promise<O>;
    remember(journal: Journal, draft: MemoryDraft): Promise<void>;
    spawn<T2, S2 extends string>(lane: Lane<T2, S2, string>, data: readonly NoInfer<T2>[]): Promise<Children<T2, S2>>;
    suspend(state: W, until: { readonly at: Date }): Promise<void>;
    suspend<T2, S2 extends string>(state: W, until: { readonly children: Children<T2, S2> }): Promise<readonly UnitView<T2, S2>[]>;
    fail(cause: Failure): Failed;
  }

  export interface FlowDraft {
    for<T1, S1 extends string, F1 extends string, W1 extends string>(k1: Kind<T1, S1, F1, W1>): FlowShape<T1, S1, W1, void>;
    for<T1, S1 extends string, F1 extends string, W1 extends string, T2, S2 extends string, F2 extends string, W2 extends string>(
      k1: Kind<T1, S1, F1, W1>,
      k2: Kind<T2, S2, F2, W2>
    ): FlowShape<T1 | T2, S1 & S2, W1 & W2, void>;
  }
  export interface FlowShape<T, S extends string, W extends string, P> {
    params<P2>(schema: Schema<P2>): FlowShape<T, S, W, P2>;
    does(body: (ctx: FlowContext<T, S, W, P>) => Promise<S | Failed>): Flow<T, S, P>;
  }
  export interface Flow<T, S extends string, P> extends Named {
    readonly entity: 'flow';
    readonly states: readonly S[];
    readonly accepts: (data: T, params: P) => void;
  }

  export interface LaneDraft<T, S extends string, F extends string, W extends string> {
    handler<P>(flow: Flow<T, S, P>, ...params: RunArgs<NoInfer<P>>): HandledLane<T, S, F, W>;
  }
  export interface HandledLane<T, S extends string, F extends string, W extends string> {
    retries(times: number, exhausted: F | W, backoff?: Backoff): Lane<T, S, W>;
  }
  export interface LaneRef extends Named {
    readonly entity: 'lane';
  }
  export interface Lane<T, S extends string, W extends string = string> extends LaneRef {
    suppliers(...suppliers: readonly Supplier<T, S>[]): Lane<T, S, W>;
    store(store: Store<T>): Lane<T, S, W>;
    wip(limit: number): Lane<T, S, W>;
    maxUsdPerUnit(limit: number): Lane<T, S, W>;
    locks(select: (data: T) => readonly Lock[]): Lane<T, S, W>;
    sequence(order: (data: T) => string, parked: W): Lane<T, S, W>;
    facet<V extends string>(facet: Facet<V>, read: (data: T) => V | undefined): Lane<T, S, W>;
  }

  export interface UnitSource<T, S extends string> {
    readonly entity: 'source';
    readonly on: 'enters' | 'streak' | 'deadline';
    readonly kind: Kind<T, S, string, string>;
  }
  export interface MetricSource<G extends string | null> {
    readonly entity: 'source';
    readonly on: 'metric';
    readonly groups?: readonly G[];
  }
  export interface HaltSource<C> {
    readonly entity: 'source';
    readonly on: 'halted';
    readonly halt: HaltRef;
    readonly about?: C;
  }
  export type Bound = { readonly below: number } | { readonly above: number };
  export interface MetricBounds {
    readonly trip: Bound;
    readonly reset: Bound;
    readonly minSamples: number;
  }

  export interface UnitEvent<T, S extends string> {
    readonly unit: UnitView<T, S>;
    readonly at: Date;
    readonly attempt?: { readonly durationMs: number };
  }
  export interface MetricEvent<G extends string | null> {
    readonly group: G;
    readonly rate: Rate;
    readonly state: 'tripped' | 'reset';
  }
  export interface HaltEvent<C> {
    readonly unit: string;
    readonly about: C;
    readonly raisedAt: Date;
  }

  export interface Effect {
    readonly entity: 'effect';
  }
  export interface Actions {
    create<T2, S2 extends string>(lane: Lane<T2, S2, string>, data: NoInfer<T2>, key?: string): Effect;
    move<T2, S2 extends string>(lane: Lane<T2, S2, string>, key: string, state: NoInfer<S2>): Effect;
    remember(journal: Journal, draft: MemoryDraft): Effect;
    pause(lane: LaneRef): Effect;
    resume(lane: LaneRef): Effect;
    run<I, O>(executable: Executable<I, O>, input: NoInfer<I>): Effect;
  }
  export interface UnitActions<S extends string> extends Actions {
    move(state: S): Effect;
    move<T2, S2 extends string>(lane: Lane<T2, S2, string>, key: string, state: NoInfer<S2>): Effect;
  }
  export interface Trigger extends Named {
    readonly entity: 'trigger';
  }

  export interface Tick<T, S extends string> {
    readonly now: Date;
    readonly units: readonly UnitView<T, S>[];
    create(data: T, key?: string): Supply<T, S>;
    update(key: string, change: { readonly patch?: Partial<T>; readonly state?: S }): Supply<T, S>;
  }

  export interface Harness extends Named {
    readonly entity: 'harness';
    ledger(ledger: Ledger): Harness;
    lanes(...lanes: readonly LaneRef[]): Harness;
    pools(...pools: readonly Pool[]): Harness;
    triggers(...triggers: readonly Trigger[]): Harness;
    scheduler(policy: SchedulerPolicy): Harness;
    clients(...clients: readonly Client[]): Harness;
    observers(...observers: readonly Observer[]): Harness;
    start(): Promise<Running>;
  }

  export interface Dsl {
    state<N extends string, P extends 'pending' | 'waiting'>(name: N, position: P): State<N, P>;
    state<N extends string>(name: N, position: 'terminal', verdict: Verdict): State<N, 'terminal'>;
    kind(name: string): KindDraft;
    role(name: string): RoleDraft;
    memory(name: string, sort: MemorySort): MemoryKind;
    halt<D>(name: string, decision: Schema<D>): Halt<D>;
    resource(name: string): Resource;
    facet<V extends string>(name: string, values: Schema<V>): Facet<V>;

    seat<I, O>(name: string, role: Role<I, O>): SeatDraft<I, O>;
    command(name: string): Command<void, string>;
    job(name: string): JobDraft;
    flow(name: string): FlowDraft;

    lane<T, S extends string, F extends string, W extends string>(name: string, kind: Kind<T, S, F, W>): LaneDraft<T, S, F, W>;
    journal(name: string, memory: MemoryKind, store: MemoryStore, recall: RecallPolicy): Journal;
    pool(name: string, members: readonly PoolMember[], policy?: AccountPolicy): Pool;
    trigger<T, S extends string>(
      name: string,
      source: UnitSource<T, S>,
      effect: (event: UnitEvent<T, S>, act: UnitActions<S>) => Effect | readonly Effect[]
    ): Trigger;
    trigger<G extends string | null>(
      name: string,
      source: MetricSource<G>,
      effect: (event: MetricEvent<G>, act: Actions) => Effect | readonly Effect[]
    ): Trigger;
    trigger<C>(
      name: string,
      source: HaltSource<C>,
      effect: (event: HaltEvent<C>, act: Actions) => Effect | readonly Effect[]
    ): Trigger;
    harness(name: string): Harness;

    readonly on: {
      enters<T, S extends string>(kind: Kind<T, S, string, string>, state: NoInfer<S>, options?: { readonly times: number }): UnitSource<T, S>;
      streak<T, S extends string>(kind: Kind<T, S, string, string>, state: NoInfer<S>, count: number, group: (data: T) => string): UnitSource<T, S>;
      deadline<T, S extends string>(kind: Kind<T, S, string, string>, due: (data: T) => Date, whileIn: readonly NoInfer<S>[]): UnitSource<T, S>;
      metric(read: (metrics: Metrics) => Rate, bounds: MetricBounds): MetricSource<null>;
      metric<V extends string>(read: (metrics: Metrics) => Readonly<Partial<Record<V, Rate>>>, bounds: MetricBounds): MetricSource<V>;
      halted<D, C>(halt: Halt<D, C>, after: Interval): HaltSource<C>;
    };

    readonly policy: {
      model<M extends Model>(name: string, candidates: readonly M[], decide: (choice: ModelChoice) => M): ModelPolicy;
      account(name: string, decide: (choice: AccountChoice) => Account | null): AccountPolicy;
      scheduler(name: string, decide: (view: SchedulerView) => ScheduleDecision): SchedulerPolicy;
      recall(name: string, decide: (view: RecallView) => readonly RecallCandidate[]): RecallPolicy;
      rule<I, O>(name: string, input: Schema<I>, decide: (input: I, metrics: Metrics) => O): RulePolicy<I, O>;
    };

    readonly halts: {
      readonly interrupted: Halt<RecoveryDecision, ParkedFacts>;
      readonly definitionChanged: Halt<RecoveryDecision, ParkedFacts>;
      readonly costCeiling: Halt<RecoveryDecision, ParkedFacts>;
    };

    clock<T, S extends string>(
      name: string,
      kind: Kind<T, S, string, string>,
      at: TimeSpec,
      produce: (tick: Tick<T, S>) => readonly Supply<T, S>[]
    ): Supplier<T, S>;
    readonly operator: Supplier<never, never>;

    readonly ops: {
      readonly readWork: Operation;
      readonly writeWork: Operation;
      readonly readMemory: Operation;
      readonly writeMemory: Operation;
      readonly curateMemory: Operation;
      readonly readTelemetry: Operation;
      readonly readAccounts: Operation;
      readonly setShares: Operation;
      resolve(...halts: readonly HaltRef[]): Operation;
    };
    operation<I, O>(name: string, executable: Executable<I, O>): Operation;

    env(name: string): Ref<string>;
  }

  export const H: Dsl;
}

declare module 'harness-dsl/claude-code' {
  import type { Account, Model, Guard, Client, Operation, Ref, Executable, QuotaPartition } from 'harness-dsl/kernel';
  export function subscription(name: string, options: { readonly token: Ref<string>; readonly quota?: QuotaPartition }): Account;
  export function model(id: string): Model;
  export function fileLeases(): Guard;
  export function stopCheck(check: Executable<void, unknown>): Guard;
  export function supervisor(options: { readonly grants: readonly Operation[] }): Client;
}

declare module 'harness-dsl/anthropic' {
  import type { Account, Model, Ref, QuotaPartition } from 'harness-dsl/kernel';
  export function account(name: string, options: { readonly apiKey: Ref<string>; readonly quota?: QuotaPartition }): Account;
  export function model(id: string): Model;
}

declare module 'harness-dsl/linear' {
  import type { Kind, Supplier, Store, Ref } from 'harness-dsl/kernel';
  export interface Issue {
    readonly title: string;
    readonly description: string;
    readonly parentId?: string;
  }
  export function tracker<T, S extends string>(
    kind: Kind<T, S, string, string>,
    options: {
      readonly apiKey: Ref<string>;
      readonly team: string;
      readonly label: string;
      readonly read: (issue: Issue) => NoInfer<T>;
      readonly statuses: Readonly<Record<NoInfer<S>, string>>;
    }
  ): Supplier<T, S> & Store<T>;
}

declare module 'harness-dsl/folder' {
  import type { Kind, Supplier, Store } from 'harness-dsl/kernel';
  export interface MarkdownFile {
    readonly path: string;
    readonly frontmatter: Readonly<Record<string, unknown>>;
    readonly body: string;
  }
  export function files<T, S extends string>(
    kind: Kind<T, S, string, string>,
    options: {
      readonly dir: string;
      readonly read: (file: MarkdownFile) => NoInfer<T>;
      readonly key?: (file: MarkdownFile) => string;
    }
  ): Supplier<T, S> & Store<T>;
}

declare module 'harness-dsl/sqlite' {
  import type { Kind, Store, Ledger, QuotaPartition } from 'harness-dsl/kernel';
  export function ledger(path: string): Ledger;
  export function store<T, S extends string>(kind: Kind<T, S, string, string>, path: string): Store<T>;
  export function quota(path: string): QuotaPartition;
}

declare module 'harness-dsl/jsonl' {
  import type { MemoryStore } from 'harness-dsl/kernel';
  export function memory(path: string): MemoryStore;
}

declare module 'harness-dsl/qdrant' {
  import type { MemoryStore, Ref } from 'harness-dsl/kernel';
  export function memory(options: {
    readonly url: string;
    readonly collection: string;
    readonly embedder: string;
    readonly apiKey: Ref<string>;
  }): MemoryStore;
}

declare module 'harness-dsl/git' {
  import type { Runner } from 'harness-dsl/kernel';
  export function worktree(name: string, options: { readonly repo: string; readonly slots: number }): Runner;
}

declare module 'harness-dsl/shell' {
  import type { Runner } from 'harness-dsl/kernel';
  export function local(name: string, options: { readonly slots: number }): Runner;
}

declare module 'harness-dsl/ssh' {
  import type { Runner, Ref, Executable } from 'harness-dsl/kernel';
  export function host(name: string, options: {
    readonly address: string;
    readonly user: string;
    readonly key: Ref<string>;
    readonly slots: number;
    readonly preflight?: Executable<void, unknown>;
  }): Runner;
}

declare module 'harness-dsl/http' {
  import type { Kind, Supplier, Supply, Store, Client, Operation, Ref, Arg, Schema, Interval } from 'harness-dsl/kernel';
  export function webhook<T, S extends string, B>(kind: Kind<T, S, string, string>, options: {
    readonly path: string;
    readonly secret: Ref<string>;
    readonly body: Schema<B>;
    readonly read: (body: B) => Supply<NoInfer<T>, NoInfer<S>> | null;
  }): Supplier<T, S>;
  export function poll<T, S extends string, B>(kind: Kind<T, S, string, string>, options: {
    readonly url: string;
    readonly every: Interval;
    readonly headers: Readonly<Record<string, Arg>>;
    readonly body: Schema<B>;
    readonly read: (body: B) => readonly Supply<NoInfer<T>, NoInfer<S>>[];
  }): Supplier<T, S>;
  export function store<T, S extends string>(kind: Kind<T, S, string, string>, options: {
    readonly url: string;
    readonly headers: Readonly<Record<string, Arg>>;
    readonly stateField: string;
  }): Store<T>;
  export function control(options: {
    readonly port: number;
    readonly token: Ref<string>;
    readonly grants: readonly Operation[];
  }): Client;
}

declare module 'harness-dsl/markdown' {
  import type { Observer } from 'harness-dsl/kernel';
  export function board(path: string): Observer;
  export function telemetry(path: string): Observer;
}

declare module 'harness-dsl/slack' {
  import type { Observer, Ref, LedgerEntry } from 'harness-dsl/kernel';
  export function notify(options: {
    readonly webhook: Ref<string>;
    readonly message: (entry: LedgerEntry) => string | null;
  }): Observer;
}
