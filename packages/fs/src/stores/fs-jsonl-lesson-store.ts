import { existsSync } from 'node:fs';
import path from 'node:path';
import type {
  FsJsonlLessonStoreNode,
  LessonOutcome,
  LessonRecord,
  LessonStore,
} from '@harness-dsl/core';
import type { FsLessonDefinitionRecord } from './internal/fs-lesson-definition-record.js';
import {
  atomicWriteJsonFile,
  readAllLessonDefinitions,
  readLessonStatsFile,
  withNonBlockingAdvisoryFileLock,
} from './internal/fs-lesson-lock-and-atomic-io.js';
import {
  computeLessonId,
  computeQueryRelevanceScore,
  mergeDefinitionAndStats,
} from './internal/fs-lesson-relevance.js';

/**
 * Crash-safe hybrid filesystem `LessonStore` implementation (`fs.jsonlLessonStore`, `SPEC.md` §4.3).
 *
 * Resolves `definitionsDir`, `statsPath`, and `lockFile` against the immutable host repository
 * root (Invariant 5), writes immutable `<definitionsDir>/<lessonId>.json` definition files on
 * `admit()`, and updates mutable telemetry counters in `statsPath` under an in-process async
 * queue combined with a non-blocking advisory lockfile and atomic temp-file rename.
 */
export class FsJsonlLessonStore implements LessonStore {
  /** Absolute host-root directory path storing immutable `<lessonId>.json` definitions. */
  private readonly definitionsDirPath: string;
  /** Absolute host-root file path storing mutable lesson telemetry counters. */
  private readonly statsFilePath: string;
  /** Absolute host-root advisory lockfile path. */
  private readonly lockFilePath: string;
  /** Serialized in-process async mutex promise chain. */
  private mutexTail: Promise<unknown> = Promise.resolve();
  /** Monotonic counter for atomic temporary file suffixes. */
  private tempCounter = 0;

  /**
   * Initializes an `FsJsonlLessonStore` bound to the host repository root (`SPEC.md` Invariant 5).
   *
   * Resolves all configured store paths relative to `hostRoot` (defaulting to `process.cwd()`).
   * @param {FsJsonlLessonStoreNode} node                     - Passive lesson store AST node.
   * @param {string}                 [hostRoot=process.cwd()] - Optional explicit host repository root directory.
   */
  constructor(node: FsJsonlLessonStoreNode, hostRoot: string = process.cwd()) {
    const resolvedRoot = path.resolve(hostRoot);
    this.definitionsDirPath = path.resolve(resolvedRoot, node.definitionsDir);
    this.statsFilePath = path.resolve(resolvedRoot, node.statsPath);
    this.lockFilePath = path.resolve(resolvedRoot, node.lockFile);
  }

  /**
   * Enqueues `operation` onto the in-process mutex queue and acquires the advisory file lock.
   *
   * Guarantees strict serialization across concurrent calls within the process and across processes.
   * @template TResult Result type of the locked operation.
   * @param {() => Promise<TResult>} operation - Critical section callback.
   * @returns {Promise<TResult>} Result returned by `operation`.
   */
  private enqueueLocked<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    const next = this.mutexTail.then(
      () => withNonBlockingAdvisoryFileLock(this.lockFilePath, operation),
      () => withNonBlockingAdvisoryFileLock(this.lockFilePath, operation),
    );
    this.mutexTail = next.then(() => undefined, () => undefined);
    return next;
  }

  /**
   * Queries non-retired candidate lessons and populates `relevanceScore` in `[0, 1]`.
   *
   * Orders returned candidate lessons deterministically by descending `relevanceScore` and `id`.
   * @param {Record<string, unknown>} req - Query text and active partitions.
   * @returns {Promise<readonly LessonRecord[]>} Frozen array of candidate lesson records.
   */
  queryCandidates(req: { readonly queryText: string; readonly partitions: readonly string[] }): Promise<readonly LessonRecord[]> {
    return this.enqueueLocked(async () => {
      const definitions = await readAllLessonDefinitions(this.definitionsDirPath);
      const statsMap = await readLessonStatsFile(this.statsFilePath);
      const partitionSet = new Set<string>(req.partitions);
      const records: LessonRecord[] = [];
      for (const def of definitions) {
        const stats = statsMap[def.id];
        if (stats?.retired === true) continue;
        records.push(mergeDefinitionAndStats(def, stats, computeQueryRelevanceScore(req.queryText, def, partitionSet)));
      }
      records.sort((a, b) => ((b.relevanceScore ?? 0) !== (a.relevanceScore ?? 0) ? (b.relevanceScore ?? 0) - (a.relevanceScore ?? 0) : a.id.localeCompare(b.id)));
      return Object.freeze(records);
    });
  }

  /**
   * Admits a distilled lesson by writing an immutable `<definitionsDir>/<lessonId>.json` file.
   *
   * Deduplicates identical `(partition, directive)` pairs and initializes telemetry counters in `statsPath`.
   * @param {Record<string, unknown>} lesson - Lesson definition to admit.
   * @returns {Promise<string>} Assigned content-addressed `lessonId`.
   */
  admit(lesson: { readonly partition?: string; readonly directive: string; readonly epochAtCreation: number; readonly createdByRunId?: string }): Promise<string> {
    return this.enqueueLocked(async () => {
      const lessonId = computeLessonId(lesson.partition, lesson.directive);
      const defPath = path.join(this.definitionsDirPath, `${lessonId}.json`);
      if (!existsSync(defPath)) {
        const defRecord: FsLessonDefinitionRecord = Object.freeze({ id: lessonId, partition: lesson.partition, directive: lesson.directive, epochAtCreation: lesson.epochAtCreation, createdByRunId: lesson.createdByRunId });
        this.tempCounter += 1;
        await atomicWriteJsonFile(defPath, defRecord, this.tempCounter);
      }
      const statsMap = await readLessonStatsFile(this.statsFilePath);
      if (statsMap[lessonId] === undefined) {
        statsMap[lessonId] = { recentOutcomes: [], totalCleanPasses: 0, totalViolated: 0, retired: false };
        this.tempCounter += 1;
        await atomicWriteJsonFile(this.statsFilePath, statsMap, this.tempCounter);
      }
      return lessonId;
    });
  }

  /**
   * Appends deduplicated step execution outcomes to `statsPath` and returns the updated lesson records.
   *
   * Increments `totalCleanPasses` and `totalViolated` counters without touching `<definitionsDir>/<lessonId>.json`.
   * @param {ReadonlyArray<Record<string, unknown>>} outcomes - Batch of lesson outcomes.
   * @returns {Promise<readonly LessonRecord[]>} Updated lesson records for the affected lessons.
   */
  recordOutcomes(outcomes: ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>): Promise<readonly LessonRecord[]> {
    return this.enqueueLocked(async () => {
      const definitions = await readAllLessonDefinitions(this.definitionsDirPath);
      const defById = new Map<string, FsLessonDefinitionRecord>();
      for (const def of definitions) defById.set(def.id, def);
      const statsMap = await readLessonStatsFile(this.statsFilePath);
      const touchedIds = new Set<string>();
      const mutableOutcomesById = new Map<string, LessonOutcome[]>();
      for (const outcomeEntry of outcomes) {
        const prev = statsMap[outcomeEntry.lessonId] ?? { recentOutcomes: [], totalCleanPasses: 0, totalViolated: 0 };
        let outcomeList = mutableOutcomesById.get(outcomeEntry.lessonId);
        if (outcomeList === undefined) {
          outcomeList = Array.from(prev.recentOutcomes);
          mutableOutcomesById.set(outcomeEntry.lessonId, outcomeList);
        }
        outcomeList.push(outcomeEntry.outcome);
        statsMap[outcomeEntry.lessonId] = {
          recentOutcomes: outcomeList,
          totalCleanPasses: prev.totalCleanPasses + (outcomeEntry.outcome === 'clean_pass' ? 1 : 0),
          totalViolated: prev.totalViolated + (outcomeEntry.outcome === 'violated' ? 1 : 0),
          epochAtCreation: prev.epochAtCreation,
          signalLastEmittedAt: prev.signalLastEmittedAt,
          retired: prev.retired,
        };
        touchedIds.add(outcomeEntry.lessonId);
      }
      this.tempCounter += 1;
      await atomicWriteJsonFile(this.statsFilePath, statsMap, this.tempCounter);
      const updated: LessonRecord[] = [];
      for (const id of touchedIds) {
        const def = defById.get(id);
        if (def !== undefined) updated.push(mergeDefinitionAndStats(def, statsMap[id]));
      }
      return Object.freeze(updated);
    });
  }

  /**
   * Aligns `epochAtCreation` overrides in `statsPath` for lessons created by `runIds`.
   *
   * Keeps `<definitionsDir>/<lessonId>.json` 100% immutable while updating `statsPath` (`SPEC.md` §4.3).
   * @param {readonly string[]}           runIds        - Run IDs whose topology overlays committed.
   * @param {ReadonlyMap<string, number>} updatedEpochs - Map of `partitionId` to committed base epoch.
   * @returns {Promise<void>} Resolves when `statsPath` is atomically updated.
   */
  syncCreationEpochsForRuns(runIds: readonly string[], updatedEpochs: ReadonlyMap<string, number>): Promise<void> {
    return this.enqueueLocked(async () => {
      if (runIds.length === 0 || updatedEpochs.size === 0) return;
      const runIdSet = new Set(runIds);
      const definitions = await readAllLessonDefinitions(this.definitionsDirPath);
      const statsMap = await readLessonStatsFile(this.statsFilePath);
      let mutated = false;
      for (const def of definitions) {
        if (def.createdByRunId === undefined || !runIdSet.has(def.createdByRunId) || def.partition === undefined) continue;
        const newEpoch = updatedEpochs.get(def.partition);
        if (newEpoch === undefined) continue;
        const prev = statsMap[def.id] ?? { recentOutcomes: [], totalCleanPasses: 0, totalViolated: 0 };
        statsMap[def.id] = {
          recentOutcomes: prev.recentOutcomes,
          totalCleanPasses: prev.totalCleanPasses,
          totalViolated: prev.totalViolated,
          epochAtCreation: newEpoch,
          signalLastEmittedAt: prev.signalLastEmittedAt,
          retired: prev.retired,
        };
        mutated = true;
      }
      if (mutated) {
        this.tempCounter += 1;
        await atomicWriteJsonFile(this.statsFilePath, statsMap, this.tempCounter);
      }
    });
  }

  /**
   * Persists the ISO-8601 emission timestamp for `signalId` on `lessonId` in `statsPath`.
   *
   * Enforces `.emitSignalWhen()` cooldowns across process restarts (`SPEC.md` §3.4.3).
   * @param {string} lessonId  - Lesson identifier.
   * @param {string} signalId  - Signal identifier.
   * @param {string} emittedAt - ISO-8601 emission timestamp.
   * @returns {Promise<void>} Resolves when `statsPath` is atomically updated.
   */
  markSignalEmitted(lessonId: string, signalId: string, emittedAt: string): Promise<void> {
    return this.enqueueLocked(async () => {
      const statsMap = await readLessonStatsFile(this.statsFilePath);
      const prev = statsMap[lessonId] ?? { recentOutcomes: [], totalCleanPasses: 0, totalViolated: 0 };
      statsMap[lessonId] = { ...prev, signalLastEmittedAt: { ...(prev.signalLastEmittedAt ?? {}), [signalId]: emittedAt } };
      this.tempCounter += 1;
      await atomicWriteJsonFile(this.statsFilePath, statsMap, this.tempCounter);
    });
  }

  /**
   * Permanently retires `lessonIds` in `statsPath` so subsequent `queryCandidates()` calls exclude them.
   *
   * Preserves historical `<definitionsDir>/<lessonId>.json` audit files while marking `retired: true`.
   * @param {readonly string[]} lessonIds - Lesson identifiers to retire.
   * @returns {Promise<void>} Resolves when `statsPath` is atomically updated.
   */
  retire(lessonIds: readonly string[]): Promise<void> {
    return this.enqueueLocked(async () => {
      if (lessonIds.length === 0) return;
      const statsMap = await readLessonStatsFile(this.statsFilePath);
      for (const id of lessonIds) {
        const prev = statsMap[id] ?? { recentOutcomes: [], totalCleanPasses: 0, totalViolated: 0 };
        statsMap[id] = {
          recentOutcomes: prev.recentOutcomes,
          totalCleanPasses: prev.totalCleanPasses,
          totalViolated: prev.totalViolated,
          epochAtCreation: prev.epochAtCreation,
          signalLastEmittedAt: prev.signalLastEmittedAt,
          retired: true,
        };
      }
      this.tempCounter += 1;
      await atomicWriteJsonFile(this.statsFilePath, statsMap, this.tempCounter);
    });
  }
}
