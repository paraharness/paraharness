# @paraharness/postgres

Distributed PostgreSQL runtime drivers and declarative `postgres.*` builders for [Paraharness](https://github.com/paraharness/paraharness). This package provides transactional multi-worker persistence for `LedgerStore`, Copy-on-Write `TopologyStore`, `LessonStore`, and relational global rules sources over PostgreSQL connection pools.

## Installation

With npm:

```bash
npm install @paraharness/postgres @paraharness/core zod
```

With yarn:

```bash
yarn add @paraharness/postgres @paraharness/core zod
```

With pnpm:

```bash
pnpm add @paraharness/postgres @paraharness/core zod
```

## Usage

```ts
import { P, z } from '@paraharness/core';
import { createExecutorRegistry } from '@paraharness/core/runtime';
import { postgres, postgresExecutors } from '@paraharness/postgres';

const TaskInput = z.object({
  id: z.string(),
  prompt: z.string(),
});

const dbUrl = P.env('DATABASE_URL');

const ledger = postgres
  .ledger(dbUrl)
  .compactWhen(($c) =>
    $c
      .onTerminalExit(['done', 'cancelled'], { afterGracePeriodHours: 48 })
      .retainFailedRunsForDays(30),
  );

const repoTopology = P.topology('repo-topology')
  .store(postgres.topologyStore(dbUrl))
  .partitions({
    db: {},
    api: { dependsOn: ['db'] },
  });

const repoLessons = P.lessons('repo-lessons')
  .store(postgres.lessonStore(dbUrl))
  .queryFrom(TaskInput, (item) => item.prompt);

const registry = createExecutorRegistry(postgresExecutors);
```

## Documentation

See the [`@paraharness/postgres` API Reference](https://paraharness.github.io/paraharness/modules/_paraharness_postgres.html) for full type and builder specifications.

## License

[MIT](./LICENSE) © Tornike Tsomaia
