import { H } from '@harness-dsl/core';
import { fs } from '@harness-dsl/fs';
import { git } from '@harness-dsl/git';
import { local } from '@harness-dsl/node';
import { sqlite } from '@harness-dsl/sqlite';
import { runner, verifySuite } from './pools-and-services.constants.js';
import { changeShippedSignal, prClosedUnmergedSignal } from './signals-and-interrupts.constants.js';

/**
 * Relational architectural topology (`app-topology`) backed by SQLite with two-phase overlay commitment (`CODING_SAMPLE.md` §6.4).
 *
 * Declares `db` -> `api` -> `web` dependency edges, commits sealed run overlays to global base state when
 * `changeShippedSignal` arrives on `'main'`, and discards overlays when `prClosedUnmergedSignal` fires.
 */
export const repoTopology = H.topology('app-topology')
  .store(sqlite.topologyStore('.harness/state.sqlite'))
  .partitions({
    db: {},
    api: { dependsOn: ['db'] },
    web: { dependsOn: ['api'] },
  })
  .commitOverlayWhen({
    onSignal: {
      signal: changeShippedSignal,
      correlateBy: (sig) => sig.ref,
      baseBranch: (sig) => sig.baseBranch,
    },
    discardOnSignal: {
      signal: prClosedUnmergedSignal,
      correlateBy: (sig) => sig.ref,
    },
    maxSealedAgeHours: 168,
  });

/**
 * Filesystem partition mapping binding `repoTopology` partitions to directory globs and public boundary index files (`CODING_SAMPLE.md` §6.4).
 *
 * Used by `fs.boundaryGuard(repoPartitions)`, `workspace.checkpointPolicy`, and `git.publicSurfaceCrossTester`.
 */
export const repoPartitions = fs.partitionMap(repoTopology, {
  db: {
    globs: ['packages/db/**'],
    boundaryGlobs: ['packages/db/src/index.ts'],
  },
  api: {
    globs: ['packages/api/**'],
    boundaryGlobs: ['packages/api/src/index.ts'],
  },
  web: {
    globs: ['packages/web/**'],
    boundaryGlobs: ['packages/web/src/index.ts'],
  },
});

/**
 * Copy-on-Write Git worktree isolation scope (`workspace`) with lockfile gating and rebase reconciliation (`CODING_SAMPLE.md` §6.4).
 *
 * Excludes build caches from APFS/reflink clones, gates `pnpm install --frozen-lockfile` on `pnpm-lock.yaml` hash changes,
 * enforces partition-aware checkpoint hygiene, and verifies rebases with `verifySuite`.
 */
export const workspace = git
  .cowWorktree({ repo: '.', dir: '.harness/workspaces' })
  .excludeFromCloneGlobs([
    'dist/**',
    '.next/**',
    'coverage/**',
    '**/*.tsbuildinfo',
    '.harness-ephemeral/**',
    '**/node_modules/.cache/**',
    '**/node_modules/.vite/**',
    '**/node_modules/.vitest/**',
  ])
  .setup(
    local
      .command('install')
      .runner(runner)
      .stdin('closed')
      .env({ CI: 'true' })
      .argv(['pnpm', 'install', '--frozen-lockfile']),
  )
  .lockfileGate('pnpm-lock.yaml')
  .checkpointPolicy({
    partitionMap: repoPartitions,
    excludeGlobs: [
      'dist/**',
      '.next/**',
      'coverage/**',
      '**/*.tsbuildinfo',
      '.harness-ephemeral/**',
      '**/node_modules/.cache/**',
      '**/node_modules/.vite/**',
      '**/node_modules/.vitest/**',
    ],
    maxUntrackedFileSizeBytes: 1_048_576,
  })
  .reconcileStrategy('rebase-onto-base', {
    verifyWith: verifySuite,
  });
