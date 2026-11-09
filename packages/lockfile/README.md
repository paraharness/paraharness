# @paraharness/lockfile

Cross-process advisory lockfile utility for [Paraharness](https://github.com/paraharness/paraharness). This package coordinates exclusive access to shared host files across concurrent processes and in-process async tasks using `p-queue` FIFO serialization, atomic `wx` lockfile creation, `.unref()`ed `utimes` heartbeats, and dead-PID or stale-`mtime` lock reclamation.

## Installation

With npm:

```bash
npm install @paraharness/lockfile
```

With yarn:

```bash
yarn add @paraharness/lockfile
```

With pnpm:

```bash
pnpm add @paraharness/lockfile
```

## Usage

```ts
import { withFileLock } from '@paraharness/lockfile';

const result = await withFileLock(
  '.harness/lessons.lock',
  async () => {
    return { updated: true };
  },
  {
    staleMs: 10_000,
    heartbeatMs: 2_000,
    timeoutMs: 30_000,
  },
);
```

## Documentation

See the [`@paraharness/lockfile` API Reference](https://paraharness.github.io/paraharness/modules/_paraharness_lockfile.html) for full type and builder specifications.

## License

[MIT](./LICENSE) © Tornike Tsomaia
