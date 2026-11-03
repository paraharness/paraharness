declare module 'harness-dsl' {
  import { z } from 'zod';

  const brand: unique symbol;

  export type Outcome = 'pending' | 'active' | 'succeeded' | 'failed' | 'cancelled' | 'concluded';
  export type TerminalOutcome = Exclude<Outcome, 'pending' | 'active'>;

  export interface EnvRef { readonly ref: 'env'; readonly name: string }
  export interface PortRef { readonly ref: 'port'; readonly preferred: number }

  export interface State<N extends string = string, O extends Outcome = Outcome> {
    readonly name: N;
    readonly outcome: O;
    readonly [brand]: 'state';
  }

  export interface WorkKind<N extends string, D, S extends State> {
    readonly name: N;
    readonly [brand]: { readonly data: D; readonly states: S };
    states<T extends readonly State[]>(...states: T): WorkKind<N, D, T[number]>;
    key(by: (data: D) => string): WorkKind<N, D, S>;
  }
  export type AnyWork = WorkKind<string, unknown, State>;

  export interface Unit<D, S extends State = State> {
    readonly key: string;
    readonly kind: string;
    readonly state: S['name'];
    readonly outcome: Outcome;
    readonly data: D;
    readonly labels: Readonly<Record<string, string>>;
    readonly createdAt: Date;
    readonly attempts: number;
  }
  export interface UnitRef { readonly kind: string; readonly key: string }

  export interface Message<P> {
    readonly name: string;
    readonly [brand]: { readonly payload: P };
  }
  export interface ChildExit {
    readonly child: UnitRef;
    readonly state: string;
    readonly outcome: TerminalOutcome;
    readonly remaining: number;
    readonly succeeded: number;
    readonly failed: number;
  }
  export interface Delivery { readonly key: string; readonly [brand]: 'delivery' }
  export type Arrival<D> = { readonly create: D } | Delivery;

  export interface Reaction<D, S extends State> {
    readonly cancel?: boolean;
    readonly to?: S;
    readonly update?: Partial<D>;
    readonly start?: boolean;
  }

  export type Intent = 'read' | 'edit' | 'execute' | 'search' | 'browse' | 'halt';
  export interface Role {
    readonly name: string;
    intents(...intents: Intent[]): Role;
    instructions(text: string): Role;
    skills(...skills: string[]): Role;
  }
  export interface Resource { readonly name: string; readonly [brand]: 'resource' }

  export type MemoryNature = 'experience' | 'taste';
  export interface MemoryKind<N extends MemoryNature = MemoryNature> {
    readonly name: string;
    readonly nature: N;
    curated(): MemoryKind<N>;
  }
  export interface Scope {
    readonly kinds?: readonly AnyWork[];
    readonly roles?: readonly Role[];
    readonly resources?: readonly Resource[];
    readonly skills?: readonly string[];
    readonly labels?: Readonly<Record<string, string>>;
  }
  export interface MemoryDraft {
    readonly do: string;
    readonly when: string;
    readonly because?: string;
    readonly applies?: Scope;
  }
  export interface MemoryStore { readonly name: string; readonly [brand]: 'memory-store' }
  export interface RecallInput {
    readonly kind: string;
    readonly role: string;
    readonly skills: readonly string[];
    readonly resources: readonly string[];
    readonly labels: Readonly<Record<string, string>>;
    readonly text: string;
  }
  export interface RecallPlan {
    readonly rank: 'specificity' | 'similarity';
    readonly limit: number;
    readonly trackRecord: boolean;
    readonly minScore?: number;
    readonly text?: string;
  }
  export interface Journal {
    readonly name: string;
    store(store: MemoryStore): Journal;
    recall(policy: Policy<RecallInput, RecallPlan>): Journal;
  }

  export interface Window { readonly sinceDays?: number; readonly since?: Date }
  export interface Rate { readonly rate: number | null; readonly hits: number; readonly samples: number }
  export interface Mean { readonly mean: number | null; readonly samples: number }
  export interface Slice extends Window {
    readonly model?: Model;
    readonly agent?: string;
    readonly labels?: Readonly<Record<string, string>>;
  }
  export type Selector =
    | { readonly step: string; readonly ok?: boolean }
    | { readonly decision: string; readonly where?: Readonly<Record<string, string | number | boolean>> }
    | { readonly enter: State | readonly State[] };
  export interface Metric { readonly name: string; readonly [brand]: 'metric' }
  export interface Metrics {
    successRate(query: Slice & { readonly kind: AnyWork }): Rate;
    endedIn(query: Slice & { readonly kind: AnyWork; readonly state: State | readonly State[] }): Rate;
    meanCostUsd(query: Slice & { readonly kind: AnyWork; readonly outcome?: TerminalOutcome }): Mean;
    spentUsd(query: Window): number;
    active(query: { readonly kind: AnyWork; readonly state?: State }): number;
    read(metric: Metric, query?: Slice): Rate;
  }

  export interface PolicyEnv { readonly metrics: Metrics; readonly now: Date }
  export interface Policy<In, Out> {
    readonly name: string;
    readonly decide: (input: In, env: PolicyEnv) => Out;
  }
  export interface PolicyBuilder {
    <In, Out>(name: string, decide: (input: In, env: PolicyEnv) => Out): Policy<In, Out>;
    soonestReset(): Policy<readonly AccountView[], AccountView | undefined>;
    specificity(options: { readonly limit: number; readonly trackRecord?: boolean }): Policy<RecallInput, RecallPlan>;
    similarity(options: { readonly limit: number; readonly minScore?: number; readonly trackRecord?: boolean }): Policy<RecallInput, RecallPlan>;
  }

  export interface Executable<In, Out> {
    readonly name: string;
    readonly [brand]: { readonly in: (input: In) => void; readonly out: Out };
  }
  export interface CommandResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string }
  export interface Command<In, Out> extends Executable<In, Out> {
    output<Z extends z.ZodTypeAny>(schema: Z): Command<In, z.infer<Z>>;
    timeoutSeconds(seconds: number): Command<In, Out>;
    env(vars: Readonly<Record<string, string | EnvRef>>): Command<In, Out>;
  }
  export interface CommandStart {
    run<In = void>(argv: (input: In) => readonly string[]): Command<In, CommandResult>;
  }

  export interface Runner {
    readonly name: string;
    readonly [brand]: 'runner';
    slots(count: number): Runner;
    preflight(check: Executable<void, unknown>): Runner;
  }

  export interface Model { readonly name: string; readonly [brand]: 'model' }
  export interface AccountStateStore { readonly name: string; readonly [brand]: 'account-state' }
  export interface Account {
    readonly name: string;
    readonly [brand]: 'account';
    quotaIn(store: AccountStateStore): Account;
  }
  export interface AccountView {
    readonly name: string;
    readonly utilization: number;
    readonly share: number;
    readonly eligible: boolean;
    readonly resetsAt?: Date;
    readonly coolingDownUntil?: Date;
  }
  export interface Pool {
    readonly name: string;
    accounts(...accounts: Account[]): Pool;
    share(account: Account, fraction: number): Pool;
    order(policy: Policy<readonly AccountView[], AccountView | undefined>): Pool;
    fallback(account: Account): Pool;
  }

  export interface Guard { readonly [brand]: 'guard' }
  export interface ModelChoice { readonly unit: Unit<unknown>; readonly kind: AnyWork; readonly agent: string }
  export interface Agent<Out> extends Executable<string, Out> {
    model(model: Model | Policy<ModelChoice, Model>): Agent<Out>;
    pool(pool: Pool): Agent<Out>;
    output<Z extends z.ZodTypeAny>(schema: Z): Agent<z.infer<Z>>;
    recall(...journals: Journal[]): Agent<Out>;
    record(journal: Journal): Agent<Out>;
    guards(...guards: Guard[]): Agent<Out>;
  }

  export interface FlowContext<I, P, S> {
    readonly unit: Unit<I>;
    readonly params: P;
    readonly steps: S;
    readonly round: number;
    readonly attempt: number;
  }
  export interface Failure { readonly step: string; readonly message: string; readonly result?: CommandResult }
  export interface Backoff { readonly max: number; readonly initialSeconds: number; readonly factor: number }
  export interface StepOptions<C, E extends string> {
    readonly on?: Runner | ((ctx: C) => Runner);
    readonly retry?: Backoff;
    readonly onFailure?: 'crash' | { readonly exit: E } | { readonly halt: (ctx: C, failure: Failure) => string };
  }

  export interface Flow<I, P, S, E extends string, N extends string> {
    readonly name: string;
    params<Z extends z.ZodTypeAny>(schema: Z): Flow<I, z.infer<Z>, S, E, N>;
    exits<X extends string>(...reasons: X[]): Flow<I, P, S, X, N>;
    call<K extends string, In, Out>(
      name: K,
      exec: Executable<In, Out>,
      input: (ctx: FlowContext<I, P, S>) => In,
      options?: StepOptions<FlowContext<I, P, S>, E>,
    ): Flow<I, P, S & Record<K, Out>, E, N | K>;
    call<K extends string, Out>(
      name: K,
      exec: Executable<void, Out>,
      options?: StepOptions<FlowContext<I, P, S>, E>,
    ): Flow<I, P, S & Record<K, Out>, E, N | K>;
    fanout<K extends string, In, Out>(
      name: K,
      exec: Executable<In, Out>,
      inputs: (ctx: FlowContext<I, P, S>) => readonly In[],
      options?: StepOptions<FlowContext<I, P, S>, E> & { readonly mode?: 'parallel' | 'batch' },
    ): Flow<I, P, S & Record<K, readonly Out[]>, E, N | K>;
    halt<K extends string, Z extends z.ZodTypeAny>(
      name: K,
      request: {
        readonly ask: (ctx: FlowContext<I, P, S>) => string;
        readonly decision: Z;
        readonly unless?: { readonly policy: Policy<FlowContext<I, P, S>, boolean>; readonly assume: z.infer<Z> };
      },
    ): Flow<I, P, S & Record<K, z.infer<Z>>, E, N | K>;
    spawn<K extends string, D>(
      name: K,
      kind: WorkKind<string, D, State>,
      children: (ctx: FlowContext<I, P, S>) => readonly D[],
    ): Flow<I, P, S & Record<K, readonly UnitRef[]>, E, N | K>;
    when<K extends string, S2, N2 extends string>(
      name: K,
      test: ((ctx: FlowContext<I, P, S>) => boolean) | Policy<FlowContext<I, P, S>, boolean>,
      body: (flow: Flow<I, P, S, E, never>) => Flow<I, P, S2, E, N2>,
    ): Flow<I, P, S & Partial<Omit<S2, keyof S>>, E, N | K | N2>;
    repeat<K extends string, S2, N2 extends string>(
      name: K,
      body: (flow: Flow<I, P, S, E, never>) => Flow<I, P, S2, E, N2>,
      options: {
        readonly max: number | ((ctx: FlowContext<I, P, S>) => number);
        readonly until: (ctx: FlowContext<I, P, S2>) => boolean;
      },
    ): Flow<I, P, S2, E, N | K | N2>;
    update(change: (ctx: FlowContext<I, P, S>) => Partial<I>): Flow<I, P, S, E, N>;
    label(labels: (ctx: FlowContext<I, P, S>) => Readonly<Record<string, string>>): Flow<I, P, S, E, N>;
    record(journal: Journal, items: (ctx: FlowContext<I, P, S>) => readonly MemoryDraft[]): Flow<I, P, S, E, N>;
    exitWhen(reason: (ctx: FlowContext<I, P, S>) => E | undefined): Flow<I, P, S, E, N>;
    exit(reason: E | ((ctx: FlowContext<I, P, S>) => E)): Handler<I, P, E, N>;
  }
  export interface Handler<I, P, E extends string, N extends string> {
    readonly name: string;
    readonly [brand]: {
      readonly input: (input: I) => void;
      readonly params: (params: P) => void;
      readonly exits: E;
      readonly steps: N;
    };
  }

  export interface Supplier<D> { readonly name: string; readonly [brand]: { readonly produces: D } }
  export interface Store<D> { readonly name: string; readonly [brand]: { readonly holds: (data: D) => D } }
  export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
  export type Cadence =
    | { readonly every: { readonly minutes?: number; readonly hours?: number } }
    | { readonly daily: { readonly at: string } }
    | { readonly weekly: { readonly on: Weekday; readonly at: string } }
    | { readonly monthly: { readonly day: number; readonly at: string } };
  export interface UnitLookup<D> {
    list(filter?: {
      readonly outcome?: Outcome | readonly Outcome[];
      readonly where?: (unit: Unit<D>) => boolean;
    }): Promise<readonly Unit<D>[]>;
  }
  export interface Tick<D> { readonly now: Date; readonly units: UnitLookup<D> }
  export interface ScheduleStart<D> {
    create(make: (tick: Tick<D>) => readonly D[] | Promise<readonly D[]>): Supplier<D>;
    send<P>(
      message: Message<P>,
      deliveries: (tick: Tick<D>) =>
        | readonly { readonly key: string; readonly payload: P }[]
        | Promise<readonly { readonly key: string; readonly payload: P }[]>,
    ): Supplier<D>;
  }

  export interface Intensity { readonly maxRestarts: number; readonly withinSeconds: number }

  export interface AnyLane {
    readonly name: string;
    readonly [brand]: { readonly data: unknown; readonly states: State };
  }

  export interface Lane<D, S extends State, E extends string = never, N extends string = never> extends AnyLane {
    readonly name: string;
    readonly [brand]: { readonly data: D; readonly states: S };
    supply(...suppliers: Supplier<D>[]): Lane<D, S, E, N>;
    store(store: Store<D>): Lane<D, S, E, N>;
    handler<E2 extends string, N2 extends string>(flow: Handler<D, void, E2, N2>): Lane<D, S, E2, N2>;
    handler<P, E2 extends string, N2 extends string>(flow: Handler<D, P, E2, N2>, params: P): Lane<D, S, E2, N2>;
    exits(map: Readonly<Record<E | 'crashed', S>>): Lane<D, S, E, N>;
    phases(map: Partial<Readonly<Record<N, S>>>): Lane<D, S, E, N>;
    receive<P>(message: Message<P>, react: (payload: P, unit: Unit<D, S>) => Reaction<D, S> | undefined): Lane<D, S, E, N>;
    deadline(at: (unit: Unit<D, S>) => Date | undefined): Lane<D, S, E, N>;
    costCeiling(ceiling: { readonly maxUsd: number; readonly onBreach: 'halt' | 'crash' }): Lane<D, S, E, N>;
    runner(runner: Runner): Lane<D, S, E, N>;
    restart(intensity: Intensity): Lane<D, S, E, N>;
  }

  export interface AttemptSummary {
    readonly number: number;
    readonly exit: string;
    readonly durationSeconds: number;
    readonly costUsd: number;
  }
  export interface TransitionEvent<D> {
    readonly unit: Unit<D>;
    readonly from: string;
    readonly to: string;
    readonly attempt?: AttemptSummary;
  }
  export interface StreakEvent<D> { readonly group: string; readonly units: readonly Unit<D>[] }
  export interface DeadlineEvent<D> { readonly unit: Unit<D> }
  export interface Source<E> { readonly [brand]: { readonly event: E } }
  export interface Consequence { readonly [brand]: 'consequence' }
  export interface Trigger { readonly name: string; readonly [brand]: 'trigger' }
  export interface TriggerOn<E> {
    do(consequence: (event: E) => Consequence | readonly Consequence[] | undefined): Trigger;
  }
  export interface TriggerStart { on<E>(source: Source<E>): TriggerOn<E> }

  export interface Candidate {
    readonly unit: Unit<unknown>;
    readonly lane: string;
    readonly waitingSeconds: number;
    readonly deadline?: Date;
  }
  export interface RunningAttempt {
    readonly unit: Unit<unknown>;
    readonly lane: string;
    readonly startedAt: Date;
    readonly blocked: boolean;
  }
  export interface SchedulingInput {
    readonly pending: readonly Candidate[];
    readonly running: readonly RunningAttempt[];
  }
  export interface Scheduler {
    readonly name: string;
    order(policy: Policy<SchedulingInput, readonly Candidate[]>): Scheduler;
    wip(lane: AnyLane, max: number): Scheduler;
  }

  export interface Operation<In = unknown> {
    readonly name: string;
    readonly [brand]: { readonly input: (input: In) => void };
  }
  export interface Grant { readonly name: string; readonly [brand]: 'grant' }
  export interface Client { readonly name: string; readonly [brand]: 'client' }
  export interface Observer { readonly name: string; readonly [brand]: 'observer' }
  export interface Ledger { readonly name: string; readonly [brand]: 'ledger' }

  export interface RunningHarness {
    readonly name: string;
    stop(): Promise<void>;
  }
  export interface Harness {
    readonly name: string;
    ledger(ledger: Ledger): Harness;
    lanes(...lanes: AnyLane[]): Harness;
    triggers(...triggers: Trigger[]): Harness;
    scheduler(scheduler: Scheduler): Harness;
    clients(...clients: Client[]): Harness;
    observe(...observers: Observer[]): Harness;
    timeZone(zone: string): Harness;
    restart(intensity: Intensity): Harness;
    start(): Promise<RunningHarness>;
  }

  export const H: {
    env(name: string): EnvRef;
    slot: { port(preferred: number): PortRef };

    state<N extends string, O extends Outcome>(name: N, outcome: O): State<N, O>;
    work<N extends string, Z extends z.ZodTypeAny>(name: N, schema: Z): WorkKind<N, z.infer<Z>, never>;
    message<Z extends z.ZodTypeAny>(name: string, schema: Z): Message<z.infer<Z>>;
    down: Message<ChildExit>;
    deliver<P>(message: Message<P>, key: string, payload: NoInfer<P>): Delivery;
    role(name: string): Role;
    resource(name: string): Resource;
    memory: {
      experience(name: string): MemoryKind<'experience'>;
      taste(name: string): MemoryKind<'taste'>;
    };

    command(name: string): CommandStart;
    agent(name: string, role: Role): Agent<string>;
    guard: {
      lease(resource: Resource): Guard;
      stopCheck(check: Executable<void, unknown>): Guard;
    };

    pool(name: string): Pool;
    journal(name: string, kind: MemoryKind): Journal;
    flow<I = unknown>(name: string): Flow<I, void, {}, never, never>;
    lane<D, S extends State>(kind: WorkKind<string, D, S>): Lane<D, S>;
    supply: {
      schedule<D>(kind: WorkKind<string, D, State>, cadence: Cadence): ScheduleStart<D>;
      operator(): Supplier<never>;
    };
    trigger(name: string): TriggerStart;
    on: {
      enter<D, S extends State>(kind: WorkKind<string, D, S>, state: NoInfer<S> | readonly NoInfer<S>[]): Source<TransitionEvent<D>>;
      streak<D, S extends State>(
        kind: WorkKind<string, D, S>,
        pattern: { readonly state: NoInfer<S>; readonly count: number; readonly by: (unit: Unit<D>) => string },
      ): Source<StreakEvent<D>>;
      deadline<D, S extends State, E extends string, N extends string>(
        lane: Lane<D, S, E, N>,
        options?: { readonly while?: readonly NoInfer<S>[] },
      ): Source<DeadlineEvent<D>>;
    };
    do: {
      create<D, S extends State, E extends string, N extends string>(lane: Lane<D, S, E, N>, data: NoInfer<D>): Consequence;
      send<D, S extends State, E extends string, N extends string>(lane: Lane<D, S, E, N>, delivery: Delivery): Consequence;
      react<D, S extends State, E extends string, N extends string>(
        lane: Lane<D, S, E, N>,
        unit: UnitRef,
        reaction: Reaction<NoInfer<D>, NoInfer<S>>,
      ): Consequence;
      record(journal: Journal, item: MemoryDraft): Consequence;
      run<In>(exec: Executable<In, unknown>, input: NoInfer<In>): Consequence;
    };

    policy: PolicyBuilder;
    metric(name: string, ratio: { readonly count: Selector; readonly of: Selector }): Metric;
    scheduler(name: string): Scheduler;

    op: {
      readonly readWork: Operation;
      readonly createWork: Operation;
      readonly updateWork: Operation;
      readonly cancelWork: Operation;
      readonly sendMessage: Operation;
      readonly resolveBlocker: Operation;
      readonly readMemory: Operation;
      readonly writeMemory: Operation;
      readonly curateMemory: Operation;
      readonly readTelemetry: Operation;
      readonly setAccountShare: Operation;
    };
    operation<Z extends z.ZodTypeAny, Out>(
      name: string,
      spec: { readonly input: Z; readonly run: Executable<z.infer<Z>, Out> },
    ): Operation<z.infer<Z>>;
    grant(name: string, ...operations: Operation<never>[]): Grant;

    harness(name: string): Harness;
  };
}

declare module 'harness-dsl/sqlite' {
  import { Ledger, Store, AccountStateStore, WorkKind, State } from 'harness-dsl';
  export function ledger(path: string): Ledger;
  export function store<D>(kind: WorkKind<string, D, State>, path: string): Store<D>;
  export function accountState(path: string): AccountStateStore;
}

declare module 'harness-dsl/jsonl' {
  import { MemoryStore } from 'harness-dsl';
  export function memory(path: string): MemoryStore;
}

declare module 'harness-dsl/qdrant' {
  import { MemoryStore, EnvRef } from 'harness-dsl';
  export function memory(options: {
    readonly url: string | EnvRef;
    readonly collection: string;
    readonly apiKey?: EnvRef;
  }): MemoryStore;
}

declare module 'harness-dsl/claude-code' {
  import { Account, Model, Client, Grant, EnvRef } from 'harness-dsl';
  export function subscription(name: string, options: { readonly credentials: EnvRef }): Account;
  export function model(id: 'opus' | 'sonnet' | 'haiku'): Model;
  export function supervisor(
    options: { readonly grant: Grant } | { readonly endpoints: readonly string[] },
  ): Client;
}

declare module 'harness-dsl/anthropic' {
  import { Account, Model, EnvRef } from 'harness-dsl';
  export function apiKey(name: string, options: { readonly key: EnvRef }): Account;
  export function model(id: string, options?: { readonly batch?: boolean }): Model;
}

declare module 'harness-dsl/linear' {
  import { Supplier, Store, EnvRef } from 'harness-dsl';
  export interface LinearIssue {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly description: string;
    readonly labels: readonly string[];
    readonly state: string;
    readonly parentId?: string;
  }
  export function tracker<D>(options: {
    readonly team: string;
    readonly apiKey: EnvRef;
    readonly labels?: readonly string[];
    readonly map: (issue: LinearIssue) => D;
    readonly patch?: (data: D, state: string) => Partial<LinearIssue>;
  }): Supplier<D> & Store<D>;
}

declare module 'harness-dsl/folder' {
  import { Supplier, Store } from 'harness-dsl';
  export interface MarkdownFile {
    readonly path: string;
    readonly body: string;
    readonly frontmatter: Readonly<Record<string, string | number | boolean>>;
  }
  export function markdown<D>(options: {
    readonly dir: string;
    readonly map: (file: MarkdownFile) => D;
    readonly frontmatter?: (data: D, state: string) => Readonly<Record<string, string | number | boolean>>;
  }): Supplier<D> & Store<D>;
}

declare module 'harness-dsl/markdown' {
  import { Observer } from 'harness-dsl';
  export function board(options: { readonly path: string }): Observer;
  export function telemetry(options: { readonly path: string }): Observer;
}

declare module 'harness-dsl/zendesk' {
  import { Supplier, Store, Arrival, EnvRef, PortRef } from 'harness-dsl';
  export interface ZendeskTicket {
    readonly id: number;
    readonly subject: string;
    readonly latestComment: string;
    readonly requesterEmail: string;
    readonly status: string;
    readonly priority: string;
    readonly updatedAt: Date;
  }
  export interface ZendeskEvent {
    readonly type: 'ticket.created' | 'comment.added' | 'ticket.updated';
    readonly ticket: ZendeskTicket;
    readonly byRequester: boolean;
  }
  export function webhook<D>(options: {
    readonly secret: EnvRef;
    readonly port: PortRef;
    readonly route: (event: ZendeskEvent) => Arrival<D> | undefined;
  }): Supplier<D>;
  export function poll<D>(options: {
    readonly subdomain: string;
    readonly token: EnvRef;
    readonly everyMinutes: number;
    readonly map: (ticket: ZendeskTicket) => D;
  }): Supplier<D>;
  export function store<D>(options: {
    readonly subdomain: string;
    readonly token: EnvRef;
    readonly map: (ticket: ZendeskTicket) => D;
    readonly patch: (data: D, state: string) => Partial<ZendeskTicket>;
  }): Store<D>;
}

declare module 'harness-dsl/http' {
  import { Supplier, Store, Client, Grant, Arrival, EnvRef, PortRef } from 'harness-dsl';
  export interface Request {
    readonly body: unknown;
    readonly headers: Readonly<Record<string, string>>;
  }
  export function server(options: { readonly grant: Grant; readonly port: PortRef; readonly token?: EnvRef }): Client;
  export function webhook<D>(options: {
    readonly port: PortRef;
    readonly path: string;
    readonly route: (request: Request) => Arrival<D> | undefined;
  }): Supplier<D>;
  export function poll<D>(options: {
    readonly url: string | EnvRef;
    readonly everyMinutes: number;
    readonly headers?: Readonly<Record<string, string | EnvRef>>;
    readonly map: (body: unknown) => readonly D[];
  }): Supplier<D>;
  export function store<D>(options: {
    readonly baseUrl: string | EnvRef;
    readonly headers?: Readonly<Record<string, string | EnvRef>>;
    readonly read: (body: unknown) => D;
    readonly write: (data: D, state: string) => unknown;
  }): Store<D>;
}

declare module 'harness-dsl/local' {
  import { Runner } from 'harness-dsl';
  export function runner(name: string): Runner;
}

declare module 'harness-dsl/ssh' {
  import { Runner, EnvRef } from 'harness-dsl';
  export function host(name: string, options: { readonly host: string; readonly user: string; readonly key: EnvRef }): Runner;
}

declare module 'harness-dsl/git' {
  import { Runner, Resource } from 'harness-dsl';
  export function worktrees(name: string, options: { readonly repo: string; readonly base?: string; readonly resource: Resource }): Runner;
}

declare module 'harness-dsl/slack' {
  import { Observer, AnyWork, TransitionEvent, EnvRef } from 'harness-dsl';
  export function notify(options: {
    readonly webhook: EnvRef;
    readonly kinds?: readonly AnyWork[];
    readonly text: (event: TransitionEvent<unknown>) => string;
  }): Observer;
}
