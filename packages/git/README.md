# @paraharness/git

Copy-on-Write (CoW) hierarchical Git worktree isolation scope, git-index checkpointing, stateless 3-way `git merge-tree --write-tree` reconciliation, and candidate comparison tools for [Paraharness](https://github.com/paraharness/paraharness). This package isolates every flow run, subagent fork, and speculative branch inside its own worktree sharing the host repository's object store while providing deterministic post-flight rollback, abort snapshots, and retry-safe branch pushing.

## Installation

With npm:

```bash
npm install @paraharness/git @paraharness/core zod
```

With yarn:

```bash
yarn add @paraharness/git @paraharness/core zod
```

With pnpm:

```bash
pnpm add @paraharness/git @paraharness/core zod
```

## Usage

```ts
import { P, z } from '@paraharness/core';
import { createExecutorRegistry } from '@paraharness/core/runtime';
import { git, gitExecutors } from '@paraharness/git';
import { local, nodeExecutors } from '@paraharness/node';

const TaskInput = z.object({
  id: z.string(),
  title: z.string(),
});

const runner = local.runner({ slots: 4 });

const worktreeScope = git
  .cowWorktree({ repo: '.', dir: '.harness/worktrees' })
  .excludeFromCloneGlobs(['dist/**', 'coverage/**'])
  .lockfileGate('pnpm-lock.yaml')
  .reconcileStrategy('rebase-onto-base');

const landChanges = git
  .commitAndPush('land-changes', {
    inputSchema: TaskInput,
    branch: (item) => `feat/${item.id}`,
    message: (item) => `feat(${item.id}): ${item.title}`,
  })
  .runner(runner);

const flow = P.flow('git-delivery-flow')
  .input(TaskInput)
  .scope(worktreeScope)
  .step('push', landChanges)
  .exit('done');

const registry = createExecutorRegistry(gitExecutors, nodeExecutors);
```

## Documentation

See the [`@paraharness/git` API Reference](https://paraharness.github.io/paraharness/modules/_paraharness_git.html) for full type and builder specifications.

## License

[MIT](./LICENSE) © Tornike Tsomaia
