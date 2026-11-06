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
  - Root workspace configs (`package.json`, `eslint.config.mjs`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`) and `docs/**`
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

Every file in `packages/node/src/**` and `packages/node/test/fixtures/**` adheres to [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §1–§5 (`<= 250` lines per file, zero co-location of `interface` / `function` / `class` / `const` / `type`, strictly 1 top-level `interface` per file plus `TSPropertySignature` property sub-interfaces only, 1 `class` per file, 1 builder factory function per `create-*.ts` file, `internal/` helpers, pure `src/index.ts` barrel, full 3-part `/** ... */` JSDoc on every declaration and `TSMethodSignature`, and zero inline/non-JSDoc comments).

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/local-runner-options.ts` | `interface` | `LocalRunnerOptions` |
| `src/builders/local-runner-builder.ts` | `interface` | `LocalRunnerBuilder` |
| `src/builders/create-local-runner-builder.ts` | `function` | `createLocalRunnerBuilder` |
| `src/builders/local-command-unrepeatable-options.ts` | `interface` | `LocalCommandUnrepeatableOptions` |
| `src/builders/local-command-builder.ts` | `interface` | `LocalCommandBuilder<TIn, TOut, THandle>` |
| `src/builders/create-local-command-builder.ts` | `function` | `createLocalCommandBuilder` |
| `src/builders/local-stream-check-circuit-breaker-options.ts` | `interface` | `LocalStreamCheckCircuitBreakerOptions` |
| `src/builders/local-stream-check-builder.ts` | `interface` | `LocalStreamCheckBuilder<THandle>` |
| `src/builders/create-local-stream-check-builder.ts` | `function` | `createLocalStreamCheckBuilder` |
| `src/builders/local-daemon-interact-options.ts` | `interface` | `LocalDaemonInteractOptions<TInput>` |
| `src/builders/local-daemon-builder.ts` | `interface` | `LocalDaemonBuilder` |
| `src/builders/create-local-daemon-builder.ts` | `function` | `createLocalDaemonBuilder` |
| `src/builders/mcp-server-options.ts` | `interface` | `McpServerOptions` |
| `src/builders/create-allow-binaries-builder.ts` | `function` | `createAllowBinariesBuilder` |
| `src/builders/create-deny-network-builder.ts` | `function` | `createDenyNetworkBuilder` |
| `src/builders/create-mcp-server-builder.ts` | `function` | `createMcpServerBuilder` |
| `src/builders/create-mcp-stdio-builder.ts` | `function` | `createMcpStdioBuilder` |
| `src/builders/create-mcp-sse-builder.ts` | `function` | `createMcpSseBuilder` |
| `src/builders/local-namespace-contract.ts` | `interface` | `LocalNamespace` |
| `src/builders/local-namespace.ts` | `const` | `local: LocalNamespace` |
| `src/builders/mcp-namespace-contract.ts` | `interface` | `McpNamespace` |
| `src/builders/mcp-namespace.ts` | `const` | `mcp: McpNamespace` |
| `src/executors/node-subprocess-env.constants.ts` | `const` | `ISOLATED_GIT_ENV_OVERRIDES`, `DEFAULT_SUBPROCESS_GRACE_MS` |
| `src/executors/internal/process-group-lifecycle.ts` | `function` | `spawnDetachedSubprocess`, `terminateProcessGroupWithGrace`, `resolveWorktreeEnvAndCwd` |
| `src/executors/internal/daemon-ports-and-scope-key.ts` | `function` | `allocateDynamicPorts`, `waitForTcpPortReady`, `sanitizeDaemonScopeKey` |
| `src/executors/node-runner-driver.ts` | `class` | `NodeRunnerDriver` (implementing `RunnerDriver` with `withSlot` and `withDaemonSlot`) |
| `src/executors/local-command-executors.ts` | `function` | `executeLocalCommandStep`, `executeLocalCommandCheck`, `createLocalCommandToolDriver` |
| `src/executors/local-stream-check-executors.ts` | `function` | `executeLocalStreamCheck`, `createLocalStreamCheckToolDriver` |
| `src/executors/local-daemon-service.ts` | `function` | `startLocalDaemonService`, `createLocalServiceToolDriver` |
| `src/executors/internal/pty-framed-session.ts` | `class` | `PtyFramedInteractiveSession` |
| `src/executors/node-guard-executors.ts` | `function` | `evaluateNodeAllowBinariesGuard`, `evaluateNodeDenyNetworkGuard` |
| `src/executors/node-control-plane-and-mcp-adapters.ts` | `function` | `createNodeHttpControlPlaneAdapter`, `createNodeMcpStdioAdapter`, `createNodeMcpSseAdapter` |
| `src/executors/create-node-executors.ts` | `function` | `createNodeExecutors` |
| `src/executors/node-executors.constants.ts` | `const` | `nodeExecutors: RuntimeExecutorRegistrySlice` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `local`, `LocalNamespace`, `mcp`, `McpNamespace`, `nodeExecutors`, `createNodeExecutors`, `NodeRunnerDriver`, `sanitizeDaemonScopeKey`, `LocalRunnerBuilder`, `LocalRunnerOptions`, `LocalCommandBuilder`, `LocalCommandUnrepeatableOptions`, `LocalStreamCheckBuilder`, `LocalStreamCheckCircuitBreakerOptions`, `LocalDaemonBuilder`, `LocalDaemonInteractOptions`, `McpServerOptions`, all `create*` builder factories, and all `Node*` / `Local*` AST node types from `@harness-dsl/core` |

---

## 4. Detailed Implementation Requirements

### 4.0 Strict File Separation & Full 3-Part JSDoc (`docs/CODING_GUIDELINES.md` §§1–2)
1. **Zero Co-Location of Entity Kinds**:
   - `interface`, `function`, `class`, `const`, and `type` declarations must **never** live in the same file in `packages/node/src/**` or `packages/node/test/fixtures/**`.
   - Every builder interface (`*-builder.ts`), options interface (`*-options.ts`), and namespace contract (`local-namespace-contract.ts`, `mcp-namespace-contract.ts`) gets its own single-interface file; every builder factory function (`create-*.ts`) gets its own single-function file (and at most 4 cohesive functions `<= 40` lines each—or 1 function when `> 40` lines—per `function`-only file per Rule 1.6); `NodeRunnerDriver` and `PtyFramedInteractiveSession` each get their own single-class file; every `const` (`local`, `mcp`, `nodeExecutors`, `ISOLATED_GIT_ENV_OVERRIDES`) lives in its own `const`-only file.
2. **Full 3-Part JSDoc Requirement**:
   - Every `interface`, `class`, `function`, class method, **interface method signature (`TSMethodSignature`)**, `type`, and exported `const` in `src/**` and `test/fixtures/**` must carry full 3-part JSDoc per `docs/CODING_GUIDELINES.md` §2 (2-paragraph Summary + Detailed description separated by a blank `*` line, vertically aligned `@template` and `@param {Type} name - Description`, and `@returns {Type} Description`), enforced by `pnpm --filter @harness-dsl/node lint`.

### 4.1 `local.runner({ id?, slots, maxDaemons? })` & `NodeRunnerDriver` (`SPEC.md` §4.2 line 2783)
- Compiles to `NodeRunnerNode` (`readonly type: 'node:runner'`, defaulting `id` to `'default-runner'` and `maxDaemons` to `slots`).
- Separates one-shot command semaphores (`withSlot`, used by `local.command` and `local.streamCheck`) from long-lived daemon semaphores (`withDaemonSlot`, used by `local.daemon`) so active daemons never starve one-shot verification commands.
- All subprocesses execute with `cwd: scopeHandle.worktreePath` and all 9 isolated `GIT_*` environment variables (`GIT_CEILING_DIRECTORIES=<path.dirname(worktreePath)>`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_OPTIONAL_LOCKS=0`, `GIT_CONFIG_COUNT=2`, `GIT_CONFIG_KEY_0=commit.gpgsign`, `GIT_CONFIG_VALUE_0=false`, `GIT_CONFIG_KEY_1=core.hooksPath`, `GIT_CONFIG_VALUE_1=/dev/null`, `SPEC.md:3057`) when `scopeHandle` has a `worktreePath` (falling back to the host root), resolve `EnvRef` values via `ctx.resolveEnv`, and terminate their detached process group (`SIGTERM` $\to$ grace window $\to$ `SIGKILL`) immediately when `ctx.signal` (`AbortSignal`) fires while removing the `abort` listener in `finally` (`docs/CODING_GUIDELINES.md` Rule 5.3).

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
- Fluent methods: `.runner(runner)`, `.lifecycle('scope' | 'fork' | 'skill')`, `.port(name)`, `.start(fn)`, `.stopCommand(fn)`, `.readyWhenStdout(regex)`, `.interact(toolName, { description?, inputSchema?, command, frameDelimiter, idleSettleMs, timeoutSeconds })` (defaulting `inputSchema` to `z.object({ input: z.string() })` and `description` to `` `Interact with service via ${toolName}` `` when omitted).
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

### 4.5 Policy Guards & MCP Control Plane (`local.allowBinaries`, `local.denyNetwork`, `mcp.server`, `local.mcpStdio`, `local.mcpSse`, `SPEC.md` §4.2 lines 2770–2789)
- **`local.allowBinaries(bins)` (`NodeAllowBinariesNode`, `'node:allow-binaries'`) & `evaluateNodeAllowBinariesGuard`**:
  - Compiles to `NodeAllowBinariesNode` (`{ type: 'node:allow-binaries', id: 'node:allow-binaries:...', binaries: Object.freeze([...bins]) }`).
  - `evaluateNodeAllowBinariesGuard` inspects subprocess/command `ToolEffect` entries and rejects any invocation whose binary name/basename is not in `node.binaries`.
- **`local.denyNetwork()` (`NodeDenyNetworkNode`, `'node:deny-network'`) & `evaluateNodeDenyNetworkGuard`**:
  - Compiles to `NodeDenyNetworkNode` (`{ type: 'node:deny-network', id: 'node:deny-network' }`).
  - `evaluateNodeDenyNetworkGuard` blocks network-access effects and injects network-denying environment/sandbox flags on guarded subprocesses.
- **`mcp.server({ port })`, `local.mcpStdio(serverName)`, and `local.mcpSse({ port })` (`ControlPlaneAdapter`)**:
  - `mcp.server({ port })` compiles to `NodeHttpControlPlaneNode` (`'node:http-control-plane'`), `local.mcpStdio(serverName)` compiles to `NodeMcpStdioNode` (`'node:mcp-stdio'`), and `local.mcpSse({ port })` compiles to `NodeMcpSseNode` (`'node:mcp-sse'`).
  - `createNodeHttpControlPlaneAdapter`, `createNodeMcpStdioAdapter`, and `createNodeMcpSseAdapter` implement `ControlPlaneAdapter` (`start(controller)` returning `Promise<{ close(): Promise<void> }>`), exposing active runs (`controller.getActiveRuns()`) and external signal dispatch (`controller.emitSignal(signalId, payload)`).

---

## 5. Deterministic Test Suite Architecture (`packages/node/test/**`)

All `test/fixtures/**` files strictly obey single-entity-kind file separation (`<= 250` lines per file, full 3-part §2 JSDoc):

| File Path | Line Ceiling | Required Deterministic Test Cases |
| :--- | :--- | :--- |
| `test/fixtures/sample-node-daemons.ts` | `<= 250` | Pure `function` helpers building real local Node child-process argv scripts simulating CLI commands, failing multi-line test runners, TCP daemons, and interactive REPLs (`psql` / `cdp>` prompts). |
| `test/local-runner-and-command.test.ts` | `<= 400` | Verifies `local.runner` separate `slots` vs `maxDaemons` concurrency, `cwd: worktreePath` + all 9 `GIT_*` environment variables injection, `AbortSignal` immediate process-group termination + listener cleanup in `finally` (`CODING_GUIDELINES.md` Rule 5.3), `local.command` (`stdin: 'closed'`, JSON/text output parsing, `.unrepeatable(preCheckCmd, { key })` skip when `preCheckCmd` returns `true`, non-zero exit error diagnostics, `.asCheck()`, and `.asTool()` with `effectTracking: 'subprocess-post-flight'` and omitted `describeEffects`). |
| `test/local-stream-check.test.ts` | `<= 400` | Verifies `local.streamCheck` rolling multi-line `stdout`+`stderr` circuit breaker (`graceLinesAfterMatch: 25`), immediate process-group termination on match, and `.asTool()` post-flight tracking. |
| `test/local-daemon-and-mcp.test.ts` | `<= 400` | Verifies `sanitizeDaemonScopeKey` (`run#1` vs `run_1`), pre-start `.stopCommand()` execution, dynamic `.port()` allocation + `.readyWhenStdout()` + TCP readiness check, `.interact()` default `inputSchema`/`description`, framed REPL turns without echoed input, serialized concurrent turns per PTY session, `timeoutSeconds` enforcement, `ServiceSession.stop()` process-group teardown, `local.allowBinaries`, `local.denyNetwork`, and `mcp.server` / `local.mcpStdio` / `local.mcpSse`. |

---

## 6. Verification Gate Commands

Run from workspace root (plus the `IMPL_LOOP.md` `baseline_dirty` diff check against `<non_sibling_forbidden_dirs_excluding_upstream_patches>`):

```bash
pnpm --filter @harness-dsl/node lint
pnpm --filter @harness-dsl/node typecheck
pnpm --filter @harness-dsl/node test -- --reporter=verbose
test -z "$(git status --porcelain -- docs .agents .claude package.json tsconfig.base.json vitest.config.ts)"
```
