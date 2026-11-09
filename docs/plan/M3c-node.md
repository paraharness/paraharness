# Milestone M3c — `@paraharness/node` OS Subprocesses, Stream Checks, Daemons & MCP Control Plane

## 1. Scope & Ownership (`owned_dirs` & `forbidden_dirs`)

- **Milestone**: `M3c` (Wave 2 — Parallel Adapter Fan-Out `c`, depends on `M1`)
- **Package**: `@paraharness/node` (`packages/node`)
- **`owned_dirs`**:
  - `packages/node/src/**`
  - `packages/node/test/**`
- **`forbidden_dirs`**:
  - `packages/core/**`, `packages/lockfile/**`
  - `packages/{sqlite,postgres,fs,markdown,git,claude,openai,gemini,github,slack,stripe,netsuite,integration}/**`
  - Root workspace configs (`package.json`, `eslint.config.mjs`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.ts`) and `docs/**`
- **Cross-Adapter Independence Rule**:
  - `@paraharness/node` must have **zero runtime or type imports** from any other M3 adapter package. It depends exclusively on `@paraharness/core` (`workspace:*`), `node-pty`, `@modelcontextprotocol/sdk`, `pidtree`, `fkill`, `get-port`, `wait-on`, `p-queue`, `p-limit`, `zod`, and Node built-ins (`node:child_process`, `node:net`, `node:http`, `node:crypto`, `node:events`).

### Approved External Libraries & Native Primitives (`CLAUDE.MD` #2 & `docs/CODING_GUIDELINES.md` Rule 3.5)

| Concern | Selected Package / Built-in | Version & License | Evaluated Alternatives & Rejection Reason | Lifecycle & Native/WASM Trade-offs | Owner Approval Status |
| :--- | :--- | :--- | :--- | :--- | :--- |
| Interactive PTY daemon sessions (`local.daemon(...).interact(...)`) | `node-pty` | `^1.1.0` (npm `1.1.0`, `MIT`, `0` deprecated, `0` CVEs) | `child_process.spawn` with `script`/`stty` shell wrappers (fragile across macOS BSD vs Linux `util-linux` flags and forbidden by Rule 3.5) | Native POSIX/ConPTY pseudoterminal addon; disable echo via `stty -echo` initialization, serialize interactive turns via `p-queue` (`concurrency: 1`), and call `ptyProcess.kill()` inside `try / finally` | Approved (`Rule 3.5`) |
| MCP stdio & SSE control-plane protocol (`local.mcpStdio`, `local.mcpSse`) | `@modelcontextprotocol/sdk` (`Server`, `StdioServerTransport`, `SSEServerTransport`) | `^1.32.2` (npm `1.32.2`, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled JSON-RPC 2.0 stdio/SSE framing (forbidden by Rule 3.5) | Official MCP TypeScript SDK; normalize incoming `'data'` stream chunks to `Buffer` and never call `setEncoding('utf8')` on `Readable` streams passed to `StdioServerTransport` (`docs/lessons/BUILDER.md`); close server in `try / finally` | Approved (`Rule 3.5`) |
| Descendant process-tree enumeration & graceful/forceful teardown (`terminateProcessGroupWithGrace`) | `pidtree` (`^1.0.0`, `MIT`) + `fkill` (`^10.0.3`, `MIT`) | npm `1.0.0` & `10.0.3` (`0` deprecated, `0` CVEs) | `tree-kill` (unmaintained since 2021 with shell-injection / zombie-reaping issues); hand-rolled `ps` parser (forbidden by Rule 3.5) | Enumerates full descendant PID tree via `pidtree`, sends `SIGTERM`, awaits grace window, and force-kills remaining PIDs via `fkill(..., { force: true, silent: true })` | Approved (`Rule 3.5`) |
| Ephemeral conflict-free TCP port allocation (`local.daemon(...).port(...)`) | `get-port` (`getPort`) | `^7.2.0` (npm `7.2.0`, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled `net.createServer().listen(0)` port prober (forbidden by Rule 3.5) | Pure ESM dynamic port allocator with exclusion set support so multi-port daemons never receive duplicate ports | Approved (`Rule 3.5`) |
| TCP listener readiness verification (`waitForTcpPortReady`) | `wait-on` (`+ @types/wait-on` `^5.3.4`, `MIT`) | `^9.5.1` (npm `9.5.1`, `MIT`, `0` deprecated, `0` CVEs; `@types/wait-on` `^5.3.4`, `MIT`) | Hand-rolled `net.Socket` polling loop (forbidden by Rule 3.5) | Polls `tcp:127.0.0.1:${port}` after `.readyWhenStdout(regex)` matches before resolving `ServiceSession` | Approved (`Rule 3.5`) |
| Runner slot & PTY turn serialization (`NodeRunnerDriver`, `PtyFramedInteractiveSession`) | `p-queue` (`^9.1.0`, `MIT`) + `p-limit` (`^7.3.0`, `MIT`) | `p-queue` `^9.1.0` (`9.3.5` locked in `pnpm-lock.yaml`; npm `10.0.0` — pinned to `^9.1.0` / `9.3.5` for Node `>=22.0.0` engine compatibility and `PQueue` `idle`/`next` event semantics without mutating locked workspace manifests) & `p-limit` `^7.3.0` (npm `7.3.3`, `0` deprecated, `0` CVEs) | Hand-rolled semaphore queues (forbidden by Rule 3.5) | Separates one-shot command concurrency (`withSlot`) from long-lived daemon concurrency (`withDaemonSlot`); queued-wait-only `AbortSignal` handling (`docs/lessons/BUILDER.md`) | Approved (`Rule 3.5`) |
| Command & interaction input/output validation | `zod` | `^4.6.7` (npm `4.6.7`, `MIT`, `0` deprecated, `0` CVEs) | Hand-rolled validation (forbidden by Rule 3.5) | Pure TypeScript runtime validation | Approved (`Rule 3.5`) |

---

## 2. Normative Specification & Coding Sample Grounding

| Normative Source | Section & Exact Line Range | Grounded Scope in `M3c` |
| :--- | :--- | :--- |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §1.1–§1.2 (`lines 3–34`) | Pure passive AST nodes (`NodeRunnerNode`, `LocalCommandNode`, `LocalCommandCheckNode`, `LocalCommandToolNode`, `LocalStreamCheckNode`, `LocalStreamCheckToolNode`, `LocalServiceNode`, `LocalServiceToolNode`, `NodeAllowBinariesNode`, `NodeDenyNetworkNode`, `NodeHttpControlPlaneNode`, `NodeMcpStdioNode`, `NodeMcpSseNode`) and late-bound `EnvRef` resolution via `ctx.resolveEnv`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §2.2–§2.4 (`lines 682–1474`) | `BaseRunnerPoolASTNode`, `BaseDomainStepASTNode`, `BaseCheckASTNode`, `BaseToolASTNode` (`effectTracking: 'subprocess-post-flight'`), `BaseServiceASTNode`, `BasePolicyGuardASTNode`, `BaseControlPlaneASTNode`, `RunnerDriver`, `ToolDriver` (omitting `describeEffects` on `'subprocess-post-flight'` tools), `ServiceSession`, `ControlPlaneAdapter`, `RuntimeExecutorRegistrySlice`. |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §3.4.2 & §3.5 (`lines 2279–2342`) | Service lifecycle (`'scope' \| 'fork' \| 'skill'`), `LocalServiceNode.toolSchemas` up-front wire registration, and post-flight subprocess sandboxing (`effectTracking: 'subprocess-post-flight'`). |
| [`docs/SPEC.md`](file:///Users/torniketsomaia/projects/metaharness/docs/SPEC.md) | §4.2 (`lines 2713–2825`) | Complete `@paraharness/node` specification: `local.runner({ id?, slots, maxDaemons? })`, `local.command(id)` (`.runner()`, `.stdin()`, `.env()`, `.argv()`, `.timeoutMinutes()`, `.input()`, `.output()`, `.unrepeatable(preCheckCmd, { key })`, `.asCheck()`, `.asTool()`), `local.streamCheck(id)` (`.runner()`, `.argv()`, `.env()`, `.timeoutMinutes()`, `.circuitBreakWhenStdout(regex, { graceLinesAfterMatch })`, `.asTool()`), `local.daemon(id)` (`.runner()`, `.lifecycle()`, `.port()`, `.start()`, `.stopCommand()`, `.readyWhenStdout()`, `.interact()`, `${sanitizedPrefix}-${sha256(rawScopeKey).slice(0, 8)}`, pre-start `.stopCommand()` cleanup, TCP readiness verification, PTY `ECHO`-disabled framed interaction), `local.allowBinaries(bins)`, `local.denyNetwork()`, `mcp.server({ port })`, `local.mcpStdio(...)`, `local.mcpSse(...)`. |
| [`docs/CODING_SAMPLE.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_SAMPLE.md) | §6 (`lines 185, 322, 370–430, 505–510, 609–610, 620, 727, 730, 981, 1002–1030, 1194, 1205`) | All `local.*` and `mcp.*` usages in `engineering-harness.ts`. |

---

## 3. Planned Module Decomposition & Public Exports (`packages/node/src/**`)

Every file, class, method, and function in `packages/node/src/**` and `packages/node/test/fixtures/**` adheres to [`docs/CODING_GUIDELINES.md`](file:///Users/torniketsomaia/projects/metaharness/docs/CODING_GUIDELINES.md) §§1–5: each file, class, method, and function has **one clear responsibility at one uniform level of abstraction** (Rules 1.1–1.8 & 3.1–3.4), single-kind entity files per Rule 1.1, 1 root `interface` per file plus reachable `TSPropertySignature` / `TSMethodSignature` sub-interfaces per Rule 1.2, 1 `class` per file with optional co-located dedicated 1:1 `*Params`/`*Options` interfaces per Rule 1.3, 1 builder factory function per `create-*.ts` file with optional co-located dedicated 1:1 `*Params`/`*Options` interfaces per Rules 1.6 & 3.3, pure `src/index.ts` barrel, complete `/** ... */` JSDoc on every declaration per Rules 2.1–2.3, and zero inline/non-JSDoc comments per Rule 2.4. Orchestrators only sequence high-level phase calls and lifecycle boundaries (`try / finally`), delegating subprocess spawning, process-tree termination, port allocation, readiness verification, and PTY framing to focused `internal/` functions. Builders are free and expected to extract additional focused `internal/` phase, predicate, and projection helper files beyond the baseline §3 table whenever responsibilities separate, while preserving all planned public exports.

| File Path | Primary Category | Exported Symbols |
| :--- | :--- | :--- |
| `src/builders/local-runner-builder.ts` | `interface` | `LocalRunnerBuilder` |
| `src/builders/create-local-runner-builder.ts` | `function` | `createLocalRunnerBuilder` |
| `src/builders/local-command-builder.ts` | `interface` | `LocalCommandBuilder<TIn, TOut, THandle>` (plus `TSMethodSignature` sub-interface `LocalCommandUnrepeatableOptions`) |
| `src/builders/create-local-command-builder.ts` | `function` | `createLocalCommandBuilder` |
| `src/builders/local-stream-check-builder.ts` | `interface` | `LocalStreamCheckBuilder<THandle>` (plus `TSMethodSignature` sub-interface `LocalStreamCheckCircuitBreakerOptions`) |
| `src/builders/create-local-stream-check-builder.ts` | `function` | `createLocalStreamCheckBuilder` |
| `src/builders/local-daemon-builder.ts` | `interface` | `LocalDaemonBuilder` (plus `TSMethodSignature` sub-interface `LocalDaemonInteractOptions<TInput>`) |
| `src/builders/create-local-daemon-builder.ts` | `function` | `createLocalDaemonBuilder` |
| `src/builders/create-allow-binaries-builder.ts` | `function` | `createAllowBinariesBuilder` |
| `src/builders/create-deny-network-builder.ts` | `function` | `createDenyNetworkBuilder` |
| `src/builders/create-mcp-server-builder.ts` | `function` | `createMcpServerBuilder` |
| `src/builders/create-mcp-stdio-builder.ts` | `function` | `createMcpStdioBuilder` |
| `src/builders/create-mcp-sse-builder.ts` | `function` | `createMcpSseBuilder` |
| `src/builders/local-namespace-contract.ts` | `interface` | `LocalNamespace` (plus `TSMethodSignature` sub-interface `LocalRunnerOptions`) |
| `src/builders/local-namespace.ts` | `const` | `local: LocalNamespace` |
| `src/builders/mcp-namespace-contract.ts` | `interface` | `McpNamespace` (plus `TSMethodSignature` sub-interface `McpServerOptions`) |
| `src/builders/mcp-namespace.ts` | `const` | `mcp: McpNamespace` |
| `src/executors/node-subprocess-env.constants.ts` | `const` | `ISOLATED_GIT_ENV_OVERRIDES`, `DEFAULT_SUBPROCESS_GRACE_MS` |
| `src/executors/internal/process-group-lifecycle.ts` | `function` | `spawnDetachedSubprocess`, `terminateProcessGroupWithGrace`, `resolveWorktreeEnvAndCwd` (backed by `pidtree` and `fkill`) |
| `src/executors/internal/daemon-ports-and-scope-key.ts` | `function` | `allocateDynamicPorts`, `waitForTcpPortReady`, `sanitizeDaemonScopeKey` (backed by `get-port` and `wait-on`) |
| `src/executors/node-runner-driver.ts` | `class` | `NodeRunnerDriver` (implementing `RunnerDriver` with `withSlot` and `withDaemonSlot` backed by `p-limit` / `p-queue`) |
| `src/executors/local-command-executors.ts` | `function` | `executeLocalCommandStep`, `executeLocalCommandCheck`, `createLocalCommandToolDriver` |
| `src/executors/local-stream-check-executors.ts` | `function` | `executeLocalStreamCheck`, `createLocalStreamCheckToolDriver` |
| `src/executors/local-daemon-service.ts` | `function` | `startLocalDaemonService`, `createLocalServiceToolDriver` |
| `src/executors/internal/pty-framed-session.ts` | `class` | `PtyFramedInteractiveSession` (backed by `node-pty` and `p-queue`) |
| `src/executors/node-guard-executors.ts` | `function` | `evaluateNodeAllowBinariesGuard`, `evaluateNodeDenyNetworkGuard` |
| `src/executors/node-control-plane-and-mcp-adapters.ts` | `function` | `createNodeHttpControlPlaneAdapter`, `createNodeMcpStdioAdapter`, `createNodeMcpSseAdapter` (backed by `@modelcontextprotocol/sdk`) |
| `src/executors/create-node-executors.ts` | `function` | `createNodeExecutors` |
| `src/executors/node-executors.constants.ts` | `const` | `nodeExecutors: RuntimeExecutorRegistrySlice` |
| `src/index.ts` | `barrel` | Pure explicit re-exports of `local`, `LocalNamespace`, `mcp`, `McpNamespace`, `nodeExecutors`, `createNodeExecutors`, `NodeRunnerDriver`, `sanitizeDaemonScopeKey`, `LocalRunnerBuilder`, `LocalRunnerOptions`, `LocalCommandBuilder`, `LocalCommandUnrepeatableOptions`, `LocalStreamCheckBuilder`, `LocalStreamCheckCircuitBreakerOptions`, `LocalDaemonBuilder`, `LocalDaemonInteractOptions`, `McpServerOptions`, all `create*` builder factories, and all `Node*` / `Local*` AST node types from `@paraharness/core` |

---

## 4. Detailed Implementation Requirements

### 4.0 Single-Kind File Separation, Co-Location & JSDoc Discipline (`docs/CODING_GUIDELINES.md` §§1–3)
1. **Single-Responsibility Decomposition, Single-Kind Entity Files & Co-Location (`Rules 1.1–1.8 & 3.1–3.4`)**:
   - Every file, class, method, and function in `packages/node/src/**` and `packages/node/test/fixtures/**` must have **one clear responsibility at one uniform level of abstraction** (`docs/CODING_GUIDELINES.md` §§1–3). Orchestrators only sequence high-level phase calls and lifecycle boundaries (`try / finally`), delegating context extraction, state initialization, lesson recall/scoring, iteration phases, and outcome projection to focused `internal/` functions. Builders are free and expected to extract additional focused `internal/` phase, predicate, and projection helper files beyond the baseline §3 table whenever responsibilities separate, while preserving all planned public exports.
   - Unrelated or different-kind declarations (`interface`, `function`, `class`, `const`, `type`) must **never** live in the same file in `packages/node/src/**` or `packages/node/test/fixtures/**`.
   - Each root `interface` (`*-builder.ts`, `local-namespace-contract.ts`, `mcp-namespace-contract.ts`) lives in its own single-interface file, co-locating secondary interfaces reachable via `TSPropertySignature` or `TSMethodSignature` parameter/return types (`LocalRunnerOptions`, `LocalCommandUnrepeatableOptions`, `LocalStreamCheckCircuitBreakerOptions`, `LocalDaemonInteractOptions<TInput>`, `McpServerOptions`) per Rule 1.2.
   - Every builder factory function (`create-*.ts`) gets its own focused file (`Rule 1.6`); `NodeRunnerDriver` and `PtyFramedInteractiveSession` each get their own single-class file; every `const` (`local`, `mcp`, `nodeExecutors`, `ISOLATED_GIT_ENV_OVERRIDES`) lives in its own `const`-only file.
2. **JSDoc Anatomy & Approved Library Mandate (`docs/CODING_GUIDELINES.md` §2 & Rule 3.5)**:
   - Use `node-pty` for PTY daemon sessions, `@modelcontextprotocol/sdk` for MCP stdio/SSE control-plane servers (normalizing incoming `'data'` stream chunks to `Buffer` and never calling `setEncoding('utf8')` on `Readable` streams passed to `StdioServerTransport` per `docs/lessons/BUILDER.md`), `pidtree` + `fkill` for process-tree teardown, `get-port` for dynamic port allocation, `wait-on` for TCP port readiness polling, and `p-queue` / `p-limit` for runner slot concurrency.
   - Every `class` (and its constructor, methods, and properties), `interface` (and its properties and methods), `function` (public and `internal/`), and top-level `type` alias or `const` in `src/**` and `test/fixtures/**` must carry a complete `/** ... */` JSDoc block per `docs/CODING_GUIDELINES.md` §2 (clear summary sentence, behavioral description when non-obvious, and complete `@template`, `@param {Type} name - Description`, `@returns {Type} Description`, and `@throws` / `@note` / `@example` tags where applicable, with zero inline or body comments), enforced by `pnpm --filter @paraharness/node lint`.

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

All `test/fixtures/**` files strictly obey single-entity-kind file separation, single responsibility at one level of abstraction, and complete §2 JSDoc:

| File Path | Primary Category | Required Deterministic Test Cases |
| :--- | :--- | :--- |
| `test/fixtures/sample-node-daemons.ts` | `fixture (function)` | Pure `function` helpers building real local Node child-process argv scripts simulating CLI commands, failing multi-line test runners, TCP daemons, and interactive REPLs (`psql` / `cdp>` prompts). |
| `test/local-runner-and-command.test.ts` | `test` | Verifies `local.runner` separate `slots` vs `maxDaemons` concurrency, `cwd: worktreePath` + all 9 `GIT_*` environment variables injection, `AbortSignal` immediate process-group termination + listener cleanup in `finally` (`CODING_GUIDELINES.md` Rule 5.3), `local.command` (`stdin: 'closed'`, JSON/text output parsing, `.unrepeatable(preCheckCmd, { key })` skip when `preCheckCmd` returns `true`, non-zero exit error diagnostics, `.asCheck()`, and `.asTool()` with `effectTracking: 'subprocess-post-flight'` and omitted `describeEffects`). |
| `test/local-stream-check.test.ts` | `test` | Verifies `local.streamCheck` rolling multi-line `stdout`+`stderr` circuit breaker (`graceLinesAfterMatch: 25`), immediate process-group termination on match, and `.asTool()` post-flight tracking. |
| `test/local-daemon-and-mcp.test.ts` | `test` | Verifies `sanitizeDaemonScopeKey` (`run#1` vs `run_1`), pre-start `.stopCommand()` execution, dynamic `.port()` allocation + `.readyWhenStdout()` + TCP readiness check, `.interact()` default `inputSchema`/`description`, framed REPL turns without echoed input, serialized concurrent turns per PTY session, `timeoutSeconds` enforcement, `ServiceSession.stop()` process-group teardown, `local.allowBinaries`, `local.denyNetwork`, and `mcp.server` / `local.mcpStdio` / `local.mcpSse`. |

---

## 6. Verification Gate Commands

Run from workspace root (plus the `IMPL_LOOP.md` `baseline_dirty` diff check against `<non_sibling_forbidden_dirs_excluding_upstream_patches>`):

```bash
pnpm --filter @paraharness/node lint
pnpm --filter @paraharness/node typecheck
pnpm --filter @paraharness/node test -- --reporter=verbose
test -z "$(git status --porcelain -- docs .agents .claude package.json tsconfig.base.json vitest.config.ts)"
```
