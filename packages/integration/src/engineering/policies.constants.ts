import { M } from '@metaharness/core';
import { fs } from '@metaharness/fs';
import { git } from '@metaharness/git';
import { mapLeaseRequestViolation } from './internal/map-lease-request-violation.js';
import { leaseRequest, scopeTripwire } from './signals-and-interrupts.constants.js';
import { repoPartitions } from './topology-and-workspace.constants.js';

/**
 * Read-only capability policy (`read-only`) denying all filesystem write operations (`CODING_SAMPLE.md` §6.6).
 *
 * Enforced on `evaluator`, `leaseAdjudicator`, and `candidateArbiter` so verification and adjudication actors never mutate the worktree.
 */
export const readOnlyPolicy = M.policy('read-only')
  .guard(fs.writeGuard({ denyGlobs: ['**/*'] }))
  .onViolation('deny-with-error');

/**
 * Base worker capability policy (`worker-base`) with ordered guard clauses and snapshot-on-abort (`CODING_SAMPLE.md` §6.6).
 *
 * Clause 1 denies writes to cross-partition boundaries, architecture/product specs, `.gitignore`, and `.harness/**` in-band;
 * Clause 2 intercepts edits to existing `.test.ts`/`.test.tsx` files pre-flight and raises `leaseRequest`;
 * binds `git.snapshotAndReset()` as the default abort hook.
 */
export const workerBasePolicy = M.policy('worker-base')
  .guard(
    fs.boundaryGuard(repoPartitions),
    fs.writeGuard({
      denyGlobs: [
        'TECH_DESIGN.md',
        'PRODUCT_SPEC.md',
        'openapi.yaml',
        '**/.gitignore',
        '.harness/**',
      ],
    }),
  )
  .onViolation(
    'deny-with-error',
    (violation) =>
      `${violation.violationSummary}. Raise 'contract-violation' if an upstream partition contract or boundary must change.`,
  )
  .guard(
    fs.writeGuard({
      denyGlobs: ['**/*.test.ts', '**/*.test.tsx'],
      onlyExistingAtBaseRef: true,
    }),
  )
  .onViolation('raise-interrupt', leaseRequest, mapLeaseRequestViolation)
  .onAbort(git.snapshotAndReset());

/**
 * Fast-path worker capability policy (`fast-path-limits`) extending `workerBasePolicy` with tight scope tripwires (`CODING_SAMPLE.md` §6.6).
 *
 * Caps optimistic single-agent attempts at 4 mutated files, 8 turns, and $1.00, flushing reconnaissance via `scopeTripwire`
 * and snapshotting/resetting the worktree when any limit is exceeded.
 */
export const fastPathPolicy = workerBasePolicy
  .extend('fast-path-limits')
  .tripwire(fs.maxFilesMutated(4))
  .maxTurns(8)
  .maxCostUsd(1.0)
  .onLimitExceeded(($limit) =>
    $limit
      .flushWithInterrupt(scopeTripwire)
      .onAbort(git.snapshotAndReset()),
  );

/**
 * Coordinator capability policy (`coordinator-policy`) restricting direct writes to endogenous architecture files (`CODING_SAMPLE.md` §6.6).
 *
 * Permits direct edits only to `TECH_DESIGN.md` and `packages/<partition>/src/index.ts`, requiring `delegate-partition` for leaf code
 * and `normative-tradeoff` owner lease elevation for `PRODUCT_SPEC.md` or `openapi.yaml`.
 */
export const coordinatorPolicy = M.policy('coordinator-policy')
  .guard(
    fs.writeGuard({
      denyGlobs: ['**/*'],
      allowGlobs: ['TECH_DESIGN.md', 'packages/*/src/index.ts'],
    }),
  )
  .onViolation(
    'deny-with-error',
    (violation) =>
      `${violation.violationSummary}. Delegate leaf implementation edits via 'delegate-partition' or invoke the 'normative-tradeoff' escalation tool to request an owner spec lease.`,
  );
