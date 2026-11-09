# @paraharness/node

Local OS subprocess runner pools, one-shot commands, circuit-breaking stream checks, framed PTY background daemons, and Model Context Protocol (MCP) control-plane adapters for [Paraharness](https://github.com/paraharness/paraharness). This package manages bounded concurrency slots for shell commands and interactive pseudo-terminal services (`node-pty`), rolling-window regex circuit breakers on `stdout`/`stderr`, and post-flight workspace mutation tracking.

## Installation

With npm:

```bash
npm install @paraharness/node @paraharness/core zod
```

With yarn:

```bash
yarn add @paraharness/node @paraharness/core zod
```

With pnpm:

```bash
pnpm add @paraharness/node @paraharness/core zod
```

## Usage

```ts
import { P, z } from '@paraharness/core';
import { createExecutorRegistry } from '@paraharness/core/runtime';
import { claude, claudeExecutors } from '@paraharness/claude';
import { local, mcp, nodeExecutors } from '@paraharness/node';

const runner = local.runner({ id: 'local-pool', slots: 8, maxDaemons: 4 });
const sonnet = claude.model('sonnet', { id: 'claude-sonnet-4-6' });

const verifySuite = local
  .streamCheck('verify-suite')
  .runner(runner)
  .argv(['pnpm', 'test', '--run'])
  .circuitBreakWhenStdout(/FAIL/, { graceLinesAfterMatch: 25 })
  .timeoutMinutes(5);

const worker = P.agent('worker')
  .model(sonnet)
  .tools(verifySuite.asTool())
  .beforeStop(verifySuite)
  .instructions('Run verification checks and ensure all tests pass before stopping.')
  .input(z.object({ taskId: z.string() }))
  .output(z.object({ passed: z.boolean() }));

const controlPlane = mcp.server({ port: 9100 });
const registry = createExecutorRegistry(claudeExecutors, nodeExecutors);
```

## Documentation

See the [`@paraharness/node` API Reference](https://paraharness.github.io/paraharness/modules/_paraharness_node.html) for full type and builder specifications.

## License

[MIT](./LICENSE) © Tornike Tsomaia
