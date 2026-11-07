# Coding Guidelines

Every file in this repository must conform to these guidelines, enforced by `pnpm lint` (`eslint.config.mjs`), review, and verification gates. *(Outside **§2**, `/** ... */` JSDoc is omitted from snippets to isolate each rule; production and `test/fixtures/` files require full JSDoc per **§2**.)*

## 1. File & Module Taxonomy

### Rule 1.1 — Strict Single-Kind Entity Files & Universal Line Ceilings
- Unrelated or different-kind declarations (`interface`, `type`, `class`, `function`, `const`) must **never** share a production file (`src/**`, `test/fixtures/**`), enforced by `harness/file-separation` (Rules 1.2–1.7): **(1) `*.types.ts`** (pure `type` aliases); **(2) `*.schema.ts`** (sole cross-kind pairing: a Zod schema `const` and its `z.infer` `type`; `interface`, `class`, and `function` declarations are forbidden); **(3) `<entity-name>.ts`** (1 top-level `interface` + `TSPropertySignature` sub-interfaces); **(4) `<class-name>.ts`** (1 `class`); **(5) `create-*-builder.ts` / `<domain-verb>.ts` / `internal/<domain-verb>.ts`** (functions only: `<= 1` in `**/builders/*.ts`, `**/create-*.ts`, or `> 40` lines; `<= 4` in `internal/`); **(6) `*.constants.ts` & `index.ts`** (`const` values only in `*.constants.ts`; pure re-exports in `index.ts`).
- **Line ceilings & test/CLI scope:** Non-test files (`src/**`, `test/fixtures/**`, `scripts/**`, `.agents/hooks/**`, `eslint.config.mjs`) must be **`<= 250` lines**; test files (`test/**/*.test.ts`) must be **`<= 400` lines** and may co-locate local test constants and setup helpers with `describe`/`it` suites (reusable fakes live in `test/fixtures/**` per Rule 6.1). CLI/config files in `.agents/hooks/**`, `scripts/**`, and `eslint.config.mjs` (`<= 250` lines) may co-locate constants, documented functions, and entrypoint/config exports.
**DON'T (`src/runtime/runner.ts`):**
```ts
export const DEFAULT_TIMEOUT_MS = 5_000;
export interface RunnerOptions { readonly timeoutMs?: number; }
export type RunnerMode = 'local' | 'container';
export class LocalRunner { run(opts: RunnerOptions): void {} }
export function createLocalRunner(): LocalRunner { return new LocalRunner(); }
```
**DO (`runner.constants.ts`, `runner-options.ts`, `runner.types.ts`, `local-runner.ts`, `create-local-runner.ts`):**
```ts
import type { RunnerOptions } from './runner-options.js';
export class LocalRunner { run(opts: RunnerOptions): void {} }
```

### Rule 1.2 — One Top-Level `interface` Per File (`TSPropertySignature` Sub-Interfaces Only)
- Place each top-level `interface` in its own `kebab-case` file (`LessonsBuilder` $\to$ `lessons-builder.ts`, `CreateLessonsBuilderOptions` $\to$ `create-lessons-builder-options.ts`) without `.interface.ts`. Secondary interfaces may share a file **only if** reachable from the root via **`TSPropertySignature` property type annotations** (or `extends`). Interfaces referenced only in **`TSMethodSignature` parameter/return types** (`($d: LessonDistillationBuilder) => ...`), function `*Options` / `*Params`, and sibling AST/port interfaces must **live in their own file**. Never build god interfaces mixing unrelated concerns.
**DON'T (`src/builders/lessons-builder.ts`):**
```ts
export interface LessonDistillationBuilder { onLoopRecovery(enabled?: boolean): LessonDistillationBuilder; }
export interface LessonsBuilder<TIn = unknown> { distillWith(fn: ($d: LessonDistillationBuilder) => LessonDistillationBuilder): LessonsBuilder<TIn>; }
export interface CreateLessonsBuilderOptions<TIn> { readonly store?: LessonStoreASTNode; }
export function createLessonsBuilder<TIn = unknown>(id: string, opts?: CreateLessonsBuilderOptions<TIn>): LessonsBuilder<TIn> { throw new Error(id); }
```
**DO (`src/ast/topology-node.ts`):**
```ts
export interface TopologyCommitOverlayConfig<TOnSig = unknown> {
  readonly onSignal: { readonly signal: SignalNode<TOnSig>; readonly correlateBy: (payload: TOnSig) => string };
}
export interface TopologyNode<TPartition extends string = string> {
  readonly type: 'harness:topology';
  readonly id: string;
  readonly partitions: Readonly<Record<TPartition, { readonly dependsOn: readonly TPartition[] }>>;
  readonly commitOverlayWhen: TopologyCommitOverlayConfig | undefined;
}
```

### Rule 1.3 — One `class` Per File & Single-Responsibility Classes
- Place each `class` in its own `kebab-case` file (`ScopeLockManager` $\to$ `scope-lock-manager.ts`) with one stateful responsibility, importing constants from `*.constants.ts` and parameter/option interfaces from dedicated files. Never pack multiple classes into one file or mix unrelated state machines; extract stateless algorithms to `internal/` functions.
**DON'T (`src/runtime/managers.ts`):**
```ts
export class RuntimeGodManager {
  private readonly locks = new Map<string, string>();
  async acquireLock(key: string): Promise<void> {}
  async checkoutWarmContainer(poolId: string): Promise<unknown> { return undefined; }
}
export class FenceValidator { validate(token: number): boolean { return token > 0; } }
```
**DO (`src/runtime/locks/scope-lock-manager.ts`):**
```ts
export class ScopeLockManager {
  private readonly owners = new Map<string, string>();
  async acquireWriteLeases(keys: readonly string[], ownerId: string): Promise<readonly ScopeLease[]> {
    const leases: ScopeLease[] = [];
    for (const k of sortScopeKeysCanonical(keys)) {
      if (this.owners.has(k)) throw new Error(`Write lock contention on '${k}' for '${ownerId}'.`);
      this.owners.set(k, ownerId);
      leases.push({ scopeKey: k, ownerId, mode: 'write' });
    }
    return leases;
  }
}
```

### Rule 1.4 — Grouped `type` Aliases (`*.types.ts`) & Schema Type Co-Location (`*.schema.ts`)
- Pure `type` aliases (discriminated unions, primitive/template-literal/mapped/conditional types) live in `*.types.ts`; a `z.infer<typeof FooSchema>` type may pair with `FooSchema` in `*.schema.ts` per Rule 1.1(2). Never place `interface`, `class`, `const`, or `function` declarations in `*.types.ts`, or use `type Foo = { ... }` object-type literals to evade dedicated interface files.
**DON'T (`src/ast/step.types.ts`):**
```ts
export const STEP_VERSION = 1;
export type AgentNodeShape = { readonly type: 'harness:agent'; readonly id: string };
export type CoreStepASTNode = AgentNodeShape;
```
**DO (`src/ast/step-ast.types.ts`):**
```ts
import type { AgentNode } from './agent-node.js';
import type { LoopNode } from './loop-node.js';
export type CoreStepASTNode<TIn = unknown, TOut = unknown> = AgentNode<TIn, TOut> | LoopNode<TIn, TOut>;
export type CoreStepNodeType = CoreStepASTNode['type'];
```

### Rule 1.5 — Grouped Constants (`*.constants.ts`), Schemas (`*.schema.ts`) & Zero Magic Literals
- Place module-scope constants, protocol markers, default bounds, pre-compiled regexes, and frozen lookup tables in `*.constants.ts` (and Zod schemas with `z.infer` types in `*.schema.ts`). Never mix constants into interface, class, type, or function files, or scatter magic numbers (`65_536`, `5_000`, `0.25`) or wire strings (`'harness:fork-dispatched'`) inline in bodies.
**DON'T (`src/runtime/lane/compute-priority.ts`):**
```ts
export const DEFAULT_AGING_MS = 60_000;
export function computeEffectivePriority(level: string, waitedMs: number): number {
  const base = level === 'critical' ? 40 : level === 'high' ? 30 : level === 'normal' ? 20 : 10;
  return base + Math.floor(waitedMs / DEFAULT_AGING_MS) * 5;
}
```
**DO (`src/runtime/lane/lane-priority.constants.ts`):**
```ts
export const LANE_PRIORITY_WEIGHTS: Readonly<Record<LanePriorityLevel, number>> = Object.freeze({ low: 10, normal: 20, high: 30, critical: 40 });
export const DEFAULT_PRIORITY_AGING_INTERVAL_MS = 60_000;
export const PRIORITY_AGING_STEP_WEIGHT = 5;
```

### Rule 1.6 — Single-Function Builder/Large Function Files & Cohesive `internal/` Helpers
- Functions never share a file with interfaces, constants, types, or classes. Entity builder factories (`**/builders/*.ts`, `**/create-*.ts` outside `internal/`) and any file with a function `> 40` lines allow **at most 1 top-level function per file** (`createLessonsBuilder` $\to$ `create-lessons-builder.ts`). Cohesive helpers (`<= 40` lines each) may share a file (**up to 4 functions per file**), with non-public helpers under `internal/` (`src/builders/internal/assert-valid-max-turns.ts`).
**DON'T (`src/builders/agent.ts`):**
```ts
function assertValidMaxTurns(n: number): void { if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid: ${n}`); }
export function createAgentBuilder(id: string): unknown { assertValidMaxTurns(10); return { id }; }
```
**DO (`src/builders/create-agent-builder.ts`):**
```ts
import { AgentBuilderImpl } from './agent-builder-impl.js';
import { assertValidMaxTurns } from './internal/assert-valid-max-turns.js';
export function createAgentBuilder(id: string, defaultTurns = 25): AgentBuilder {
  assertValidMaxTurns(defaultTurns, id);
  return new AgentBuilderImpl(id, defaultTurns);
}
```

### Rule 1.7 — Pure Barrel Files (`index.ts`) & Strict Acyclic Import Graph (DAG)
- `index.ts` files contain **only** `export { ... } from '...'` and `export type { ... } from '...'` statements (zero declarations and zero wildcard `export *` re-exports). Module imports must form a strict DAG (`*.types.ts / interfaces / *.constants.ts` $\to$ `internal/` $\to$ `public classes & functions` $\to$ `index.ts`); leaf files import directly from sibling leaf files (`./agent-node.js`), never through `index.js`.
**DON'T (`src/index.ts`):**
```ts
import { createRuntime } from './runtime/index.js';
export const VERSION = '1.0.0';
export interface HarnessConfig { readonly strict: boolean; }
export function boot(): unknown { return createRuntime(); }
```
**DO (`src/index.ts`):**
```ts
export type { AgentNode } from './ast/agent-node.js';
export type { CoreStepASTNode, CoreStepNodeType } from './ast/step-ast.types.js';
export { createAgentBuilder } from './builders/create-agent-builder.js';
export { createRuntime } from './runtime/create-runtime.js';
```

### Rule 1.8 — 1:1 File & Identifier Naming Precision (Zero Grab-Bag Names)
- File names must match their primary exported entity in `kebab-case` (`ScopeLockManager` $\to$ `scope-lock-manager.ts`). Grab-bag file names (`utils.ts`, `helpers.ts`, `common.ts`, `shared.ts`, `misc.ts`, `core.ts`, `base.ts`, unprefixed `types.ts` / `constants.ts`) and vague identifiers (`data`, `info`, `item`, `val`, `temp`, `obj`, `res`, `ret`, `processData`, `handleItem`, `doWork`, `Manager`, `Helper`) are forbidden.
**DON'T (`src/runtime/utils.ts`):**
```ts
export function processData(data: readonly unknown[], flag: boolean): unknown[] {
  const res: unknown[] = [];
  for (const item of data) if (flag && item !== null) res.push(item);
  return res;
}
```
**DO (`src/runtime/prefix/internal/select-eligible-lessons.ts`):**
```ts
export function selectEligibleLessons(lessons: readonly LessonRecord[], minConfidence: number): LessonRecord[] {
  const eligible: LessonRecord[] = [];
  for (const l of lessons) if (!l.archived && l.confidence >= minConfidence) eligible.push(l);
  return eligible;
}
```

## 2. JSDoc Documentation & Comment Discipline

### Rule 2.1 — Mandatory JSDoc on Every Class, Interface, Method, Function, and Top-Level Type or Constant
Every `class` (and its constructor, methods, and properties), `interface` (and its properties and methods), `function` (public, `internal/`, and CLI hook/script functions), and top-level `type` alias or `const` in `src/**`, `test/fixtures/**`, `scripts/**`, `.agents/hooks/**`, and `eslint.config.mjs` requires a `/** ... */` JSDoc block immediately above its declaration (in `test/**/*.test.ts`, `describe`/`it` suites and local test helpers do not require §2 JSDoc).
**DON'T:**
```ts
export interface LeaseReceipt { readonly leaseId: string; readonly scopeKey: string; readonly fenceToken: number; }
export class FenceClock { private current = 0; nextToken(): number { this.current += 1; return this.current; } }
```
**DO (`src/runtime/locks/fence-clock.ts`):**
```ts
/**
 * Monotonic counter issuing strictly increasing fencing tokens.
 *
 * Guarantees every write lease receives a token greater than all prior tokens.
 *
 * @note
 * Initialize with the maximum persisted `fenceToken` on recovery.
 */
export class FenceClock {
  /** Highest fencing token issued so far. */
  private current = 0;
  /**
   * Increments the counter by one and returns the newly issued fencing token.
   *
   * Rejects allocation before overflow so tokens remain safe integers.
   *
   * @returns {number} Strictly positive fencing token greater than all prior tokens.
   *
   * @throws {RangeError} If incrementing would exceed `Number.MAX_SAFE_INTEGER`.
   */
  nextToken(): number {
    if (this.current >= Number.MAX_SAFE_INTEGER) throw new RangeError('FenceClock exhausted MAX_SAFE_INTEGER.');
    this.current += 1;
    return this.current;
  }
}
```

### Rule 2.2 — JSDoc Anatomy, Tag Completeness & Vertical Alignment
**Every `class`, top-level `interface`, `function`, class method (`MethodDefinition`), and interface method (`TSMethodSignature`) requires the 3-part JSDoc anatomy below** (only properties, top-level constants, and simple type aliases may use a 1-sentence `/** Summary. */` unless invariants or `@template` tags require detail; 1-line stub JSDocs on interface methods are rejected by `harness/require-complete-jsdoc`):
1. **Summary line:** One direct sentence stating what the entity is or does.
2. **Detailed description:** Separated by an empty `*` line; explains behavioral invariants, state transitions, edge cases, or concurrency guarantees.
3. **Grouped, vertically aligned block tags** separated by empty `*` lines: `@template TName Description` (aligned when $\ge 2$), `@param {Type} name - Description` (`[name=default]` when optional, matching parameter count and aligned when $\ge 2$), `@returns {Type} Description` (mandatory for non-`void` callables), `@throws {ErrorType} Description`, and `@note` / `@example` when applicable.
**DON'T:**
```ts
/** Fluent configurator for contrastive lesson distillation. */
export interface LessonDistillationBuilder {
  /** Enables contrastive distillation on outer `H.loop` recovery iterations. */
  onLoopRecovery(enabled?: boolean): LessonDistillationBuilder;
}
/**
 * Executes a step node.
 * @param node the node
 * @param input step input
 */
export async function executeStepNode<TIn, TOut>(node: StepASTNode<TIn, TOut>, input: TIn): Promise<TOut> { throw new Error('Not implemented'); }
```
**DO:**
```ts
/**
 * Fluent configurator for contrastive lesson distillation (`$d` in `.distillWith`).
 *
 * Captures trigger conditions used when distilling failure-to-pass trajectory pairs into `LessonStore`.
 */
export interface LessonDistillationBuilder {
  /**
   * Toggles contrastive distillation when an outer `H.loop` recovers after a failed check.
   *
   * Pairs the latest failing trajectory with the passing trajectory for distillation.
   *
   * @param {boolean} [enabled=true] - Whether outer loop recovery distillation is active.
   *
   * @returns {LessonDistillationBuilder} Updated immutable builder instance.
   */
  onLoopRecovery(enabled?: boolean): LessonDistillationBuilder;
}
/**
 * Dispatches a passive step AST node to its registered runtime executor.
 *
 * Built-in steps narrow via `switch (node.type)`; adapter steps dispatch via `ctx.registry.steps`.
 *
 * @template TIn     Step input payload type.
 * @template TOut    Step output payload type.
 * @template THandle Isolation scope handle type.
 *
 * @param {StepASTNode<TIn, TOut, THandle>} node  - Passive step AST node to execute.
 * @param {TIn}                             input - Input payload for the step.
 * @param {StepExecutionContext<THandle>}   ctx   - Active step execution context.
 *
 * @returns {Promise<TOut>} Validated step output payload.
 *
 * @throws {ZodError} If `input` fails `node.inputSchema` or output fails `node.outputSchema`.
 *
 * @note
 * Callers must hold at least a shared read lease on the active scope.
 *
 * @example
 * ```ts
 * const out = await executeStepNode(agentNode, { issueId: 42 }, stepCtx);
 * ```
 */
export async function executeStepNode<TIn = unknown, TOut = unknown, THandle = unknown>(node: StepASTNode<TIn, TOut, THandle>, input: TIn, ctx: StepExecutionContext<THandle>): Promise<TOut> { throw new Error(ctx.runId); }
```

### Rule 2.3 — JSDoc Prose Quality (Grounded & Direct — No Vague Stubs, No Robotic Walls of Text)
- Write direct engineering English: **no tautological stubs** repeating identifier words (`/** Validates fence token. */`), and **no robotic walls of text** with LLM throat-clearing (*"This function is responsible for..."*) or repeated sentences across summary, description, and `@returns`.
**DON'T:**
```ts
/**
 * Validates fence token.
 * @param {number} token - The token.
 */
export function assertFreshFenceTokenStub(token: number): void {}
/**
 * This function is responsible for ensuring that a given fencing token is valid.
 * @param {number} fenceToken - This parameter represents the fence token.
 */
export function assertFreshFenceTokenVerbose(fenceToken: number): void {}
```
**DO:**
```ts
/**
 * Rejects state mutations carrying a fencing token older than the resource's high-water mark.
 *
 * Compares `fenceToken` against `highWaterMark` and throws on stale tokens.
 *
 * @param {number} fenceToken    - Active lease fencing token.
 * @param {number} highWaterMark - Highest token committed to `resourceId`.
 * @param {string} resourceId    - Guarded store or partition identifier.
 *
 * @throws {StaleFenceTokenError} If `fenceToken < highWaterMark`.
 */
export function assertFreshFenceToken(fenceToken: number, highWaterMark: number, resourceId: string): void {
  if (fenceToken < highWaterMark) throw new StaleFenceTokenError(resourceId, fenceToken, highWaterMark);
}
```

### Rule 2.4 — Zero Inline or Non-JSDoc Comments Anywhere
- Single-line comments (`// ...`) and non-JSDoc block comments (`/* ... */`) are forbidden in all files, and **zero comments of any kind (`//`, `/* */`, `/** */`) may appear inside a function, method, or constructor body**. Extract complex blocks into named `internal/` helpers with declaration JSDoc.
**DON'T:**
```ts
export async function settleTournament(s: TournamentState): Promise<WinnerResult> {
  // Case 1: 0 completed and 1 parked -> unpark directly
  if (s.completed.length === 0 && s.parked.length === 1) return unparkCandidate(s, s.parked[0]);
  // Case 2: 1 completed, 0 parked, no prior rulings -> short-circuit arbiter
  if (s.completed.length === 1 && s.parked.length === 0 && s.rulings.length === 0) return verifySoleSurvivor(s, s.completed[0]);
  return runArbiterTurn(s);
}
```
**DO:**
```ts
/** Resolves a completed speculative tournament race into a winning branch or unpark continuation (full JSDoc per §2). */
export async function settleTournament(s: TournamentState): Promise<WinnerResult> {
  if (shouldUnparkSoleEscalatedCandidate(s)) return unparkSoleEscalatedCandidate(s);
  if (canShortCircuitArbiterForSoleSurvivor(s)) return verifySoleSurvivor(s);
  return runArbiterTurn(s);
}
```

## 3. Clean Code, KISS, Single Responsibility & Control Flow

### Rule 3.1 — Single Responsibility & Natural Function Decomposition (`<= 80` Lines, Zero Closure State Machines)
- Each function and class method must do **one thing** at one level of abstraction and stay under **80 lines**. Never write closure state machines mutating outer `let` variables from inner closures; define an explicit state interface in its own file and decompose along real domain phases (`compileTurnPrefix`, `invokeModelTurn`, `dispatchToolCalls`) in `internal/`.
**DON'T:**
```ts
export async function executeAgent(node: AgentNode, input: unknown, ctx: StepExecutionContext): Promise<unknown> {
  let turn = 0;
  let history: WireFrameRecord[] = [];
  const runTools = async (calls: readonly ToolCall[]): Promise<void> => { for (const c of calls) history.push(await runSingleTool(c)); };
  while (turn < node.maxTurns) {
    turn += 1;
    const res = await invokeDriver(node, history, ctx);
    if (res.toolCalls.length > 0) await runTools(res.toolCalls);
  }
  return undefined;
}
```
**DO:**
```ts
export async function executeAgent<TIn = unknown, TOut = unknown, THandle = unknown>(node: AgentNode<TIn, TOut, THandle>, input: TIn, ctx: StepExecutionContext<THandle>): Promise<TOut> {
  const s = await createAgentTurnSession(node, input, ctx);
  try { return await runAgentTurnLoop(s); } finally { await releaseAgentTurnSession(s); }
}
```

### Rule 3.2 — Guard Clauses & Flat Control Flow (Maximum Nesting Depth 3)
- Validate preconditions, null/undefined checks, and early-exit cases at the top of the function using guard clauses (`if (!isValid) return ...;`). Never wrap the main body in deep `if / else if / else` pyramids, or nest control structures deeper than **3 levels**.
**DON'T:**
```ts
export function resolveInterrupt(h: InterruptHandlerNode | undefined, sig: InterruptSignal): Resolution {
  if (h !== undefined) {
    if (h.mode === 'replace') {
      if (h.abortHook !== undefined) return runAbortHookAndReplace(h, sig);
      else return restoreCheckpointAndReplace(h, sig);
    } else return adjudicateInterrupt(h, sig);
  } else throw sig;
}
```
**DO:**
```ts
export function resolveInterrupt(h: InterruptHandlerNode | undefined, sig: InterruptSignal): Resolution {
  if (h === undefined) throw sig;
  if (h.mode !== 'replace') return adjudicateInterrupt(h, sig);
  if (h.abortHook !== undefined) return runAbortHookAndReplace(h, sig);
  return restoreCheckpointAndReplace(h, sig);
}
```

### Rule 3.3 — Named Parameter Objects Over Long Positional Parameter Lists (`> 3` Parameters)
- Functions, methods, and constructors requiring **more than 3 parameters** must accept a single typed parameter interface (defined in its own interface file, such as `dispatch-fork-child-params.ts`, or as a `TSPropertySignature` sub-interface of its port per Rule 1.2). Never pass positional boolean flags.
**DON'T:**
```ts
export async function dispatchForkChild(runId: string, node: StepASTNode, input: unknown, isolate: boolean, inherit: boolean, timeoutMs?: number): Promise<ForkChildResult> {
  return executeChild(runId, node, input, isolate, inherit, timeoutMs);
}
```
**DO (`src/runtime/fork/dispatch-fork-child.ts`):**
```ts
export function dispatchForkChild(p: DispatchForkChildParams): Promise<ForkChildResult> {
  p.signal?.throwIfAborted();
  return executeIsolatedForkBranch(p);
}
```

### Rule 3.4 — KISS: Zero Speculative Abstractions, Single-Caller Wrappers, or Unrequested Options
- Write the simplest direct implementation satisfying `docs/SPEC.md`. Never introduce an abstract base class with one subclass, a strategy pattern with one strategy, a pass-through wrapper, or unrequested config flags (decomposing complex functions or branches into single-caller `internal/` phase/predicate helpers per Rules 1.3, 2.4, and 3.1 is required and compliant).
**DON'T:**
```ts
export abstract class AbstractDigestStrategy { abstract compute(s: string): string; }
export class Sha256DigestStrategy extends AbstractDigestStrategy {
  override compute(s: string): string { return createHash('sha256').update(s).digest('hex'); }
}
export function computeDigestWithStrategy(s: string, st: AbstractDigestStrategy = new Sha256DigestStrategy()): string { return st.compute(s); }
```
**DO:**
```ts
import { createHash } from 'node:crypto';
export function computeSha256Hex(s: string): string { return createHash('sha256').update(s, 'utf8').digest('hex'); }
```

### Rule 3.5 — Library-First Mandate (Zero Hand-Rolled Commodity Utilities)
- Choose an Owner-approved library over hand-rolled commodity infrastructure (`CLAUDE.MD` #2). Hand-rolling commodity parsers, graph traversals, diffs, search indices, queues, globs, atomic writes, process-tree killers, port probers, or vendor HTTP wire clients is a Defect Gate violation:
  - **`@harness-dsl/lockfile`**: `p-queue` (`concurrency: 1` per-path serialization) + atomic `open(lockPath, 'wx')`, `.unref()`ed `utimes` heartbeat, and dead-PID / stale-`mtime` reclamation.
  - **`@harness-dsl/core`**: `zod` v4 (`z.toJSONSchema()` for `zodToJsonSchema`), `@dagrejs/graphlib` (`Graph`, `alg.findCycles`, `alg.preorder` for topology/prerequisite DAGs), `diff` (`createTwoFilesPatch` for grounding diffs), `p-queue` (`concurrency: 1` for `StepContinuationQueue` & `ScopeLockManager`), `p-limit` (bounded fork/speculate concurrency).
  - **`@harness-dsl/sqlite` & `@harness-dsl/postgres`**: `better-sqlite3` (`sqlite`), `pg` (`Pool` in `postgres` + `@electric-sql/pglite` in tests), `@dagrejs/graphlib`, `node-diff3` (`diff3Merge` for 3-way contract overlay merges), `minisearch` (BM25 lesson recall), `p-queue`.
  - **`@harness-dsl/fs`**: `@harness-dsl/lockfile` (`withFileLock`), `tinyglobby` (globbing), `picomatch` (pre-compiled path matchers), `write-file-atomic` (atomic writes), `minisearch` (BM25 JSONL lesson recall), `p-queue`.
  - **`@harness-dsl/markdown`**: `mdast-util-from-markdown`, `mdast-util-to-markdown`, `mdast-util-frontmatter`, `micromark-extension-frontmatter`, `yaml` (frontmatter YAML), `tinyglobby`, `picomatch`.
  - **`@harness-dsl/node`**: `node-pty` (PTY daemons), `@modelcontextprotocol/sdk` (MCP stdio/SSE control-plane), `pidtree` + `fkill` (process-tree teardown), `get-port` (ephemeral ports), `wait-on` (TCP readiness), `p-queue`, `p-limit`.
  - **`@harness-dsl/git`**: `@harness-dsl/lockfile` (`withFileLock`), `es-module-lexer` (`publicSurfaceCrossTester` export extraction), `write-file-atomic` (`harness-meta.json`), `picomatch`, `p-queue`.
  - **`@harness-dsl/claude`, `@harness-dsl/openai`, `@harness-dsl/gemini`**: `@anthropic-ai/sdk`, `openai`, `@google/genai`.
  - **`@harness-dsl/github`, `@harness-dsl/slack`, `@harness-dsl/stripe`, `@harness-dsl/netsuite`**: `@octokit/rest` + `@octokit/webhooks`, `@slack/web-api` + `@slack/socket-mode` + `@slack/webhook`, `stripe`, `big.js` (exact decimal math).

## 4. Library-Grade Runtime Performance

### Rule 4.1 — Zero-Allocation Loops Over Spreads & Chained Array Combinators
- Never write spread accumulations (`arr = [...arr, item]`, `obj = { ...obj, [k]: v }`) inside a loop ($O(N^2)$ copies/GC churn), or chain `.filter().map().flatMap().reduce()` in runtime paths; use a single `for (const x of list)` loop mutating local collections in-place and call `Object.freeze` **once** at the return boundary (such as `.toAST()`).
**DON'T:**
```ts
export function collectUnlockedToolNames(frames: readonly WireFrameRecord[], skills: readonly SkillNode[], enabledIds: ReadonlySet<string>): readonly string[] {
  let history: readonly WireFrameRecord[] = [];
  for (const f of frames) history = Object.freeze([...history, f]);
  return skills.filter((s) => enabledIds.has(s.id)).flatMap((s) => s.tools).map((t) => t.name);
}
```
**DO:**
```ts
export function collectUnlockedToolNames(skills: readonly SkillNode[], enabledIds: ReadonlySet<string>): readonly string[] {
  const names: string[] = [];
  for (const s of skills) if (enabledIds.has(s.id)) for (const t of s.tools) names.push(t.name);
  return Object.freeze(names);
}
```

### Rule 4.2 — $O(1)$ Pre-Indexed `Map` / `Set` Lookups Over Repeated Linear Scans
- Never call `.find()`, `.some()`, `.includes()`, or `.indexOf()` inside per-turn, per-tool-call, per-frame, or per-item loops; pre-index into `Map<string, T>` or `Set<string>` once at initialization for $O(1)$ lookup. Use `Map`/`Set` for dynamic collections instead of `Record<string, T>` with `delete obj[key]`, and never call `Object.keys()` / `Object.entries()` on dynamic collections or in hot loops (cold diagnostics and one-time static `Readonly<Record<...>>` init are permitted).
**DON'T:**
```ts
export async function dispatchToolBatch(calls: readonly ModelToolCall[], tools: readonly ToolASTNode[], allowed: readonly string[]): Promise<ToolResult[]> {
  const out: ToolResult[] = [];
  for (const c of calls) {
    if (!allowed.includes(c.name)) throw new Error(`Locked: ${c.name}`);
    const t = tools.find((x) => x.name === c.name);
    if (t === undefined) throw new Error(`Unknown: ${c.name}`);
    out.push(await invokeTool(t, c));
  }
  return out;
}
```
**DO:**
```ts
export async function dispatchToolBatch(calls: readonly ModelToolCall[], byName: ReadonlyMap<string, ToolASTNode>, allowed: ReadonlySet<string>): Promise<ToolResult[]> {
  const out: ToolResult[] = [];
  for (const c of calls) {
    if (!allowed.has(c.name)) throw new Error(`Locked: ${c.name}`);
    const t = byName.get(c.name);
    if (t === undefined) throw new Error(`Unknown: ${c.name}`);
    out.push(await invokeTool(t, c));
  }
  return out;
}
```

### Rule 4.3 — Monomorphic Object Shapes (Preserve V8 Hidden Classes & Inline Caches)
- Never construct AST nodes, wire frames, or runtime records using conditional property spreads (`{ id, ...(a !== undefined ? { a } : {}) }`), which create $2^k$ V8 hidden classes and megamorphic inline caches. Always initialize all properties in a single fixed, unconditional order, setting absent optional properties to `undefined`.
**DON'T:**
```ts
export function buildCommandNode<TIn, TOut, THandle>(id: string, fn: CommandFn<TIn, TOut, THandle>, inputSchema?: ZodType<TIn>, outputSchema?: ZodType<TOut>, extractPartitions?: (input: TIn) => readonly string[]): CommandNode<TIn, TOut, THandle> {
  return Object.freeze({ type: 'harness:command', id, fn, ...(inputSchema !== undefined ? { inputSchema } : {}), ...(outputSchema !== undefined ? { outputSchema } : {}), ...(extractPartitions !== undefined ? { extractPartitions } : {}) });
}
```
**DO:**
```ts
export function buildCommandNode<TIn = unknown, TOut = unknown, THandle = unknown>(p: BuildCommandNodeParams<TIn, TOut, THandle>): CommandNode<TIn, TOut, THandle> {
  return Object.freeze({ type: 'harness:command', id: p.id, fn: p.fn, inputSchema: p.inputSchema, outputSchema: p.outputSchema, extractPartitions: p.extractPartitions });
}
```

### Rule 4.4 — Compile & Serialize Once, Reuse Everywhere
- Pre-compile `picomatch` glob matchers and `RegExp` instances once when a guard (`fs:protect`), scoped rule, or skill trigger is registered—never inside per-file or per-tool-call loops. Never use `JSON.parse(JSON.stringify(value))` to clone or test deep equality, or re-serialize/re-hash immutable wire frames or checkpoints whose `sha256` digest is already computed.
**DON'T:**
```ts
export function isProtectedPath(path: string, globs: readonly string[], snap: Record<string, unknown>): boolean {
  const cloned = JSON.parse(JSON.stringify(snap)) as Record<string, unknown>;
  for (const g of globs) if (picomatch(g, { dot: true })(path) && cloned !== null) return true;
  return false;
}
```
**DO:**
```ts
import picomatch from 'picomatch';
export function compilePathGlobMatcher(globs: readonly string[]): (path: string) => boolean {
  if (globs.length === 0) return () => false;
  const matchers: Array<(input: string) => boolean> = [];
  for (const g of globs) matchers.push(picomatch(g, { dot: true }));
  return (path: string): boolean => { for (const m of matchers) if (m(path)) return true; return false; };
}
```

### Rule 4.5 — Zero Unnecessary `async` Microtasks & Per-Call Wrapper Closures
- Do not mark a function `async` unless it directly `await`s an async operation or satisfies an async port contract; return delegated Promises directly when no `try / catch / finally` is needed, and avoid per-call proxy closures around `StepExecutionContext`.
**DON'T:**
```ts
export async function computeSlotThreeDigest(frames: readonly WireFrameRecord[]): Promise<string> {
  const h = createHash('sha256');
  for (const f of frames) h.update(f.serializedJson);
  return h.digest('hex');
}
```
**DO:**
```ts
export function computeSlotThreeDigest(frames: readonly WireFrameRecord[]): string {
  const h = createHash('sha256');
  for (const f of frames) h.update(f.serializedJson, 'utf8');
  return h.digest('hex');
}
```

## 5. Type Rigor, Purity, Resource Lifecycle & Error Handling

### Rule 5.1 — Exhaustive Type Narrowing (Zero Unsound Casts, Type Erasures, or `!`)
- `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `: any`, `as any`, `as unknown as T`, and unguarded `!` non-null assertions are forbidden in `src/**` and `test/**`. Annotate every function and object-literal method parameter, pass the target interface type argument to generic wrappers (`Object.freeze<TargetInterface>({ ... })`, `deepFreeze<TargetInterface>({ ... })`), narrow discriminated unions via exhaustive `switch (node.type)` (`assertNever` default) or type predicates (`x is T`), and check indexed lookups for `undefined` under `noUncheckedIndexedAccess: true`.
**DON'T:**
```ts
export function getFirstBranchOutput<TOut>(branches: readonly BranchOutcome<TOut>[]): TOut {
  return (branches[0]!.payload as unknown as { readonly result: TOut }).result;
}
```
**DO:**
```ts
export function getFirstBranchOutput<TOut>(branches: readonly BranchOutcome<TOut>[], tournamentId: string): TOut {
  const leading = branches[0];
  if (leading === undefined) throw new Error(`Tournament '${tournamentId}' has 0 completed branches.`);
  return leading.output;
}
```

### Rule 5.2 — Zero Import-Time Side Effects & Symbolic `EnvRef` Resolution
- Importing any module (`src/**`, `test/fixtures/**`) must perform **zero I/O**, spawn zero subprocesses, open zero connections, and mutate zero global state (CLI scripts in `.agents/hooks/**` and `scripts/**` may execute their entrypoint per Rule 1.1). Builders and AST nodes must never read `.env` or `process.env[key]` at declaration time; represent secrets symbolically via `H.env('KEY')` (`EnvRef`) and resolve them exclusively inside leaf adapter execution.
**DON'T:**
```ts
const API_KEY = process.env['OPENAI_API_KEY'] ?? '';
const globalClient = new HttpPool(API_KEY);
export function createOpenAiDriver(model: string): ModelDriverNode { return { type: 'openai:driver', model, client: globalClient }; }
```
**DO (`src/internal/resolve-env-ref.ts`):**
```ts
export function resolveEnvRef(ref: EnvRef, env: Readonly<Record<string, string | undefined>>): string {
  const val = env[ref.key];
  if (val === undefined || val.length === 0) throw new Error(`Missing env '${ref.key}' referenced by H.env('${ref.key}').`);
  return val;
}
```

### Rule 5.3 — Deterministic `try / finally` Resource Lifecycle & `AbortSignal` Hygiene
- Release every acquired resource (read/write scope lease, `ScopeHandle`, warm-pool lease, `ServiceSession` daemon, subprocess, SQLite transaction, timer, file handle) and remove every `AbortSignal` listener (`signal.removeEventListener('abort', onAbort)`) inside `try / finally` so parent signals never leak closed-over buffers or child handles.
**DON'T:**
```ts
export async function runWithAbortAndLease<T>(p: RunWithAbortAndLeaseParams<T>): Promise<T> {
  const leases = await p.lockManager.acquireWriteLeases([p.scopeKey], p.ownerId);
  const abort = new Promise<never>((_, rej) => { p.signal.addEventListener('abort', () => rej(new Error('Aborted')), { once: true }); });
  const res = await Promise.race([p.work(), abort]);
  await p.lockManager.releaseLeases(leases);
  return res;
}
```
**DO:**
```ts
export async function runWithAbortAndLease<T>(p: RunWithAbortAndLeaseParams<T>): Promise<T> {
  p.signal.throwIfAborted();
  const leases = await p.lockManager.acquireWriteLeases([p.scopeKey], p.ownerId);
  let onAbort: (() => void) | undefined;
  try {
    const abort = new Promise<never>((_, rej) => {
      onAbort = (): void => rej(new Error(`Aborted on '${p.scopeKey}'.`));
      p.signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([p.work(), abort]);
  } finally {
    if (onAbort !== undefined) p.signal.removeEventListener('abort', onAbort);
    await p.lockManager.releaseLeases(leases);
  }
}
```

### Rule 5.4 — Actionable Domain Errors & Zero Silent Fallbacks
- Every thrown `Error` must state: (1) **which subsystem/operation** failed, (2) **which entity identifier** (`runId`, `stepExecId`, `node.type`, `node.id`, `scopeKey`) was involved, and (3) **why** it failed. Never swallow exceptions (`catch {}`) or return fabricated fallbacks when a required executor, driver, tool, or schema validation fails.
**DON'T:**
```ts
export async function executeExternalStep(n: StepASTNode, input: unknown, ctx: StepExecutionContext): Promise<unknown> {
  try { return (await ctx.registry.steps[n.type]?.execute(n, input, ctx)) ?? { status: 'skipped' }; } catch { return null; }
}
```
**DO:**
```ts
export async function executeExternalStep<TIn = unknown, TOut = unknown, THandle = unknown>(n: StepASTNode<TIn, TOut, THandle>, input: TIn, ctx: StepExecutionContext<THandle>): Promise<TOut> {
  const exec = ctx.registry.steps[n.type];
  if (exec === undefined) throw new Error(`No StepExecutor for '${n.type}' (id '${n.id}', runId '${ctx.runId}').`);
  return n.outputSchema.parse(await exec.execute(n, input, ctx));
}
```

## 6. Testing Standards & Anti-Smell Discipline

### Rule 6.1 — Focused Per-Subsystem Test Files & Shared `test/fixtures/`
- Organize tests by subsystem (`test/scope-lock-manager.test.ts`, `test/prefix-compiler.test.ts`), keeping each test file `<= 400` lines. Extract reusable fakes into `test/fixtures/` (`<= 250` lines per file), obeying the exact same taxonomy and JSDoc rules as `src/**` (1 class/interface per file, mandatory JSDoc per **§2**, zero inline comments).
**DON'T (`test/everything.test.ts`):**
```ts
describe('runtime', () => {
  it('test 1', async () => {
    class InlineFakeDriver { async invoke() { return { text: 'ok' }; } }
    expect(new InlineFakeDriver()).toBeDefined();
  });
});
```
**DO (`test/fixtures/scripted-model-driver.ts`):**
```ts
export class ScriptedModelDriver implements ModelDriver {
  private readonly queue: ModelTurnResponse[];
  constructor(res: readonly ModelTurnResponse[]) { this.queue = [...res]; }
  async invokeTurn(_req: ModelTurnRequest): Promise<ModelTurnResponse> {
    const next = this.queue.shift();
    if (next === undefined) throw new Error('ScriptedModelDriver queue exhausted.');
    return next;
  }
}
```

### Rule 6.2 — Real Local Resources & Deterministic Synchronization (Zero `setTimeout` Sleeps)
- Test adapters against **real local resources** (SQLite DBs, temp dirs/files, Git repos, Node child processes), mocking only external network HTTP transports. Never coordinate concurrent tests with `setTimeout` sleeps; use deterministic deferred promises / barrier latches, and clean up temp dirs, DBs, and child processes in `afterEach` or `try / finally`.
**DON'T:**
```ts
it('queues second writer', async () => {
  const order: string[] = [];
  void locks.withWriteLock('a', async () => { await new Promise((r) => setTimeout(r, 100)); order.push('1'); });
  await new Promise((r) => setTimeout(r, 20));
  await locks.withWriteLock('a', async () => { order.push('2'); });
  expect(order).toEqual(['1', '2']);
});
```
**DO:**
```ts
it('queues second writer until first releases lease', async () => {
  const locks = new ScopeLockManager();
  const order: string[] = [];
  const held = createDeferred<void>();
  const gate = createDeferred<void>();
  const p1 = locks.withWriteLock('a', async () => { held.resolve(); await gate.promise; order.push('1'); });
  await held.promise;
  const p2 = locks.withWriteLock('a', async () => { order.push('2'); });
  expect(order).toEqual([]);
  gate.resolve();
  await Promise.all([p1, p2]);
  expect(order).toEqual(['1', '2']);
});
```

### Rule 6.3 — Exact Behavioral Assertions (Zero Weak, Tautological, or Inverted-Oracle Tests)
- Assert exact output values, wire frame structures, database rows, and thrown error messages/codes. Weak existence checks (`expect(result).toBeDefined()`, `expect(frames.length).toBeGreaterThanOrEqual(0)`), unawaited async rejections (`expect(fn()).rejects.toThrow()` without `await`), `.skip` / `.todo` / `.only`, and "make-bugs-pass" tests (assertions tailored to match broken implementation behavior instead of `docs/SPEC.md`) are forbidden.
**DON'T:**
```ts
it('validates fencing token', async () => {
  const r = await store.commitCheckpoint('run-1', 5, payload);
  expect(r).toBeDefined();
  expect(r.fenceToken).toBeGreaterThanOrEqual(0);
  expect(store.commitCheckpoint('run-1', 3, payload)).rejects.toThrow();
});
```
**DO:**
```ts
it('commits at higher fence token and rejects stale lower fence tokens', async () => {
  const r = await store.commitCheckpoint('run-1', 5, payload);
  expect(r).toEqual({ runId: 'run-1', fenceToken: 5, byteLength: 128, committed: true });
  await expect(store.commitCheckpoint('run-1', 3, payload)).rejects.toThrowError(new StaleFenceTokenError('run-1', 3, 5));
});
```
