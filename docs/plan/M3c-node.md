# Milestone M3c — `@harness-dsl/node` OS Subprocesses, Stream Checks, Daemons & MCP Control Plane

## 1. Scope & Ownership (`owned_dirs` & `forbidden_dirs`)

- **Milestone**: `M3c` (Wave 2 — Parallel Adapter Fan-Out `c`, depends on `M1`)
- **Package**: `@harness-dsl/node` (`packages/node`)
- **`owned_dirs`**:
  - `packages/node/src/**`
  - `packages/node/test/**`
- **`forbidden_dirs`**:
  - `packages/core/**`
  - `packages/{sqlite,postgres,fs,markdown,git,claude,openai,gemini,github,slack,stripe,netsuite,integration}/**`
  - Root workspace configs (`package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`) and `docs/**`
- **Cross-Adapter Independence Rule**:
  - `@harness-dsl/node` must have **zero runtime or type imports** from any other M3 adapter package. It depends exclusively on `@harness-dsl/core` (`workspace:*`), `zod`, and Node built-ins (`node:child_process`, `node:net`, `node:http`, `node:crypto`, `node:events`).

---

## 2. Normative Specification & Coding Sample Grounding

| Normative Source | Section & Exact Line Range | Grounded Scope in `M3c` |
| :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1–§1.2 (`lines 3–34`) | Pure passive AST nodes (`NodeRunnerNode`, `LocalCommandNode`, `LocalCommandCheckNode`, `LocalCommandToolNode`, `LocalStreamCheckNode`, `LocalStreamCheckToolNode`, `LocalServiceNode`, `LocalServiceToolNode`, `NodeAllowBinariesNode`, `NodeDenyNetworkNode`, `NodeHttpControlPlaneNode`, `NodeMcpStdioNode`, `NodeMcpSseNode`) and late-bound `EnvRef` resolution via `ctx.resolveEnv`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.2–§2.4 (`lines 682–1438`) | `BaseRunnerPoolASTNode`, `BaseDomainStepASTNode`, `BaseCheckASTNode`, `BaseToolASTNode` (`effectTracking: 'subprocess-post-flight'`), `BaseServiceASTNode`, `BasePolicyGuardASTNode`, `BaseControlPlaneASTNode`, `RunnerDriver`, `ToolDriver` (omitting `describeEffects` on `'subprocess-post-flight'` tools), `ServiceSession`, `ControlPlaneAdapter`, `RuntimeExecutorRegistrySlice`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.4.2 & §3.5 (`lines 2243–2306`) | Service lifecycle (`'scope' \| 'fork' \| 'skill'`), `LocalServiceNode.toolSchemas` up-front wire registration, and post-flight subprocess sandboxing (`effectTracking: 'subprocess-post-flight'`). |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.2 (`lines 2677–2789`) | Complete `@harness-dsl/node` specification: `local.runner({ id?, slots, maxDaemons? })`, `local.command(id)` (`.runner()`, `.stdin()`, `.env()`, `.argv()`, `.timeoutMinutes()`, `.input()`, `.output()`, `.unrepeatable(preCheckCmd, { key })`, `.asCheck()`, `.asTool()`), `local.streamCheck(id)` (`.runner()`, `.argv()`, `.env()`, `.timeoutMinutes()`, `.circuitBreakWhenStdout(regex, { graceLinesAfterMatch })`, `.asTool()`), `local.daemon(id)` (`.runner()`, `.lifecycle()`, `.port()`, `.start()`, `.stopCommand()`, `.readyWhenStdout()`, `.interact()`, `${sanitizedPrefix}-${sha256(rawScopeKey).slice(0, 8)}`, pre-start `.stopCommand()` cleanup, TCP readiness verification, PTY `ECHO`-disabled framed interaction), `local.allowBinaries(bins)`, `local.denyNetwork()`, `mcp.server({ port })`, `local.mcpStdio(...)`, `local.mcpSse(...)`. |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §6 (`lines 185, 322, 370–430, 505–510, 609–610, 620, 727, 730, 981, 1002–1030, 1194, 1205`) | All `local.*` and `mcp.*` usages in `engineering-harness.ts`. |

---

## 3. Planned Module Decomposition & Public Exports (`packages/node/src/**`)

Every file in `packages/node/src/**` and `packages/node/test/fixtures/**` adheres to [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §1–§5 (`<= 250` lines per file, single primary concept per file, `internal/` helpers, pure `src/index.ts` barrel, complete `/** ... */` JSDoc, and zero inline/non-JSDoc comments).

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/local-runner-builder.ts` | `function` | `createLocalRunnerBuilder`, `LocalRunnerBuilder` |
| `src/builders/local-command-builder.ts` | `interface` | `LocalCommandBuilder`, `createLocalCommandBuilder` |
| `src/builders/local-stream-check-builder.ts` | `interface` | `LocalStreamCheckBuilder`, `createLocalStreamCheckBuilder` |
| `src/builders/local-daemon-builder.ts` | `interface` | `LocalDaemonBuilder`, `createLocalDaemonBuilder` |
| `src/builders/local-guard-and-mcp-builders.ts` | `function` | `createAllowBinariesBuilder`, `createDenyNetworkBuilder`, `createMcpServerBuilder`, `createMcpStdioBuilder`, `createMcpSseBuilder` |
| `src/builders/local-and-mcp-namespaces.constants.ts` | `const` | `local`, `mcp`, `LocalNamespace`, `McpNamespace` |
| `src/executors/internal/process-group-and-ports.ts` | `function` | `spawnDetachedSubprocess`, `terminateProcessGroupWithGrace`, `allocateDynamicPorts`, `waitForTcpPortReady`, `sanitizeDaemonScopeKey`, `resolveWorktreeEnvAndCwd` |
| `src/executors/node-runner-driver.ts` | `class` | `NodeRunnerDriver` (implementing `RunnerDriver` with `withSlot` and `withDaemonSlot`) |
| `src/executors/local-command-executors.ts` | `function` | `executeLocalCommandStep`, `executeLocalCommandCheck`, `createLocalCommandToolDriver` |
| `src/executors/local-stream-check-executors.ts` | `function` | `executeLocalStreamCheck`, `createLocalStreamCheckToolDriver` |
| `src/executors/local-daemon-service.ts` | `function` | `startLocalDaemonService`, `createLocalServiceToolDriver` |
| `src/executors/internal/pty-framed-session.ts` | `class` | `PtyFramedInteractiveSession` |
| `src/executors/node-guard-and-control-plane-executors.ts` | `function` | `evaluateNodeAllowBinariesGuard`, `evaluateNodeDenyNetworkGuard`, `createNodeHttpControlPlaneAdapter`, `createNodeMcpStdioAdapter`, `createNodeMcpSseAdapter` |
| `src/executors/node-executors.constants.ts` | `const` | `nodeExecutors: RuntimeExecutorRegistrySlice`, `createNodeExecutors` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `local`, `mcp`, `nodeExecutors`, `createNodeExecutors`, `NodeRunnerDriver`, `sanitizeDaemonScopeKey`, `LocalCommandBuilder`, `LocalStreamCheckBuilder`, `LocalDaemonBuilder`, and all `Node*` / `Local*` AST node types from `@harness-dsl/core` |

---

## 4. Detailed Implementation Requirements

### 4.1 `local.runner({ id?, slots, maxDaemons? })` & `NodeRunnerDriver` (`SPEC.md` §4.2 line 2783)
- Compiles to `NodeRunnerNode` (`readonly type: 'node:runner'`, defaulting `id` to `'default-runner'` and `maxDaemons` to `slots`).
- Separates one-shot command semaphores (`withSlot`, used by `local.command` and `local.streamCheck`) from long-lived daemon semaphores (`withDaemonSlot`, used by `local.daemon`) so active daemons never starve one-shot verification commands.
- All subprocesses execute with `cwd: scopeHandle.worktreePath` and isolated `GIT_*` environment variables when `scopeHandle` has a `worktreePath` (falling back to the host root), resolve `EnvRef` values via `ctx.resolveEnv`, and terminate their detached process group (`SIGTERM` $\to$ grace window $\to$ `SIGKILL`) immediately when `ctx.signal` (`AbortSignal`) fires (`docs/CODING_GUIDELINES.md` Rule 5.3).

### 4.2 `local.command(id)` (`SPEC.md` §4.2 line 2784)
- Fluent methods: `.runner(runner)`, `.stdin('closed' | mapper)`, `.env(record)`, `.argv(arrayOrMapper)`, `.timeoutMinutes(minutes)`, `.input(schema)` (defaults to `z.unknown()`), `.output(schema)` (defaults to `z.unknown()`), `.unrepeatable(preCheckCmd, { key })`, `.asCheck()`, `.asTool()`.
- Step execution (`steps['node:command']`):
  - Acquires slot via `ctx.getRunner(node.runner).withSlot(...)`.
  - If `node.unrepeatable` is configured, executes `preCheckCmd` first; if `preCheckCmd` returns `true`, skips execution as a no-op success.
  - Enforces `stdinMode: 'closed'` (`stdio: ['ignore', 'pipe', 'pipe']`) or writes the mapped `string | Uint8Array` buffer and closes `stdin`.
  - Non-zero exit codes throw an actionable error with `exitCode`, `stdout`, and `stderr`; exit code `0` trims `stdout`, parses JSON if valid (or falls back to trimmed string / `undefined` when empty), and validates via `node.outputSchema.parse(rawOutput)`.
- `.asTool()` (`tools['node:command-tool']`):
  - Defaults `inputSchema` to `z.object({})` when `argv` is a static array (or uses `.input()` schema when `argv` is a mapper function).
  - Sets `effectTracking: 'subprocess-post-flight'` and **omits** `ToolDriver.describeEffects` so `CheckpointableScope.diffEffects()` verifies workspace changes post-flight.

### 4.3 `local.streamCheck(id)` (`SPEC.md` §4.2 line 2785)
- Fluent methods: `.runner(runner)`, `.argv(argv)`, `.env(record)`, `.timeoutMinutes(minutes)`, `.circuitBreakWhenStdout(regex, { graceLinesAfterMatch })`, `.asTool()`.
- Streams `stdout` and `stderr` into a combined rolling multi-line buffer.
- When `circuitBreaker` matches across the rolling `stdout`/`stderr` buffer, collects `graceLinesAfterMatch` additional lines, kills the process group (`SIGTERM` $\to$ `SIGKILL`), and returns `{ ok: false, deficits: [matchedExcerpt] }`.
- `.asTool()` (`tools['node:stream-check-tool']`) sets `effectTracking: 'subprocess-post-flight'` and omits `describeEffects`.

### 4.4 `local.daemon(id)` (`SPEC.md` §4.2 line 2786)
- Fluent methods: `.runner(runner)`, `.lifecycle('scope' | 'fork' | 'skill')`, `.port(name)`, `.start(fn)`, `.stopCommand(fn)`, `.readyWhenStdout(regex)`, `.interact(toolName, { description?, inputSchema?, command, frameDelimiter, idleSettleMs, timeoutSeconds })`.
- Populates `toolSchemas` up front on `LocalServiceNode` and emits `LocalServiceToolNode` descriptors (`type: 'node:service-tool'`, `effectTracking: 'subprocess-post-flight'`, `serviceId: id`) dispatched via `tools['node:service-tool']` to `ctx.activeServiceSessions?.get(toolNode.serviceId)?.invokeTool(toolNode.name, args, ctx)`.
- **Scope Key Sanitization (`sanitizeDaemonScopeKey`)**: replaces characters outside `[a-zA-Z0-9_.-]` with `_` and appends `-${sha256(rawScopeKey).slice(0, 8)}` so `run#1` and `run_1` never collide.
- **Pre-Start Orphan Reaping & Readiness**:
  - Allocates dynamic conflict-free TCP ports for every declared `.port(name)`.
  - Executes `.stopCommand` best-effort before `.start()` to reap crash-orphaned containers.
  - Evaluates `.readyWhenStdout(regex)` over a rolling multi-line window across combined `stdout` and `stderr`, then verifies TCP listener readiness across all declared `.port()` ports before resolving `ServiceSession`.
- **PTY `ECHO`-Disabled Framed Interactive Sessions (`PtyFramedInteractiveSession`)**:
  - Spawns `interaction.command` with `ECHO` disabled (`stty -echo` / PTY wrapper) so interactive CLIs emit prompts without echoing input.
  - Serializes turns per session: drains initial startup banner until `frameDelimiter` matches and output settles for `idleSettleMs`, writes `${args.input}\n`, and resolves once `frameDelimiter` matches and output settles for `idleSettleMs` within `timeoutSeconds`.
- **Stop Teardown**: executes `.stopCommand`, sends `SIGTERM` $\to$ `SIGKILL` to the process group, and releases ports only after exit.

---

## 5. Deterministic Test Suite Architecture (`packages/node/test/**`)

| File Path | Line Ceiling | Required Deterministic Test Cases |
| :--- | :--- | :--- |
| `test/fixtures/sample-node-daemons.ts` | `<= 250` | Real local Node child-process scripts simulating CLI commands, failing multi-line test runners, TCP daemons, and interactive REPLs (`psql` / `cdp>` prompts). |
| `test/local-runner-and-command.test.ts` | `<= 400` | Verifies `local.runner` separate `slots` vs `maxDaemons` concurrency, `local.command` (`stdin: 'closed'`, JSON/text output parsing, `.unrepeatable(preCheckCmd, { key })` skip when `preCheckCmd` returns `true`, non-zero exit error diagnostics, `.asCheck()`, and `.asTool()` with `effectTracking: 'subprocess-post-flight'` and omitted `describeEffects`). |
| `test/local-stream-check.test.ts` | `<= 400` | Verifies `local.streamCheck` rolling multi-line `stdout`+`stderr` circuit breaker (`graceLinesAfterMatch: 25`), immediate process-group termination on match, and `.asTool()` post-flight tracking. |
| `test/local-daemon-and-mcp.test.ts` | `<= 400` | Verifies `sanitizeDaemonScopeKey` (`run#1` vs `run_1`), pre-start `.stopCommand()` execution, dynamic `.port()` allocation + `.readyWhenStdout()` + TCP readiness check, `.interact()` framed REPL turns without echoed input, `ServiceSession.stop()` process-group teardown, `local.allowBinaries`, `local.denyNetwork`, and `mcp.server` / `local.mcpStdio` / `local.mcpSse`. |

---

## 6. Verification Gate Commands

Run from workspace root:

```bash
pnpm --filter @harness-dsl/node typecheck
pnpm --filter @harness-dsl/node test -- --reporter=verbose
test -z "$(git status --porcelain -- packages/core packages/sqlite packages/postgres packages/fs packages/markdown packages/git packages/claude packages/openai packages/gemini packages/github packages/slack packages/stripe packages/netsuite packages/integration)"
```
