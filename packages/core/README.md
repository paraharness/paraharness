# `@paraharness/core`

Core declarative pure-AST DSL builders (`P.*`), runtime port contracts, and the default `@paraharness/core/runtime` execution engine for ParaHarness.

- **Full API Reference:** [https://paraharness.github.io/paraharness/modules/_paraharness_core.html](https://paraharness.github.io/paraharness/modules/_paraharness_core.html)

## Installation

```bash
pnpm add @paraharness/core zod
```

## Overview

`@paraharness/core` provides two entrypoints:
- `@paraharness/core`: Pure passive AST node contracts (`CoreASTNode`, `DomainASTNode`, `CustomDomainASTRegistry`), fluent `P.*` builders (`P.agent`, `P.loop`, `P.flow`, `P.lane`, `P.harness`, `P.policy`, `P.prefixGroup`, `P.topology`, `P.rules`, `P.scopedRule`, `P.skill`, `P.lessons`, `P.pool`, `P.signal`, `P.interrupt`, `P.stream`, `P.human`, `P.command`, `P.env`), and runtime driver/store port interfaces.
- `@paraharness/core/runtime`: Default execution engine (`createRuntime`, `createExecutorRegistry`, `executeStepNode`, `executeAgent`, `executeLoop`, `executeCommand`, `executeFlow`, `LaneScheduler`, `ScopeLockManager`, `StepContinuationQueue`, `PoolManager`, `ServiceSessionRegistry`).

## Usage

```ts
import { P, z } from '@paraharness/core';
import { createExecutorRegistry, createRuntime } from '@paraharness/core/runtime';

const taskSignal = P.signal('task-updated').payload(z.object({ id: z.string() }));
const verifyCmd = P.command('verify-input', {
  input: z.object({ id: z.string() }),
  output: z.object({ ok: z.boolean() }),
  fn: async (input) => ({ ok: input.id.length > 0 }),
});
```

## Key Exports

| Export | Entrypoint | Description |
| :--- | :--- | :--- |
| `P` | `@paraharness/core` | Root fluent DSL namespace for compiling passive AST nodes |
| `extractAST` | `@paraharness/core` | Unwraps `TNode | AstBuilder<TNode>` into a frozen AST node |
| `dependentsOf`, `affectedBy` | `@paraharness/core` | Transitive partition dependency queries over `TopologyNode` |
| `createExecutorRegistry` | `@paraharness/core/runtime` | Merges peer adapter executor partials into a `RuntimeExecutorRegistry` |
| `createRuntime` | `@paraharness/core/runtime` | Instantiates a durable `HarnessRuntime` for a compiled `HarnessNode` |

## License

[MIT](./LICENSE) © Tornike Tsomaia
