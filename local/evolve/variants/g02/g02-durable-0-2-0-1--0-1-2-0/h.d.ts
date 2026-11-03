declare module 'harness-dsl' {
  import { z } from 'zod';
  import {
    Named,
    EnvRef,
    PortRef,
    Verdict,
    State,
    UnitView,
    WorkRef,
    KindRef,
    RoleRef,
    ResourceRef,
    HaltRef,
    SeatRef,
    JobRef,
    FacetRef,
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
  } from 'harness-dsl/kernel';
  export * from 'harness-dsl/kernel';

  export type Schema<T> = z.ZodType<T>;
  export type Empty = { readonly [K in never]: never };

  export type PendingState<S extends State> = Extract<S, State<string, 'pending'>>;
  export type WaitingState<S extends State> = Extract<S, State<string, 'waiting'>>;
  export type StateMatch<S extends State> = S | readonly S[];

  export interface KindShape<A, S extends State> extends WorkRef<S> {
    readonly entity: 'kind';
    readonly _attrs?: A;
  }

  export interface Kind<A, S extends State> extends KindShape<A, S> {
    attributes<A2 extends object>(schema: Schema<A2>): Kind<A2, S>;
    states<S2 extends State[]>(...states: S2): Kind<A, S2[number]>;
    key(identity: (attrs: A) => string): Kind<A, S>;
  }

  export interface Signal<P = unknown> extends Named {
    readonly entity: 'signal';
    readonly _payload?: P;
    payload<P2>(schema: Schema<P2>): Signal<P2>;
  }

  export interface Halt<D = unknown> extends HaltRef {
    readonly _decision?: D;
    decision<D2>(schema: Schema<D2>): Halt<D2>;
  }

  export interface Resource extends ResourceRef {}

  export interface Facet<V extends string> extends FacetRef {
    of(value: V): FacetValue<V>;
  }

  export interface Executable<I, O> extends Named {
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
  }

  export interface Runner extends Named {
    readonly backend: RunnerBackend;
    slots(count: number): Runner;
  }

  export type Intent = 'read' | 'edit' | 'run' | 'search' | 'browse' | 'record';

  export interface Role extends RoleRef {
    intents(...intents: Intent[]): Role;
    instructions(text: string): Role;
  }

  export interface AgentTask {
    readonly task: string;
    readonly resources?: readonly ResourceRef[];
    readonly skills?: readonly string[];
  }

  export interface Guard {
    readonly leaseFiles?: boolean;
    readonly beforeStop?: Executable<void, unknown>;
  }

  export interface Seat<O> extends Executable<AgentTask, O>, SeatRef {
    role(role: Role): Seat<O>;
    model(model: Model | ModelPolicy): Seat<O>;
    pool(pool: Pool): Seat<O>;
    output<O2>(schema: Schema<O2>): Seat<O2>;
    workspace(workspace: Workspace, guard?: Guard): Seat<O>;
  }

  export interface PolicyCtx {
    readonly kind: KindRef;
    readonly seat: SeatRef;
    readonly metrics: Metrics;
  }

  export interface ModelPolicy extends Policy<PolicyCtx, Model> {
    readonly candidates: readonly Model[];
  }

  export interface AccountPolicyCtx {
    readonly candidates: readonly AccountState[];
    readonly now: Date;
  }

  export type AccountPolicy = Policy<AccountPolicyCtx, AccountState | undefined>;

  export interface HaltPolicyCtx<A> {
    readonly unit: UnitView<A>;
    readonly facets: readonly FacetValue[];
    readonly metrics: Metrics;
  }

  export interface HaltPolicy<A, D> extends Policy<HaltPolicyCtx<A>, D | undefined> {
    readonly halt: HaltRef;
  }

  export interface Pool extends Named {
    accounts(...accounts: Account[]): Pool;
    share(account: Account, fraction: number): Pool;
    drain(policy: AccountPolicy): Pool;
    fallback(account: Account): Pool;
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
  }

  export interface ChildResult {
    readonly unitId: string;
    readonly state: State;
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
      halt: Halt<D>,
      options: HaltOptions<In, P, St, NoInfer<D>> & { readonly when: (ctx: FlowCtx<In, P, St>) => boolean },
    ): Flow<In, P, St & { readonly [K in M]: D | undefined }, X, N | M>;
    halt<M extends string, D>(
      name: M,
      halt: Halt<D>,
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
    job<M extends string, O>(
      name: M,
      seat: Seat<O>,
      input: (ctx: FlowCtx<In, P, St>) => readonly AgentTask[],
    ): Flow<In, P, St & { readonly [K in M]: readonly O[] }, X, N | M>;
    spawn<M extends string, A2>(
      name: M,
      lane: LaneShape<A2, State, unknown>,
      children: (ctx: FlowCtx<In, P, St>) => readonly A2[],
    ): Flow<In, P, St & { readonly [K in M]: readonly ChildResult[] }, X, N | M>;
    loop<M extends string, F, St2, X2 extends string, N2 extends string>(
      name: M,
      feedback: Schema<F>,
      body: (flow: Flow<In, P, St & { readonly [K in M]: readonly F[] }, X, N>) => Flow<In, P, St2, X2, N2>,
      bounds: {
        readonly max: number | ((ctx: FlowCtx<In, P, St>) => number);
        readonly until?: (ctx: FlowCtx<In, P, St2>) => boolean;
        readonly feed: (ctx: FlowCtx<In, P, St2>) => NoInfer<F>;
      },
    ): Flow<In, P, St2, X2, N2>;
    exit<M extends string>(
      name: M,
      when?: (ctx: FlowCtx<In, P, St>) => boolean,
    ): Flow<In, P, St, X | M, N>;
  }

  export interface LaneShape<A, S extends State, St> extends WorkRef<S> {
    readonly entity: 'lane';
    readonly _types?: { readonly attrs: A; readonly steps: St };
  }

  export type LaneRef = LaneShape<unknown, State, unknown>;

  export type InputFits<A, I> = [A] extends [I] ? unknown : { readonly flowInputDoesNotFitKind: I };

  export interface Reaction<A, S extends State, N extends string, P> {
    readonly update?: (attrs: A, payload: P) => A;
    readonly rewind?: N;
    readonly enter?: S;
    readonly at?: readonly N[];
  }

  export interface Route { readonly route: 'create' | 'signal' | 'skip' }

  export interface Router<A> {
    create(attrs: A): Route;
    signal<P>(signal: Signal<P>, key: string, payload: P): Route;
    skip(): Route;
  }

  export interface OperatorSupplier extends Named { readonly operator: true }

  export interface Lease {
    readonly resource: Resource;
    readonly mode: 'exclusive' | 'shared';
  }

  export interface StoreMap<S extends State, M extends string> {
    readonly states: { readonly [K in S['name']]: M };
    readonly inFlight: M;
  }

  export interface Lane<A, S extends State, St, N extends string> extends LaneShape<A, S, St> {
    readonly _names?: N;
    supply(supplier: OperatorSupplier): Lane<A, S, St, N>;
    supply<E>(
      supplier: Supplier<E>,
      route: (event: E, to: Router<A>) => Route | readonly Route[],
    ): Lane<A, S, St, N>;
    handler<I, St2, X extends string, N2 extends string>(
      flow: Flow<I, void, St2, X, N2>,
      map: { readonly exits: { readonly [K in X]: S } } & InputFits<A, I>,
    ): Lane<A, S, St2, N2>;
    handler<I, P, St2, X extends string, N2 extends string>(
      flow: Flow<I, P, St2, X, N2>,
      map: { readonly exits: { readonly [K in X]: S }; readonly params: P } & InputFits<A, I>,
    ): Lane<A, S, St2, N2>;
    store(store: Store): Lane<A, S, St, N>;
    store<M extends string>(store: Store<M>, map: StoreMap<S, M>): Lane<A, S, St, N>;
    retry(retry: Retry & { readonly exhausted: S }): Lane<A, S, St, N>;
    lease(pick: (unit: UnitView<A, S>) => Lease): Lane<A, S, St, N>;
    after(order: {
      readonly key: (attrs: A) => string | undefined;
      readonly onPredecessorFailed: WaitingState<S>;
    }): Lane<A, S, St, N>;
    on<P>(signal: Signal<P>, reaction: Reaction<A, S, N, P>): Lane<A, S, St, N>;
    ceiling(ceiling: { readonly maxUsd: number; readonly halt: Halt<CeilingDecision> }): Lane<A, S, St, N>;
  }

  export interface Tick { readonly at: Date }
  export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
  export interface CalendarOptions {
    readonly on?: Weekday | number;
    readonly tz?: string;
  }

  export interface Clock extends Supplier<Tick> {
    every(interval: { readonly minutes: number }): Clock;
    at(time: string, options?: CalendarOptions): Clock;
  }

  export interface Assignments {
    modelOf(seat: SeatRef): Model | undefined;
  }

  export interface TransitionEvent<A, S extends State> {
    readonly unit: UnitView<A, S>;
    readonly attempt?: { readonly durationMs: number; readonly costUsd: number };
    readonly at: Date;
  }

  export interface PatternEvent<A, S extends State, K extends string> extends TransitionEvent<A, S> {
    readonly group: K;
    readonly streak: number;
  }

  export interface TimerEvent<A, S extends State> {
    readonly unit: UnitView<A, S>;
    readonly at: Date;
  }

  export interface StepEvent<A, S extends State, O> extends Assignments {
    readonly unit: UnitView<A, S>;
    readonly ok: boolean;
    readonly output?: O;
  }

  export interface DecisionEvent<A, S extends State, D> extends Assignments {
    readonly unit: UnitView<A, S>;
    readonly decision: D;
    readonly resolvedBy: ResolvedBy;
    readonly facets: readonly FacetValue[];
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

  export interface CrossingEvent<V> {
    readonly value: V;
    readonly rate: number;
    readonly hits: number;
    readonly samples: number;
  }

  export interface Source<E> extends Named { readonly _event?: E }

  export interface TriggerRef extends Named {
    readonly entity: 'trigger';
  }

  export interface Trigger<E> extends TriggerRef {
    on<E2>(source: Source<E2>): Trigger<E2>;
    create<A>(lane: LaneShape<A, State, unknown>, attrs: (event: E) => A | undefined): Trigger<E>;
    signal<P>(
      signal: Signal<P>,
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
    readonly metrics: Metrics;
  }

  export interface Scheduler extends Named {
    expedite(lane: LaneRef, options?: { readonly holds?: readonly LaneRef[] }): Scheduler;
    fixedDate<A>(lane: LaneShape<A, State, unknown>, due: (unit: UnitView<A>) => Date): Scheduler;
    standard(...lanes: LaneRef[]): Scheduler;
    wip(lanes: LaneRef | readonly LaneRef[], maxActive: number): Scheduler;
    aging(lane: LaneRef, aging: { readonly afterMinutes: number }): Scheduler;
    admit<A>(lane: LaneShape<A, State, unknown>, gate: (ctx: AdmitCtx<A>) => boolean): Scheduler;
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
    nextTime(at: string, options: CalendarOptions & { readonly after: Date }): Date;

    kind(name: string): Kind<Empty, never>;
    state<N extends string, P extends 'pending' | 'waiting'>(name: N, position: P): State<N, P>;
    terminal<N extends string>(name: N, verdict: Verdict): State<N, 'terminal'>;
    signal(name: string): Signal<Empty>;
    halt(name: string): Halt<Empty>;
    resource(name: string): Resource;
    facet<V extends string>(name: string, values: Schema<V>): Facet<V>;
    role(name: string): Role;
    memory(name: string, trust: 'experience' | 'taste'): MemoryKind;
    readonly cancel: Signal<{ readonly reason?: string }>;
    readonly ceilingDecision: Schema<CeilingDecision>;

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
      model(name: string, candidates: readonly Model[], choose: (ctx: PolicyCtx) => Model): ModelPolicy;
      account(name: string, choose: (ctx: AccountPolicyCtx) => AccountState | undefined): AccountPolicy;
      halt<A, S extends State, D>(
        name: string,
        kind: KindShape<A, S>,
        halt: Halt<D>,
        decide: (ctx: HaltPolicyCtx<A>) => NoInfer<D> | undefined,
      ): HaltPolicy<A, D>;
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
      pattern<A, S extends State, St, K extends string>(
        lane: LaneShape<A, S, St>,
        pattern: {
          readonly to: StateMatch<NoInfer<S>>;
          readonly consecutive: number;
          readonly per: (unit: UnitView<A, S>) => K;
        },
      ): Source<PatternEvent<A, S, K>>;
      timer<A, S extends State, St>(
        lane: LaneShape<A, S, St>,
        timer: {
          readonly in: StateMatch<NoInfer<S>>;
          readonly at: (unit: UnitView<A, S>) => Date | undefined;
        },
      ): Source<TimerEvent<A, S>>;
      step<A, S extends State, St, M extends keyof St & string>(
        lane: LaneShape<A, S, St>,
        step: M,
        filter?: { readonly if?: (event: StepEvent<A, S, St[M]>) => boolean },
      ): Source<StepEvent<A, S, St[M]>>;
      decision<A, S extends State, D>(kind: KindShape<A, S>, halt: Halt<D>): Source<DecisionEvent<A, S, D>>;
      invocation(filter: { readonly lanes: readonly LaneRef[] }): Source<InvocationEvent>;
      crossing<V extends string>(
        metric: MetricRef<'rate'>,
        band: Band & { readonly per: Facet<V> },
        edge: 'entered' | 'exited',
      ): Source<CrossingEvent<V>>;
      crossing(metric: MetricRef<'rate'>, band: Band, edge: 'entered' | 'exited'): Source<CrossingEvent<undefined>>;
    };
    metric<E>(name: string, source: Source<E>): MetricDraft<E>;
    scheduler(name: string): Scheduler;

    operation<O>(name: string, exec: Executable<void, O>): Operation<void, O>;
    readonly ops: {
      readonly workRead: Grant;
      readonly workCreate: Grant;
      readonly workUpdate: Grant;
      readonly workCancel: Grant;
      readonly attemptsRecover: Grant;
      readonly memoryRead: Grant;
      readonly memoryWrite: Grant;
      readonly memoryCurate: Grant;
      readonly telemetryRead: Grant;
      readonly accountsShare: Grant;
      resolve(...halts: Halt<unknown>[]): Grant;
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
    subscription(name: string, options: { readonly token: EnvRef; readonly quota: QuotaPartition }): Account;
    model(name: string, options: { readonly id: string }): Model;
    supervisor(name: string, options: { readonly grants: readonly Grant[]; readonly port: PortRef }): Client;
    session(name: string, options: { readonly endpoints: readonly Client[] }): SupervisorSession;
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
    issues(options: { readonly apiKey: EnvRef; readonly team: string; readonly labels: readonly string[] }): Supplier<LinearIssue>;
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
