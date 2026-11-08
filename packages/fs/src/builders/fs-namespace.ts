import { createFsAllowOnlyGuardBuilder } from './create-fs-allow-only-guard-builder.js';
import { createFsAllowWriteGlobsLeaseDelta } from './create-fs-allow-write-globs-lease-delta.js';
import { createFsBoundaryGuardBuilder } from './create-fs-boundary-guard-builder.js';
import { createFsCodingTools } from './create-fs-coding-tools.js';
import { createFsGlobMatcherBuilder } from './create-fs-glob-matcher-builder.js';
import { createFsGlobSourceBuilder } from './create-fs-glob-source-builder.js';
import { createFsInPartitionPredicate } from './create-fs-in-partition-predicate.js';
import { createFsJsonlLessonStoreBuilder } from './create-fs-jsonl-lesson-store-builder.js';
import { createFsMaxFilesMutatedBuilder } from './create-fs-max-files-mutated-builder.js';
import { createFsPartitionMap } from './create-fs-partition-map.js';
import { createFsProtectGuardBuilder } from './create-fs-protect-guard-builder.js';
import { createFsReadOnlyGuardBuilder } from './create-fs-read-only-guard-builder.js';
import { createFsReadOnlyTools } from './create-fs-read-only-tools.js';
import { createFsRegexCheckBuilder } from './create-fs-regex-check-builder.js';
import { createFsRequireReadBeforeWriteGuardBuilder } from './create-fs-require-read-before-write-guard-builder.js';
import { createFsScopedWriteGuardBuilder } from './create-fs-scoped-write-guard-builder.js';
import { createFsSecretLiteralsGuardBuilder } from './create-fs-secret-literals-guard-builder.js';
import { createFsTelemetryBuilder } from './create-fs-telemetry-builder.js';
import { createFsTextSourceBuilder } from './create-fs-text-source-builder.js';
import { createFsWriteGuardBuilder } from './create-fs-write-guard-builder.js';
import type { FsNamespace } from './fs-namespace-contract.js';

/**
 * Frozen `@paraharness/fs` builder namespace (`fs.*`).
 *
 * Provides pure AST builder factories for filesystem sources, partition maps, policy guards,
 * capability lease deltas, quota tripwires, regex checks, telemetry collectors, lesson stores,
 * and workspace-jailed coding/read-only tool bundles.
 */
export const fs: FsNamespace = Object.freeze<FsNamespace>({
  text: createFsTextSourceBuilder,
  glob: createFsGlobSourceBuilder,
  matchGlobs: createFsGlobMatcherBuilder,
  partitionMap: createFsPartitionMap,
  inPartition: createFsInPartitionPredicate,
  boundaryGuard: createFsBoundaryGuardBuilder,
  writeGuard: createFsWriteGuardBuilder,
  protect: createFsProtectGuardBuilder,
  readOnly: createFsReadOnlyGuardBuilder,
  allowOnly: createFsAllowOnlyGuardBuilder,
  requireReadBeforeWrite: createFsRequireReadBeforeWriteGuardBuilder,
  scopedWrite: createFsScopedWriteGuardBuilder,
  secretLiterals: createFsSecretLiteralsGuardBuilder,
  allowWriteGlobs: createFsAllowWriteGlobsLeaseDelta,
  maxFilesMutated: createFsMaxFilesMutatedBuilder,
  codingTools: createFsCodingTools,
  readOnlyTools: createFsReadOnlyTools,
  telemetry: createFsTelemetryBuilder,
  regexCheck: createFsRegexCheckBuilder,
  jsonlLessonStore: createFsJsonlLessonStoreBuilder,
});
