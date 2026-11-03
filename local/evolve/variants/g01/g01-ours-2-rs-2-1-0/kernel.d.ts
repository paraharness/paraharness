export type Duration = `${number}${'ms' | 's' | 'm' | 'h' | 'd' | 'w'}`;
export type Window = Duration | 'calendarDay' | 'calendarMonth';

export type Position = 'pending' | 'active' | 'waiting' | 'terminal';
export type Verdict = 'success' | 'failure' | 'neutral';
export type Outcome = 'succeeded' | 'failed' | 'cancelled';
export type Resolver = 'human' | 'policy' | 'clock';
export type BlockReason = 'decision' | 'stepFailure' | 'budget' | 'interrupted' | 'definitionChanged';
export type SuspendReason = 'job' | 'children';
export type Effect = 'repeatable' | 'unrepeatable' | 'external';
export type Intent = 'read' | 'edit' | 'shell' | 'web';
export type SupplyMode = 'upsert' | 'create' | 'update';
export type Column = 'kind' | 'lane' | 'state' | 'model' | 'seat' | 'account' | 'resource' | 'halt' | 'resolver' | 'job';

export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

export interface EnvRef {
  readonly ref: 'env';
  readonly name: string;
}
export interface SlotRef {
  readonly ref: 'slot';
  readonly slot: 'port';
  readonly index: number;
}
export type Setting = string | EnvRef | SlotRef;

export interface Stoppable {
  stop(): Promise<void>;
}

export interface UnitMeta {
  readonly key: string;
  readonly lane: string;
  readonly kind: string;
  readonly created: Date;
  readonly parent: string | undefined;
  readonly facets: Readonly<Record<string, string>>;
}
export interface UnitView<T> extends UnitMeta {
  readonly data: T;
  readonly state: string;
  readonly position: Position;
}
export interface Child<T> {
  readonly key: string;
  readonly data: T;
}
export interface ChildResult {
  readonly key: string;
  readonly state: string;
  readonly verdict: Verdict | undefined;
}

export type AttemptStatus =
  | { readonly status: 'running'; readonly step: string }
  | { readonly status: 'blocked'; readonly step: string; readonly reason: BlockReason; readonly halt: string | undefined; readonly detail: string }
  | { readonly status: 'suspended'; readonly step: string; readonly on: SuspendReason }
  | { readonly status: 'ended'; readonly outcome: Outcome };

export type TransitionCause = 'supplied' | 'exit' | 'retry' | 'exhausted' | 'bounded' | 'trigger' | 'operator' | 'order' | 'ceiling' | 'spawned';

export interface TransitionEvent<T> {
  readonly unit: UnitView<T>;
  readonly from: string | undefined;
  readonly to: string;
  readonly position: Position;
  readonly verdict: Verdict | undefined;
  readonly model: string | undefined;
  readonly seat: string | undefined;
  readonly cause: TransitionCause;
  readonly at: Date;
}
export interface AttemptEvent {
  readonly unit: UnitMeta;
  readonly attempt: string;
  readonly outcome: Outcome;
  readonly retry: number;
  readonly resumed: boolean;
  readonly model: string | undefined;
  readonly seat: string | undefined;
  readonly account: string | undefined;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly at: Date;
}
export interface StepEvent<O> {
  readonly unit: UnitMeta;
  readonly attempt: string;
  readonly address: string;
  readonly step: string;
  readonly outcome: 'completed' | 'failed';
  readonly output: O | undefined;
  readonly model: string | undefined;
  readonly seat: string | undefined;
  readonly durationMs: number;
  readonly at: Date;
}
export interface InvocationEvent {
  readonly unit: UnitMeta;
  readonly attempt: string;
  readonly seat: string;
  readonly model: string;
  readonly account: string;
  readonly costUsd: number;
  readonly batched: boolean;
  readonly error: boolean;
  readonly at: Date;
}
export interface HaltOpenEvent<C> {
  readonly unit: UnitMeta;
  readonly attempt: string;
  readonly halt: string;
  readonly address: string;
  readonly context: C;
  readonly openedAt: Date;
}
export interface DecisionEvent<C, D> extends HaltOpenEvent<C> {
  readonly decision: D;
  readonly resolver: Resolver;
  readonly client: string | undefined;
  readonly model: string | undefined;
  readonly seat: string | undefined;
  readonly waitedMs: number;
  readonly at: Date;
}
export interface CreditEvent<E> {
  readonly event: E;
  readonly attempt: string;
  readonly seat: string;
  readonly model: string;
  readonly credited: boolean;
  readonly at: Date;
}
export interface JobEvent {
  readonly unit: UnitMeta;
  readonly attempt: string;
  readonly job: string;
  readonly ref: string;
  readonly submittedAt: Date;
  readonly endedAt: Date | undefined;
  readonly hoursInFlight: number;
  readonly outcome: 'running' | 'done' | 'failed';
}
export interface LeaseEvent {
  readonly unit: UnitMeta;
  readonly resource: string;
  readonly mode: 'exclusive' | 'shared';
  readonly requestedAt: Date;
  readonly grantedAt: Date;
  readonly waitMs: number;
}
export interface PauseEvent {
  readonly lane: string;
  readonly reason: string;
  readonly value: number | undefined;
  readonly samples: number | undefined;
  readonly pausedAt: Date;
  readonly resumedAt: Date | undefined;
  readonly durationMs: number;
}
export interface UpdateEvent<T> {
  readonly unit: UnitView<T>;
  readonly previous: T;
  readonly deferred: boolean;
  readonly at: Date;
}
export interface TimeEvent {
  readonly at: Date;
}
export interface DeadlineEvent<T> {
  readonly unit: UnitView<T>;
  readonly deadline: Date;
}
export interface CrossingEvent<Key extends string> {
  readonly key: { readonly [P in Key]: string };
  readonly value: number;
  readonly samples: number;
  readonly direction: 'down' | 'up';
  readonly at: Date;
}
export interface StreakEvent<E> {
  readonly group: string;
  readonly events: readonly E[];
}

export type LedgerRecordType =
  | 'unit.supplied' | 'unit.updated' | 'unit.moved' | 'unit.moveDeferred'
  | 'attempt.started' | 'attempt.blocked' | 'attempt.suspended' | 'attempt.resumed' | 'attempt.ended'
  | 'step.started' | 'step.completed' | 'step.failed'
  | 'invocation'
  | 'halt.opened' | 'halt.resolved'
  | 'job.submitted' | 'job.polled' | 'job.collected'
  | 'lease.requested' | 'lease.granted' | 'lease.released'
  | 'timer.armed' | 'timer.superseded' | 'timer.fired'
  | 'trigger.fired' | 'policy.decided'
  | 'lane.paused' | 'lane.resumed'
  | 'memory.recorded' | 'memory.curated'
  | 'operation.called' | 'tag.recorded';

export interface NewRecord {
  readonly type: LedgerRecordType;
  readonly at: Date;
  readonly unit?: string;
  readonly lane?: string;
  readonly attempt?: string;
  readonly address?: string;
  readonly columns: Readonly<Partial<Record<Column, string>>>;
  readonly facets: Readonly<Record<string, string>>;
  readonly payload: Json;
}
export interface LedgerRecord extends NewRecord {
  readonly seq: number;
  readonly harness: string;
  readonly instance: string;
}
export interface LedgerQuery {
  readonly types?: readonly LedgerRecordType[];
  readonly unit?: string;
  readonly lane?: string;
  readonly attempt?: string;
  readonly since?: Date;
  readonly afterSeq?: number;
}
export interface WriterClaim {
  readonly harness: string;
  readonly instance: string;
  readonly staleAfterMs: number;
}
export interface WriterLease {
  readonly instance: string;
  readonly tookOverFrom: string | undefined;
  append(records: readonly NewRecord[]): Promise<readonly LedgerRecord[]>;
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}
export interface Ledger {
  readonly name: string;
  acquire(claim: WriterClaim): Promise<WriterLease>;
  read(query: LedgerQuery): AsyncIterable<LedgerRecord>;
}

export interface QuotaEvent {
  readonly account: string;
  readonly harness: string;
  readonly at: Date;
  readonly type: 'consumed' | 'limited' | 'cooldown';
  readonly tokens: number;
  readonly resetsAt: Date | undefined;
  readonly until: Date | undefined;
}
export interface QuotaState {
  readonly used: number;
  readonly limit: number | undefined;
  readonly resetsAt: Date | undefined;
  readonly coolingUntil: Date | undefined;
  readonly byHarness: Readonly<Record<string, number>>;
}
export interface QuotaPartition {
  readonly name: string;
  append(event: QuotaEvent): Promise<void>;
  fold(account: string, now: Date): Promise<QuotaState>;
}

export interface SupplySink<T> {
  offer(child: Child<T>): Promise<'created' | 'updated' | 'ignored'>;
}
export interface Supplier<T> {
  readonly name: string;
  readonly mode: SupplyMode;
  start(sink: SupplySink<T>): Promise<Stoppable>;
}

export interface StoredUnit<T> {
  readonly key: string;
  readonly state: string;
  readonly data: T;
}
export interface Store<T> {
  readonly name: string;
  load(key: string): Promise<StoredUnit<T> | undefined>;
  list(filter: { readonly states?: readonly string[] }): AsyncIterable<StoredUnit<T>>;
  save(unit: StoredUnit<T>): Promise<void>;
}

export interface Scope {
  readonly kinds?: readonly string[];
  readonly roles?: readonly string[];
  readonly skills?: readonly string[];
  readonly resources?: readonly string[];
  readonly facets?: readonly { readonly facet: string; readonly value: string }[];
}
export interface MemoryItem {
  readonly id: string;
  readonly kind: string;
  readonly created: Date;
  readonly status: 'candidate' | 'accepted';
  readonly content: Json;
  readonly when: Scope;
  readonly mergedFrom: readonly string[];
}
export interface ScoredItem {
  readonly item: MemoryItem;
  readonly similarity: number | undefined;
}
export interface MemoryStore {
  readonly name: string;
  put(item: MemoryItem): Promise<void>;
  remove(id: string): Promise<void>;
  search(query: { readonly kind: string; readonly scope: Scope; readonly text: string | undefined; readonly limit: number }): Promise<readonly ScoredItem[]>;
}

export interface Reading {
  readonly value: number | undefined;
  readonly samples: number;
  readonly window: Window;
}
export interface DimensionKey {
  readonly dimension: string;
  readonly value: string;
}
export interface MetricSpec {
  readonly name: string;
  readonly records: readonly LedgerRecordType[];
  readonly aggregate: 'rate' | 'mean' | 'median' | 'sum' | 'count';
  readonly project: (record: LedgerRecord) => number | undefined;
  readonly by: readonly string[];
  readonly window: Window;
}
export interface Metrics {
  read(spec: MetricSpec, at: readonly DimensionKey[], now: Date): Promise<Reading>;
}

export interface Candidate<T = unknown> {
  readonly lane: string;
  readonly kind: string;
  readonly key: string;
  readonly data: T;
  readonly queuedAt: Date;
  readonly attempts: number;
}
export interface ActiveUnit {
  readonly lane: string;
  readonly kind: string;
  readonly key: string;
  readonly startedAt: Date;
}
export interface AccountCandidate {
  readonly account: string;
  readonly maxQuotaShare: number;
  readonly quota: QuotaState;
}
export interface RecallCandidate {
  readonly item: MemoryItem;
  readonly specificity: number;
  readonly trackRecord: Reading;
  readonly similarity: number | undefined;
}
export interface CeilingContext {
  readonly unit: UnitMeta;
  readonly spentUsd: number;
  readonly maxUsd: number;
  readonly nextStep: string;
}
export type CeilingDecision =
  | { readonly action: 'raise'; readonly extraUsd: number }
  | { readonly action: 'stop' };

export type JobPoll<O> =
  | { readonly status: 'pending' }
  | { readonly status: 'done'; readonly output: O }
  | { readonly status: 'failed'; readonly reason: string };

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
}
export interface ModelRequest {
  readonly model: string;
  readonly system: string;
  readonly prompt: string;
  readonly tools: readonly string[];
  readonly session: string;
  readonly workspace: string | undefined;
  readonly budgetTokens: number | undefined;
  readonly maxOutputTokens: number | undefined;
}
export interface ModelResult {
  readonly text: string;
  readonly usage: Usage;
  readonly session: string;
  readonly quota: QuotaEvent | undefined;
}
export interface BatchDriver {
  submit(requests: readonly ModelRequest[]): Promise<string>;
  collect(ref: string): Promise<JobPoll<readonly ModelResult[]>>;
}
export interface AccountDriver {
  readonly name: string;
  readonly batch: BatchDriver | undefined;
  invoke(request: ModelRequest, signal: AbortSignal): Promise<ModelResult>;
  recover(session: string): Promise<ModelResult | 'running' | undefined>;
}
export interface ModelPricing {
  costUsd(model: string, usage: Usage, mode: 'interactive' | 'batch'): number;
}

export interface ExecOptions {
  readonly cwd?: string;
  readonly stdin?: string;
  readonly timeoutMs?: number;
}
export interface ExecResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}
export interface Runner {
  readonly name: string;
  readonly slots: number;
  exec(argv: readonly string[], options: ExecOptions, signal: AbortSignal): Promise<ExecResult>;
}

export interface OperationInfo {
  readonly name: string;
  readonly halt: string | undefined;
  readonly states: readonly string[];
  readonly input: Json;
}
export interface ControlApi {
  readonly harness: string;
  operations(client: string): readonly OperationInfo[];
  call(client: string, operation: string, args: Json): Promise<Json>;
}
export interface Client {
  readonly name: string;
  readonly transport: string;
  serve(api: ControlApi): Promise<Stoppable>;
}

export interface BoardUnit extends UnitView<unknown> {
  readonly enteredBy: TransitionCause;
  readonly wokenBy: readonly string[];
}
export interface BoardSnapshot {
  readonly units: readonly BoardUnit[];
  readonly attempts: readonly { readonly attempt: string; readonly unit: string; readonly status: AttemptStatus }[];
  readonly pausedLanes: readonly { readonly lane: string; readonly reason: string; readonly value: number | undefined }[];
}
export interface Observer {
  readonly name: string;
  observe(record: LedgerRecord, board: BoardSnapshot): Promise<void>;
}

export interface AttemptInfo {
  readonly attempt: string;
  readonly unit: UnitMeta;
  readonly resumed: boolean;
}
export interface Middleware {
  readonly name: string;
  around(attempt: AttemptInfo, next: (workspace: string | undefined) => Promise<void>): Promise<void>;
}
export interface LeaseTable {
  claim(resource: string, mode: 'exclusive' | 'shared', path: string): Promise<boolean>;
}
export interface AgentContext {
  readonly attempt: AttemptInfo;
  readonly workspace: string | undefined;
  readonly leases: LeaseTable;
}
export interface ToolCall {
  readonly tool: string;
  readonly intent: Intent;
  readonly paths: readonly string[];
}
export type PluginVerdict = { readonly allow: true } | { readonly allow: false; readonly reason: string };
export interface AgentPlugin {
  readonly name: string;
  readonly resources: readonly string[];
  beforeTool(call: ToolCall, ctx: AgentContext): Promise<PluginVerdict>;
  beforeStop(ctx: AgentContext): Promise<PluginVerdict>;
}
export interface StopCheckInput {
  readonly workspace: string;
}
export interface StopCheckResult {
  readonly ok: boolean;
  readonly report: string;
}
