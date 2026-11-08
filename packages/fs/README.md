# `@paraharness/fs`

Workspace-jailed filesystem tools, glob effect matchers, pre/post-flight write policy guards, file-count quota tripwires, regex checks, and content-addressed JSONL lesson stores for ParaHarness.

- **Full API Reference:** [https://paraharness.github.io/paraharness/modules/_paraharness_fs.html](https://paraharness.github.io/paraharness/modules/_paraharness_fs.html)

## Installation

```bash
pnpm add @paraharness/fs @paraharness/core zod
```

## Usage

```ts
import { fs, fsExecutors } from '@paraharness/fs';
import { local } from '@paraharness/node';

const runner = local.runner({ slots: 4 });
const tools = fs.codingTools(runner);
const protectIndex = fs.writeGuard({
  denyGlobs: ['packages/*/src/index.ts'],
  onlyExistingAtBaseRef: true,
});
const tripwire = fs.maxFilesMutated(6);
```

## Key Exports

| Export | Description |
| :--- | :--- |
| `fs.codingTools(runner)`, `fs.readOnlyTools(runner)` | Symlink-safe, worktree-jailed file and search tool AST tuples |
| `fs.text(path)`, `fs.glob(pattern)` | File and glob `SourceASTNode` builders with SHA-256 content digests |
| `fs.partitionMap(topology, map)`, `fs.inPartition(map, id)` | Maps logical `P.topology` partitions to filesystem globs and boundary files |
| `fs.writeGuard(opts)`, `fs.boundaryGuard(map)`, `fs.protect(globs)`, `fs.readOnly()`, `fs.allowOnly(globs)`, `fs.requireReadBeforeWrite()`, `fs.scopedWrite(map)`, `fs.secretLiterals(patterns?)` | Pre-flight and post-flight filesystem policy guard AST nodes |
| `fs.allowWriteGlobs(globs)` | Produces a serializable `LeaseDelta` unlocking matching paths/globs |
| `fs.maxFilesMutated(count)` | Builds `FsQuotaTripwireNode` (`type: 'fs:quota-tripwire'`) |
| `fs.regexCheck(id, opts)` | Builds `FsRegexCheckNode` (`type: 'fs:regex-check'`) over mutated files |
| `fs.jsonlLessonStore(opts)` | Builds host-root atomic `FsJsonlLessonStoreNode` (`type: 'fs:jsonl-lesson-store'`) |
| `fs.telemetry()` | Builds `FsTelemetryCollectorNode` (`type: 'fs:telemetry'`) |
| `fsExecutors` | Runtime executor and driver registrations for all `fs:*` AST nodes |

## License

[MIT](./LICENSE) © Tornike Tsomaia
