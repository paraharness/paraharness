import type {
  FsJsonlLessonStoreNode,
  RuntimeExecutorRegistrySlice,
} from '@metaharness/core';
import { FsJsonlLessonStore } from '../stores/fs-jsonl-lesson-store.js';
import {
  collectFsTelemetry,
  evaluateFsQuotaTripwire,
  executeFsRegexCheck,
} from './fs-check-tripwire-and-telemetry.js';
import { evaluateFsGlobEffectMatcher } from './fs-glob-effect-matcher.js';
import {
  evaluateFsAllowOnlyGuard,
  evaluateFsBoundaryGuard,
  evaluateFsProtectGuard,
  evaluateFsReadOnlyGuard,
} from './fs-path-guard-executors.js';
import {
  createFsGlobToolDriver,
  createFsGrepToolDriver,
  createFsReadToolDriver,
} from './fs-read-tool-drivers.js';
import {
  executeFsGlobSource,
  executeFsTextSource,
} from './fs-source-executors.js';
import {
  evaluateFsRequireReadBeforeWriteGuard,
  evaluateFsScopedWriteGuard,
  evaluateFsSecretLiteralsGuard,
  evaluateFsWriteGuard,
} from './fs-write-guard-executors.js';
import {
  createFsEditToolDriver,
  createFsWriteToolDriver,
} from './fs-write-tool-drivers.js';

/**
 * Creates a fresh `RuntimeExecutorRegistrySlice` registering all `@metaharness/fs` runtime executors and drivers.
 *
 * Registers `sources`, `checks`, `policyGuards`, `quotaTripwires`, `telemetryCollectors`,
 * `effectMatchers`, `tools`, and `lessons` for `@metaharness/fs` AST nodes (`SPEC.md` §4.3).
 *
 * @returns {RuntimeExecutorRegistrySlice} Deeply frozen executor registry slice for `@metaharness/fs`.
 */
export function createFsExecutors(): RuntimeExecutorRegistrySlice {
  return Object.freeze<RuntimeExecutorRegistrySlice>({
    sources: Object.freeze({
      'fs:text-source': executeFsTextSource,
      'fs:glob-source': executeFsGlobSource,
    }),
    checks: Object.freeze({
      'fs:regex-check': executeFsRegexCheck,
    }),
    policyGuards: Object.freeze({
      'fs:boundary-guard': evaluateFsBoundaryGuard,
      'fs:protect': evaluateFsProtectGuard,
      'fs:read-only': evaluateFsReadOnlyGuard,
      'fs:allow-only': evaluateFsAllowOnlyGuard,
      'fs:write-guard': evaluateFsWriteGuard,
      'fs:require-read-before-write': evaluateFsRequireReadBeforeWriteGuard,
      'fs:scoped-write': evaluateFsScopedWriteGuard,
      'fs:secret-literals': evaluateFsSecretLiteralsGuard,
    }),
    quotaTripwires: Object.freeze({
      'fs:quota-tripwire': evaluateFsQuotaTripwire,
    }),
    telemetryCollectors: Object.freeze({
      'fs:telemetry': collectFsTelemetry,
    }),
    effectMatchers: Object.freeze({
      'fs:match-globs': evaluateFsGlobEffectMatcher,
    }),
    tools: Object.freeze({
      'fs:read': createFsReadToolDriver(),
      'fs:edit': createFsEditToolDriver(),
      'fs:write': createFsWriteToolDriver(),
      'fs:glob': createFsGlobToolDriver(),
      'fs:grep': createFsGrepToolDriver(),
    }),
    lessons: Object.freeze({
      'fs:jsonl-lesson-store': (node: FsJsonlLessonStoreNode): FsJsonlLessonStore =>
        new FsJsonlLessonStore(node),
    }),
  });
}
