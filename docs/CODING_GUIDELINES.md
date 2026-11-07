# Coding Guidelines

Every file authored in this repository must conform to these guidelines, enforced deterministically by `pnpm lint` (`eslint.config.mjs`), code review, and verification gates.
*(Note: `/** ... */` JSDoc blocks are omitted from snippets outside **§2** to isolate each rule; in production and `test/fixtures/` files, every entity must carry full JSDoc per **§2**.)*

## 1. File & Module Taxonomy

### Rule 1.1 — Strict Single-Kind Entity Files (Zero Cross-Kind Co-Location) & Universal Line Ceilings
- Unrelated or different-kind declarations (`interface`, `type`, `class`, `function`, `const`) must **never** share a production source file (`src/**`, `test/fixtures/**`). Every production file belongs strictly to one of six mutually exclusive categories enforced by `harness/file-separation`:
  1. **Types (`*.types.ts`):** Pure `type` aliases only (multiple logically grouped `type` aliases may share a `*.types.ts` file; never mix `type` aliases with `interface`, `function`, `class`, or `const` declarations).
  2. **Schemas (`*.schema.ts`):** Sole permitted cross-kind pairing—a Zod schema constant (`export const FooSchema = z.object(...)`) and its directly inferred type (`export type Foo = z.infer<typeof FooSchema>`), never mixed with `interface` or `class` declarations.
  3. **Interfaces (`<entity-name>.ts`):** Strictly **one top-level `interface` per file** (plus sub-interfaces referenced directly by that parent interface's `TSPropertySignature` properties; never mix interfaces with functions, constants, types, or classes). Use clear `kebab-case` entity filenames (`lessons-builder.ts`, `lesson-distillation-builder.ts`, `create-lessons-builder-options.ts`) without a rigid `.interface.ts` suffix.
  4. **Classes (`<class-name>.ts`):** Strictly **one `class` per file**, never mixed with interfaces, functions, constants, or types.
  5. **Functions (`create-*-builder.ts`, `<domain-verb>.ts`, `internal/<domain-verb>.ts`):** Functions only, never mixed with interfaces, constants, types, or classes. Entity builder factories (`**/builders/*.ts`, `**/create-*.ts`) and any file containing a function `> 40` lines allow **at most 1 function per file**; cohesive helper files in `internal/` allow **at most 4 functions per file**.
  6. **Constants (`*.constants.ts`) & Barrels (`index.ts`):** `*.constants.ts` contains only logically grouped `const` values (never mixed with interfaces, functions, classes, or types); `index.ts` contains only pure `export { ... } from '...'` and `export type { ... } from '...'` re-exports (zero declarations).
- **Universal file line-count ceiling & test/CLI scope:** Every non-test file (`src/**`, `test/fixtures/**`, `scripts/**`, `.agents/hooks/**`, `eslint.config.mjs`) must be **`<= 250` lines**; every test file (`test/**/*.test.ts`) must be **`<= 400` lines** and may co-locate file-local test constants and small local setup helpers with `describe`/`it` suites without separate entity files (reusable test doubles/fakes still live in `test/fixtures/**` per Rule 6.1). Standalone CLI scripts in `.agents/hooks/**` and `scripts/**` (`<= 250` lines) may co-locate constants, documented functions, and top-level CLI entrypoint execution in one file.
**DON'T (`src/runtime/runner.ts` — mixing constants, interfaces, union types, classes, and factory functions in one file):**
```ts
export const DEFAULT_TIMEOUT_MS = 5_000;
export interface RunnerOptions { readonly timeoutMs?: number; }
export type RunnerMode = 'local' | 'container';
export class LocalRunner { run(options: RunnerOptions): void {} }
export function createLocalRunner(): LocalRunner { return new LocalRunner(); }
```
**DO (split each entity kind into `runner.constants.ts`, `runner-options.ts`, `runner.types.ts`, `local-runner.ts`, `create-local-runner.ts`, each `<= 250` lines):**
```ts
import type { RunnerOptions } from './runner-options.js';
export class LocalRunner {
  run(options: RunnerOptions): void {}
}
```

### Rule 1.2 — One Top-Level `interface` Per File (Property-Referenced Sub-Interfaces Only, Zero Co-Located Sub-Builders or `*Options`)
- Place each top-level `interface` in its own `kebab-case` file (`LessonsBuilder` $\to$ `lessons-builder.ts`, `LessonDistillationBuilder` $\to$ `lesson-distillation-builder.ts`, `CreateLessonsBuilderOptions` $\to$ `create-lessons-builder-options.ts`).
- **Property-referenced sub-interfaces only:** A secondary `interface` may share a file with the root `interface` **if and only if** it is reachable from the root interface via **`TSPropertySignature` property type annotations** (or `extends`). Interfaces referenced only in **`TSMethodSignature` parameter or return types** (such as callback sub-builders `($d: LessonDistillationBuilder) => ...`), function `*Options` / `*Params` interfaces, and sibling AST/port interfaces must **each live in their own file**.
- **No god interfaces:** Never build 30-property/25-method interfaces mixing unrelated concerns (locks, SQLite, model streaming, git worktrees). Decompose distinct capability surfaces into focused interfaces in separate files.
**DON'T (`src/builders/lessons-builder.ts` — packing callback sub-builder interfaces, function `*Options` interfaces, and factory functions into one file):**
```ts
export interface LessonDistillationBuilder { onLoopRecovery(enabled?: boolean): LessonDistillationBuilder; }
export interface LessonsBuilder<TIn = unknown> {
  readonly id: string;
  distillWith(configure: ($d: LessonDistillationBuilder) => LessonDistillationBuilder): LessonsBuilder<TIn>;
}
export interface CreateLessonsBuilderOptions<TIn> { readonly store?: LessonStoreASTNode; }
export function createLessonsBuilder<TIn = unknown>(id: string, opts?: CreateLessonsBuilderOptions<TIn>): LessonsBuilder<TIn> {
  throw new Error(id);
}
```
**DO (`src/ast/topology-node.ts` — one top-level interface with its `TSPropertySignature`-referenced config sub-interface):**
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

### Rule 1.3 — One `class` Per File & Single-Responsibility Classes (No God Classes)
- Place each `class` in its own `kebab-case` file (`ScopeLockManager` $\to$ `scope-lock-manager.ts`), focused on a single stateful responsibility, importing any constants from `*.constants.ts` and parameter/option interfaces from their dedicated interface files.
- Never pack multiple classes into one file or manage unrelated state machines in one class; extract stateless algorithms into `internal/` functions.
**DON'T (`src/runtime/managers.ts` — multiple classes and mixed responsibilities):**
```ts
export class RuntimeGodManager {
  private readonly locks = new Map<string, string>();
  async acquireLock(scopeKey: string): Promise<void> {}
  async checkoutWarmContainer(poolId: string): Promise<unknown> { return undefined; }
}
export class FenceValidator { validate(token: number): boolean { return token > 0; } }
```
**DO (`src/runtime/locks/scope-lock-manager.ts` — one focused class delegating pure helpers to `internal/`):**
```ts
export class ScopeLockManager {
  private readonly activeWriteOwners = new Map<string, string>();
  async acquireWriteLeases(scopeKeys: readonly string[], ownerId: string): Promise<readonly ScopeLease[]> {
    const leases: ScopeLease[] = [];
    for (const key of sortScopeKeysCanonical(scopeKeys)) {
      if (this.activeWriteOwners.has(key)) throw new Error(`Write lock contention on '${key}' for '${ownerId}'.`);
      this.activeWriteOwners.set(key, ownerId);
      leases.push({ scopeKey: key, ownerId, mode: 'write' });
    }
    return leases;
  }
}
```

### Rule 1.4 — Grouped `type` Aliases (`*.types.ts`) & Schema Type Co-Location (`*.schema.ts`)
- Pure `type` aliases (discriminated unions, primitive/template-literal/mapped/conditional types) live in `*.types.ts`; a `z.infer<typeof FooSchema>` type may be paired with `FooSchema` in `*.schema.ts` per Rule 1.1(2).
- Never place `interface`, `class`, `const`, or `function` declarations inside `*.types.ts`, and never use `type Foo = { ... }` object-type literals as a backdoor to avoid dedicated single-interface files.
**DON'T (`src/ast/step.types.ts` — object-shape interfaces and constants inside `*.types.ts`):**
```ts
export const STEP_VERSION = 1;
export type AgentNodeShape = { readonly type: 'harness:agent'; readonly id: string };
export type CoreStepASTNode = AgentNodeShape;
```
**DO (`src/ast/step-ast.types.ts` — pure type aliases importing single-file interfaces):**
```ts
import type { AgentNode } from './agent-node.js';
import type { LoopNode } from './loop-node.js';
export type CoreStepASTNode<TIn = unknown, TOut = unknown> = AgentNode<TIn, TOut> | LoopNode<TIn, TOut>;
export type CoreStepNodeType = CoreStepASTNode['type'];
```

### Rule 1.5 — Grouped Constants (`*.constants.ts`), Schemas (`*.schema.ts`) & Zero Magic Literals
- Place all module-scope constants, protocol markers, default bounds, pre-compiled regexes, and frozen lookup tables in dedicated `*.constants.ts` files (and Zod schemas with their directly inferred `z.infer` types in `*.schema.ts`).
- Never mix constants into interface, class, type, or function files, and never scatter magic numbers (`65_536`, `5_000`, `0.25`) or protocol wire strings (`'harness:fork-dispatched'`) inline across function bodies.
**DON'T (`src/runtime/lane/compute-priority.ts` — magic numbers inline and constants mixed with functions):**
```ts
export const DEFAULT_AGING_MS = 60_000;
export function computeEffectivePriority(level: string, waitedMs: number): number {
  const base = level === 'critical' ? 40 : level === 'high' ? 30 : level === 'normal' ? 20 : 10;
  return base + Math.floor(waitedMs / DEFAULT_AGING_MS) * 5;
}
```
**DO (`src/runtime/lane/lane-priority.constants.ts`):**
```ts
export const LANE_PRIORITY_WEIGHTS: Readonly<Record<LanePriorityLevel, number>> = Object.freeze({
  low: 10, normal: 20, high: 30, critical: 40,
});
export const DEFAULT_PRIORITY_AGING_INTERVAL_MS = 60_000;
export const PRIORITY_AGING_STEP_WEIGHT = 5;
```

### Rule 1.6 — Single-Function Builder/Large Function Files & Cohesive `internal/` Helpers
- Functions must never share a file with interfaces, constants, types, or classes.
- Entity builder factories (`**/builders/*.ts`, `**/create-*.ts` outside `internal/`) and any file containing a function `> 40` lines must contain **at most 1 top-level function per file** (`createLessonsBuilder` $\to$ `create-lessons-builder.ts`).
- Small, logically grouped helper functions (`<= 40` lines each) operating on the same narrow concept may share a file (**up to 4 functions per file**), with non-public helpers placed under `internal/` (`src/builders/internal/assert-valid-max-turns.ts`).
**DON'T (`src/builders/agent.ts` — mixing internal helpers and public factories in one file):**
```ts
function assertValidMaxTurns(maxTurns: number): void {
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error(`Invalid maxTurns: ${maxTurns}`);
}
export function createAgentBuilder(id: string): unknown {
  assertValidMaxTurns(10);
  return { id };
}
```
**DO (`src/builders/create-agent-builder.ts` importing `./internal/assert-valid-max-turns.js`):**
```ts
import { AgentBuilderImpl } from './agent-builder-impl.js';
import { assertValidMaxTurns } from './internal/assert-valid-max-turns.js';
export function createAgentBuilder(id: string, defaultTurns = 25): AgentBuilder {
  assertValidMaxTurns(defaultTurns, id);
  return new AgentBuilderImpl(id, defaultTurns);
}
```

### Rule 1.7 — Pure Barrel Files (`index.ts`) & Strict Acyclic Import Graph (DAG)
- `index.ts` files must contain **only** `export { ... } from '...'` and `export type { ... } from '...'` statements (zero declarations, and zero wildcard `export *` in package root `src/index.ts`).
- Module imports must form a strict DAG (`*.types.ts / interfaces / *.constants.ts` $\to$ `internal/` $\to$ `public classes & functions` $\to$ `index.ts`). Leaf files must import directly from sibling leaf files (`./agent-node.js`), never back through `index.js`.
**DON'T (`src/index.ts` — defining entities in a barrel and importing from `./runtime/index.js`):**
```ts
import { createRuntime } from './runtime/index.js';
export const VERSION = '1.0.0';
export interface HarnessConfig { readonly strict: boolean; }
export function boot(): unknown { return createRuntime(); }
```
**DO (`src/index.ts` — pure explicit re-exports):**
```ts
export type { AgentNode } from './ast/agent-node.js';
export type { CoreStepASTNode, CoreStepNodeType } from './ast/step-ast.types.js';
export { createAgentBuilder } from './builders/create-agent-builder.js';
export { createRuntime } from './runtime/create-runtime.js';
```

### Rule 1.8 — 1:1 File & Identifier Naming Precision (Zero Grab-Bag Names)
- File names must match their primary exported entity in `kebab-case` (`ScopeLockManager` $\to$ `scope-lock-manager.ts`).
- Grab-bag file names (`utils.ts`, `helpers.ts`, `common.ts`, `shared.ts`, `misc.ts`, `core.ts`, `base.ts`, unprefixed `types.ts` / `constants.ts`) and vague identifiers (`data`, `info`, `item`, `val`, `temp`, `obj`, `res`, `ret`, `processData`, `handleItem`, `doWork`, `Manager`, `Helper`) are forbidden.
**DON'T (`src/runtime/utils.ts` — vague file name and meaningless identifiers):**
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
  const eligibleLessons: LessonRecord[] = [];
  for (const lesson of lessons) {
    if (!lesson.archived && lesson.confidence >= minConfidence) eligibleLessons.push(lesson);
  }
  return eligibleLessons;
}
```

## 2. JSDoc Documentation & Comment Discipline

### Rule 2.1 — Mandatory JSDoc on Every Class, Interface, Method, Function, and Exported Type or Constant
Every `class` (and its constructor, methods, and properties), `interface` (and its properties and methods), `function` (public, `internal/`, and CLI hook/script functions), and exported `type` alias or `const` in `src/**`, `test/fixtures/**`, `scripts/**`, and `.agents/hooks/**` must have a `/** ... */` JSDoc block immediately above its declaration (inside `test/**/*.test.ts`, `describe`/`it` suites and file-local test constants/setup helpers do not require §2 JSDoc).
**DON'T (undocumented interface, class, and methods):**
```ts
export interface LeaseReceipt { readonly leaseId: string; readonly scopeKey: string; readonly fenceToken: number; }
export class FenceClock {
  private current = 0;
  nextToken(): number { this.current += 1; return this.current; }
}
```
**DO (`src/runtime/locks/fence-clock.ts` — complete JSDoc on class, property, and method):**
```ts
/**
 * Monotonic counter that issues strictly increasing fencing tokens across lock acquisitions.
 *
 * Guarantees that every newly granted write lease receives a fencing token strictly
 * greater than any token previously issued within the same runtime instance.
 *
 * @note
 * Initialize with the maximum persisted `fenceToken` from the checkpoint ledger during crash recovery.
 */
export class FenceClock {
  /** Highest fencing token issued so far by this clock instance. */
  private currentToken = 0;

  /**
   * Advances the internal counter by one and returns the newly issued fencing token.
   *
   * @returns {number} Strictly positive integer fencing token greater than all prior tokens.
   *
   * @throws {RangeError} If incrementing would exceed `Number.MAX_SAFE_INTEGER`.
   */
  nextToken(): number {
    if (this.currentToken >= Number.MAX_SAFE_INTEGER) throw new RangeError('FenceClock exhausted MAX_SAFE_INTEGER.');
    this.currentToken += 1;
    return this.currentToken;
  }
}
```

### Rule 2.2 — JSDoc Anatomy, Tag Completeness & Vertical Alignment (Functions, Class Methods, AND Interface Methods)
Structure every JSDoc block so TypeDoc, TSServer, and engineers can parse the full contract without reading the body. **Every `class`, top-level `interface`, `function`, class method (`MethodDefinition`), AND interface method (`TSMethodSignature`) requires the full 3-part JSDoc anatomy below** (only interface/class properties (`TSPropertySignature` / `PropertyDefinition`), exported constants, and simple type aliases may use a concise 1-sentence `/** Summary. */` block unless non-obvious invariants or `@template` parameters require detail; 1-line stub JSDocs on interface methods are strictly forbidden and rejected by `harness/require-complete-jsdoc`):
1. **Summary line:** One direct sentence stating what the entity is or does.
2. **Detailed description:** Separated by an empty `*` line; explains behavioral invariants, state transitions, edge cases, or concurrency guarantees.
3. **Grouped, vertically aligned block tags** separated by empty `*` lines: `@template TName Description` (column-aligned when $\ge 2$), `@param {Type} name - Description` (`[name=default]` when optional, column-aligned when $\ge 2$), `@returns {Type} Description` (mandatory for all non-`void` functions, class methods, and interface methods), `@throws {ErrorType} Description`, and `@note` / `@example` when applicable.
**DON'T (1-line interface method stubs missing detailed descriptions, `@param`, and `@returns`, plus unaligned function tags):**
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
export async function executeStepNode<TIn, TOut>(node: StepASTNode<TIn, TOut>, input: TIn): Promise<TOut> {
  throw new Error('Not implemented');
}
```
**DO (complete 3-part JSDoc on both the interface/interface method AND the function, with vertically aligned tags):**
```ts
/**
 * Fluent configurator for contrastive lesson distillation (`$d` in `.distillWith(model, $d => ...)`).
 *
 * Captures trigger conditions and guidelines used when distilling failure-to-pass trajectory pairs
 * into empirical lessons stored in the backing `LessonStore`.
 */
export interface LessonDistillationBuilder {
  /**
   * Enables or disables contrastive distillation when an outer `H.loop` iteration recovers after a failed check.
   *
   * Pairs the most recent failing loop iteration trajectory with the subsequent passing iteration trajectory
   * and invokes the configured distillation model before advancing the loop.
   *
   * @param {boolean} [enabled=true] - Whether outer loop recovery distillation is active.
   *
   * @returns {LessonDistillationBuilder} Updated immutable builder instance for method chaining.
   */
  onLoopRecovery(enabled?: boolean): LessonDistillationBuilder;
}

/**
 * Dispatches a passive step AST node to its registered runtime executor.
 *
 * Built-in step types narrow via exhaustive `switch (node.type)`, whereas external
 * adapter step types dispatch through `ctx.registry.steps[node.type]`.
 *
 * @template TIn     Step input payload type.
 * @template TOut    Step output payload type.
 * @template THandle Isolation scope handle type.
 *
 * @param {StepASTNode<TIn, TOut, THandle>} node  - Passive step AST node to execute.
 * @param {TIn}                             input - Raw or pre-mapped input payload for the step.
 * @param {StepExecutionContext<THandle>}   ctx   - Active step execution context and scope handle.
 *
 * @returns {Promise<TOut>} Validated output payload produced by the step executor.
 *
 * @throws {ZodError} If `input` fails `node.inputSchema` or output fails `node.outputSchema`.
 *
 * @note
 * Callers must hold at least a shared read lease on the step's active scope before invoking.
 *
 * @example
 * ```ts
 * const output = await executeStepNode(agentNode, { issueId: 42 }, stepCtx);
 * ```
 */
export async function executeStepNode<TIn = unknown, TOut = unknown, THandle = unknown>(
  node: StepASTNode<TIn, TOut, THandle>, input: TIn, ctx: StepExecutionContext<THandle>,
): Promise<TOut> {
```

### Rule 2.3 — JSDoc Prose Quality (Grounded & Direct — No Vague Stubs, No Robotic Walls of Text)
- Write in natural, direct engineering English that goes straight to the contract.
- **No tautological stubs:** Never merely repeat the identifier words (`/** Validates fence token. */`).
- **No robotic walls of text:** Never pad JSDoc with LLM throat-clearing (*"This function is responsible for taking the provided parameter..."*) or repeat the same sentence across summary, description, and `@returns`.
**DON'T (a tautological stub AND a bloated robotic wall of text):**
```ts
/**
 * Validates fence token.
 * @param {number} token - The token.
 */
export function assertFreshFenceTokenStub(token: number): void {}

/**
 * This function is responsible for asserting and ensuring that a given fencing token
 * provided by the caller is completely valid and fresh within the architecture.
 * @param {number} fenceToken    - This parameter represents the numeric fence token value being checked.
 * @param {number} highWaterMark - This parameter represents the numeric high water mark value.
 */
export function assertFreshFenceTokenVerbose(fenceToken: number, highWaterMark: number): void {}
```
**DO (crisp, high-signal, grounded prose):**
```ts
/**
 * Rejects state mutations carrying a fencing token older than the resource's high-water mark.
 *
 * Compares the caller's lease fencing token against the highest token previously committed
 * to `resourceId` and halts immediately when `fenceToken < highWaterMark`.
 *
 * @param {number} fenceToken    - Fencing token presented by the active lease holder.
 * @param {number} highWaterMark - Highest fencing token previously committed to `resourceId`.
 * @param {string} resourceId    - Identifier of the guarded store or topology partition.
 *
 * @throws {StaleFenceTokenError} If `fenceToken < highWaterMark`.
 */
export function assertFreshFenceToken(fenceToken: number, highWaterMark: number, resourceId: string): void {
  if (fenceToken < highWaterMark) throw new StaleFenceTokenError(resourceId, fenceToken, highWaterMark);
}
```

### Rule 2.4 — Zero Inline or Non-JSDoc Comments Anywhere
- Single-line comments (`// ...`) and non-JSDoc block comments (`/* ... */`) are forbidden in all files.
- **Zero comments of any kind (`//`, `/* */`, `/** */`) may appear inside a function, method, or constructor body.** Extract complex blocks into named `internal/` helper functions with declaration JSDoc.
**DON'T (inline `//` comments explaining branches inside a function body):**
```ts
export async function settleTournament(state: TournamentState): Promise<WinnerResult> {
  // Case 1: 0 completed and 1 parked -> unpark directly
  if (state.completed.length === 0 && state.parked.length === 1) return unparkCandidate(state, state.parked[0]);
  // Case 2: 1 completed, 0 parked, no prior rulings -> short-circuit arbiter
  if (state.completed.length === 1 && state.parked.length === 0 && state.rulings.length === 0) {
    return verifySoleSurvivor(state, state.completed[0]);
  }
  return runArbiterTurn(state);
}
```
**DO (self-documenting `internal/` predicate/action functions with declaration JSDoc and zero body comments):**
```ts
/** Resolves a completed speculative tournament race into a winning branch or unpark continuation (full JSDoc per §2). */
export async function settleTournament(state: TournamentState): Promise<WinnerResult> {
  if (shouldUnparkSoleEscalatedCandidate(state)) return unparkSoleEscalatedCandidate(state);
  if (canShortCircuitArbiterForSoleSurvivor(state)) return verifySoleSurvivor(state);
  return runArbiterTurn(state);
}
```

## 3. Clean Code, KISS, Single Responsibility & Control Flow

### Rule 3.1 — Single Responsibility & Natural Function Decomposition (No Enormous Functions or Closure State Machines)
- Each function must do **one thing** at a single level of abstraction and stay under **80 lines** (hard ceiling: 100 lines).
- **No closure state machines:** Never write a mega-function declaring mutable outer `let` variables mutated from inner closures. Define an explicit state interface in its own file and pass it to standalone, unit-testable functions in `internal/`.
- **Split naturally:** Decompose along real domain phases (`compileTurnPrefix`, `invokeModelTurn`, `dispatchToolCalls`), never chopping a single expression in half arbitrarily.
**DON'T (enormous function with mutable outer state mutated by nested closures):**
```ts
export async function executeAgent(node: AgentNode, input: unknown, ctx: StepExecutionContext): Promise<unknown> {
  let turnIndex = 0;
  let history: WireFrameRecord[] = [];
  const executeToolBatch = async (calls: readonly ToolCall[]): Promise<void> => {
    for (const call of calls) history.push(await runSingleTool(call));
  };
  while (turnIndex < node.maxTurns) {
    turnIndex += 1;
    const response = await invokeDriver(node, history, ctx);
    if (response.toolCalls.length > 0) await executeToolBatch(response.toolCalls);
  }
  return undefined;
}
```
**DO (high-level orchestrator composing focused `internal/` phase functions over explicit state):**
```ts
export async function executeAgent<TIn = unknown, TOut = unknown, THandle = unknown>(
  node: AgentNode<TIn, TOut, THandle>, input: TIn, ctx: StepExecutionContext<THandle>,
): Promise<TOut> {
  const session = await createAgentTurnSession(node, input, ctx);
  try { return await runAgentTurnLoop(session); }
  finally { await releaseAgentTurnSession(session); }
}
```

### Rule 3.2 — Guard Clauses & Flat Control Flow (Maximum Nesting Depth 3)
- Validate preconditions, null/undefined checks, and early-exit cases at the top of the function using guard clauses (`if (!isValid) return ...;`).
- Never wrap the main body in deep `if / else if / else` pyramids, and never nest control structures deeper than **3 levels**.
**DON'T (deeply nested arrow anti-pattern):**
```ts
export function resolveInterrupt(handler: InterruptHandlerNode | undefined, signal: InterruptSignal): Resolution {
  if (handler !== undefined) {
    if (handler.mode === 'replace') {
      if (handler.abortHook !== undefined) return runAbortHookAndReplace(handler, signal);
      else return restoreCheckpointAndReplace(handler, signal);
    } else return adjudicateInterrupt(handler, signal);
  } else throw signal;
}
```
**DO (flat guard clauses with clear linear flow):**
```ts
export function resolveInterrupt(handler: InterruptHandlerNode | undefined, signal: InterruptSignal): Resolution {
  if (handler === undefined) throw signal;
  if (handler.mode !== 'replace') return adjudicateInterrupt(handler, signal);
  if (handler.abortHook !== undefined) return runAbortHookAndReplace(handler, signal);
  return restoreCheckpointAndReplace(handler, signal);
}
```

### Rule 3.3 — Named Parameter Objects Over Long Positional Parameter Lists (`> 3` Parameters)
- Functions, methods, and constructors requiring **more than 3 parameters** must accept a single typed parameter interface (defined in its own dedicated interface file, such as `dispatch-fork-child-params.ts`, or as a property-referenced sub-interface of its port per Rule 1.2). Never pass positional boolean flags.
**DON'T (6 positional arguments including mystery booleans):**
```ts
export async function dispatchForkChild(
  parentRunId: string, childNode: StepASTNode, childInput: unknown,
  isolateWorktree: boolean, inheritLeases: boolean, timeoutMs?: number,
): Promise<ForkChildResult> {
  return executeChild(parentRunId, childNode, childInput, isolateWorktree, inheritLeases, timeoutMs);
}
```
**DO (`src/runtime/fork/dispatch-fork-child.ts` accepting `DispatchForkChildParams`):**
```ts
export function dispatchForkChild(params: DispatchForkChildParams): Promise<ForkChildResult> {
  params.signal?.throwIfAborted();
  return executeIsolatedForkBranch(params);
}
```

### Rule 3.4 — KISS: Zero Speculative Abstractions, Single-Caller Wrappers, or Unrequested Options
- Write the simplest direct implementation that satisfies `docs/SPEC.md`. Never introduce an abstract base class with one subclass, a strategy pattern with one strategy, a pass-through wrapper function, or unrequested config flags (decomposing complex functions or branch conditions into single-caller `internal/` phase/predicate helpers per Rules 1.3, 2.4, and 3.1 is required and compliant, not a forbidden pass-through wrapper).
**DON'T (abstract factory boilerplate and pass-through wrappers for a single concrete operation):**
```ts
export abstract class AbstractDigestStrategy { abstract compute(input: string): string; }
export class Sha256DigestStrategy extends AbstractDigestStrategy {
  override compute(input: string): string { return createHash('sha256').update(input).digest('hex'); }
}
export function computeDigestWithStrategy(input: string, s: AbstractDigestStrategy = new Sha256DigestStrategy()): string {
  return s.compute(input);
}
```
**DO (direct, zero-ceremony function):**
```ts
import { createHash } from 'node:crypto';
export function computeSha256Hex(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}
```

### Rule 3.5 — Library-First Mandate (Zero Hand-Rolled Commodity Utilities)
- Choose an Owner-approved library that fits over hand-rolled commodity infrastructure (`CLAUDE.MD` §How to work #2). Hand-rolling commodity parsers, graph traversals, diffs, search indices, queues, globs, atomic writes, process-tree killers, port probers, or vendor HTTP wire clients is a Defect Gate violation:
  - **`@harness-dsl/lockfile`**: `p-queue` (`concurrency: 1` per-path in-process serialization) + atomic `open(lockPath, 'wx')`, `.unref()`ed `utimes` heartbeat, and dead-PID / stale-`mtime` atomic reclamation.
  - **`@harness-dsl/core`**: `zod` v4 (`z.toJSONSchema()` for `zodToJsonSchema`), `@dagrejs/graphlib` (`Graph`, `alg.findCycles`, `alg.preorder` for topology & prerequisite DAGs), `diff` (`createTwoFilesPatch` for grounding diffs), `p-queue` (`concurrency: 1` for `StepContinuationQueue` & `ScopeLockManager` writer serialization), `p-limit` (bounded fork/speculate concurrency).
  - **`@harness-dsl/sqlite` & `@harness-dsl/postgres`**: `better-sqlite3` (`sqlite`), `pg` (`Pool` in `postgres` + `@electric-sql/pglite` in tests), `@dagrejs/graphlib`, `node-diff3` (`diff3Merge` for 3-way contract overlay merges), `minisearch` (BM25 lesson recall), `p-queue`.
  - **`@harness-dsl/fs`**: `@harness-dsl/lockfile` (`withFileLock`), `tinyglobby` (directory globbing), `picomatch` (pre-compiled path matchers), `write-file-atomic` (crash-safe atomic writes), `minisearch` (BM25 JSONL lesson recall), `p-queue`.
  - **`@harness-dsl/markdown`**: `mdast-util-from-markdown`, `mdast-util-to-markdown`, `mdast-util-frontmatter`, `micromark-extension-frontmatter`, `yaml` (frontmatter YAML parsing), `tinyglobby`, `picomatch`.
  - **`@harness-dsl/node`**: `node-pty` (PTY daemon sessions), `@modelcontextprotocol/sdk` (MCP stdio/SSE control-plane servers), `pidtree` + `fkill` (process-tree teardown), `get-port` (ephemeral port allocation), `wait-on` (TCP port readiness), `p-queue`, `p-limit`.
  - **`@harness-dsl/git`**: `@harness-dsl/lockfile` (`withFileLock`), `es-module-lexer` (export surface extraction in `publicSurfaceCrossTester`), `write-file-atomic` (`harness-meta.json` persistence), `picomatch`, `p-queue`.
  - **`@harness-dsl/claude`, `@harness-dsl/openai`, `@harness-dsl/gemini`**: `@anthropic-ai/sdk`, `openai`, `@google/genai`.
  - **`@harness-dsl/github`, `@harness-dsl/slack`, `@harness-dsl/stripe`, `@harness-dsl/netsuite`**: `@octokit/rest` + `@octokit/webhooks`, `@slack/web-api` + `@slack/socket-mode` + `@slack/webhook`, `stripe`, `big.js` (exact decimal arithmetic).

## 4. Library-Grade Runtime Performance

### Rule 4.1 — Zero-Allocation Loops Over Spreads & Chained Array Combinators
- **No spread accumulation in loops:** Never write `arr = [...arr, item]` or `obj = { ...obj, [k]: v }` inside a loop ($O(N^2)$ copies and GC churn).
- **No `.filter().map().flatMap().reduce()` chains in runtime paths:** Use a single `for (const x of list)` loop, mutating local arrays/maps in-place and calling `Object.freeze` **once** at the return boundary (such as inside `.toAST()`).
**DON'T ($O(N^2)$ array copies in a loop and multi-pass `.filter().flatMap().map()` allocations):**
```ts
export function collectUnlockedToolNames(
  frames: readonly WireFrameRecord[], skills: readonly SkillNode[], enabledIds: ReadonlySet<string>,
): readonly string[] {
  let history: readonly WireFrameRecord[] = [];
  for (const frame of frames) history = Object.freeze([...history, frame]);
  return skills.filter((s) => enabledIds.has(s.id)).flatMap((s) => s.tools).map((t) => t.name);
}
```
**DO (single-pass `for` loop mutating a local array and freezing once at the boundary):**
```ts
export function collectUnlockedToolNames(skills: readonly SkillNode[], enabledIds: ReadonlySet<string>): readonly string[] {
  const toolNames: string[] = [];
  for (const skill of skills) {
    if (!enabledIds.has(skill.id)) continue;
    for (const tool of skill.tools) toolNames.push(tool.name);
  }
  return Object.freeze(toolNames);
}
```

### Rule 4.2 — $O(1)$ Pre-Indexed `Map` / `Set` Lookups Over Repeated Linear Scans
- Never call `.find()`, `.some()`, `.includes()`, or `.indexOf()` inside per-turn, per-tool-call, per-frame, or per-item loops; pre-index into `Map<string, T>` or `Set<string>` once at initialization for $O(1)$ lookup.
- Use `Map` and `Set` for dynamic collections instead of `Record<string, T>` with `delete obj[key]`, and never call `Object.keys()` or `Object.entries()` on dynamic collections or in hot-path loops (cold error diagnostics and one-time initialization over static `Readonly<Record<...>>` are permitted).
**DON'T ($O(N \times M)$ repeated `.find()` and `.includes()` scans inside a tool-dispatch loop):**
```ts
export async function dispatchToolBatch(
  calls: readonly ModelToolCall[], registeredTools: readonly ToolASTNode[], allowedToolNames: readonly string[],
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const call of calls) {
    if (!allowedToolNames.includes(call.name)) throw new Error(`Tool '${call.name}' is not unlocked.`);
    const tool = registeredTools.find((candidate) => candidate.name === call.name);
    if (tool === undefined) throw new Error(`Unknown tool '${call.name}'.`);
    results.push(await invokeTool(tool, call));
  }
  return results;
}
```
**DO ($O(1)$ lookups against pre-built `ReadonlyMap` and `ReadonlySet` indices):**
```ts
export async function dispatchToolBatch(
  calls: readonly ModelToolCall[], toolsByName: ReadonlyMap<string, ToolASTNode>, allowedToolNames: ReadonlySet<string>,
): Promise<ToolResult[]> {
  const results: ToolResult[] = [];
  for (const call of calls) {
    if (!allowedToolNames.has(call.name)) throw new Error(`Tool '${call.name}' is not unlocked in current turn.`);
    const tool = toolsByName.get(call.name);
    if (tool === undefined) throw new Error(`Tool '${call.name}' is not registered on active agent.`);
    results.push(await invokeTool(tool, call));
  }
  return results;
}
```

### Rule 4.3 — Monomorphic Object Shapes (Preserve V8 Hidden Classes & Inline Caches)
- Never construct AST nodes, wire frames, or runtime records using conditional property spreads (`{ id, ...(a !== undefined ? { a } : {}) }`), which create $2^k$ distinct V8 hidden classes and megamorphic inline caches.
- Always initialize all properties in a single fixed, unconditional order, setting absent optional properties to `undefined`.
**DON'T (conditional object spreads producing $2^3 = 8$ V8 hidden classes plus 5 positional parameters):**
```ts
export function buildCommandNode<TIn, TOut, THandle>(
  id: string, fn: CommandFn<TIn, TOut, THandle>, inputSchema?: ZodType<TIn>,
  outputSchema?: ZodType<TOut>, extractPartitions?: (input: TIn) => readonly string[],
): CommandNode<TIn, TOut, THandle> {
  return Object.freeze({
    type: 'harness:command', id, fn,
    ...(inputSchema !== undefined ? { inputSchema } : {}),
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    ...(extractPartitions !== undefined ? { extractPartitions } : {}),
  });
}
```
**DO (fixed property order producing a single monomorphic V8 hidden class):**
```ts
export function buildCommandNode<TIn = unknown, TOut = unknown, THandle = unknown>(
  params: BuildCommandNodeParams<TIn, TOut, THandle>,
): CommandNode<TIn, TOut, THandle> {
  return Object.freeze({
    type: 'harness:command', id: params.id, fn: params.fn,
    inputSchema: params.inputSchema, outputSchema: params.outputSchema, extractPartitions: params.extractPartitions,
  });
}
```

### Rule 4.4 — Compile & Serialize Once, Reuse Everywhere
- Pre-compile `picomatch` glob matchers and `RegExp` instances once when a guard (`fs:protect`), scoped rule, or skill trigger is registered—never inside per-file or per-tool-call loops.
- Never use `JSON.parse(JSON.stringify(value))` to clone objects or test deep equality, and never re-serialize or re-hash immutable wire frames or checkpoints whose `sha256` digest is already computed.
**DON'T (re-compiling `picomatch` globs on every file check and cloning via `JSON.stringify`):**
```ts
export function isProtectedPath(
  candidatePath: string, protectedGlobs: readonly string[], contextSnapshot: Record<string, unknown>,
): boolean {
  const cloned = JSON.parse(JSON.stringify(contextSnapshot)) as Record<string, unknown>;
  for (const globPattern of protectedGlobs) {
    if (picomatch(globPattern, { dot: true })(candidatePath) && cloned !== null) return true;
  }
  return false;
}
```
**DO (compile matchers once at initialization with a `for` loop and test paths with zero allocations):**
```ts
import picomatch from 'picomatch';
export function compilePathGlobMatcher(globPatterns: readonly string[]): (candidatePath: string) => boolean {
  if (globPatterns.length === 0) return () => false;
  const matchers: Array<(input: string) => boolean> = [];
  for (const pattern of globPatterns) matchers.push(picomatch(pattern, { dot: true }));
  return (candidatePath: string): boolean => {
    for (const isMatch of matchers) if (isMatch(candidatePath)) return true;
    return false;
  };
}
```

### Rule 4.5 — Zero Unnecessary `async` Microtasks & Per-Call Wrapper Closures
- Do not mark a function `async` unless it directly `await`s an asynchronous operation or satisfies an async port contract; return delegated Promises directly when no `try / catch / finally` is needed, and avoid per-call proxy closures around `StepExecutionContext`.
**DON'T (marking synchronous CPU work `async`):**
```ts
export async function computeSlotThreeDigest(frames: readonly WireFrameRecord[]): Promise<string> {
  const hash = createHash('sha256');
  for (const frame of frames) hash.update(frame.serializedJson);
  return hash.digest('hex');
}
```
**DO (synchronous execution for synchronous CPU work—zero `Promise` or microtask overhead):**
```ts
export function computeSlotThreeDigest(frames: readonly WireFrameRecord[]): string {
  const hash = createHash('sha256');
  for (const frame of frames) hash.update(frame.serializedJson, 'utf8');
  return hash.digest('hex');
}
```

## 5. Type Rigor, Purity, Resource Lifecycle & Error Handling

### Rule 5.1 — Exhaustive Type Narrowing (Zero Unsound Casts, Type Erasures, or `!`)
- `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `: any`, `as any`, `as unknown as T`, and unguarded `!` non-null assertions are forbidden in `src/**` and `test/**`.
- Explicitly annotate every function and object-literal method parameter, and pass the target interface type argument to generic wrapper calls (`Object.freeze<TargetInterface>({ ... })`, `deepFreeze<TargetInterface>({ ... })`), because unannotated object literals inside generic calls lose contextual typing from the outer return type.
- Narrow discriminated unions via exhaustive `switch (node.type)` (`assertNever` default) or type predicates (`x is T`), and check indexed lookups for `undefined` under `noUncheckedIndexedAccess: true`.
**DON'T (non-null assertions `!` and `as unknown as` casts hiding runtime crashes):**
```ts
export function getFirstBranchOutput<TOut>(branches: readonly BranchOutcome<TOut>[]): TOut {
  const winner = branches[0]!;
  return (winner.payload as unknown as { readonly result: TOut }).result;
}
```
**DO (explicit narrowing and bounds validation under `noUncheckedIndexedAccess: true`):**
```ts
export function getFirstBranchOutput<TOut>(branches: readonly BranchOutcome<TOut>[], tournamentId: string): TOut {
  const leadingBranch = branches[0];
  if (leadingBranch === undefined) {
    throw new Error(`Cannot extract branch output: tournament '${tournamentId}' has 0 completed branches.`);
  }
  return leadingBranch.output;
}
```

### Rule 5.2 — Zero Import-Time Side Effects & Symbolic `EnvRef` Resolution
- Importing any module (`src/**`, `test/fixtures/**`) must perform **zero I/O**, spawn zero subprocesses, open zero connections, and mutate zero global state (standalone CLI scripts in `.agents/hooks/**` and `scripts/**` may execute their top-level CLI entrypoint per Rule 1.1).
- Builders and AST nodes must never read `.env` or evaluate `process.env[key]` at declaration time; represent secrets symbolically via `H.env('KEY')` (`EnvRef`) and resolve them exclusively inside leaf adapter execution.
**DON'T (reading `process.env` and opening a connection at module import / builder time):**
```ts
const API_KEY = process.env['OPENAI_API_KEY'] ?? '';
const globalClient = new HttpPool(API_KEY);
export function createOpenAiDriver(model: string): ModelDriverNode {
  if (API_KEY.length === 0) throw new Error('Missing OPENAI_API_KEY');
  return { type: 'openai:driver', model, client: globalClient };
}
```
**DO (`src/internal/resolve-env-ref.ts` resolving symbolic `EnvRef` at leaf runtime invocation):**
```ts
export function resolveEnvRef(envRef: EnvRef, env: Readonly<Record<string, string | undefined>>): string {
  const resolved = env[envRef.key];
  if (resolved === undefined || resolved.length === 0) {
    throw new Error(`Required environment variable '${envRef.key}' referenced by H.env('${envRef.key}') is not set.`);
  }
  return resolved;
}
```

### Rule 5.3 — Deterministic `try / finally` Resource Lifecycle & `AbortSignal` Hygiene
- Release every acquired resource (read/write scope lease, `ScopeHandle`, warm-pool lease, `ServiceSession` daemon, subprocess, SQLite transaction, timer, file handle) inside `try / finally`.
- Explicitly remove every `AbortSignal` listener in `finally` (`signal.removeEventListener('abort', onAbort)`) so long-lived parent signals never leak closed-over buffers or child handles.
**DON'T (leaking scope leases on error and leaking `AbortSignal` closures on normal completion):**
```ts
export async function runWithAbortAndLease<TResult>(params: RunWithAbortAndLeaseParams<TResult>): Promise<TResult> {
  const leases = await params.lockManager.acquireWriteLeases([params.scopeKey], params.ownerId);
  const abortPromise = new Promise<never>((_, reject) => {
    params.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
  });
  const result = await Promise.race([params.work(), abortPromise]);
  await params.lockManager.releaseLeases(leases);
  return result;
}
```
**DO (guaranteed `try / finally` release for both the `AbortSignal` listener and the scope leases):**
```ts
export async function runWithAbortAndLease<TResult>(params: RunWithAbortAndLeaseParams<TResult>): Promise<TResult> {
  params.signal.throwIfAborted();
  const leases = await params.lockManager.acquireWriteLeases([params.scopeKey], params.ownerId);
  let onAbort: (() => void) | undefined;
  try {
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = (): void => reject(new Error(`Aborted while holding write lease on '${params.scopeKey}'.`));
      params.signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([params.work(), abortPromise]);
  } finally {
    if (onAbort !== undefined) params.signal.removeEventListener('abort', onAbort);
    await params.lockManager.releaseLeases(leases);
  }
}
```

### Rule 5.4 — Actionable Domain Errors & Zero Silent Fallbacks
- Every thrown `Error` must state: (1) **which subsystem/operation** failed, (2) **which entity identifier** (`runId`, `stepExecId`, `node.type`, `node.id`, `scopeKey`) was involved, and (3) **why** it failed.
- Never swallow exceptions (`catch {}`) or return fabricated fallback values when a required executor, driver, tool, or schema validation fails.
**DON'T (swallowing errors and returning a silent fake fallback):**
```ts
export async function executeExternalStep(node: StepASTNode, input: unknown, ctx: StepExecutionContext): Promise<unknown> {
  try {
    return (await ctx.registry.steps[node.type]?.execute(node, input, ctx)) ?? { status: 'skipped' };
  } catch { return null; }
}
```
**DO (fail fast with an actionable, diagnostic error message and schema-validated output):**
```ts
export async function executeExternalStep<TIn = unknown, TOut = unknown, THandle = unknown>(
  node: StepASTNode<TIn, TOut, THandle>, input: TIn, ctx: StepExecutionContext<THandle>,
): Promise<TOut> {
  const executor = ctx.registry.steps[node.type];
  if (executor === undefined) {
    const registered = Object.keys(ctx.registry.steps).join(', ') || '<none>';
    throw new Error(`No StepExecutor for '${node.type}' (id '${node.id}', runId '${ctx.runId}'). Registered: [${registered}].`);
  }
  return node.outputSchema.parse(await executor.execute(node, input, ctx));
}
```

## 6. Testing Standards & Anti-Smell Discipline

### Rule 6.1 — Focused Per-Subsystem Test Files & Shared `test/fixtures/`
- Organize tests by subsystem (`test/scope-lock-manager.test.ts`, `test/prefix-compiler.test.ts`), keeping each test file `<= 400` lines.
- Extract reusable test doubles and fake drivers into `test/fixtures/` (`<= 250` lines per file), obeying the exact same taxonomy and JSDoc rules as `src/**` (1 class/interface per file, mandatory JSDoc per **§2**, zero inline comments).
**DON'T (`test/everything.test.ts` — monolith re-declaring inline mock classes in every `it()` block):**
```ts
describe('entire runtime', () => {
  it('test 1', async () => {
    class InlineFakeDriver { async invoke() { return { text: 'ok' }; } }
    expect(new InlineFakeDriver()).toBeDefined();
  });
});
```
**DO (`test/fixtures/scripted-model-driver.ts` — reusable fixture class imported by focused subsystem tests):**
```ts
export class ScriptedModelDriver implements ModelDriver {
  private readonly responses: ModelTurnResponse[];
  constructor(responses: readonly ModelTurnResponse[]) { this.responses = [...responses]; }
  async invokeTurn(_request: ModelTurnRequest): Promise<ModelTurnResponse> {
    const nextResponse = this.responses.shift();
    if (nextResponse === undefined) throw new Error('ScriptedModelDriver queue exhausted.');
    return nextResponse;
  }
}
```

### Rule 6.2 — Real Local Resources & Deterministic Synchronization (Zero `setTimeout` Sleeps)
- Test adapters against **real local resources** (real SQLite databases, temp dirs/files, Git repos, Node child processes), mocking only external network HTTP transports.
- Never coordinate concurrent tests with `setTimeout` sleeps; use deterministic deferred promises / barrier latches, and always clean up temp dirs, DBs, and child processes in `afterEach` or `try / finally`.
**DON'T (sleeping with `setTimeout` to test lock contention):**
```ts
it('queues second writer behind first writer', async () => {
  const order: string[] = [];
  void lockManager.withWriteLock('scope-a', async () => {
    await new Promise((resolve) => setTimeout(resolve, 100));
    order.push('first');
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await lockManager.withWriteLock('scope-a', async () => { order.push('second'); });
  expect(order).toEqual(['first', 'second']);
});
```
**DO (deterministic barrier latch with zero wall-clock sleep):**
```ts
it('queues second writer behind first writer until first writer releases its lease', async () => {
  const lockManager = new ScopeLockManager();
  const order: string[] = [];
  const firstAcquired = createDeferred<void>();
  const releaseFirst = createDeferred<void>();
  const first = lockManager.withWriteLock('scope-a', async () => {
    firstAcquired.resolve();
    await releaseFirst.promise;
    order.push('first');
  });
  await firstAcquired.promise;
  const second = lockManager.withWriteLock('scope-a', async () => { order.push('second'); });
  expect(order).toEqual([]);
  releaseFirst.resolve();
  await Promise.all([first, second]);
  expect(order).toEqual(['first', 'second']);
});
```

### Rule 6.3 — Exact Behavioral Assertions (Zero Weak, Tautological, or Inverted-Oracle Tests)
- Assert exact output values, wire frame structures, database rows, and thrown error messages/codes.
- Weak existence assertions (`expect(result).toBeDefined()`, `expect(frames.length).toBeGreaterThanOrEqual(0)`), unawaited async rejections (`expect(fn()).rejects.toThrow()` without `await`), `.skip` / `.todo` / `.only`, and "make-bugs-pass" tests (assertions tailored to match broken implementation behavior instead of `docs/SPEC.md`) are forbidden.
**DON'T (weak existence checks and unawaited `.rejects`):**
```ts
it('validates fencing token and commits checkpoint', async () => {
  const receipt = await store.commitCheckpoint('run-1', 5, payload);
  expect(receipt).toBeDefined();
  expect(receipt.fenceToken).toBeGreaterThanOrEqual(0);
  expect(store.commitCheckpoint('run-1', 3, payload)).rejects.toThrow();
});
```
**DO (exact structural assertions and properly awaited error verification):**
```ts
it('commits checkpoint at a higher fence token and rejects stale lower fence tokens', async () => {
  const receipt = await store.commitCheckpoint('run-1', 5, payload);
  expect(receipt).toEqual({ runId: 'run-1', fenceToken: 5, byteLength: 128, committed: true });
  await expect(store.commitCheckpoint('run-1', 3, payload)).rejects.toThrowError(
    new StaleFenceTokenError('run-1', 3, 5),
  );
});
```
