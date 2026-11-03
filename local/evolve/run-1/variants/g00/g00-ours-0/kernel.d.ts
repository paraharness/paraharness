declare module 'harness-dsl/kernel' {
  export type Outcome = 'pending' | 'active' | 'succeeded' | 'failed' | 'cancelled' | 'ended';
  export type TerminalOutcome = 'succeeded' | 'failed' | 'cancelled' | 'ended';

  export type Duration = `${number}s` | `${number}m` | `${number}h` | `${number}d`;
  export type Window = Duration | { readonly since: Date };

  export type Json =
    | string
    | number
    | boolean
    | null
    | readonly Json[]
    | { readonly [key: string]: Json };

  export interface EnvRef {
    readonly ref: 'env';
    readonly name: string;
  }
  export interface PortRef {
    readonly ref: 'port';
    readonly index: number;
  }
  export type Secret = string | EnvRef;
  export type EnvValue = string | EnvRef | PortRef;

  export interface StateRef {
    readonly name: string;
    readonly outcome: Outcome;
  }

  export interface UnitView<T> {
    readonly id: string;
    readonly key: string;
    readonly kind: string;
    readonly lane: string;
    readonly data: T;
    readonly state: StateRef;
    readonly createdAt: Date;
    readonly parentId: string | null;
    readonly costUsd: number;
    readonly attempts: number;
  }

  export type AttemptStatus = 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled';

  export interface AttemptView {
    readonly id: string;
    readonly unitId: string;
    readonly number: number;
    readonly status: AttemptStatus;
    readonly startedAt: Date;
    readonly endedAt: Date | null;
    readonly durationMs: number | null;
    readonly costUsd: number;
    readonly models: Readonly<Record<string, string>>;
  }

  export type Actor =
    | { readonly type: 'harness' }
    | { readonly type: 'agent'; readonly agent: string; readonly model: string }
    | { readonly type: 'command'; readonly command: string }
    | { readonly type: 'operator'; readonly name: string }
    | { readonly type: 'supplier'; readonly supplier: string }
    | { readonly type: 'trigger'; readonly trigger: string };

  export interface RecordBase {
    readonly id: string;
    readonly at: Date;
    readonly run: string;
  }

  export interface TransitionEvent<T> extends RecordBase {
    readonly type: 'transition';
    readonly unit: UnitView<T>;
    readonly from: StateRef | null;
    readonly to: StateRef;
    readonly actor: Actor;
    readonly attempt: AttemptView | null;
  }

  export interface UpdateEvent<T> extends RecordBase {
    readonly type: 'update';
    readonly unit: UnitView<T>;
    readonly previous: UnitView<T>;
    readonly actor: Actor;
  }

  export interface OverdueEvent<T> extends RecordBase {
    readonly type: 'overdue';
    readonly unit: UnitView<T>;
    readonly deadline: Date;
  }

  export interface ResolutionEvent<T, R> extends RecordBase {
    readonly type: 'resolution';
    readonly unit: UnitView<T>;
    readonly blocker: string;
    readonly resolution: R;
    readonly actor: Actor;
    readonly attempt: AttemptView;
  }

  export interface RunRecord extends RecordBase {
    readonly type: 'run';
    readonly phase: 'started' | 'stopped';
  }

  export interface AttemptRecord extends RecordBase {
    readonly type: 'attempt';
    readonly attempt: AttemptView;
    readonly unit: UnitView<unknown>;
  }

  export interface InvocationRecord extends RecordBase {
    readonly type: 'invocation';
    readonly attemptId: string;
    readonly step: string;
    readonly executable: string;
    readonly agent: string | null;
    readonly model: string | null;
    readonly account: string | null;
    readonly via: 'direct' | 'provider-batch';
    readonly retry: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
    readonly durationMs: number;
    readonly status: 'ok' | 'error';
    readonly error: string | null;
  }

  export interface CheckpointRecord extends RecordBase {
    readonly type: 'checkpoint';
    readonly attemptId: string;
    readonly path: readonly string[];
    readonly value: Json;
    readonly blocker: string | null;
  }

  export interface TriggerRecord extends RecordBase {
    readonly type: 'trigger';
    readonly trigger: string;
    readonly sourceId: string;
    readonly consequence: 'add' | 'transition' | 'record';
    readonly resultId: string | null;
  }

  export interface RecallRecord extends RecordBase {
    readonly type: 'recall';
    readonly attemptId: string;
    readonly invocationId: string;
    readonly journal: string;
    readonly itemIds: readonly string[];
  }

  export interface MemoryRecord extends RecordBase {
    readonly type: 'memory';
    readonly journal: string;
    readonly itemId: string;
    readonly change: 'created' | 'accepted' | 'merged' | 'dropped' | 'edited';
    readonly actor: Actor;
  }

  export interface OperationRecord extends RecordBase {
    readonly type: 'operation';
    readonly operation: string;
    readonly actor: Actor;
    readonly input: Json;
    readonly ok: boolean;
  }

  export interface ShareRecord extends RecordBase {
    readonly type: 'share';
    readonly account: string;
    readonly maxRatio: number;
  }

  export type LedgerRecord =
    | RunRecord
    | AttemptRecord
    | InvocationRecord
    | CheckpointRecord
    | TransitionEvent<unknown>
    | UpdateEvent<unknown>
    | OverdueEvent<unknown>
    | ResolutionEvent<unknown, unknown>
    | TriggerRecord
    | RecallRecord
    | MemoryRecord
    | OperationRecord
    | ShareRecord;

  export interface LedgerQuery {
    readonly types?: readonly LedgerRecord['type'][];
    readonly since?: Date;
    readonly until?: Date;
    readonly lane?: string;
    readonly unitId?: string;
    readonly attemptId?: string;
  }

  export interface OpenAttempt {
    readonly attempt: AttemptView;
    readonly unit: UnitView<unknown>;
    readonly checkpoint: CheckpointRecord | null;
  }

  export interface QuotaWindow {
    readonly name: string;
    readonly utilization: number;
    readonly resetsAt: Date;
  }

  export interface QuotaReading {
    readonly windows: readonly QuotaWindow[];
    readonly coolingDownUntil: Date | null;
  }

  export interface QuotaState extends QuotaReading {
    readonly account: string;
    readonly observedAt: Date;
  }

  export interface QuotaUsage {
    readonly account: string;
    readonly harness: string;
    readonly at: Date;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
    readonly reading: QuotaReading | null;
  }

  export interface QuotaLedger {
    readonly name: string;
    quota(account: string): Promise<QuotaState>;
    recordUsage(usage: QuotaUsage): Promise<QuotaState>;
    setCooldown(account: string, until: Date | null): Promise<void>;
  }

  export interface Ledger extends QuotaLedger {
    open(): Promise<void>;
    close(): Promise<void>;
    append(records: readonly LedgerRecord[]): Promise<void>;
    read(query: LedgerQuery): AsyncIterable<LedgerRecord>;
    pending(): Promise<readonly PendingUnit[]>;
    openAttempts(): Promise<readonly OpenAttempt[]>;
  }

  export type SupplyEvent<T> =
    | { readonly key: string; readonly data: T; readonly state?: StateRef }
    | { readonly key: string; readonly patch: Partial<T>; readonly state?: StateRef };

  export interface SupplySink<T> {
    emit(event: SupplyEvent<T>): Promise<void>;
  }

  export interface SupplierContext {
    readonly lane: string;
    now(): Date;
    units(): Promise<readonly UnitView<unknown>[]>;
    resolve(value: EnvValue): string;
  }

  export interface Handle {
    stop(): Promise<void>;
  }

  export interface Supplier<T> {
    readonly name: string;
    start(sink: SupplySink<T>, ctx: SupplierContext): Promise<Handle>;
  }

  export interface StoredUnit<T> {
    readonly key: string;
    readonly data: T;
    readonly state: StateRef;
  }

  export interface Store<T> {
    readonly name: string;
    get(key: string): Promise<StoredUnit<T> | null>;
    put(key: string, data: T): Promise<void>;
    transition(key: string, to: StateRef): Promise<void>;
    list(): AsyncIterable<StoredUnit<T>>;
  }

  export interface ScopeNames {
    readonly kinds: readonly string[];
    readonly roles: readonly string[];
    readonly skills: readonly string[];
    readonly resources: readonly string[];
  }

  export interface MemoryItem<C> {
    readonly id: string;
    readonly kind: string;
    readonly content: C;
    readonly when: ScopeNames;
    readonly createdAt: Date;
    readonly status: 'candidate' | 'active' | 'merged' | 'dropped';
    readonly mergedInto: string | null;
  }

  export interface MemoryStore<C> {
    readonly name: string;
    list(): AsyncIterable<MemoryItem<C>>;
    put(item: MemoryItem<C>): Promise<void>;
    update(
      id: string,
      patch: Partial<Pick<MemoryItem<C>, 'content' | 'when' | 'status' | 'mergedInto'>>,
    ): Promise<void>;
    similar?(
      query: string,
      limit: number,
    ): Promise<readonly { readonly id: string; readonly similarity: number }[]>;
  }

  export type ToolIntent =
    | 'read-files'
    | 'edit-files'
    | 'run-commands'
    | 'search-web'
    | 'fetch-web'
    | 'record-memory'
    | 'halt-for-decision';

  export interface ExecOptions {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string>>;
    readonly timeoutMs: number;
    readonly stdin: string;
  }

  export interface ExecResult {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }

  export interface RunnerBackend {
    readonly name: string;
    exec(command: string, options: Partial<ExecOptions>): Promise<ExecResult>;
  }

  export interface PluginContext {
    readonly attemptId: string;
    readonly unit: UnitView<unknown>;
    readonly resources: readonly string[];
    workdir(): string | null;
    setWorkdir(path: string): void;
    exec(command: string, options?: Partial<ExecOptions>): Promise<ExecResult>;
  }

  export interface ToolCall {
    readonly intent: ToolIntent;
    readonly paths: readonly string[];
    readonly command: string | null;
  }

  export type HookDecision =
    | { readonly allow: true }
    | { readonly allow: false; readonly reason: string };

  export interface AgentPlugin {
    readonly name: string;
    beforeAttempt?(ctx: PluginContext): Promise<void>;
    beforeTool?(call: ToolCall, ctx: PluginContext): Promise<HookDecision>;
    beforeStop?(ctx: PluginContext): Promise<HookDecision>;
    afterAttempt?(ctx: PluginContext, status: AttemptStatus): Promise<void>;
  }

  export interface InvocationRequest {
    readonly modelId: string;
    readonly system: string;
    readonly prompt: string;
    readonly outputSchema: Json;
    readonly intents: readonly ToolIntent[];
    readonly memory: readonly MemoryItem<unknown>[];
    readonly plugins: readonly AgentPlugin[];
    readonly plugin: PluginContext;
  }

  export interface InvocationResult {
    readonly output: unknown;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costUsd: number;
    readonly haltReason: string | null;
  }

  export interface ModelDriver {
    readonly name: string;
    invoke(request: InvocationRequest): Promise<InvocationResult>;
    submitBatch?(requests: readonly InvocationRequest[]): Promise<readonly InvocationResult[]>;
    quota?(): Promise<QuotaReading | null>;
  }

  export interface OutcomeQuery {
    readonly lane?: string;
    readonly kind?: string;
    readonly model?: string;
    readonly agent?: string;
    readonly window: Window;
  }

  export interface OutcomeStats {
    readonly samples: number;
    readonly successRate: number | null;
    readonly byOutcome: Readonly<Record<TerminalOutcome, number>>;
    readonly byState: Readonly<Record<string, number>>;
    readonly meanSucceededCostUsd: number | null;
    readonly meanDurationMs: number | null;
  }

  export interface RateStats {
    readonly samples: number;
    readonly hits: number;
    readonly rate: number | null;
  }

  export interface SpendStats {
    readonly costUsd: number;
    readonly invocations: number;
  }

  export interface Metrics {
    outcomes(query: OutcomeQuery): OutcomeStats;
    rate(
      metric: { readonly name: string },
      query: { readonly key?: string; readonly window: Window },
    ): RateStats;
    spend(query: {
      readonly window: Window;
      readonly lane?: string;
      readonly unitId?: string;
    }): SpendStats;
  }

  export interface Policy<Ctx, Out> {
    readonly entity: 'policy';
    readonly name: string;
    decide(ctx: Ctx): Out;
  }

  export interface PendingUnit extends UnitView<unknown> {
    readonly enqueuedAt: Date;
    readonly deadline: Date | null;
  }

  export interface ActiveAttempt {
    readonly attempt: AttemptView;
    readonly unit: UnitView<unknown>;
  }

  export interface ScheduleContext {
    readonly pending: readonly PendingUnit[];
    readonly active: readonly ActiveAttempt[];
    readonly metrics: Metrics;
    readonly now: Date;
  }

  export interface ScheduleDecision {
    readonly start: readonly PendingUnit[];
    readonly preempt?: readonly ActiveAttempt[];
  }

  export interface Candidate {
    readonly name: string;
    readonly modelId: string | null;
    readonly quota: QuotaState | null;
    readonly share: { readonly maxRatio: number; readonly usedRatio: number } | null;
    readonly eligible: boolean;
  }

  export interface ChooseContext {
    readonly candidates: readonly Candidate[];
    readonly unit: UnitView<unknown> | null;
    readonly agent: string | null;
    readonly metrics: Metrics;
    readonly now: Date;
  }

  export interface RecallScope {
    readonly kind: string;
    readonly role: string;
    readonly skill: string;
    readonly resources: readonly string[];
    readonly query: string;
  }

  export interface RecallCandidate {
    readonly item: MemoryItem<unknown>;
    readonly journal: string;
    readonly specificity: number;
    readonly similarity: number | null;
    readonly trackRecord: { readonly injected: number; readonly succeeded: number };
    readonly tokens: number;
  }

  export interface RecallContext {
    readonly items: readonly RecallCandidate[];
    readonly scope: RecallScope;
    readonly metrics: Metrics;
  }

  export interface HarnessView {
    readonly harness: string;
    readonly lanes: readonly string[];
    readonly metrics: Metrics;
    units(lane?: string): Promise<readonly UnitView<unknown>[]>;
    openAttempts(): Promise<readonly OpenAttempt[]>;
  }

  export interface Observer {
    readonly name: string;
    observe(record: LedgerRecord, view: HarnessView): Promise<void>;
  }

  export interface OperationInfo {
    readonly name: string;
    readonly inputSchema: Json;
  }

  export interface ControlApi {
    readonly harness: string;
    operations(): readonly OperationInfo[];
    call(operation: string, input: Json, actor: string): Promise<Json>;
  }

  export interface Client {
    readonly name: string;
    serve(api: ControlApi): Promise<Handle>;
  }
}
