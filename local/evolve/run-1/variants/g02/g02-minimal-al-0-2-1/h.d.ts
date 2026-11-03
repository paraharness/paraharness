declare module 'harness-dsl' {
  import type {
    Position, Verdict, State, Ref, Arg, Schema, Named, Kind, KindRef, LaneRef, TriggerRef, DecisionRef, AgentRef,
    Role, Intent, MemoryKind, MemorySort, MemoryDraft, Recalled, RecallView,
    Executable, Result, Model, Account, Runner, Guard, Supplier, Supply, Store, MemoryStore, Ledger,
    Observer, Client, Operation, Policy, ModelChoice, AccountChoice, SchedulerView, ScheduleDecision,
    RetryView, RetryDecision, Metrics, Rate, UnitView, TimeSpec, Running, Recovery, Failed, Dimension,
    EntryFilter, Ask, Resolver
  } from 'harness-dsl/kernel';

  export type {
    Position, Verdict, State, Ref, Arg, Schema, Named, Kind, KindRef, LaneRef, TriggerRef, DecisionRef, AgentRef,
    Role, Intent, MemoryKind, MemorySort, MemoryDraft, Recalled, RecallView,
    Executable, Result, Model, Account, Runner, Guard, Supplier, Supply, Store, MemoryStore, Ledger,
    Observer, Client, Operation, Policy, ModelChoice, AccountChoice, SchedulerView, ScheduleDecision,
    RetryView, RetryDecision, Metrics, Rate, UnitView, TimeSpec, Running, Recovery, Failed, Dimension,
    EntryFilter, Ask, Resolver
  } from 'harness-dsl/kernel';
  export type { PendingView, ActiveView, AccountView, RunnerView, Mean, LedgerEntry, Interval } from 'harness-dsl/kernel';

  export type SupplyOf<K> = K extends Kind<infer T, infer S extends string> ? Supply<T, S> : never;

  export type StateName<X> = X extends State<infer N extends string, Position> ? N : never;
  export type PendingName<X> = X extends State<infer N extends string, 'pending'> ? N : never;

  export interface KindDraft {
    data<T>(schema: Schema<T>): KindData<T>;
  }
  export interface KindData<T> {
    states<I extends string, St extends readonly State<string, Position>[]>(
      initial: State<I, 'pending'>,
      ...others: St
    ): KindDescriptor<T, I | StateName<St[number]>, I | PendingName<St[number]>>;
  }
  export interface KindDescriptor<T, S extends string, Pd extends string> extends Kind<T, S, Pd> {
    onFailure(state: NoInfer<S>, options?: { readonly afterAttempts: number }): KindDescriptor<T, S, Pd>;
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
  export type RetryPolicy = Policy<RetryView, RetryDecision>;
  export type RecallPolicy = Policy<RecallView, readonly Recalled[]>;

  export type Match<O> = O extends object ? { readonly [K in keyof O]?: O[K] } : O;

  export interface DecisionDraft {
    input<I>(schema: Schema<I>): DecisionInput<I>;
  }
  export interface DecisionInput<I> {
    output<O>(schema: Schema<O>): Decision<I, O>;
  }
  export interface Decision<I, O> extends DecisionRef {
    readonly inputSchema: Schema<I>;
    readonly outputSchema: Schema<O>;
    show(render: (input: I) => string): Decision<I, O>;
    policy(decide: (input: I, metrics: Metrics, self: Decision<I, O>) => O | Ask): Decision<I, O>;
    resolved(match?: Match<O>, by?: Resolver): EntryFilter;
  }

  export interface Library extends Named {
    readonly entity: 'library';
    readonly memory: MemoryKind;
    readonly store: MemoryStore;
  }

  export interface AgentDraft<I, O> {
    model(choice: Model | ModelPolicy): Agent<I, O>;
  }
  export interface Agent<I, O> extends Executable<I, O>, AgentRef {
    readonly entity: 'agent';
    readonly role: Role<I, O>;
    on(runner: Runner): Agent<I, O>;
    recalls(...libraries: readonly Library[]): Agent<I, O>;
    recall(policy: RecallPolicy): Agent<I, O>;
    records(library: Library): Agent<I, O>;
    guards(...guards: readonly Guard[]): Agent<I, O>;
  }

  export interface Command<I, O> extends Executable<I, O> {
    readonly entity: 'command';
    input<I2>(schema: Schema<I2>): Command<I2, O>;
    output<O2>(schema: Schema<O2>): Command<I, O2>;
    argv(render: (input: I) => readonly Arg[]): Command<I, O>;
    on(...runners: readonly Runner[]): Command<I, O>;
    recover(recovery: Recovery<I>): Command<I, O>;
  }

  export interface PoolMember {
    readonly account: Account;
    readonly share: number;
  }
  export interface Pool extends Named {
    readonly entity: 'pool';
    readonly members: readonly PoolMember[];
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

  export interface Until<S extends string> {
    readonly rest: S;
    readonly then: S;
  }

  export interface FlowContext<T, S extends string, P> {
    readonly unit: UnitView<T, S>;
    readonly params: P;
    now(): Date;
    run<I, O>(executable: Executable<I, O>, ...args: RunArgs<I>): Promise<Result<O>>;
    batch<I, O>(agent: Agent<I, O>, inputs: readonly I[]): Promise<readonly Result<O>[]>;
    decide<I, O>(decision: Decision<I, O>, input: I): Promise<O>;
    move(state: S): Promise<void>;
    update(patch: Partial<T>): Promise<void>;
    remember(library: Library, draft: MemoryDraft): Promise<void>;
    spawn<T2, S2 extends string, P2 extends string>(lane: Lane<T2, S2, P2>, data: readonly T2[]): Promise<void>;
    children(): Promise<readonly UnitView<unknown, string>[]>;
    until(rest: S, wake: { readonly at?: Date; readonly children?: true; readonly then: S }): Until<S>;
    fail(reason: string): Failed;
  }

  export interface FlowDraft {
    for<T1, S1 extends string>(k1: Kind<T1, S1>): FlowShape<T1, S1, void>;
    for<T1, S1 extends string, T2, S2 extends string>(k1: Kind<T1, S1>, k2: Kind<T2, S2>): FlowShape<T1 | T2, S1 & S2, void>;
  }
  export interface FlowShape<T, S extends string, P> {
    params<P2>(schema: Schema<P2>): FlowShape<T, S, P2>;
    does(body: (ctx: FlowContext<T, S, P>) => Promise<S | Until<S> | Failed>): Flow<T, S, P>;
  }
  export interface Flow<T, S extends string, P> extends Named {
    readonly entity: 'flow';
    readonly kinds: readonly string[];
    readonly states: readonly S[];
    readonly accepts: (data: T) => void;
    readonly params?: Schema<P>;
  }

  export interface LaneDraft<T, S extends string, Pd extends string> {
    handler(flow: Flow<T, S, void>): Lane<T, S, Pd>;
    handler<P>(flow: Flow<T, S, P>, params: P): Lane<T, S, Pd>;
    handler(byState: { readonly [K in Pd]?: Flow<T, S, void> }): Lane<T, S, Pd>;
  }
  export interface Lane<T, S extends string, Pd extends string> extends LaneRef {
    readonly kind: Kind<T, S, Pd>;
    suppliers(...suppliers: readonly Supplier<T, S>[]): Lane<T, S, Pd>;
    store(store: Store<T>): Lane<T, S, Pd>;
    wip(limit: number): Lane<T, S, Pd>;
    maxUsdPerUnit(limit: number): Lane<T, S, Pd>;
  }

  export interface UnitSource<T, S extends string> {
    readonly entity: 'source';
    readonly kind: Kind<T, S>;
    readonly on: 'enters' | 'streak' | 'deadline';
  }
  export type Bound = { readonly below: number } | { readonly above: number };
  export interface Bounds {
    readonly trip: Bound;
    readonly reset: Bound;
    readonly minSamples: number;
  }
  export interface MetricSource {
    readonly entity: 'source';
    readonly on: 'metric';
    readonly grouped: boolean;
  }

  export interface UnitEvent<T, S extends string> {
    readonly unit: UnitView<T, S>;
    readonly at: Date;
    readonly attempt?: { readonly id: string; readonly durationMs: number; readonly costUsd: number };
  }
  export interface MetricEvent {
    readonly group?: string;
    readonly rate: Rate;
    readonly state: 'tripped' | 'reset';
    readonly at: Date;
  }
  export interface GroupEvent extends MetricEvent {
    readonly group: string;
  }

  export interface Effect {
    readonly entity: 'effect';
    readonly does: 'create' | 'move' | 'remember' | 'pause' | 'resume';
  }
  export interface Actions {
    create<T2, S2 extends string, P2 extends string>(lane: Lane<T2, S2, P2>, data: T2, key?: string): Effect;
    move<T2, S2 extends string, P2 extends string>(lane: Lane<T2, S2, P2>, key: string, state: NoInfer<S2>): Effect;
    remember(library: Library, draft: MemoryDraft): Effect;
    pause(lane: LaneRef): Effect;
    resume(lane: LaneRef): Effect;
  }
  export interface UnitActions<S extends string> extends Actions {
    move(state: S): Effect;
    move<T2, S2 extends string, P2 extends string>(lane: Lane<T2, S2, P2>, key: string, state: NoInfer<S2>): Effect;
  }
  export interface Trigger extends TriggerRef {
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
    state<N extends string, P extends 'pending' | 'active' | 'waiting'>(name: N, position: P): State<N, P>;
    state<N extends string>(name: N, position: 'terminal', verdict: Verdict): State<N, 'terminal'>;
    kind(name: string): KindDraft;
    role(name: string): RoleDraft;
    memory(name: string, sort: MemorySort): MemoryKind;
    decision(name: string): DecisionDraft;

    agent<I, O>(name: string, role: Role<I, O>): AgentDraft<I, O>;
    command(name: string): Command<void, string>;
    flow(name: string): FlowDraft;

    lane<T, S extends string, Pd extends string>(name: string, kind: Kind<T, S, Pd>): LaneDraft<T, S, Pd>;
    library(name: string, memory: MemoryKind, store: MemoryStore): Library;
    pool(name: string, members: readonly PoolMember[], policy?: AccountPolicy): Pool;
    trigger<T, S extends string>(
      name: string,
      source: UnitSource<T, S>,
      effect: (event: UnitEvent<T, S>, act: UnitActions<S>) => Effect | readonly Effect[]
    ): Trigger;
    trigger(
      name: string,
      source: MetricSource & { readonly grouped: true },
      effect: (event: GroupEvent, act: Actions) => Effect | readonly Effect[]
    ): Trigger;
    trigger(
      name: string,
      source: MetricSource,
      effect: (event: MetricEvent, act: Actions) => Effect | readonly Effect[]
    ): Trigger;
    harness(name: string): Harness;

    readonly on: {
      enters<T, S extends string>(kind: Kind<T, S>, states: NoInfer<S> | readonly NoInfer<S>[]): UnitSource<T, S>;
      streak<T, S extends string>(kind: Kind<T, S>, state: NoInfer<S>, count: number, group: (data: T) => string): UnitSource<T, S>;
      deadline<T, S extends string>(kind: Kind<T, S>, due: (data: T) => Date, whileIn: readonly NoInfer<S>[]): UnitSource<T, S>;
      metric(read: (metrics: Metrics) => Rate, bounds: Bounds): MetricSource & { readonly grouped: false };
      metricBy(read: (metrics: Metrics) => Readonly<Record<string, Rate>>, bounds: Bounds): MetricSource & { readonly grouped: true };
    };

    readonly by: {
      model(agent?: AgentRef): Dimension;
      input<I, O, K extends keyof I & string>(decision: Decision<I, O>, key: K): Dimension;
      data<T, S extends string, K extends keyof T & string>(kind: Kind<T, S>, key: K): Dimension;
      readonly resolver: Dimension;
      readonly group: Dimension;
    };

    readonly policy: {
      model(name: string, decide: (choice: ModelChoice) => Model): ModelPolicy;
      account(name: string, decide: (choice: AccountChoice) => Account | null): AccountPolicy;
      scheduler(name: string, decide: (view: SchedulerView) => ScheduleDecision): SchedulerPolicy;
      retry(name: string, decide: (view: RetryView) => RetryDecision): RetryPolicy;
      recall(name: string, decide: (view: RecallView) => readonly Recalled[]): RecallPolicy;
    };

    readonly ask: Ask;

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
      readonly resolveDecisions: Operation;
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
  export function ledger(path: string, options?: { readonly sharedQuota: string }): Ledger;
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
  import type { Observer, Ref, LedgerEntry, EntryFilter } from 'harness-dsl/kernel';
  export function notify(options: {
    readonly webhook: Ref<string>;
    readonly among: EntryFilter;
    readonly message: (entry: LedgerEntry) => string;
  }): Observer;
}
