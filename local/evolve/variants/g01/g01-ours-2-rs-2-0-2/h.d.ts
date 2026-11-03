declare module 'harness-dsl' {
  import { z } from 'zod';
  import type * as K from 'harness-dsl/kernel';

  export type Duration = K.Duration;
  export type UnitView<D> = K.UnitView<D>;

  export interface State<N extends string = string, P extends K.Position = K.Position> extends K.EntityRef<'state'> {
    readonly name: N;
    readonly position: P;
    readonly verdict: K.Verdict | undefined;
  }

  export interface StateBuilder<N extends string> {
    pending(): State<N, 'pending'>;
    active(): State<N, 'active'>;
    waiting(): State<N, 'waiting'>;
    terminal(verdict: K.Verdict): State<N, 'terminal'>;
  }

  export interface WorkKind<D = unknown, St extends State = never> extends K.EntityRef<'work'> {
    readonly __data?: D;
    readonly __states?: St;
    schema<S extends z.ZodType>(schema: S): WorkKind<z.output<S>, St>;
    states<T extends State[]>(...states: T): WorkKind<D, T[number]>;
  }

  export interface Resource extends K.EntityRef<'resource'> {}

  export interface Lease {
    readonly resource: Resource;
    readonly mode: K.LeaseMode;
  }

  export interface Halt<C = void, D = unknown> extends K.EntityRef<'halt'> {
    readonly __context?: (context: C) => void;
    readonly __decision?: D;
    context<S extends z.ZodType>(schema: S): Halt<z.output<S>, D>;
    ask(question: string | ((context: C) => string)): Halt<C, D>;
    decision<S extends z.ZodType>(schema: S): Halt<C, z.output<S>>;
  }

  export interface MemoryKind<C = unknown> extends K.EntityRef<'memory'> {
    readonly __content?: C;
    content<S extends z.ZodType>(schema: S): MemoryKind<z.output<S>>;
    trust(trust: K.Trust): MemoryKind<C>;
  }

  export interface Role extends K.EntityRef<'role'> {
    prompt(text: string): Role;
    promptFile(path: string): Role;
    intents(intents: readonly K.Intent[]): Role;
    recall(...kinds: ReadonlyArray<K.EntityRef<'memory'>>): Role;
    record(...kinds: ReadonlyArray<K.EntityRef<'memory'>>): Role;
    use(...plugins: readonly K.AgentPlugin[]): Role;
  }

  export interface Skill<I = void, O = unknown> extends K.EntityRef<'skill'> {
    readonly __io?: { readonly input: (input: I) => void; readonly output: O };
    input<S extends z.ZodType>(schema: S): Skill<z.output<S>, O>;
    output<S extends z.ZodType>(schema: S): Skill<I, z.output<S>>;
    prompt(render: (input: I) => string): Skill<I, O>;
    assert(check: (output: O, input: I) => true | string): Skill<I, O>;
    maxRetries(retries: number): Skill<I, O>;
  }

  export interface Facet extends K.EntityRef<'facet'> {}

  export interface Account extends K.EntityRef<'account'> {
    maxQuotaShare(share: number): Account;
    quota(partition: K.QuotaPartition): Account;
  }

  export interface ModelOptions {
    readonly contextTokens?: number;
    readonly maxOutputTokens?: number;
    readonly effort?: 'low' | 'medium' | 'high';
  }

  export interface Model extends K.ModelRef {
    pricing(pricing: K.Pricing): Model;
  }

  export interface Runner extends K.EntityRef<'runner'> {
    readonly slots: number;
    env(variables: Readonly<Record<string, K.Setting>>): Runner;
  }

  export interface Executable<I, O> {
    readonly entity: 'command' | 'job' | 'call';
    readonly name: string;
    readonly __io?: { readonly input: (input: I) => void; readonly output: O };
  }

  export interface Command<I = void, O = void> extends Executable<I, O> {
    readonly entity: 'command';
    input<S extends z.ZodType>(schema: S): Command<z.output<S>, O>;
    output<S extends z.ZodType>(schema: S): Command<I, z.output<S>>;
    runner(runner: Runner): Command<I, O>;
    effect(effect: K.Effect): Command<I, O>;
    detect(probe: (input: I, ctx: K.CommandContext) => Promise<O | undefined>): Command<I, O>;
    run(body: (input: I, ctx: K.CommandContext) => Promise<O>): Command<I, O>;
  }

  export interface Job<I = void, O = void> extends Executable<I, O> {
    readonly entity: 'job';
    input<S extends z.ZodType>(schema: S): Job<z.output<S>, O>;
    output<S extends z.ZodType>(schema: S): Job<I, z.output<S>>;
    submit(body: (input: I, ctx: K.CommandContext) => Promise<string>): Job<I, O>;
    collect(body: (ref: string, ctx: K.CommandContext) => Promise<K.JobStatus<O>>): Job<I, O>;
    poll(every: Duration): Job<I, O>;
  }

  export interface Call<I, O> extends Executable<I, O> {
    readonly entity: 'call';
    readonly seat: K.EntityRef<'seat'>;
    readonly skill: K.EntityRef<'skill'>;
  }

  export interface Batch<I, O> extends Executable<readonly I[], readonly O[]> {
    readonly entity: 'job';
    readonly seat: K.EntityRef<'seat'>;
    readonly skill: K.EntityRef<'skill'>;
  }

  export interface Policy<I, O> extends K.EntityRef<'policy'> {
    readonly sort: K.PolicySort;
    readonly __decide?: (input: I) => O;
  }

  export interface RunnerView {
    readonly runner: Runner;
    readonly slots: number;
    readonly freeSlots: number;
  }

  export interface RunnerPolicyInput<S> {
    readonly state: S;
    readonly candidates: readonly RunnerView[];
    readonly metrics: K.MetricsView;
    readonly now: Date;
  }

  export type PoolPolicy = Policy<K.PoolPolicyInput, readonly K.AccountView[]>;
  export type SeatPolicy = Policy<K.SeatPolicyInput, readonly K.ModelRef[]>;
  export type SchedulePolicy = Policy<K.SchedulePolicyInput, readonly K.Candidate[]>;
  export type RecallPolicy = Policy<K.RecallInput, readonly K.RecallCandidate[]>;
  export type HaltPolicy<C, D> = Policy<K.HaltPolicyInput<C>, D | undefined>;
  export type RunnerPolicy<S> = Policy<RunnerPolicyInput<S>, readonly Runner[]>;

  export interface Pool extends K.EntityRef<'pool'> {
    serves(...models: readonly Model[]): Pool;
    policy(policy: PoolPolicy): Pool;
    fallback(account: Account): Pool;
  }

  export interface Seat extends K.EntityRef<'seat'> {
    role(role: Role): Seat;
    models(...models: readonly Model[]): Seat;
    policy(policy: SeatPolicy): Seat;
    call<I, O>(skill: Skill<I, O>): Call<I, O>;
    batch<I, O>(skill: Skill<I, O>): Batch<I, O>;
  }

  export interface Source<P> {
    readonly entity: 'source';
    readonly __payload?: P;
  }

  export interface HaltClock<C> extends Source<K.HaltOpened<C>> {
    after(delay: Duration): Source<K.HaltOpened<C>>;
    at(deadline: (openedAt: Date) => Date): Source<K.HaltOpened<C>>;
  }

  export interface Consequence<P> {
    readonly entity: 'consequence';
    readonly __accepts?: (payload: P) => void;
  }

  export interface Crossing {
    falls(): Source<K.Crossed>;
    rises(): Source<K.Crossed>;
  }

  export interface Metric extends K.EntityRef<'metric'> {}

  export interface MetricBuilder {
    rate(hits: K.EventSet, of: K.EventSet): Metric;
    count(events: K.EventSet): Metric;
    sum(events: K.EventSet, field: K.Field): Metric;
    mean(events: K.EventSet, field: K.Field): Metric;
    median(events: K.EventSet, field: K.Field): Metric;
  }

  export type FlowState<I, A, X> = {
    readonly input: I;
    readonly steps: Readonly<A>;
    readonly now: Date;
    readonly unit: K.UnitRef;
  } & X;

  export interface LoopScope<C> {
    readonly carry: C;
    readonly iteration: number;
  }

  export interface LoopResult<C> {
    readonly iterations: number;
    readonly carry: C;
    readonly completed: boolean;
  }

  export interface StepOptions<S> {
    readonly retry?: K.Retry;
    readonly onFailure?: 'fail' | 'block';
    readonly runner?: Runner | RunnerPolicy<S>;
  }

  export interface FlowShape<I, A, E extends string, X> extends K.EntityRef<'flow'> {
    readonly __flow?: {
      readonly input: (input: I) => void;
      readonly steps: A;
      readonly exits: E;
      readonly scope: (scope: X) => void;
    };
  }

  export interface ExitedFlow<I, A, E extends string, X = {}> extends FlowShape<I, A, E, X> {
    readonly exited: true;
  }

  export type StepsOf<F> = F extends FlowShape<infer _I, infer A, infer _E, infer _X> ? A : never;

  export interface Flow<I, A, E extends string, X = {}> extends FlowShape<I, A, E, X> {
    input<S extends z.ZodType>(schema: S): Flow<z.output<S>, A, E, X>;
    resources(select: (state: FlowState<I, A, X>) => ReadonlyArray<Resource | Lease>): Flow<I, A, E, X>;
    facet(facet: Facet, value: (state: FlowState<I, A, X>) => string): Flow<I, A, E, X>;
    step<N extends string, SI, O>(
      name: N,
      executable: Executable<SI, O>,
      map: (state: FlowState<I, A, X>) => NoInfer<SI>,
      options?: StepOptions<FlowState<I, A, X>>,
    ): Flow<I, A & { readonly [P in N]: O }, E, X>;
    step<N extends string, O>(
      name: N,
      executable: Executable<void, O>,
      options?: StepOptions<FlowState<I, A, X>>,
    ): Flow<I, A & { readonly [P in N]: O }, E, X>;
    step<N extends string, O>(
      name: N,
      executable: Executable<I, O>,
      options?: StepOptions<FlowState<I, A, X>>,
    ): Flow<I, A & { readonly [P in N]: O }, E, X>;
    when<A2, E2 extends string = never>(
      predicate: (state: FlowState<I, A, X>) => boolean,
      branch: (flow: Flow<I, A, never, X>) => FlowShape<I, A2, E2, X>,
    ): Flow<I, A & Partial<Omit<A2, keyof A>>, E | E2, X>;
    parallel<
      N extends string,
      B extends { readonly [branch: string]: (flow: Flow<I, A, never, X>) => FlowShape<I, object, never, X> },
    >(
      name: N,
      branches: B,
    ): Flow<I, A & { readonly [P in N]: { readonly [Q in keyof B]: Omit<StepsOf<ReturnType<B[Q]>>, keyof A> } }, E, X>;
    loop<N extends string, C, A2, E2 extends string = never>(
      name: N,
      spec: {
        readonly maxIterations: number | ((state: FlowState<I, A, X>) => number);
        readonly initial: (state: FlowState<I, A, X>) => C;
        readonly body: (flow: Flow<I, A, never, X & LoopScope<C>>) => FlowShape<I, A2, E2, X & LoopScope<C>>;
        readonly next: (state: FlowState<I, A2, X & LoopScope<C>>) => C;
        readonly until: (state: FlowState<I, A2, X & LoopScope<C>>) => boolean;
      },
    ): Flow<I, A & { readonly [P in N]: LoopResult<C> }, E | E2, X>;
    halt<N extends string, C, D>(
      name: N,
      halt: Halt<C, D>,
      context: (state: FlowState<I, A, X>) => NoInfer<C>,
    ): Flow<I, A & { readonly [P in N]: D }, E, X>;
    halt<N extends string, D>(name: N, halt: Halt<void, D>): Flow<I, A & { readonly [P in N]: D }, E, X>;
    spawn<N extends string, CD>(
      name: N,
      lane: LaneRef<CD>,
      items: (state: FlowState<I, A, X>) => readonly NoInfer<CD>[],
    ): Flow<I, A & { readonly [P in N]: readonly K.ChildResult[] }, E, X>;
    exit<L extends string>(label: L | ((state: FlowState<I, A, X>) => L)): ExitedFlow<I, A, E | L, X>;
  }

  export interface Supply<D> extends K.EntityRef<'supply'> {
    readonly __supplies?: D;
    map<D2>(map: (raw: D) => D2): Supply<D2>;
    key(key: (data: D) => string): Supply<D>;
    updatesOnly(): Update<D>;
  }

  export interface Update<D> extends K.EntityRef<'supply'> {
    readonly __updates?: D;
  }

  export interface ExitBound<St extends State> {
    readonly to: St;
    readonly maxTimes: number;
    readonly then: St;
  }

  export interface Arcs<St extends State, E extends string> {
    readonly exits: { readonly [L in E]: St | ExitBound<St> };
    readonly retry: K.Retry & { readonly exhausted: St };
  }

  export interface LaneRef<D> extends K.EntityRef<'lane'> {
    readonly __accepts?: (data: D) => void;
  }

  export interface Lane<D, St extends State> extends LaneRef<D> {
    readonly __states?: St;
    from(...suppliers: ReadonlyArray<Supply<D> | Update<Partial<D>>>): Lane<D, St>;
    store(store: K.Store): Lane<D, St>;
    handle<E extends string>(flow: ExitedFlow<D, object, E>, arcs: Arcs<St, NoInfer<E>>): Lane<D, St>;
    handle<I, E extends string>(
      flow: ExitedFlow<I, object, E>,
      arcs: Arcs<St, NoInfer<E>> & { readonly input: (unit: K.UnitView<D>) => NoInfer<I> },
    ): Lane<D, St>;
    wip(limit: number): Lane<D, St>;
    ceiling(ceiling: {
      readonly maxUsd: number;
      readonly onExceed: Halt<K.CeilingContext, K.CeilingDecision> | 'fail';
    }): Lane<D, St>;
    after(predecessor: (data: D) => string | undefined, options: { readonly failed: St }): Lane<D, St>;
    facet(facet: Facet, value: (data: D) => string): Lane<D, St>;
    deadline(deadline: (unit: K.UnitView<D>) => Date | undefined): Lane<D, St>;
  }

  export interface LaneStart {
    of<D, St extends State>(kind: WorkKind<D, St>): Lane<D, St>;
  }

  export interface Journal<C> extends K.JournalRef<C> {
    store(store: K.MemoryStore): Journal<C>;
    recall(policy: RecallPolicy): Journal<C>;
  }

  export interface JournalStart {
    of<C>(kind: MemoryKind<C>): Journal<C>;
  }

  export interface Trigger<P> extends K.EntityRef<'trigger'> {
    when(predicate: (payload: P) => boolean): Trigger<P>;
    do(...consequences: ReadonlyArray<Consequence<P>>): Trigger<P>;
  }

  export interface TriggerStart {
    on<P>(source: Source<P>): Trigger<P>;
  }

  export interface Operation extends K.EntityRef<'operation'> {}

  export interface Grant extends K.EntityRef<'grant'> {
    readonly client: K.Client;
    readonly operations: readonly Operation[];
  }

  export interface Harness extends K.EntityRef<'harness'> {
    ledger(ledger: K.Ledger): Harness;
    pools(...pools: readonly Pool[]): Harness;
    lanes(...lanes: ReadonlyArray<LaneRef<never>>): Harness;
    journals(...journals: ReadonlyArray<K.JournalRef<never>>): Harness;
    triggers(...triggers: ReadonlyArray<K.EntityRef<'trigger'>>): Harness;
    schedule(policy: SchedulePolicy): Harness;
    grants(...grants: readonly Grant[]): Harness;
    metrics(...metrics: readonly Metric[]): Harness;
    observe(...observers: readonly K.Observer[]): Harness;
    start(): Promise<K.RunningHarness>;
  }

  export const H: {
    work(name: string): WorkKind<unknown, never>;
    state<N extends string>(name: N): StateBuilder<N>;
    resource(name: string): Resource;
    halt(name: string): Halt<void, unknown>;
    memory(name: string): MemoryKind<unknown>;
    role(name: string): Role;
    skill(name: string): Skill<void, unknown>;
    facet(name: string): Facet;

    account(name: string, driver: K.ModelDriver): Account;
    model(modelId: string, options?: ModelOptions): Model;
    runner: {
      local(name: string, options: { readonly slots: number }): Runner;
      ssh(name: string, options: {
        readonly host: K.Setting;
        readonly user: K.Setting;
        readonly key: K.EnvRef;
        readonly slots: number;
      }): Runner;
    };
    command(name: string): Command<void, void>;
    job(name: string): Job<void, void>;

    pool(name: string, accounts: readonly Account[]): Pool;
    seat(name: string): Seat;
    lane(name: string): LaneStart;
    journal(name: string): JournalStart;
    grant(client: K.Client, ...operations: readonly Operation[]): Grant;

    flow(name: string): Flow<void, {}, never>;
    lease: {
      exclusive(resource: Resource): Lease;
      shared(resource: Resource): Lease;
    };

    trigger(name: string): TriggerStart;
    entered<D, St extends State>(lane: Lane<D, St>, ...states: readonly NoInfer<St>[]): Source<K.Entered<D>>;
    streak<D, St extends State>(
      lane: Lane<D, St>,
      state: NoInfer<St>,
      count: number,
      options?: { readonly by?: Facet },
    ): Source<K.Streak<D>>;
    due<D, St extends State>(lane: Lane<D, St>): Source<K.Due<D>>;
    opened<C, D>(halt: Halt<C, D>): HaltClock<C>;
    resolved<C, D>(halt: Halt<C, D>): Source<K.HaltResolved<C, D>>;
    crossing(metric: Metric, options: {
      readonly below?: number;
      readonly above?: number;
      readonly samples: number;
      readonly window: Duration;
      readonly by?: Facet | K.Column;
    }): Crossing;

    create<D, P>(
      lane: LaneRef<D>,
      map: (payload: P) => NoInfer<D>,
      options?: { readonly key?: (payload: P) => string },
    ): Consequence<P>;
    move<D, St extends State>(lane: Lane<D, St>, state: NoInfer<St>): Consequence<{ readonly unit: K.UnitRef }>;
    move<D, St extends State, P>(lane: Lane<D, St>, state: NoInfer<St>, key: (payload: P) => string): Consequence<P>;
    pause(lane: LaneRef<never>): Consequence<unknown>;
    resume(lane: LaneRef<never>): Consequence<unknown>;
    record<C, P>(journal: K.JournalRef<C>, map: (payload: P) => K.MemoryDraft<NoInfer<C>>): Consequence<P>;
    run<I, P>(command: Command<I, unknown>, map: (payload: P) => NoInfer<I>): Consequence<P>;
    resolve<C, D>(halt: Halt<C, D>, decide: (payload: K.HaltOpened<C>) => NoInfer<D>): Consequence<K.HaltOpened<C>>;
    resolve<C, D>(halt: Halt<C, D>, policy: HaltPolicy<C, NoInfer<D>>): Consequence<K.HaltOpened<C>>;

    policy: {
      pool(name: string, decide: (input: K.PoolPolicyInput) => readonly K.AccountView[]): PoolPolicy;
      seat(name: string, decide: (input: K.SeatPolicyInput) => readonly K.ModelRef[]): SeatPolicy;
      schedule(name: string, decide: (input: K.SchedulePolicyInput) => readonly K.Candidate[]): SchedulePolicy;
      recall(name: string, decide: (input: K.RecallInput) => readonly K.RecallCandidate[]): RecallPolicy;
      halt<C, D>(
        name: string,
        halt: Halt<C, D>,
        decide: (input: K.HaltPolicyInput<C>) => NoInfer<D> | undefined,
      ): HaltPolicy<C, D>;
      runner<S>(
        name: string,
        runners: readonly Runner[],
        decide: (input: RunnerPolicyInput<S>) => readonly Runner[],
      ): RunnerPolicy<S>;
    };

    metric(name: string): MetricBuilder;
    events: {
      attempts(filter?: { readonly outcome?: K.AttemptOutcome }): K.EventSet;
      terminal(filter?: { readonly verdict?: K.Verdict }): K.EventSet;
      entered(...states: readonly State[]): K.EventSet;
      created(): K.EventSet;
      steps<F extends FlowShape<never, object, string, never>>(
        flow: F,
        step: keyof StepsOf<F> & string,
        filter?: { readonly outcome?: K.AttemptOutcome },
      ): K.EventSet;
      decisions<C, D>(halt: Halt<C, D>, filter?: {
        readonly match?: (decision: D) => boolean;
        readonly resolver?: K.ResolverSort;
      }): K.EventSet;
      credits<C, D>(halt: Halt<C, D>, credit: (decision: D) => readonly Seat[]): K.EventSet;
      invocations(filter?: { readonly outcome?: 'succeeded' | 'failed' }): K.EventSet;
      pauses(): K.EventSet;
      jobs(): K.EventSet;
      leases(): K.EventSet;
    };

    harness(name: string): Harness;

    ops: {
      resolve<C, D>(halt: Halt<C, D>): Operation;
      work: { readonly read: Operation; readonly write: Operation };
      memory: {
        read(...journals: ReadonlyArray<K.JournalRef<never>>): Operation;
        write(...journals: ReadonlyArray<K.JournalRef<never>>): Operation;
        curate(...journals: ReadonlyArray<K.JournalRef<never>>): Operation;
      };
      telemetry: { readonly read: Operation };
      accounts: { readonly manage: Operation };
    };
    operation<I, O>(name: string, command: Command<I, O>): Operation;

    env(name: string): K.EnvRef;
    slot: { port(index: number): K.PortRef };
  };
}

declare module 'harness-dsl/claude-code' {
  import type * as K from 'harness-dsl/kernel';
  export const claudeCode: {
    driver(options: { readonly configDir: K.Setting }): K.ModelDriver;
    client(name: string, options?: { readonly session?: string }): K.Client;
  };
}

declare module 'harness-dsl/anthropic' {
  import type * as K from 'harness-dsl/kernel';
  export const anthropic: {
    api(options: { readonly apiKey: K.EnvRef }): K.ModelDriver;
    pricing(): K.Pricing;
  };
}

declare module 'harness-dsl/sqlite' {
  import { z } from 'zod';
  import type * as K from 'harness-dsl/kernel';
  import type { Supply } from 'harness-dsl';
  export const sqlite: {
    ledger(path: string): K.Ledger;
    quota(path: string): K.QuotaPartition;
    store(path: string): K.Store;
    reopen<S extends z.ZodType>(options: {
      readonly path: string;
      readonly cron: string;
      readonly schema: S;
      readonly where: (data: z.output<S>) => boolean;
    }): Supply<z.output<S>>;
  };
}

declare module 'harness-dsl/jsonl' {
  import type * as K from 'harness-dsl/kernel';
  export const jsonl: {
    store(path: string): K.MemoryStore;
  };
}

declare module 'harness-dsl/pgvector' {
  import type * as K from 'harness-dsl/kernel';
  export const pgvector: {
    store(options: {
      readonly url: K.EnvRef;
      readonly table: string;
      readonly embeddingModel: string;
      readonly embeddingKey: K.EnvRef;
    }): K.MemoryStore;
  };
}

declare module 'harness-dsl/linear' {
  import type * as K from 'harness-dsl/kernel';
  import type { Supply } from 'harness-dsl';
  export interface LinearIssue {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly description: string;
    readonly labels: readonly string[];
    readonly status: string;
    readonly parentId: string | undefined;
  }
  export const linear: {
    issues(options: {
      readonly apiKey: K.EnvRef;
      readonly team: string;
      readonly labels?: readonly string[];
    }): Supply<LinearIssue>;
    store(options: {
      readonly apiKey: K.EnvRef;
      readonly team: string;
      readonly statuses: ReadonlyArray<readonly [K.EntityRef<'state'>, string]>;
    }): K.Store;
  };
}

declare module 'harness-dsl/http' {
  import { z } from 'zod';
  import type * as K from 'harness-dsl/kernel';
  import type { Supply } from 'harness-dsl';
  export const http: {
    client(name: string, options: { readonly port: number | K.PortRef; readonly token?: K.EnvRef }): K.Client;
    webhook<S extends z.ZodType>(options: { readonly path: string; readonly schema: S; readonly secret?: K.EnvRef }): Supply<z.output<S>>;
    store(options: {
      readonly load: (unit: K.UnitRef, ctx: K.ResolveContext) => Promise<K.StoredUnit | undefined>;
      readonly save: (unit: K.UnitRef, change: K.StoredUnit, ctx: K.ResolveContext) => Promise<void>;
    }): K.Store;
  };
}

declare module 'harness-dsl/supply' {
  import { z } from 'zod';
  import type * as K from 'harness-dsl/kernel';
  import type { Supply } from 'harness-dsl';
  export const supply: {
    folder<S extends z.ZodType>(options: { readonly path: string; readonly schema: S }): Supply<z.output<S>>;
    schedule<D>(options: { readonly cron: string; readonly units: (now: Date, ctx: K.ResolveContext) => readonly D[] | Promise<readonly D[]> }): Supply<D>;
    poll<D>(options: { readonly every: K.Duration; readonly fetch: (ctx: K.ResolveContext) => Promise<readonly D[]> }): Supply<D>;
    manual<S extends z.ZodType>(schema: S): Supply<z.output<S>>;
    manual(): Supply<never>;
    frontmatter(options: { readonly path: string }): K.Store;
  };
}

declare module 'harness-dsl/policies' {
  import type { PoolPolicy, RecallPolicy } from 'harness-dsl';
  export const policies: {
    soonestExpiring(): PoolPolicy;
    specificity(options?: { readonly limit?: number }): RecallPolicy;
    similarity(options: { readonly limit: number; readonly minSimilarity?: number }): RecallPolicy;
  };
}

declare module 'harness-dsl/observers' {
  import type * as K from 'harness-dsl/kernel';
  import type { LaneRef } from 'harness-dsl';
  export const observers: {
    board(options: { readonly path: string }): K.Observer;
    telemetry(options: { readonly path: string }): K.Observer;
    slack(options: { readonly webhookUrl: K.EnvRef; readonly lanes: ReadonlyArray<LaneRef<never>> }): K.Observer;
  };
}

declare module 'harness-dsl/plugins' {
  import type * as K from 'harness-dsl/kernel';
  import type { Command, Resource } from 'harness-dsl';
  export const plugins: {
    fileLeaseGuard(areas: ReadonlyArray<{ readonly resource: Resource; readonly globs: readonly string[] }>): K.AgentPlugin;
    gitWorktreeIsolation(): K.AgentPlugin;
    stopCheck(command: Command<void, unknown>): K.AgentPlugin;
  };
}
