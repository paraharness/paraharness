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
    RoleRef,
    ResourceRef,
    HaltRef,
    SeatRef,
    FacetRef,
    JobRef,
    ExecutableRef,
    FacetValue,
    Dimensions,
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
    CeilingDecision,
    LeaseMode,
    LeaseSpan,
  } from 'harness-dsl/kernel';
  export * from 'harness-dsl/kernel';

  export type Schema<T> = z.ZodType<T>;
  export type Empty = { readonly [K in never]: never };

  export type PendingState<S extends State> = Extract<S, State<string, 'pending'>>;
  export type WaitingState<S extends State> = Extract<S, State<string, 'waiting'>>;

  export interface KindShape<A, S extends State> extends WorkRef<S> {
    readonly entity: 'kind';
    readonly _attrs?: A;
  }

  export interface Kind<N extends string, A, S extends State> extends KindShape<A, S> {
    readonly name: N;
    attributes<A2 extends object>(schema: Schema<A2>): Kind<N, A2, S>;
    states<S2 extends State[]>(...states: S2): Kind<N, A, S2[number]>;
    key(identity: (attrs: A) => string): Kind<N, A, S>;
    initial(state: PendingState<S>): Kind<N, A, S>;
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

  export interface Resource extends ResourceRef {}

  export interface ResourceFamily<V extends string> extends Named {
    readonly schema: Schema<V>;
    readonly all: readonly Resource[];
    get(value: V): Resource;
  }

  export interface Facet<V extends string = string> extends FacetRef {
    readonly values: readonly V[];
    readonly schema: Schema<V>;
    of(value: V): FacetValue<V>;
  }

  export interface Executable<I, O> extends ExecutableRef {
    readonly _io?: { readonly in: (input: I) => void; readonly out: O };
  }

  export interface Job<I, O> extends JobRef {
    readonly _io?: { readonly in: (input: I) => void; readonly out: O };
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

  export type Intent = 'read' | 'edit' | 'run' | 'search' | 'browse' | 'halt' | 'record';

  export interface Role extends RoleRef {
    intents(...intents: Intent[]): Role;
    instructions(text: string): Role;
  }

  export interface AgentTask {
    readonly task: string;
    readonly resources?: readonly ResourceRef[];
    readonly skills?: readonly string[];
  }

  export interface PolicyCtx {
    readonly kind: WorkRef;
    readonly seat: SeatRef;
    readonly metrics: Metrics;
  }

  export interface ModelPolicy<V extends string, B extends boolean> extends Policy<PolicyCtx, Model<V, B>> {
    readonly choice: 'single';
    readonly candidates: readonly Model<V, B>[];
  }

  export interface Assignment<V extends string = string, B extends boolean = boolean> {
    readonly seat: SeatRef;
    readonly model: Model<V, B>;
  }

  export interface LineupCtx<V extends string, B extends boolean> {
    readonly kind: WorkRef;
    readonly seats: readonly SeatRef[];
    readonly candidates: readonly Model<V, B>[];
    current(seat: SeatRef): Model<V, B>;
    readonly metrics: Metrics;
  }

  export interface Lineup<V extends string, B extends boolean>
    extends Policy<LineupCtx<V, B>, readonly Assignment<V, B>[]> {
    readonly choice: 'lineup';
    readonly candidates: readonly Model<V, B>[];
  }

  export type VendorFits<P extends string, V extends string> =
    [P] extends [V] ? unknown : { readonly poolHasAccountsTheModelCannotServe: Exclude<P, V> };

  export interface Seat<O, V extends string, B extends boolean> extends Executable<AgentTask, O>, SeatRef {
    readonly _model?: { readonly vendor: V; readonly batch: B };
    role(role: Role): Seat<O, V, B>;
    model<V2 extends string, B2 extends boolean>(model: Model<V2, B2>): Seat<O, V2, B2>;
    model<V2 extends string, B2 extends boolean>(policy: ModelPolicy<V2, B2>): Seat<O, V2, B2>;
    model<V2 extends string, B2 extends boolean>(lineup: Lineup<V2, B2>): Seat<O, V2, B2>;
    pool<P extends string>(pool: Pool<P> & VendorFits<P, V>): Seat<O, V, B>;
    output<O2>(schema: Schema<O2>): Seat<O2, V, B>;
    workspace(workspace: Workspace): Seat<O, V, B>;
    halts(...halts: HaltRef[]): Seat<O, V, B>;
  }

  export interface AccountPolicyCtx {
    readonly candidates: readonly AccountState[];
    readonly now: Date;
  }

  export type AccountPolicy = Policy<AccountPolicyCtx, AccountState | undefined>;

  export interface Pool<V extends string> extends Named {
    readonly _vendor?: V;
    accounts<V2 extends string>(...accounts: Account<V2>[]): Pool<V | V2>;
    share(account: Account<V>, fraction: number): Pool<V>;
    drain(policy: AccountPolicy): Pool<V>;
    fallback<V2 extends string>(account: Account<V2>): Pool<V | V2>;
  }

  export interface HaltPolicyCtx<A> {
    readonly unit: UnitView<A>;
    readonly facets: readonly FacetValue[];
    readonly metrics: Metrics;
    facet<V extends string>(facet: Facet<V>): V | undefined;
  }

  export interface HaltPolicy<A, D> extends Policy<HaltPolicyCtx<A>, D | undefined> {
    readonly halt: HaltRef;
  }

  export interface HaltPolicyDraft<A, D> {
    decide(decide: (ctx: HaltPolicyCtx<A>) => D | undefined): HaltPolicy<A, D>;
  }

  export interface MemoryKind extends Named {
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
    readonly backoff?: 'fixed' | 'exponential';
    readonly initialDelayMs?: number;
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

  export interface ChildResult<S extends State> {
    readonly unitId: string;
    readonly state: S;
    readonly verdict: Verdict;
  }

  export interface JobHandle {
    readonly jobId: string;
  }

  export interface JobPoll<O> {
    readonly state: 'running' | 'succeeded' | 'failed';
    readonly result?: O;
    readonly reason?: string;
  }

  export interface HaltOptions<In, P, St, D> {
    readonly ask: (ctx: FlowCtx<In, P, St>) => string;
    readonly skip?: HaltPolicy<In, D>;
    readonly facets?: (ctx: FlowCtx<In, P, St>) => readonly FacetValue[];
    readonly timeout?: { readonly afterMinutes: number; readonly decide: (ctx: FlowCtx<In, P, St>) => D };
    readonly escalate?: { readonly afterMinutes: number; readonly run: Executable<void, unknown> };
  }

  export interface LoopBounds<In, P, St, St2> {
    readonly max?: number | ((ctx: FlowCtx<In, P, St>) => number);
    readonly until?: (ctx: FlowCtx<In, P, St2>) => boolean;
  }

  export interface Carry<C> {
    readonly schema: Schema<C>;
    readonly initial: NoInfer<C>;
  }

  export interface ExitOptions<In, P, St> {
    readonly when?: (ctx: FlowCtx<In, P, St>) => boolean;
    readonly update?: (ctx: FlowCtx<In, P, St>) => Partial<In>;
  }

  export interface Flow<In, P, St, X extends string, N extends string> extends Named {
    readonly _types?: {
      readonly input: (attrs: In) => void;
      readonly params: (params: P) => P;
      readonly steps: St;
      readonly exits: X;
      readonly stepNames: N;
    };
    input<In2>(schema: Schema<In2>): Flow<In2, P, St, X, N>;
    params<P2>(schema: Schema<P2>): Flow<In, P2, St, X, N>;
    step<M extends string, O>(
      name: M,
      exec: Executable<void, O>,
      options?: StepOptions<void>,
    ): Flow<In, P, St & { readonly [K in M]: O }, X, N | M>;
    step<M extends string, I, O>(
      name: M,
      exec: Executable<I, O>,
      input: (ctx: FlowCtx<In, P, St>) => I,
      options?: StepOptions<I>,
    ): Flow<In, P, St & { readonly [K in M]: O }, X, N | M>;
    halt<M extends string, D>(
      name: M,
      halt: Halt<string, D>,
      options: HaltOptions<In, P, St, NoInfer<D>> & { readonly when: (ctx: FlowCtx<In, P, St>) => boolean },
    ): Flow<In, P, St & { readonly [K in M]: D | undefined }, X, N | M>;
    halt<M extends string, D>(
      name: M,
      halt: Halt<string, D>,
      options: HaltOptions<In, P, St, NoInfer<D>>,
    ): Flow<In, P, St & { readonly [K in M]: D }, X, N | M>;
    wait<M extends string>(
      name: M,
      wait: { readonly ms: number },
    ): Flow<In, P, St & { readonly [K in M]: Date }, X, N | M>;
    job<M extends string, I, O>(
      name: M,
      job: Job<I, O>,
      input: (ctx: FlowCtx<In, P, St>) => I,
    ): Flow<In, P, St & { readonly [K in M]: O }, X, N | M>;
    spawn<M extends string, A2, S2 extends State>(
      name: M,
      lane: LaneShape<A2, S2, unknown>,
      children: (ctx: FlowCtx<In, P, St>) => readonly A2[],
    ): Flow<In, P, St & { readonly [K in M]: readonly ChildResult<S2>[] }, X, N | M>;
    loop<M extends string, St2, X2 extends string, N2 extends string>(
      name: M,
      body: (flow: Flow<In, P, St, X, N>) => Flow<In, P, St2, X2, N2>,
      bounds: LoopBounds<In, P, St, St2>,
    ): Flow<In, P, St2, X2, N2>;
    loop<M extends string, C, St2, X2 extends string, N2 extends string>(
      name: M,
      carry: Carry<C>,
      body: (flow: Flow<In, P, St & { readonly [K in M]: C }, X, N>) => Flow<In, P, St2, X2, N2>,
      bounds: LoopBounds<In, P, St, St2> & { readonly next: (ctx: FlowCtx<In, P, St2>) => C },
    ): Flow<In, P, St2, X2, N2>;
    exit<M extends string>(
      name: M,
      when?: (ctx: FlowCtx<In, P, St>) => boolean,
    ): Flow<In, P, St, X | M, N>;
    exit<M extends string>(
      name: M,
      options: ExitOptions<In, P, St>,
    ): Flow<In, P, St, X | M, N>;
  }

  export interface LaneShape<A, S extends State, St> extends WorkRef<S> {
    readonly entity: 'lane';
    readonly _lane?: { readonly attrs: A; readonly steps: St };
  }

  export type LaneRef = LaneShape<unknown, State, unknown>;

  export type InputFits<A, I> = [A] extends [I] ? unknown : { readonly flowInputDoesNotFitKind: I };

  export type ExitTarget<S extends State> =
    | S
    | { readonly to: S; readonly bound: { readonly times: number; readonly to: S } };

  export interface SignalReaction<A, S extends State, N extends string, P> {
    readonly update?: (attrs: A, payload: P) => A;
    readonly restart?: N;
    readonly enter?: S;
    readonly at?: readonly N[];
  }

  export interface Route { readonly route: 'create' | 'signal' | 'skip' }

  export interface Router<A> {
    create(attrs: A): Route;
    signal<P>(signal: Signal<string, P>, key: string, payload: P): Route;
    skip(): Route;
  }

  export interface OperatorSupplier extends Named { readonly operator: true }

  export interface Lease {
    readonly resource: Resource;
    readonly mode: LeaseMode;
    readonly heldWhile?: LeaseSpan;
  }

  export interface StoreMap<S extends State, N extends string, M extends string> {
    readonly states: { readonly [K in S['name']]: M };
    readonly inFlight: M;
    readonly steps?: { readonly [K in N]?: M };
  }

  export interface Lane<A, S extends State, St, N extends string> extends LaneShape<A, S, St> {
    readonly _stepNames?: N;
    supply(supplier: OperatorSupplier): Lane<A, S, St, N>;
    supply<E>(
      suppliers: Supplier<E> | readonly Supplier<E>[],
      route: (event: E, to: Router<A>) => Route | readonly Route[],
    ): Lane<A, S, St, N>;
    handler<I, St2, X extends string, N2 extends string>(
      flow: Flow<I, void, St2, X, N2>,
      map: { readonly exits: { readonly [K in X]: ExitTarget<S> } } & InputFits<A, I>,
    ): Lane<A, S, St2, N2>;
    handler<I, P, St2, X extends string, N2 extends string>(
      flow: Flow<I, P, St2, X, N2>,
      map: { readonly exits: { readonly [K in X]: ExitTarget<S> }; readonly params: P } & InputFits<A, I>,
    ): Lane<A, S, St2, N2>;
    store(store: Store): Lane<A, S, St, N>;
    store<M extends string>(store: Store<M>, map: StoreMap<S, N, M>): Lane<A, S, St, N>;
    retry(retry: Retry & { readonly exhausted: S }): Lane<A, S, St, N>;
    on<P>(signal: Signal<string, P>, reaction: SignalReaction<A, S, N, P>): Lane<A, S, St, N>;
    ceiling(ceiling: {
      readonly maxUsd: number;
      readonly onExceed: 'fail' | Halt<string, CeilingDecision>;
    }): Lane<A, S, St, N>;
  }

  export interface Tick { readonly at: Date }
  export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

  export interface Clock extends Supplier<Tick> {
    every(interval: { readonly minutes: number }): Clock;
    at(time: string, options?: { readonly on?: Weekday | number; readonly tz?: string }): Clock;
  }

  export interface TransitionEvent<A, S extends State = State> {
    readonly unit: UnitView<A, S>;
    readonly to: S;
    readonly attempt?: { readonly durationMs: number; readonly costUsd: number };
    readonly at: Date;
  }

  export interface PatternEvent<A, S extends State, G extends string> extends TransitionEvent<A, S> {
    readonly group: G;
    readonly streak: number;
  }

  export interface UnitEvent<A, S extends State = State> {
    readonly unit: UnitView<A, S>;
    readonly at: Date;
  }

  export interface TimerView<T> {
    readonly key: string;
    readonly createdAt: Date;
    readonly attributes: T;
  }

  export interface StepEvent<A, O> {
    readonly unit: UnitView<A>;
    readonly ok: boolean;
    readonly output?: O;
    readonly durationMs: number;
    readonly at: Date;
    modelOf(seat: SeatRef): Model | undefined;
  }

  export interface DecisionEvent<A, S extends State, D> {
    readonly unit: UnitView<A, S>;
    readonly halt: HaltRef;
    readonly decision: D;
    readonly resolvedBy: ResolvedBy;
    readonly resolver: string;
    readonly facets: readonly FacetValue[];
    readonly waitedMs: number;
    readonly at: Date;
    facet<V extends string>(facet: Facet<V>): V | undefined;
    modelOf(seat: SeatRef): Model | undefined;
  }

  export interface InvocationEvent {
    readonly seat?: SeatRef;
    readonly model?: Model;
    readonly ok: boolean;
    readonly costUsd: number;
  }

  export type Threshold = { readonly below: number } | { readonly above: number };

  export interface Band<V extends string> {
    readonly window: Window;
    readonly minSamples: number;
    readonly enter: Threshold;
    readonly exit: Threshold;
    readonly per?: Facet<V>;
  }

  export interface CrossingBase {
    readonly rate: number;
    readonly hits: number;
    readonly samples: number;
    readonly at: Date;
  }

  export type CrossingEvent<V extends string> = CrossingBase & ([V] extends [never] ? unknown : { readonly value: V });

  export interface Source<E> extends Named { readonly _event?: E }

  export type StateMatch<S extends State> = S | readonly S[];

  export interface TriggerRef extends Named {
    readonly entity: 'trigger';
  }

  export interface Trigger<E> extends TriggerRef {
    on<E2>(source: Source<E2>): Trigger<E2>;
    create<A>(lane: LaneShape<A, State, unknown>, attrs: (event: E) => A | undefined): Trigger<E>;
    signal<P>(
      signal: Signal<string, P>,
      lane: LaneRef,
      target: (event: E) => { readonly key: string; readonly payload: P } | undefined,
    ): Trigger<E>;
    record(journal: Journal, item: (event: E) => MemoryDraft | undefined): Trigger<E>;
    pause(lane: LaneRef, reason: (event: E) => string): Trigger<E>;
    resume(lane: LaneRef, reason: (event: E) => string): Trigger<E>;
  }

  export interface Sample extends Dimensions { readonly hit: boolean }
  export interface Amount extends Dimensions { readonly amount: number }

  export interface MetricDraft<E> extends Named {
    samples(extract: (event: E) => readonly Sample[]): MetricRef<'rate'>;
    amounts(extract: (event: E) => readonly Amount[]): MetricRef<'total'>;
  }

  export interface AdmitCtx<A> {
    readonly unit: UnitView<A>;
    readonly count: (lanes: LaneRef | readonly LaneRef[], ...positions: Position[]) => number;
    readonly metrics: Metrics;
  }

  export interface Scheduler extends Named {
    expedite(lane: LaneRef, options?: { readonly holds?: readonly LaneRef[] }): Scheduler;
    fixedDate<A>(lane: LaneShape<A, State, unknown>, due: (unit: UnitView<A>) => Date): Scheduler;
    standard(...lanes: LaneRef[]): Scheduler;
    wip(lanes: LaneRef | readonly LaneRef[], maxActive: number): Scheduler;
    aging(lane: LaneRef, aging: { readonly afterMinutes: number }): Scheduler;
    admit<A>(lane: LaneShape<A, State, unknown>, gate: (ctx: AdmitCtx<A>) => boolean): Scheduler;
    lease<A, S extends State>(
      lane: LaneShape<A, S, unknown>,
      pick: (unit: UnitView<A, S>) => Lease | readonly Lease[],
    ): Scheduler;
    order<A, S extends State>(
      lane: LaneShape<A, S, unknown>,
      order: {
        readonly after: (attrs: A) => string | undefined;
        readonly onPredecessorFailed: WaitingState<S>;
      },
    ): Scheduler;
  }

  export interface Operation<I, O> extends Named {
    readonly _io?: { readonly in: (input: I) => void; readonly out: O };
  }

  export type Grant = Operation<never, unknown>;

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
    state<N extends string, P extends 'pending' | 'waiting'>(name: N, position: P): State<N, P>;
    terminal<N extends string>(name: N, verdict: Verdict): State<N, 'terminal'>;
    signal<N extends string>(name: N): Signal<N, Empty>;
    halt<N extends string>(name: N): Halt<N, Empty>;
    resource(name: string): Resource;
    resources<const V extends string>(name: string, values: readonly V[]): ResourceFamily<V>;
    facet<const V extends string>(name: string, values: readonly V[]): Facet<V>;
    role(name: string): Role;
    memory(name: string, trust: 'experience' | 'taste'): MemoryKind;
    readonly cancel: Signal<'cancel', { readonly reason?: string }>;
    readonly ceilingDecision: Schema<CeilingDecision>;
    retry(retry: Retry): Retry;

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
    batch<O>(seat: Seat<O, string, true>): Job<readonly AgentTask[], readonly O[]>;
    seat(name: string): Seat<string, never, false>;
    pool(name: string): Pool<never>;
    readonly policy: {
      model<V extends string, B extends boolean>(
        name: string,
        candidates: readonly Model<V, B>[],
        choose: (ctx: PolicyCtx) => NoInfer<Model<V, B>>,
      ): ModelPolicy<V, B>;
      lineup<V extends string, B extends boolean>(
        name: string,
        candidates: readonly Model<V, B>[],
        choose: (ctx: LineupCtx<NoInfer<V>, NoInfer<B>>) => readonly Assignment<NoInfer<V>, NoInfer<B>>[],
      ): Lineup<V, B>;
      account(name: string, choose: (ctx: AccountPolicyCtx) => AccountState | undefined): AccountPolicy;
      halt<A, S extends State, D>(
        name: string,
        kind: KindShape<A, S>,
        halt: Halt<string, D>,
      ): HaltPolicyDraft<A, D>;
    };

    flow(name: string): Flow<unknown, void, Empty, never, never>;
    lane<A, S extends State>(name: string, kind: KindShape<A, S>): Lane<A, S, Empty, never>;
    journal(name: string, of: MemoryKind): Journal;
    clock(name: string): Clock;
    readonly operator: OperatorSupplier;

    trigger(name: string): Trigger<never>;
    readonly when: {
      transition<A, S extends State, St>(
        lane: LaneShape<A, S, St>,
        filter?: {
          readonly to?: StateMatch<NoInfer<S>>;
          readonly if?: (event: TransitionEvent<A, S>) => boolean;
        },
      ): Source<TransitionEvent<A, S>>;
      pattern<A, S extends State, St, G extends string>(
        lane: LaneShape<A, S, St>,
        pattern: {
          readonly to: StateMatch<NoInfer<S>>;
          readonly consecutive: number;
          readonly per: (unit: UnitView<A, S>) => G;
        },
      ): Source<PatternEvent<A, S, G>>;
      timer<A, S extends State, St, K extends keyof A = never>(
        lane: LaneShape<A, S, St>,
        timer: {
          readonly reads?: readonly K[];
          readonly at: (view: TimerView<Pick<A, K>>) => Date | undefined;
        },
      ): Source<UnitEvent<A, S>>;
      sweep<A, S extends State, St>(
        lane: LaneShape<A, S, St>,
        sweep: { readonly every: Clock; readonly in: StateMatch<NoInfer<S>> },
      ): Source<UnitEvent<A, S>>;
      step<A, S extends State, St, M extends keyof St & string>(
        lane: LaneShape<A, S, St>,
        step: M,
        filter?: { readonly if?: (event: StepEvent<A, St[M]>) => boolean },
      ): Source<StepEvent<A, St[M]>>;
      decision<A, S extends State, D>(kind: KindShape<A, S>, halt: Halt<string, D>): Source<DecisionEvent<A, S, D>>;
      invocation(filter: { readonly lanes: readonly LaneRef[] }): Source<InvocationEvent>;
      crossing<V extends string = never>(
        metric: MetricRef<'rate'>,
        band: Band<V>,
        edge: 'entered' | 'exited',
      ): Source<CrossingEvent<V>>;
    };
    metric<E>(name: string, source: Source<E>): MetricDraft<E>;
    scheduler(name: string): Scheduler;

    operation<O>(name: string, exec: Executable<void, O>): Operation<void, O>;
    readonly ops: {
      readonly workRead: Grant;
      readonly workCreate: Grant;
      readonly workUpdate: Grant;
      readonly workMove: Grant;
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
      resolve(...halts: HaltRef[]): Grant;
    };
    harness(name: string): Harness;
  };
}

declare module 'harness-dsl/sqlite' {
  import { Ledger, Store, QuotaPartition } from 'harness-dsl';
  export const sqlite: {
    ledger(options: { readonly path: string }): Ledger;
    store(options: { readonly path: string }): Store;
    quota(name: string, options: { readonly path: string }): QuotaPartition;
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
  export interface SupervisorSession extends Named {
    readonly endpoints: readonly Client[];
  }
  export const claudeCode: {
    subscription(name: string, options: { readonly token: EnvRef; readonly quota: QuotaPartition }): Account<'claude-code'>;
    apiKey(name: string, options: { readonly apiKey: EnvRef; readonly quota: QuotaPartition }): Account<'claude-code'>;
    model(name: string, options: { readonly id: string }): Model<'claude-code', false>;
    supervisor(name: string, options: { readonly grants: readonly Grant[]; readonly port?: PortRef }): Client;
    session(name: string, options: { readonly endpoints: readonly Client[] }): SupervisorSession;
  };
}

declare module 'harness-dsl/anthropic' {
  import { Account, Model, EnvRef, QuotaPartition } from 'harness-dsl';
  export const anthropic: {
    account(name: string, options: { readonly apiKey: EnvRef; readonly quota: QuotaPartition }): Account<'anthropic'>;
    model(name: string, options: { readonly id: string }): Model<'anthropic', true>;
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
    store<const M extends string>(options: { readonly apiKey: EnvRef; readonly team: string; readonly workflow: readonly M[] }): Store<M>;
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
