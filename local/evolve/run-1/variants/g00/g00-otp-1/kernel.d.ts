export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

export type Outcome = 'pending' | 'active' | 'succeeded' | 'failed' | 'cancelled' | 'concluded';
export type TerminalOutcome = 'succeeded' | 'failed' | 'cancelled' | 'concluded';
export type AttemptStatus = 'running' | 'blocked' | 'exited' | 'crashed' | 'cancelled';

export interface UnitIdentity { readonly kind: string; readonly key: string }

export interface UnitRecord extends UnitIdentity {
  readonly id: string;
  readonly state: string;
  readonly outcome: Outcome;
  readonly labels: Readonly<Record<string, string>>;
  readonly parent?: UnitIdentity;
  readonly createdAt: Date;
  readonly attempts: number;
  readonly wantsAttempt: boolean;
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly costUsd: number;
  readonly batched: boolean;
}

export type LedgerEvent =
  | { readonly type: 'run.started'; readonly run: string; readonly harness: string; readonly at: Date }
  | { readonly type: 'run.stopped'; readonly run: string; readonly at: Date }
  | { readonly type: 'unit.created'; readonly unit: UnitIdentity; readonly state: string; readonly data: Json; readonly parent?: UnitIdentity; readonly supplier: string; readonly at: Date }
  | { readonly type: 'unit.transitioned'; readonly unit: UnitIdentity; readonly from: string; readonly to: string; readonly outcome: Outcome; readonly attempt?: string; readonly cause: string; readonly at: Date }
  | { readonly type: 'unit.labelled'; readonly unit: UnitIdentity; readonly labels: Readonly<Record<string, string>>; readonly at: Date }
  | { readonly type: 'message.received'; readonly unit: UnitIdentity; readonly message: string; readonly payload: Json; readonly at: Date }
  | { readonly type: 'attempt.started'; readonly attempt: string; readonly unit: UnitIdentity; readonly number: number; readonly flow: string; readonly run: string; readonly at: Date }
  | { readonly type: 'attempt.blocked'; readonly attempt: string; readonly step: string; readonly ask: string; readonly at: Date }
  | { readonly type: 'attempt.resumed'; readonly attempt: string; readonly step: string; readonly decision: Json; readonly by: string; readonly at: Date }
  | { readonly type: 'attempt.ended'; readonly attempt: string; readonly status: Exclude<AttemptStatus, 'running' | 'blocked'>; readonly exit: string; readonly at: Date }
  | { readonly type: 'step.started'; readonly attempt: string; readonly step: string; readonly round: number; readonly at: Date }
  | { readonly type: 'step.ended'; readonly attempt: string; readonly step: string; readonly round: number; readonly ok: boolean; readonly output: Json; readonly at: Date }
  | { readonly type: 'invocation'; readonly attempt: string; readonly step: string; readonly executable: string; readonly agent?: string; readonly model?: string; readonly account?: string; readonly runner?: string; readonly ok: boolean; readonly usage?: Usage; readonly durationMs: number; readonly at: Date }
  | { readonly type: 'policy.decided'; readonly policy: string; readonly input: Json; readonly output: Json; readonly at: Date }
  | { readonly type: 'trigger.fired'; readonly trigger: string; readonly source: Json; readonly consequences: readonly Json[]; readonly at: Date }
  | { readonly type: 'timer.elapsed'; readonly unit: UnitIdentity; readonly lane: string; readonly deadline: Date; readonly at: Date }
  | { readonly type: 'operation.performed'; readonly operation: string; readonly client: string; readonly input: Json; readonly at: Date }
  | { readonly type: 'lease.acquired'; readonly attempt: string; readonly resource: string; readonly key: string; readonly at: Date }
  | { readonly type: 'lease.released'; readonly attempt: string; readonly resource: string; readonly key: string; readonly at: Date };

export interface StoredEvent {
  readonly seq: number;
  readonly event: LedgerEvent;
}

export interface LedgerQuery {
  readonly afterSeq?: number;
  readonly types?: readonly LedgerEvent['type'][];
  readonly unit?: UnitIdentity;
  readonly attempt?: string;
  readonly since?: Date;
  readonly limit?: number;
}

export interface Child {
  readonly name: string;
  start(signal: AbortSignal): Promise<void>;
  stop(): Promise<void>;
  healthy(): Promise<boolean>;
}

export interface Ledger extends Child {
  append(events: readonly LedgerEvent[]): Promise<number>;
  read(query: LedgerQuery): AsyncIterable<StoredEvent>;
  follow(afterSeq: number, signal: AbortSignal): AsyncIterable<StoredEvent>;
  unit(identity: UnitIdentity): Promise<UnitRecord | undefined>;
  units(filter: { readonly kind?: string; readonly outcome?: readonly Outcome[]; readonly wantsAttempt?: boolean }): Promise<readonly UnitRecord[]>;
  openAttempts(): Promise<readonly { readonly attempt: string; readonly unit: UnitIdentity; readonly status: 'running' | 'blocked' }[]>;
  tryLease(attempt: string, resource: string, key: string): Promise<boolean>;
  releaseLeases(attempt: string): Promise<void>;
}

export interface AccountWindow {
  readonly account: string;
  readonly utilization: number;
  readonly resetsAt?: Date;
  readonly coolingDownUntil?: Date;
  readonly byHarness: Readonly<Record<string, number>>;
  readonly version: number;
}

export interface AccountState extends Child {
  read(account: string): Promise<AccountWindow>;
  reserve(account: string, harness: string, share: number, estimate: Usage): Promise<{ readonly granted: boolean; readonly window: AccountWindow }>;
  settle(account: string, harness: string, actual: Usage): Promise<AccountWindow>;
  coolDown(account: string, until: Date): Promise<AccountWindow>;
  watch(account: string, signal: AbortSignal): AsyncIterable<AccountWindow>;
}

export type Arrival =
  | { readonly type: 'create'; readonly data: Json }
  | { readonly type: 'deliver'; readonly key: string; readonly message: string; readonly payload: Json };

export interface SupplierContext {
  readonly lane: string;
  offer(arrival: Arrival): Promise<boolean>;
  demand(): number;
  units(filter: { readonly outcome?: readonly Outcome[] }): Promise<readonly (UnitRecord & { readonly data: Json })[]>;
  readonly now: () => Date;
}

export interface Supplier extends Child {
  attach(context: SupplierContext): void;
  pull?(demand: number): Promise<readonly Arrival[]>;
}

export interface Store extends Child {
  get(key: string): Promise<Json | undefined>;
  put(key: string, data: Json, state: string): Promise<void>;
  patch(key: string, change: Json): Promise<Json>;
  transition(key: string, from: string, to: string): Promise<void>;
  list(filter: { readonly states?: readonly string[] }): Promise<readonly { readonly key: string; readonly data: Json; readonly state: string }[]>;
}

export interface ScopeRecord {
  readonly kinds: readonly string[];
  readonly roles: readonly string[];
  readonly resources: readonly string[];
  readonly skills: readonly string[];
  readonly labels: Readonly<Record<string, string>>;
}

export interface MemoryItem {
  readonly id: string;
  readonly memoryKind: string;
  readonly nature: 'experience' | 'taste';
  readonly status: 'candidate' | 'accepted' | 'dropped';
  readonly created: Date;
  readonly when: ScopeRecord;
  readonly do: string;
  readonly condition: string;
  readonly because?: string;
  readonly mergedInto?: string;
  readonly source: { readonly type: 'agent' | 'flow' | 'trigger' | 'operation'; readonly ref: string };
}

export interface MemoryQuery {
  readonly memoryKind: string;
  readonly status: readonly MemoryItem['status'][];
  readonly within: ScopeRecord;
}

export interface MemoryStore extends Child {
  append(item: MemoryItem): Promise<void>;
  update(id: string, change: Partial<Pick<MemoryItem, 'status' | 'do' | 'condition' | 'because' | 'when' | 'mergedInto'>>): Promise<MemoryItem>;
  list(query: MemoryQuery): Promise<readonly MemoryItem[]>;
  similar?(query: MemoryQuery, text: string, limit: number): Promise<readonly { readonly item: MemoryItem; readonly score: number }[]>;
}

export interface Rate { readonly rate: number | null; readonly hits: number; readonly samples: number }
export interface Mean { readonly mean: number | null; readonly samples: number }

export interface MetricSlice {
  readonly kind?: string;
  readonly model?: string;
  readonly agent?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly since: Date;
}

export type SelectorRecord =
  | { readonly type: 'step'; readonly step: string; readonly ok?: boolean }
  | { readonly type: 'decision'; readonly halt: string; readonly where?: Readonly<Record<string, string | number | boolean>> }
  | { readonly type: 'enter'; readonly states: readonly string[] };

export interface Metrics {
  successRate(slice: MetricSlice & { readonly kind: string }): Rate;
  endedIn(slice: MetricSlice & { readonly kind: string; readonly states: readonly string[] }): Rate;
  meanCostUsd(slice: MetricSlice & { readonly kind: string; readonly outcome?: TerminalOutcome }): Mean;
  spentUsd(since: Date): number;
  active(kind: string, state?: string): number;
  ratio(count: SelectorRecord, of: SelectorRecord, slice: MetricSlice): Rate;
}

export interface MetricsIndex {
  rebuild(ledger: Ledger): Promise<void>;
  apply(event: StoredEvent): void;
  snapshot(): Metrics;
}

export interface PolicyEnv { readonly metrics: Metrics; readonly now: Date }
export interface Policy<In, Out> {
  readonly name: string;
  decide(input: In, env: PolicyEnv): Out;
}

export interface Workspace {
  readonly id: string;
  readonly cwd: string;
  readonly resources: readonly string[];
}

export interface ExecResult { readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly durationMs: number }

export interface Runner extends Child {
  readonly slots: number;
  acquire(attempt: string): Promise<Workspace>;
  exec(workspace: Workspace, argv: readonly string[], env: Readonly<Record<string, string>>, timeoutMs: number, signal: AbortSignal): Promise<ExecResult>;
  release(workspace: Workspace): Promise<void>;
}

export type Intent = 'read' | 'edit' | 'execute' | 'search' | 'browse' | 'halt';

export interface WriteNotice { readonly resource: string; readonly key: string }

export interface ModelRequest {
  readonly attempt: string;
  readonly model: string;
  readonly account: string;
  readonly system: string;
  readonly prompt: string;
  readonly memory: readonly MemoryItem[];
  readonly intents: readonly Intent[];
  readonly outputSchema?: Json;
  readonly workspace?: Workspace;
  readonly mayRecord: boolean;
}

export interface DriverHooks {
  beforeWrite(notice: WriteNotice): Promise<boolean>;
  beforeStop(): Promise<{ readonly allow: boolean; readonly feedback: string }>;
  halt(ask: string): Promise<Json>;
  record(draft: { readonly do: string; readonly condition: string; readonly because?: string }): Promise<void>;
}

export interface ModelResult {
  readonly output: Json;
  readonly usage: Usage;
  readonly accountSignal?: { readonly utilization?: number; readonly resetsAt?: Date; readonly coolDownUntil?: Date };
}

export interface ModelDriver {
  readonly name: string;
  readonly models: readonly string[];
  invoke(request: ModelRequest, hooks: DriverHooks, signal: AbortSignal): Promise<ModelResult>;
  submitBatch?(requests: readonly ModelRequest[]): Promise<string>;
  collectBatch?(batchId: string, signal: AbortSignal): Promise<readonly ModelResult[]>;
  price(model: string, usage: Omit<Usage, 'costUsd'>): number;
}

export interface Blocker {
  readonly attempt: string;
  readonly unit: UnitIdentity;
  readonly step: string;
  readonly ask: string;
  readonly decisionSchema: Json;
  readonly since: Date;
}

export interface ControlApi {
  readonly harness: string;
  readonly operations: readonly { readonly name: string; readonly inputSchema: Json }[];
  perform(operation: string, input: Json, client: string): Promise<Json>;
  blockers(): Promise<readonly Blocker[]>;
  events(afterSeq: number, signal: AbortSignal): AsyncIterable<StoredEvent>;
}

export interface Client extends Child {
  attach(api: ControlApi): void;
}

export interface ObserverView {
  unit(identity: UnitIdentity): Promise<UnitRecord | undefined>;
  units(filter: { readonly kind?: string; readonly outcome?: readonly Outcome[] }): Promise<readonly UnitRecord[]>;
  metrics(): Metrics;
}

export interface Observer extends Child {
  handle(event: StoredEvent, view: ObserverView): Promise<void>;
}

export interface Clock {
  now(): Date;
  at(when: Date, signal: AbortSignal): Promise<void>;
}

export interface RestartIntensity { readonly maxRestarts: number; readonly withinSeconds: number }

export interface SupervisorNode {
  readonly name: string;
  readonly strategy: 'one_for_one' | 'simple_one_for_one';
  readonly intensity: RestartIntensity;
  readonly children: readonly (Child | SupervisorNode)[];
}

export interface StartupProblem {
  readonly code:
    | 'duplicate-name'
    | 'state-not-in-kind'
    | 'exit-unmapped'
    | 'phase-unknown'
    | 'two-lanes-one-kind'
    | 'spawn-kind-without-lane'
    | 'trigger-lane-unregistered'
    | 'journal-without-store'
    | 'agent-without-model'
    | 'model-without-pool'
    | 'no-initial-pending-state'
    | 'operation-not-granted';
  readonly entity: string;
  readonly detail: string;
}

export interface Validator {
  validate(tree: SupervisorNode): readonly StartupProblem[];
}
