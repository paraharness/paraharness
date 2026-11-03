declare module 'harness-dsl' {
  import { z } from 'zod';
  import {
    Named,
    EnvRef,
    PortRef,
    Verdict,
    Position,
    State,
    UnitView,
    WorkRef,
    Metrics,
    Policy,
    AccountState,
    Account,
    Model,
    RunnerBackend,
    Workspace,
    Supplier,
    Store,
    MemoryStore,
    Ledger,
    Client,
    Observer,
    Scope,
    MetricRef,
    Measure,
    Window,
    ResolvedBy,
    Dims,
    FacetValue,
    FacetRef,
    HaltRef,
    RoleRef,
    SeatRef,
    Resource,
    ColumnName,
    Grant,
  } from 'harness-dsl/kernel';
  export * from 'harness-dsl/kernel';

  export type Schema<T> = z.ZodType<T>;
  export type Empty = { readonly [K in never]: never };
  export type StepOf<St> = Extract<keyof St, string>;

  export type RestPosition = 'pending' | 'waiting';
  export type TerminalState<S extends State> = Extract<S, State<string, 'terminal'>>;
  export type RestState<S extends State> = Extract<S, State<string, RestPosition>>;
  export type WaitingState<S extends State> = Extract<S, State<string, 'waiting'>>;
  export type StateMatch<S extends State> = S | readonly S[];

  export interface KindShape<A, S extends State> extends WorkRef<S['name']> {
    readonly entity: 'kind';
    readonly _types?: { readonly attrs: A; readonly states: S };
  }

  export interface Kind<N extends string, A, S extends State> extends KindShape<A, S> {
    readonly name: N;
    attributes<A2 extends object>(schema: Schema<A2>): Kind<N, A2, S>;
    states<S2 extends State[]>(...states: S2): Kind<N, A, S2[number]>;
    key(identity: (attrs: A) => string): Kind<N, A, S>;
    initial(state: RestState<S>): Kind<N, A, S>;
  }

  export interface Signal<N extends string = string, P = unknown> extends Named {
    readonly entity: 'signal';
    readonly name: N;
    readonly _payload?: P;
    payload<P2>(schema: Schema<P2>): Signal<N, P2>;
  }

  export interface Halt<N extends string = string, D = unknown> extends HaltRef {
    readonly name: N;
    readonly _decision?: D;
    decision<D2>(schema: Schema<D2>): Halt<N, D2>;
  }

  export interface Facet<N extends string = string> extends FacetRef {
    readonly name: N;
    of(value: string): FacetValue;
    read(by: Dims): string | undefined;
  }

  export interface Executable<I, O> extends Named {
    readonly runs: 'now';
    readonly _io?: { readonly in: (input: I) => void; readonly out: O };
  }

  export interface Job<I, O> extends Named {
    readonly runs: 'later';
    readonly _job?: { readonly in: (input: I) => void; readonly out: O };
  }

  export interface JobHandle {
    readonly jobId: string;
  }

  export interface JobPoll<O> {
    readonly state: 'running' | 'succeeded' | 'failed';
    readonly result?: O;
    readonly reason?: string;
  }

  export interface CommandResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }

  export interface Command<I, O> extends Executable<I, O> {
    input<I2>(schema: Schema<I2>): Command<I2, O>;
    argv(argv: readonly string[] | ((input: I) => readonly string[])): Command<I, O>;
    output<O2>(schema: Schema<O2>): Command<I, O2>;
    runner(runner: Runner | ((input: I) => Runner)): Command<I, O>;
    acceptExitCodes(...exitCodes: number[]): Command<I, O>;
  }

  export interface Runner extends Named {
    readonly backend: RunnerBackend;
    slots(count: number): Runner;
    preflight(check: Executable<void, unknown>): Runner;
  }

  export type Intent = 'read' | 'edit' | 'run' | 'search' | 'browse' | 'record';

  export interface Role extends RoleRef {
    intents(...intents: Intent[]): Role;
    instructions(text: string): Role;
  }

  export interface Task {
    readonly task: string;
    readonly resources?: readonly Resource[];
    readonly skills?: readonly string[];
  }

  export interface Peer {
    readonly seat: SeatRef;
    readonly current?: Model;
  }

  export interface ModelPolicyCtx {
    readonly kind: WorkRef;
    readonly seat: SeatRef;
    readonly candidates: readonly [Model, ...Model[]];
    readonly current?: Model;
    readonly peers: readonly Peer[];
    readonly metrics: Metrics;
  }

  export type ModelPolicy = Policy<ModelPolicyCtx, Model>;

  export interface Seat<O> extends Executable<Task, O>, SeatRef {
    role(role: Role): Seat<O>;
    model(model: Model): Seat<O>;
    model(policy: ModelPolicy, candidates: readonly [Model, ...Model[]]): Seat<O>;
    pool(pool: Pool): Seat<O>;
    output<O2>(schema: Schema<O2>): Seat<O2>;
    workspace(workspace: Workspace): Seat<O>;
    guard(guard: { readonly leaseFiles?: boolean; readonly beforeStop?: Executable<void, unknown> }): Seat<O>;
    halts(...halts: Halt<string, unknown>[]): Seat<O>;
    batch(): Job<readonly Task[], readonly O[]>;
  }

  export interface AccountPolicyCtx {
    readonly candidates: readonly AccountState[];
    readonly now: Date;
  }

  export type AccountPolicy = Policy<AccountPolicyCtx, AccountState | undefined>;

  export interface HaltPolicyCtx<I> {
    readonly input: I;
    readonly metrics: Metrics;
  }

  export interface HaltPolicy<I, D> extends Policy<HaltPolicyCtx<I>, D | undefined> {
    readonly halt: HaltRef;
    readonly _input?: I;
  }

  export interface Pool extends Named {
    accounts(...accounts: Account[]): Pool;
    share(account: Account, fraction: number): Pool;
    drain(policy: AccountPolicy): Pool;
    fallback(account: Account): Pool;
  }

  export interface MemoryKind extends Named {
    readonly entity: 'memoryKind';
    readonly trust: 'experience' | 'taste';
  }

  export interface Journal extends Named {
    readonly entity: 'journal';
    store(store: MemoryStore): Journal;
    recall(recall: { readonly by: 'specificity' | 'similarity'; readonly limit: number }): Journal;
    readBy(...roles: Role[]): Journal;
    recordedBy(...roles: Role[]): Journal;
  }

  export interface MemoryDraft {
    readonly text: string;
    readonly when?: Scope;
    readonly status?: 'candidate' | 'active';
  }

  export interface Retry {
    readonly maxAttempts: number;
    readonly backoff: 'fixed' | 'exponential';
    readonly initialDelayMs: number;
  }

  export interface StepOptions<I> {
    readonly retry?: Retry;
    readonly afterCrash?: 'rerun' | 'park' | 'askDriver';
    readonly alreadyDone?: Executable<I, boolean>;
  }

  export interface FlowCtx<In, P, St> {
    readonly unit: UnitView<In>;
    readonly params: P;
    readonly steps: St;
    readonly metrics: Metrics;
    readonly now: Date;
    readonly iteration: number;
  }

  export interface ChildResult {
    readonly unitId: string;
    readonly state: string;
    readonly verdict: Verdict;
  }

  export interface HaltOptions<In, P, St, D, I> {
    readonly ask: (ctx: FlowCtx<In, P, St>) => string;
    readonly policy?: { readonly by: HaltPolicy<I, D>; readonly input: (ctx: FlowCtx<In, P, St>) => I };
    readonly timeout?: { readonly afterMinutes: number; readonly decide: (ctx: FlowCtx<In, P, St>) => D };
    readonly escalate?: { readonly afterMinutes: number; readonly run: Executable<void, unknown> };
  }

  export interface Flow<In, P, St, X extends string> extends Named {
    readonly _types?: {
      readonly input: (attrs: In) => void;
      readonly params: (params: P) => P;
      readonly steps: St;
      readonly exits: X;
    };
    input<In2>(schema: Schema<In2>): Flow<In2, P, St, X>;
    params<P2>(schema: Schema<P2>): Flow<In, P2, St, X>;
    step<M extends string, O>(
      name: M,
      exec: Executable<void, O>,
      options?: StepOptions<void>,
    ): Flow<In, P, St & { readonly [K in M]: O }, X>;
    step<M extends string, I, O>(
      name: M,
      exec: Executable<I, O>,
      input: (ctx: FlowCtx<In, P, St>) => I,
      options?: StepOptions<I>,
    ): Flow<In, P, St & { readonly [K in M]: O }, X>;
    halt<M extends string, D, I = never>(
      name: M,
      halt: Halt<string, D>,
      options: HaltOptions<In, P, St, NoInfer<D>, I>,
    ): Flow<In, P, St & { readonly [K in M]: D }, X>;
    wait<M extends string>(
      name: M,
      wait: { readonly ms: number },
    ): Flow<In, P, St & { readonly [K in M]: Date }, X>;
    job<M extends string, I, O>(
      name: M,
      job: Job<I, O>,
      input: (ctx: FlowCtx<In, P, St>) => I,
      options?: { readonly afterCrash?: 'rerun' | 'park' },
    ): Flow<In, P, St & { readonly [K in M]: O }, X>;
    spawn<M extends string, A2>(
      name: M,
      lane: LaneShape<A2, State, unknown, string>,
      children: (ctx: FlowCtx<In, P, St>) => readonly A2[],
    ): Flow<In, P, St & { readonly [K in M]: readonly ChildResult[] }, X>;
    loop<M extends string, St2, X2 extends string>(
      name: M,
      body: (flow: Flow<In, P, St, X>) => Flow<In, P, St2, X2>,
      bounds: {
        readonly max?: number | ((ctx: FlowCtx<In, P, St>) => number);
        readonly until?: (ctx: FlowCtx<In, P, St2>) => boolean;
      },
    ): Flow<In, P, St2, X2>;
    exit<M extends string>(name: M, when?: (ctx: FlowCtx<In, P, St>) => boolean): Flow<In, P, St, X | M>;
  }

  export interface LaneShape<A, S extends State, St, X extends string> extends WorkRef<S['name'], X> {
    readonly entity: 'lane';
    readonly _types?: { readonly attrs: A; readonly states: S; readonly steps: St };
  }

  export type LaneRef = LaneShape<unknown, State, unknown, string>;

  export interface Lease {
    readonly resource: Resource;
    readonly mode: 'exclusive' | 'shared';
  }

  export type CeilingDecision =
    | { readonly action: 'raise'; readonly maxUsd: number }
    | { readonly action: 'fail' };

  export interface Handler<A, S extends State, St, E extends string, R extends string> {
    readonly ends?: { readonly [K in E]: TerminalState<S> };
    readonly rests?: { readonly [K in R]: RestState<S> };
    readonly retry: Retry & { readonly exhausted: TerminalState<S> | WaitingState<S> };
    readonly ceiling?: { readonly maxUsd: number; readonly onExceed: 'fail' | Halt<string, CeilingDecision> };
    readonly lease?: (unit: UnitView<A, S['name'], StepOf<St>>) => Lease;
    readonly order?: { readonly after: (attrs: A) => string | undefined; readonly held: WaitingState<S> };
  }

  export type ParamsFor<P> = [P] extends [void] ? { readonly params?: undefined } : { readonly params: P };
  export type Covers<X extends string, K extends string> = [Exclude<X, K>] extends [never]
    ? unknown
    : { readonly exitsWithoutDestination: Exclude<X, K> };
  export type InputFits<A, I> = [A] extends [I] ? unknown : { readonly flowInputDoesNotFitKind: I };

  export interface Reaction<A, S extends State, N extends string, P> {
    readonly update?: (attrs: A, payload: P) => A;
    readonly restart?: N | { readonly to: N; readonly at: readonly N[] };
    readonly enter?: S;
  }

  export interface Route { readonly route: 'create' | 'signal' | 'skip' }

  export type SignalTarget<S extends State> = string | { readonly key?: string; readonly in: StateMatch<S> };

  export interface Router<A, S extends State> {
    create(attrs: A): Route;
    signal<P>(signal: Signal<string, P>, target: SignalTarget<S>, payload: P): Route;
    skip(): Route;
  }

  export interface OperatorSupplier extends Named { readonly operator: true }

  export interface Lane<A, S extends State, St, X extends string> extends LaneShape<A, S, St, X> {
    supply(supplier: OperatorSupplier): Lane<A, S, St, X>;
    supply<E>(
      supplier: Supplier<E>,
      route: (event: E, to: Router<A, S>) => Route | readonly Route[],
    ): Lane<A, S, St, X>;
    store(store: Store): Lane<A, S, St, X>;
    store<M extends string>(
      store: Store<M>,
      map: { readonly states: { readonly [K in S['name']]: M }; readonly running: M; readonly blocked?: M },
    ): Lane<A, S, St, X>;
    handler<I, P, St2, X2 extends string, E extends X2 = never, R extends X2 = never>(
      flow: Flow<I, P, St2, X2>,
      handler: Handler<A, S, St2, E, R> & ParamsFor<P> & Covers<X2, E | R> & InputFits<A, I>,
    ): Lane<A, S, St2, X2>;
    on<P>(signal: Signal<string, P>, reaction: Reaction<A, S, StepOf<St>, P>): Lane<A, S, St, X>;
  }

  export interface Tick { readonly at: Date }
  export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

  export interface Clock extends Supplier<Tick> {
    every(interval: { readonly minutes: number }): Clock;
    at(time: string, options?: { readonly on?: Weekday | number; readonly tz?: string }): Clock;
  }

  export interface Invoked {
    readonly seat?: SeatRef;
    readonly model?: Model;
  }

  export interface TransitionEvent<A, SN extends string = string, StepN extends string = string> {
    readonly unit: UnitView<A, SN, StepN>;
    readonly to: SN;
    readonly attempt?: { readonly durationMs: number; readonly costUsd: number; readonly exit?: string };
    readonly at: Date;
  }

  export interface PatternEvent<A, SN extends string = string, StepN extends string = string>
    extends TransitionEvent<A, SN, StepN> {
    readonly group: string;
    readonly streak: number;
  }

  export interface TimerEvent<A, SN extends string = string, StepN extends string = string> {
    readonly unit: UnitView<A, SN, StepN>;
    readonly at: Date;
  }

  export interface StepEvent<A, O, St, SN extends string = string> {
    readonly unit: UnitView<A, SN, StepOf<St>>;
    readonly ok: boolean;
    readonly output?: O;
    readonly outputs: { readonly [K in keyof St]?: St[K] };
    readonly invocations: { readonly [K in keyof St]?: Invoked };
    readonly durationMs: number;
    readonly at: Date;
  }

  export interface DecisionEvent<A, D, St, SN extends string = string> {
    readonly unit: UnitView<A, SN, StepOf<St>>;
    readonly decision: D;
    readonly resolvedBy: ResolvedBy;
    readonly resolver: string;
    readonly waitedMs: number;
    readonly outputs: { readonly [K in keyof St]?: St[K] };
    readonly invocations: { readonly [K in keyof St]?: Invoked };
    readonly at: Date;
  }

  export interface InvocationEvent {
    readonly seat?: SeatRef;
    readonly model?: Model;
    readonly ok: boolean;
    readonly costUsd: number;
  }

  export type Threshold = { readonly below: number } | { readonly above: number };

  export interface Band {
    readonly window: Window;
    readonly minSamples: number;
    readonly enter: Threshold;
    readonly exit: Threshold;
  }

  export interface CrossingEvent {
    readonly by: Dims;
    readonly value: number;
    readonly samples: number;
  }

  export interface Source<E> extends Named { readonly _event?: E }

  export interface TriggerRef extends Named {
    readonly entity: 'trigger';
  }

  export interface Trigger<E> extends TriggerRef {
    on<E2>(source: Source<E2>): Trigger<E2>;
    create<A>(lane: LaneShape<A, State, unknown, string>, attrs: (event: E) => A | undefined): Trigger<E>;
    signal<P>(
      signal: Signal<string, P>,
      lane: LaneRef,
      target: (event: E) => { readonly key: string; readonly payload: P } | undefined,
    ): Trigger<E>;
    record(journal: Journal, item: (event: E) => MemoryDraft | undefined): Trigger<E>;
    pause(lane: LaneRef, reason: (event: E) => string): Trigger<E>;
    resume(lane: LaneRef, reason: (event: E) => string): Trigger<E>;
  }

  export interface Sample { readonly hit: boolean; readonly by?: Dims }
  export interface Amount { readonly amount: number; readonly by?: Dims }

  export interface MetricDraft<E> extends Named {
    facets(...facets: Facet[]): MetricDraft<E>;
    samples(extract: (event: E) => readonly Sample[]): MetricRef<'rate'>;
    amounts(extract: (event: E) => readonly Amount[]): MetricRef<'total'>;
  }

  export interface AdmitCtx<A> {
    readonly unit: UnitView<A>;
    readonly count: (lane: LaneRef, ...positions: Position[]) => number;
    readonly metrics: Metrics;
  }

  export interface Scheduler extends Named {
    priority(...lanes: LaneRef[]): Scheduler;
    wip(lane: LaneRef, maxActive: number): Scheduler;
    boost(lane: LaneRef, aging: { readonly afterMinutes: number }): Scheduler;
    rank<A>(lane: LaneShape<A, State, unknown, string>, key: (unit: UnitView<A>) => number): Scheduler;
    admit<A>(lane: LaneShape<A, State, unknown, string>, gate: (ctx: AdmitCtx<A>) => boolean): Scheduler;
  }

  export interface Operation<I, O> extends Grant {
    readonly _io?: { readonly in: (input: I) => void; readonly out: O };
  }

  export interface Harness extends Named {
    ledger(ledger: Ledger): Harness;
    lanes(...lanes: LaneRef[]): Harness;
    journals(...journals: Journal[]): Harness;
    triggers(...triggers: TriggerRef[]): Harness;
    metrics(...metrics: MetricRef<Measure>[]): Harness;
    scheduler(scheduler: Scheduler): Harness;
    clients(...clients: Client[]): Harness;
    observers(...observers: Observer[]): Harness;
    start(): Promise<void>;
  }

  export const H: {
    env(name: string): EnvRef;
    readonly slot: { port(slot: number): PortRef };
    nextTime(at: string, options: { readonly after: Date; readonly tz?: string }): Date;

    kind<N extends string>(name: N): Kind<N, Empty, never>;
    state<N extends string, P extends RestPosition>(name: N, position: P): State<N, P>;
    terminal<N extends string>(name: N, verdict: Verdict): State<N, 'terminal'>;
    signal<N extends string>(name: N): Signal<N, Empty>;
    halt<N extends string>(name: N): Halt<N, Empty>;
    resource(name: string): Resource;
    facet<N extends string>(name: N & (N extends ColumnName ? never : unknown)): Facet<N>;
    readonly cancel: Signal<'cancel', { readonly reason?: string }>;
    role(name: string): Role;
    memory(name: string, trust: 'experience' | 'taste'): MemoryKind;

    command(name: string): Command<void, CommandResult>;
    job<I, O>(
      name: string,
      job: {
        readonly submit: Executable<I, JobHandle>;
        readonly collect: Executable<JobHandle, JobPoll<O>>;
        readonly pollEveryMinutes: number;
      },
    ): Job<I, O>;
    jobPoll<O>(result: Schema<O>): Schema<JobPoll<O>>;
    seat(name: string): Seat<string>;
    pool(name: string): Pool;
    readonly policy: {
      model(name: string, choose: (ctx: ModelPolicyCtx) => Model): ModelPolicy;
      account(name: string, choose: (ctx: AccountPolicyCtx) => AccountState | undefined): AccountPolicy;
      halt<D, I>(
        name: string,
        halt: Halt<string, D>,
        input: Schema<I>,
        decide: (ctx: HaltPolicyCtx<I>) => NoInfer<D> | undefined,
      ): HaltPolicy<I, D>;
    };

    flow(name: string): Flow<unknown, void, Empty, never>;
    lane<A, S extends State>(name: string, kind: KindShape<A, S>): Lane<A, S, Empty, never>;
    journal(name: string, of: MemoryKind): Journal;
    clock(name: string): Clock;
    readonly operator: OperatorSupplier;

    trigger(name: string): Trigger<never>;
    readonly when: {
      transition<A, S extends State, St>(
        lane: LaneShape<A, S, St, string>,
        filter?: {
          readonly to?: StateMatch<NoInfer<S>>;
          readonly if?: (event: TransitionEvent<A, S['name'], StepOf<St>>) => boolean;
        },
      ): Source<TransitionEvent<A, S['name'], StepOf<St>>>;
      pattern<A, S extends State, St>(
        lane: LaneShape<A, S, St, string>,
        pattern: {
          readonly to: StateMatch<NoInfer<S>>;
          readonly consecutive: number;
          readonly per: (unit: UnitView<A, S['name'], StepOf<St>>) => string;
        },
      ): Source<PatternEvent<A, S['name'], StepOf<St>>>;
      timer<A, S extends State, St>(
        lane: LaneShape<A, S, St, string>,
        timer: { readonly at: (unit: UnitView<A, S['name'], StepOf<St>>) => Date | undefined },
      ): Source<TimerEvent<A, S['name'], StepOf<St>>>;
      step<A, S extends State, St, M extends StepOf<St>>(
        lane: LaneShape<A, S, St, string>,
        step: M,
        filter?: { readonly if?: (event: StepEvent<A, St[M], St, S['name']>) => boolean },
      ): Source<StepEvent<A, St[M], St, S['name']>>;
      decision<A, S extends State, St, D>(
        lanes: LaneShape<A, S, St, string> | readonly LaneShape<A, S, St, string>[],
        halt: Halt<string, D>,
      ): Source<DecisionEvent<A, D, St, S['name']>>;
      invocation(filter: { readonly lanes: readonly LaneRef[] }): Source<InvocationEvent>;
      crossing(metric: MetricRef<'rate'>, band: Band, edge: 'entered' | 'exited'): Source<CrossingEvent>;
    };
    metric<E>(name: string, source: Source<E>): MetricDraft<E>;
    scheduler(name: string): Scheduler;

    operation<O>(name: string, exec: Executable<void, O>): Operation<void, O>;
    readonly ops: {
      readonly workRead: Grant;
      readonly workCreate: Grant;
      readonly workUpdate: Grant;
      readonly workCancel: Grant;
      readonly workSignal: Grant;
      readonly attemptsRecover: Grant;
      readonly lanesPause: Grant;
      readonly memoryRead: Grant;
      readonly memoryWrite: Grant;
      readonly memoryCurate: Grant;
      readonly telemetryRead: Grant;
      readonly accountsRead: Grant;
      readonly accountsShare: Grant;
      resolve(halt: HaltRef, gate?: { readonly afterMinutes: number }): Grant;
    };
    harness(name: string): Harness;
  };
}

declare module 'harness-dsl/sqlite' {
  import { Ledger, Store, Supplier, Clock, JsonObject, QuotaPartition } from 'harness-dsl';
  export interface StoredUnit {
    readonly key: string;
    readonly kind: string;
    readonly state: string;
    readonly attributes: JsonObject;
  }
  export const sqlite: {
    ledger(options: { readonly path: string }): Ledger;
    quota(name: string, options: { readonly path: string }): QuotaPartition;
    store(options: { readonly path: string }): Store;
    scan(name: string, options: { readonly path: string; readonly kind: string; readonly schedule: Clock }): Supplier<StoredUnit>;
  };
}

declare module 'harness-dsl/jsonl' {
  import { MemoryStore } from 'harness-dsl';
  export const jsonl: {
    memoryStore(options: { readonly path: string }): MemoryStore;
  };
}

declare module 'harness-dsl/pgvector' {
  import { MemoryStore, EnvRef, Embedder } from 'harness-dsl';
  export const pgvector: {
    memoryStore(options: { readonly url: EnvRef; readonly table: string; readonly embedder: Embedder }): MemoryStore;
  };
}

declare module 'harness-dsl/voyage' {
  import { Embedder, EnvRef } from 'harness-dsl';
  export const voyage: {
    embedder(name: string, options: { readonly id: string; readonly apiKey: EnvRef }): Embedder;
  };
}

declare module 'harness-dsl/claude-code' {
  import { Account, Model, Client, Grant, EnvRef, PortRef, QuotaPartition, Named } from 'harness-dsl';
  export interface Supervisor extends Named {
    client(name: string, options: { readonly grants: readonly Grant[]; readonly port?: PortRef }): Client;
  }
  export const claudeCode: {
    subscription(name: string, options: { readonly token: EnvRef; readonly quota: QuotaPartition }): Account;
    model(name: string, options: { readonly id: string }): Model;
    supervisor(name: string): Supervisor;
  };
}

declare module 'harness-dsl/anthropic' {
  import { Account, Model, EnvRef, QuotaPartition } from 'harness-dsl';
  export const anthropic: {
    account(name: string, options: { readonly apiKey: EnvRef; readonly quota: QuotaPartition }): Account;
    model(name: string, options: { readonly id: string }): Model;
  };
}

declare module 'harness-dsl/linear' {
  import { Supplier, Store, EnvRef } from 'harness-dsl';
  export interface LinearIssue {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly description: string;
    readonly labels: readonly string[];
  }
  export const linear: {
    issues(options: { readonly apiKey: EnvRef; readonly team: string; readonly labels?: readonly string[] }): Supplier<LinearIssue>;
    store<M extends string>(options: { readonly apiKey: EnvRef; readonly team: string; readonly workflow: readonly M[] }): Store<M>;
  };
}

declare module 'harness-dsl/folder' {
  import { Supplier, Store } from 'harness-dsl';
  export interface FolderFile {
    readonly path: string;
    readonly name: string;
    readonly body: string;
  }
  export const folder: {
    files(options: { readonly path: string; readonly glob: string }): Supplier<FolderFile>;
    frontmatter(options: { readonly path: string }): Store;
  };
}

declare module 'harness-dsl/git' {
  import { Workspace } from 'harness-dsl';
  export const git: {
    worktree(options: { readonly repo: string; readonly base: string }): Workspace;
  };
}

declare module 'harness-dsl/local' {
  import { Runner } from 'harness-dsl';
  export const local: {
    runner(name: string): Runner;
  };
}

declare module 'harness-dsl/ssh' {
  import { Runner, EnvRef } from 'harness-dsl';
  export const ssh: {
    host(name: string, options: { readonly host: string; readonly user: string; readonly key: EnvRef }): Runner;
  };
}

declare module 'harness-dsl/http' {
  import { Client, Grant, EnvRef, PortRef } from 'harness-dsl';
  export const http: {
    controlApi(name: string, options: { readonly port: PortRef; readonly token: EnvRef; readonly grants: readonly Grant[] }): Client;
  };
}

declare module 'harness-dsl/webhook' {
  import { Supplier, Schema, EnvRef, PortRef } from 'harness-dsl';
  export const webhook: {
    json<P>(name: string, options: {
      readonly port: PortRef;
      readonly path: string;
      readonly secret: EnvRef;
      readonly payload: Schema<P>;
    }): Supplier<P>;
  };
}

declare module 'harness-dsl/zendesk' {
  import { Supplier, Store, EnvRef, PortRef } from 'harness-dsl';
  export interface ZendeskEvent {
    readonly type: 'created' | 'replied' | 'updated';
    readonly status: 'new' | 'open' | 'pending' | 'solved' | 'closed';
    readonly ticketId: string;
    readonly subject: string;
    readonly message: string;
    readonly customerEmail: string;
    readonly priority: 'low' | 'normal' | 'high' | 'urgent';
    readonly createdAt: Date;
  }
  export const zendesk: {
    webhook(options: { readonly port: PortRef; readonly path: string; readonly secret: EnvRef }): Supplier<ZendeskEvent>;
    poll(options: { readonly subdomain: string; readonly token: EnvRef; readonly everyMinutes: number }): Supplier<ZendeskEvent>;
    store(options: { readonly subdomain: string; readonly token: EnvRef }): Store;
  };
}

declare module 'harness-dsl/contentful' {
  import { Supplier, Store, EnvRef } from 'harness-dsl';
  export interface ContentfulEntry {
    readonly id: string;
    readonly title: string;
    readonly section: string;
    readonly body: string;
  }
  export const contentful: {
    drafts(options: { readonly space: string; readonly token: EnvRef; readonly everyMinutes: number }): Supplier<ContentfulEntry>;
    store(options: { readonly space: string; readonly token: EnvRef }): Store;
  };
}

declare module 'harness-dsl/ironclad' {
  import { Store, EnvRef } from 'harness-dsl';
  export const ironclad: {
    store(options: { readonly workspace: string; readonly token: EnvRef }): Store;
  };
}

declare module 'harness-dsl/markdown' {
  import { Observer } from 'harness-dsl';
  export const markdown: {
    board(options: { readonly path: string }): Observer;
    telemetry(options: { readonly path: string }): Observer;
  };
}

declare module 'harness-dsl/slack' {
  import { Observer, EnvRef, LaneRef } from 'harness-dsl';
  export const slack: {
    notifier(name: string, options: { readonly webhookUrl: EnvRef; readonly lanes: readonly LaneRef[] }): Observer;
  };
}
