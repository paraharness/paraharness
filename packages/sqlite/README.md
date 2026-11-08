# `@paraharness/sqlite`

WAL-mode SQLite runtime drivers and AST builders for ParaHarness `LedgerStore`, Copy-on-Write `TopologyStore`, `LessonStore`, and relational global rules sources.

- **Full API Reference:** [https://paraharness.github.io/paraharness/modules/_paraharness_sqlite.html](https://paraharness.github.io/paraharness/modules/_paraharness_sqlite.html)

## Installation

```bash
pnpm add @paraharness/sqlite @paraharness/core zod
```

## Usage

```ts
import { sqlite, sqliteExecutors } from '@paraharness/sqlite';

const ledger = sqlite
  .ledger('.harness/state.sqlite')
  .compactWhen(($c) =>
    $c
      .onTerminalExit(['done', 'cancelled'], { afterGracePeriodHours: 24 })
      .retainFailedRunsForDays(14),
  );

const topologyStore = sqlite.topologyStore('.harness/state.sqlite');
const lessonStore = sqlite.lessonStore('.harness/state.sqlite');
```

## Key Exports

| Export | Description |
| :--- | :--- |
| `sqlite.ledger(uri)` | Builds `SqliteLedgerNode` (`type: 'sqlite:ledger'`) with optional `.compactWhen()` |
| `sqlite.topologyStore(uri)` | Builds `SqliteTopologyNode` (`type: 'sqlite:topology'`) |
| `sqlite.lessonStore(uri)` | Builds `SqliteLessonsNode` (`type: 'sqlite:lessons'`) |
| `sqlite.globalRules(uri, { table })` | Builds `SqliteRulesSourceNode` (`type: 'sqlite:global-rules'`) |
| `sqliteExecutors` | Runtime store and source registrations for all `sqlite:*` AST nodes |

## License

[MIT](./LICENSE) © Tornike Tsomaia
