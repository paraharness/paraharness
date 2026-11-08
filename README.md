# ParaHarness (`@paraharness/*`)

Declarative pure-AST agent orchestration DSL (`P.*`) and durable execution runtime for coordinating autonomous LLM actors, deterministic tools, lifecycle-bound services, and human escalations over isolated execution scopes.

- **Full API Reference:** [https://paraharness.github.io/paraharness/](https://paraharness.github.io/paraharness/)
- **Repository:** [https://github.com/paraharness/paraharness](https://github.com/paraharness/paraharness)

## Key Architectural Principles

1. **Pure Passive Discriminated-Union AST & Late Binding:** Every construct in `@paraharness/core` (`P.*`) and peer adapter packages compiles into an immutable, deeply frozen, JSON-inspectable AST node (`readonly type: '...'`) with zero build-time I/O and zero execution methods on AST nodes.
2. **Strict Core vs. Domain Boundary:** `@paraharness/core` defines domain-agnostic execution topology, capability-tiered isolation scopes (`'scope' | 'checkpointable' | 'branchable'`), continuation-stack durability, and policy/interrupt state machines. Environment and vendor concerns live in dedicated adapter packages.
3. **Run-Immutable Warm-Fork Prefix Groups (`P.prefixGroup`):** Preserves byte-0 provider KV prefix cache hits across downward forks (`.fork()`), speculative tournaments (`.speculate()`), and iterative loops (`P.loop`) while injecting dynamic topology contracts, lessons, and grounding diffs into Turn-0 `[ROLE_AND_SCOPE_CONTEXT]` frames.
4. **Reboot-Safe Continuation Call Stacks:** Every step, loop iteration, tool batch (`PendingToolBatch`), downward fork batch, and speculative tournament persists its `ContinuationFrame[]` tree in `LedgerStore` for deterministic crash recovery and upward child-interrupt suspension (`resumeFork`).

## Packages

| Package | Description | API Reference |
| :--- | :--- | :--- |
| [`@paraharness/core`](./packages/core) | Core pure-AST DSL builders (`P.*`), runtime ports, and `@paraharness/core/runtime` execution engine | [Docs](https://paraharness.github.io/paraharness/modules/_paraharness_core.html) |
| [`@paraharness/lockfile`](./packages/lockfile) | Cross-process advisory lockfile utility with `p-queue` serialization and stale lock reclamation | [Docs](https://paraharness.github.io/paraharness/modules/_paraharness_lockfile.html) |
| [`@paraharness/claude`](./packages/claude) | Anthropic `/v1/messages` `ModelDriver` and AST builders (`claude.cliAccount`, `claude.model`) | [Docs](https://paraharness.github.io/paraharness/modules/_paraharness_claude.html) |
| [`@paraharness/openai`](./packages/openai) | OpenAI Responses API & Codex CLI `ModelDriver` and AST builders (`openai.account`, `openai.model`) | [Docs](https://paraharness.github.io/paraharness/modules/_paraharness_openai.html) |
| [`@paraharness/gemini`](./packages/gemini) | Google Gemini `generateContent` `ModelDriver` and AST builders (`gemini.account`, `gemini.cliAccount`, `gemini.model`) | [Docs](https://paraharness.github.io/paraharness/modules/_paraharness_gemini.html) |
| [`@paraharness/node`](./packages/node) | Local OS subprocess runner pools, commands, stream checks, PTY daemons, and MCP control planes (`local.*`, `mcp.*`) | [Docs](https://paraharness.github.io/paraharness/modules/_paraharness_node.html) |
| [`@paraharness/fs`](./packages/fs) | Workspace-jailed file tools, glob matchers, write guards, quota tripwires, and JSONL lesson store (`fs.*`) | [Docs](https://paraharness.github.io/paraharness/modules/_paraharness_fs.html) |
| [`@paraharness/git`](./packages/git) | Copy-on-Write Git worktree scope, git-index checkpoints, 3-way `merge-tree` reconciliation, and ref/candidate tools (`git.*`) | [Docs](https://paraharness.github.io/paraharness/modules/_paraharness_git.html) |
| [`@paraharness/markdown`](./packages/markdown) | Frontmatter and section-aware Markdown loaders for rules and skills (`md.*`) | [Docs](https://paraharness.github.io/paraharness/modules/_paraharness_markdown.html) |
| [`@paraharness/sqlite`](./packages/sqlite) | WAL-mode SQLite drivers for `LedgerStore`, `TopologyStore`, `LessonStore`, and global rules (`sqlite.*`) | [Docs](https://paraharness.github.io/paraharness/modules/_paraharness_sqlite.html) |
| [`@paraharness/postgres`](./packages/postgres) | Distributed PostgreSQL drivers for `LedgerStore`, `TopologyStore`, `LessonStore`, and global rules (`postgres.*`) | [Docs](https://paraharness.github.io/paraharness/modules/_paraharness_postgres.html) |
| [`@paraharness/github`](./packages/github) | GitHub Issues tracker, HMAC webhook stream, and idempotent PR step executor (`github.*`) | [Docs](https://paraharness.github.io/paraharness/modules/_paraharness_github.html) |
| [`@paraharness/slack`](./packages/slack) | Slack Socket Mode interactive human approval / control-plane adapter and webhook notifier (`slack.*`) | [Docs](https://paraharness.github.io/paraharness/modules/_paraharness_slack.html) |

## Quick Start

```ts
import { P, z } from '@paraharness/core';
import { createExecutorRegistry, createRuntime } from '@paraharness/core/runtime';
import { claude, claudeExecutors } from '@paraharness/claude';
import { fs, fsExecutors } from '@paraharness/fs';
import { git, gitExecutors } from '@paraharness/git';
import { local, nodeExecutors } from '@paraharness/node';
import { sqlite, sqliteExecutors } from '@paraharness/sqlite';

const runner = local.runner({ slots: 4, maxDaemons: 2 });
const sonnet = claude.model('sonnet', { id: 'claude-sonnet-4-6' });

const worker = P.agent('worker')
  .model(sonnet)
  .tools(...fs.codingTools(runner))
  .instructions('Implement the requested change and keep all checks passing.')
  .input(z.object({ taskId: z.string(), prompt: z.string() }))
  .output(z.object({ summary: z.string() }));

const flow = P.flow('delivery-flow')
  .input(z.object({ taskId: z.string(), prompt: z.string() }))
  .scope(git.cowWorktree({ repo: '.', dir: '.worktrees' }))
  .step('implement', worker)
  .exit('done');

const harness = P.harness('engineering-harness')
  .ledger(sqlite.ledger('.harness/state.sqlite'))
  .pools(runner)
  .lanes(
    P.lane('main-lane')
      .input(z.object({ taskId: z.string(), prompt: z.string() }))
      .key((item) => item.taskId)
      .runs(flow)
      .concurrency(2)
      .priority('normal'),
  );

const registry = createExecutorRegistry(
  claudeExecutors,
  fsExecutors,
  gitExecutors,
  nodeExecutors,
  sqliteExecutors,
);

const runtime = createRuntime(harness, { registry, env: process.env });
```

## License

[MIT](./LICENSE) © Tornike Tsomaia
