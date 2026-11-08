# `@paraharness/node`

Local OS process runner pools, one-shot subprocess commands, circuit-breaking stream checks, framed PTY background daemons, and Model Context Protocol (MCP) control-plane adapters for ParaHarness.

- **Full API Reference:** [https://paraharness.github.io/paraharness/modules/_paraharness_node.html](https://paraharness.github.io/paraharness/modules/_paraharness_node.html)

## Installation

```bash
pnpm add @paraharness/node @paraharness/core zod
```

## Overview

Provides separate concurrency pools for one-shot commands (`slots`) and background daemons (`maxDaemons`), rolling-window regex circuit breakers on combined `stdout`/`stderr`, pseudo-terminal (`node-pty`) interactive service sessions with collision-free hashed `scopeKey`s and TCP readiness checks, and post-flight workspace mutation tracking (`effectTracking: 'subprocess-post-flight'`).

## Usage

```ts
import { local, mcp, nodeExecutors } from '@paraharness/node';

const runner = local.runner({ id: 'local-pool', slots: 8, maxDaemons: 4 });

const verifySuite = local
  .streamCheck('verify-suite')
  .runner(runner)
  .argv(['pnpm', 'test'])
  .circuitBreakWhenStdout(/FAIL/, { graceLinesAfterMatch: 25 });

const controlPlane = mcp.server({ port: 4100 });
```

## Key Exports

| Export | Description |
| :--- | :--- |
| `local.runner(opts)` | Builds `NodeRunnerNode` (`type: 'node:runner'`) managing command and daemon slots |
| `local.command(id)` | Builds `LocalCommandNode` (`type: 'node:command'`) with `.asCheck()` and `.asTool()` projections |
| `local.streamCheck(id)` | Builds `LocalStreamCheckNode` (`type: 'node:stream-check'`) with regex circuit-breaking and `.asTool()` |
| `local.daemon(id)` | Builds `LocalServiceNode` (`type: 'node:service'`) with dynamic ports and PTY `.interact()` tools |
| `local.allowBinaries(bins)`, `local.denyNetwork()` | Builds process policy guard AST nodes |
| `mcp.server(opts)`, `local.mcpStdio(name)`, `local.mcpSse(opts)` | Builds HTTP and MCP control-plane AST nodes |
| `nodeExecutors` | Runtime executor and driver registrations for all `node:*` AST nodes |

## License

[MIT](./LICENSE) © Tornike Tsomaia
