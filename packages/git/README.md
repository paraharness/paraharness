# `@paraharness/git`

Copy-on-Write (CoW) hierarchical Git worktree isolation scope (`BranchableScope` & `CheckpointableScope`), deterministic git-index checkpointing, stateless 3-way `git merge-tree --write-tree` reconciliation, and candidate comparison tools for ParaHarness.

- **Full API Reference:** [https://paraharness.github.io/paraharness/modules/_paraharness_git.html](https://paraharness.github.io/paraharness/modules/_paraharness_git.html)

## Installation

```bash
pnpm add @paraharness/git @paraharness/core zod
```

## Usage

```ts
import { git, gitExecutors } from '@paraharness/git';
import { local } from '@paraharness/node';

const runner = local.runner({ slots: 4 });

const worktreeScope = git
  .cowWorktree({ repo: '.', dir: '.harness/worktrees' })
  .excludeFromCloneGlobs(['dist/**', 'coverage/**'])
  .reconcileStrategy('rebase-onto-base');

const commitStep = git
  .commitAndPush('commit-and-push', {
    branch: (item: { id: string }) => `feat/${item.id}`,
    message: (item: { id: string }) => `feat: complete ${item.id}`,
  })
  .runner(runner);
```

## Key Exports

| Export | Description |
| :--- | :--- |
| `git.cowWorktree(opts)` | Builds `GitCowWorktreeNode` (`type: 'git:cow-worktree'`, `capabilityTier: 'branchable'`) |
| `git.commitAndPush(id, opts)` | Builds retry-safe squash/rebase/push step (`type: 'git:commit-and-push'`) |
| `git.mergeQueue(id, opts)` | Builds cumulative batch merge train step (`type: 'git:merge-queue'`) |
| `git.snapshotAndReset()` | Builds idempotent abort hook pinning `refs/harness/aborted/<runId>/<stepExecId>` |
| `git.keepWorktree()`, `git.resetWorktree()`, `git.discardBranch()` | Builds scope rewind hooks for `P.lane.onSignal().rewindTo()` |
| `git.publicSurfaceCrossTester(opts)`, `git.patchEquivalence()` | Builds speculative tournament `CrossVerifierASTNode`s |
| `git.refReaderTools(runner)`, `git.candidateComparisonTools(runner)` | Builds read-only git object and speculative candidate benchmark tools |
| `gitExecutors` | Runtime executor and driver registrations for all `git:*` AST nodes |

## License

[MIT](./LICENSE) © Tornike Tsomaia
