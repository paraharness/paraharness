declare module 'harness-dsl' {
  import { z } from 'zod';
  import type {
    Outcome,
    Terminal,
    Ref,
    Supply,
    NewUnit,
    UnitPatch,
    Supplier,
    Store,
    MemoryStore,
    MemoryItem,
    MemoryDraft,
    Scope,
    Rate,
    Mean,
    Ledger,
    Runner,
    Account,
    Model,
    Workspace,
    Guard,
    Client,
    ControlApi,
    QuotaView,
    Intent,
    Exec,
    OperationRef,
    Metric,
    Policy,
  } from 'harness-dsl/kernel';

  export type {
    Outcome,
    Terminal,
    Ref,
    Supply,
    NewUnit,
    UnitPatch,
    Supplier,
    Store,
    MemoryStore,
    MemoryItem,
    MemoryDraft,
    Scope,
    Rate,
    Mean,
    Ledger,
    Runner,
    Account,
    Model,
    Workspace,
    Guard,
    Client,
    ControlApi,
    QuotaView,
    Intent,
    Exec,
    OperationRef,
    Metric,
    Policy,
  };

  export type Schema<T> = z.ZodType<T, unknown>;
  type Empty = Record<never, never>;
  type Named<N extends string, O> = { readonly [k in N]: O };
  type BuiltinMark = 'failed' | 'cancelled';

  export interface Kind<D, St extends string> {
    readonly name: string;
    readonly sort: 'kind';
    readonly schema: Schema<D>;
    readonly states: Readonly<Record<St, Outcome>>;
    readonly initial: St;
    extend<D2 = D>(name: string, patch?: { readonly data?: Schema<D2>; readonly tags?: (data: D2) => readonly string[] }): Kind<D2, St>;
  }

  export interface MemoryKind {
    readonly name: string;
    readonly sort: 'memory';
    readonly stance: 'experience' | 'taste';
  }

  export interface Role<N extends string> {
    readonly name: N;
    readonly sort: 'role';
    readonly instructions: string;
    readonly intents: readonly Intent[];
  }

  export interface Ask<O, S extends string> extends Exec<O, S> {
    readonly sort: 'ask' | 'batch';
    readonly seat: S;
  }

  export interface Command<O> extends Exec<O, never> {
    readonly sort: 'command';
  }

  export interface CommandOutput {
    readonly exitCode: number;
    readonly stdout: string;
  }

  export interface Operator {
    readonly name: 'operator';
    readonly sort: 'operator';
  }

  export interface Choice<T> extends Policy<PickContext<T>, T> {
    readonly candidates: readonly T[];
  }

  export type ModelChoice = Model | Choice<Model>;
  export type RunnerChoice = Runner | Choice<Runner>;
  export type AccountChoice = Account | Choice<Account>;

  export interface Candidate<T> {
    readonly value: T;
    readonly eligible: boolean;
    readonly quota?: QuotaView;
  }

  export interface UnitView<D> {
    readonly key: string;
    readonly kind: string;
    readonly state: string;
    readonly outcome: Outcome;
    readonly data: D;
    readonly tags: readonly string[];
    readonly createdAt: Date;
  }

  export interface Metrics {
    successRate(query: { readonly kind: Kind<unknown, string>; readonly sinceDays?: number; readonly seat?: string; readonly model?: Model }): Rate;
    outcomes<St extends string>(query: { readonly kind: Kind<unknown, St>; readonly sinceDays?: number }): {
      readonly samples: number;
      readonly byState: Readonly<Record<St, number>>;
      readonly byOutcome: Readonly<Record<Terminal, number>>;
    };
    rate(metric: Metric, query?: { readonly key?: string; readonly sinceDays?: number }): Rate;
    meanCostUsd(query: { readonly kind: Kind<unknown, string>; readonly outcome?: Terminal; readonly sinceDays?: number }): Mean;
    spentUsd(query: { readonly since: Date }): number;
  }

  export interface PickContext<T> {
    readonly candidates: readonly Candidate<T>[];
    readonly unit?: UnitView<unknown>;
    readonly seat?: string;
    readonly metrics: Metrics;
    readonly now: Date;
  }

  export interface Pending {
    readonly key: string;
    readonly kind: string;
    readonly lane: string;
    readonly state: string;
    readonly tags: readonly string[];
    readonly waitingSeconds: number;
    readonly deadline?: Date;
    readonly data: unknown;
    is<D>(kind: Kind<D, string>): this is Pending & { readonly data: D };
  }

  export interface Active {
    readonly attempt: string;
    readonly key: string;
    readonly kind: string;
    readonly lane: string;
    readonly blocked: boolean;
    readonly runningSeconds: number;
    readonly costUsd: number;
    is<D>(kind: Kind<D, string>): this is Active & { readonly data: D };
  }

  export interface ScheduleContext {
    readonly pending: readonly Pending[];
    readonly active: readonly Active[];
    readonly metrics: Metrics;
    readonly now: Date;
  }

  export interface Plan {
    readonly order: readonly Pending[];
    readonly preempt?: readonly Active[];
  }

  export interface RecallContext {
    readonly scope: { readonly kind: string; readonly role: string; readonly tags: readonly string[]; readonly resources: readonly string[]; readonly skills: readonly string[] };
    readonly query: string;
    readonly limit: number;
    items(): Promise<readonly MemoryItem[]>;
    similar(text: string, k: number): Promise<readonly { readonly item: MemoryItem; readonly score: number }[]>;
    specificity(item: MemoryItem): number;
    trackRecord(item: MemoryItem): Rate;
  }

  export interface Ctx<D, A, Out> {
    readonly unit: UnitView<D>;
    readonly args: A;
    readonly out: Out;
    readonly round: number;
    readonly metrics: Metrics;
    readonly now: Date;
  }

  export interface Retry {
    readonly maxRetries: number;
    readonly backoff: 'exponential' | 'fixed';
    readonly baseSeconds: number;
  }

  export interface StepOptions {
    readonly on?: RunnerChoice;
    readonly retry?: Retry;
  }

  export interface EndOptions<D, A, Out> {
    readonly resumeAt?: (ctx: Ctx<D, A, Out>) => Date;
    readonly resumeOnUpdate?: boolean;
    readonly note?: (ctx: Ctx<D, A, Out>) => string;
  }

  export interface ChildResult {
    readonly key: string;
    readonly state: string;
    readonly outcome: Terminal;
  }

  export interface LaneRef<D> {
    readonly name: string;
    readonly sort: 'lane';
    readonly accepts: (data: D) => boolean;
  }

  export interface Handler<D, A, S extends string, M extends string> {
    readonly name: string;
    readonly accepts: (data: D) => boolean;
    readonly takes: (args: A) => boolean;
    readonly seats: readonly S[];
    readonly marks: readonly M[];
  }

  export interface Flow<D, A, Out, Seats extends string, Marks extends string> extends Handler<D, A, Seats, Marks> {
    step<N extends string, O, S extends string>(
      name: N,
      exec: Exec<O, S> | ((ctx: Ctx<D, A, Out>) => Exec<O, S>),
      options?: StepOptions,
    ): Flow<D, A, Out & Named<N, O>, Seats | S, Marks>;
    halt<N extends string, O>(
      name: N,
      options: {
        readonly question: (ctx: Ctx<D, A, Out>) => string;
        readonly decision: Schema<O>;
        readonly unless?: (ctx: Ctx<D, A, Out>) => boolean;
      },
    ): Flow<D, A, Out & Named<N, O | undefined>, Seats, Marks>;
    loop<N extends string, O2, S extends string, M extends string>(
      name: N,
      rounds: number | ((args: A) => number),
      body: (flow: Flow<D, A, Out, never, never>) => Flow<D, A, O2, S, M>,
      until: (ctx: Ctx<D, A, O2>) => boolean,
    ): Flow<D, A, Out & Named<N, { readonly rounds: number; readonly satisfied: boolean; readonly last: O2 }>, Seats | S, Marks | M>;
    spawn<N extends string, CD>(
      name: N,
      lane: LaneRef<CD>,
      children: (ctx: Ctx<D, A, Out>) => readonly NewUnit<CD>[],
    ): Flow<D, A, Out & Named<N, readonly ChildResult[]>, Seats, Marks>;
    mark<M extends string>(mark: M): Flow<D, A, Out, Seats, Marks | M>;
    end<M extends string>(
      mark: M | ((ctx: Ctx<D, A, Out>) => M | undefined),
      options?: EndOptions<D, A, Out>,
    ): Flow<D, A, Out, Seats, Marks | M>;
  }

  export interface Lane<D, St extends string, Seats extends string, Marks extends string> extends LaneRef<D> {
    readonly kind: Kind<D, St>;
    from(...suppliers: readonly (Supplier<D> | Operator)[]): Lane<D, St, Seats, Marks>;
    store(store: Store<D>): Lane<D, St, Seats, Marks>;
    handle<A, S extends string, M extends string>(
      flow: Handler<D, A, S, M>,
      ...args: undefined extends A ? [args?: A] : [args: A]
    ): Lane<D, St, S, M>;
    cast(models: { readonly [k in Seats]: ModelChoice }): Lane<D, St, Seats, Marks>;
    states(map: { readonly [k in Marks | BuiltinMark]: St }): Lane<D, St, Seats, Marks>;
    runOn(runner: RunnerChoice): Lane<D, St, Seats, Marks>;
    wip(maxActive: number): Lane<D, St, Seats, Marks>;
    maxUsd(usd: number, options?: { readonly onExceed: 'halt' | 'fail' }): Lane<D, St, Seats, Marks>;
    deadline(at: (unit: UnitView<D>) => Date): Lane<D, St, Seats, Marks>;
  }

  export interface Journal {
    readonly name: string;
    readonly sort: 'journal';
    readonly kind: MemoryKind;
    recall(policy: Policy<RecallContext, Promise<readonly MemoryItem[]>>): Journal;
    recalledBy(...roles: readonly Role<string>[]): Journal;
    recordedBy(...writers: readonly (Role<string> | Command<unknown> | Operator)[]): Journal;
  }

  export interface Transition<D, St extends string> {
    readonly unit: UnitView<D>;
    readonly from: St | undefined;
    readonly to: St;
    readonly outcome: Outcome;
    readonly at: Date;
    readonly note?: string;
    readonly attempt?: { readonly id: string; readonly durationSeconds: number; readonly costUsd: number };
  }

  export interface Overdue<D> {
    readonly unit: UnitView<D>;
    readonly dueAt: Date;
    readonly at: Date;
  }

  export interface Updated<D> {
    readonly unit: UnitView<D>;
    readonly previous: D;
    readonly at: Date;
  }

  export interface Source<E, St extends string> {
    readonly sort: 'source';
    readonly describe: string;
    readonly accepts: (event: E, state: St) => boolean;
    where(predicate: (event: E) => boolean): Source<E, St>;
  }

  export interface Effect {
    readonly sort: 'effect';
    readonly describe: string;
  }

  export interface Then<E, St extends string> {
    create<D>(lane: LaneRef<D>, unit: (event: E) => NewUnit<D>): Effect;
    cancel(to: St): Effect;
    record(journal: Journal, item: (event: E) => MemoryDraft): Effect;
    run<O>(exec: Exec<O, never> | ((event: E) => Exec<O, never>), options?: { readonly on?: RunnerChoice }): Effect;
  }

  export interface Trigger {
    readonly name: string;
    readonly sort: 'trigger';
  }

  export interface Tick<D> {
    readonly now: Date;
    units(query?: { readonly states?: readonly string[]; readonly tags?: readonly string[] }): Promise<readonly UnitView<D>[]>;
  }

  export interface Running {
    readonly api: ControlApi;
    stop(): Promise<void>;
  }

  export interface Harness {
    readonly name: string;
    ledger(ledger: Ledger): Harness;
    lanes(...lanes: readonly LaneRef<never>[]): Harness;
    journals(...journals: readonly Journal[]): Harness;
    triggers(...triggers: readonly Trigger[]): Harness;
    metrics(...metrics: readonly Metric[]): Harness;
    scheduler(policy: Policy<ScheduleContext, Plan>): Harness;
    share(account: Account, fraction: number): Harness;
    operations(...operations: readonly OperationRef[]): Harness;
    clients(...clients: readonly Client[]): Harness;
    start(): Promise<Running>;
  }

  export interface MetricEventView {
    readonly on: 'step' | 'halt' | 'transition' | 'operation';
    readonly kind: string;
    readonly unit: { readonly key: string; readonly state: string; readonly data: unknown; readonly tags: readonly string[] };
    readonly step?: string;
    readonly ok?: boolean;
    readonly output?: unknown;
    readonly decision?: unknown;
    readonly out: Readonly<Record<string, unknown>>;
    readonly cast: Readonly<Record<string, string>>;
    readonly from?: string;
    readonly to?: string;
    readonly operation?: string;
    readonly input?: unknown;
  }

  export interface HApi {
    kind<D, St extends string>(
      name: string,
      definition: {
        readonly data: Schema<D>;
        readonly states: Record<St, Outcome>;
        readonly initial: NoInfer<St>;
        readonly tags?: (data: D) => readonly string[];
      },
    ): Kind<D, St>;
    memory(name: string, definition: { readonly stance: 'experience' | 'taste' }): MemoryKind;
    role<N extends string>(name: N, definition: { readonly instructions: string; readonly intents?: readonly Intent[] }): Role<N>;

    ask<N extends string, O, S extends string = N>(
      role: Role<N>,
      options: {
        readonly seat?: S;
        readonly prompt: string;
        readonly output: Schema<O>;
        readonly budgetTokens?: number;
        readonly workspace?: Workspace;
        readonly guards?: readonly Guard[];
        readonly beforeStop?: Command<unknown>;
        readonly resources?: readonly string[];
      },
    ): Ask<O, S>;
    batch<N extends string, O, S extends string = N>(
      role: Role<N>,
      options: { readonly seat?: S; readonly prompts: readonly string[]; readonly output: Schema<O> },
    ): Ask<readonly O[], S>;
    command<O = CommandOutput>(
      name: string,
      options: {
        readonly argv: readonly (string | Ref<string>)[];
        readonly output?: Schema<O>;
        readonly timeoutSeconds?: number;
        readonly env?: Readonly<Record<string, string | Ref<string>>>;
      },
    ): Command<O>;

    flow<K extends readonly Kind<unknown, string>[], A = undefined>(
      name: string,
      definition: { readonly kinds: K; readonly args?: Schema<A> },
    ): Flow<K[number] extends Kind<infer D, string> ? D : never, A, Empty, never, never>;
    lane<D, St extends string>(kind: Kind<D, St>): Lane<D, St, never, never>;
    every<D>(
      kind: Kind<D, string>,
      when: { readonly minutes?: number; readonly cron?: string; readonly tz?: string },
      emit: (tick: Tick<D>) => readonly Supply<D>[] | Promise<readonly Supply<D>[]>,
    ): Supplier<D>;
    journal(name: string, kind: MemoryKind, store: MemoryStore): Journal;

    trigger<E, St extends string>(
      name: string,
      source: Source<E, St>,
      effect: (then: Then<E, St>) => Effect | readonly Effect[],
    ): Trigger;
    readonly when: {
      enters<D, St extends string, S extends St>(kind: Kind<D, St>, ...states: readonly S[]): Source<Transition<D, St>, St>;
      repeats<D, St extends string>(
        kind: Kind<D, St>,
        pattern: { readonly state: NoInfer<St>; readonly times: number; readonly sameKey?: (data: D) => string },
      ): Source<Transition<D, St>, St>;
      overdue<D, St extends string>(
        kind: Kind<D, St>,
        deadline: { readonly in: readonly NoInfer<St>[]; readonly at: (unit: UnitView<D>) => Date },
      ): Source<Overdue<D>, St>;
      updated<D, St extends string>(kind: Kind<D, St>, filter?: { readonly in?: readonly NoInfer<St>[] }): Source<Updated<D>, St>;
      transition(): Source<Transition<unknown, string>, string>;
    };

    readonly policy: {
      pick<T>(name: string, candidates: readonly T[], decide: (ctx: PickContext<T>) => T): Choice<T>;
      order(name: string, decide: (ctx: ScheduleContext) => Plan): Policy<ScheduleContext, Plan>;
      recall(name: string, decide: (ctx: RecallContext) => Promise<readonly MemoryItem[]>): Policy<RecallContext, Promise<readonly MemoryItem[]>>;
    };
    metric<P>(
      name: string,
      definition: {
        readonly on: MetricEventView['on'];
        readonly select: Schema<P>;
        readonly success: (event: P) => boolean;
        readonly key?: (event: P) => string;
      },
    ): Metric;

    operation<I>(
      name: string,
      definition: { readonly input: Schema<I>; readonly run: (input: I) => Exec<unknown, never>; readonly on?: RunnerChoice },
    ): OperationRef;
    readonly op: {
      readonly readWork: OperationRef;
      readonly writeWork: OperationRef;
      readonly createWork: OperationRef;
      readonly cancelWork: OperationRef;
      readonly resolveBlocker: OperationRef;
      readonly writeMemory: OperationRef;
      readonly curateMemory: OperationRef;
      readonly readMemory: OperationRef;
      readonly readTelemetry: OperationRef;
      readonly setShares: OperationRef;
    };

    readonly operator: Operator;
    harness(name: string): Harness;
    env(name: string): Ref<string>;
    readonly slot: { port(fallback: number): Ref<number> };
  }

  export const H: HApi;
}

declare module 'harness-dsl/claude-code' {
  import type { Account, Model, Client, OperationRef, Ref, QuotaPrice } from 'harness-dsl/kernel';
  import type { AccountChoice } from 'harness-dsl';
  export const claudeCode: {
    subscription(options: { readonly name: string; readonly token: Ref<string>; readonly renewsAt?: Date }): Account;
    model(options: { readonly name: string; readonly id: string; readonly accounts: AccountChoice; readonly price: QuotaPrice }): Model;
    supervisor(options: { readonly name: string; readonly grants: readonly OperationRef[]; readonly endpoint?: Ref<number> }): Client;
  };
}

declare module 'harness-dsl/anthropic' {
  import type { Account, Model, Ref, QuotaPrice } from 'harness-dsl/kernel';
  export const anthropic: {
    account(options: { readonly name: string; readonly key: Ref<string> }): Account;
    model(options: { readonly name: string; readonly id: string; readonly account: Account; readonly price: QuotaPrice; readonly batchFactor?: number }): Model;
  };
}

declare module 'harness-dsl/sqlite' {
  import type { Ledger, Store } from 'harness-dsl/kernel';
  import type { Kind } from 'harness-dsl';
  export const sqlite: {
    ledger(options: { readonly path: string; readonly quotaPath?: string }): Ledger;
    store<D>(kind: Kind<D, string>, options: { readonly path: string }): Store<D>;
  };
}

declare module 'harness-dsl/jsonl' {
  import type { MemoryStore } from 'harness-dsl/kernel';
  export const jsonl: {
    memory(options: { readonly path: string }): MemoryStore;
  };
}

declare module 'harness-dsl/lancedb' {
  import type { MemoryStore, Ref } from 'harness-dsl/kernel';
  export const lancedb: {
    memory(options: {
      readonly uri: string;
      readonly table: string;
      readonly embedding: { readonly provider: 'openai' | 'sentence-transformers'; readonly model: string; readonly apiKey?: Ref<string> };
    }): MemoryStore;
  };
}

declare module 'harness-dsl/linear' {
  import type { Supplier, Store, Ref } from 'harness-dsl/kernel';
  import type { Kind } from 'harness-dsl';
  export interface LinearIssue {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly description: string;
    readonly labels: readonly string[];
    readonly status: string;
    readonly parentId?: string;
  }
  export const linear: {
    issues<D, St extends string>(
      kind: Kind<D, St>,
      options: {
        readonly team: string;
        readonly apiKey: Ref<string>;
        readonly label?: string;
        readonly statuses: { readonly [k in St]: string };
        readonly map: (issue: LinearIssue) => D;
      },
    ): Supplier<D> & Store<D>;
  };
}

declare module 'harness-dsl/folder' {
  import type { Supplier, Store } from 'harness-dsl/kernel';
  import type { Kind } from 'harness-dsl';
  export const folder: {
    markdown<D>(kind: Kind<D, string>, options: { readonly path: string; readonly stateField?: string }): Supplier<D> & Store<D>;
  };
}

declare module 'harness-dsl/git' {
  import type { Workspace, Guard } from 'harness-dsl/kernel';
  export const git: {
    worktree(options: { readonly repo: string; readonly base?: string }): Workspace;
    fileLease(): Guard;
  };
}

declare module 'harness-dsl/shell' {
  import type { Runner, Ref } from 'harness-dsl/kernel';
  import type { Command } from 'harness-dsl';
  export const shell: {
    local(options?: { readonly name?: string; readonly slots?: number }): Runner;
    ssh(options: {
      readonly name: string;
      readonly host: string;
      readonly user: string;
      readonly key: Ref<string>;
      readonly slots?: number;
      readonly preflight?: Command<unknown>;
    }): Runner;
  };
}

declare module 'harness-dsl/markdown' {
  import type { Exec } from 'harness-dsl/kernel';
  export const markdown: {
    board(options: { readonly path: string }): Exec<void, never>;
    telemetry(options: { readonly path: string; readonly sinceDays?: number }): Exec<void, never>;
  };
}

declare module 'harness-dsl/http' {
  import type { Supplier, Supply, Client, OperationRef, Ref } from 'harness-dsl/kernel';
  import type { Kind } from 'harness-dsl';
  export const http: {
    webhook<D>(kind: Kind<D, string>, options: { readonly path: string; readonly port: Ref<number>; readonly secret?: Ref<string>; readonly parse: (body: unknown) => readonly Supply<D>[] }): Supplier<D>;
    poll<D>(kind: Kind<D, string>, options: { readonly url: string; readonly everyMinutes: number; readonly token?: Ref<string>; readonly parse: (body: unknown) => readonly Supply<D>[] }): Supplier<D>;
    control(options: { readonly name: string; readonly port: Ref<number>; readonly token: Ref<string>; readonly grants: readonly OperationRef[] }): Client;
  };
}

declare module 'harness-dsl/zendesk' {
  import type { Supplier, Store, Ref, Exec } from 'harness-dsl/kernel';
  import type { Kind } from 'harness-dsl';
  export interface ZendeskTicket {
    readonly id: string;
    readonly subject: string;
    readonly requester: string;
    readonly latestMessage: string;
    readonly createdAt: string;
    readonly status: string;
  }
  export const zendesk: {
    tickets<D, St extends string>(
      kind: Kind<D, St>,
      options: { readonly subdomain: string; readonly token: Ref<string>; readonly pollMinutes: number; readonly statuses: { readonly [k in St]: string }; readonly map: (ticket: ZendeskTicket) => D },
    ): Supplier<D> & Store<D>;
    webhook<D>(kind: Kind<D, string>, options: { readonly path: string; readonly port: Ref<number>; readonly secret: Ref<string>; readonly map: (ticket: ZendeskTicket) => D }): Supplier<D>;
    reply(options: { readonly subdomain: string; readonly token: Ref<string>; readonly ticketId: string; readonly body: string }): Exec<void, never>;
  };
}

declare module 'harness-dsl/wordpress' {
  import type { Supplier, Store, Ref } from 'harness-dsl/kernel';
  import type { Kind } from 'harness-dsl';
  export interface WordpressPost {
    readonly id: string;
    readonly title: string;
    readonly content: string;
    readonly categories: readonly string[];
    readonly status: string;
  }
  export const wordpress: {
    drafts<D, St extends string>(
      kind: Kind<D, St>,
      options: { readonly url: string; readonly token: Ref<string>; readonly pollMinutes: number; readonly statuses: { readonly [k in St]: string }; readonly map: (post: WordpressPost) => D },
    ): Supplier<D> & Store<D>;
  };
}

declare module 'harness-dsl/slack' {
  import type { Exec, Ref } from 'harness-dsl/kernel';
  export const slack: {
    message(options: { readonly webhook: Ref<string>; readonly text: string }): Exec<void, never>;
  };
}
