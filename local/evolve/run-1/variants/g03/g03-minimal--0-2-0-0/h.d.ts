declare module 'harness-dsl' {
  import type {
    Position, Verdict, State, Ref, Arg, Schema, Named, Kind, KindRef, LaneRef, TriggerRef, HaltRef, TagRef, TagMatch,
    RoleRef, Role, Intent, MemoryKind, MemorySort, MemoryDraft, MemoryItem, ItemDraft, Scope, ScopeRecord, Recalled,
    RecallView, Executable, Result, AgentResult, Model, ModelRef, Account, Runner, Guard, Supplier, Supply, Store,
    MemoryStore, Ledger, QuotaPartition, Observer, Client, Operation, Policy, ModelChoice, AccountChoice, SchedulerView,
    ScheduleDecision, RetryView, RetryDecision, Metrics, Rate, Grouped, Mean, Total, UnitView, TimeSpec, Running,
    Recovery, CommandRecovery, Failed, EntryFilter, EntryType, EntryOf, PendingView, ActiveView, AccountView,
    LedgerEntry, Interval
  } from 'harness-dsl/kernel';

  export type {
    Position, Verdict, State, Ref, Arg, Schema, Named, Kind, KindRef, LaneRef, TriggerRef, HaltRef, TagRef, TagMatch,
    RoleRef, Role, Intent, MemoryKind, MemorySort, MemoryDraft, MemoryItem, ItemDraft, Scope, ScopeRecord, Recalled,
    RecallView, Executable, Result, AgentResult, Model, ModelRef, Account, Runner, Guard, Supplier, Supply, Store,
    MemoryStore, Ledger, QuotaPartition, Observer, Client, Operation, Policy, ModelChoice, AccountChoice, SchedulerView,
    ScheduleDecision, RetryView, RetryDecision, Metrics, Rate, Grouped, Mean, Total, UnitView, TimeSpec, Running,
    Recovery, CommandRecovery, Failed, EntryFilter, EntryType, EntryOf, PendingView, ActiveView, AccountView,
    LedgerEntry, Interval
  } from 'harness-dsl/kernel';

  export type SupplyOf<K> = K extends Kind<infer T, infer S extends string> ? Supply<T, S> : never;

  export interface KindDraft {
    data<T>(schema: Schema<T>): KindData<T>;
  }
  export interface KindData<T> {
    states<I extends string, S extends string = never>(initial: State<I>, ...others: readonly State<S>[]): KindDescriptor<T, I | S>;
  }
  export interface KindDescriptor<T, S extends string> extends Kind<T, S, never> {
    failsTo<F extends S>(first: F, ...more: readonly F[]): Kind<T, S, F>;
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
  export interface RuleView<I> {
    readonly input: I;
    readonly metrics: Metrics;
  }
  export interface RulePolicy<I, O> extends Policy<RuleView<I>, O> {
    readonly input: Schema<I>;
    readonly output: Schema<O>;
  }

  export interface Archive extends Named {
    readonly entity: 'archive';
    readonly memory: MemoryKind;
    readonly store: MemoryStore;
  }

  export interface Briefing extends Named {
    readonly entity: 'briefing';
    readonly archives: readonly Archive[];
    readonly ranking?: RecallPolicy;
  }

  export type DecisionMatch<D> = { readonly [K in keyof D]?: Extract<D[K], string | number | boolean> };

  export interface Halt<D> extends HaltRef {
    readonly decision: Schema<D>;
    raised(): EntryFilter<'halt'>;
    resolved(match?: DecisionMatch<D>): EntryFilter<'halt'>;
  }

  export interface Tag extends TagRef {
    is(value: string | Named): TagMatch;
  }

  export interface AgentDraft<I, O> {
    model(choice: Model | ModelPolicy): Agent<I, O>;
  }
  export interface Agent<I, O> extends Executable<I, O> {
    readonly entity: 'agent';
    readonly role: Role<I, O>;
    on(runner: Runner): Agent<I, O>;
    recalls(briefing: Briefing): Agent<I, O>;
    records(archive: Archive): Agent<I, O>;
    guards(...guards: readonly Guard[]): Agent<I, O>;
  }

  export interface Command<I, O> extends Executable<I, O> {
    readonly entity: 'command';
    input<I2>(schema: Schema<I2>): Command<I2, O>;
    output<O2>(schema: Schema<O2>): Command<I, O2>;
    argv(render: (input: I) => readonly Arg[]): Command<I, O>;
    on(...runners: readonly Runner[]): Command<I, O>;
    recovers(how: CommandRecovery<I>): Command<I, O>;
  }

  export interface PoolMember {
    readonly account: Account;
    readonly share: number;
  }
  export interface Pool extends Named {
    readonly entity: 'pool';
    readonly members: readonly PoolMember[];
  }

  export interface RunOptions {
    readonly retry?: RetryPolicy;
  }
  export type RunArgs<I> = [I] extends [void]
    ? [input?: undefined, options?: RunOptions]
    : [input: I, options?: RunOptions];

  export interface Wait<S extends string> {
    readonly entity: 'wait';
    readonly state: S;
    readonly then: S;
  }

  export interface FlowContext<T, S extends string, P, F extends string> {
    readonly unit: UnitView<T, S>;
    readonly params: P;
    now(): Promise<Date>;
    run<I, O>(agent: Agent<I, O>, ...args: RunArgs<I>): Promise<AgentResult<O>>;
    run<I, O>(executable: Executable<I, O>, ...args: RunArgs<I>): Promise<Result<O>>;
    batch<I, O>(agent: Agent<I, O>, inputs: readonly I[]): Promise<readonly AgentResult<O>[]>;
    move(state: S): Promise<void>;
    update(patch: Partial<T>): Promise<void>;
    tag(tag: Tag, value: string | Named): void;
    halt<D>(halt: Halt<D>, show: string): Promise<D>;
    decide<I, O>(rule: RulePolicy<I, O>, input: NoInfer<I>): Promise<O>;
    remember(archive: Archive, draft: MemoryDraft): Promise<void>;
    spawn<T2, S2 extends string>(lane: Lane<T2, S2>, data: readonly NoInfer<T2>[]): Promise<void>;
    children<T2, S2 extends string>(lane: Lane<T2, S2>): Promise<readonly UnitView<T2, S2>[]>;
    wait(state: S, wake: { readonly at?: Date; readonly children?: true; readonly then: S }): Wait<S>;
    fail(reason: string, to?: F): Failed;
  }

  export type FlowBody<T, S extends string, P, F extends string> =
    (ctx: FlowContext<T, S, P, F>) => Promise<S | Wait<S> | Failed>;

  export interface FlowDraft {
    for<T1, S1 extends string, F1 extends S1>(k1: Kind<T1, S1, F1>): FlowShape<T1, S1, void, F1>;
    for<T1, S1 extends string, F1 extends S1, T2, S2 extends string, F2 extends S2>(
      k1: Kind<T1, S1, F1>,
      k2: Kind<T2, S2, F2>
    ): FlowShape<T1 | T2, S1 & S2, void, F1 & F2>;
  }
  export interface FlowShape<T, S extends string, P, F extends string> {
    params<P2>(schema: Schema<P2>): FlowShape<T, S, P2, F>;
    does(body: FlowBody<T, S, P, F>): Flow<T, S, P, F>;
  }
  export interface Flow<T, S extends string, P, F extends string> extends Named {
    readonly entity: 'flow';
    readonly kinds: readonly string[];
    readonly states: readonly S[];
    readonly accepts: (data: T) => void;
    readonly params?: Schema<P>;
    phase(state: S, body: FlowBody<T, S, P, F>): Flow<T, S, P, F>;
  }

  export interface LaneDraft<T, S extends string> {
    handler<F extends string>(flow: Flow<T, S, void, F>): Lane<T, S>;
    handler<P, F extends string>(flow: Flow<T, S, P, F>, params: NoInfer<P>): Lane<T, S>;
  }
  export interface Lane<T, S extends string> extends LaneRef {
    readonly kind: Kind<T, S>;
    suppliers(...suppliers: readonly Supplier<T, S>[]): Lane<T, S>;
    store(store: Store<T>): Lane<T, S>;
    wip(limit: number): Lane<T, S>;
    maxUsdPerUnit(limit: number): Lane<T, S>;
    retry(policy: RetryPolicy): Lane<T, S>;
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
  export interface MetricSource<G extends string | undefined> {
    readonly entity: 'source';
    readonly on: 'metric';
    readonly group?: Tag;
    readonly accepts: (group: G) => void;
  }

  export interface UnitEvent<T, S extends string> {
    readonly unit: UnitView<T, S>;
    readonly at: Date;
    readonly attempt?: { readonly id: string; readonly durationMs: number; readonly costUsd: number };
  }
  export interface MetricEvent<G extends string | undefined> {
    readonly group: G;
    readonly rate: Rate;
    readonly state: 'tripped' | 'reset';
    readonly at: Date;
  }

  export interface Effect {
    readonly entity: 'effect';
    readonly does: 'create' | 'move' | 'remember' | 'pause' | 'resume';
  }
  export interface Actions {
    create<T2, S2 extends string>(lane: Lane<T2, S2>, data: NoInfer<T2>, key?: string): Effect;
    move<T2, S2 extends string>(lane: Lane<T2, S2>, key: string, state: NoInfer<S2>): Effect;
    remember(archive: Archive, draft: MemoryDraft): Effect;
    pause(lane: LaneRef): Effect;
    resume(lane: LaneRef): Effect;
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
    tag(name: string): Tag;

    agent<I, O>(name: string, role: Role<I, O>): AgentDraft<I, O>;
    command(name: string): Command<void, string>;
    flow(name: string): FlowDraft;

    lane<T, S extends string>(name: string, kind: Kind<T, S>): LaneDraft<T, S>;
    archive(name: string, memory: MemoryKind, store: MemoryStore): Archive;
    briefing(name: string, archives: readonly Archive[], ranking?: RecallPolicy): Briefing;
    pool(name: string, members: readonly PoolMember[], policy?: AccountPolicy): Pool;
    trigger<T, S extends string>(
      name: string,
      source: UnitSource<T, S>,
      effect: (event: UnitEvent<T, S>, act: UnitActions<S>) => Effect | readonly Effect[]
    ): Trigger;
    trigger<G extends string | undefined>(
      name: string,
      source: MetricSource<G>,
      effect: (event: MetricEvent<G>, act: Actions) => Effect | readonly Effect[]
    ): Trigger;
    harness(name: string): Harness;

    readonly on: {
      enters<T, S extends string>(kind: Kind<T, S>, states: NoInfer<S> | readonly NoInfer<S>[]): UnitSource<T, S>;
      streak<T, S extends string>(kind: Kind<T, S>, state: NoInfer<S>, count: number, group: (data: T) => string): UnitSource<T, S>;
      deadline<T, S extends string>(kind: Kind<T, S>, due: (data: T) => Date, whileIn: readonly NoInfer<S>[]): UnitSource<T, S>;
      metric(read: (metrics: Metrics) => Rate, bounds: Bounds): MetricSource<undefined>;
      metric(read: (metrics: Metrics) => Grouped, bounds: Bounds & { readonly group: Tag }): MetricSource<string>;
    };

    readonly policy: {
      model(name: string, decide: (choice: ModelChoice) => Model): ModelPolicy;
      account(name: string, decide: (choice: AccountChoice) => Account | null): AccountPolicy;
      scheduler(name: string, decide: (view: SchedulerView) => ScheduleDecision): SchedulerPolicy;
      retry(name: string, decide: (view: RetryView) => RetryDecision): RetryPolicy;
      recall(name: string, decide: (view: RecallView) => readonly Recalled[]): RecallPolicy;
      rule<I, O>(
        name: string,
        shape: { readonly input: Schema<I>; readonly output: Schema<O> },
        decide: (input: NoInfer<I>, metrics: Metrics) => NoInfer<O>
      ): RulePolicy<I, O>;
    };

    clock<T, S extends string>(
      name: string,
      kind: Kind<T, S>,
      at: TimeSpec,
      produce: (tick: { readonly now: Date; readonly units: readonly UnitView<T, S>[] }) => readonly Supply<NoInfer<T>, NoInfer<S>>[]
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
  import type { Kind, Store, Ledger, QuotaPartition } from 'harness-dsl/kernel';
  export function ledger(path: string): Ledger;
  export function quota(path: string): QuotaPartition;
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
  import type { Observer, Ref, EntryFilter, EntryType, EntryOf } from 'harness-dsl/kernel';
  export function notify<E extends EntryType>(options: {
    readonly webhook: Ref<string>;
    readonly on: EntryFilter<E> & { readonly entry: E | readonly E[] };
    readonly message: (entry: EntryOf<E>) => string;
  }): Observer;
}
