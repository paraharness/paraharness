# @paraharness/sqlite

WAL-mode SQLite runtime drivers and declarative `sqlite.*` builders for [Paraharness](https://github.com/paraharness/paraharness). This package provides single-node durable persistence for `LedgerStore`, Copy-on-Write `TopologyStore`, `LessonStore`, and relational global rules sources backed by `better-sqlite3`.

## Installation

With npm:

```bash
npm install @paraharness/sqlite @paraharness/core zod
```

With yarn:

```bash
yarn add @paraharness/sqlite @paraharness/core zod
```

With pnpm:

```bash
pnpm add @paraharness/sqlite @paraharness/core zod
```

## Usage

```ts
import { P, z } from '@paraharness/core';
import { createExecutorRegistry } from '@paraharness/core/runtime';
import { sqlite, sqliteExecutors } from '@paraharness/sqlite';

const TaskInput = z.object({
  id: z.string(),
  prompt: z.string(),
});

const ledger = sqlite
  .ledger('.harness/state.sqlite')
  .compactWhen(($c) =>
    $c
      .onTerminalExit(['done', 'cancelled'], { afterGracePeriodHours: 24 })
      .retainFailedRunsForDays(14),
  );

const repoTopology = P.topology('repo-topology')
  .store(sqlite.topologyStore('.harness/state.sqlite'))
  .partitions({
    db: {},
    api: { dependsOn: ['db'] },
  });

const repoLessons = P.lessons('repo-lessons')
  .store(sqlite.lessonStore('.harness/state.sqlite'))
  .queryFrom(TaskInput, (item) => item.prompt);

const registry = createExecutorRegistry(sqliteExecutors);
```

## Documentation

See the [`@paraharness/sqlite` API Reference](https://paraharness.github.io/paraharness/modules/_paraharness_sqlite.html) for full type and builder specifications.

## License

[MIT](./LICENSE) © Tornike Tsomaia
