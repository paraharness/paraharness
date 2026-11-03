declare module 'harness-dsl' {
  import { z } from 'zod';

  export type Schema<T> = z.ZodType<T>;
  export type Empty = { readonly [K in never]: never };

  export interface EnvRef { readonly ref: 'env'; readonly name: string }
  export interface PortRef { readonly ref: 'port'; readonly slot: number }

  export type StepName<St> = keyof St & string;

  export type ActiveState<S> = Extract<S, { readonly position: 'active' }>;
  export type WaitingState<S> = Extract<S, { readonly position: 'waiting' }>;
  export type SettledState<S> = Extract<S, { readonly position: 'terminal' | 'waiting' }>;
  export type IdleState<S> = Exclude<S, { readonly position: 'active' }>;
  export type OpenState<S> = Exclude<S, { readonly position: 'terminal' }>;

  export interface KindShape<A, S extends State> {
    readonly entity: 'kind';
    readonly name: string;
    readonly _types?: { readonly attrs: A; readonly states: S };
  }

  export interface Kind<N extends string, A, S extends State> extends KindShape<A, S> {
    readonly name: N;
    attributes<A2 extends object>(schema: Schema<A2>): Kind<N, A2, S>;
    states<S2 extends readonly State[]>(...states: S2): Kind<N, A, S2[number]>;
    key(identity: (attrs: A) => string): Kind<N, A, S>;
  }

  export interface Signal<N extends string = string, P = unknown> extends Named {
    readonly entity: 'signal';
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
    env(vars: Readonly<Record<string, string | EnvRef>>): Command<I, O>;
  }

  export interface Runner extends Named {
    readonly backend: RunnerBackend;
    slots(count: number): Runner;
    preflight(check: Executable<void, unknown>): Runner;
  }

  export type Intent = 'read' | 'edit' | 'run' | 'search' | 'browse' | 'halt';

  export interface Role extends Named {
    readonly entity: 'role';
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
    output<O2>(schema: Schema<O2>): Agent<O2>;
    workspace(workspace: Workspace): Agent<O>;
    guards(...guards: Guard[]): Agent<O>;
    budgetTokens(tokens: number): Agent<O>;
    batch(): Executable<readonly AgentTask[], readonly O[]>;
  }

  export interface PolicyCtx {
    readonly lane: AnyLane;
    readonly unit: UnitView<unknown>;
    readonly metrics: Metrics;
    readonly now: Date;
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
    readonly entity: 'pool';
    accounts(...accounts: Account[]): Pool;
    share(account: Account, fraction: number): Pool;
    drain(policy: AccountPolicy): Pool;
    fallback(account: Account): Pool;
  }

  export interface MemoryKind<N extends string, B> extends Named {
    readonly entity: 'memoryKind';
    readonly name: N;
    readonly _body?: B;
    body<B2>(schema: Schema<B2>): MemoryKind<N, B2>;
    trust(trust: 'experience' | 'taste'): MemoryKind<N, B>;
  }

  export interface Recall extends Named { readonly by: 'specificity' | 'similarity' }

  export interface Journal<B> extends Named {
    readonly entity: 'journal';
    readonly _body?: B;
    store(store: MemoryStore): Journal<B>;
    recall(recall: Recall): Journal<B>;
    readBy(...roles: Role[]): Journal<B>;
    writtenBy(...roles: Role[]): Journal<B>;
  }

  export interface MemoryDraft<B> {
    readonly body: B;
    readonly when?: Scope;
    readonly status?: 'candidate' | 'active';
  }

  export interface Retry {
    readonly retries: number;
    readonly backoff: 'fixed' | 'exponential';
    readonly initialDelayMs: number;
    readonly maxDelayMs?: number;
  }

  export type AfterCrash<I> =
    | 'rerun'
    | 'park'
    | 'ask'
    | { readonly parkUnless: Executable<I, boolean> };

  export interface StepOptions<I> {
    readonly retry?: Retry;
    readonly timeoutMs?: number;
    readonly afterCrash?: AfterCrash<I>;
  }

  export interface FlowCtx<In, P, St> {
    readonly unit: UnitView<In>;
    readonly params: P;
    readonly steps: St;
    readonly iteration: number;
    readonly metrics: Metrics;
    readonly now: Date;
  }

  export interface ChildResult<S extends State> {
    readonly unitId: string;
    readonly state: S['name'];
    readonly verdict: Verdict;
  }

  export type Wait<In, P, St> =
    | { readonly ms: number }
    | { readonly until: (ctx: FlowCtx<In, P, St>) => Date };

  export interface Flow<In, P, St, X extends string, N extends string, W extends string> extends Named {
    readonly entity: 'flow';
    readonly _types?: {
      readonly input: (attrs: In) => void;
      readonly params: (params: P) => P;
      readonly steps: St;
      readonly exits: X;
      readonly stepNames: N;
      readonly waits: W;
    };
    input<In2>(schema: Schema<In2>): Flow<In2, P, St, X, N, W>;
    params<P2>(schema: Schema<P2>): Flow<In, P2, St, X, N, W>;
    step<M extends string, O>(
      name: M,
      exec: Executable<void, O>,
      options?: StepOptions<void>,
    ): Flow<In, P, St & { readonly [K in M]: O }, X, N | M, W>;
    step<M extends string, I, O>(
      name: M,
      exec: Executable<I, O>,
      input: (ctx: FlowCtx<In, P, St>) => I,
      options?: StepOptions<NoInfer<I>>,
    ): Flow<In, P, St & { readonly [K in M]: O }, X, N | M, W>;
    halt<M extends string, D>(
      name: M,
      halt: {
        readonly ask: (ctx: FlowCtx<In, P, St>) => string;
        readonly decision: Schema<D>;
        readonly skip?: (ctx: FlowCtx<In, P, St>) => NoInfer<D> | undefined;
      },
    ): Flow<In, P, St & { readonly [K in M]: D }, X, N | M, W>;
    await<M extends string, Pl>(
      name: M,
      signal: Signal<string, Pl>,
    ): Flow<In, P, St & { readonly [K in M]: Pl }, X, N | M, W | M>;
    wait<M extends string>(
      name: M,
      wait: Wait<In, P, St>,
    ): Flow<In, P, St & { readonly [K in M]: Date }, X, N | M, W | M>;
    spawn<M extends string, A2, S2 extends State>(
      name: M,
      lane: LaneShape<A2, S2, unknown>,
      children: (ctx: FlowCtx<In, P, St>) => readonly NoInfer<A2>[],
    ): Flow<In, P, St & { readonly [K in M]: readonly ChildResult<S2>[] }, X, N | M, W | M>;
    loop<M extends string, St2, X2 extends string, N2 extends string, W2 extends string>(
      name: M,
      body: (flow: Flow<In, P, St, X, N, W>) => Flow<In, P, St2, X2, N2, W2>,
      bounds: {
        readonly max?: number | ((ctx: FlowCtx<In, P, St>) => number);
        readonly until?: (ctx: FlowCtx<In, P, St2>) => boolean;
      },
    ): Flow<In, P, St2, X2, N2 | M, W2>;
    exit<M extends string>(
      name: M,
      when?: (ctx: FlowCtx<In, P, St>) => boolean,
    ): Flow<In, P, St, X | M, N, W>;
  }

  export interface LaneShape<A, S extends State, St> extends Named {
    readonly entity: 'lane';
    readonly _types?: { readonly attrs: A; readonly states: S; readonly steps: St };
  }

  export type AnyLane = LaneShape<unknown, State, unknown>;

  export type HandlerMap<S extends State, X extends string, N extends string, W extends string> = {
    readonly exits: { readonly [K in X]: SettledState<S> };
    readonly during?: { readonly [K in Exclude<N, W>]?: ActiveState<S> };
    readonly failure: IdleState<S>;
  } & ([W] extends [never]
    ? { readonly waits?: Empty }
    : { readonly waits: { readonly [K in W]: WaitingState<S> } });

  export type InputFits<A, In> = [A] extends [In] ? unknown : { readonly inputMismatch: never };

  export interface Reaction<A, S extends State, N extends string, P> {
    readonly update?: (attrs: A, payload: P) => A;
    readonly restart?: N;
    readonly enter?: S;
  }

  export interface Route { readonly route: 'create' | 'signal' | 'skip' }

  export interface Router<A, S extends State> {
    create(attrs: A, options?: { readonly state?: OpenState<S> }): Route;
    signal<P>(
      signal: Signal<string, P>,
      target: string | ((unit: UnitView<A, S['name']>) => boolean),
      payload: NoInfer<P>,
    ): Route;
    skip(): Route;
  }

  export interface OperatorSupplier extends Named { readonly operator: true }

  export interface Lane<A, S extends State, St, N extends string> extends LaneShape<A, S, St> {
    supply(supplier: OperatorSupplier): Lane<A, S, St, N>;
    supply<E>(
      supplier: Supplier<E>,
      route: (event: E, to: Router<A, S>) => Route | readonly Route[],
    ): Lane<A, S, St, N>;
    store(store: Store): Lane<A, S, St, N>;
    handler<In, St2, X extends string, N2 extends string, W extends string>(
      flow: Flow<In, void, St2, X, N2, W>,
      map: HandlerMap<S, X, N2, W> & InputFits<A, In>,
    ): Lane<A, S, St2, N2>;
    handler<In, P, St2, X extends string, N2 extends string, W extends string>(
      flow: Flow<In, P, St2, X, N2, W>,
      map: HandlerMap<S, X, N2, W> & { readonly params: P } & InputFits<A, In>,
    ): Lane<A, S, St2, N2>;
    on<P>(signal: Signal<string, P>, reaction: Reaction<A, S, N, P>): Lane<A, S, St, N>;
    ceiling(ceiling: { readonly maxUsd: number; readonly onExceed: 'halt' | 'fail' }): Lane<A, S, St, N>;
    unit(key: string): UnitRef;
  }

  export interface Tick { readonly at: Date }
  export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

  export interface Clock extends Supplier<Tick> {
    every(interval: { readonly minutes?: number; readonly hours?: number }): Clock;
    daily(at: string, options?: { readonly tz?: string }): Clock;
    weekly(day: Weekday, at: string, options?: { readonly tz?: string }): Clock;
    monthly(dayOfMonth: number, at: string, options?: { readonly tz?: string }): Clock;
  }

  export interface AttemptSummary {
    readonly id: string;
    readonly number: number;
    readonly outcome: AttemptOutcome;
    readonly durationMs: number;
    readonly costUsd: number;
  }

  export interface TransitionEvent<A, SN extends string, N extends string> {
    readonly unit: UnitView<A, SN, N>;
    readonly from: SN | undefined;
    readonly to: SN;
    readonly position: Position;
    readonly verdict?: Verdict;
    readonly attempt?: AttemptSummary;
    readonly at: Date;
  }

  export interface PatternEvent<A, SN extends string, N extends string> extends TransitionEvent<A, SN, N> {
    readonly group: string;
    readonly streak: number;
  }

  export interface TimerEvent<A, SN extends string, N extends string> {
    readonly unit: UnitView<A, SN, N>;
    readonly at: Date;
  }

  export interface StepEvent<A, O, SN extends string, St> {
    readonly unit: UnitView<A, SN, StepName<St>>;
    readonly step: StepName<St>;
    readonly ok: boolean;
    readonly output?: O;
    readonly steps: { readonly [K in StepName<St>]?: St[K] };
    readonly models: { readonly [K in StepName<St>]?: string };
    readonly costUsd: number;
    readonly durationMs: number;
    readonly at: Date;
  }

  export interface InvocationEvent {
    readonly unit: UnitView<unknown>;
    readonly lane: string;
    readonly step: string;
    readonly executable: string;
    readonly model?: string;
    readonly ok: boolean;
    readonly batch: boolean;
    readonly costUsd: number;
    readonly at: Date;
  }

  export interface CrossingEvent {
    readonly band: string;
    readonly direction: 'down' | 'up';
    readonly group: string;
    readonly rate: number;
    readonly samples: number;
    readonly at: Date;
  }

  export interface Source<E> extends Named { readonly _event?: E }

  export type StateMatch<S extends State> = S | Position | readonly (S | Position)[];

  export interface SignalTarget<P> {
    readonly unit: UnitRef;
    readonly payload: P;
  }

  export interface AnyTrigger extends Named {
    readonly entity: 'trigger';
  }

  export interface Trigger<E> extends AnyTrigger {
    on<E2>(source: Source<E2>): Trigger<E2>;
    create<A>(lane: LaneShape<A, State, unknown>, attrs: (event: E) => NoInfer<A> | undefined): Trigger<E>;
    signal<P>(signal: Signal<string, P>, target: (event: E) => SignalTarget<NoInfer<P>> | undefined): Trigger<E>;
    record<B>(journal: Journal<B>, item: (event: E) => MemoryDraft<NoInfer<B>> | undefined): Trigger<E>;
    pause(lane: AnyLane, reason: (event: E) => string): Trigger<E>;
    resume(lane: AnyLane, reason: (event: E) => string): Trigger<E>;
  }

  export interface Sample { readonly group: string; readonly success: boolean }

  export interface AnyMetric extends Named {
    readonly entity: 'metric';
  }

  export interface Metric<E> extends AnyMetric {
    from<E2>(source: Source<E2>): Metric<E2>;
    samples(extract: (event: E) => readonly Sample[]): Metric<E>;
  }

  export type Band = Named & { readonly entity: 'band' };

  export interface Budget extends Named {
    readonly entity: 'budget';
    maxUsd(usd: number): Budget;
    per(window: 'day' | 'week' | 'month', options?: { readonly tz?: string }): Budget;
    lanes(...lanes: AnyLane[]): Budget;
  }

  export interface AdmitCtx<A, SN extends string> {
    readonly unit: UnitView<A, SN>;
    readonly count: (lane: AnyLane, position: Position | readonly Position[]) => number;
    readonly budget: (budget: Budget) => { readonly spentUsd: number; readonly remainingUsd: number };
    readonly metrics: Metrics;
    readonly now: Date;
  }

  export interface Scheduler extends Named {
    readonly entity: 'scheduler';
    priority(...lanes: AnyLane[]): Scheduler;
    wip(lane: AnyLane, maxActive: number): Scheduler;
    boost(lane: AnyLane, aging: { readonly afterMinutes: number }): Scheduler;
    rank<A, S extends State>(lane: LaneShape<A, S, unknown>, key: (unit: UnitView<A, S['name']>) => number): Scheduler;
    admit<A, S extends State>(lane: LaneShape<A, S, unknown>, gate: (ctx: AdmitCtx<A, S['name']>) => boolean): Scheduler;
  }

  export interface Operation<I, O> extends Named {
    readonly entity: 'operation';
    readonly _io?: { readonly in: (input: I) => void; readonly out: O };
    input<I2>(schema: Schema<I2>): Operation<I2, O>;
    run<O2>(exec: Executable<I, O2>): Operation<I, O2>;
  }

  export type Grant = Operation<never, unknown>;

  export interface RunningHarness {
    readonly name: string;
    stop(): Promise<void>;
  }

  export interface Harness extends Named {
    readonly entity: 'harness';
    ledger(ledger: Ledger): Harness;
    pool(pool: Pool): Harness;
    lanes(...lanes: AnyLane[]): Harness;
    journals(...journals: Journal<unknown>[]): Harness;
    triggers(...triggers: AnyTrigger[]): Harness;
    metrics(...metrics: AnyMetric[]): Harness;
    budgets(...budgets: Budget[]): Harness;
    scheduler(scheduler: Scheduler): Harness;
    clients(...clients: Client[]): Harness;
    observers(...observers: Observer[]): Harness;
    start(): Promise<RunningHarness>;
  }

  export const H: {
    env(name: string): EnvRef;
    readonly slot: { port(slot: number): PortRef };
    nextTime(at: string, options: { readonly after: Date; readonly tz?: string }): Date;

    kind<N extends string>(name: N): Kind<N, Empty, never>;
    state<N extends string, P extends 'pending' | 'active' | 'waiting'>(name: N, position: P): State<N, P, undefined>;
    state<N extends string, V extends Verdict>(name: N, position: 'terminal', verdict: V): State<N, 'terminal', V>;
    signal<N extends string>(name: N): Signal<N, Empty>;
    readonly cancel: Signal<'cancel', { readonly reason?: string }>;
    role(name: string): Role;
    memory<N extends string>(name: N): MemoryKind<N, { readonly text: string }>;

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
    recall(name: string, options: {
      readonly by: 'specificity' | 'similarity';
      readonly limit: number;
      readonly minScore?: number;
    }): Recall;

    flow(name: string): Flow<unknown, void, Empty, never, never, never>;
    lane<A, S extends State>(name: string, kind: KindShape<A, S>): Lane<A, S, Empty, never>;
    journal<B>(name: string, of: MemoryKind<string, B>): Journal<B>;
    clock(name: string): Clock;
    readonly operator: OperatorSupplier;

    trigger(name: string): Trigger<never>;
    band(name: string, metric: AnyMetric, band: Window & {
      readonly below: number;
      readonly above: number;
      readonly minSamples: number;
    }): Band;
    readonly when: {
      transition<A, S extends State, St>(
        lane: LaneShape<A, S, St>,
        filter?: {
          readonly to?: StateMatch<NoInfer<S>>;
          readonly from?: StateMatch<NoInfer<S>>;
          readonly if?: (event: TransitionEvent<A, S['name'], StepName<St>>) => boolean;
        },
      ): Source<TransitionEvent<A, S['name'], StepName<St>>>;
      pattern<A, S extends State, St>(
        lane: LaneShape<A, S, St>,
        pattern: {
          readonly to: StateMatch<NoInfer<S>>;
          readonly consecutive: number;
          readonly per: (unit: UnitView<A, S['name']>) => string;
        },
      ): Source<PatternEvent<A, S['name'], StepName<St>>>;
      timer<A, S extends State, St>(
        lane: LaneShape<A, S, St>,
        timer: {
          readonly at: (unit: UnitView<A, S['name'], StepName<St>>) => Date;
          readonly if?: (unit: UnitView<A, S['name'], StepName<St>>) => boolean;
        },
      ): Source<TimerEvent<A, S['name'], StepName<St>>>;
      step<A, S extends State, St, M extends StepName<St>>(
        lane: LaneShape<A, S, St>,
        step: M,
        filter?: { readonly if?: (event: StepEvent<A, St[M], S['name'], St>) => boolean },
      ): Source<StepEvent<A, St[M], S['name'], St>>;
      invocation(lane?: AnyLane): Source<InvocationEvent>;
      crossing(band: Band, direction: 'down' | 'up'): Source<CrossingEvent>;
    };
    metric(name: string): Metric<never>;
    budget(name: string): Budget;
    scheduler(name: string): Scheduler;

    operation(name: string): Operation<void, void>;
    readonly ops: {
      readonly workRead: Grant;
      readonly workCreate: Grant;
      readonly workUpdate: Grant;
      readonly workCancel: Grant;
      readonly workSignal: Grant;
      readonly blockersResolve: Grant;
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
  import { Ledger, Store } from 'harness-dsl';
  export const sqlite: {
    ledger(options: { readonly path: string; readonly accountsPath?: string }): Ledger;
    store(options: { readonly path: string }): Store;
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
    readonly url: string;
    readonly parentId?: string;
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
    readonly frontmatter: Readonly<Record<string, unknown>>;
    readonly body: string;
  }
  export const folder: {
    files(options: { readonly path: string; readonly glob?: string }): Supplier<FolderFile>;
    frontmatter(options: { readonly path: string }): Store;
  };
}

declare module 'harness-dsl/git' {
  import { Workspace } from 'harness-dsl';
  export const git: {
    worktree(options: { readonly repo: string; readonly base?: string }): Workspace;
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
    readonly type: 'created' | 'replied' | 'closed' | 'updated';
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
    readonly updatedAt: Date;
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
  import { Observer, EnvRef, AnyLane } from 'harness-dsl';
  export const slack: {
    notifier(name: string, options: { readonly webhookUrl: EnvRef; readonly lanes?: readonly AnyLane[] }): Observer;
  };
}
