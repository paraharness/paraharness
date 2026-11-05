# Milestone 3c (`M3c`): `@harness-dsl/node` Subprocess, Stream Check, Daemon & MCP Adapter

## 1. Scope & Package Directory

- **Milestone Wave:** Parallel Wave 2 — Scoped Adapter Builder (`c`) (Depends on Wave 1a `M1` -> Wave 1b `M2` completing)
- **Owned Files & Directories:**
  - `packages/node/src/runner.ts`
  - `packages/node/src/command.ts`
  - `packages/node/src/stream-check.ts`
  - `packages/node/src/daemon.ts`
  - `packages/node/src/pty-session.ts`
  - `packages/node/src/mcp-server.ts`
  - `packages/node/src/index.ts`
  - `packages/node/test/runner-command.test.ts`
  - `packages/node/test/stream-check.test.ts`
  - `packages/node/test/daemon-pty.test.ts`
  - `packages/node/test/mcp-server.test.ts`
- **Forbidden Directories:**
  - Do not modify root workspace files (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `pnpm-lock.yaml`) or `packages/core/**`.
  - Do not touch `packages/sqlite`, `packages/postgres`, `packages/fs`, `packages/markdown`, `packages/git`, `packages/claude`, `packages/openai`, `packages/github`, `packages/slack`, `packages/stripe`, `packages/netsuite`, or `packages/integration`.
  - Zero cross-adapter imports: `packages/node` imports only from `@harness-dsl/core`, `zod`, and Node.js built-ins (`node:child_process`, `node:crypto`, `node:http`, `node:net`, `node:os`, `node:path`).

---

## 2. Exact Spec Grounding Table

Read the following sections in full before authoring any file in `M3c`:

| Document | Section | Line Range | Key Contracts & Subprocess/Daemon Semantics Covered |
| :--- | :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1 Package Boundaries & §1.2 Invariant 3 | `16, 29` | `@harness-dsl/node` responsibilities; opaque `EnvRef` resolution at invocation time |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.3 Executable Units, Checks, Tools & Services | `149–220` | `StepExecutable`, `Check`, `ToolDefinition` (`describeEffects` omission), `Service`, `ServiceSession` |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.7 `ControlPlaneAdapter` & `HarnessRuntimeController` | `860–868` | Control-plane server lifecycle and runtime inspection/signal methods |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.4.2 Skills & §3.5 Post-Flight Scope Diffing | `956–967, 1009–1015` | Static `Service.toolSchemas`, reference-counted daemon quiescing, post-flight rollback on `.asTool()` omitting `describeEffects` |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.2 `@harness-dsl/node` | `1339–1348` | `local.runner({ slots, maxDaemons })`, `local.command` (`.stdin('closed')`, `.unrepeatable()`), `local.streamCheck` (`.circuitBreakWhenStdout()`), `local.daemon` (SHA-256 `scopeKey`, `.stopCommand()`, TCP readiness, PTY `ECHO`-disabled `.interact()`), `mcp.server` |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §6 `engineering-harness.ts` | `322, 367–430, 504–511, 1002–1031, 1204–1207` | `runner`, `drizzleGenerate`, `verifySuite`, `localPostgres`, `browserSandbox`, `checkExistingPr`, `publishPr`, `mcp.server({ port: 9100 })` |

---

## 3. File-by-File Architecture & Exported Symbols

### 3.1 `packages/node/src/index.ts`

```ts
import { z } from 'zod';
import type {
  Check,
  ControlPlaneAdapter,
  EnvRef,
  Service,
  StepExecutable,
  ToolDefinition,
} from '@harness-dsl/core';

export interface SubprocessExecOptions {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string | EnvRef>>;
  readonly stdin?: 'closed' | string | Uint8Array;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface SubprocessExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Runner {
  readonly kind: 'harness:runner';
  readonly id: string;
  readonly slots: number;
  readonly maxDaemons: number;
  acquireSlot<T>(fn: () => Promise<T>): Promise<T>;
  acquireDaemonSlot(): Promise<() => void>;
  allocatePort(): Promise<{ readonly port: number; release(): void }>;
  exec(argv: readonly string[], opts?: SubprocessExecOptions): Promise<SubprocessExecResult>;
  shutdownAll(): Promise<void>;
}

export interface LocalCommandBuilder<TIn = any, TOut = void> extends StepExecutable<TIn, TOut, any> {
  input<TSchema extends z.ZodTypeAny>(schema: TSchema): LocalCommandBuilder<z.infer<TSchema>, TOut>;
  output<TSchema extends z.ZodTypeAny>(schema: TSchema): LocalCommandBuilder<TIn, z.infer<TSchema>>;
  runner(runner: Runner): LocalCommandBuilder<TIn, TOut>;
  stdin(mode: 'closed' | ((input: TIn) => string | Uint8Array)): LocalCommandBuilder<TIn, TOut>;
  env(vars: Readonly<Record<string, string | EnvRef>>): LocalCommandBuilder<TIn, TOut>;
  argv(args: readonly string[] | ((input: TIn) => readonly string[])): LocalCommandBuilder<TIn, TOut>;
  timeoutMinutes(minutes: number): LocalCommandBuilder<TIn, TOut>;
  unrepeatable(
    preCheck: StepExecutable<TIn, boolean, any>,
    opts: { readonly key: (input: TIn) => string },
  ): LocalCommandBuilder<TIn, TOut>;
  asTool(): ToolDefinition<any>;
  asCheck(): Check<any>;
}

export interface LocalStreamCheckBuilder extends Check<any>, StepExecutable<any, { readonly ok: boolean; readonly deficits: readonly string[] }, any> {
  runner(runner: Runner): LocalStreamCheckBuilder;
  argv(args: readonly string[]): LocalStreamCheckBuilder;
  env(vars: Readonly<Record<string, string | EnvRef>>): LocalStreamCheckBuilder;
  circuitBreakWhenStdout(
    pattern: RegExp,
    opts?: { readonly graceLinesAfterMatch?: number },
  ): LocalStreamCheckBuilder;
  timeoutMinutes(minutes: number): LocalStreamCheckBuilder;
  asTool(): ToolDefinition<any>;
}

export interface DaemonCommandContext<TPorts extends string = string> {
  readonly ports: Readonly<Record<TPorts, number>>;
  readonly scopeKey: string;
  readonly worktreePath: string;
}

export interface LocalDaemonBuilder<TPorts extends string = never> extends Service<any> {
  runner(runner: Runner): LocalDaemonBuilder<TPorts>;
  lifecycle(mode: 'scope' | 'fork' | 'skill'): LocalDaemonBuilder<TPorts>;
  port<TName extends string>(name: TName): LocalDaemonBuilder<TPorts | TName>;
  env(vars: Readonly<Record<string, string | EnvRef>>): LocalDaemonBuilder<TPorts>;
  start(fn: (ctx: DaemonCommandContext<TPorts>) => readonly string[]): LocalDaemonBuilder<TPorts>;
  stopCommand(fn: (ctx: DaemonCommandContext<TPorts>) => readonly string[]): LocalDaemonBuilder<TPorts>;
  readyWhenStdout(pattern: RegExp): LocalDaemonBuilder<TPorts>;
  interact(
    toolName: string,
    opts: {
      readonly description?: string;
      readonly command: (ctx: DaemonCommandContext<TPorts>) => readonly string[];
      readonly frameDelimiter: RegExp;
      readonly idleSettleMs: number;
      readonly timeoutSeconds: number;
    },
  ): LocalDaemonBuilder<TPorts>;
}

export function sanitizeScopeKey(rawScopeKey: string): string;

export const local: {
  runner(opts: { readonly slots: number; readonly maxDaemons?: number }): Runner;
  command(id: string): LocalCommandBuilder<any, void>;
  streamCheck(id: string): LocalStreamCheckBuilder;
  daemon(id: string): LocalDaemonBuilder<never>;
};

export const mcp: {
  server(opts: { readonly port: number; readonly host?: string }): ControlPlaneAdapter;
};
```

---

## 4. Critical Implementation Invariants

1. **Disjoint `slots` vs `maxDaemons` Semaphores, Worktree `cwd`/`env` Inheritance & Process-Group Teardown (`SPEC.md` §4.2 line 1343):**
   - `local.runner({ slots, maxDaemons })` maintains two independent FIFO semaphores: `slots` (acquired by `local.command`, `local.streamCheck`, and `runner.exec`) and `maxDaemons` (defaulting to `slots`, acquired by `local.daemon.acquire()` and held until `ServiceSession.stop()` completes). Holding all `maxDaemons` slots never blocks `local.command` or `local.streamCheck` from acquiring a `slots` permit.
   - `local.command`, `local.streamCheck`, `local.daemon` (`.start`, `.stopCommand`, `.interact`), and `local.cliTool` (`exec`, `execInteractive`, `spawnBackground`, `glob`, `grep`, `readFile`, `applyEdits`) all resolve `cwd` from `(ctx.scopeHandle as { worktreePath?: string })?.worktreePath ?? process.cwd()` and merge `(ctx.scopeHandle as { env?: Record<string, string> })?.env` into subprocess environment variables before applying step-specific `.env(...)` overrides.
   - All spawned subprocesses use `detached: true` so the child PID is its own POSIX process group leader (`pgid = child.pid`). Teardown sends `process.kill(-child.pid, 'SIGTERM')`, waits up to a configurable grace window (`250ms` default), and escalates to `process.kill(-child.pid, 'SIGKILL')` if any process in the group remains alive.
2. **`local.command` Closed Stdin, `EnvRef` Resolution, Output Coercion & `.unrepeatable()` (`SPEC.md` §4.2 line 1344):**
   - When `.stdin('closed')` is set (or by default), the child process is spawned with `stdio: ['ignore', 'pipe', 'pipe']`.
   - `EnvRef` values (`{ kind: 'harness:env-ref', key }`) are resolved in-memory at execution time from `process.env[key]` (never serialized to logs or ledger) and merged over `process.env` and `ctx.scopeHandle?.env`.
   - When `.unrepeatable(preCheckCmd, { key })` is configured, `execute(input, ctx)` first runs `const alreadyDone = await preCheckCmd.execute(input, ctx)`; if `alreadyDone === true` (or if `key(input)` was already recorded as completed in the current run), the command skips execution and returns a no-op success.
   - `command.asTool()` returns a `ToolDefinition` with `describeEffects: undefined` so `@harness-dsl/core` enforces post-flight `CheckpointableScope.diffEffects()`.
3. **`local.streamCheck` Combined Rolling `stdout`/`stderr` Circuit Breaker (`SPEC.md` §4.2 line 1345):**
   - Appends incoming chunks from **both** `stdout` and `stderr` into a unified rolling multi-line buffer (bounded to the last 200 lines / 64 KB).
   - Evaluates `circuitBreakWhenStdout` regex across the combined rolling buffer on every chunk (so failure banners written to `stderr` or spanning multiple lines match immediately).
   - Once matched, counts subsequent newline-delimited lines across `stdout`/`stderr` until `graceLinesAfterMatch` lines are collected (or the process exits / a `200ms` post-match settle timer fires), kills the process group (`SIGTERM` -> `SIGKILL`), and returns `{ ok: false, deficits: [capturedWindow] }`.
   - `streamCheck.asTool()` returns a `ToolDefinition` with `describeEffects: undefined`.
4. **`local.daemon` Collision-Free `scopeKey`, Pre-Start `.stopCommand()`, TCP Readiness & PTY `ECHO`-Disabled `.interact()` (`SPEC.md` §4.2 line 1346):**
   - `sanitizeScopeKey(rawScopeKey)` replaces any character outside `[a-zA-Z0-9_.-]` with `_` and appends `-${sha256(rawScopeKey).slice(0, 8)}` so `run#1` and `run_1` produce distinct container/daemon names.
   - `daemon.toolSchemas` is populated statically at builder construction time as each `.interact(toolName, ...)` call is chained.
   - `acquire({ runId, scopeKey, scopeHandle })`:
     1. Acquires a `maxDaemons` slot and allocates distinct free ephemeral TCP ports (`127.0.0.1`, port `0` probe + reservation lock) for every declared `.port(name)`.
     2. If `.stopCommand` is configured, executes it first (ignoring non-zero exit codes) to clean up any crash-orphaned container with the same `sanitizedScopeKey`.
     3. Spawns `.start(...)` and evaluates `.readyWhenStdout(regex)` over the combined `stdout`/`stderr` rolling multi-line window, then verifies TCP connectivity (`net.connect(port, '127.0.0.1')`) on all declared ports before resolving `acquire()`.
   - `.interact(toolName, opts)`: spawns `opts.command(ctx)` inside a pseudo-terminal (`ECHO` disabled via `stty -echo` / `python3 -c 'import pty, termios, ...'` wrapper so input commands are never echoed back into the output stream), writes the tool's `input` argument followed by `\n`, accumulates output until `opts.frameDelimiter` matches the end of the buffer and no further bytes arrive for `opts.idleSettleMs` (enforcing `opts.timeoutSeconds`), and strips the trailing prompt delimiter if desired or returns the settled frame.
   - `session.stop()`: terminates any open `.interact()` PTY processes, runs `.stopCommand` (if configured), kills the daemon process group (`SIGTERM` -> `SIGKILL`), waits for process exit, and only then releases the reserved TCP ports and `maxDaemons` slot.

---

## 5. Required Test Suite (`packages/node/test/*.test.ts`)

1. **`runner-command.test.ts`:**
   - `local.runner({ slots: 2, maxDaemons: 2 })` concurrency enforcement: holding 2 daemon slots does not block `local.command` from acquiring its 2 `slots` permits.
   - `local.command` with `.stdin('closed')`, `H.env('TEST_SECRET')` resolution, boolean/JSON output parsing (`checkExistingPr` pattern from `CODING_SAMPLE.md` lines 1002–1015), `.unrepeatable()` skipping execution when `preCheck` returns `true`, and `.asTool()` omitting `describeEffects`.
   - Process-group teardown reaping a parent subprocess and its spawned grandchild subprocess upon timeout or abort signal.
2. **`stream-check.test.ts`:**
   - `local.streamCheck` matching a multi-line failure banner written across `stderr` and `stdout` (`FAIL packages/api/auth.test.ts\n  ● should verify token`), capturing exactly `graceLinesAfterMatch` trailing stack-trace lines, killing a hanging subprocess early, and returning `{ ok: false, deficits }`.
   - `.asTool()` omitting `describeEffects` and returning formatted failure output (`isError: true`) when the check fails.
3. **`daemon-pty.test.ts`:**
   - `sanitizeScopeKey('run#1') !== sanitizeScopeKey('run_1')` with deterministic 8-hex SHA-256 suffix.
   - `local.daemon` lifecycle: pre-start `.stopCommand()` execution, dynamic port allocation, combined `stdout`/`stderr` multi-line `.readyWhenStdout()` + TCP listener verification, PTY `.interact()` with `ECHO` disabled (verifying sent input is not echoed and multi-turn state persists across `.interact()` calls until `frameDelimiter` + `idleSettleMs`), and `stop()` executing `.stopCommand()`, killing detached child trees, and releasing ports.
4. **`mcp-server.test.ts`:**
   - `mcp.server({ port: 0 })` starting, responding to MCP JSON-RPC `tools/list` and `tools/call` for `getActiveRuns` and `emitSignal`, and shutting down cleanly on `close()`.

---

## 6. Verification Gate Commands

```bash
pnpm check:comments
pnpm --filter @harness-dsl/node typecheck
pnpm --filter @harness-dsl/node test
```
