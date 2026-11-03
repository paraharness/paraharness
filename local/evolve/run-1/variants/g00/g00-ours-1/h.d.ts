declare module 'harness-dsl' {
  import { z } from 'zod';

  export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

  export interface EnvRef { readonly sort: 'env'; readonly variable: string }
  export interface PortRef { readonly sort: 'port'; readonly index: number }
  export type Setting = string | EnvRef | PortRef;
  export type Secret = string | EnvRef;
  export type NameOf = string | { readonly name: string };

  export type NoParams = Record<never, never>;
  export type NoSteps = Record<never, never>;
  export type NoInput = Record<never, never>;

  export type Outcome = 'pending' | 'active' | 'dormant' | 'succeeded' | 'failed' | 'ended' | 'cancelled';

  export interface State<N extends string = string> {
    readonly sort: 'state';
    readonly name: N;
    readonly outcome: Outcome;
  }

  export interface StateStart<N extends string> {
    pending(): State<N>;
    active(): State<N>;
    dormant(): State<N>;
    succeeded(): State<N>;
    failed(): State<N>;
    ended(): State<N>;
    cancelled(): State<N>;
  }

  export interface WorkKind<D, SN extends string> {
    readonly sort: 'work-kind';
    readonly name: string;
    readonly types: { readonly data: D; readonly states: SN };
    schema<D2>(schema: z.ZodType<D2>): WorkKind<D2, SN>;
    states<S extends readonly State[]>(...states: S): WorkKind<D, S[number]['name']>;
    key(identify: (data: D) => string): WorkKind<D, SN>;
    resources(select: (data: D) => readonly string[]): WorkKind<D, SN>;
  }

  export type StatesOf<K> = K extends { readonly types: { readonly states: infer S } } ? S : never;
  export type CommonStates<K extends readonly unknown[]> =
    K extends readonly [infer F, ...infer R] ? StatesOf<F> & CommonStates<R> : string;

  export interface UnitView<D, SN extends string> {
    readonly key: string;
    readonly kind: string;
    readonly lane: string;
    readonly state: SN;
    readonly outcome: Outcome;
    readonly data: D;
    readonly createdAt: Date;
    readonly updatedAt: Date;
    readonly parentKey: string | null;
  }

  export interface Actor {
    readonly sort: 'flow' | 'operator' | 'trigger' | 'scheduler' | 'supplier' | 'clock';
    readonly name: string;
  }

  export interface InvocationSummary {
    readonly step: string;
    readonly executable: string;
    readonly iteration: number;
    readonly model: string | null;
    readonly account: string | null;
    readonly batched: boolean;
    readonly succeeded: boolean;
    readonly costUsd: number;
  }

  export interface AttemptSummary {
    readonly id: string;
    readonly number: number;
    readonly startedAt: Date;
    readonly endedAt: Date | null;
    readonly durationMs: number;
    readonly costUsd: number;
    readonly invocations: readonly InvocationSummary[];
  }

  export interface TransitionEvent<D, SN extends string> {
    readonly unit: UnitView<D, SN>;
    readonly from: SN | null;
    readonly to: SN;
    readonly outcome: Outcome;
    readonly at: Date;
    readonly actor: Actor;
    readonly attempt: AttemptSummary | null;
  }

  export interface UpdateEvent<D, SN extends string> {
    readonly unit: UnitView<D, SN>;
    readonly previous: D;
    readonly at: Date;
    readonly activeAttempt: AttemptSummary | null;
  }

  export interface DeadlineEvent<D, SN extends string> {
    readonly unit: UnitView<D, SN>;
    readonly deadline: Date;
    readonly at: Date;
  }

  export interface StreakEvent<D, SN extends string> {
    readonly unit: UnitView<D, SN>;
    readonly group: string;
    readonly count: number;
    readonly units: readonly UnitView<D, SN>[];
  }

  export interface Source<E, SN extends string> {
    readonly sort: 'source';
    readonly description: string;
    readonly types: { readonly event: E; readonly states: SN };
  }

  export interface WindowQuery {
    readonly windowDays?: number;
    readonly since?: Date;
  }

  export interface OutcomeQuery extends WindowQuery {
    readonly kind?: NameOf;
    readonly lane?: NameOf;
    readonly model?: NameOf;
    readonly step?: string;
  }

  export interface OutcomeStats {
    readonly samples: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly ended: number;
    readonly cancelled: number;
    readonly successRate: number | null;
    readonly byState: Readonly<Record<string, number>>;
    readonly meanCostUsd: number | null;
    readonly meanCostUsdSucceeded: number | null;
  }

  export interface SpendQuery extends WindowQuery {
    readonly kind?: NameOf;
    readonly account?: NameOf;
    readonly model?: NameOf;
  }

  export interface SpendStats {
    readonly usd: number;
    readonly invocations: number;
  }

  export interface Metrics {
    outcomes(query: OutcomeQuery): OutcomeStats;
    transitions<D, SN extends string>(
      kind: WorkKind<D, SN>,
      query: WindowQuery & { readonly to?: readonly State<SN>[] },
    ): readonly TransitionEvent<D, SN>[];
    spend(query: SpendQuery): SpendStats;
  }

  export interface Policy<Ctx, Out> {
    readonly sort: 'policy';
    readonly name: string;
    decide(context: Ctx): Out;
  }

  export interface AccountDriver { readonly sort: 'account-driver'; readonly name: string }
  export interface QuotaStore { readonly sort: 'quota-store'; readonly name: string }
  export interface Pricing { readonly sort: 'pricing'; readonly name: string }
  export interface Ledger { readonly sort: 'ledger'; readonly name: string }
  export interface Store { readonly sort: 'store'; readonly name: string }
  export interface MemoryStore { readonly sort: 'memory-store'; readonly name: string }
  export interface Endpoint { readonly sort: 'endpoint'; readonly name: string }
  export interface Projection { readonly sort: 'projection'; readonly name: string }
  export interface AgentPlugin { readonly sort: 'agent-plugin'; readonly name: string }

  export interface Unparsed { readonly unparsed: true }

  export interface Supplier<D> {
    readonly sort: 'supplier';
    readonly name: string;
    readonly types: { readonly data: D };
  }

  export interface Account {
    readonly sort: 'account';
    readonly name: string;
    quota(store: QuotaStore): Account;
  }

  export interface Model {
    readonly sort: 'model';
    readonly name: string;
    readonly modelId: string;
    pricing(pricing: Pricing): Model;
  }

  export interface Executable<I, O> {
    readonly name: string;
    readonly signature: { readonly input: (input: I) => void; readonly output: O };
  }

  export interface ExecResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly durationMs: number;
  }

  export interface ExecOptions {
    readonly cwd?: string;
    readonly stdin?: string;
    readonly timeoutMs?: number;
    readonly allowFailure?: boolean;
  }

  export interface CommandContext<I> {
    readonly input: I;
    readonly unit: UnitView<unknown, string> | null;
    readonly attemptId: string | null;
    readonly runner: string;
    exec(program: string, args?: readonly string[], options?: ExecOptions): Promise<ExecResult>;
    record<C>(journal: Journal<C>, draft: MemoryDraft<NoInfer<C>>): Promise<string>;
    isCancelled(): boolean;
  }

  export interface Runner {
    readonly sort: 'runner';
    readonly name: string;
    slots(count: number): Runner;
    env(variables: Readonly<Record<string, Setting>>): Runner;
    preflight(check: Executable<NoInput, unknown>): Runner;
  }

  export interface Command<I, O> extends Executable<I, O> {
    readonly sort: 'command';
  }

  export interface CommandBuilder<I, O> {
    input<I2>(schema: z.ZodType<I2>): CommandBuilder<I2, O>;
    output<O2>(schema: z.ZodType<O2>): CommandBuilder<I, O2>;
    runner(runner: Runner | Pool<Runner>): CommandBuilder<I, O>;
    env(variables: Readonly<Record<string, Setting>>): CommandBuilder<I, O>;
    run(body: (context: CommandContext<I>) => Promise<O>): Command<I, O>;
  }

  export type Candidate = Account | Model | Runner;

  export interface QuotaView {
    readonly utilization: number;
    readonly maxShare: number;
    readonly windowResetsAt: Date | null;
    readonly coolingUntil: Date | null;
    readonly eligible: boolean;
  }

  export interface PickContext<C extends Candidate> {
    readonly candidates: readonly C[];
    readonly kind: string | null;
    readonly unit: UnitView<unknown, string> | null;
    readonly step: string | null;
    readonly metrics: Metrics;
    quota(account: Account): QuotaView;
    readonly now: Date;
  }

  export interface Pool<C extends Candidate> {
    readonly sort: 'pool';
    readonly name: string;
    readonly types: { readonly candidate: C };
    policy(policy: Policy<PickContext<C>, readonly C[]>): Pool<C>;
    fallback(candidate: C): Pool<C>;
    maxShare(this: Pool<Account>, account: Account, ratio: number): Pool<Account>;
  }

  export type Intent = 'read' | 'edit' | 'execute' | 'search' | 'fetch' | 'ask';

  export interface MemoryKind<C> {
    readonly sort: 'memory-kind';
    readonly name: string;
    readonly types: { readonly content: C };
    content<C2>(schema: z.ZodType<C2>): MemoryKind<C2>;
    taste(): MemoryKind<C>;
  }

  export interface When {
    readonly kinds?: readonly NameOf[];
    readonly roles?: readonly NameOf[];
    readonly skills?: readonly NameOf[];
    readonly resources?: readonly string[];
  }

  export interface MemoryItem<C> {
    readonly id: string;
    readonly kind: string;
    readonly createdAt: Date;
    readonly when: When;
    readonly content: C;
    readonly status: 'candidate' | 'active' | 'dropped';
    readonly mergedInto: string | null;
  }

  export interface MemoryDraft<C> {
    readonly content: C;
    readonly when?: When;
  }

  export interface RecallScope {
    readonly kind: string | null;
    readonly role: string;
    readonly skill: string;
    readonly resources: readonly string[];
    readonly text: string;
  }

  export interface RecallCandidate {
    readonly item: MemoryItem<unknown>;
    readonly specificity: number;
    readonly trackRecord: { readonly attempts: number; readonly succeeded: number };
    readonly similarity: number | null;
    readonly tokens: number;
  }

  export interface RecallContext {
    readonly candidates: readonly RecallCandidate[];
    readonly scope: RecallScope;
    readonly now: Date;
  }

  export interface JournalStart {
    of<C>(kind: MemoryKind<C>): Journal<C>;
  }

  export interface Journal<C> {
    readonly sort: 'journal';
    readonly name: string;
    readonly types: { readonly content: C };
    store(store: MemoryStore): Journal<C>;
    recall(policy: Policy<RecallContext, readonly RecallCandidate[]>): Journal<C>;
  }

  export interface Role {
    readonly sort: 'role';
    readonly name: string;
    prompt(text: string): Role;
    tools(...intents: readonly Intent[]): Role;
    recall(...kinds: readonly MemoryKind<unknown>[]): Role;
    record(...kinds: readonly MemoryKind<unknown>[]): Role;
  }

  export interface Skill<I, O> {
    readonly sort: 'skill';
    readonly name: string;
    readonly types: { readonly input: I; readonly output: O };
    input<I2>(schema: z.ZodType<I2>): Skill<I2, O>;
    output<O2>(schema: z.ZodType<O2>): Skill<I, O2>;
    prompt(render: (input: I) => string): Skill<I, O>;
    assert(check: (output: O, input: I) => true | string): Skill<I, O>;
    maxRetries(count: number): Skill<I, O>;
  }

  export interface Agent {
    readonly sort: 'agent';
    readonly name: string;
    role(role: Role): Agent;
    model(model: Model | Pool<Model>): Agent;
    use(...plugins: readonly AgentPlugin[]): Agent;
    perform<I, O>(skill: Skill<I, O>): Executable<I, O>;
  }

  export interface ChildSummary {
    readonly total: number;
    readonly pending: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly ended: number;
    readonly cancelled: number;
  }

  export interface Scope<In, P, S, SN extends string> {
    readonly unit: UnitView<In, SN>;
    readonly params: P;
    readonly steps: S;
    readonly attempt: { readonly id: string; readonly number: number; readonly costUsd: number };
    readonly children: ChildSummary | null;
    readonly metrics: Metrics;
    readonly now: Date;
  }

  export interface Retry {
    readonly maxRetries: number;
    readonly backoff: 'fixed' | 'exponential';
    readonly initialDelayMs: number;
  }

  export interface StepOptions {
    readonly retry?: Retry;
  }

  export interface BatchOptions {
    readonly concurrency?: number;
    readonly deferred?: boolean;
  }

  export interface Flow<In, P> {
    readonly sort: 'flow';
    readonly name: string;
    readonly accepts: (data: In, params: P) => void;
  }

  export type Produced<F> = F extends (builder: never) => { readonly produces: infer S2 } ? S2 : never;

  export interface FlowStart {
    of<K extends readonly WorkKind<unknown, string>[]>(
      ...kinds: K
    ): FlowBuilder<K[number]['types']['data'], NoParams, NoSteps, CommonStates<K> & string>;
  }

  export interface FlowBuilder<In, P, S, SN extends string> extends Flow<In, P> {
    readonly produces: S;
    params<P2>(schema: z.ZodType<P2>): FlowBuilder<In, P2, S, SN>;
    step<N extends string, I, O>(
      name: N,
      executable: Executable<I, O>,
      input: (scope: Scope<In, P, S, SN>) => NoInfer<I>,
      options?: StepOptions,
    ): FlowBuilder<In, P, S & { readonly [K in N]: O }, SN>;
    batch<N extends string, I, O>(
      name: N,
      executable: Executable<I, O>,
      items: (scope: Scope<In, P, S, SN>) => readonly NoInfer<I>[],
      options?: BatchOptions,
    ): FlowBuilder<In, P, S & { readonly [K in N]: readonly O[] }, SN>;
    halt<N extends string, T>(
      name: N,
      request: {
        readonly ask: (scope: Scope<In, P, S, SN>) => string;
        readonly decision: z.ZodType<T>;
      },
    ): FlowBuilder<In, P, S & { readonly [K in N]: T }, SN>;
    when<S2>(
      test: (scope: Scope<In, P, S, SN>) => boolean,
      body: (builder: FlowBuilder<In, P, S, SN>) => FlowBuilder<In, P, S2, SN>,
    ): FlowBuilder<In, P, S & Partial<Omit<S2, keyof S>>, SN>;
    loop<N extends string, S2, F = null>(
      name: N,
      spec: {
        readonly maxIterations: number | ((scope: Scope<In, P, S, SN>) => number);
        readonly body: (
          builder: FlowBuilder<In, P, S & { readonly [K in N]: F | null }, SN>,
        ) => FlowBuilder<In, P, S2, SN>;
        readonly carry?: {
          readonly schema: z.ZodType<F>;
          readonly from: (scope: Scope<In, P, S2, SN>) => NoInfer<F>;
        };
        readonly until: (scope: Scope<In, P, S2, SN>) => boolean;
      },
    ): FlowBuilder<In, P, S2, SN>;
    parallel<B extends Readonly<Record<string, (builder: FlowBuilder<In, P, S, SN>) => { readonly produces: object }>>>(
      name: string,
      branches: B,
    ): FlowBuilder<In, P, S & { readonly [K in keyof B]: Omit<Produced<B[K]>, keyof S> }, SN>;
    update(patch: (scope: Scope<In, P, S, SN>) => Partial<In>): FlowBuilder<In, P, S, SN>;
    transition(to: State<SN> | ((scope: Scope<In, P, S, SN>) => State<SN>)): FlowBuilder<In, P, S, SN>;
    spawn<D2>(
      name: string,
      lane: Lane<D2, string>,
      items: (scope: Scope<In, P, S, SN>) => readonly NoInfer<D2>[],
      park: { readonly wait: State<SN>; readonly resume: State<SN> },
    ): FlowBuilder<In, P, S, SN>;
  }

  export interface LaneStart {
    of<D, SN extends string>(kind: WorkKind<D, SN>): Lane<D, SN>;
  }

  export interface Lane<D, SN extends string> {
    readonly sort: 'lane';
    readonly name: string;
    readonly types: { readonly data: D; readonly states: SN };
    from(...suppliers: readonly (Supplier<D> | Supplier<Unparsed>)[]): Lane<D, SN>;
    store(store: Store): Lane<D, SN>;
    handle(flow: Flow<D, NoParams>): Lane<D, SN>;
    handle<P>(flow: Flow<D, P>, params: P): Lane<D, SN>;
    wip(maxActive: number): Lane<D, SN>;
    maxUsdPerUnit(usd: number): Lane<D, SN>;
    enters(...states: readonly State<SN>[]): Source<TransitionEvent<D, SN>, SN>;
    updated(): Source<UpdateEvent<D, SN>, SN>;
    deadline(
      at: (unit: UnitView<D, SN>) => Date | null,
      options?: { readonly during?: readonly State<SN>[] },
    ): Source<DeadlineEvent<D, SN>, SN>;
    streak(
      state: State<SN>,
      count: number,
      options: { readonly by: (unit: UnitView<D, SN>) => string },
    ): Source<StreakEvent<D, SN>, SN>;
  }

  export interface Trigger {
    readonly sort: 'trigger';
    readonly name: string;
  }

  export interface TriggerStart {
    on<E, SN extends string>(source: Source<E, SN>): TriggerOn<E, SN>;
  }

  export interface TriggerOn<E, SN extends string> {
    where(test: (event: E) => boolean): TriggerOn<E, SN>;
    create<D2>(lane: Lane<D2, string>, produce: (event: E) => NoInfer<D2> | readonly NoInfer<D2>[]): Trigger;
    move(to: State<SN>): Trigger;
    run<I>(executable: Executable<I, unknown>, input: (event: E) => NoInfer<I>): Trigger;
    record<C>(
      journal: Journal<C>,
      draft: (event: E) => MemoryDraft<NoInfer<C>> | null,
      options?: { readonly candidate?: boolean },
    ): Trigger;
  }

  export interface Queued<D, SN extends string> {
    readonly lane: string;
    readonly unit: UnitView<D, SN>;
    readonly queuedAt: Date;
    readonly waitedMs: number;
  }

  export interface Running<D, SN extends string> {
    readonly lane: string;
    readonly unit: UnitView<D, SN>;
    readonly attempt: AttemptSummary;
    readonly blocked: boolean;
  }

  export interface ScheduleContext {
    readonly pending: readonly Queued<unknown, string>[];
    readonly running: readonly Running<unknown, string>[];
    of<D, SN extends string>(lane: Lane<D, SN>): {
      readonly pending: readonly Queued<D, SN>[];
      readonly running: readonly Running<D, SN>[];
    };
    readonly metrics: Metrics;
    readonly now: Date;
  }

  export interface ScheduleDecision {
    readonly start: readonly Queued<unknown, string>[];
    readonly preempt?: readonly Running<unknown, string>[];
  }

  export interface Scheduler {
    readonly sort: 'scheduler';
    readonly name: string;
    concurrency(maxActive: number): Scheduler;
    policy(policy: Policy<ScheduleContext, ScheduleDecision>): Scheduler;
  }

  export interface Operation {
    readonly sort: 'operation';
    readonly name: string;
  }

  export interface Supervisor {
    readonly sort: 'supervisor';
    readonly name: string;
    endpoint(...endpoints: readonly Endpoint[]): Supervisor;
    grant(...operations: readonly Operation[]): Supervisor;
  }

  export interface HarnessRun {
    readonly runId: string;
    stop(): Promise<void>;
  }

  export interface Harness {
    readonly sort: 'harness';
    readonly name: string;
    ledger(ledger: Ledger): Harness;
    lanes(...lanes: readonly Lane<unknown, string>[]): Harness;
    journals(...journals: readonly Journal<unknown>[]): Harness;
    triggers(...triggers: readonly Trigger[]): Harness;
    scheduler(scheduler: Scheduler): Harness;
    supervisor(supervisor: Supervisor): Harness;
    projections(...projections: readonly Projection[]): Harness;
    start(): Promise<HarnessRun>;
  }

  export const H: {
    env(variable: string): EnvRef;
    slot: { port(index: number): PortRef };
    work(name: string): WorkKind<unknown, never>;
    state<N extends string>(name: N): StateStart<N>;
    memory(name: string): MemoryKind<unknown>;
    role(name: string): Role;
    skill(name: string): Skill<NoInput, string>;
    account(name: string, driver: AccountDriver): Account;
    model(name: string, source: Account | Pool<Account>, modelId: string): Model;
    command(name: string): CommandBuilder<NoInput, void>;
    pool<C extends Candidate>(name: string, candidates: readonly C[]): Pool<C>;
    agent(name: string): Agent;
    lane(name: string): LaneStart;
    journal(name: string): JournalStart;
    flow(name: string): FlowStart;
    trigger(name: string): TriggerStart;
    policy: {
      pick<C extends Candidate>(
        name: string,
        decide: (context: PickContext<C>) => readonly C[],
      ): Policy<PickContext<C>, readonly C[]>;
      schedule(
        name: string,
        decide: (context: ScheduleContext) => ScheduleDecision,
      ): Policy<ScheduleContext, ScheduleDecision>;
      recall(
        name: string,
        decide: (context: RecallContext) => readonly RecallCandidate[],
      ): Policy<RecallContext, readonly RecallCandidate[]>;
    };
    scheduler(name: string): Scheduler;
    operation<I, O>(name: string, executable: Executable<I, O>): Operation;
    ops: {
      readonly work: { readonly read: Operation; readonly write: Operation };
      readonly blockers: { readonly resolve: Operation };
      readonly memory: { readonly read: Operation; readonly write: Operation; readonly curate: Operation };
      readonly telemetry: { readonly read: Operation };
      readonly accounts: { readonly manage: Operation };
    };
    supervisor(name: string): Supervisor;
    harness(name: string): Harness;
  };
}

declare module 'harness-dsl/claude-code' {
  import type { AccountDriver, Endpoint, Setting } from 'harness-dsl';
  export const claudeCode: {
    subscription(options: { readonly configDir: Setting }): AccountDriver;
    endpoint(options: { readonly server: string }): Endpoint;
  };
}

declare module 'harness-dsl/anthropic' {
  import type { AccountDriver, Pricing, Secret } from 'harness-dsl';
  export const anthropic: {
    api(options: { readonly apiKey: Secret }): AccountDriver;
    pricing(): Pricing;
  };
}

declare module 'harness-dsl/sqlite' {
  import type { Ledger, QuotaStore, Store } from 'harness-dsl';
  export const sqlite: {
    ledger(path: string): Ledger;
    quota(path: string): QuotaStore;
    store(path: string): Store;
  };
}

declare module 'harness-dsl/jsonl' {
  import type { MemoryStore } from 'harness-dsl';
  export const jsonl: {
    memory(path: string): MemoryStore;
  };
}

declare module 'harness-dsl/lancedb' {
  import type { MemoryStore, Secret } from 'harness-dsl';
  export const lancedb: {
    memory(options: {
      readonly uri: string;
      readonly table: string;
      readonly embeddingModel: string;
      readonly apiKey: Secret;
    }): MemoryStore;
  };
}

declare module 'harness-dsl/linear' {
  import type { Secret, Store, Supplier } from 'harness-dsl';
  export interface LinearIssue {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly description: string;
    readonly labels: readonly string[];
    readonly status: string;
    readonly parentId: string | null;
    readonly url: string;
  }
  export const linear: {
    supply<D>(options: {
      readonly apiKey: Secret;
      readonly team: string;
      readonly labels?: readonly string[];
      readonly map: (issue: LinearIssue) => D;
    }): Supplier<D>;
    store(options: {
      readonly apiKey: Secret;
      readonly team: string;
      readonly statuses: Readonly<Record<string, string>>;
    }): Store;
  };
}

declare module 'harness-dsl/folder' {
  import type { Store, Supplier, Unparsed } from 'harness-dsl';
  export const folder: {
    supply(path: string, options?: { readonly glob?: string }): Supplier<Unparsed>;
    store(path: string): Store;
  };
}

declare module 'harness-dsl/supply' {
  import type { Supplier, Unparsed } from 'harness-dsl';
  export function schedule<D>(
    cron: string,
    produce: (at: Date) => readonly D[],
    options?: { readonly timeZone?: string },
  ): Supplier<D>;
  export function manual(): Supplier<Unparsed>;
}

declare module 'harness-dsl/rest' {
  import type { Json, Secret, Setting, Store, Supplier } from 'harness-dsl';
  export const rest: {
    poll<D>(options: {
      readonly url: Setting;
      readonly token?: Secret;
      readonly everyMinutes: number;
      readonly map: (record: Json) => D | null;
    }): Supplier<D>;
    store(options: {
      readonly baseUrl: Setting;
      readonly token?: Secret;
      readonly path: (kind: string, key: string) => string;
    }): Store;
  };
}

declare module 'harness-dsl/webhook' {
  import type { Json, Secret, Supplier, WorkKind } from 'harness-dsl';
  export const webhook: {
    supply<D>(options: {
      readonly path: string;
      readonly secret?: Secret;
      readonly mode?: 'create' | 'upsert';
      readonly map: (body: Json) => D | null;
    }): Supplier<D>;
    update<D>(options: {
      readonly kind: WorkKind<D, string>;
      readonly path: string;
      readonly secret?: Secret;
      readonly map: (body: Json) => { readonly key: string; readonly patch: Partial<D> } | null;
    }): Supplier<D>;
  };
}

declare module 'harness-dsl/http' {
  import type { Endpoint, PortRef, Secret } from 'harness-dsl';
  export const http: {
    endpoint(options: { readonly port: number | PortRef; readonly token: Secret }): Endpoint;
  };
}

declare module 'harness-dsl/slack' {
  import type { Executable, Secret } from 'harness-dsl';
  export const slack: {
    message(name: string, options: { readonly webhookUrl: Secret }): Executable<{ readonly text: string }, void>;
  };
}

declare module 'harness-dsl/runners' {
  import type { Runner, Setting } from 'harness-dsl';
  export function local(name: string): Runner;
  export function ssh(
    name: string,
    options: { readonly host: Setting; readonly user: Setting; readonly keyPath: Setting },
  ): Runner;
}

declare module 'harness-dsl/policies' {
  import type { Account, PickContext, Policy, RecallCandidate, RecallContext } from 'harness-dsl';
  export const drainSoonestExpiring: Policy<PickContext<Account>, readonly Account[]>;
  export function byApplicability(options: {
    readonly budgetTokens: number;
  }): Policy<RecallContext, readonly RecallCandidate[]>;
  export function bySimilarity(options: {
    readonly budgetTokens: number;
    readonly minSimilarity: number;
  }): Policy<RecallContext, readonly RecallCandidate[]>;
}

declare module 'harness-dsl/projections' {
  import type { Projection } from 'harness-dsl';
  export function board(path: string): Projection;
  export function telemetry(path: string): Projection;
}

declare module 'harness-dsl/plugins' {
  import type { AgentPlugin, Executable, NoInput } from 'harness-dsl';
  export function fileLeaseGuard(): AgentPlugin;
  export function stopCheck(check: Executable<NoInput, unknown>): AgentPlugin;
}

declare module 'harness-dsl/git' {
  import type { AgentPlugin } from 'harness-dsl';
  export function worktree(options: { readonly repo: string }): AgentPlugin;
}
