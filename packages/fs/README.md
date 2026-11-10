# @paraharness/fs

Workspace-jailed filesystem tools, glob effect matchers, pre-flight and post-flight write policy guards, file-count quota tripwires, regex checks, and content-addressed JSONL lesson stores for [Paraharness](https://github.com/paraharness/paraharness). This package provides symlink-safe file reading, editing, and search tools alongside declarative `fs.*` guards that enforce partition boundaries and test ratchets inside `P.policy`.

## Installation

With npm:

```bash
npm install @paraharness/fs @paraharness/core zod
```

With yarn:

```bash
yarn add @paraharness/fs @paraharness/core zod
```

With pnpm:

```bash
pnpm add @paraharness/fs @paraharness/core zod
```

## Usage

```ts
import { P, z } from '@paraharness/core';
import { createExecutorRegistry } from '@paraharness/core/runtime';
import { claude, claudeExecutors } from '@paraharness/claude';
import { fs, fsExecutors } from '@paraharness/fs';
import { local, nodeExecutors } from '@paraharness/node';

const runner = local.runner({ slots: 4 });
const sonnet = claude.model('sonnet', { id: 'claude-sonnet-4-6' });

const leaseRequest = P.interrupt(
  'lease-request',
  z.object({
    requestedPaths: z.array(z.string()),
    justification: z.string(),
  }),
);

const workerPolicy = P.policy('worker-policy')
  .guard(
    fs.protect(['packages/*/src/index.ts', 'PRODUCT_SPEC.md']),
    fs.requireReadBeforeWrite(),
    fs.secretLiterals(),
  )
  .onViolation('deny-with-error')
  .guard(
    fs.writeGuard({
      denyGlobs: ['**/*.test.ts', '**/*.test.tsx'],
      onlyExistingAtBaseRef: true,
    }),
  )
  .onViolation('raise-interrupt', leaseRequest, (violation) => ({
    requestedPaths: fs.violatedPaths(violation),
    justification: violation.violationSummary,
  }))
  .tripwire(fs.maxFilesMutated(6));

const worker = P.agent('worker')
  .model(sonnet)
  .policy(workerPolicy)
  .tools(fs.codingTools(runner))
  .instructions(fs.text('.harness/prompts/worker.md'))
  .input(z.object({ prompt: z.string() }))
  .output(z.object({ summary: z.string() }));

const registry = createExecutorRegistry(claudeExecutors, fsExecutors, nodeExecutors);
```

## Documentation

See the [`@paraharness/fs` API Reference](https://paraharness.github.io/paraharness/modules/_paraharness_fs.html) for full type and builder specifications.

## License

[MIT](./LICENSE) © Tornike Tsomaia
