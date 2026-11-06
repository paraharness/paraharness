# Coding Guidelines

Every file authored in this repository must conform to these rules. They are enforced by the deterministic AST gate (`pnpm check:code`) and by code review.

---

## 1. File & Module Taxonomy

### Rule 1.1 — Never Mix Entity Kinds in One File
Interfaces, classes, functions, constants, and type aliases must never live in the same file. Each file has a single structural category.

**DON'T:**
```ts
export const DEFAULT_TIMEOUT_MS = 5_000;

export interface RunnerOptions {
  readonly timeoutMs?: number;
}

export type RunnerMode = 'local' | 'container';

export class LocalRunner {
  run(opts: RunnerOptions): void {}
}

export function createLocalRunner(): LocalRunner {
  return new LocalRunner();
}
```

**DO:**
```ts
// runner.constants.ts -> export const DEFAULT_TIMEOUT_MS = 5_000;
// runner-options.ts   -> export interface RunnerOptions { ... }
// runner.types.ts     -> export type RunnerMode = 'local' | 'container';
// local-runner.ts     -> export class LocalRunner { ... }
// create-runner.ts    -> export function createLocalRunner(): LocalRunner { ... }
```

---

### Rule 1.2 — One Top-Level `interface` Per File
Place each top-level exported `interface` in its own file named in `kebab-case` after the interface (e.g., `AgentNode` $\to$ `agent-node.ts`). Tightly-coupled sub-interfaces used exclusively as nested property shapes of that top-level interface may live in the same file above or below it.

**DON'T:**
```ts
// ast.ts (multiple unrelated top-level interfaces in one file)
export interface SignalNode<TPayload = unknown> {
  readonly type: 'harness:signal';
  readonly id: string;
}

export interface InterruptNode<TPayload = unknown> {
  readonly type: 'harness:interrupt';
  readonly id: string;
}
```

**DO:**
```ts
// ast/TopologyNode.ts (or ast/topology-node.ts)
/**
 * Configuration for signal-driven topology overlay commits and discards.
 *
 * @template TOnSig      Payload type of the commit trigger signal.
 * @template TDiscardSig Payload type of the discard trigger signal.
 */
export interface TopologyCommitOverlayConfig<TOnSig = unknown, TDiscardSig = unknown> {
  readonly onSignal: {
    readonly signal: SignalNode<TOnSig>;
    readonly correlateBy: (payload: TOnSig) => string | readonly string[];
  };
  readonly discardOverlayOn?: {
    readonly signal: SignalNode<TDiscardSig>;
    readonly correlateBy: (payload: TDiscardSig) => string | readonly string[];
  };
}

/**
 * Passive AST node describing a partitioned system topology and its overlay commit rules.
 *
 * @template TPartition Union of partition identifier string literals.
 */
export interface TopologyNode<TPartition extends string = string> {
  readonly type: 'harness:topology';
  readonly id: string;
  readonly store: TopologyStoreASTNode;
  readonly partitions: Readonly<Record<TPartition, { readonly dependsOn: readonly TPartition[] }>>;
  readonly commitOverlayWhen: TopologyCommitOverlayConfig | undefined;
}
```

---

### Rule 1.3 — One `class` Per File
Place each `class` in its own dedicated file named after the class (`ScopeLockManager` $\to$ `scope-lock-manager.ts`). Keep classes focused on a single stateful responsibility and under ~250 lines.

**DON'T:**
```ts
// locks.ts (two classes in one file)
export class ScopeLockManager { /* ... */ }
export class StepStackQueueManager { /* ... */ }
```

**DO:**
```ts
// runtime/locks/scope-lock-manager.ts -> export class ScopeLockManager { ... }
// runtime/locks/step-stack-queue-manager.ts -> export class StepStackQueueManager { ... }
```

---

### Rule 1.4 — Grouped `type` Aliases (`*.types.ts`)
Pure `type` aliases (discriminated unions, mapped types, conditional types, utility types) may be grouped logically in `*.types.ts` files. Never place `interface`, `class`, `const`, or `function` declarations inside `*.types.ts`.

**DO:**
```ts
// ast/step-ast.types.ts
import type { AgentNode } from './agent-node.js';
import type { CommandNode } from './command-node.js';
import type { LoopNode } from './loop-node.js';

/**
 * Discriminated union of built-in `@harness-dsl/core` executable step AST nodes.
 *
 * @template TIn     Step input payload type.
 * @template TOut    Step output payload type.
 * @template THandle Isolation scope handle type.
 */
export type CoreStepASTNode<TIn = unknown, TOut = unknown, THandle = unknown> =
  | AgentNode<TIn, TOut, THandle>
  | LoopNode<TIn, TOut, THandle>
  | CommandNode<TIn, TOut, THandle>;
```

---

### Rule 1.5 — Grouped Constants (`*.constants.ts`)
Group related runtime constants, default configuration values, and frozen lookup tables in `*.constants.ts` files. Never hardcode magic numbers or protocol markers inline inside functions.

**DO:**
```ts
// runtime/lane/lane-priority.constants.ts
/**
 * Base numeric weights for lane item priorities before aging boost is applied.
 */
export const LANE_PRIORITY_WEIGHTS: Readonly<Record<'low' | 'normal' | 'high' | 'critical', number>> =
  Object.freeze({
    low: 10,
    normal: 20,
    high: 30,
    critical: 40,
  });
```

---

### Rule 1.6 — Cohesive Function Files & `internal/` Directories
- Logically related public functions may share a file when the file stays cohesive and under ~250 lines.
- Internal helper functions that are not part of a package's public API must live inside an `internal/` directory (e.g., `src/builders/internal/freeze-rules.ts`, `src/runtime/agent/internal/evaluate-before-stop.ts`). Even though TypeScript modules can import them, the `internal/` path segments make internal-only intent explicit.

**DON'T:**
```ts
// builders.ts (4,300 lines mixing 30 internal helpers and 20 public builders)
function extractAST<T>(v: MaybeBuilder<T>): T { /* ... */ }
function validateScopeTier(/* ... */) { /* ... */ }
export function createAgentBuilder(/* ... */) { /* ... */ }
```

**DO:**
```ts
// builders/internal/validate-scope-tier.ts -> internal validation functions
// builders/extract-ast.ts                  -> public AST unwrapping functions
// builders/create-agent-builder.ts         -> public agent builder factory
```

---

### Rule 1.7 — Pure Barrel Files (`index.ts`) & Acyclic Imports
- `index.ts` files must contain **only** `export { ... } from '...'` and `export type { ... } from '...'` re-exports—never interfaces, classes, functions, or constants.
- Dependencies must form a strict Directed Acyclic Graph (DAG):
  `types / interfaces / constants` $\to$ `internal/` helpers $\to$ `public functions / classes` $\to$ `index.ts`.
- Internal modules must import directly from leaf files (`./agent-node.js`), never back through a parent or sibling `index.js` barrel.

**DON'T:**
```ts
// src/index.ts
export interface Config { readonly debug: boolean; }
export * from './runtime/index.js';
```

**DO:**
```ts
// src/index.ts
export type { Config } from './config.js';
export { createRuntime, defaultExecutionEngine } from './runtime/index.js';
```

---

### Rule 1.8 — Naming Precision (No Grab-Bag Names)
Ban generic filenames and identifiers (`utils.ts`, `helpers.ts`, `common.ts`, `shared.ts`, `misc.ts`, `data`, `info`, `item`, `temp`, `val`, `processData`, `handleItem`). Name every file, function, parameter, and variable after its exact domain concept.

---

## 2. JSDoc Documentation & Comment Discipline

### Rule 2.1 — Mandatory JSDoc Coverage
Every `interface` (and its properties/methods), `class` (and its constructor/methods/properties), `function`, and exported `type` or `const` must have a `/** ... */` JSDoc block immediately above it.

### Rule 2.2 — JSDoc Structure, Alignment & Professional Tone
Write JSDoc for human engineers and API documentation generators (TypeDoc / TSServer):
1. **Summary line:** One crisp, direct sentence stating what the entity is or does.
2. **Description (when non-trivial):** Separated from the summary by a blank line. Explain behavioral invariants, state transitions, or concurrency guarantees in natural, grounded prose. No robotic filler, no repetition of the function name, and no vague one-liners (`/** Processes the step. */`).
3. **Aligned tags:** Vertically align `@template`, `@param`, `@returns`, and `@throws` descriptions:
   - `@template TName Description` for every generic parameter.
   - `@param {Type} name - Description` for every parameter (including destructured/options parameters).
   - `@returns {Type} Description` for every non-`void` return value.
   - `@throws {ErrorType} Description` for every exception condition the function can raise directly or via validation.
4. **Notes & Examples:** Use `@remarks` for key architectural invariants and `@example` with concise, valid TypeScript code on public builders, ports, and entrypoints.

**DON'T:**
```ts
/**
 * Executes step node.
 * @param node the node
 * @param input the input
 * @param ctx the context
 */
export async function executeStepNode(node: StepASTNode, input: unknown, ctx: StepExecutionContext): Promise<unknown> {
```

**DO:**
```ts
/**
 * Dispatches a passive step AST node to its registered runtime executor.
 *
 * Built-in `@harness-dsl/core` step types (`'harness:agent'`, `'harness:loop'`,
 * `'harness:command'`) narrow at compile time via `switch (node.type)`, while
 * external adapter step types dispatch through `ctx.registry.steps[node.type]`.
 * Input and output payloads are validated against the node's Zod schemas when present.
 *
 * @template TIn     Step input payload type.
 * @template TOut    Step output payload type.
 * @template THandle Isolation scope handle type.
 *
 * @param {StepASTNode<TIn, TOut, THandle>} node  - Passive step AST node to execute.
 * @param {TIn}                             input - Raw or pre-mapped step input payload.
 * @param {StepExecutionContext<THandle>}   ctx   - Active step execution context and scope handle.
 *
 * @returns {Promise<TOut>} Validated output produced by the step executor.
 *
 * @throws {ZodError} If `input` fails `node.inputSchema` or the result fails `node.outputSchema`.
 * @throws {Error}    If `node.type` is an external step type with no executor in `ctx.registry.steps`.
 *
 * @example
 * ```ts
 * const result = await executeStepNode(agentNode, { issueId: 42 }, stepCtx);
 * ```
 */
export async function executeStepNode<TIn = unknown, TOut = unknown, THandle = unknown>(
  node: StepASTNode<TIn, TOut, THandle>,
  input: TIn,
  ctx: StepExecutionContext<THandle>,
): Promise<TOut> {
```

---

### Rule 2.3 — Zero Inline or Non-JSDoc Comments
- Inline comments (`// ...`) and non-JSDoc block comments (`/* ... */`) are forbidden in all files.
- **Zero comments of any kind (`//`, `/* */`, `/** */`) may appear inside a function, method, or constructor body.**
- If a block of code inside a function feels like it needs a comment to explain *what* it is doing, extract that block into a well-named helper function in `internal/` with its own JSDoc.

**DON'T:**
```ts
export async function settleTournament(state: TournamentState): Promise<WinnerResult> {
  // Case 2: 0 completed and 1 parked on escalation -> unpark directly without arbiter
  if (state.completed.length === 0 && state.parked.length === 1) {
    return unparkCandidate(state, state.parked[0]);
  }
  // Case 3: 1 completed, 0 parked, and no prior human rulings -> short-circuit arbiter
  if (state.completed.length === 1 && state.parked.length === 0 && state.rulings.length === 0) {
    return verifySoleSurvivor(state, state.completed[0]);
  }
  return runArbiterTurn(state);
}
```

**DO:**
```ts
/**
 * Resolves a completed speculative tournament race into a winning branch or unpark action.
 *
 * @param {TournamentState} state - Post-race branch states and prior human rulings.
 *
 * @returns {Promise<WinnerResult>} Selected winning candidate or unparked branch continuation.
 */
export async function settleTournament(state: TournamentState): Promise<WinnerResult> {
  if (shouldUnparkSoleCandidate(state)) {
    return unparkSoleCandidate(state);
  }
  if (canShortCircuitArbiter(state)) {
    return verifySoleSurvivor(state);
  }
  return runArbiterTurn(state);
}
```

---

## 3. Clean Code, Single Responsibility & Control Flow (KISS & SRP)

### Rule 3.1 — Small, Composable Functions (No Closure State Machines)
- Keep functions focused on one level of abstraction and under **80 lines** (hard ceiling: 100 lines).
- Never write a 500+ line function that declares 20 mutable local variables and mutates them across nested inner closures. Define an explicit state interface (e.g., `AgentTurnLoopState`) in its own file and pass it explicitly to small, testable functions in `internal/`.

**DON'T:**
```ts
export async function executeAgent(node: AgentNode, input: unknown, ctx: StepExecutionContext) {
  let history: WireFrameRecord[] = [];
  let activeLeases: LeaseDelta[] = [];
  let conflictCheckArmed = false;
  let pendingToolBatch: PendingToolBatch | undefined;
  // ... 35 more mutable locals ...
  const runForkBatch = async () => {
    // 400 lines mutating history, activeLeases, conflictCheckArmed from outer closure
  };
  const runSpeculate = async () => {
    // 500 lines mutating outer closure variables
  };
}
```

**DO:**
```ts
/**
 * Executes an `AgentNode` turn loop until structured output passes all `beforeStop` gates.
 *
 * @template TIn     Agent input payload type.
 * @template TOut    Agent output payload type.
 * @template THandle Isolation scope handle type.
 *
 * @param {AgentNode<TIn, TOut, THandle>} node  - Passive agent AST node.
 * @param {TIn}                           input - Validated agent input payload.
 * @param {StepExecutionContext<THandle>} ctx   - Step execution context.
 *
 * @returns {Promise<TOut>} Validated agent output payload.
 */
export async function executeAgent<TIn = unknown, TOut = unknown, THandle = unknown>(
  node: AgentNode<TIn, TOut, THandle>,
  input: TIn,
  ctx: StepExecutionContext<THandle>,
): Promise<TOut> {
  const session = await initializeAgentSession(node, input, ctx);
  try {
    return await runAgentTurnLoop(session);
  } finally {
    await cleanupAgentSession(session);
  }
}
```

---

### Rule 3.2 — Guard Clauses Over Deep Nesting
Keep control flow flat (maximum nesting depth of **3**). Handle edge cases, preconditions, and early exits at the top of the function using guard clauses (`if (!valid) return ...;`) instead of wrapping the function body in nested `if / else` blocks.

**DON'T:**
```ts
function resolveInterrupt(handler: InterruptHandlerNode | undefined, signal: InterruptSignal): Resolution {
  if (handler !== undefined) {
    if (handler.mode === 'replace') {
      if (handler.abortHook !== undefined) {
        return runAbortHookAndReplace(handler, signal);
      } else {
        return restoreCheckpointAndReplace(handler, signal);
      }
    } else {
      return adjudicateInterrupt(handler, signal);
    }
  } else {
    throw signal;
  }
}
```

**DO:**
```ts
/**
 * Dispatches an upward interrupt signal against a matched handler node.
 *
 * @param {InterruptHandlerNode | undefined} handler - Matched interrupt handler, if any.
 * @param {InterruptSignal}                  signal  - Raised interrupt signal.
 *
 * @returns {Resolution} Handler resolution action.
 *
 * @throws {InterruptSignal} Re-throws `signal` when `handler` is `undefined`.
 */
export function resolveInterrupt(
  handler: InterruptHandlerNode | undefined,
  signal: InterruptSignal,
): Resolution {
  if (handler === undefined) {
    throw signal;
  }
  if (handler.mode !== 'replace') {
    return adjudicateInterrupt(handler, signal);
  }
  if (handler.abortHook !== undefined) {
    return runAbortHookAndReplace(handler, signal);
  }
  return restoreCheckpointAndReplace(handler, signal);
}
```

---

### Rule 3.3 — Typed Parameter Objects (`> 3` Parameters)
Functions or methods requiring more than 3 parameters must accept a single typed options/params interface rather than 4+ positional arguments.

---

## 4. Library-Grade Runtime Performance

### Rule 4.1 — Zero-Allocation Loops Over Array Spreads & Combinator Chains
- Never write `arr = [...arr, item]` or `obj = { ...obj, [k]: v }` inside a loop ($O(N^2)$ allocations and GC churn).
- Avoid chaining `.filter(...).map(...).flatMap(...)` in hot paths; use a single `for` loop that pushes directly into the target array and can early-exit with `break` or `return`.
- In fluent builders (`H.agent`, `H.flow`, etc.), accumulate into internal arrays or copy once on builder transition and `Object.freeze` once inside `.toAST()`.

**DON'T:**
```ts
let history: readonly WireFrameRecord[] = initialHistory;
for (const frame of newFrames) {
  history = Object.freeze([...history, frame]);
}

const activeIds = skills
  .filter((s) => s.type === 'harness:skill')
  .map((s) => s.id)
  .filter((id) => enabledSet.has(id));
```

**DO:**
```ts
const history: WireFrameRecord[] = [...initialHistory];
for (const frame of newFrames) {
  history.push(frame);
}

const activeIds: string[] = [];
for (const skill of skills) {
  if (skill.type === 'harness:skill' && enabledSet.has(skill.id)) {
    activeIds.push(skill.id);
  }
}
```

---

### Rule 4.2 — $O(1)$ Pre-Indexed `Map` / `Set` Lookups
- Never call `.find()`, `.some()`, or `.includes()` repeatedly inside per-turn, per-tool-call, or per-item loops. Build a `Map<string, T>` or `Set<string>` index once when initializing the step, prefix, or scheduler so every lookup inside the loop is $O(1)$.
- Use `Map` and `Set` for dynamic collections instead of `Record<string, T>` with `Object.keys()`, `Object.entries()`, or `delete record[key]` (which allocates intermediate arrays and forces V8 objects into slow dictionary mode).

**DON'T:**
```ts
for (const call of toolCalls) {
  const toolNode = agent.tools.find((t) => t.name === call.toolName);
  const isUnlocked = activeSkillIds.includes(call.skillId);
}
```

**DO:**
```ts
// Pre-indexed once at step initialization:
// toolsByName: ReadonlyMap<string, ToolASTNode>
// activeSkillIdSet: Set<string>
for (const call of toolCalls) {
  const toolNode = toolsByName.get(call.toolName);
  const isUnlocked = activeSkillIdSet.has(call.skillId);
}
```

---

### Rule 4.3 — Monomorphic Object Shapes (V8 Hidden Classes)
Avoid constructing objects in hot paths with conditional property spreads (`{ id, ...(a !== undefined ? { a } : {}), ...(b !== undefined ? { b } : {}) }`), which create $2^k$ distinct V8 hidden classes and deoptimize inline caches into megamorphic lookups. Assign all properties in a fixed, consistent order (setting optional fields to `undefined` when permitted by the interface).

**DON'T:**
```ts
return Object.freeze({
  type: 'harness:command',
  id,
  fn,
  ...(inputSchema !== undefined ? { inputSchema } : {}),
  ...(outputSchema !== undefined ? { outputSchema } : {}),
  ...(extractPartitions !== undefined ? { extractPartitions } : {}),
});
```

**DO:**
```ts
return Object.freeze({
  type: 'harness:command',
  id,
  fn,
  inputSchema,
  outputSchema,
  extractPartitions,
});
```

---

### Rule 4.4 — Compile & Serialize Once, Reuse Everywhere
- **Pre-compile globs and regular expressions:** Compile `picomatch` matchers and `RegExp` instances once when a guard, rule, or skill is initialized—never inside per-file or per-tool-call loops.
- **No redundant serialization or hashing:** Never use `JSON.parse(JSON.stringify(x))` to clone objects, and never re-compute `JSON.stringify` or `sha256` digests on wire frames or checkpoints that have already been serialized.

---

### Rule 4.5 — Avoid Unnecessary `async` & Wrapper Closures
- Do not mark synchronous functions `async`—every `async` call allocates a `Promise` and schedules a microtask tick even when the result is synchronous.
- Do not wrap context objects in per-call proxy/clone closures on every step transition; store session services in a `WeakMap` or pass the session state structure directly.

---

## 5. Type Safety, Resource Lifecycle & Testing Standards

### Rule 5.1 — Exhaustive Narrowing (Zero Unsound Casts or `!`)
- `as any`, `as unknown as T`, `@ts-ignore`, and unguarded `!` non-null assertions are forbidden in both `src/**` and `test/**`.
- Narrow unions via discriminated `switch (node.type)` with an `assertNever(node)` default branch, or via small type-predicate functions (`value is TargetType`) in `internal/`.
- When indexing an array or `Map` after a bounds/existence check, bind the element (`const first = items[0]; if (first === undefined) ...`) instead of writing `items[0]!`.

**DON'T:**
```ts
const soleSurvivor = completedBranches[0]!;
const driver = (ctx.registry.models as unknown as Record<string, ModelDriverFactory>)[node.type]!;
```

**DO:**
```ts
const soleSurvivor = completedBranches[0];
if (soleSurvivor === undefined) {
  throw new Error(`Expected at least one completed branch in tournament '${specNode.id}'.`);
}
```

---

### Rule 5.2 — Deterministic `try / finally` & `AbortSignal` Hygiene
- Every acquired resource (read/write scope locks, root/child `ScopeHandle`s, `ServiceSession` daemons, timers, stream subscriptions, file descriptors, database transactions) must be released in a `try / finally` block.
- Any listener attached to an `AbortSignal` (`signal.addEventListener('abort', onAbort, { once: true })`) must be removed in `finally` (`signal.removeEventListener('abort', onAbort)`) so long-lived parent signals never retain closures in memory.

---

### Rule 5.3 — Actionable Errors & Zero Silent Fallbacks
- Every thrown `Error` must include the specific entity type, identifier (`runId`, `stepExecId`, `node.type`, `node.id`), and the exact invariant that failed.
- Never silently swallow errors (`catch {}`) or fabricate fallback values (`JSON.stringify(node) as unknown as T`) when a required executor, driver, or environment variable is missing.

---

### Rule 5.4 — Modular, Deterministic Tests
- **Focused test files:** Organize tests by subsystem (`test/<subsystem>.test.ts`, each under ~400 lines) rather than multi-thousand-line monolith test files. Extract shared test fakes and fixtures into `test/fixtures/` following the same file taxonomy rules (`1` class/interface per file, JSDoc on fixtures).
- **Zero wall-clock `setTimeout` sleeps:** Synchronize concurrent tasks, lane runs, and lock contention using deterministic deferred promises and event barriers—never `await new Promise(r => setTimeout(r, 50))`.
- **Concrete behavioral assertions:** Assert exact output values, wire frames, ledger records, and terminal receipts. Tautological or weak assertions (`expect(x).toBeDefined()`, `expect(count).toBeGreaterThanOrEqual(0)`) are forbidden.
