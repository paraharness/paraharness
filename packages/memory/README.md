# @paraharness/memory

Unified Memory Harness for [Paraharness](https://github.com/paraharness/paraharness). This package provides the `MemoryHarness` coordinator, `ClaudeCliDistillerRunner`, Zod-validated schemas, port contracts, 4-way path/glob context scope matching, capacity bucket resolution, atomic JSONL ledger persistence with monotonic high-water-mark metadata, 4-mode note lifecycles, Git 3-way ledger reconciliation, and just-in-time file-interaction hook injection for agentic engineering workflows.

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

## Core Surfaces (`MemoryHarness` & `ClaudeCliDistillerRunner`)

- **`MemoryHarness`:** Stateful coordinator implementing `MemoryHarnessContract` (`getConfig`, `init`, `loadScoped`, `propose`, `commit`, `drainNotes`, and `handleFileInteractionHook`).
- **`ClaudeCliDistillerRunner`:** Built-in `MemoryDistillerRunner` spawning `claude -p` with JSON Schema validation (`DistillerStructuredOutputSchema`) for automated rule and lesson distillation.
- **Five Unified Memory Tools:**
  1. `init` (`memory_init`): Loads unscoped `'general'` and `<role>` memories, updates `latest-role.json` and `<sessionId>.json` (`PENDING_HOOK_EPOCH`), and generates the config-adapted Memory Protocol.
  2. `loadScoped` (`memory_load_scoped`): Loads path-scoped `R*` -> `L*` -> `N*` records matching 4-way path/glob scopes and tracks seen IDs in the active compaction epoch.
  3. `propose` (`memory_propose`): Formats, deduplicates, and checks 3-zone capacity (`UNCAPPED`, `UNDER_SOFT_CAP`, `SOFT_CAP_PRESSURE`, `AT_HARD_CAP`) via `MemoryDistillerRunner` (`resolved`) or subagent delegation (`delegate_to_subagent`).
  4. `commit` (`memory_commit`): Atomically adds, updates, or removes rules, lessons, and lifecycle-managed notes with monotonic ID allocation and optional Git auto-commit/push 3-way reconciliation.
  5. `drainNotes` (`memory_drain_notes`): Previews (`dryRun: true`) or bulk-drains (`dryRun: false`) operational notes across lifecycle modes, roles, paths, and IDs.
- **File-Interaction Hook (`handleFileInteractionHook` & `extractTouchedPathsFromHookInput`):** Injects unseen path-scoped memories on the first file/directory/glob interaction within each compaction epoch across Claude Code and Antigravity transcripts.

## Usage

```ts
import {
  ClaudeCliDistillerRunner,
  MemoryHarness,
  extractTouchedPathsFromHookInput,
} from '@paraharness/memory';

const harness = new MemoryHarness({
  workspaceRoot: process.cwd(),
  distillerRunner: new ClaudeCliDistillerRunner(),
});

const initResult = await harness.init({
  role: 'builder',
  sessionId: 'session-1',
});

const touched = extractTouchedPathsFromHookInput({
  tool_name: 'Read',
  tool_input: {
    file_path: 'packages/memory/src/index.ts',
  },
});

const hookResult = await harness.handleFileInteractionHook({
  sessionId: 'session-1',
  role: 'builder',
  touchedPaths: [...touched],
});
```

## Documentation

See the [`@paraharness/memory` API Reference](https://paraharness.github.io/paraharness/modules/_paraharness_memory.html) for full type and schema specifications.

## License

[MIT](./LICENSE) © Tornike Tsomaia
