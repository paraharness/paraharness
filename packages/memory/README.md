# @paraharness/memory

Unified Memory Harness for [Paraharness](https://github.com/paraharness/paraharness). This package provides Zod-validated schemas, port contracts, 4-way path/glob context scope matching, capacity bucket resolution, atomic JSONL ledger persistence with monotonic high-water-mark metadata, 4-mode note lifecycles, Git 3-way ledger reconciliation, and hook path extraction for agentic engineering workflows.

## Installation

With npm:

```bash
npm install @paraharness/memory
```

With yarn:

```bash
yarn add @paraharness/memory
```

With pnpm:

```bash
pnpm add @paraharness/memory
```

## Usage

```ts
import {
  MemoryConfigSchema,
  MemoryRecordSchema,
  extractTouchedPathsFromHookInput,
} from '@paraharness/memory';

const config = MemoryConfigSchema.parse({
  repoId: 'paraharness',
  allowedRoles: ['general', 'builder', 'reviewer'],
});

const touched = extractTouchedPathsFromHookInput({
  tool_name: 'Read',
  tool_input: {
    file_path: 'packages/memory/src/index.ts',
  },
});
```

## Documentation

See the [`@paraharness/memory` API Reference](https://paraharness.github.io/paraharness/modules/_paraharness_memory.html) for full type and schema specifications.

## License

[MIT](./LICENSE) © Tornike Tsomaia
