declare module 'harness-dsl' {
  import type {
    Position, Verdict, AttemptOutcome, Ref, Arg, Schema, Named, State, Lifecycle, Kind, Role, Intent,
    MemoryKind, Trust, MemoryDraft, Executable, CrashMode, Result, Failure, Model, Account, Runner, Guard,
    Supplier, Supply, Store, MemoryStore, Ledger, QuotaBook, Observer, Client, Operation, ControlApi, Policy,
    ModelChoice, AccountChoice, SchedulerView, ScheduleDecision, RecallView, Recalled, RetryView,
    RetryDecision, RuleView, Metrics, Rate, UnitView, Cadence, Running
  } from 'harness-dsl/kernel';

  export type {
    Position, Verdict, AttemptOutcome, Ref, Arg, Schema, Named, State, Lifecycle, Kind, Role, Intent,
    MemoryKind, Trust, MemoryDraft, Executable, CrashMode, Result, Failure, Model, Account, Runner, Guard,
    Supplier, Supply, Store, MemoryStore, Ledger, QuotaBook, Observer, Client, Operation, ControlApi, Policy,
    ModelChoice, AccountChoice, SchedulerView, ScheduleDecision, RecallView, Recalled, RetryView,
    RetryDecision, RuleView, Metrics, Rate, UnitView, Cadence, Running
  } from 'harness-dsl/kernel';
  export type { PendingView, ActiveView, AccountView, Mean, EntryFilter, LedgerEntry, Interval } from 'harness-dsl/kernel';

  export type DataOf<K> = K extends Kind<infer T, infer _S extends string> ? T : never;
  export type StateOf<K> = K extends Kind<infer _T, infer S extends string> ? S : never;

  export interface KindEnds<S extends string> {
    readonly initial: S;
    readonly afterFailure: S;
  }
  export interface KindDraft {
    data<T>(schema: Schema<T>): KindData<T>;
  }
  export interface KindData<T> {
    states<S extends string>(lifecycle: Lifecycle<S>, ends: KindEnds<NoInfer<S>>): Kind<T, S>;
    states<S extends string>(states: readonly State<S>[], ends: KindEnds<NoInfer<S>>): Kind<T, S>;
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

  export type ModelPolicy = Policy<ModelChoice, Model>;
  export type AccountPolicy = Policy<AccountChoice, Account | null>;
  export type SchedulerPolicy = Policy<SchedulerView, ScheduleDecision>;
  export type RecallPolicy = Policy<RecallView, readonly Recalled[]>;
  export type RetryPolicy = Policy<RetryView, RetryDecision>;
  export type RulePolicy<I, O> = Policy<RuleView<I>, O>;

  export interface MemoryKindDescriptor<M> extends MemoryKind<M> {
    data<M2>(schema: Schema<M2>): MemoryKindDescriptor<M2>;
  }

  export interface Library<M> extends Named {
    readonly entity: 'library';
    readonly memory: MemoryKind<M>;
    readonly store: MemoryStore;
    recall(policy: RecallPolicy): Library<M>;
  }

  export interface AgentDraft<I, O> {
    model(choice: Model | ModelPolicy): Agent<I, O>;
  }
  export interface Agent<I, O> extends Executable<I, O> {
    readonly entity: 'agent';
    readonly role: Role<I, O>;
    on(runner: Runner): Agent<I, O>;
    recalls(...libraries: readonly Library<unknown>[]): Agent<I, O>;
    records(library: Library<unknown>): Agent<I, O>;
    guards(...guards: readonly Guard[]): Agent<I, O>;
    onCrash(mode: CrashMode): Agent<I, O>;
  }

  export interface Command<I, O> extends Executable<I, O> {
    readonly entity: 'command';
    input<I2>(schema: Schema<I2>): Command<I2, O>;
    output<O2>(schema: Schema<O2>): Command<I, O2>;
    argv(render: (input: I) => readonly Arg[]): Command<I, O>;
    on(runner: Runner | ((input: I) => Runner)): Command<I, O>;
    onCrash(mode: 'rerun'): Command<I, O>;
    onCrash(mode: 'park', options?: { readonly happened?: Executable<I, boolean> }): Command<I, O>;
  }

  export interface PoolMember {
    readonly account: Account;
    readonly share: number;
  }
  export interface Pool extends Named {
    readonly entity: 'pool';
    readonly members: readonly PoolMember[];
    readonly policy: AccountPolicy;
  }

  export interface RecallScope {
    readonly skills?: readonly string[];
    readonly resources?: readonly string[];
  }
  export interface RunOptions {
    readonly retry?: RetryPolicy;
    readonly scope?: RecallScope;
  }
  export type RunArgs<I> = [I] extends [void]
    ? [input?: undefined, options?: RunOptions]
    : [input: I, options?: RunOptions];

  export interface HaltRequest<D> {
    readonly name: string;
    readonly show: string;
    readonly decision: Schema<D>;
  }

  export interface Until<S extends string> {
    readonly rest: S;
    readonly then: S;
    readonly wakeAt?: Date;
    readonly wakeOnChildren?: true;
  }

  export interface FlowContext<T, S extends string, P> {
    readonly unit: UnitView<T, S>;
    readonly params: P;
    now(): Date;
    run<I, O>(executable: Executable<I, O>, ...args: RunArgs<I>): Promise<Result<O>>;
    batch<I, O>(agent: Agent<I, O>, inputs: readonly I[]): Promise<readonly Result<O>[]>;
    move(state: S): Promise<void>;
    update(patch: Partial<T>): Promise<void>;
    tag(tags: Readonly<Record<string, string>>): void;
    halt<D>(request: HaltRequest<D>): Promise<D>;
    decide<I, O>(rule: RulePolicy<I, O>, input: I): Promise<O>;
    remember<M>(library: Library<M>, draft: MemoryDraft<M>): Promise<void>;
    spawn<T2, S2 extends string>(lane: Lane<T2, S2>, data: readonly T2[]): Promise<readonly string[]>;
    children(): Promise<readonly UnitView<unknown, string>[]>;
    until(rest: S, wake: { readonly at?: Date; readonly children?: true; readonly then: S }): Until<S>;
    fail(reason: string): Failure;
  }

  export interface FlowDraft {
    for<T1, S1 extends string>(k1: Kind<T1, S1>): FlowShape<T1, S1, void>;
    for<T1, S1 extends string, T2, S2 extends string>(k1: Kind<T1, S1>, k2: Kind<T2, S2>): FlowShape<T1 | T2, S1 & S2, void>;
    for<T1, S1 extends string, T2, S2 extends string, T3, S3 extends string>(
      k1: Kind<T1, S1>, k2: Kind<T2, S2>, k3: Kind<T3, S3>
    ): FlowShape<T1 | T2 | T3, S1 & S2 & S3, void>;
  }
  export interface FlowShape<T, S extends string, P> {
    params<P2>(schema: Schema<P2>): FlowShape<T, S, P2>;
    does(body: (ctx: FlowContext<T, S, P>) => Promise<S | Until<S> | Failure>): Flow<T, S, P>;
  }
  export interface Flow<T, S extends string, P> extends Named {
    readonly entity: 'flow';
    readonly kinds: readonly string[];
    readonly states: readonly S[];
    readonly accepts: (data: T) => void;
    readonly params?: Schema<P>;
  }

  export interface LaneDraft<T, S extends string> {
    handler(flow: Flow<T, S, void>): Lane<T, S>;
    handler<P>(flow: Flow<T, S, P>, params: P): Lane<T, S>;
  }
  export interface Lane<T, S extends string> extends Named {
    readonly entity: 'lane';
    readonly kind: Kind<T, S>;
    suppliers(...suppliers: readonly Supplier<T, S>[]): Lane<T, S>;
    store(store: Store<T>): Lane<T, S>;
    wip(limit: number): Lane<T, S>;
    maxUsdPerUnit(limit: number): Lane<T, S>;
  }
  export interface LaneRef extends Named {
    readonly entity: 'lane';
  }

  export interface Source<E, S extends string> {
    readonly entity: 'source';
    readonly on: 'enters' | 'streak' | 'deadline' | 'cadence' | 'crossing';
    readonly kind?: string;
    readonly states: readonly S[];
    readonly carries: (event: E) => void;
  }
  export interface UnitEvent<T, S extends string> {
    readonly unit: UnitView<T, S>;
    readonly at: Date;
    readonly attempt?: { readonly id: string; readonly durationMs: number; readonly costUsd: number };
    readonly streak?: number;
  }
  export interface CrossingEvent {
    readonly group: string;
    readonly direction: 'entered' | 'cleared';
    readonly rate: Rate;
    readonly at: Date;
  }
  export type Threshold = { readonly above: number } | { readonly below: number };
  export type CrossingOptions =
    ({ readonly rate: (metrics: Metrics) => Rate } | { readonly rates: (metrics: Metrics) => Readonly<Record<string, Rate>> })
    & { readonly enter: Threshold; readonly clear: Threshold; readonly minSamples: number };

  export interface Effect {
    readonly entity: 'effect';
    readonly does: 'create' | 'move' | 'remember' | 'pause' | 'resume';
  }
  export interface CreateOptions {
    readonly key?: string;
    readonly tags?: Readonly<Record<string, string>>;
  }
  export interface Actions<S extends string> {
    create<T2, S2 extends string>(lane: Lane<T2, S2>, data: T2, options?: CreateOptions): Effect;
    move(state: S): Effect;
    move<T2, S2 extends string>(lane: Lane<T2, S2>, key: string, state: NoInfer<S2>): Effect;
    remember<M>(library: Library<M>, draft: MemoryDraft<M>): Effect;
    pause(lane: LaneRef, reason: string): Effect;
    resume(lane: LaneRef, reason: string): Effect;
  }
  export interface Trigger extends Named {
    readonly entity: 'trigger';
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
    control(): Promise<ControlApi>;
  }

  export interface Dsl {
    state<N extends string>(name: N, position: 'pending' | 'active' | 'waiting'): State<N>;
    state<N extends string>(name: N, position: 'terminal', verdict: Verdict): State<N>;
    lifecycle<S extends string>(...states: readonly State<S>[]): Lifecycle<S>;
    kind(name: string): KindDraft;
    role(name: string): RoleDraft;
    memory(name: string, trust: Trust): MemoryKindDescriptor<void>;

    agent<I, O>(name: string, role: Role<I, O>): AgentDraft<I, O>;
    command(name: string): Command<void, string>;
    flow(name: string): FlowDraft;

    lane<T, S extends string>(name: string, kind: Kind<T, S>): LaneDraft<T, S>;
    library<M>(name: string, memory: MemoryKind<M>, store: MemoryStore): Library<M>;
    pool(name: string, members: readonly PoolMember[], policy: AccountPolicy): Pool;
    trigger<E, S extends string>(
      name: string,
      source: Source<E, S>,
      effect: (event: E, act: Actions<S>) => Effect | readonly Effect[]
    ): Trigger;
    harness(name: string): Harness;

    readonly on: {
      enters<T, S extends string>(kind: Kind<T, S>, states: NoInfer<S> | readonly NoInfer<S>[]): Source<UnitEvent<T, S>, S>;
      streak<T, S extends string>(kind: Kind<T, S>, state: NoInfer<S>, count: number, group: (data: T) => string): Source<UnitEvent<T, S>, S>;
      deadline<T, S extends string>(kind: Kind<T, S>, due: (data: T) => Date, whileIn: readonly NoInfer<S>[]): Source<UnitEvent<T, S>, S>;
      cadence<T, S extends string>(kind: Kind<T, S>, cadence: Cadence, whileIn: readonly NoInfer<S>[]): Source<UnitEvent<T, S>, S>;
      crossing(options: CrossingOptions): Source<CrossingEvent, never>;
    };

    readonly policy: {
      model(name: string, decide: (choice: ModelChoice) => Model): ModelPolicy;
      account(name: string, decide: (choice: AccountChoice) => Account | null): AccountPolicy;
      scheduler(name: string, decide: (view: SchedulerView) => ScheduleDecision): SchedulerPolicy;
      recall(name: string, decide: (view: RecallView) => readonly Recalled[]): RecallPolicy;
      retry(name: string, decide: (view: RetryView) => RetryDecision): RetryPolicy;
      rule<I, O>(name: string, decide: (input: I, metrics: Metrics) => O): RulePolicy<I, O>;
    };

    calendar<T, S extends string>(
      name: string,
      kind: Kind<T, S>,
      cadence: Cadence,
      produce: (tick: { readonly now: Date; readonly units: readonly UnitView<T, S>[] }) => readonly Supply<T, S>[]
    ): Supplier<T, S>;
    readonly operator: Supplier<never, never>;

    readonly ops: {
      readonly readWork: Operation;
      readonly writeWork: Operation;
      readonly resolveHalts: Operation;
      readonly readMemory: Operation;
      readonly writeMemory: Operation;
      readonly curateMemory: Operation;
      readonly readTelemetry: Operation;
      readonly readAccounts: Operation;
      readonly setShares: Operation;
    };
    operation<I, O>(name: string, executable: Executable<I, O>): Operation;

    env(name: string): Ref<string>;
    readonly slot: { port(index: number): Ref<number> };
  }

  export const H: Dsl;
}

declare module 'harness-dsl/claude-code' {
  import type { Account, Model, Guard, Client, Operation, Ref, Executable } from 'harness-dsl/kernel';
  export function subscription(name: string, options: { readonly token: Ref<string> }): Account;
  export function model(id: string): Model;
  export function fileLeases(): Guard;
  export function stopCheck(check: Executable<void, unknown>): Guard;
  export function supervisor(options: { readonly grants: readonly Operation[] }): Client;
}

declare module 'harness-dsl/anthropic' {
  import type { Account, Model, Ref } from 'harness-dsl/kernel';
  export function account(name: string, options: { readonly apiKey: Ref<string> }): Account;
  export function model(id: string): Model;
}

declare module 'harness-dsl/linear' {
  import type { Kind, Supplier, Store, Ref } from 'harness-dsl/kernel';
  export interface Issue {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly description: string;
    readonly labels: readonly string[];
    readonly status: string;
    readonly parentId?: string;
  }
  export function tracker<T, S extends string>(
    kind: Kind<T, S>,
    options: {
      readonly apiKey: Ref<string>;
      readonly team: string;
      readonly label?: string;
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
      readonly write?: (data: NoInfer<T>, state: NoInfer<S>) => Readonly<Record<string, string | number | boolean>>;
    }
  ): Supplier<T, S> & Store<T>;
}

declare module 'harness-dsl/sqlite' {
  import type { Kind, Store, Ledger, QuotaBook } from 'harness-dsl/kernel';
  export function ledger(path: string, options?: { readonly quota?: QuotaBook }): Ledger;
  export function store<T, S extends string>(kind: Kind<T, S>, path: string): Store<T>;
  export function quota(path: string): QuotaBook;
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
    readonly headers?: Readonly<Record<string, Arg>>;
    readonly body: Schema<B>;
    readonly read: (body: B) => readonly Supply<NoInfer<T>, NoInfer<S>>[];
  }): Supplier<T, S>;
  export function store<T, S extends string>(kind: Kind<T, S>, options: {
    readonly url: string;
    readonly headers?: Readonly<Record<string, Arg>>;
    readonly stateField: string;
  }): Store<T>;
  export function control(options: {
    readonly port: Ref<number> | number;
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
