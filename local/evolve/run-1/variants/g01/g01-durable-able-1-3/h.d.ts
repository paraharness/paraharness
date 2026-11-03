declare module 'harness-dsl' {
  import { z } from 'zod';
  import type * as K from 'harness-dsl/kernel';

  type Shape = z.ZodRawShape;
  type Obj<S extends Shape> = z.infer<z.ZodObject<S>>;
  type ScalarShape = { [key: string]: z.ZodType<K.Scalar> };
  type NumberKeys<A> = { [P in keyof A]-?: A[P] extends number ? P : never }[keyof A] & string;

  export type Position = K.Position;
  export type Verdict = K.Verdict;
  export type AttemptOutcome = K.AttemptOutcome;
  export type Scalar = K.Scalar;
  export type Create<A, F> = K.Create<A, F>;
  export type Update<A, F> = K.Update<A, F>;
  export type Supply<A, F, Sig> = K.Supply<A, F, Sig>;
  export type EnvRef = K.EnvRef;
  export type PortRef = K.PortRef;
  export type Secret = K.Secret;
  export type Account = K.Account;
  export type Model = K.Model;
  export type Quota = K.Quota;
  export type Runner = K.Runner;
  export type Store = K.Store;
  export type MemoryStore = K.MemoryStore;
  export type Ledger = K.Ledger;
  export type Supplier<Out> = K.Supplier<Out>;
  export type Projection = K.Projection;
  export type Client = K.Client;
  export type Executable<I, O> = K.Executable<I, O>;
  export type Timing = K.Timing;
  export type Recurrence = K.Recurrence;
  export type Delay = K.Delay;
  export type Duration = K.Duration;
  export type Rate = K.Rate;

  export interface State<N extends string = string, P extends K.Position = K.Position, V extends K.Verdict | null = K.Verdict | null>
    extends K.Named {
    readonly entity: 'state';
    readonly name: N;
    readonly position: P;
    readonly verdict: V;
  }

  type ActiveOf<St> = Extract<St, { readonly position: 'active' }>;
  type RestingOf<St> = Exclude<St, { readonly position: 'active' }>;

  export interface TimerSource<A> {
    attribute<Q extends NumberKeys<A>>(key: Q): K.AttributeTime;
  }

  export interface WorkKind<A = {}, F = {}, St extends State = never, Sig = {}, Tm extends string = never> extends K.Named {
    readonly entity: 'work';
    readonly types?: { attributes: A; fields: F; state: St; signals: Sig; timers: Tm };
    attributes<S extends ScalarShape>(shape: S): WorkKind<Obj<S>, F, St, Sig, Tm>;
    fields<S extends Shape>(shape: S): WorkKind<A, Obj<S>, St, Sig, Tm>;
    states<T extends State>(states: readonly T[]): WorkKind<A, F, T, Sig, Tm>;
    signals<S extends { [name: string]: Shape }>(signals: S): WorkKind<A, F, St, { [N in keyof S]: Obj<S[N]> }, Tm>;
    timers<T extends { [name: string]: K.Timing }>(make: (t: TimerSource<A>) => T): WorkKind<A, F, St, Sig, Tm | (keyof T & string)>;
    key(make: (unit: { attributes: A; fields: F }) => string): WorkKind<A, F, St, Sig, Tm>;
  }

  export type SupplyOf<W> = W extends WorkKind<infer A, infer F, infer _St, infer Sig, infer _Tm> ? K.Supply<A, F, Sig> : never;

  export type Intent = K.Intent;

  export interface Role<I = { task: string }, O = { text: string }> extends K.RoleSpec {
    readonly entity: 'role';
    readonly types?: { input: I; output: O };
    intents(intents: readonly K.Intent[]): Role<I, O>;
    instructions(text: string): Role<I, O>;
    input<S extends Shape>(shape: S): Role<Obj<S>, O>;
    output<S extends Shape>(shape: S): Role<I, Obj<S>>;
  }

  export interface Resource extends K.Named {
    readonly entity: 'resource';
    readonly globs: readonly string[];
    paths(globs: readonly string[]): Resource;
  }

  export interface MemoryKind extends K.MemoryKindSpec {
    readonly entity: 'memory';
    curated(): MemoryKind;
  }

  export interface Journal extends K.JournalSpec {
    readonly entity: 'journal';
    store(store: K.MemoryStore): Journal;
    recall(policy: K.RecallPolicy): Journal;
  }

  export interface Command<D = null> extends K.Executable<K.CommandInput, K.CommandResult<D>>, K.CommandSpec {
    readonly executable: 'command';
    parses<S extends Shape>(shape: S): Command<Obj<S>>;
  }

  export interface Pool extends K.Named {
    readonly entity: 'pool';
    accounts(entries: readonly { account: K.Account; share: number }[]): Pool;
    prefer(policy: K.AccountPolicy): Pool;
    fallback(account: K.Account): Pool;
  }

  export interface Agent<I, O> extends K.Executable<I, O> {
    readonly executable: 'agent';
    readonly role: Role<I, O>;
    model(model: K.Model | K.ChoicePolicy<K.Model>): Agent<I, O>;
    pool(pool: Pool | K.Account): Agent<I, O>;
    recalls(journals: readonly Journal[]): Agent<I, O>;
    records(journal: Journal): Agent<I, O>;
    leaseWrites(): Agent<I, O>;
    mustPass(check: K.CommandSpec): Agent<I, O>;
  }

  export interface Retry extends K.RetrySpec { readonly entity: 'retry' }

  export interface StepOptions<I, O> {
    readonly retry?: Retry;
    readonly timeoutMs?: number;
    readonly onFailure?: 'fail' | 'halt';
    readonly runner?: K.Runner;
    readonly onRestart?: K.RestartRule;
    readonly confirm?: K.Executable<I, O>;
  }

  export interface FlowContext<In, P, Out> {
    readonly input: In;
    readonly params: P;
    readonly out: Out;
    readonly unit: K.UnitView;
    readonly attempt: K.AttemptView;
  }
  export interface LoopRound<C> { readonly round: number; readonly carry: C | null }
  type Ctx<In, P, Out, X> = FlowContext<In, P, Out> & X;

  export interface Flow<In, P, Out, Sp, M extends string, E extends string> extends K.Named {
    readonly entity: 'flow';
    readonly types?: { input: In; params: P; out: Out; spawns: Sp; marks: M; ends: E };
  }

  export interface FlowDraft<In, P, Out, Sp, M extends string, E extends string, X> extends K.Named {
    readonly entity: 'flow-draft';
    requires<S extends Shape>(shape: S): FlowDraft<Obj<S>, P, Out, Sp, M, E, X>;
    params<S extends Shape>(shape: S): FlowDraft<In, Obj<S>, Out, Sp, M, E, X>;
    step<Q extends string, I, O>(
      key: Q,
      executable: K.Executable<I, O>,
      input: (c: Ctx<In, P, Out, X>) => I,
      options?: StepOptions<NoInfer<I>, NoInfer<O>>,
    ): FlowDraft<In, P, Out & { [R in Q]: O }, Sp, M, E, X>;
    batch<Q extends string, I, O>(
      key: Q,
      agent: Agent<I, O>,
      items: (c: Ctx<In, P, Out, X>) => readonly I[],
      options?: StepOptions<NoInfer<I>, NoInfer<O>>,
    ): FlowDraft<In, P, Out & { [R in Q]: readonly O[] }, Sp, M, E, X>;
    halt<Q extends string, D extends Shape>(
      key: Q,
      spec: {
        ask: (c: Ctx<In, P, Out, X>) => string;
        decision: D;
        skip?: { when: K.GatePolicy; decision: Obj<D> };
      },
    ): FlowDraft<In, P, Out & { [R in Q]: Obj<D> }, Sp, M, E, X>;
    spawn<Q extends string, O extends string, S extends Shape>(
      key: Q,
      spec: { outlet: O; child: S; items: (c: Ctx<In, P, Out, X>) => readonly Obj<S>[] },
    ): FlowDraft<In, P, Out & { [R in Q]: readonly K.ChildView[] }, Sp & { [R in O]: Obj<S> }, M, E, X>;
    wait<Q extends string>(key: Q, delay: K.Delay): FlowDraft<In, P, Out & { [R in Q]: { firedAt: number } }, Sp, M, E, X>;
    loop<Q extends string, C extends Shape, B>(
      key: Q,
      spec: { carry: C; rounds: (c: Ctx<In, P, Out, X>) => number },
      body: (round: FlowDraft<In, P, Out, Sp, M, E, X & LoopRound<Obj<C>>>) => FlowDraft<In, P, B, Sp, M, E, X & LoopRound<Obj<C>>>,
      again: (last: B, c: Ctx<In, P, Out, X>) => Obj<C> | null,
    ): FlowDraft<In, P, Out & { [R in Q]: { rounds: number; last: B; exhausted: boolean } }, Sp, M, E, X>;
    sets<S extends ScalarShape>(shape: S, make: (c: Ctx<In, P, Out, X>) => Obj<S>): FlowDraft<In & Obj<S>, P, Out, Sp, M, E, X>;
    mark<L extends string>(label: L): FlowDraft<In, P, Out, Sp, M | L, E, X>;
    exit<L extends string>(label: L, when: (c: Ctx<In, P, Out, X>) => boolean): FlowDraft<In, P, Out, Sp, M, E | L, X>;
    ends<L extends string>(labels: readonly L[], pick: (c: Ctx<In, P, Out, X>) => NoInfer<L>): Flow<In, P, Out, Sp, M, E | L | 'failed'>;
  }

  export interface SpawnTarget<C> {
    readonly entity: 'spawn-target';
    readonly lane: K.Named;
    readonly types?: { child: (child: C) => void };
  }

  type HandlerConfig<U, In, St extends State, P, Sp, M extends string, E extends string> =
    { states: { [Q in M]: ActiveOf<St> } & { [Q in E]: RestingOf<St> } } &
    ({} extends P ? { params?: P } : { params: P }) &
    ({} extends Sp ? { spawns?: {} } : { spawns: { [Q in keyof Sp]: SpawnTarget<Sp[Q]> } }) &
    ([U] extends [In] ? {} : { unitDoesNotSatisfyFlowInput: never });

  export interface Lane<A, F, St extends State, Sig, Tm extends string, Out> extends K.LaneLike<A> {
    readonly entity: 'lane';
    readonly types?: { attributes: A; fields: F; state: St; signals: Sig; timers: Tm; out: Out };
    supply(suppliers: readonly K.Supplier<K.Supply<A, F, Sig>>[]): Lane<A, F, St, Sig, Tm, Out>;
    store(store: K.Store): Lane<A, F, St, Sig, Tm, Out>;
    handler<In, P, O, Sp, M extends string, E extends string>(
      flow: Flow<In, P, O, Sp, M, E>,
      config: HandlerConfig<A & F, In, St, P, Sp, M, E>,
    ): Lane<A, F, St, Sig, Tm, O>;
    runner(runner: K.Runner): Lane<A, F, St, Sig, Tm, Out>;
    preflight(check: K.CommandSpec): Lane<A, F, St, Sig, Tm, Out>;
    wip(max: number): Lane<A, F, St, Sig, Tm, Out>;
    budget(budget: { maxUsdPerUnit: number; onExceed: 'halt' | 'fail' }): Lane<A, F, St, Sig, Tm, Out>;
  }

  export interface Source<E> {
    readonly entity: 'source';
    readonly types?: { event: E };
  }

  export interface Trigger<E> extends K.Named {
    readonly entity: 'trigger';
    where(test: (event: E) => boolean): Trigger<E>;
    creates<A, F, St extends State, Sig, Tm extends string, O>(
      lane: Lane<A, F, St, Sig, Tm, O>,
      make: (event: E) => K.Create<A, F>,
    ): Trigger<E>;
    moves<A, F, St extends State, Sig, Tm extends string, O>(
      lane: Lane<A, F, St, Sig, Tm, O>,
      spec: {
        key: (event: E) => string;
        to: NoInfer<St>;
        from?: readonly NoInfer<St>[];
        update?: (event: E) => K.Update<A, F>;
      },
    ): Trigger<E>;
    records(journal: Journal, make: (event: E) => readonly K.MemoryDraft[]): Trigger<E>;
    invokes<I, O>(executable: K.Executable<I, O>, make: (event: E) => I): Trigger<E>;
    pauses(lane: K.LaneLike<unknown>): Trigger<E>;
    resumes(lane: K.LaneLike<unknown>): Trigger<E>;
  }

  export interface Metric extends K.MetricSpec { readonly entity: 'metric' }

  export interface Operation extends K.OperationSpec { readonly entity: 'operation' }

  export interface OperationDraft<I> extends K.Named {
    input<S extends Shape>(shape: S): OperationDraft<Obj<S>>;
    invokes<EI, EO>(executable: K.Executable<EI, EO>, prepare: (input: I) => EI): Operation;
  }

  export interface Access extends K.AccessSpec {
    readonly entity: 'access';
    allows(operations: readonly Operation[]): Access;
  }

  export interface Harness extends K.Named {
    readonly entity: 'harness';
    ledger(ledger: K.Ledger): Harness;
    lanes(lanes: readonly K.LaneLike<unknown>[]): Harness;
    triggers(triggers: readonly K.Named[]): Harness;
    schedule(policy: K.SchedulePolicy): Harness;
    clients(clients: readonly K.Client[]): Harness;
    projections(projections: readonly K.Projection[]): Harness;
    start(): Promise<K.Running>;
    control(): Promise<K.ControlApi>;
  }

  export const H: {
    env(name: string): K.EnvRef;
    slot: { port(index: number): K.PortRef };

    state: {
      <N extends string, P extends 'pending' | 'active' | 'waiting'>(name: N, position: P): State<N, P, null>;
      <N extends string, V extends K.Verdict>(name: N, position: 'terminal', verdict: V): State<N, 'terminal', V>;
    };
    work(name: string): WorkKind;
    role(name: string): Role;
    resource(name: string): Resource;
    memory: { experience(name: string): MemoryKind; taste(name: string): MemoryKind };

    command(name: string, argv: readonly string[]): Command;
    agent<I, O>(name: string, role: Role<I, O>): Agent<I, O>;
    pool(name: string): Pool;
    journal(name: string, kind: MemoryKind): Journal;
    retry: {
      exponential(spec: { maxRetries: number; initialDelayMs: number; maxDelayMs?: number }): Retry;
      fixed(spec: { maxRetries: number; delayMs: number }): Retry;
    };

    time: {
      every(interval: K.Duration): K.Recurrence;
      daily(at: string, timeZone?: string): K.Recurrence;
      weekly(day: K.Weekday, at: string, timeZone?: string): K.Recurrence;
      monthly(dayOfMonth: number, at: string, timeZone?: string): K.Recurrence;
      after(delay: K.Duration): K.Delay;
    };

    flow(name: string): FlowDraft<{}, {}, {}, {}, never, never, {}>;
    lane<A, F, St extends State, Sig, Tm extends string>(name: string, kind: WorkKind<A, F, St, Sig, Tm>): Lane<A, F, St, Sig, Tm, {}>;
    child<A, F, St extends State, Sig, Tm extends string, O, C>(
      lane: Lane<A, F, St, Sig, Tm, O>,
      create: (child: C) => K.Create<A, F>,
    ): SpawnTarget<C>;

    supply: {
      operator(): K.Supplier<never>;
      schedule<A, F, St extends State, Sig, Tm extends string>(
        kind: WorkKind<A, F, St, Sig, Tm>,
        when: K.Recurrence,
        make: (c: K.ScheduleSupplyContext<A>) => readonly K.Supply<A, F, Sig>[],
      ): K.Supplier<K.Supply<A, F, Sig>>;
    };

    on: {
      transition<A, F, St extends State, Sig, Tm extends string, O>(
        lane: Lane<A, F, St, Sig, Tm, O>,
        filter?: { to?: readonly NoInfer<St>[]; verdict?: readonly K.Verdict[] },
      ): Source<K.TransitionEvent<A, O>>;
      streak<A, F, St extends State, Sig, Tm extends string, O>(
        lane: Lane<A, F, St, Sig, Tm, O>,
        spec: { verdict: K.Verdict; count: number; per: keyof A & string },
      ): Source<K.StreakEvent<A>>;
      step<A, F, St extends State, Sig, Tm extends string, O, Q extends keyof O & string>(
        lane: Lane<A, F, St, Sig, Tm, O>,
        key: Q,
      ): Source<K.StepEvent<A, O[Q]>>;
      signal<A, F, St extends State, Sig, Tm extends string, O, N extends (keyof Sig & string) | Tm>(
        lane: Lane<A, F, St, Sig, Tm, O>,
        name: N,
      ): Source<K.SignalEvent<A, N extends keyof Sig ? Sig[N] : K.TimerPayload>>;
      threshold(spec: {
        groups?: (c: K.PolicyContext) => readonly string[];
        read: (c: K.PolicyContext, group: string | null) => K.Rate;
        enters: (rate: K.Rate) => boolean;
        leaves: (rate: K.Rate) => boolean;
      }): Source<K.ThresholdEvent>;
    };
    trigger<E>(name: string, source: Source<E>): Trigger<E>;

    metric(name: string): {
      step<In, P, O, Sp, M extends string, E extends string, Q extends keyof O & string>(
        flow: Flow<In, P, O, Sp, M, E>,
        key: Q,
      ): { hit(test: (output: O[Q], event: K.StepEvent<K.Attributes, O[Q]>) => boolean): Metric };
      transition<A, F, St extends State, Sig, Tm extends string, O>(
        lane: Lane<A, F, St, Sig, Tm, O>,
      ): { hit(test: (event: K.TransitionEvent<A, O>) => boolean): Metric };
    };

    policy: {
      schedule(name: string, decide: (c: K.ScheduleContext) => K.ScheduleDecision): K.SchedulePolicy;
      model<M extends K.Model>(name: string, options: readonly M[], decide: (c: K.PolicyContext, options: readonly M[]) => M): K.ChoicePolicy<K.Model>;
      account(name: string, decide: (c: K.AccountContext) => K.AccountView | null): K.AccountPolicy;
      gate(name: string, decide: (c: K.PolicyContext) => boolean): K.GatePolicy;
      recall(name: string, decide: (c: K.RecallContext) => readonly K.RecallCandidate[]): K.RecallPolicy;
    };

    ops: {
      readonly readWork: Operation;
      readonly createWork: Operation;
      readonly updateWork: Operation;
      readonly signalWork: Operation;
      readonly resolveBlocks: Operation;
      readonly readMemory: Operation;
      readonly writeMemory: Operation;
      readonly curateMemory: Operation;
      readonly readTelemetry: Operation;
      readonly readAccounts: Operation;
      readonly setShares: Operation;
    };
    operation(name: string): OperationDraft<{}>;
    access(name: string): Access;

    harness(name: string): Harness;
  };
}

declare module 'harness-dsl/sqlite' {
  import type { Ledger, Store, State, WorkKind } from 'harness-dsl';
  export function ledger(path: string, options?: { quotaPath?: string; writerTtlMs?: number }): Ledger;
  export function store<A, F, St extends State, Sig, Tm extends string>(kind: WorkKind<A, F, St, Sig, Tm>, path: string): Store;
}

declare module 'harness-dsl/jsonl' {
  import type { MemoryStore } from 'harness-dsl';
  export function memory(path: string): MemoryStore;
}

declare module 'harness-dsl/lancedb' {
  import type { MemoryStore } from 'harness-dsl';
  export function memory(path: string, options: { embedding: string; table?: string }): MemoryStore;
}

declare module 'harness-dsl/claude-code' {
  import type { Account, Model, Client, Secret, PortRef, Access } from 'harness-dsl';
  export function subscription(name: string, options: { configDir: Secret }): Account;
  export function model(id: string): Model;
  export function supervisor(name: string, access: Access, options: { port: PortRef }): Client;
}

declare module 'harness-dsl/anthropic' {
  import type { Account, Model, Secret } from 'harness-dsl';
  export function account(name: string, options: { apiKey: Secret }): Account;
  export function model(id: string, options?: { batch?: boolean }): Model;
}

declare module 'harness-dsl/linear' {
  import type { Supplier, Store, Supply, Create, Secret, State, WorkKind } from 'harness-dsl';
  export interface LinearIssue {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly description: string;
    readonly labels: readonly string[];
    readonly priority: number;
    readonly url: string;
    readonly parentId: string | null;
  }
  export function issues<A, F, St extends State, Sig, Tm extends string>(
    kind: WorkKind<A, F, St, Sig, Tm>,
    options: { apiKey: Secret; team: string; labels?: readonly string[] },
    map: (issue: LinearIssue) => Create<A, F>,
  ): Supplier<Supply<A, F, Sig>>;
  export function store<A, F, St extends State, Sig, Tm extends string>(
    kind: WorkKind<A, F, St, Sig, Tm>,
    options: { apiKey: Secret; team: string; status: { [N in St['name']]?: string } },
  ): Store;
}

declare module 'harness-dsl/folder' {
  import type { Supplier, Store, Supply, Create, State, WorkKind } from 'harness-dsl';
  export interface FolderFile {
    readonly path: string;
    readonly frontmatter: Readonly<Record<string, unknown>>;
    readonly body: string;
  }
  export function files<A, F, St extends State, Sig, Tm extends string>(
    kind: WorkKind<A, F, St, Sig, Tm>,
    dir: string,
    map: (file: FolderFile) => Create<A, F>,
  ): Supplier<Supply<A, F, Sig>>;
  export function frontmatter<A, F, St extends State, Sig, Tm extends string>(
    kind: WorkKind<A, F, St, Sig, Tm>,
    dir: string,
  ): Store;
}

declare module 'harness-dsl/zendesk' {
  import type { Supplier, Store, Supply, Secret, PortRef, Recurrence, State, WorkKind, Executable } from 'harness-dsl';
  export interface ZendeskTicket {
    readonly id: number;
    readonly subject: string;
    readonly latestComment: string;
    readonly requesterEmail: string;
    readonly tags: readonly string[];
    readonly slaDueAt: number | null;
    readonly updatedAt: number;
  }
  export interface ZendeskEvent {
    readonly type: 'ticket.created' | 'comment.added' | 'ticket.solved';
    readonly fromCustomer: boolean;
    readonly ticket: ZendeskTicket;
  }
  export interface ZendeskConnection { readonly subdomain: string; readonly token: Secret }
  export function webhook<A, F, St extends State, Sig, Tm extends string>(
    kind: WorkKind<A, F, St, Sig, Tm>,
    options: ZendeskConnection & { port: PortRef; signingSecret: Secret },
    map: (event: ZendeskEvent) => NoInfer<Supply<A, F, Sig>> | null,
  ): Supplier<Supply<A, F, Sig>>;
  export function poll<A, F, St extends State, Sig, Tm extends string>(
    kind: WorkKind<A, F, St, Sig, Tm>,
    when: Recurrence,
    options: ZendeskConnection,
    map: (ticket: ZendeskTicket) => NoInfer<Supply<A, F, Sig>> | null,
  ): Supplier<Supply<A, F, Sig>>;
  export function store<A, F, St extends State, Sig, Tm extends string>(
    kind: WorkKind<A, F, St, Sig, Tm>,
    options: ZendeskConnection & { status: { [N in St['name']]?: string } },
  ): Store;
  export function reply(name: string, options: ZendeskConnection): Executable<{ ticketId: number; body: string }, { commentId: number }>;
}

declare module 'harness-dsl/wordpress' {
  import type { Supplier, Store, Supply, Create, Secret, Recurrence, State, WorkKind } from 'harness-dsl';
  export interface WordpressPost {
    readonly id: number;
    readonly title: string;
    readonly content: string;
    readonly section: string;
    readonly author: string;
    readonly status: string;
  }
  export interface WordpressConnection { readonly site: string; readonly token: Secret }
  export function poll<A, F, St extends State, Sig, Tm extends string>(
    kind: WorkKind<A, F, St, Sig, Tm>,
    when: Recurrence,
    options: WordpressConnection & { status: string },
    map: (post: WordpressPost) => Create<A, F>,
  ): Supplier<Supply<A, F, Sig>>;
  export function store<A, F, St extends State, Sig, Tm extends string>(
    kind: WorkKind<A, F, St, Sig, Tm>,
    options: WordpressConnection & { status: { [N in St['name']]?: string } },
  ): Store;
}

declare module 'harness-dsl/http' {
  import type { Client, Supplier, Supply, PortRef, Secret, Access, State, WorkKind } from 'harness-dsl';
  export function server(name: string, access: Access, options: { port: PortRef; token: Secret }): Client;
  export function webhook<A, F, St extends State, Sig, Tm extends string>(
    kind: WorkKind<A, F, St, Sig, Tm>,
    options: { path: string; port: PortRef; secret: Secret },
    parse: (body: unknown) => NoInfer<Supply<A, F, Sig>> | null,
  ): Supplier<Supply<A, F, Sig>>;
}

declare module 'harness-dsl/markdown' {
  import type { Projection } from 'harness-dsl';
  export function board(path: string): Projection;
  export function telemetry(path: string): Projection;
}

declare module 'harness-dsl/git' {
  import type { Runner } from 'harness-dsl';
  export function worktree(options: { repo: string; base: string; slots: number }): Runner;
}

declare module 'harness-dsl/local' {
  import type { Runner } from 'harness-dsl';
  export function shell(options: { slots: number; cwd?: string }): Runner;
}

declare module 'harness-dsl/ssh' {
  import type { Runner, Secret } from 'harness-dsl';
  export function hosts(options: {
    hosts: readonly { host: string; user: string; key: Secret }[];
    slotsPerHost: number;
  }): Runner;
}

declare module 'harness-dsl/slack' {
  import type { Executable, Secret } from 'harness-dsl';
  export function notify(name: string, options: { webhookUrl: Secret }): Executable<{ text: string }, { delivered: boolean }>;
}
