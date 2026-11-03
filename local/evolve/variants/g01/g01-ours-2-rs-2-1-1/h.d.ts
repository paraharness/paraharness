declare module 'harness-dsl' {
  import { z } from 'zod';
  import type * as K from 'harness-dsl/kernel';

  type Mapper<S, Out> = (state: S, ctx: StepContext) => Out;

  export interface StepContext {
    readonly now: Date;
    readonly unit: K.UnitMeta;
  }

  export interface State<N extends string = string, P extends K.Position = K.Position> {
    readonly entity: 'state';
    readonly name: N;
    readonly position: P;
    readonly verdict: K.Verdict | undefined;
  }
  export interface StateDraft<N extends string> {
    pending(): State<N, 'pending'>;
    active(): State<N, 'active'>;
    waiting(): State<N, 'waiting'>;
    terminal(verdict: K.Verdict): State<N, 'terminal'>;
  }
  type Settled<St> = Extract<St, { readonly position: 'terminal' | 'waiting' }>;

  export interface AnyWork {
    readonly entity: 'work';
    readonly name: string;
  }
  export interface Work<N extends string, T, St extends State> extends AnyWork {
    readonly name: N;
    readonly schema: z.ZodType<T>;
    readonly states: readonly St[];
  }
  export interface WorkDraft<N extends string> {
    schema<S extends z.ZodType>(schema: S): WorkSchema<N, z.output<S>>;
  }
  export interface WorkSchema<N extends string, T> {
    states<Ss extends readonly State[]>(...states: Ss): Work<N, T, Ss[number]>;
  }

  export interface AnyResource {
    readonly entity: 'resource';
    readonly name: string;
  }
  export interface Resource<N extends string = string> extends AnyResource {
    readonly name: N;
    exclusive(): LeaseClaim;
    shared(): LeaseClaim;
  }
  export interface LeaseClaim {
    readonly entity: 'lease';
    readonly resource: AnyResource;
    readonly mode: 'exclusive' | 'shared';
  }

  export interface AnyHalt {
    readonly entity: 'halt';
    readonly name: string;
  }
  export interface Halt<N extends string, C, D> extends AnyHalt {
    readonly name: N;
    readonly context: z.ZodType<C>;
    readonly decision: z.ZodType<D>;
    ask(question: (context: C) => string): Halt<N, C, D>;
  }
  export interface HaltDraft<N extends string> {
    context<S extends z.ZodType>(schema: S): HaltContext<N, z.output<S>>;
  }
  export interface HaltContext<N extends string, C> {
    decision<S extends z.ZodType>(schema: S): Halt<N, C, z.output<S>>;
  }

  export interface AnyMemoryKind {
    readonly entity: 'memory';
    readonly name: string;
  }
  export interface MemoryKind<N extends string, C> extends AnyMemoryKind {
    readonly name: N;
    readonly content: z.ZodType<C>;
    trust(trust: 'experience' | 'taste'): MemoryKind<N, C>;
    curated(): MemoryKind<N, C>;
  }
  export interface MemoryDraft<N extends string> {
    content<S extends z.ZodType>(schema: S): MemoryKind<N, z.output<S>>;
  }

  export interface Role<N extends string = string> {
    readonly entity: 'role';
    readonly name: N;
    prompt(text: string): Role<N>;
    intents(intents: readonly K.Intent[]): Role<N>;
    recall(...kinds: readonly AnyMemoryKind[]): Role<N>;
    record(...kinds: readonly AnyMemoryKind[]): Role<N>;
    use(...plugins: readonly K.AgentPlugin[]): Role<N>;
  }

  export interface AnySkill {
    readonly entity: 'skill';
    readonly name: string;
  }
  export interface Skill<N extends string, I, O> extends AnySkill {
    readonly name: N;
    readonly __io?: (input: I) => O;
    prompt(render: (input: I) => string): Skill<N, I, O>;
  }
  export interface SkillDraft<N extends string> {
    input<S extends z.ZodType>(schema: S): SkillInput<N, z.output<S>>;
  }
  export interface SkillInput<N extends string, I> {
    output<S extends z.ZodType>(schema: S): Skill<N, I, z.output<S>>;
  }

  export interface Facet<N extends string = string> {
    readonly entity: 'facet';
    readonly name: N;
    is(value: string): FacetValue<N>;
  }
  export interface FacetValue<N extends string = string> {
    readonly facet: Facet<N>;
    readonly value: string;
  }
  export type Dimension = K.Column | Facet;
  type DimTag<D> = D extends Facet<infer N> ? `facet:${N}` : D extends string ? D : never;
  type FacetName<Key> = Key extends `facet:${infer N}` ? N : never;
  type KeyValue<D> =
    D extends `facet:${infer N}` ? FacetValue<N> :
    D extends 'model' ? Model :
    D extends 'seat' ? AnySeat :
    D extends 'lane' ? LaneRef<unknown> :
    D extends 'kind' ? AnyWork :
    D extends 'state' ? State :
    D extends 'resource' ? AnyResource :
    D extends 'halt' ? AnyHalt :
    D extends 'account' ? AnyAccount :
    D extends 'job' ? AnyJob :
    D extends 'resolver' ? K.Resolver :
    never;

  export interface ScopeInput {
    readonly kinds?: readonly AnyWork[];
    readonly roles?: readonly Role[];
    readonly skills?: readonly AnySkill[];
    readonly resources?: readonly AnyResource[];
    readonly facets?: readonly FacetValue[];
  }

  export interface AnyAccount {
    readonly entity: 'account';
    readonly name: string;
  }
  export interface Account<N extends string> extends AnyAccount {
    readonly name: N;
    quota(partition: K.QuotaPartition): Account<N>;
  }

  export interface Model {
    readonly entity: 'model';
    readonly name: string;
    pricing(pricing: K.ModelPricing): Model;
  }

  export interface Executable<I, O> {
    readonly name: string;
    readonly executable: 'command' | 'seat' | 'job';
    readonly __io?: (input: I) => O;
  }

  export interface CommandContext {
    readonly now: Date;
    readonly unit: K.UnitMeta;
    readonly attempt: string;
    exec(argv: readonly string[], options?: K.ExecOptions): Promise<K.ExecResult>;
    remember<C>(kind: MemoryKind<string, C>, content: C, when?: ScopeInput): void;
  }

  export interface CommandDraft<N extends string> {
    input<S extends z.ZodType>(schema: S): CommandInput<N, z.output<S>>;
  }
  export interface CommandInput<N extends string, I> {
    output<S extends z.ZodType>(schema: S): CommandBody<N, I, z.output<S>>;
  }
  export interface CommandBody<N extends string, I, O> {
    runner(runner: K.Runner | ((input: I) => K.Runner)): CommandBody<N, I, O>;
    effect(effect: K.Effect): CommandBody<N, I, O>;
    detect(probe: (input: I, ctx: CommandContext) => Promise<O | undefined>): CommandBody<N, I, O>;
    run(body: (input: I, ctx: CommandContext) => Promise<O>): Command<N, I, O>;
  }
  export interface Command<N extends string, I, O> extends Executable<I, O> {
    readonly entity: 'command';
    readonly name: N;
    readonly effect: K.Effect;
  }

  export interface AnyJob {
    readonly entity: 'job';
    readonly name: string;
  }
  export interface JobDraft<N extends string> {
    input<S extends z.ZodType>(schema: S): JobInput<N, z.output<S>>;
    batch<I, O>(seat: Seat<string, I, O>): Job<N, readonly I[], readonly O[]>;
  }
  export interface JobInput<N extends string, I> {
    output<S extends z.ZodType>(schema: S): JobBody<N, I, z.output<S>>;
  }
  export interface JobBody<N extends string, I, O> {
    submit(submit: (input: I, ctx: CommandContext) => Promise<string>): JobSubmitted<N, I, O>;
  }
  export interface JobSubmitted<N extends string, I, O> {
    collect(collect: (ref: string, ctx: CommandContext) => Promise<K.JobPoll<O>>, every: K.Duration): Job<N, I, O>;
  }
  export interface Job<N extends string, I, O> extends Executable<I, O>, AnyJob {
    readonly name: N;
    detect(probe: (input: I, ctx: CommandContext) => Promise<string | undefined>): Job<N, I, O>;
  }

  export interface AnySeat {
    readonly entity: 'seat';
    readonly name: string;
  }
  export interface SeatDraft<N extends string> {
    role(role: Role): SeatRole<N>;
  }
  export interface SeatRole<N extends string> {
    skill<I, O>(skill: Skill<string, I, O>): SeatSkill<N, I, O>;
  }
  export interface SeatSkill<N extends string, I, O> {
    models(...models: readonly Model[]): Seat<N, I, O>;
  }
  export interface Seat<N extends string, I, O> extends Executable<I, O>, AnySeat {
    readonly name: N;
    policy(choice: Policy<'models'>): Seat<N, I, O>;
  }

  export interface Pool {
    readonly entity: 'pool';
    readonly name: string;
    share(account: AnyAccount, maxQuotaShare: number): Pool;
    serves(...models: readonly Model[]): Pool;
    policy(order: Policy<'accounts'>): Pool;
    fallback(account: AnyAccount): Pool;
  }

  export interface Policy<Site extends string> {
    readonly entity: 'policy';
    readonly name: string;
    readonly site: Site;
  }
  export interface DecisionPolicy<C, D> extends Policy<'decision'> {
    readonly __decides?: (context: C) => D;
  }
  export interface MetricsReader {
    read<Key extends string>(metric: Metric<Key>, ...at: readonly NoInfer<KeyValue<Key>>[]): K.Reading;
  }
  export interface AccountChoice {
    readonly candidates: readonly K.AccountCandidate[];
    readonly model: Model;
    readonly unit: K.UnitMeta;
    readonly metrics: MetricsReader;
    readonly now: Date;
  }
  export interface ModelChoice {
    readonly candidates: readonly Model[];
    readonly seat: string;
    readonly unit: K.UnitMeta;
    readonly metrics: MetricsReader;
    readonly now: Date;
  }
  export interface ScheduleChoice {
    readonly candidates: readonly K.Candidate[];
    readonly active: readonly K.ActiveUnit[];
    readonly metrics: MetricsReader;
    readonly now: Date;
  }
  export interface RecallChoice {
    readonly candidates: readonly K.RecallCandidate[];
    readonly seat: string;
    readonly unit: K.UnitMeta;
    readonly limit: number;
    readonly metrics: MetricsReader;
    readonly now: Date;
  }
  export interface DecisionChoice<C> {
    readonly context: C;
    readonly unit: K.UnitMeta;
    readonly metrics: MetricsReader;
    readonly now: Date;
  }

  export interface Stream<E> {
    readonly entity: 'stream';
    where(test: (event: E) => boolean): Stream<E>;
    streak(count: number, options: { readonly group: (event: E) => string; readonly matches: (event: E) => boolean }): Stream<K.StreakEvent<E>>;
  }

  export interface MetricDraft<E> {
    rate(test: (event: E) => boolean): Metric<never>;
    mean(value: (event: E) => number): Metric<never>;
    median(value: (event: E) => number): Metric<never>;
    sum(value: (event: E) => number): Metric<never>;
    count(): Metric<never>;
  }
  export interface Metric<Key extends string> {
    readonly entity: 'metric';
    readonly name: string;
    readonly __key?: Key;
    by<D extends Dimension[]>(...dimensions: D): Metric<Key | DimTag<D[number]>>;
    window(window: K.Window): Metric<Key>;
    crossing(bounds: { readonly below: number; readonly above: number; readonly samples: number }): Hysteresis<Key>;
  }
  export interface Crossing<Key extends string> {
    readonly value: number;
    readonly samples: number;
    readonly direction: 'down' | 'up';
    readonly at: Date;
    facet<N extends FacetName<Key>>(facet: Facet<N>): string;
  }
  export interface Hysteresis<Key extends string> {
    readonly down: Stream<Crossing<Key>>;
    readonly up: Stream<Crossing<Key>>;
  }

  export interface Consequence<E> {
    readonly entity: 'consequence';
    readonly __on?: (event: E) => void;
  }
  export interface Call<Src, O> extends Consequence<Src> {
    readonly __out?: O;
  }
  export type CallFactory<S> = <In, O>(exe: Executable<In, O>, input: Mapper<S, NoInfer<In>>) => Call<S, O>;
  type CallOutput<C> = C extends Call<infer _S, infer O> ? O : never;

  export interface Trigger {
    readonly entity: 'trigger';
    readonly name: string;
  }
  export interface TriggerSource<E> {
    do(...consequences: readonly Consequence<E>[]): Trigger;
  }

  export interface LaneRef<T> {
    readonly entity: 'lane';
    readonly name: string;
    readonly __data?: T;
  }
  export type Selector<E, T, St> =
    | ((event: E) => string)
    | { readonly state: St; readonly where?: (data: T, event: E) => boolean }
    | { readonly halted: AnyHalt; readonly key?: (event: E) => string };
  export type ExitTarget<St> = St | { readonly to: St; readonly atMost: number; readonly then: St };
  export interface Backoff {
    readonly initial: K.Duration;
    readonly factor: number;
    readonly max?: K.Duration;
  }
  export interface LaneRetry<St> {
    readonly retries: number;
    readonly backoff?: Backoff;
    readonly exhausted: Settled<St>;
  }
  export type Handling<T, FI, L extends string, St> = {
    readonly exits: { readonly [P in L]: ExitTarget<St> };
    readonly retry: LaneRetry<St>;
  } & ([T] extends [FI]
    ? { readonly input?: (unit: K.UnitView<T>) => FI }
    : { readonly input: (unit: K.UnitView<T>) => FI });

  export interface Lane<N extends string, T, St extends State> extends LaneRef<T> {
    readonly name: N;
    from(...suppliers: readonly K.Supplier<T>[]): Lane<N, T, St>;
    store(store: K.Store<T>): Lane<N, T, St>;
    handle<FI, S, L extends string>(flow: Flow<FI, S, L>, handling: Handling<T, FI, L, St>): Lane<N, T, St>;
    wip(limit: number): Lane<N, T, St>;
    ceiling(ceiling: { readonly maxUsd: number; readonly onExceed: Halt<string, K.CeilingFacts, K.CeilingDecision> }): Lane<N, T, St>;
    order(order: { readonly after: (data: T) => readonly string[] }): Lane<N, T, St>;
    holds(candidate: K.Candidate): candidate is K.Candidate<T>;
    create<E>(child: (event: E) => K.Child<T>, facets?: (event: E) => readonly FacetValue[]): Consequence<E>;
    move<E>(select: Selector<E, T, St>, to: St): Consequence<E>;
    pause<E>(reason: (event: E) => string): Consequence<E>;
    resume<E>(): Consequence<E>;
  }

  export interface LoopIndex {
    readonly iteration: number;
  }
  export interface StepOptions {
    readonly retry: { readonly retries: number; readonly backoff?: Backoff };
  }

  export interface Flow<I, S, L extends string> {
    readonly entity: 'flow';
    readonly name: string;
    readonly __flow?: (input: I) => S;
    readonly __exits?: L;
    use(...middleware: readonly K.Middleware[]): Flow<I, S, L>;
    resources(claims: (input: I) => readonly LeaseClaim[]): Flow<I, S, L>;
    tag(facet: Facet, value: Mapper<S, string>): Flow<I, S, L>;
    step<N extends string, In, O>(name: N, exe: Executable<In, O>, input: Mapper<S, NoInfer<In>>, options?: StepOptions): Flow<I, S & { readonly [P in N]: O }, L>;
    halt<N extends string, C, D>(name: N, halt: Halt<string, C, D>, context: Mapper<S, NoInfer<C>>, options?: { readonly resolver: DecisionPolicy<NoInfer<C>, NoInfer<D>> }): Flow<I, S & { readonly [P in N]: D }, L>;
    when<S2, L2 extends string>(test: Mapper<S, boolean>, then: (flow: Flow<I, S, never>) => Flow<I, S2, L2>): Flow<I, S, L | L2>;
    loop<N extends string, S2, L2 extends string>(name: N, loop: {
      readonly max: (state: S) => number;
      readonly body: (flow: Flow<I, S & { readonly [P in N]: LoopIndex }, never>) => Flow<I, S2, L2>;
      readonly until: (state: S2) => boolean;
    }): Flow<I, S2, L | L2>;
    parallel<N extends string, B extends Record<string, Call<S, unknown>>>(name: N, calls: (call: CallFactory<S>) => B): Flow<I, S & { readonly [P in N]: { readonly [Q in keyof B]: CallOutput<B[Q]> } }, L>;
    spawn<N extends string, T2>(name: N, lane: LaneRef<T2>, children: Mapper<S, readonly K.Child<T2>[]>): Flow<I, S & { readonly [P in N]: readonly K.ChildResult[] }, L>;
    exit<X extends string>(label: X): Flow<I, S, L | X>;
  }
  export interface FlowDraft {
    input<Sc extends z.ZodType>(schema: Sc): Flow<z.output<Sc>, { readonly input: z.output<Sc> }, never>;
  }

  export interface AnyJournal {
    readonly entity: 'journal';
    readonly name: string;
  }
  export interface Journal<N extends string, C> extends AnyJournal {
    readonly name: N;
    store(store: K.MemoryStore): Journal<N, C>;
    recall(policy: Policy<'recall'>): Journal<N, C>;
    record<E>(item: (event: E) => { readonly content: C; readonly when?: ScopeInput }): Consequence<E>;
  }

  export interface Operation {
    readonly entity: 'operation';
    readonly name: string;
  }
  export interface ResolveOperation<C, D> extends Operation {
    with(decide: (event: K.HaltOpenEvent<C>) => D): Consequence<K.HaltOpenEvent<C>>;
  }
  export interface Grant {
    readonly entity: 'grant';
    readonly client: string;
    readonly operations: readonly Operation[];
  }

  export interface Harness<N extends string> {
    readonly entity: 'harness';
    readonly name: N;
    ledger(ledger: K.Ledger): Harness<N>;
    pools(...pools: readonly Pool[]): Harness<N>;
    lanes(...lanes: readonly LaneRef<unknown>[]): Harness<N>;
    journals(...journals: readonly AnyJournal[]): Harness<N>;
    triggers(...triggers: readonly Trigger[]): Harness<N>;
    scheduler(order: Policy<'units'>): Harness<N>;
    grants(...grants: readonly Grant[]): Harness<N>;
    observe(...observers: readonly K.Observer[]): Harness<N>;
    start(): Promise<K.Stoppable>;
  }

  export const H: {
    work<N extends string>(name: N): WorkDraft<N>;
    state<N extends string>(name: N): StateDraft<N>;
    resource<N extends string>(name: N): Resource<N>;
    halt<N extends string>(name: N): HaltDraft<N>;
    memory<N extends string>(name: N): MemoryDraft<N>;
    role<N extends string>(name: N): Role<N>;
    skill<N extends string>(name: N): SkillDraft<N>;
    facet<N extends string>(name: N): Facet<N>;

    account<N extends string>(name: N, driver: K.AccountDriver): Account<N>;
    model(id: string): Model;
    command<N extends string>(name: N): CommandDraft<N>;
    job<N extends string>(name: N): JobDraft<N>;

    seat<N extends string>(name: N): SeatDraft<N>;
    pool(name: string, accounts: readonly AnyAccount[]): Pool;
    lane<N extends string>(name: N): { of<T, St extends State>(work: Work<string, T, St>): Lane<N, T, St> };
    journal<N extends string>(name: N): { of<C>(kind: MemoryKind<string, C>): Journal<N, C> };
    grant(client: K.Client, ...operations: readonly Operation[]): Grant;

    flow(name: string): FlowDraft;
    call<Src, In, O>(exe: Executable<In, O>, input: (event: Src, ctx: StepContext) => NoInfer<In>): Call<Src, O>;
    trigger(name: string): { on<E>(source: Stream<E>): TriggerSource<E> };
    metric<E>(name: string, over: Stream<E>): MetricDraft<E>;

    policy: {
      accounts(name: string, order: (choice: AccountChoice) => readonly K.AccountCandidate[]): Policy<'accounts'>;
      models(name: string, order: (choice: ModelChoice) => readonly Model[]): Policy<'models'>;
      units(name: string, order: (choice: ScheduleChoice) => readonly K.Candidate[]): Policy<'units'>;
      recall(name: string, order: (choice: RecallChoice) => readonly K.RecallCandidate[]): Policy<'recall'>;
      decision<C, D>(name: string, halt: Halt<string, C, D>, decide: (choice: DecisionChoice<C>) => NoInfer<D> | undefined): DecisionPolicy<C, D>;
    };

    events: {
      transitions<T>(lane: LaneRef<T>, filter?: { readonly to?: State; readonly terminal?: boolean }): Stream<K.TransitionEvent<T>>;
      attempts(lane?: LaneRef<unknown>): Stream<K.AttemptEvent>;
      steps<I, O>(exe: Executable<I, O>): Stream<K.StepEvent<O>>;
      invocations(): Stream<K.InvocationEvent>;
      decisions<C, D>(halt: Halt<string, C, D>): Stream<K.DecisionEvent<C, D>>;
      jobs(job: AnyJob): Stream<K.JobEvent>;
      leases(): Stream<K.LeaseEvent>;
      pauses(lane: LaneRef<unknown>): Stream<K.PauseEvent>;
      updates<T>(lane: LaneRef<T>): Stream<K.UpdateEvent<T>>;
    };

    time: {
      every(cron: string): Stream<K.TimeEvent>;
      at<T>(lane: LaneRef<T>, deadline: (data: T) => Date | undefined): Stream<K.DeadlineEvent<T>>;
      after<C, D>(halt: Halt<string, C, D>, wait: K.Duration): Stream<K.HaltOpenEvent<C>>;
    };

    ops: {
      resolve<C, D>(halt: Halt<string, C, D>): ResolveOperation<C, D>;
      work: { readonly read: Operation; readonly write: Operation };
      memory: { read(kind: AnyMemoryKind): Operation; write(kind: AnyMemoryKind): Operation; curate(kind: AnyMemoryKind): Operation };
      telemetry: { readonly read: Operation };
      accounts: { readonly manage: Operation };
      attempts: { readonly manage: Operation };
    };
    operation<I, O>(name: string, exe: Executable<I, O>): Operation;

    harness<N extends string>(name: N): Harness<N>;
    env(name: string): K.EnvRef;
    slot: { port(index: number): K.SlotRef };
  };
}

declare module 'harness-dsl/claude-code' {
  import type { AccountDriver, Client, Setting } from 'harness-dsl/kernel';
  export const claudeCode: {
    driver(options: { readonly configDir: Setting }): AccountDriver;
    client(options: { readonly name: string }): Client;
  };
}

declare module 'harness-dsl/anthropic' {
  import type { AccountDriver, EnvRef, ModelPricing } from 'harness-dsl/kernel';
  export const anthropic: {
    api(options: { readonly apiKey: EnvRef }): AccountDriver;
    pricing(): ModelPricing;
  };
}

declare module 'harness-dsl/sqlite' {
  import type { Ledger, QuotaPartition, Store } from 'harness-dsl/kernel';
  export const sqlite: {
    ledger(path: string): Ledger;
    quota(path: string): QuotaPartition;
    store<T>(path: string): Store<T>;
  };
}

declare module 'harness-dsl/jsonl' {
  import type { MemoryStore } from 'harness-dsl/kernel';
  export const jsonl: {
    memory(path: string): MemoryStore;
  };
}

declare module 'harness-dsl/pgvector' {
  import type { EnvRef, MemoryStore, Setting } from 'harness-dsl/kernel';
  export const pgvector: {
    memory(options: { readonly url: Setting; readonly table: string; readonly embeddingModel: string; readonly embeddingKey: EnvRef }): MemoryStore;
  };
}

declare module 'harness-dsl/linear' {
  import { z } from 'zod';
  import type { EnvRef, Store, Supplier } from 'harness-dsl/kernel';
  export interface LinearIssue {
    readonly id: string;
    readonly identifier: string;
    readonly title: string;
    readonly description: string;
    readonly labels: readonly string[];
    readonly state: string;
    readonly parentId: string | undefined;
  }
  export const linear: {
    issues<T>(options: {
      readonly name: string;
      readonly apiKey: EnvRef;
      readonly team: string;
      readonly labels: readonly string[];
      readonly data: (issue: LinearIssue) => T;
    }): Supplier<T>;
    store<S extends z.ZodType>(options: {
      readonly apiKey: EnvRef;
      readonly team: string;
      readonly schema: S;
      readonly states: Readonly<Record<string, string>>;
    }): Store<z.output<S>>;
  };
}

declare module 'harness-dsl/http' {
  import { z } from 'zod';
  import type { Client, EnvRef, Setting, SlotRef, Supplier } from 'harness-dsl/kernel';
  export interface WebhookOptions<S extends z.ZodType> {
    readonly name: string;
    readonly path: string;
    readonly port: number | SlotRef;
    readonly secret: Setting;
    readonly body: S;
    readonly key: (body: z.output<S>) => string;
  }
  export const http: {
    client(options: { readonly name: string; readonly port: number | SlotRef; readonly token: EnvRef }): Client;
    webhook<S extends z.ZodType, T>(options: WebhookOptions<S> & {
      readonly mode: 'update';
      readonly data: (body: z.output<S>, current: T) => T;
    }): Supplier<T>;
    webhook<S extends z.ZodType, T>(options: WebhookOptions<S> & {
      readonly mode?: 'upsert' | 'create';
      readonly data: (body: z.output<S>, current: T | undefined) => T;
    }): Supplier<T>;
  };
}

declare module 'harness-dsl/rest' {
  import { z } from 'zod';
  import type { Duration, EnvRef, Setting, Store, Supplier } from 'harness-dsl/kernel';
  export const rest: {
    poll<S extends z.ZodType, T>(options: {
      readonly name: string;
      readonly baseUrl: Setting;
      readonly token: EnvRef;
      readonly path: string;
      readonly interval: Duration;
      readonly item: S;
      readonly key: (item: z.output<S>) => string;
      readonly data: (item: z.output<S>) => T;
    }): Supplier<T>;
    store<S extends z.ZodType>(options: {
      readonly name: string;
      readonly baseUrl: Setting;
      readonly token: EnvRef;
      readonly path: string;
      readonly schema: S;
    }): Store<z.output<S>>;
  };
}

declare module 'harness-dsl/supply' {
  import { z } from 'zod';
  import type { Child, Store, Supplier } from 'harness-dsl/kernel';
  export interface FolderFile {
    readonly path: string;
    readonly name: string;
    readonly frontmatter: Readonly<Record<string, unknown>>;
    readonly body: string;
  }
  export const folder: {
    files<T>(options: {
      readonly name: string;
      readonly path: string;
      readonly glob: string;
      readonly data: (file: FolderFile) => T;
      readonly key?: (file: FolderFile) => string;
    }): Supplier<T>;
    store<S extends z.ZodType>(options: { readonly path: string; readonly schema: S }): Store<z.output<S>>;
  };
  export const schedule: {
    cron<T>(options: { readonly name: string; readonly cron: string; readonly children: (at: Date) => readonly Child<T>[] }): Supplier<T>;
  };
  export function manual<T>(name: string): Supplier<T>;
}

declare module 'harness-dsl/runners' {
  import type { EnvRef, Runner, Setting } from 'harness-dsl/kernel';
  export interface PreflightResult {
    readonly ok: boolean;
    readonly reason?: string;
  }
  export interface RunnerInstance extends Runner {
    env(vars: Readonly<Record<string, Setting>>): RunnerInstance;
    preflight(name: string, check: (runner: Runner) => Promise<PreflightResult>): RunnerInstance;
  }
  export const runners: {
    local(options: { readonly name: string; readonly slots: number }): RunnerInstance;
    ssh(options: { readonly name: string; readonly host: Setting; readonly user: string; readonly identity: EnvRef; readonly slots: number }): RunnerInstance;
  };
}

declare module 'harness-dsl/policies' {
  import type { Policy } from 'harness-dsl';
  export const policies: {
    soonestReset(): Policy<'accounts'>;
    specificity(options: { readonly limit: number }): Policy<'recall'>;
  };
}

declare module 'harness-dsl/observers' {
  import type { Stream } from 'harness-dsl';
  import type { Observer, Setting } from 'harness-dsl/kernel';
  export const observers: {
    board(options: { readonly path: string }): Observer;
    telemetry(options: { readonly path: string }): Observer;
    slack<E>(options: { readonly webhookUrl: Setting; readonly on: Stream<E>; readonly text: (event: E) => string }): Observer;
  };
}

declare module 'harness-dsl/plugins' {
  import type { AnyResource, Executable } from 'harness-dsl';
  import type { AgentPlugin, Middleware, StopCheckInput, StopCheckResult } from 'harness-dsl/kernel';
  export interface FileLeaseGuard extends AgentPlugin {
    area(resource: AnyResource, globs: readonly string[]): FileLeaseGuard;
  }
  export const plugins: {
    gitWorktree(): Middleware;
    fileLeaseGuard(): FileLeaseGuard;
    stopCheck(check: Executable<StopCheckInput, StopCheckResult>): AgentPlugin;
  };
}
