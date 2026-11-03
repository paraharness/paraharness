declare module 'harness-dsl/kernel' {
  export type Outcome = 'pending' | 'active' | 'succeeded' | 'failed' | 'cancelled' | 'concluded';
  export type Terminal = 'succeeded' | 'failed' | 'cancelled' | 'concluded';
  export type AttemptState = 'running' | 'blocked' | 'yielded' | 'ended' | 'failed' | 'cancelled';
  export type Intent = 'read' | 'write' | 'execute' | 'browse' | 'halt' | 'record';

  export interface Ref<T> {
    readonly sort: 'env' | 'port';
    readonly name: string;
    readonly fallback?: T;
  }

  export interface Rate {
    readonly value: number;
    readonly samples: number;
  }

  export interface Mean {
    readonly value: number;
    readonly samples: number;
  }

  export interface UnitRef {
    readonly kind: string;
    readonly key: string;
  }

  export interface NewUnit<D> {
    readonly key: string;
    readonly data: D;
    readonly mode?: 'create' | 'upsert';
    readonly reopen?: boolean;
  }

  export interface UnitPatch<D> {
    readonly key: string;
    readonly mode: 'update';
    readonly patch: Partial<D>;
    readonly reopen?: boolean;
  }

  export type Supply<D> = NewUnit<D> | UnitPatch<D>;

  export interface UnitRecord {
    readonly kind: string;
    readonly key: string;
    readonly lane: string;
    readonly state: string;
    readonly outcome: Outcome;
    readonly data: unknown;
    readonly tags: readonly string[];
    readonly parent?: UnitRef;
    readonly notBefore?: string;
    readonly awaiting?: 'children' | 'update';
    readonly resumeStep?: string;
    readonly spentUsd: number;
    readonly createdAt: string;
    readonly updatedAt: string;
  }

  export interface Usage {
    readonly tokensIn: number;
    readonly tokensOut: number;
    readonly costUsd: number;
    readonly model?: string;
    readonly account?: string;
    readonly batch: boolean;
  }

  export type LedgerEvent =
    | { readonly type: 'unit.created'; readonly at: string; readonly unit: UnitRef; readonly state: string; readonly data: unknown; readonly source: string }
    | { readonly type: 'unit.updated'; readonly at: string; readonly unit: UnitRef; readonly data: unknown; readonly previous: unknown; readonly source: string }
    | { readonly type: 'transition'; readonly at: string; readonly unit: UnitRef; readonly from?: string; readonly to: string; readonly outcome: Outcome; readonly attempt?: string; readonly note?: string }
    | { readonly type: 'attempt.started'; readonly at: string; readonly attempt: string; readonly unit: UnitRef; readonly lane: string; readonly fromStep?: string; readonly cast: Readonly<Record<string, string>> }
    | { readonly type: 'attempt.ended'; readonly at: string; readonly attempt: string; readonly state: AttemptState; readonly mark?: string; readonly costUsd: number; readonly durationSeconds: number }
    | { readonly type: 'invocation'; readonly at: string; readonly attempt: string; readonly step: string; readonly number: number; readonly ok: boolean; readonly output?: unknown; readonly error?: string; readonly usage?: Usage }
    | { readonly type: 'halt.opened'; readonly at: string; readonly attempt: string; readonly step: string; readonly question: string }
    | { readonly type: 'halt.resolved'; readonly at: string; readonly attempt: string; readonly step: string; readonly decision: unknown; readonly by: string }
    | { readonly type: 'clock.due'; readonly at: string; readonly unit: UnitRef; readonly trigger: string; readonly dueAt: string }
    | { readonly type: 'trigger.fired'; readonly at: string; readonly trigger: string; readonly cause: number; readonly effects: readonly string[] }
    | { readonly type: 'operation'; readonly at: string; readonly operation: string; readonly client: string; readonly input: unknown }
    | { readonly type: 'memory'; readonly at: string; readonly journal: string; readonly item: string; readonly action: 'recorded' | 'accepted' | 'merged' | 'dropped' | 'recalled'; readonly attempt?: string }
    | { readonly type: 'policy'; readonly at: string; readonly policy: string; readonly decision: unknown };

  export type Sequenced = LedgerEvent & { readonly seq: number };

  export interface EventQuery {
    readonly types?: readonly LedgerEvent['type'][];
    readonly unit?: UnitRef;
    readonly kind?: string;
    readonly afterSeq?: number;
    readonly since?: string;
  }

  export interface LedgerReader {
    read(query: EventQuery): AsyncIterable<Sequenced>;
    unit(ref: UnitRef): Promise<UnitRecord | undefined>;
  }

  export interface UnitIndex {
    get(ref: UnitRef): Promise<UnitRecord | undefined>;
    put(record: UnitRecord): Promise<void>;
    pending(): Promise<readonly UnitRecord[]>;
    active(): Promise<readonly UnitRecord[]>;
  }

  export interface QuotaPrice {
    readonly inputUsdPerMTok: number;
    readonly outputUsdPerMTok: number;
  }

  export interface QuotaState {
    readonly account: string;
    readonly windowUsed: number;
    readonly windowResetsAt: string;
    readonly cooldownUntil?: string;
    readonly renewsAt?: string;
  }

  export interface QuotaView {
    readonly windowUsed: number;
    readonly windowResetsAt: Date;
    readonly cooldownUntil?: Date;
    readonly renewsAt?: Date;
    readonly shareCap: number;
    readonly shareUsed: number;
  }

  export interface QuotaBook {
    read(account: string): Promise<QuotaState>;
    charge(account: string, usage: Usage): Promise<QuotaState>;
    cooldown(account: string, untilIso: string): Promise<void>;
  }

  export interface ShareBook {
    get(account: string): Promise<number | undefined>;
    set(account: string, fraction: number): Promise<void>;
    used(account: string, windowStartIso: string): Promise<number>;
  }

  export interface Ledger extends LedgerReader {
    readonly name: string;
    append(events: readonly LedgerEvent[]): Promise<readonly number[]>;
    readonly units: UnitIndex;
    readonly quota: QuotaBook;
    readonly shares: ShareBook;
    lease(resource: string, holder: string, ttlSeconds: number): Promise<boolean>;
    release(resource: string, holder: string): Promise<void>;
  }

  export interface StoredUnit<D> {
    readonly key: string;
    readonly state: string;
    readonly data: D;
    readonly tags: readonly string[];
  }

  export interface StoreReader<D> {
    get(key: string): Promise<StoredUnit<D> | undefined>;
    list(query?: { readonly states?: readonly string[]; readonly tags?: readonly string[] }): Promise<readonly StoredUnit<D>[]>;
  }

  export interface Store<D> extends StoreReader<D> {
    readonly name: string;
    put(unit: StoredUnit<D>): Promise<void>;
  }

  export interface SupplierContext<D> {
    readonly signal: AbortSignal;
    readonly units: StoreReader<D>;
    emit(batch: readonly Supply<D>[]): Promise<void>;
    now(): Date;
    resolve<T>(ref: Ref<T>): T;
  }

  export interface Supplier<D> {
    readonly name: string;
    start(ctx: SupplierContext<D>): Promise<void>;
  }

  export interface Scope {
    readonly kinds?: readonly string[];
    readonly roles?: readonly string[];
    readonly skills?: readonly string[];
    readonly resources?: readonly string[];
    readonly tags?: readonly string[];
  }

  export interface MemoryContent {
    readonly do: string;
    readonly condition: string;
    readonly because: string;
  }

  export interface MemoryDraft extends MemoryContent {
    readonly when?: Scope;
    readonly status?: 'candidate' | 'active';
  }

  export interface MemoryItem extends MemoryContent {
    readonly id: string;
    readonly kind: string;
    readonly created: string;
    readonly when: Scope;
    readonly status: 'candidate' | 'active' | 'retired';
    readonly mergedInto?: string;
    readonly source: string;
  }

  export interface MemoryStore {
    readonly name: string;
    put(item: MemoryItem): Promise<void>;
    get(id: string): Promise<MemoryItem | undefined>;
    list(query: { readonly kinds?: readonly string[]; readonly status?: readonly MemoryItem['status'][] }): Promise<readonly MemoryItem[]>;
    remove(id: string): Promise<void>;
    nearest?(text: string, k: number, query?: { readonly kinds?: readonly string[] }): Promise<readonly { readonly item: MemoryItem; readonly score: number }[]>;
  }

  export interface RunnerExec {
    readonly exitCode: number;
    readonly stdout: string;
    readonly stderr: string;
  }

  export interface Runner {
    readonly name: string;
    readonly slots: number;
    exec(argv: readonly string[], options: { readonly env: Readonly<Record<string, string>>; readonly cwd?: string; readonly signal: AbortSignal; readonly timeoutSeconds?: number }): Promise<RunnerExec>;
    preflight?(signal: AbortSignal): Promise<{ readonly ok: boolean; readonly reason?: string }>;
  }

  export interface Account {
    readonly name: string;
    readonly sort: 'account';
    readonly quotaKey: string;
  }

  export interface WorkspaceHandle {
    readonly path: string;
    close(outcome: AttemptState): Promise<void>;
  }

  export interface Workspace {
    readonly name: string;
    open(attempt: string, unit: UnitRef): Promise<WorkspaceHandle>;
  }

  export interface AgentAction {
    readonly intent: Intent;
    readonly resources: readonly string[];
    readonly attempt: string;
  }

  export interface Guard {
    readonly name: string;
    before(action: AgentAction, ledger: Ledger): Promise<{ readonly allow: true } | { readonly allow: false; readonly reason: string }>;
  }

  export interface Invocation {
    readonly attempt: string;
    readonly step: string;
    readonly number: number;
    readonly unit: UnitRef;
    readonly signal: AbortSignal;
    readonly runner?: Runner;
    readonly ledger: LedgerReader;
    resolve<T>(ref: Ref<T>): T;
    record(journal: string, item: MemoryDraft): Promise<void>;
  }

  export interface Result<O> {
    readonly ok: boolean;
    readonly output?: O;
    readonly error?: string;
    readonly usage?: Usage;
    readonly halt?: { readonly question: string };
  }

  export interface Exec<O, S extends string> {
    readonly name: string;
    readonly sort: 'ask' | 'batch' | 'command' | 'projection' | 'message';
    readonly seats: readonly S[];
    invoke(input: unknown, invocation: Invocation): Promise<Result<O>>;
  }

  export interface RoleSpec {
    readonly name: string;
    readonly instructions: string;
    readonly intents: readonly Intent[];
  }

  export interface ModelRequest {
    readonly role: RoleSpec;
    readonly prompt: string;
    readonly memory: readonly MemoryItem[];
    readonly outputSchema: unknown;
    readonly budgetTokens?: number;
    readonly workspace?: WorkspaceHandle;
    readonly guards: readonly Guard[];
    readonly beforeStop?: Exec<unknown, never>;
    readonly account?: Account;
  }

  export interface Model {
    readonly name: string;
    readonly sort: 'model';
    readonly price: QuotaPrice;
    readonly accounts: readonly Account[];
    call(request: ModelRequest, invocation: Invocation): Promise<Result<unknown>>;
    batch?(requests: readonly ModelRequest[], invocation: Invocation): Promise<readonly Result<unknown>[]>;
  }

  export interface Policy<C, R> {
    readonly name: string;
    readonly decide: (ctx: C) => R;
  }

  export interface Metric {
    readonly name: string;
    readonly sort: 'metric';
  }

  export interface OperationRef {
    readonly name: string;
    readonly sort: 'operation';
  }

  export interface ControlApi {
    operations(client: string): readonly { readonly name: string; readonly inputSchema: unknown }[];
    invoke(operation: string, input: unknown, client: string): Promise<unknown>;
    events(afterSeq: number): AsyncIterable<Sequenced>;
  }

  export interface Client {
    readonly name: string;
    readonly grants: readonly OperationRef[];
    serve(api: ControlApi, resolve: <T>(ref: Ref<T>) => T): Promise<{ close(): Promise<void> }>;
  }
}
