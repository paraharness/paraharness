declare module 'harness-dsl' {
  import { z } from 'zod';
  import type {
    Schema, Named, Ref, Arg, Position, Verdict, State, AnyState, NamesAt, Shape, ShapeOf, Settable, StateName,
    ShapeLists, Kind, Resource, Role, Intent, MemoryKind, MemorySort, MemoryDraft, ScopeRefs, Executable, Interrupt,
    Result, Model, Account, Runner, Guard, Supplier, Supply, Store, MemoryStore, Ledger, QuotaBook, Observer, Client,
    Operation, Policy, ModelChoice, AccountChoice, SchedulerView, ScheduleDecision, RecallView, Recalled, RetryView,
    RetryDecision, RuleView, Metrics, Rate, UnitView, TimeSpec, Interval, Running, AttemptOutcome
  } from 'harness-dsl/kernel';

  export type {
    Schema, Named, Ref, Arg, Position, Verdict, State, AnyState, NamesAt, Shape, ShapeOf, Settable, StateName,
    ShapeLists, Kind, Resource, Role, Intent, MemoryKind, MemorySort, MemoryDraft, ScopeRefs, Executable, Interrupt,
    Result, Model, Account, Runner, Guard, Supplier, Supply, Store, MemoryStore, Ledger, QuotaBook, Observer, Client,
    Operation, Policy, ModelChoice, AccountChoice, SchedulerView, ScheduleDecision, RecallView, Recalled, RetryView,
    RetryDecision, RuleView, Metrics, Rate, UnitView, TimeSpec, Interval, Running, AttemptOutcome
  } from 'harness-dsl/kernel';
  export type {
    PendingView, ActiveView, AccountView, Mean, EntryFilter, LedgerEntry, Condition, Window
  } from 'harness-dsl/kernel';

  export type SupplyOf<K> = K extends Kind<infer T, infer Sh extends Shape> ? Supply<T, Sh> : never;

  export interface KindDraft {
    data<T>(schema: Schema<T>): KindData<T>;
  }
  export interface KindData<T> {
    states<St extends AnyState>(
      states: readonly St[],
      options: {
        readonly initial: NoInfer<NamesAt<St, 'pending'>>;
        readonly afterFailure: NoInfer<Settable<ShapeOf<St>>>;
      }
    ): Kind<T, ShapeOf<St>>;
  }

  export interface ResourceGroup<N extends string> extends Named {
    readonly entity: 'resource-group';
    readonly schema: Schema<N>;
    readonly all: readonly Resource[];
    get(name: N): Resource;
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

  export interface Library extends Named {
    readonly entity: 'library';
    readonly memory: MemoryKind;
    readonly store: MemoryStore;
    recall(policy: RecallPolicy): Library;
  }

  export interface AgentDraft<I, O> {
    model(choice: Model | ModelPolicy): Agent<I, O>;
  }
  export interface Agent<I, O> extends Executable<I, O> {
    readonly entity: 'agent';
    readonly role: Role<I, O>;
    on(...runners: readonly Runner[]): Agent<I, O>;
    recalls(...libraries: readonly Library[]): Agent<I, O>;
    records(library: Library): Agent<I, O>;
    guards(...guards: readonly Guard[]): Agent<I, O>;
    ifInterrupted(mode: Interrupt): Agent<I, O>;
  }

  export interface Command<I, O> extends Executable<I, O> {
    readonly entity: 'command';
    input<I2>(schema: Schema<I2>): Command<I2, O>;
    output<O2>(schema: Schema<O2>): Command<I, O2>;
    argv(render: (input: I) => readonly Arg[]): Command<I, O>;
    on(...runners: readonly Runner[]): Command<I, O>;
    ifInterrupted(mode: 'rerun' | 'park'): Command<I, O>;
    ifInterrupted(mode: 'ask', check: Executable<I, boolean>): Command<I, O>;
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
    readonly resources?: readonly Resource[];
  }
  export interface RunOptions {
    readonly step?: string;
    readonly retry?: RetryPolicy;
    readonly timeoutMs?: number;
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

  export interface Wait<Sh extends Shape> {
    readonly entity: 'wait';
    readonly rest: Sh['waiting'];
    readonly then: Sh['pending'];
    readonly at?: Date;
    readonly children?: true;
  }
  export type Rest<Sh extends Shape> = Settable<Sh> | Wait<Sh>;

  export interface FlowContext<T, Sh extends Shape, P> {
    readonly unit: UnitView<T, Sh>;
    readonly params: P;
    now(): Date;
    run<I, O>(executable: Executable<I, O>, ...args: RunArgs<I>): Promise<Result<O>>;
    batch<I, O>(agent: Agent<I, O>, inputs: readonly I[], options?: RunOptions): Promise<readonly Result<O>[]>;
    move(state: Sh['active']): Promise<void>;
    update(patch: Partial<T>): Promise<void>;
    tag(tags: Readonly<Record<string, string>>): void;
    halt<D>(request: HaltRequest<D>): Promise<D>;
    decide<I, O>(rule: RulePolicy<I, O>, input: I): Promise<O>;
    remember(library: Library, draft: MemoryDraft): Promise<void>;
    spawn<T2, Sh2 extends Shape>(lane: Lane<T2, Sh2>, data: readonly T2[]): Promise<readonly string[]>;
    children(): Promise<readonly UnitView<unknown, Shape>[]>;
    wait(rest: Sh['waiting'], wake: { readonly at?: Date; readonly children?: true; readonly then: Sh['pending'] }): Wait<Sh>;
    fail(reason: string): never;
  }

  export type Common<A extends Shape, B extends Shape> = {
    readonly pending: A['pending'] & B['pending'];
    readonly active: A['active'] & B['active'];
    readonly waiting: A['waiting'] & B['waiting'];
    readonly terminal: A['terminal'] & B['terminal'];
  };

  export interface FlowDraft {
    for<T1, A extends Shape>(k1: Kind<T1, A>): FlowShape<T1, A, void>;
    for<T1, A extends Shape, T2, B extends Shape>(k1: Kind<T1, A>, k2: Kind<T2, B>): FlowShape<T1 | T2, Common<A, B>, void>;
    for<T1, A extends Shape, T2, B extends Shape, T3, C extends Shape>(
      k1: Kind<T1, A>, k2: Kind<T2, B>, k3: Kind<T3, C>
    ): FlowShape<T1 | T2 | T3, Common<Common<A, B>, C>, void>;
  }
  export interface FlowShape<T, Sh extends Shape, P> {
    params<P2>(schema: Schema<P2>): FlowShape<T, Sh, P2>;
    does(body: (ctx: FlowContext<T, Sh, P>) => Promise<Rest<Sh>>): Flow<T, Sh, P>;
  }
  export interface Flow<T, Sh extends Shape, P> extends Named {
    readonly entity: 'flow';
    readonly accepts: (data: T) => void;
    readonly shape: ShapeLists<Sh>;
    readonly params?: Schema<P>;
  }

  export interface LaneDraft<T, Sh extends Shape> {
    handler(flow: Flow<T, Sh, void>): Lane<T, Sh>;
    handler<P>(flow: Flow<T, Sh, P>, params: P): Lane<T, Sh>;
  }
  export interface LaneRef extends Named {
    readonly entity: 'lane';
  }
  export interface Lane<T, Sh extends Shape> extends LaneRef {
    readonly kind: Kind<T, Sh>;
    suppliers(...suppliers: readonly Supplier<T, Sh>[]): Lane<T, Sh>;
    store(store: Store<T>): Lane<T, Sh>;
    touches(resources: (data: T) => readonly Resource[]): Lane<T, Sh>;
    wip(limit: number): Lane<T, Sh>;
    maxUsdPerUnit(limit: number): Lane<T, Sh>;
  }

  export interface UnitEvent<T, Sh extends Shape> {
    readonly unit: UnitView<T, Sh>;
    readonly at: Date;
    readonly attempt?: {
      readonly id: string;
      readonly outcome: AttemptOutcome;
      readonly durationMs: number;
      readonly costUsd: number;
    };
    readonly streak?: number;
  }
  export interface MetricEvent {
    readonly group: string;
    readonly edge: 'entered' | 'exited';
    readonly rate: Rate;
    readonly at: Date;
  }

  export interface Effect {
    readonly entity: 'effect';
    readonly does: 'create' | 'move' | 'pause' | 'resume' | 'remember';
  }
  export interface Actions {
    create<T2, Sh2 extends Shape>(lane: Lane<T2, Sh2>, data: T2, key?: string): Effect;
    moveUnit<T2, Sh2 extends Shape>(lane: Lane<T2, Sh2>, key: string, state: Settable<Sh2>): Effect;
    pause(lane: LaneRef): Effect;
    resume(lane: LaneRef): Effect;
    remember(library: Library, draft: MemoryDraft): Effect;
  }
  export interface UnitActions<Sh extends Shape> extends Actions {
    move(state: Settable<Sh>): Effect;
  }

  export interface Source<E, A> {
    readonly entity: 'source';
    readonly on: 'enters' | 'streak' | 'deadline' | 'time' | 'metric';
    readonly kind?: string;
    readonly event?: E;
    readonly actions?: A;
  }
  export interface Trigger extends Named {
    readonly entity: 'trigger';
  }

  export interface MetricCrossing {
    readonly every: Interval;
    readonly read: (metrics: Metrics, now: Date) => Readonly<Record<string, Rate>>;
    readonly enter: (rate: Rate) => boolean;
    readonly exit: (rate: Rate) => boolean;
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
    state<N extends string, P extends 'pending' | 'active' | 'waiting'>(name: N, position: P): State<N, P>;
    state<N extends string>(name: N, position: 'terminal', verdict: Verdict): State<N, 'terminal'>;
    kind(name: string): KindDraft;
    resources<N extends string>(group: string, names: readonly N[]): ResourceGroup<N>;
    role(name: string): RoleDraft;
    memory(name: string, sort: MemorySort): MemoryKind;

    agent<I, O>(name: string, role: Role<I, O>): AgentDraft<I, O>;
    command(name: string): Command<void, string>;
    flow(name: string): FlowDraft;

    lane<T, Sh extends Shape>(name: string, kind: Kind<T, Sh>): LaneDraft<T, Sh>;
    library(name: string, memory: MemoryKind, store: MemoryStore): Library;
    pool(name: string, members: readonly PoolMember[], policy: AccountPolicy): Pool;
    trigger<E, A>(name: string, source: Source<E, A>, effect: (event: E, act: A) => Effect | readonly Effect[]): Trigger;
    harness(name: string): Harness;

    readonly on: {
      enters<T, Sh extends Shape>(kind: Kind<T, Sh>, states: NoInfer<StateName<Sh>> | readonly NoInfer<StateName<Sh>>[]): Source<UnitEvent<T, Sh>, UnitActions<Sh>>;
      streak<T, Sh extends Shape>(kind: Kind<T, Sh>, state: NoInfer<StateName<Sh>>, count: number, group: (data: T) => string): Source<UnitEvent<T, Sh>, UnitActions<Sh>>;
      deadline<T, Sh extends Shape>(kind: Kind<T, Sh>, due: (data: T) => Date, whileIn: readonly NoInfer<StateName<Sh>>[]): Source<UnitEvent<T, Sh>, UnitActions<Sh>>;
      time<T, Sh extends Shape>(kind: Kind<T, Sh>, at: TimeSpec, whileIn: readonly NoInfer<StateName<Sh>>[]): Source<UnitEvent<T, Sh>, UnitActions<Sh>>;
      metric(crossing: MetricCrossing): Source<MetricEvent, Actions>;
    };

    readonly policy: {
      model(name: string, decide: (choice: ModelChoice) => Model): ModelPolicy;
      account(name: string, decide: (choice: AccountChoice) => Account | null): AccountPolicy;
      scheduler(name: string, decide: (view: SchedulerView) => ScheduleDecision): SchedulerPolicy;
      recall(name: string, decide: (view: RecallView) => readonly Recalled[]): RecallPolicy;
      retry(name: string, decide: (view: RetryView) => RetryDecision): RetryPolicy;
      rule<I, O>(name: string, decide: (input: I, metrics: Metrics) => O): RulePolicy<I, O>;
    };

    calendar<T, Sh extends Shape>(
      name: string,
      kind: Kind<T, Sh>,
      at: TimeSpec,
      produce: (tick: { readonly now: Date; readonly units: readonly UnitView<T, Sh>[] }) => readonly Supply<T, Sh>[]
    ): Supplier<T, Sh>;
    readonly operator: Supplier<never, never>;

    readonly ops: {
      readonly readWork: Operation;
      readonly writeWork: Operation;
      readonly resolveHalts: Operation;
      readonly manageAttempts: Operation;
      readonly readMemory: Operation;
      readonly writeMemory: Operation;
      readonly curateMemory: Operation;
      readonly readTelemetry: Operation;
      readonly readAccounts: Operation;
      readonly setShares: Operation;
    };
    operation<I, O>(name: string, executable: Executable<I, O>): Operation;

    env(name: string): Ref<string>;
  }

  export const H: Dsl;
  export type InferSchema<S extends z.ZodType> = z.infer<S>;
}

declare module 'harness-dsl/claude-code' {
  import type { Account, Model, Guard, Client, Operation, Ref, QuotaBook, Executable } from 'harness-dsl/kernel';
  export function subscription(name: string, options: { readonly token: Ref<string>; readonly quota: QuotaBook }): Account;
  export function model(id: string): Model;
  export function fileLeases(): Guard;
  export function stopCheck(check: Executable<void, unknown>): Guard;
  export function supervisor(options: { readonly grants: readonly Operation[] }): Client;
}

declare module 'harness-dsl/anthropic' {
  import type { Account, Model, Ref, QuotaBook } from 'harness-dsl/kernel';
  export function account(name: string, options: { readonly apiKey: Ref<string>; readonly quota?: QuotaBook }): Account;
  export function model(id: string): Model;
}

declare module 'harness-dsl/linear' {
  import type { Kind, Shape, StateName, Supplier, Store, Ref } from 'harness-dsl/kernel';
  export interface Issue {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly description: string;
    readonly labels: readonly string[];
    readonly status: string;
    readonly parentId?: string;
  }
  export function tracker<T, Sh extends Shape>(
    kind: Kind<T, Sh>,
    options: {
      readonly apiKey: Ref<string>;
      readonly team: string;
      readonly label?: string;
      readonly read: (issue: Issue) => NoInfer<T>;
      readonly statuses: Readonly<Record<NoInfer<StateName<Sh>>, string>>;
    }
  ): Supplier<T, Sh> & Store<T>;
}

declare module 'harness-dsl/folder' {
  import type { Kind, Shape, StateName, Supplier, Store } from 'harness-dsl/kernel';
  export interface MarkdownFile {
    readonly path: string;
    readonly frontmatter: Readonly<Record<string, unknown>>;
    readonly body: string;
  }
  export function files<T, Sh extends Shape>(
    kind: Kind<T, Sh>,
    options: {
      readonly dir: string;
      readonly read: (file: MarkdownFile) => NoInfer<T>;
      readonly write?: (data: NoInfer<T>, state: NoInfer<StateName<Sh>>) => Readonly<Record<string, string | number | boolean>>;
    }
  ): Supplier<T, Sh> & Store<T>;
}

declare module 'harness-dsl/sqlite' {
  import type { Kind, Shape, Store, Ledger, QuotaBook } from 'harness-dsl/kernel';
  export function ledger(path: string): Ledger;
  export function store<T, Sh extends Shape>(kind: Kind<T, Sh>, path: string): Store<T>;
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
  import type { Runner, Resource } from 'harness-dsl/kernel';
  export function local(name: string, options: { readonly slots: number; readonly hosts?: readonly Resource[] }): Runner;
}

declare module 'harness-dsl/ssh' {
  import type { Runner, Ref, Resource } from 'harness-dsl/kernel';
  export function host(name: string, options: {
    readonly address: string;
    readonly user: string;
    readonly key: Ref<string>;
    readonly slots: number;
    readonly hosts?: readonly Resource[];
    readonly preflight?: readonly string[];
  }): Runner;
}

declare module 'harness-dsl/http' {
  import type { Kind, Shape, Supplier, Supply, Store, Client, Operation, Ref, Arg, Schema, Interval } from 'harness-dsl/kernel';
  export function webhook<T, Sh extends Shape, B>(kind: Kind<T, Sh>, options: {
    readonly path: string;
    readonly secret: Ref<string>;
    readonly body: Schema<B>;
    readonly read: (body: B) => Supply<NoInfer<T>, NoInfer<Sh>> | null;
  }): Supplier<T, Sh>;
  export function poll<T, Sh extends Shape, B>(kind: Kind<T, Sh>, options: {
    readonly url: string;
    readonly every: Interval;
    readonly headers?: Readonly<Record<string, Arg>>;
    readonly body: Schema<B>;
    readonly read: (body: B) => readonly Supply<NoInfer<T>, NoInfer<Sh>>[];
  }): Supplier<T, Sh>;
  export function store<T, Sh extends Shape>(kind: Kind<T, Sh>, options: {
    readonly url: string;
    readonly headers?: Readonly<Record<string, Arg>>;
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
