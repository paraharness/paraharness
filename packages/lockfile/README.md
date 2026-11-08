# `@paraharness/lockfile`

Cross-process advisory lockfile utility for ParaHarness with in-process `p-queue` FIFO serialization, atomic `wx` lockfile creation, `.unref()`ed `utimes` heartbeat, and dead-PID / stale-`mtime` lock reclamation.

- **Full API Reference:** [https://paraharness.github.io/paraharness/modules/_paraharness_lockfile.html](https://paraharness.github.io/paraharness/modules/_paraharness_lockfile.html)

## Installation

```bash
pnpm add @paraharness/lockfile
```

## Usage

```ts
import { withFileLock } from '@paraharness/lockfile';

const result = await withFileLock('/tmp/resource.lock', async () => {
  return 'locked-operation-complete';
});
```

## Key Exports

| Export | Description |
| :--- | :--- |
| `withFileLock(lockPath, fn, options?)` | Executes `fn` while holding an in-process and cross-process advisory lock on `lockPath` |
| `FileLockOptions` | Configuration for `staleMs`, `heartbeatMs`, `retryBaseMs`, `retryMaxMs`, and `timeoutMs` |

## License

[MIT](./LICENSE) © Tornike Tsomaia
