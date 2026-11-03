declare module 'harness-dsl' {
  import type {
    Position, Verdict, AttemptOutcome, AnyState, State, Ref, Arg, Schema, Named, Kind, Resource, Role, Intent,
    MemoryKind, Trust, When, MemoryDraft, Executable, Result, Model, Account, Runner, Guard, Supplier, Supply,
    Store, MemoryStore, Ledger, QuotaPartition, Observer, Client, Operation, Policy, ModelChoice, AccountChoice,
    SchedulerView, ScheduleDecision, RecallView, Recalled, RetryView, RetryDecision, RuleView, Metrics, UnitView,
    Cadence, Interval, Rate, MetricRead, Running, PendingView, ActiveView
  } from 'harness-dsl/kernel';

  export type {
    Position, Verdict, AttemptOutcome, AnyState, State, Ref, Arg, Schema, Named, Kind, Resource, Role, Intent,
    MemoryKind, Trust, When, MemoryDraft, Executable, Result, Model, Account, Runner, Guard, Supplier, Supply,
    Store, MemoryStore, Ledger, QuotaPartition, Observer, Client, Operation, Policy, ModelChoice, AccountChoice,
    SchedulerView, ScheduleDecision, RecallView, Recalled, RetryView, RetryDecision, RuleView, Metrics, UnitView,
    Cadence, Interval, Rate, MetricRead, Running, PendingView, ActiveView
  } from 'harness-dsl/kernel';
  export type { AccountView, Mean, EntryFilter, LedgerEntry, GroupBy } from 'harness-dsl/kernel';

  export type PendingOf<St extends AnyState> = Extract<St, { readonly position: 'pending' }>['name'];
  export type ActiveOf<St extends AnyState> = Extract<St, { readonly position: 'active' }>['name'];
  export type WaitingOf<St extends AnyState> = Extract<St, { readonly position: 'waiting' }>['name'];
  export type TerminalOf<St extends AnyState> = Extract<St, { readonly position: 'terminal' }>['name'];
  export type RestingOf<St extends AnyState> = Exclude<St['name'], ActiveOf<St>>;

  export interface Names {
    readonly pending: string;
    readonly active: string;
    readonly waiting: string;
    readonly terminal: string;
  }
  export type NamesOf<St extends AnyState> = {
    readonly pending: PendingOf<St>;
    readonly active: ActiveOf<St>;
    readonly waiting: WaitingOf<St>;
    readonly terminal: TerminalOf<St>;
  };
  export type Shared<A extends Names, B extends Names> = {
    readonly pending: A['pending'] & B['pending'];
    readonly active: A['active'] & B['active'];
    readonly waiting: A['waiting'] & B['waiting'];
    readonly terminal: A['terminal'] & B['terminal'];
  };
  type AllNames<N extends Names> = N['pending'] | N['active'] | N['waiting'] | N['terminal'];

  export type DataOf<K> = K extends Kind<infer T, infer _St extends AnyState> ? T : never;
  export type StateOf<K> = K extends Kind<infer _T, infer St extends AnyState> ? St['name'] : never;

  export interface KindDraft {
    data<T>(schema: Schema<T>): KindData<T>;
  }
  export interface KindData<T> {
    states<St extends AnyState>(states: readonly St[], initial: NoInfer<PendingOf<St>>): KindDescriptor<T, St>;
  }
  export interface KindDescriptor<T, St extends AnyState> extends Kind<T, St> {
    onFailure(state: NoInfer<RestingOf<St>>): KindDescriptor<T, St>;
  }

  export interface ResourceDescriptor extends Resource {
    of(key: string): ResourceDescriptor;
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
    restart(rule: 'reconcile' | 'rerun' | 'park'): Agent<I, O>;
  }

  export interface Command<I, O> extends Executable<I, O> {
    readonly entity: 'command';
    input<I2>(schema: Schema<I2>): Command<I2, O>;
    output<O2>(schema: Schema<O2>): Command<I, O2>;
    argv(render: (input: I) => readonly Arg[]): Command<I, O>;
    on(runner: Runner): Command<I, O>;
    restart(rule: 'rerun' | 'park' | { readonly check: Executable<I, O | null> }): Command<I, O>;
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
    readonly retry?: RetryPolicy;
    readonly scope?: RecallScope;
    readonly on?: Runner;
  }
  export type RunArgs<I> = [I] extends [void]
    ? [input?: undefined, options?: RunOptions]
    : [input: I, options?: RunOptions];

  export interface HaltRequest<D> {
    readonly name: string;
    readonly show: string;
    readonly decision: Schema<D>;
  }

  export interface Wake {
    readonly at?: Date;
    readonly children?: true;
  }
  export interface Rest {
    readonly entity: 'rest';
    readonly state: string;
  }
  export interface Failed {
    readonly entity: 'failed';
    readonly reason: string;
  }

  export interface FlowContext<T, N extends Names, P> {
    readonly unit: UnitView<T, AllNames<N>>;
    readonly params: P;
    now(): Date;
    run<I, O>(executable: Executable<I, O>, ...args: RunArgs<I>): Promise<Result<O>>;
    batch<I, O>(agent: Agent<I, O>, inputs: readonly I[]): Promise<readonly Result<O>[]>;
    move(state: N['active']): Promise<void>;
    update(patch: Partial<T>): Promise<void>;
    tag(tags: Readonly<Record<string, string>>): void;
    halt<D>(request: HaltRequest<D>): Promise<D>;
    decide<I, O>(rule: RulePolicy<I, O>, input: I): Promise<O>;
    remember<M>(library: Library<M>, draft: MemoryDraft<M>): Promise<void>;
    spawn<T2, St2 extends AnyState>(lane: Lane<T2, St2>, data: readonly T2[]): Promise<readonly string[]>;
    children(): Promise<readonly UnitView<unknown, string>[]>;
    wait(state: N['waiting'], wake: Wake): Promise<void>;
    rest(state: N['waiting'], wake?: Wake & { readonly then: N['pending'] }): Rest;
    fail(reason: string): Failed;
  }

  export interface FlowDraft {
    for<T1, St1 extends AnyState>(k1: Kind<T1, St1>): FlowShape<T1, NamesOf<St1>, void>;
    for<T1, St1 extends AnyState, T2, St2 extends AnyState>(
      k1: Kind<T1, St1>, k2: Kind<T2, St2>
    ): FlowShape<T1 | T2, Shared<NamesOf<St1>, NamesOf<St2>>, void>;
    for<T1, St1 extends AnyState, T2, St2 extends AnyState, T3, St3 extends AnyState>(
      k1: Kind<T1, St1>, k2: Kind<T2, St2>, k3: Kind<T3, St3>
    ): FlowShape<T1 | T2 | T3, Shared<Shared<NamesOf<St1>, NamesOf<St2>>, NamesOf<St3>>, void>;
  }
  export interface FlowShape<T, N extends Names, P> {
    params<P2>(schema: Schema<P2>): FlowShape<T, N, P2>;
    does(body: (ctx: FlowContext<T, N, P>) => Promise<N['pending'] | N['terminal'] | Rest | Failed>): Flow<T, N, P>;
  }
  export interface Flow<T, N extends Names, P> extends Named {
    readonly entity: 'flow';
    readonly kinds: readonly string[];
    readonly names: N;
    readonly accepts: (data: T) => void;
    readonly params?: Schema<P>;
  }

  export interface LaneDraft<T, St extends AnyState> {
    handler(flow: Flow<T, NamesOf<St>, void>): Lane<T, St>;
    handler<P>(flow: Flow<T, NamesOf<St>, P>, params: NoInfer<P>): Lane<T, St>;
  }
  export interface Lane<T, St extends AnyState> extends Named {
    readonly entity: 'lane';
    readonly kind: Kind<T, St>;
    suppliers(...suppliers: readonly Supplier<T, St['name']>[]): Lane<T, St>;
    store(store: Store<T>): Lane<T, St>;
    wip(limit: number): Lane<T, St>;
    maxUsdPerUnit(limit: number): Lane<T, St>;
    retry(policy: RetryPolicy): Lane<T, St>;
  }
  export interface LaneRef extends Named {
    readonly entity: 'lane';
  }

  export interface Source<E, M extends string> {
    readonly entity: 'source';
    readonly on: 'enters' | 'streak' | 'deadline' | 'time' | 'metric';
    readonly sample?: E;
    readonly targets?: readonly M[];
  }
  export interface UnitEvent<T, S extends string> {
    readonly unit: UnitView<T, S>;
    readonly at: Date;
    readonly attempt?: { readonly id: string; readonly durationMs: number; readonly costUsd: number };
    readonly streak?: number;
  }
  export interface MetricEvent {
    readonly group: string;
    readonly reading: MetricRead;
    readonly crossing: 'entered' | 'exited';
    readonly at: Date;
  }
  export type Threshold = { readonly below: number } | { readonly above: number };

  export interface Effect {
    readonly entity: 'effect';
    readonly does: 'create' | 'move' | 'close' | 'remember' | 'pause' | 'resume';
  }
  export interface Actions<M extends string> {
    create<T2, St2 extends AnyState>(
      lane: Lane<T2, St2>,
      data: T2,
      options?: { readonly key?: string; readonly oneOpenPer?: string }
    ): Effect;
    move(state: M): Effect;
    close<T2, St2 extends AnyState>(lane: Lane<T2, St2>, oneOpenPer: string, state: NoInfer<RestingOf<St2>>): Effect;
    remember<Mem>(library: Library<Mem>, draft: MemoryDraft<Mem>): Effect;
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
    readonly state: {
      pending<N extends string>(name: N): State<N, 'pending'>;
      active<N extends string>(name: N): State<N, 'active'>;
      waiting<N extends string>(name: N): State<N, 'waiting'>;
      terminal<N extends string>(name: N, verdict: Verdict): State<N, 'terminal'>;
    };
    resource(name: string): ResourceDescriptor;
    role(name: string): RoleDraft;
    memory(name: string, trust: Trust): MemoryKindDescriptor<void>;

    agent<I, O>(name: string, role: Role<I, O>): AgentDraft<I, O>;
    command(name: string): Command<void, string>;
    flow(name: string): FlowDraft;

    lane<T, St extends AnyState>(name: string, kind: Kind<T, St>): LaneDraft<T, St>;
    library<M>(name: string, memory: MemoryKind<M>, store: MemoryStore): Library<M>;
    pool(name: string, members: readonly PoolMember[], policy: AccountPolicy): Pool;
    trigger<E, M extends string>(
      name: string,
      source: Source<E, M>,
      effect: (event: E, act: Actions<M>) => Effect | readonly Effect[]
    ): Trigger;
    harness(name: string): Harness;

    readonly on: {
      enters<T, St extends AnyState>(
        kind: Kind<T, St>, states: NoInfer<St['name']> | readonly NoInfer<St['name']>[]
      ): Source<UnitEvent<T, St['name']>, RestingOf<St>>;
      streak<T, St extends AnyState>(
        kind: Kind<T, St>, state: NoInfer<St['name']>, count: number, group: (data: T) => string
      ): Source<UnitEvent<T, St['name']>, RestingOf<St>>;
      deadline<T, St extends AnyState>(
        kind: Kind<T, St>, due: (data: T) => Date, whileIn: readonly NoInfer<St['name']>[]
      ): Source<UnitEvent<T, St['name']>, RestingOf<St>>;
      time<T, St extends AnyState>(
        kind: Kind<T, St>, at: Cadence, whileIn: readonly NoInfer<St['name']>[]
      ): Source<UnitEvent<T, St['name']>, RestingOf<St>>;
      metric(spec: {
        readonly every: Interval;
        readonly groups?: (metrics: Metrics) => readonly string[];
        readonly read: (metrics: Metrics, group: string) => Rate;
        readonly enter: Threshold;
        readonly exit: Threshold;
        readonly minSamples: number;
      }): Source<MetricEvent, never>;
    };

    readonly policy: {
      model(name: string, decide: (choice: ModelChoice) => Model): ModelPolicy;
      account(name: string, decide: (choice: AccountChoice) => Account | null): AccountPolicy;
      scheduler(name: string, decide: (view: SchedulerView) => ScheduleDecision): SchedulerPolicy;
      recall(name: string, decide: (view: RecallView) => readonly Recalled[]): RecallPolicy;
      retry(name: string, decide: (view: RetryView) => RetryDecision): RetryPolicy;
      rule<I, O>(name: string, decide: (input: I, metrics: Metrics) => O): RulePolicy<I, O>;
    };

    timetable<T, St extends AnyState>(
      name: string,
      kind: Kind<T, St>,
      at: Cadence,
      produce: (tick: { readonly now: Date; readonly units: readonly UnitView<T, St['name']>[] }) => readonly Supply<T, St['name']>[]
    ): Supplier<T, St['name']>;
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
  import type { Kind, AnyState, Supplier, Store, Ref } from 'harness-dsl/kernel';
  export interface Issue {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly description: string;
    readonly labels: readonly string[];
    readonly status: string;
    readonly parentId?: string;
  }
  export function tracker<T, St extends AnyState>(
    kind: Kind<T, St>,
    options: {
      readonly apiKey: Ref<string>;
      readonly team: string;
      readonly label?: string;
      readonly read: (issue: Issue) => NoInfer<T>;
      readonly statuses: Readonly<Record<NoInfer<St['name']>, string>>;
    }
  ): Supplier<T, St['name']> & Store<T>;
}

declare module 'harness-dsl/folder' {
  import type { Kind, AnyState, Supplier, Store } from 'harness-dsl/kernel';
  export interface MarkdownFile {
    readonly path: string;
    readonly frontmatter: Readonly<Record<string, unknown>>;
    readonly body: string;
  }
  export function files<T, St extends AnyState>(
    kind: Kind<T, St>,
    options: {
      readonly dir: string;
      readonly read: (file: MarkdownFile) => NoInfer<T>;
      readonly write?: (data: NoInfer<T>, state: NoInfer<St['name']>) => Readonly<Record<string, string | number | boolean>>;
    }
  ): Supplier<T, St['name']> & Store<T>;
}

declare module 'harness-dsl/sqlite' {
  import type { Kind, AnyState, Store, Ledger, QuotaPartition } from 'harness-dsl/kernel';
  export function ledger(path: string, options?: { readonly quota?: QuotaPartition }): Ledger;
  export function quota(path: string): QuotaPartition;
  export function store<T, St extends AnyState>(kind: Kind<T, St>, path: string): Store<T>;
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
  import type { Kind, AnyState, Supplier, Supply, Store, Client, Operation, Ref, Arg, Schema, Interval } from 'harness-dsl/kernel';
  export function webhook<T, St extends AnyState, B>(kind: Kind<T, St>, options: {
    readonly path: string;
    readonly secret: Ref<string>;
    readonly body: Schema<B>;
    readonly read: (body: B) => Supply<NoInfer<T>, NoInfer<St['name']>> | null;
  }): Supplier<T, St['name']>;
  export function poll<T, St extends AnyState, B>(kind: Kind<T, St>, options: {
    readonly url: string;
    readonly every: Interval;
    readonly headers?: Readonly<Record<string, Arg>>;
    readonly body: Schema<B>;
    readonly read: (body: B) => readonly Supply<NoInfer<T>, NoInfer<St['name']>>[];
  }): Supplier<T, St['name']>;
  export function store<T, St extends AnyState>(kind: Kind<T, St>, options: {
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
