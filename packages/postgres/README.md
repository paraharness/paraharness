# `@paraharness/postgres`

Distributed PostgreSQL runtime drivers and AST builders for ParaHarness `LedgerStore`, Copy-on-Write `TopologyStore`, `LessonStore`, and relational global rules sources.

- **Full API Reference:** [https://paraharness.github.io/paraharness/modules/_paraharness_postgres.html](https://paraharness.github.io/paraharness/modules/_paraharness_postgres.html)

## Installation

```bash
pnpm add @paraharness/postgres @paraharness/core zod
```

## Usage

```ts
import { P } from '@paraharness/core';
import { postgres, postgresExecutors } from '@paraharness/postgres';

const dbUrl = P.env('DATABASE_URL');

const ledger = postgres.ledger(dbUrl);
const topologyStore = postgres.topologyStore(dbUrl);
const lessonStore = postgres.lessonStore(dbUrl);
```

## Key Exports

| Export | Description |
| :--- | :--- |
| `postgres.ledger(uri)` | Builds `PostgresLedgerNode` (`type: 'postgres:ledger'`) with optional `.compactWhen()` |
| `postgres.topologyStore(uri)` | Builds `PostgresTopologyNode` (`type: 'postgres:topology'`) |
| `postgres.lessonStore(uri)` | Builds `PostgresLessonsNode` (`type: 'postgres:lessons'`) |
| `postgres.globalRules(uri, { table })` | Builds `PostgresRulesSourceNode` (`type: 'postgres:global-rules'`) |
| `postgresExecutors`, `createPostgresExecutors` | Runtime store and source registrations for all `postgres:*` AST nodes |

## License

[MIT](./LICENSE) © Tornike Tsomaia
