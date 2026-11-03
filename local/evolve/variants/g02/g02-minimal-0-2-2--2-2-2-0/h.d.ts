declare module 'harness-dsl' {
  import type {
    Verdict, State, Ref, Arg, Schema, Named, Kind, Role, RoleRef, Intent, MemoryKind, MemorySort,
    MemoryDraft, Executable, Result, Model, Account, Runner, Guard, Supplier, Supply, Store, MemoryStore,
    Ledger, Observer, Client, Operation, Policy, ModelChoice, AccountChoice, SchedulerView, ScheduleDecision,
    RetryView, RetryDecision, Metrics, Rate, UnitView, TimeSpec, Running, Recovery, Failed, Grade,
    Interval, Resource, Lock, JobPoll, FacetRef, FacetValue, SeatRef, JournalRef, LaneRef, HaltRef,
    TriggerRef, PoolRef, Report, ReportRows, InvocationRef, ChangedDecision, ChangedAbout,
    InterruptedDecision, InterruptedAbout
  } from 'harness-dsl/kernel';

  export type {
    Metrics, Model, Rate, Mean, EntryFilter, PendingView, ActiveView, WaitingView, Resource, FacetValue, Dimension,
    HaltFilter, InvocationFilter, GradeFilter, TransitionFilter, AttemptFilter, FiringFilter, LaneFilter,
    LeaseFilter, Report, ReportRows, Grade
  } from 'harness-dsl/kernel';

  export type SupplyOf<K> = K extends Kind<infer T, infer S extends string> ? Supply<T, S> : never;

  export interface KindDraft {
    data<T>(schema: Schema<T>): KindData<T>;
  }
  export interface KindData<T> {
    states<I extends string, S extends string = never>(initial: State<I>, ...others: readonly State<S>[]): Kind<T, I | S>;
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

  export interface Facet<V extends string> extends FacetRef {
    readonly schema: Schema<V>;
    value(value: V): FacetValue;
  }

  export interface Halt<D, C = void> extends HaltRef {
    readonly decision: Schema<D>;
    about<C2>(schema: Schema<C2>): Halt<D, C2>;
    timeout(after: Interval, resolve: (about: C) => D): Halt<D, C>;
    policy(rule: RulePolicy<C, D | null>): Halt<D, C>;
  }

  export interface CeilingAbout {
    readonly spentUsd: number;
    readonly limitUsd: number;
  }
  export interface CeilingDecision {
    readonly continue: boolean;
  }

  export type ModelPolicy = Policy<ModelChoice, Model>;
  export type AccountPolicy = Policy<AccountChoice, Account | null>;
  export type SchedulerPolicy = Policy<SchedulerView, ScheduleDecision>;
  export type RetryPolicy = Policy<RetryView, RetryDecision>;
  export interface RuleView<I> {
    readonly input: I;
    readonly metrics: Metrics;
  }
  export type RulePolicy<I, O> = Policy<RuleView<I>, O>;

  export interface RetrySpec {
    readonly retries: number;
    readonly firstDelayMs: number;
    readonly factor?: number;
    readonly maxDelayMs?: number;
  }

  export interface Journal extends JournalRef {
    readonly memory: MemoryKind;
  }

  export interface SeatDraft<I, O> {
    model(choice: Model | ModelPolicy): Seat<I, O>;
  }
  export interface Seat<I, O> extends Executable<I, O>, SeatRef {
    readonly entity: 'seat';
    readonly role: RoleRef;
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
    recovery(recovery: Recovery<I>): Command<I, O>;
    retry(policy: RetryPolicy): Command<I, O>;
    locks(select: (input: I) => readonly Lock[]): Command<I, O>;
  }

  export interface JobDraft {
    output<O>(schema: Schema<O>): JobShape<O>;
    batch<I, O>(seat: Seat<I, O>): Job<readonly I[], readonly Result<O>[]>;
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
  export interface Pool extends PoolRef {}

  export interface RunOptions {
    readonly scope?: { readonly resources?: readonly Resource[]; readonly facets?: readonly FacetValue[] };
  }
  export type RunArgs<I> = [I] extends [void]
    ? [input?: undefined, options?: RunOptions]
    : [input: I, options?: RunOptions];

  export type Ran<O> = Result<O> & InvocationRef;

  export interface Children<T, S extends string> {
    readonly entity: 'children';
    readonly kind: Kind<T, S>;
    readonly keys: readonly string[];
  }

  export interface FlowContext<T, S extends string, P> {
    readonly unit: UnitView<T, S>;
    readonly params: P;
    now(): Date;
    run<I, O>(executable: Executable<I, O>, ...args: RunArgs<I>): Promise<Ran<O>>;
    grade(ran: InvocationRef, grade: Grade): Promise<void>;
    move(state: S): Promise<void>;
    update(patch: Partial<T>): Promise<void>;
    tag<V extends string>(facet: Facet<V>, value: NoInfer<V>): void;
    halt<D>(halt: Halt<D, void>, show: string): Promise<D>;
    halt<D, C>(halt: Halt<D, C>, show: string, about: C): Promise<D>;
    remember(journal: Journal, draft: MemoryDraft): Promise<void>;
    spawn<T2, S2 extends string>(lane: Lane<T2, S2>, data: readonly T2[]): Promise<Children<T2, S2>>;
    wait(state: S, until: { readonly at: Date }): Promise<void>;
    wait<T2, S2 extends string>(state: S, until: { readonly children: Children<T2, S2> }): Promise<readonly UnitView<T2, S2>[]>;
    fail(reason: string): Failed;
  }

  export interface FlowDraft {
    for<T1, S1 extends string>(k1: Kind<T1, S1>): FlowShape<T1, S1, void>;
    for<T1, S1 extends string, T2, S2 extends string>(k1: Kind<T1, S1>, k2: Kind<T2, S2>): FlowShape<T1 | T2, S1 & S2, void>;
  }
  export interface FlowShape<T, S extends string, P> {
    params<P2>(schema: Schema<P2>): FlowShape<T, S, P2>;
    does(body: (ctx: FlowContext<T, S, P>) => Promise<S | Failed>): Flow<T, S, P>;
  }
  export interface Flow<T, S extends string, P> extends Named {
    readonly entity: 'flow';
    readonly states: readonly S[];
    readonly accepts: (data: T, params: P) => void;
  }

  export interface Allowance<T, S extends string> extends Named {
    readonly entity: 'allowance';
    readonly kind: Kind<T, S>;
    retry(policy: RetryPolicy, exhausted: NoInfer<S>): Allowance<T, S>;
    maxUsd(limit: number, over?: Halt<CeilingDecision, CeilingAbout>): Allowance<T, S>;
  }

  export interface LaneDraft<T, S extends string> {
    handler(flow: Flow<T, S, void>): Lane<T, S>;
    handler<P>(flow: Flow<T, S, P>, params: P): Lane<T, S>;
  }
  export interface Lane<T, S extends string> extends LaneRef {
    suppliers(...suppliers: readonly Supplier<T, S>[]): Lane<T, S>;
    store(store: Store<T>): Lane<T, S>;
    wip(limit: number): Lane<T, S>;
    order(by: (data: T) => string | number, onEarlierFailure: NoInfer<S>): Lane<T, S>;
    allowance(allowance: Allowance<T, S>): Lane<T, S>;
  }

  export interface UnitSource<T, S extends string> {
    readonly entity: 'source';
    readonly on: 'enters' | 'streak' | 'deadline';
    readonly kind: Kind<T, S>;
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
    readonly trippedAt: Date;
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
    create<T2, S2 extends string>(lane: Lane<T2, S2>, data: T2, key?: string): Effect;
    move<T2, S2 extends string>(lane: Lane<T2, S2>, key: string, state: NoInfer<S2>): Effect;
    remember(journal: Journal, draft: MemoryDraft): Effect;
    pause(lane: LaneRef): Effect;
    resume(lane: LaneRef): Effect;
    run<I, O>(executable: Executable<I, O>, input: I): Effect;
  }
  export interface UnitActions<S extends string> extends Actions {
    move(state: S): Effect;
    move<T2, S2 extends string>(lane: Lane<T2, S2>, key: string, state: NoInfer<S2>): Effect;
  }
  export interface Trigger extends TriggerRef {}

  export interface Harness extends Named {
    readonly entity: 'harness';
    ledger(ledger: Ledger): Harness;
    lanes(...lanes: readonly LaneRef[]): Harness;
    pools(...pools: readonly Pool[]): Harness;
    triggers(...triggers: readonly Trigger[]): Harness;
    scheduler(policy: SchedulerPolicy): Harness;
    reports(...reports: readonly Report[]): Harness;
    clients(...clients: readonly Client[]): Harness;
    observers(...observers: readonly Observer[]): Harness;
    start(): Promise<Running>;
  }

  export interface Dsl {
    state<N extends string>(name: N, position: 'pending' | 'active' | 'waiting'): State<N>;
    state<N extends string>(name: N, position: 'terminal', verdict: Verdict): State<N>;
    kind(name: string): KindDraft;
    role(name: string): RoleDraft;
    memory(name: string, sort: MemorySort): MemoryKind;
    halt<D>(name: string, decision: Schema<D>): Halt<D>;
    resource(name: string): Resource;
    facet<V extends string>(name: string, schema: Schema<V>): Facet<V>;

    seat<I, O>(name: string, role: Role<I, O>): SeatDraft<I, O>;
    command(name: string): Command<void, string>;
    job(name: string): JobDraft;
    flow(name: string): FlowDraft;

    lane<T, S extends string>(name: string, kind: Kind<T, S>): LaneDraft<T, S>;
    allowance<T, S extends string>(name: string, kind: Kind<T, S>): Allowance<T, S>;
    journal(name: string, memory: MemoryKind, store: MemoryStore): Journal;
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
    report(name: string, read: (metrics: Metrics, now: Date) => ReportRows): Report;
    harness(name: string): Harness;

    readonly on: {
      enters<T, S extends string>(kind: Kind<T, S>, state: NoInfer<S>, options?: { readonly times: number }): UnitSource<T, S>;
      streak<T, S extends string>(kind: Kind<T, S>, state: NoInfer<S>, count: number, group: (data: T) => string): UnitSource<T, S>;
      deadline<T, S extends string>(kind: Kind<T, S>, due: (data: T) => Date, whileIn: readonly NoInfer<S>[]): UnitSource<T, S>;
      metric(read: (metrics: Metrics) => Rate, bounds: MetricBounds): MetricSource<null>;
      metric(read: (metrics: Metrics) => Readonly<Record<string, Rate>>, bounds: MetricBounds): MetricSource<string>;
      halted<D, C>(halt: Halt<D, C>, after: Interval): HaltSource<C>;
    };

    readonly policy: {
      model(name: string, decide: (choice: ModelChoice) => Model): ModelPolicy;
      account(name: string, decide: (choice: AccountChoice) => Account | null): AccountPolicy;
      scheduler(name: string, decide: (view: SchedulerView) => ScheduleDecision): SchedulerPolicy;
      retry(name: string, spec: RetrySpec): RetryPolicy;
      rule<I, O>(name: string, decide: (input: I, metrics: Metrics) => O): RulePolicy<I, O>;
    };

    readonly halts: {
      readonly changed: Halt<ChangedDecision, ChangedAbout>;
      readonly interrupted: Halt<InterruptedDecision, InterruptedAbout>;
    };

    clock<T, S extends string>(
      name: string,
      kind: Kind<T, S>,
      at: TimeSpec,
      produce: (tick: { readonly now: Date; readonly units: readonly UnitView<T, S>[] }) => readonly Supply<T, S>[]
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
      resolve(first: HaltRef, ...rest: readonly HaltRef[]): Operation;
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
    kind: Kind<T, S>,
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
    kind: Kind<T, S>,
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
  export function store<T, S extends string>(kind: Kind<T, S>, path: string): Store<T>;
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
  import type { Runner, Ref } from 'harness-dsl/kernel';
  export function host(name: string, options: {
    readonly address: string;
    readonly user: string;
    readonly key: Ref<string>;
    readonly slots: number;
    readonly preflight?: readonly string[];
  }): Runner;
}

declare module 'harness-dsl/http' {
  import type { Kind, Supplier, Supply, Store, Client, Operation, Ref, Arg, Schema, Interval } from 'harness-dsl/kernel';
  export function webhook<T, S extends string, B>(kind: Kind<T, S>, options: {
    readonly path: string;
    readonly secret: Ref<string>;
    readonly body: Schema<B>;
    readonly read: (body: B) => Supply<NoInfer<T>, NoInfer<S>> | null;
  }): Supplier<T, S>;
  export function poll<T, S extends string, B>(kind: Kind<T, S>, options: {
    readonly url: string;
    readonly every: Interval;
    readonly headers: Readonly<Record<string, Arg>>;
    readonly body: Schema<B>;
    readonly read: (body: B) => readonly Supply<NoInfer<T>, NoInfer<S>>[];
  }): Supplier<T, S>;
  export function store<T, S extends string>(kind: Kind<T, S>, options: {
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
