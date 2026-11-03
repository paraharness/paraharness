declare module 'harness-dsl' {
  import { z } from 'zod';
  import type {
    Ref,
    Ledger,
    Store,
    MemoryStore,
    Meter,
    Runner,
    Workspace,
    Observer,
    Transport,
    Producer,
    Account,
    Model,
    Metrics,
    PolicyContext,
    Rate,
    Skeleton,
    ControlApi,
  } from 'harness-dsl/kernel';

  export type {
    Ref,
    Ledger,
    Store,
    MemoryStore,
    Meter,
    Runner,
    Workspace,
    Observer,
    Transport,
    Producer,
    Account,
    Model,
    Metrics,
    PolicyContext,
    Rate,
    Skeleton,
  } from 'harness-dsl/kernel';

  export type Schema<T> = z.ZodType<T, unknown>;

  export interface Named {
    readonly name: string;
  }

  export type Outcome = 'runnable' | 'waiting' | 'succeeded' | 'failed' | 'cancelled' | 'ended';

  export interface State<N extends string = string, O extends Outcome = Outcome> {
    readonly name: N;
    readonly outcome: O;
  }

  export type Runnable<S> = Extract<S, State<string, 'runnable'>>;

  export interface Duration {
    readonly minutes?: number;
    readonly hours?: number;
    readonly days?: number;
  }

  export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

  export interface Timer<D> {
    readonly schedule: string;
    readonly at: ((data: D) => Date) | null;
  }

  export interface Tick {
    readonly at: Date;
  }

  export interface UnitStatus {
    readonly kind: string;
    readonly key: string;
    readonly state: string;
    readonly outcome: Skeleton;
  }

  export type Messages = { readonly [event: string]: unknown };

  export type Builtin = {
    readonly cancel: { readonly reason: string };
    readonly down: UnitStatus;
  };

  export interface UnitView<D> {
    readonly key: string;
    readonly data: D;
    readonly state: string;
    readonly blocked: boolean;
  }

  export interface Rule<D, S extends State, P> {
    readonly from: readonly S[];
    readonly to: S;
    readonly attempt?: 'cancel' | 'keep';
    readonly guard?: (unit: UnitView<D>, payload: P) => boolean;
    readonly update?: (data: D, payload: P) => D;
  }

  export interface DataKind<D> extends Named {
    readonly data: Schema<D>;
  }

  export interface Kind<N extends string, D, S extends State, M extends Messages> extends DataKind<D> {
    readonly name: N;
    states<T extends State>(states: readonly T[], options: { readonly initial: T }): Kind<N, D, T, M>;
    messages<X extends { readonly [event: string]: Schema<unknown> }>(
      schemas: X,
    ): Kind<N, D, S, M & { readonly [K in keyof X]: z.infer<X[K]> }>;
    timeout<const E extends string>(
      states: S | readonly S[],
      timer: Timer<D>,
      event: E,
    ): Kind<N, D, S, M & { readonly [K in E]: Tick }>;
    on<E extends keyof M & string>(event: E, rule: Rule<D, S, M[E]>): Kind<N, D, S, M>;
  }

  export interface Resource extends Named {
    key(key: string): ResourceRef;
  }

  export interface ResourceRef {
    readonly resource: string;
    readonly key: string;
  }

  export type Intent = 'read' | 'edit' | 'execute' | 'search' | 'browse' | 'ask';

  export interface Role<I, O> extends Named {
    readonly input: Schema<I>;
    readonly output: Schema<O>;
  }

  export interface MemoryKind extends Named {
    readonly authority: 'owner' | 'observed';
  }

  export interface Scope {
    readonly kinds?: readonly Named[];
    readonly roles?: readonly Named[];
    readonly skills?: readonly string[];
    readonly resources?: readonly (Resource | ResourceRef)[];
  }

  export interface MemoryDraft {
    readonly do: string;
    readonly condition: string;
    readonly because: string;
    readonly when?: Scope;
    readonly status?: 'candidate' | 'active';
  }

  export interface Recall extends Named {
    readonly limit: number;
  }

  export interface Journal extends Named {
    readonly memory: MemoryKind;
    store(store: MemoryStore): Journal;
    recall(recall: Recall): Journal;
  }

  export interface Executable<I, O> extends Named {
    readonly input: Schema<I>;
    readonly output: Schema<O>;
  }

  export interface CommandResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }

  export interface Command<I, O> extends Executable<I, O> {
    record(journal: Journal, extract: (output: O) => readonly MemoryDraft[]): Command<I, O>;
  }

  export interface Guard extends Named {}

  export interface AccountView {
    readonly name: string;
    readonly utilization: number;
    readonly resetsAt: Date | null;
    readonly cooldownUntil: Date | null;
    readonly share: number;
    readonly eligible: boolean;
  }

  export interface Pool extends Named {
    accounts(shares: readonly { readonly account: Account; readonly share: number }[]): Pool;
    order(order: (accounts: readonly AccountView[], context: PolicyContext) => readonly AccountView[]): Pool;
    fallback(account: Account): Pool;
  }

  export interface ChoiceQuery<M extends Model> {
    readonly kind: string;
    readonly agent: string;
    readonly models: readonly M[];
  }

  export interface Choice extends Named {
    readonly models: readonly Model[];
  }

  export interface Agent<I, O> extends Executable<I, O> {
    model(model: Model | Choice): Agent<I, O>;
    pool(pool: Pool): Agent<I, O>;
    recall(...journals: readonly Journal[]): Agent<I, O>;
    record(journal: Journal): Agent<I, O>;
    workspace(workspace: Workspace): Agent<I, O>;
    guard(...guards: readonly Guard[]): Agent<I, O>;
  }

  export interface Policy<I, O> extends Named {
    readonly decide: (input: I, context: PolicyContext) => O;
  }

  export interface Retry extends Named {}

  export interface Exit<E extends string> {
    readonly exit: E;
  }

  export type Outcomeless = { readonly [field: string]: never };

  export interface Target<D> extends Named {
    readonly accepts: (data: D) => void;
  }

  export type StepResult<B> =
    | { readonly ok: true; readonly output: B }
    | { readonly ok: false; readonly error: string; readonly stdout: string };

  export interface FlowContext<I, P, E extends string, O> {
    readonly input: I;
    readonly params: P;
    readonly unit: { readonly key: string; readonly kind: string; readonly lane: string; readonly attempt: number };
    received<T>(event: string, payload: Schema<T>): readonly T[];
    run<A, B>(step: string, executable: Executable<A, B>, input: NoInfer<A>, options?: { readonly retry?: Retry }): Promise<B>;
    try<A, B>(step: string, executable: Executable<A, B>, input: NoInfer<A>, options?: { readonly retry?: Retry }): Promise<StepResult<B>>;
    batch<A, B>(step: string, agent: Agent<A, B>, inputs: readonly NoInfer<A>[]): Promise<readonly B[]>;
    decide<A, B>(step: string, policy: Policy<A, B>, input: NoInfer<A>): Promise<B>;
    halt<T>(step: string, request: { readonly question: string; readonly report?: string; readonly decision: Schema<T> }): Promise<T>;
    spawn<C>(step: string, lane: Target<C>, data: readonly NoInfer<C>[]): Promise<readonly string[]>;
    children(step: string): Promise<readonly UnitStatus[]>;
    readonly exit: (exit: E, writes?: O) => Exit<E>;
  }

  export interface Flow<I, P, E extends string, O> extends Named {
    readonly run: (context: FlowContext<I, P, E, O>) => Promise<Exit<E>>;
  }

  export interface FlowSpec<I, P, E extends string, O> {
    readonly input: Schema<I>;
    readonly params?: Schema<P>;
    readonly writes?: Schema<O>;
    readonly exits: readonly E[];
  }

  export type HandleOptions<S extends State, P, E extends string> = {
    readonly exits: { readonly [K in E]: S };
    readonly crash?: { readonly retries: number; readonly then: S };
  } & ({} extends P ? { readonly params?: P } : { readonly params: P });

  export interface Delivery {
    readonly delivery: 'create' | 'send';
  }

  export interface UnitSink<D, M extends Messages> {
    create(data: D): Delivery;
    send<E extends keyof M & string>(key: string, event: E, payload: M[E]): Delivery;
  }

  export interface Supplier<N extends string> extends Named {
    readonly kind: N;
  }

  export interface Feed<R> extends Named {
    readonly producer: Producer<R>;
    to<N extends string, D, S extends State, M extends Messages>(
      kind: Kind<N, D, S, M>,
      map: (record: R, unit: UnitSink<D, M>) => Delivery | readonly Delivery[],
    ): Supplier<N>;
  }

  export interface Registry {
    find<D>(kind: DataKind<D>, filter?: { readonly states?: readonly State[] }): Promise<readonly UnitView<D>[]>;
  }

  export interface LaneRef extends Named {
    readonly kindName: string;
  }

  export interface Lane<N extends string, D, S extends State, M extends Messages> extends LaneRef, Target<D> {
    readonly kind: Kind<N, D, S, M>;
    supply(...suppliers: readonly Supplier<N>[]): Lane<N, D, S, M>;
    store(store: Store): Lane<N, D, S, M>;
    handle<P, E extends string, O extends Partial<D>>(
      state: Runnable<S>,
      flow: Flow<D, P, E, O>,
      options: HandleOptions<S, P, E>,
    ): Lane<N, D, S, M>;
    limit(limits: { readonly wip?: number; readonly queue?: number; readonly maxUsdPerUnit?: number }): Lane<N, D, S, M>;
    resources(select: (data: D) => readonly ResourceRef[]): Lane<N, D, S, M>;
  }

  export interface AttemptSummary {
    readonly id: string;
    readonly durationSeconds: number;
    readonly costUsd: number;
  }

  export interface Transition<D> {
    readonly unit: { readonly key: string; readonly data: D };
    readonly from: string;
    readonly to: string;
    readonly at: Date;
    readonly attempt: AttemptSummary | null;
  }

  export interface Received<D, P> {
    readonly unit: { readonly key: string; readonly data: D };
    readonly event: string;
    readonly payload: P;
    readonly at: Date;
  }

  export interface Streak<D> {
    readonly group: string;
    readonly units: readonly { readonly key: string; readonly data: D }[];
    readonly at: Date;
  }

  export interface Decided<D, T> {
    readonly unit: { readonly key: string; readonly data: D };
    readonly step: string;
    readonly decision: T;
    readonly by: string;
    readonly at: Date;
  }

  export interface TriggerSource<Ev> extends Named {
    readonly describe: (event: Ev) => string;
  }

  export interface Trigger extends Named {}

  export interface TriggerOn<Ev> {
    where(predicate: (event: Ev) => boolean): TriggerOn<Ev>;
    create<C>(lane: Target<C>, make: (event: Ev) => NoInfer<C>): Trigger;
    note(journal: Journal, make: (event: Ev) => MemoryDraft | readonly MemoryDraft[]): Trigger;
  }

  export interface TriggerStart {
    on<Ev>(source: TriggerSource<Ev>): TriggerOn<Ev>;
  }

  export interface InvocationView {
    readonly step: string;
    readonly executable: string;
    readonly model: string | null;
    readonly ok: boolean;
    readonly costUsd: number;
  }

  export interface Sample<D> {
    readonly unit: { readonly key: string; readonly data: D };
    readonly state: string;
    readonly outcome: Skeleton;
    readonly costUsd: number;
    readonly durationSeconds: number;
    readonly invocations: readonly InvocationView[];
    decision<T>(step: string, schema: Schema<T>): T | null;
  }

  export interface Metric extends Named {}

  export interface PendingView {
    readonly kind: string;
    readonly lane: string;
    readonly key: string;
    readonly state: string;
    readonly waitingSeconds: number;
    readonly nextTimeoutAt: Date | null;
    is(kind: Named): boolean;
  }

  export interface ActiveView {
    readonly kind: string;
    readonly lane: string;
    readonly key: string;
    readonly attemptId: string;
    readonly blocked: boolean;
    readonly startedAt: Date;
    is(kind: Named): boolean;
  }

  export interface SchedulerQuery extends PolicyContext {
    readonly pending: readonly PendingView[];
    readonly active: readonly ActiveView[];
  }

  export interface Plan {
    readonly order: readonly PendingView[];
    readonly preempt?: readonly ActiveView[];
  }

  export interface Scheduler extends Named {}

  export interface Operation extends Named {}

  export interface Client extends Named {
    grant(operations: readonly Operation[]): Client;
  }

  export interface Running {
    readonly control: ControlApi;
    stop(): Promise<void>;
  }

  export interface Harness extends Named {
    ledger(ledger: Ledger): Harness;
    lanes(lanes: readonly LaneRef[]): Harness;
    journals(journals: readonly Journal[]): Harness;
    triggers(triggers: readonly Trigger[]): Harness;
    scheduler(scheduler: Scheduler): Harness;
    clients(clients: readonly Client[]): Harness;
    observers(observers: readonly Observer[]): Harness;
    restart(intensity: { readonly maxRestarts: number; readonly withinSeconds: number }): Harness;
    start(): Promise<Running>;
  }

  export const H: {
    env(name: string): Ref<string>;
    slot: { port(index: number): Ref<number> };

    state<const N extends string, const O extends Outcome>(name: N, outcome: O): State<N, O>;
    kind<const N extends string, D>(name: N, spec: { readonly data: Schema<D>; readonly key: (data: D) => string }): Kind<N, D, never, Builtin>;
    resource(name: string): Resource;
    role<I, O>(name: string, spec: { readonly prompt: string; readonly intents: readonly Intent[]; readonly input: Schema<I>; readonly output: Schema<O> }): Role<I, O>;
    memory(name: string, spec: { readonly authority: 'owner' | 'observed' }): MemoryKind;

    time: {
      every(interval: Duration): Timer<unknown>;
      daily(hhmm: string): Timer<unknown>;
      weekly(day: Weekday, hhmm: string): Timer<unknown>;
      monthly(dayOfMonth: number, hhmm: string): Timer<unknown>;
      after(delay: Duration): Timer<unknown>;
      deadline<D>(at: (data: D) => Date): Timer<D>;
    };

    retry: {
      exponential(spec: { readonly attempts: number; readonly initialSeconds: number; readonly factor?: number }): Retry;
    };

    recall: {
      bySpecificity(spec: { readonly limit: number }): Recall;
      bySimilarity(spec: { readonly limit: number }): Recall;
    };

    guard: {
      lease(resource: Resource): Guard;
      beforeStop(check: Executable<{ readonly workspacePath: string }, unknown>): Guard;
    };

    command<I, O = CommandResult>(
      name: string,
      spec: {
        readonly input: Schema<I>;
        readonly output?: Schema<O>;
        readonly argv: (input: I) => readonly string[];
        readonly runner: Runner | ((input: I) => Runner);
      },
    ): Command<I, O>;
    agent<I, O>(name: string, role: Role<I, O>): Agent<I, O>;
    pool(name: string): Pool;
    choose<M extends Model>(name: string, models: readonly M[], pick: (query: ChoiceQuery<M>, context: PolicyContext) => M): Choice;
    policy<I, O>(name: string, decide: (input: I, context: PolicyContext) => O): Policy<I, O>;
    metric<D>(
      name: string,
      spec: {
        readonly kind: DataKind<D>;
        readonly sample: (sample: Sample<D>) => number | boolean | null;
        readonly group?: (sample: Sample<D>) => string;
      },
    ): Metric;

    flow<I, P = Outcomeless, E extends string = never, O = Outcomeless>(
      name: string,
      spec: FlowSpec<I, P, E, O>,
      run: (context: FlowContext<I, P, E, O>) => Promise<Exit<E>>,
    ): Flow<I, P, E, O>;

    journal(name: string, memory: MemoryKind): Journal;

    feed<R>(producer: Producer<R>): Feed<R>;
    supply: {
      operator<N extends string, D, S extends State, M extends Messages>(kind: Kind<N, D, S, M>): Supplier<N>;
      schedule<N extends string, D, S extends State, M extends Messages>(
        kind: Kind<N, D, S, M>,
        timer: Timer<unknown>,
        produce: (tick: Tick, unit: UnitSink<D, M>, registry: Registry) => readonly Delivery[] | Promise<readonly Delivery[]>,
      ): Supplier<N>;
    };

    lane<N extends string, D, S extends State, M extends Messages>(name: string, kind: Kind<N, D, S, M>): Lane<N, D, S, M>;

    when: {
      entered<N extends string, D, S extends State, M extends Messages>(kind: Kind<N, D, S, M>, states: S | readonly S[]): TriggerSource<Transition<D>>;
      event<N extends string, D, S extends State, M extends Messages, E extends keyof M & string>(kind: Kind<N, D, S, M>, event: E): TriggerSource<Received<D, M[E]>>;
      streak<N extends string, D, S extends State, M extends Messages>(
        kind: Kind<N, D, S, M>,
        state: S,
        count: number,
        options: { readonly by: (data: D) => string },
      ): TriggerSource<Streak<D>>;
      decided<N extends string, D, S extends State, M extends Messages, T>(kind: Kind<N, D, S, M>, step: string, decision: Schema<T>): TriggerSource<Decided<D, T>>;
    };
    trigger(name: string): TriggerStart;

    scheduler(name: string, plan: (query: SchedulerQuery) => Plan): Scheduler;

    ops: {
      readonly readWork: Operation;
      readonly writeWork: Operation;
      readonly resolveBlockers: Operation;
      readonly readMemory: Operation;
      readonly writeMemory: Operation;
      readonly curateMemory: Operation;
      readonly readTelemetry: Operation;
      readonly readAccounts: Operation;
      readonly writeShares: Operation;
    };
    operation<I, O>(name: string, executable: Executable<I, O>): Operation;
    client(name: string, transport: Transport): Client;

    harness(name: string): Harness;
  };
}

declare module 'harness-dsl/sqlite' {
  import type { Ledger, Store, Meter } from 'harness-dsl/kernel';
  export const sqlite: {
    ledger(path: string): Ledger;
    store(path: string): Store;
    meter(path: string): Meter;
  };
}

declare module 'harness-dsl/jsonl' {
  import type { MemoryStore } from 'harness-dsl/kernel';
  export const jsonl: {
    store(path: string): MemoryStore;
  };
}

declare module 'harness-dsl/qdrant' {
  import type { MemoryStore, Embedder, Ref } from 'harness-dsl/kernel';
  export const qdrant: {
    store(spec: { readonly url: Ref<string>; readonly collection: string; readonly embedder: Embedder }): MemoryStore;
  };
}

declare module 'harness-dsl/claude-code' {
  import type { Account, Model, Meter, Transport, Ref } from 'harness-dsl/kernel';
  export const claudeCode: {
    subscription(name: string, spec: { readonly configDir: Ref<string>; readonly meter?: Meter }): Account;
    apiKey(name: string, spec: { readonly key: Ref<string>; readonly meter?: Meter }): Account;
    model(name: 'opus' | 'sonnet' | 'haiku'): Model;
    session(spec?: { readonly port?: Ref<number> }): Transport;
  };
}

declare module 'harness-dsl/anthropic' {
  import type { Account, Model, Meter, Ref } from 'harness-dsl/kernel';
  export const anthropic: {
    apiKey(name: string, spec: { readonly key: Ref<string>; readonly meter?: Meter }): Account;
    model(id: string, spec?: { readonly batch?: boolean }): Model;
  };
}

declare module 'harness-dsl/openai' {
  import type { Account, Model, Embedder, Meter, Ref } from 'harness-dsl/kernel';
  export const openai: {
    apiKey(name: string, spec: { readonly key: Ref<string>; readonly meter?: Meter }): Account;
    model(id: string, spec?: { readonly batch?: boolean }): Model;
    embedder(id: string, spec: { readonly key: Ref<string> }): Embedder;
  };
}

declare module 'harness-dsl/linear' {
  import type { Feed } from 'harness-dsl';
  import type { Store, Ref } from 'harness-dsl/kernel';
  export interface LinearIssue {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly description: string;
    readonly labels: readonly string[];
    readonly parentId: string | null;
    readonly state: string;
  }
  export const linear: {
    issues(spec: { readonly team: string; readonly apiKey: Ref<string>; readonly labels?: readonly string[] }): Feed<LinearIssue>;
    store(spec: { readonly team: string; readonly apiKey: Ref<string>; readonly states?: { readonly [harnessState: string]: string } }): Store;
  };
}

declare module 'harness-dsl/folder' {
  import type { Feed, Schema } from 'harness-dsl';
  import type { Store } from 'harness-dsl/kernel';
  export interface FolderFile<F> {
    readonly path: string;
    readonly frontmatter: F;
    readonly body: string;
  }
  export const folder: {
    files<F>(spec: { readonly dir: string; readonly frontmatter: Schema<F> }): Feed<FolderFile<F>>;
    store(spec: { readonly dir: string }): Store;
  };
}

declare module 'harness-dsl/git' {
  import type { Workspace } from 'harness-dsl/kernel';
  export const git: {
    worktree(spec: { readonly repo: string; readonly baseBranch?: string }): Workspace;
  };
}

declare module 'harness-dsl/shell' {
  import type { Runner } from 'harness-dsl/kernel';
  export const shell: {
    local(spec?: { readonly slots?: number }): Runner;
  };
}

declare module 'harness-dsl/ssh' {
  import type { Runner, Ref } from 'harness-dsl/kernel';
  export const ssh: {
    host(spec: {
      readonly host: string;
      readonly user: string;
      readonly privateKey: Ref<string>;
      readonly slots?: number;
      readonly preflight?: readonly string[];
    }): Runner;
  };
}

declare module 'harness-dsl/http' {
  import type { Feed, Schema } from 'harness-dsl';
  import type { Transport, Ref } from 'harness-dsl/kernel';
  export const http: {
    webhook<B>(spec: { readonly port: Ref<number>; readonly path: string; readonly secret: Ref<string>; readonly body: Schema<B> }): Feed<B>;
    server(spec: { readonly port: Ref<number>; readonly token: Ref<string> }): Transport;
  };
}

declare module 'harness-dsl/zendesk' {
  import type { Feed, Timer } from 'harness-dsl';
  import type { Store, Ref } from 'harness-dsl/kernel';
  export interface ZendeskTicket {
    readonly id: string;
    readonly subject: string;
    readonly latestComment: string;
    readonly requesterEmail: string;
    readonly createdAt: Date;
    readonly priority: 'low' | 'normal' | 'high' | 'urgent';
  }
  export interface ZendeskEvent {
    readonly type: 'ticket.created' | 'comment.added';
    readonly ticket: ZendeskTicket;
    readonly authorIsCustomer: boolean;
  }
  export const zendesk: {
    webhook(spec: { readonly port: Ref<number>; readonly path: string; readonly secret: Ref<string> }): Feed<ZendeskEvent>;
    tickets(spec: { readonly subdomain: string; readonly token: Ref<string>; readonly every: Timer<unknown> }): Feed<ZendeskTicket>;
    store(spec: { readonly subdomain: string; readonly token: Ref<string> }): Store;
  };
}

declare module 'harness-dsl/wordpress' {
  import type { Feed, Timer } from 'harness-dsl';
  import type { Store, Ref } from 'harness-dsl/kernel';
  export interface WordpressPost {
    readonly id: string;
    readonly title: string;
    readonly content: string;
    readonly section: string;
    readonly author: string;
  }
  export const wordpress: {
    posts(spec: { readonly url: string; readonly token: Ref<string>; readonly status: 'pending' | 'draft'; readonly every: Timer<unknown> }): Feed<WordpressPost>;
    store(spec: { readonly url: string; readonly token: Ref<string> }): Store;
  };
}

declare module 'harness-dsl/markdown' {
  import type { Observer } from 'harness-dsl/kernel';
  export const markdown: {
    board(path: string): Observer;
    telemetry(path: string): Observer;
  };
}

declare module 'harness-dsl/slack' {
  import type { Named } from 'harness-dsl';
  import type { Observer, Ref } from 'harness-dsl/kernel';
  export const slack: {
    notifier(spec: { readonly webhookUrl: Ref<string>; readonly kinds?: readonly Named[] }): Observer;
  };
}
