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
  } from 'harness-dsl/kernel';
  export * from 'harness-dsl/kernel';

  export type Schema<T> = z.ZodType<T>;
  export type Empty = { readonly [K in never]: never };

  export interface KindShape<A, S extends State> extends WorkRef<S['name']> {
    readonly entity: 'kind';
    readonly _types?: { readonly attrs: A; readonly states: S };
  }

  export interface Kind<N extends string, A, S extends State> extends KindShape<A, S> {
    readonly name: N;
    attributes<A2 extends object>(schema: Schema<A2>): Kind<N, A2, S>;
    states<S2 extends State[]>(...states: S2): Kind<N, A, S2[number]>;
    key(identity: (attrs: A) => string): Kind<N, A, S>;
    initial(state: S): Kind<N, A, S>;
    onAttemptFailed(state: S): Kind<N, A, S>;
    onCancelled(state: S): Kind<N, A, S>;
  }

  export interface Signal<N extends string = string, P = unknown> extends Named {
    readonly name: N;
    readonly _payload?: P;
    payload<P2>(schema: Schema<P2>): Signal<N, P2>;
  }

  export interface Executable<I, O> extends Named {
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

  export interface Role extends Named {
    intents(...intents: Intent[]): Role;
    instructions(text: string): Role;
  }

  export interface AgentTask {
    readonly task: string;
    readonly resources?: readonly string[];
    readonly skills?: readonly string[];
  }

  export interface Guard { readonly guard: 'lease' | 'beforeStop' }

  export interface Agent<O> extends Executable<AgentTask, O> {
    role(role: Role): Agent<O>;
    model(model: Model | ModelPolicy): Agent<O>;
    pool(pool: Pool): Agent<O>;
    output<O2>(schema: Schema<O2>): Agent<O2>;
    workspace(workspace: Workspace): Agent<O>;
    guards(...guards: Guard[]): Agent<O>;
    batch(): Executable<readonly AgentTask[], readonly O[]>;
  }

  export interface PolicyCtx {
    readonly kind: WorkRef;
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
  }

  export interface ChildResult {
    readonly unitId: string;
    readonly state: string;
    readonly verdict: Verdict;
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
      halt: {
        readonly ask: (ctx: FlowCtx<In, P, St>) => string;
        readonly decision: Schema<D>;
        readonly skip?: (ctx: FlowCtx<In, P, St>) => NoInfer<D> | undefined;
      },
    ): Flow<In, P, St & { readonly [K in M]: D }, X, N | M>;
    wait<M extends string>(
      name: M,
      wait: { readonly ms: number },
    ): Flow<In, P, St & { readonly [K in M]: Date }, X, N | M>;
    spawn<M extends string, A2>(
      name: M,
      lane: LaneShape<A2, State, unknown>,
      children: (ctx: FlowCtx<In, P, St>) => readonly A2[],
    ): Flow<In, P, St & { readonly [K in M]: readonly ChildResult[] }, X, N | M>;
    loop<M extends string, St2, X2 extends string, N2 extends string>(
      name: M,
      body: (flow: Flow<In, P, St, X, N>) => Flow<In, P, St2, X2, N2>,
      bounds: {
        readonly max?: number | ((ctx: FlowCtx<In, P, St>) => number);
        readonly until?: (ctx: FlowCtx<In, P, St2>) => boolean;
      },
    ): Flow<In, P, St2, X2, N2 | M>;
    exit<M extends string>(
      name: M,
      when?: (ctx: FlowCtx<In, P, St>) => boolean,
    ): Flow<In, P, St, X | M, N>;
  }

  export interface LaneShape<A, S extends State, St> extends WorkRef<S['name']> {
    readonly entity: 'lane';
    readonly _types?: { readonly attrs: A; readonly states: S; readonly steps: St };
  }

  export type LaneRef = LaneShape<unknown, State, unknown>;

  export type ActiveState<S extends State> = Extract<S, State<string, 'active'>>;

  export interface HandlerMap<S extends State, X extends string, N extends string> {
    readonly exits: { readonly [K in X]: S };
    readonly during?: { readonly [K in N]?: ActiveState<S> };
  }

  export type InputFits<A, I> = [A] extends [I] ? unknown : { readonly flowInputDoesNotFitKind: I };

  export interface Reaction<A, S extends State, N extends string, P> {
    readonly update?: (attrs: A, payload: P) => A;
    readonly restart?: N;
    readonly enter?: S;
  }

  export interface Route { readonly route: 'create' | 'signal' | 'skip' }

  export interface Router<A, SN extends string> {
    create(attrs: A): Route;
    signal<P>(
      signal: Signal<string, P>,
      target: string | ((unit: UnitView<A, SN>) => boolean),
      payload: P,
    ): Route;
    skip(): Route;
  }

  export interface OperatorSupplier extends Named { readonly operator: true }

  export interface Lane<A, S extends State, St, N extends string> extends LaneShape<A, S, St> {
    readonly _types?: { readonly attrs: A; readonly states: S; readonly steps: St; readonly stepNames: N };
    supply(supplier: OperatorSupplier): Lane<A, S, St, N>;
    supply<E>(
      supplier: Supplier<E>,
      route: (event: E, to: Router<A, S['name']>) => Route | readonly Route[],
    ): Lane<A, S, St, N>;
    store(store: Store): Lane<A, S, St, N>;
    handler<I, St2, X extends string, N2 extends string>(
      flow: Flow<I, void, St2, X, N2>,
      map: HandlerMap<S, X, N2> & InputFits<A, I>,
    ): Lane<A, S, St2, N2>;
    handler<I, P, St2, X extends string, N2 extends string>(
      flow: Flow<I, P, St2, X, N2>,
      map: HandlerMap<S, X, N2> & { readonly params: P } & InputFits<A, I>,
    ): Lane<A, S, St2, N2>;
    on<P>(signal: Signal<string, P>, reaction: Reaction<A, S, N, P>): Lane<A, S, St, N>;
    ceiling(ceiling: { readonly maxUsd: number; readonly onExceed: 'halt' | 'fail' }): Lane<A, S, St, N>;
  }

  export interface Tick { readonly at: Date }
  export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

  export interface Clock extends Supplier<Tick> {
    every(interval: { readonly minutes: number }): Clock;
    at(time: string, options?: { readonly on?: Weekday | number; readonly tz?: string }): Clock;
  }

  export interface TransitionEvent<A, SN extends string = string> {
    readonly unit: UnitView<A, SN>;
    readonly to: SN;
    readonly attempt?: { readonly durationMs: number };
    readonly at: Date;
  }

  export interface PatternEvent<A, SN extends string = string> extends TransitionEvent<A, SN> {
    readonly group: string;
    readonly streak: number;
  }

  export interface TimerEvent<A, SN extends string = string> {
    readonly unit: UnitView<A, SN>;
    readonly at: Date;
  }

  export interface StepEvent<A, O, St> {
    readonly unit: UnitView<A>;
    readonly ok: boolean;
    readonly output?: O;
    readonly outputs: { readonly [K in keyof St]?: St[K] };
    readonly models: { readonly [K in keyof St]?: string };
    readonly at: Date;
  }

  export interface InvocationEvent {
    readonly model?: string;
    readonly ok: boolean;
    readonly costUsd: number;
  }

  export type Threshold = { readonly below: number } | { readonly above: number };

  export interface CrossingEvent {
    readonly group: string;
    readonly edge: 'entered' | 'exited';
    readonly value: number;
    readonly samples: number;
  }

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
    pause(lane: LaneRef, reason: (event: E) => string | undefined): Trigger<E>;
    resume(lane: LaneRef, reason: (event: E) => string | undefined): Trigger<E>;
  }

  export interface Sample { readonly group: string; readonly hit: boolean }
  export interface Amount { readonly group: string; readonly amount: number }

  export interface MetricDraft<E> extends Named {
    samples(extract: (event: E) => readonly Sample[]): MetricRef<'rate'>;
    amounts(extract: (event: E) => readonly Amount[]): MetricRef<'total'>;
  }

  export interface AdmitCtx<A> {
    readonly unit: UnitView<A>;
    readonly active: (lane: LaneRef) => number;
    readonly pending: (lane: LaneRef) => number;
    readonly metrics: Metrics;
  }

  export interface Scheduler extends Named {
    priority(...lanes: LaneRef[]): Scheduler;
    wip(lane: LaneRef, maxActive: number): Scheduler;
    boost(lane: LaneRef, aging: { readonly afterMinutes: number }): Scheduler;
    rank<A>(lane: LaneShape<A, State, unknown>, key: (unit: UnitView<A>) => number): Scheduler;
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
    nextTime(at: string, options: { readonly after: Date; readonly tz?: string }): Date;

    kind<N extends string>(name: N): Kind<N, Empty, never>;
    state<N extends string, P extends 'pending' | 'active' | 'waiting'>(name: N, position: P): State<N, P>;
    terminal<N extends string>(name: N, verdict: Verdict): State<N, 'terminal'>;
    signal<N extends string>(name: N): Signal<N, Empty>;
    readonly cancel: Signal<'cancel', { readonly reason?: string }>;
    role(name: string): Role;
    memory(name: string, trust: 'experience' | 'taste'): MemoryKind;

    command(name: string): Command<void, CommandResult>;
    agent(name: string): Agent<string>;
    pool(name: string): Pool;
    readonly guard: {
      lease(): Guard;
      beforeStop(check: Executable<void, unknown>): Guard;
    };
    readonly policy: {
      model(name: string, candidates: readonly Model[], choose: (ctx: PolicyCtx) => Model): ModelPolicy;
      account(name: string, choose: (ctx: AccountPolicyCtx) => AccountState | undefined): AccountPolicy;
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
          readonly if?: (event: TransitionEvent<A, S['name']>) => boolean;
        },
      ): Source<TransitionEvent<A, S['name']>>;
      pattern<A, S extends State, St>(
        lane: LaneShape<A, S, St>,
        pattern: {
          readonly to: StateMatch<NoInfer<S>>;
          readonly consecutive: number;
          readonly per: (unit: UnitView<A, S['name']>) => string;
        },
      ): Source<PatternEvent<A, S['name']>>;
      timer<A, S extends State, St>(
        lane: LaneShape<A, S, St>,
        timer: { readonly at: (unit: UnitView<A, S['name']>) => Date | undefined },
      ): Source<TimerEvent<A, S['name']>>;
      step<A, S extends State, St, M extends keyof St & string>(
        lane: LaneShape<A, S, St>,
        step: M,
        filter?: { readonly if?: (event: StepEvent<A, St[M], St>) => boolean },
      ): Source<StepEvent<A, St[M], St>>;
      invocation(filter: { readonly lanes: readonly LaneRef[] }): Source<InvocationEvent>;
      crossing(
        metric: MetricRef<'rate'>,
        crossing: {
          readonly window: Window;
          readonly minSamples: number;
          readonly enter: Threshold;
          readonly exit: Threshold;
          readonly groups?: (group: string) => boolean;
        },
      ): Source<CrossingEvent>;
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
      readonly blockersResolve: Grant;
      readonly attemptsRecover: Grant;
      readonly lanesPause: Grant;
      readonly memoryRead: Grant;
      readonly memoryWrite: Grant;
      readonly memoryCurate: Grant;
      readonly telemetryRead: Grant;
      readonly accountsRead: Grant;
      readonly accountsShare: Grant;
    };
    harness(name: string): Harness;
  };
}

declare module 'harness-dsl/sqlite' {
  import { Ledger, Store, Supplier, Clock, JsonObject } from 'harness-dsl';
  export interface StoredUnit {
    readonly key: string;
    readonly kind: string;
    readonly state: string;
    readonly attributes: JsonObject;
  }
  export const sqlite: {
    ledger(options: { readonly path: string; readonly quotaPath?: string }): Ledger;
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
  import { MemoryStore, EnvRef } from 'harness-dsl';
  export const pgvector: {
    memoryStore(options: {
      readonly url: EnvRef;
      readonly table: string;
      readonly embeddingModel: string;
    }): MemoryStore;
  };
}

declare module 'harness-dsl/claude-code' {
  import { Account, Model, Client, Grant, EnvRef } from 'harness-dsl';
  export const claudeCode: {
    subscription(name: string, options: { readonly token: EnvRef }): Account;
    model(name: string, options: { readonly id: string }): Model;
    supervisor(name: string, options: {
      readonly grants: readonly Grant[];
      readonly endpoint?: string;
    }): Client;
  };
}

declare module 'harness-dsl/anthropic' {
  import { Account, Model, EnvRef } from 'harness-dsl';
  export const anthropic: {
    account(name: string, options: { readonly apiKey: EnvRef }): Account;
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
    issues(options: {
      readonly apiKey: EnvRef;
      readonly team: string;
      readonly labels?: readonly string[];
    }): Supplier<LinearIssue>;
    store(options: {
      readonly apiKey: EnvRef;
      readonly team: string;
      readonly states: Readonly<Record<string, string>>;
    }): Store;
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
    controlApi(name: string, options: {
      readonly port: PortRef;
      readonly token: EnvRef;
      readonly grants: readonly Grant[];
    }): Client;
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
