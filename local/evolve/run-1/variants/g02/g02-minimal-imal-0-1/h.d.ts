declare module 'harness-dsl' {
  import type {
    Schema, Named, Kind, State, StatePosition, Role, Intent, MemoryKind, Trust, Resource,
    Executable, RestartRule, Result, Model, Account, Runner, Guard, Supplier, Supply, Store, MemoryStore, Ledger,
    Observer, Client, Operation, Policy, ModelChoice, AccountChoice, SchedulerView, ScheduleDecision,
    RecallView, Recalled, RetryView, RetryDecision, RuleView, Metrics, Rate, UnitView, TimeSpec, Running, Ref, Arg
  } from 'harness-dsl/kernel';

  export type {
    Metrics, Model, Account, PendingView, ActiveView, Rate, Supply, LedgerEntry, Kind, Resource
  } from 'harness-dsl/kernel';

  export type SupplyOf<K> = K extends Kind<infer T, infer S extends string> ? Supply<T, S> : never;

  export interface KindDraft {
    data<T>(schema: Schema<T>): KindData<T>;
  }
  export interface KindData<T> {
    states<S extends string>(states: readonly State<S>[], initial: NoInfer<S>): KindDescriptor<T, S>;
  }
  export interface KindDescriptor<T, S extends string> extends Kind<T, S> {
    failsTo(state: S): KindDescriptor<T, S>;
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
    on(runner: Runner): Agent<I, O>;
    recalls(...libraries: readonly Library[]): Agent<I, O>;
    records(library: Library): Agent<I, O>;
    guards(...guards: readonly Guard[]): Agent<I, O>;
  }

  export interface Command<I, O> extends Executable<I, O> {
    readonly entity: 'command';
    input<I2>(schema: Schema<I2>): Command<I2, O>;
    output<O2>(schema: Schema<O2>): Command<I, O2>;
    argv(render: (input: I) => readonly Arg[]): Command<I, O>;
    on(runner: Runner | ((input: I) => Runner)): Command<I, O>;
    restart(rule: RestartRule<I>): Command<I, O>;
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

  export interface KindRef extends Named {
    readonly entity: 'kind';
  }
  export interface RoleRef extends Named {
    readonly entity: 'role';
  }
  export interface RecallScope {
    readonly skills?: readonly string[];
    readonly resources?: readonly Resource[];
  }
  export interface When extends RecallScope {
    readonly kinds?: readonly KindRef[];
    readonly roles?: readonly RoleRef[];
  }
  export interface MemoryDraft {
    readonly text: string;
    readonly because?: string;
    readonly when?: When;
    readonly status?: 'candidate' | 'accepted';
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
  export interface Failure {
    readonly failure: string;
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
    remember(library: Library, draft: MemoryDraft): Promise<void>;
    spawn<T2, S2 extends string>(lane: Lane<T2, S2>, data: readonly T2[]): Promise<void>;
    children(): Promise<readonly UnitView<unknown, string>[]>;
    until(rest: S, wake: { readonly at?: Date; readonly children?: true; readonly then: S }): Until<S>;
    fail(reason: string): Failure;
  }

  export interface FlowDraft {
    for<T1, S1 extends string>(k1: Kind<T1, S1>): FlowShape<T1, S1, void>;
    for<T1, S1 extends string, T2, S2 extends string>(k1: Kind<T1, S1>, k2: Kind<T2, S2>): FlowShape<T1 | T2, S1 & S2, void>;
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
    readonly on: 'enters' | 'streak' | 'deadline' | 'time' | 'threshold';
    readonly emits?: E;
    readonly moves?: S;
  }
  export interface UnitEvent<T, S extends string> {
    readonly unit: UnitView<T, S>;
    readonly at: Date;
    readonly attempt?: { readonly id: string; readonly durationMs: number; readonly costUsd: number };
    readonly streak?: number;
  }
  export interface ThresholdEvent {
    readonly group: string;
    readonly rate: Rate;
    readonly phase: 'crossed' | 'recovered';
    readonly at: Date;
  }
  export type Bound = { readonly below: number } | { readonly above: number };

  export interface Effect {
    readonly entity: 'effect';
    readonly does: 'create' | 'move' | 'remember' | 'pause' | 'resume';
  }
  export interface Actions<S extends string> {
    create<T2, S2 extends string>(
      lane: Lane<T2, S2>,
      data: T2,
      key?: string,
      tags?: Readonly<Record<string, string>>
    ): Effect;
    move(state: S): Effect;
    move<T2, S2 extends string>(lane: Lane<T2, S2>, key: string, state: S2): Effect;
    remember(library: Library, draft: MemoryDraft): Effect;
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
  }

  export interface Dsl {
    kind(name: string): KindDraft;
    state<N extends string>(name: N, position: StatePosition): State<N>;
    role(name: string): RoleDraft;
    memory(name: string, trust: Trust): MemoryKind;
    resource(name: string): Resource;

    agent<I, O>(name: string, role: Role<I, O>): AgentDraft<I, O>;
    command(name: string): Command<void, string>;
    flow(name: string): FlowDraft;

    lane<T, S extends string>(name: string, kind: Kind<T, S>): LaneDraft<T, S>;
    library(name: string, memory: MemoryKind, store: MemoryStore): Library;
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
      time<T, S extends string>(kind: Kind<T, S>, at: TimeSpec, whileIn: readonly NoInfer<S>[]): Source<UnitEvent<T, S>, S>;
      threshold(options: {
        readonly measure: (metrics: Metrics) => Readonly<Record<string, Rate>>;
        readonly crosses: Bound;
        readonly recovers: Bound;
        readonly minSamples: number;
      }): Source<ThresholdEvent, never>;
    };

    readonly policy: {
      model(name: string, decide: (choice: ModelChoice) => Model): ModelPolicy;
      account(name: string, decide: (choice: AccountChoice) => Account | null): AccountPolicy;
      scheduler(name: string, decide: (view: SchedulerView) => ScheduleDecision): SchedulerPolicy;
      recall(name: string, decide: (view: RecallView) => readonly Recalled[]): RecallPolicy;
      retry(name: string, decide: (view: RetryView) => RetryDecision): RetryPolicy;
      rule<I, O>(name: string, decide: (input: I, metrics: Metrics) => O): RulePolicy<I, O>;
    };

    timetable<T, S extends string>(
      name: string,
      kind: Kind<T, S>,
      at: TimeSpec,
      produce: (tick: { readonly now: Date; readonly units: readonly UnitView<T, S>[] }) => readonly Supply<T, S>[]
    ): Supplier<T, S>;
    readonly operator: Supplier<never, never>;

    readonly ops: {
      readonly readWork: Operation;
      readonly writeWork: Operation;
      readonly resolveHalts: Operation;
      readonly readMemory: Operation;
      readonly writeMemory: Operation;
      readonly readTelemetry: Operation;
      readonly readAccounts: Operation;
      readonly setShares: Operation;
    };
    operation<I, O>(name: string, executable: Executable<I, O>): Operation;

    env(name: string): Ref<string>;
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
      readonly write?: (data: NoInfer<T>, state: NoInfer<S>) => Readonly<Record<string, string | number | boolean>>;
    }
  ): Supplier<T, S> & Store<T>;
}

declare module 'harness-dsl/sqlite' {
  import type { Kind, Store, Ledger } from 'harness-dsl/kernel';
  export function ledger(path: string, options?: { readonly sharedQuota?: string }): Ledger;
  export function store<T, S extends string>(kind: Kind<T, S>, path: string): Store<T>;
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
