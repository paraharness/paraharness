declare module 'harness-dsl' {
  import { z } from 'zod';
  import type {
    Outcome,
    TerminalOutcome,
    Duration,
    Window,
    Json,
    EnvRef,
    PortRef,
    Secret,
    EnvValue,
    StateRef,
    UnitView,
    AttemptView,
    AttemptStatus,
    Actor,
    TransitionEvent,
    UpdateEvent,
    OverdueEvent,
    ResolutionEvent,
    LedgerRecord,
    SupplyEvent,
    Supplier,
    Store,
    MemoryStore,
    MemoryItem,
    Ledger,
    QuotaLedger,
    QuotaState,
    ModelDriver,
    RunnerBackend,
    ExecOptions,
    ExecResult,
    AgentPlugin,
    ToolIntent,
    Observer,
    Client,
    Policy,
    Metrics,
    OutcomeStats,
    RateStats,
    SpendStats,
    ScheduleContext,
    ScheduleDecision,
    PendingUnit,
    ActiveAttempt,
    ChooseContext,
    Candidate,
    RecallContext,
    RecallCandidate,
  } from 'harness-dsl/kernel';

  export type {
    Outcome,
    TerminalOutcome,
    Duration,
    Window,
    Json,
    EnvRef,
    PortRef,
    Secret,
    EnvValue,
    StateRef,
    UnitView,
    AttemptView,
    AttemptStatus,
    Actor,
    TransitionEvent,
    UpdateEvent,
    OverdueEvent,
    ResolutionEvent,
    LedgerRecord,
    SupplyEvent,
    Supplier,
    Store,
    MemoryStore,
    MemoryItem,
    Ledger,
    QuotaLedger,
    QuotaState,
    ModelDriver,
    RunnerBackend,
    ExecOptions,
    ExecResult,
    AgentPlugin,
    ToolIntent,
    Observer,
    Client,
    Policy,
    Metrics,
    OutcomeStats,
    RateStats,
    SpendStats,
    ScheduleContext,
    ScheduleDecision,
    PendingUnit,
    ActiveAttempt,
    ChooseContext,
    Candidate,
    RecallContext,
    RecallCandidate,
  };

  export type Schema<T> = z.ZodType<T, unknown>;

  export interface Named {
    readonly name: string;
  }

  export interface StateDraft {
    readonly name: string;
    pending(): State;
    active(): State;
    succeeded(): State;
    failed(): State;
    cancelled(): State;
    ended(): State;
  }

  export interface State extends StateRef {
    readonly entity: 'state';
  }

  export interface WorkKind<T> {
    readonly entity: 'work';
    readonly name: string;
    readonly __data?: T;
    schema<N>(schema: Schema<N>): WorkKind<N>;
    states(...states: State[]): WorkKind<T>;
    resources(select: (data: T) => readonly string[]): WorkKind<T>;
  }

  export type DataOf<K> = K extends WorkKind<infer T> ? T : never;

  export interface MemoryKind<C> {
    readonly entity: 'memory';
    readonly name: string;
    readonly __content?: C;
    content<N>(schema: Schema<N>): MemoryKind<N>;
  }

  export interface Scope {
    readonly kinds?: readonly Named[];
    readonly roles?: readonly Named[];
    readonly skills?: readonly Named[];
    readonly resources?: readonly string[];
  }

  export interface MemoryDraft<C> {
    readonly content: C;
    readonly when?: Scope;
  }

  export interface Role {
    readonly entity: 'role';
    readonly name: string;
    prompt(text: string): Role;
    tools(...intents: ToolIntent[]): Role;
    recall(...kinds: MemoryKind<unknown>[]): Role;
    record(...kinds: MemoryKind<unknown>[]): Role;
    use(...plugins: AgentPlugin[]): Role;
  }

  export interface Executable<I, O> {
    readonly name: string;
    readonly __run?: (input: I) => O;
  }

  export interface Skill<I, O> extends Executable<I, O> {
    readonly entity: 'skill';
    input<N>(schema: Schema<N>): Skill<N, O>;
    output<N>(schema: Schema<N>): Skill<I, N>;
    prompt(render: (input: I) => string): Skill<I, O>;
    by(agent: Agent): Executable<I, O>;
  }

  export interface Blocker<R> {
    readonly entity: 'blocker';
    readonly name: string;
    readonly __resolution?: R;
    resolution<N>(schema: Schema<N>): Blocker<N>;
  }

  export interface Account {
    readonly entity: 'account';
    readonly name: string;
    ledger(quota: QuotaLedger): Account;
  }

  export interface AccountPool {
    readonly entity: 'account-pool';
    readonly name: string;
    policy(policy: Policy<ChooseContext, readonly Candidate[]>): AccountPool;
    maxShare(account: Account, ratio: number): AccountPool;
    fallback(account: Account): AccountPool;
  }

  export interface Model {
    readonly entity: 'model';
    readonly name: string;
    readonly modelId: string;
  }

  export interface ModelPool {
    readonly entity: 'model-pool';
    readonly name: string;
    policy(policy: Policy<ChooseContext, readonly Candidate[]>): ModelPool;
  }

  export interface Agent {
    readonly entity: 'agent';
    readonly name: string;
    role(role: Role): Agent;
    model(model: Model | ModelPool): Agent;
  }

  export interface Runner {
    readonly entity: 'runner';
    readonly name: string;
    slots(count: number): Runner;
    env(vars: Readonly<Record<string, EnvValue>>): Runner;
    preflight(check: Command<void, unknown>): Runner;
  }

  export interface CommandArgs<I> {
    readonly input: I;
    readonly env: Readonly<Record<string, string>>;
    readonly unit: UnitView<unknown> | null;
    exec(command: string, options?: Partial<ExecOptions>): Promise<ExecResult>;
    record<C>(journal: Journal<C>, draft: MemoryDraft<C>): Promise<void>;
  }

  export interface Command<I, O> extends Executable<I, O> {
    readonly entity: 'command';
    input<N>(schema: Schema<N>): Command<N, O>;
    output<N>(schema: Schema<N>): Command<I, N>;
    runner(...runners: Runner[]): Command<I, O>;
    env(vars: Readonly<Record<string, EnvValue>>): Command<I, O>;
    run(body: (args: CommandArgs<I>) => Promise<O>): Command<I, O>;
  }

  export interface Journal<C> {
    readonly entity: 'journal';
    readonly name: string;
    readonly __content?: C;
    of<N>(kind: MemoryKind<N>): Journal<N>;
    store(store: MemoryStore<C>): Journal<C>;
    recall(policy: Policy<RecallContext, readonly RecallCandidate[]>): Journal<C>;
  }

  export interface Retry {
    readonly maxRetries: number;
    readonly backoff?: {
      readonly initialMs: number;
      readonly factor: number;
      readonly maxMs?: number;
    };
  }

  export interface FlowContext<U, S> {
    readonly unit: UnitView<U>;
    readonly settings: S;
    readonly metrics: Metrics;
    readonly now: Date;
    readonly attempt: { readonly id: string; readonly number: number };
    readonly children: readonly UnitView<unknown>[];
  }

  export interface FlowError {
    readonly step: string;
    readonly message: string;
  }

  export interface Resolved<V, R> {
    readonly value: V;
    readonly resolution: R;
  }

  export interface MaybeResolved<V, R> {
    readonly value: V;
    readonly resolution: R | null;
  }

  export interface FlowStart {
    for<Ks extends readonly WorkKind<unknown>[]>(
      ...kinds: Ks
    ): Flow<DataOf<Ks[number]>, DataOf<Ks[number]>, void>;
  }

  export interface Flow<U, V, S> {
    readonly entity: 'flow';
    readonly name: string;
    readonly __accepts?: (unit: U) => void;
    readonly __value?: V;
    readonly __settings?: S;

    settings<N>(schema: Schema<N>): Flow<U, V, N>;

    step<I, O>(
      name: string,
      run: Executable<I, O>,
      options: {
        readonly input: (value: V, ctx: FlowContext<U, S>) => I;
        readonly retry?: Retry;
      },
    ): Flow<U, O, S>;
    step<O>(
      name: string,
      run: Executable<V, O>,
      options?: { readonly retry?: Retry },
    ): Flow<U, O, S>;

    map<O>(transform: (value: V, ctx: FlowContext<U, S>) => O): Flow<U, O, S>;

    patch(update: (value: V, ctx: FlowContext<U, S>) => Partial<U>): Flow<U, V, S>;

    parallel<B>(
      name: string,
      branches: { readonly [K in keyof B]: (flow: Flow<U, V, S>) => Flow<U, B[K], S> },
    ): Flow<U, { readonly [K in keyof B]: B[K] }, S>;

    batch<I, O>(
      name: string,
      options: {
        readonly items: (value: V, ctx: FlowContext<U, S>) => readonly I[];
        readonly run: Executable<I, O>;
        readonly via: 'concurrent' | 'provider-batch';
        readonly concurrency?: number;
      },
    ): Flow<U, readonly O[], S>;

    loop(options: {
      readonly maxIterations: number | ((ctx: FlowContext<U, S>) => number);
      readonly body: (flow: Flow<U, V, S>) => Flow<U, V, S>;
      readonly until: (value: V, ctx: FlowContext<U, S>) => boolean;
    }): Flow<U, V, S>;

    when<W>(
      predicate: (value: V, ctx: FlowContext<U, S>) => boolean,
      then: (flow: Flow<U, V, S>) => Flow<U, W, S>,
    ): Flow<U, V, S>;

    transition(to: State | ((value: V, ctx: FlowContext<U, S>) => State)): Flow<U, V, S>;

    halt<R>(
      blocker: Blocker<R>,
      report?: (value: V, ctx: FlowContext<U, S>) => string,
    ): Flow<U, Resolved<V, R>, S>;

    haltIf<R>(
      predicate: (value: V, ctx: FlowContext<U, S>) => boolean,
      blocker: Blocker<R>,
      report?: (value: V, ctx: FlowContext<U, S>) => string,
    ): Flow<U, MaybeResolved<V, R>, S>;

    spawn<T>(
      name: string,
      lane: Lane<T>,
      items: (value: V, ctx: FlowContext<U, S>) => readonly T[],
      options: { readonly waitIn: State; readonly resumeIn: State },
    ): Flow<U, never, S>;

    onError(to: State | ((error: FlowError, ctx: FlowContext<U, S>) => State)): Flow<U, V, S>;
  }

  export interface Source<E> {
    readonly entity: 'source';
    readonly __event?: E;
    where(predicate: (event: E) => boolean): Source<E>;
    streak(
      length: number,
      options: {
        readonly matches: (event: E) => boolean;
        readonly groupBy: (event: E) => string;
      },
    ): Source<E>;
  }

  export interface Lane<T> {
    readonly entity: 'lane';
    readonly name: string;
    readonly __data?: T;
    of<N>(kind: WorkKind<N>): Lane<N>;
    from(...suppliers: Supplier<T>[]): Lane<T>;
    store(store: Store<T>): Lane<T>;
    handle<V>(flow: Flow<T, V, void>): Lane<T>;
    handle<V, S>(flow: Flow<T, V, S>, settings: S): Lane<T>;
    wip(max: number): Lane<T>;
    deadline(at: (unit: UnitView<T>) => Date | null): Lane<T>;
    maxUsdPerUnit(usd: number, options: { readonly onExceed: 'halt' | 'fail' }): Lane<T>;
    enters(...states: State[]): Source<TransitionEvent<T>>;
    updated(): Source<UpdateEvent<T>>;
    overdue(): Source<OverdueEvent<T>>;
    resolved<R>(blocker: Blocker<R>): Source<ResolutionEvent<T, R>>;
  }

  export interface TriggerStart {
    on<E extends { readonly unit: UnitView<unknown> }>(source: Source<E>): Trigger<E>;
  }

  export interface Trigger<E> {
    readonly entity: 'trigger';
    readonly name: string;
    readonly __event?: E;
    add<T>(lane: Lane<T>, create: (event: E) => T): Trigger<E>;
    transition(to: State | ((event: E) => State)): Trigger<E>;
    record<C>(
      journal: Journal<C>,
      draft: (event: E) => MemoryDraft<C>,
      options?: { readonly candidate: boolean },
    ): Trigger<E>;
  }

  export interface TriggerRef {
    readonly entity: 'trigger';
    readonly name: string;
  }

  export interface MetricSample {
    readonly key: string;
    readonly hit: boolean;
  }

  export interface MetricStart {
    over<E>(source: Source<E>): MetricDraft<E>;
  }

  export interface MetricDraft<E> {
    sample(select: (event: E) => readonly MetricSample[]): Metric;
  }

  export interface Metric {
    readonly entity: 'metric';
    readonly name: string;
  }

  export interface Scheduler {
    readonly entity: 'scheduler';
    readonly name: string;
    concurrency(max: number): Scheduler;
    policy(policy: Policy<ScheduleContext, ScheduleDecision>): Scheduler;
  }

  export interface Operation {
    readonly entity: 'operation';
    readonly name: string;
  }

  export interface Supervisor {
    readonly entity: 'supervisor';
    readonly name: string;
    client(client: Client): Supervisor;
    grant(...operations: Operation[]): Supervisor;
  }

  export interface LaneRef {
    readonly entity: 'lane';
    readonly name: string;
  }

  export interface JournalRef {
    readonly entity: 'journal';
    readonly name: string;
  }

  export interface RunningHarness {
    readonly name: string;
    readonly metrics: Metrics;
    stop(): Promise<void>;
  }

  export interface Harness {
    readonly entity: 'harness';
    readonly name: string;
    ledger(ledger: Ledger): Harness;
    lanes(...lanes: LaneRef[]): Harness;
    journals(...journals: JournalRef[]): Harness;
    triggers(...triggers: TriggerRef[]): Harness;
    metrics(...metrics: Metric[]): Harness;
    scheduler(scheduler: Scheduler): Harness;
    supervisor(supervisor: Supervisor): Harness;
    observe(...observers: Observer[]): Harness;
    start(): Promise<RunningHarness>;
  }

  export interface PolicyFactory {
    schedule(
      name: string,
      decide: (ctx: ScheduleContext) => ScheduleDecision,
    ): Policy<ScheduleContext, ScheduleDecision>;
    choose(
      name: string,
      decide: (ctx: ChooseContext) => readonly Candidate[],
    ): Policy<ChooseContext, readonly Candidate[]>;
    recall(
      name: string,
      decide: (ctx: RecallContext) => readonly RecallCandidate[],
    ): Policy<RecallContext, readonly RecallCandidate[]>;
  }

  export interface Operations {
    readonly work: { readonly read: Operation; readonly write: Operation };
    readonly blockers: { readonly resolve: Operation };
    readonly memory: {
      readonly read: Operation;
      readonly write: Operation;
      readonly curate: Operation;
    };
    readonly telemetry: { readonly read: Operation };
    readonly accounts: { readonly manage: Operation };
  }

  export interface Vocabulary {
    work(name: string): WorkKind<unknown>;
    state(name: string): StateDraft;
    memory(name: string): MemoryKind<unknown>;
    role(name: string): Role;
    skill(name: string): Skill<void, string>;
    blocker(name: string): Blocker<{ readonly note?: string }>;

    account(name: string, driver: ModelDriver): Account;
    model(name: string, source: Account | AccountPool, modelId: string): Model;
    runner(name: string, backend: RunnerBackend): Runner;
    command(name: string): Command<void, void>;

    pool: {
      (name: string, accounts: readonly Account[]): AccountPool;
      (name: string, models: readonly Model[]): ModelPool;
    };
    agent(name: string): Agent;
    lane(name: string): Lane<unknown>;
    journal(name: string): Journal<unknown>;

    flow(name: string): FlowStart;
    trigger(name: string): TriggerStart;
    metric(name: string): MetricStart;
    readonly policy: PolicyFactory;
    scheduler(name: string): Scheduler;
    operation<I, O>(name: string, run: Command<I, O>): Operation;
    readonly ops: Operations;
    supervisor(name: string): Supervisor;
    harness(name: string): Harness;

    env(name: string): EnvRef;
    readonly slot: { port(index: number): PortRef };
  }

  export const H: Vocabulary;
}

declare module 'harness-dsl/claude-code' {
  import type { ModelDriver, Client } from 'harness-dsl/kernel';
  export const claudeCode: {
    driver(options: { readonly configDir: string }): ModelDriver;
    client(options?: { readonly port?: number }): Client;
  };
}

declare module 'harness-dsl/anthropic' {
  import type { ModelDriver, Secret } from 'harness-dsl/kernel';
  export const anthropic: {
    api(options: { readonly apiKey: Secret }): ModelDriver;
  };
}

declare module 'harness-dsl/sqlite' {
  import type { Ledger, Store } from 'harness-dsl/kernel';
  export const sqlite: {
    ledger(path: string): Ledger;
    store<T>(options: { readonly path: string; readonly table: string }): Store<T>;
  };
}

declare module 'harness-dsl/jsonl' {
  import type { MemoryStore } from 'harness-dsl/kernel';
  export const jsonl: {
    store<C>(path: string): MemoryStore<C>;
  };
}

declare module 'harness-dsl/lancedb' {
  import type { MemoryStore, Secret } from 'harness-dsl/kernel';
  export const lancedb: {
    store<C>(options: {
      readonly uri: string;
      readonly table: string;
      readonly text: (content: C) => string;
      readonly embeddingModel: string;
      readonly apiKey: Secret;
    }): MemoryStore<C>;
  };
}

declare module 'harness-dsl/linear' {
  import type { Supplier, Store, Secret } from 'harness-dsl/kernel';
  export interface LinearIssue {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly description: string;
    readonly labels: readonly string[];
    readonly priority: number;
    readonly parentId: string | null;
    readonly state: string;
  }
  export const linear: {
    supply<T>(options: {
      readonly apiKey: Secret;
      readonly team: string;
      readonly labels?: readonly string[];
      readonly map: (issue: LinearIssue) => T;
    }): Supplier<T>;
    store<T>(options: {
      readonly apiKey: Secret;
      readonly team: string;
      readonly map: (issue: LinearIssue) => T;
      readonly states: Readonly<Record<string, string>>;
    }): Store<T>;
  };
}

declare module 'harness-dsl/zendesk' {
  import type { Supplier, Store, Secret, SupplyEvent, Duration } from 'harness-dsl/kernel';
  export interface ZendeskTicket {
    readonly id: string;
    readonly subject: string;
    readonly status: string;
    readonly tags: readonly string[];
    readonly requesterEmail: string;
    readonly latestComment: string;
    readonly latestCommentByCustomer: boolean;
    readonly createdAt: Date;
    readonly updatedAt: Date;
  }
  export const zendesk: {
    webhook<T>(options: {
      readonly port: number;
      readonly path: string;
      readonly secret: Secret;
      readonly map: (ticket: ZendeskTicket) => SupplyEvent<T> | null;
    }): Supplier<T>;
    poll<T>(options: {
      readonly subdomain: string;
      readonly apiToken: Secret;
      readonly every: Duration;
      readonly map: (ticket: ZendeskTicket) => SupplyEvent<T> | null;
    }): Supplier<T>;
    store<T>(options: {
      readonly subdomain: string;
      readonly apiToken: Secret;
      readonly map: (ticket: ZendeskTicket) => T;
      readonly states: Readonly<Record<string, string>>;
    }): Store<T>;
  };
}

declare module 'harness-dsl/ghost' {
  import type { Supplier, Store, Secret, Duration } from 'harness-dsl/kernel';
  export interface GhostPost {
    readonly id: string;
    readonly title: string;
    readonly html: string;
    readonly tags: readonly string[];
    readonly primaryTag: string | null;
    readonly status: string;
    readonly updatedAt: Date;
  }
  export const ghost: {
    poll<T>(options: {
      readonly url: string;
      readonly adminKey: Secret;
      readonly every: Duration;
      readonly map: (post: GhostPost) => T | null;
    }): Supplier<T>;
    store<T>(options: {
      readonly url: string;
      readonly adminKey: Secret;
      readonly map: (post: GhostPost) => T;
      readonly states: Readonly<Record<string, string>>;
    }): Store<T>;
  };
}

declare module 'harness-dsl/folder' {
  import type { Supplier, Store, Json } from 'harness-dsl/kernel';
  export interface MarkdownFile {
    readonly path: string;
    readonly name: string;
    readonly frontmatter: Readonly<Record<string, Json>>;
    readonly body: string;
  }
  export const folder: {
    supply<T>(options: {
      readonly path: string;
      readonly map: (file: MarkdownFile) => T;
    }): Supplier<T>;
    store<T>(options: {
      readonly path: string;
      readonly map: (file: MarkdownFile) => T;
      readonly frontmatter: (data: T) => Readonly<Record<string, Json>>;
    }): Store<T>;
  };
}

declare module 'harness-dsl/supply' {
  import type { Supplier, SupplyEvent, UnitView, Duration, Secret } from 'harness-dsl/kernel';
  export interface ScheduleTick<T> {
    readonly now: Date;
    readonly units: readonly UnitView<T>[];
  }
  export function schedule<T>(
    when: { readonly cron: string } | { readonly every: Duration },
    produce: (tick: ScheduleTick<T>) => readonly SupplyEvent<T>[],
  ): Supplier<T>;
  export function manual<T>(): Supplier<T>;
  export function webhook<T>(options: {
    readonly port: number;
    readonly path: string;
    readonly secret?: Secret;
    readonly map: (body: unknown) => SupplyEvent<T> | null;
  }): Supplier<T>;
}

declare module 'harness-dsl/policies' {
  import type {
    Policy,
    ChooseContext,
    Candidate,
    RecallContext,
    RecallCandidate,
  } from 'harness-dsl/kernel';
  export function drainSoonestExpiring(): Policy<ChooseContext, readonly Candidate[]>;
  export function byApplicability(options: {
    readonly budgetTokens: number;
  }): Policy<RecallContext, readonly RecallCandidate[]>;
  export function bySimilarity(options: {
    readonly budgetTokens: number;
    readonly minSimilarity: number;
  }): Policy<RecallContext, readonly RecallCandidate[]>;
}

declare module 'harness-dsl/observers' {
  import type { Observer } from 'harness-dsl/kernel';
  export function board(path: string): Observer;
  export function telemetry(path: string): Observer;
}

declare module 'harness-dsl/slack' {
  import type { Observer, Secret, LedgerRecord } from 'harness-dsl/kernel';
  export const slack: {
    notifier(options: {
      readonly webhookUrl: Secret;
      readonly when: (record: LedgerRecord) => boolean;
    }): Observer;
  };
}

declare module 'harness-dsl/http' {
  import type { Client, Secret } from 'harness-dsl/kernel';
  export const http: {
    client(options: { readonly port: number; readonly token: Secret }): Client;
  };
}

declare module 'harness-dsl/plugins' {
  import type { AgentPlugin } from 'harness-dsl/kernel';
  export function fileLeaseGuard(): AgentPlugin;
  export function gitWorktreeIsolation(options: {
    readonly root: string;
    readonly baseBranch: string;
  }): AgentPlugin;
  export function stopCommandHook(
    command: string,
    options?: { readonly timeoutMs?: number },
  ): AgentPlugin;
}

declare module 'harness-dsl/local' {
  import type { RunnerBackend } from 'harness-dsl/kernel';
  export function local(): RunnerBackend;
}

declare module 'harness-dsl/ssh' {
  import type { RunnerBackend, Secret } from 'harness-dsl/kernel';
  export function ssh(options: {
    readonly host: string;
    readonly user: string;
    readonly keyFile: Secret;
  }): RunnerBackend;
}
