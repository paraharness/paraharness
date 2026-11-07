import { existsSync } from 'node:fs';
import path from 'node:path';
import type { LessonOutcome, LessonRecord } from '@harness-dsl/core';
import type { FsLessonDefinitionRecord } from './fs-lesson-definition-record.js';
import {
  atomicWriteJsonFile,
  readAllLessonDefinitions,
  readLessonStatsFile,
} from './fs-lesson-lock-and-atomic-io.js';
import {
  compareLessonRecordsByRelevance,
  computeLessonId,
  mergeDefinitionAndStats,
  scoreLessonsWithMiniSearch,
} from './fs-lesson-relevance.js';

/**
 * Parameters for {@link queryActiveLessonCandidates}.
 */
export interface QueryActiveLessonCandidatesParams {
  /** Absolute path to the definitions directory. */
  readonly definitionsDirPath: string;

  /** Absolute path to the telemetry stats file. */
  readonly statsFilePath: string;

  /** Search query text. */
  readonly queryText: string;

  /** Active task partitions. */
  readonly partitions: readonly string[];
}

/**
 * Parameters for {@link admitLessonToStore}.
 */
export interface AdmitLessonToStoreParams {
  /** Absolute path to the definitions directory. */
  readonly definitionsDirPath: string;

  /** Absolute path to the telemetry stats file. */
  readonly statsFilePath: string;

  /** Optional partition identifier. */
  readonly partition?: string;

  /** Preventative or prescriptive directive text. */
  readonly directive: string;

  /** Partition contract epoch at creation. */
  readonly epochAtCreation: number;

  /** Optional run identifier that admitted the lesson. */
  readonly createdByRunId?: string;
}

/**
 * Parameters for {@link recordLessonOutcomesInStore}.
 */
export interface RecordLessonOutcomesInStoreParams {
  /** Absolute path to the definitions directory. */
  readonly definitionsDirPath: string;

  /** Absolute path to the telemetry stats file. */
  readonly statsFilePath: string;

  /** Batch of lesson outcomes to record. */
  readonly outcomes: ReadonlyArray<{ readonly lessonId: string; readonly outcome: LessonOutcome }>;
}

/**
 * Parameters for {@link syncLessonCreationEpochsInStore}.
 */
export interface SyncLessonCreationEpochsInStoreParams {
  /** Absolute path to the definitions directory. */
  readonly definitionsDirPath: string;

  /** Absolute path to the telemetry stats file. */
  readonly statsFilePath: string;

  /** Run IDs whose topology overlays committed. */
  readonly runIds: readonly string[];

  /** Map of `partitionId` to committed base epoch. */
  readonly updatedEpochs: ReadonlyMap<string, number>;
}

/**
 * Parameters for {@link markLessonSignalEmittedInStore}.
 */
export interface MarkLessonSignalEmittedInStoreParams {
  /** Absolute path to the telemetry stats file. */
  readonly statsFilePath: string;

  /** Lesson identifier. */
  readonly lessonId: string;

  /** Signal identifier. */
  readonly signalId: string;

  /** ISO-8601 emission timestamp. */
  readonly emittedAt: string;
}

/**
 * Parameters for {@link retireLessonsInStore}.
 */
export interface RetireLessonsInStoreParams {
  /** Absolute path to the telemetry stats file. */
  readonly statsFilePath: string;

  /** Lesson identifiers to mark retired. */
  readonly lessonIds: readonly string[];
}

/**
 * Queries non-retired lesson definitions, scores them via `MiniSearch`, and returns sorted `LessonRecord` candidates.
 *
 * @param {QueryActiveLessonCandidatesParams} params - Store paths, query text, and active partitions.
 *
 * @returns {Promise<readonly LessonRecord[]>} Frozen sorted array of active candidate lesson records.
 */
export async function queryActiveLessonCandidates(
  params: QueryActiveLessonCandidatesParams,
): Promise<readonly LessonRecord[]> {
  const definitions = await readAllLessonDefinitions(params.definitionsDirPath);
  const statsMap = await readLessonStatsFile(params.statsFilePath);
  const activeDefinitions: FsLessonDefinitionRecord[] = [];
  for (const def of definitions) {
    if (statsMap[def.id]?.retired !== true) activeDefinitions.push(def);
  }
  const scoresById = scoreLessonsWithMiniSearch(
    params.queryText,
    activeDefinitions,
    new Set<string>(params.partitions),
  );
  const records: LessonRecord[] = [];
  for (const def of activeDefinitions) {
    records.push(mergeDefinitionAndStats(def, statsMap[def.id], scoresById.get(def.id) ?? 0));
  }
  records.sort(compareLessonRecordsByRelevance);
  return Object.freeze(records);
}

/**
 * Writes an immutable `<definitionsDir>/<lessonId>.json` file (if absent) and initializes telemetry counters in `statsPath`.
 *
 * @param {AdmitLessonToStoreParams} params - Store paths and lesson admission metadata.
 *
 * @returns {Promise<string>} Content-addressed `lessonId`.
 */
export async function admitLessonToStore(params: AdmitLessonToStoreParams): Promise<string> {
  const lessonId = computeLessonId(params.partition, params.directive);
  const defPath = path.join(params.definitionsDirPath, `${lessonId}.json`);
  if (!existsSync(defPath)) {
    const defRecord: FsLessonDefinitionRecord = Object.freeze({
      id: lessonId,
      partition: params.partition,
      directive: params.directive,
      epochAtCreation: params.epochAtCreation,
      createdByRunId: params.createdByRunId,
    });
    await atomicWriteJsonFile(defPath, defRecord);
  }
  const statsMap = await readLessonStatsFile(params.statsFilePath);
  if (statsMap[lessonId] === undefined) {
    statsMap[lessonId] = {
      recentOutcomes: [],
      totalCleanPasses: 0,
      totalViolated: 0,
      epochAtCreation: undefined,
      signalLastEmittedAt: undefined,
      retired: false,
    };
    await atomicWriteJsonFile(params.statsFilePath, statsMap);
  }
  return lessonId;
}

/**
 * Appends deduplicated step execution outcomes to `statsPath` and returns updated `LessonRecord` items.
 *
 * @param {RecordLessonOutcomesInStoreParams} params - Store paths and outcome batch.
 *
 * @returns {Promise<readonly LessonRecord[]>} Frozen array of updated lesson records.
 */
export async function recordLessonOutcomesInStore(
  params: RecordLessonOutcomesInStoreParams,
): Promise<readonly LessonRecord[]> {
  const definitions = await readAllLessonDefinitions(params.definitionsDirPath);
  const defById = new Map<string, FsLessonDefinitionRecord>();
  for (const def of definitions) defById.set(def.id, def);
  const statsMap = await readLessonStatsFile(params.statsFilePath);
  const touchedIds = new Set<string>();
  const mutableOutcomesById = new Map<string, LessonOutcome[]>();
  for (const outcomeEntry of params.outcomes) {
    const prev = statsMap[outcomeEntry.lessonId] ?? {
      recentOutcomes: [],
      totalCleanPasses: 0,
      totalViolated: 0,
    };
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
  await atomicWriteJsonFile(params.statsFilePath, statsMap);
  const updated: LessonRecord[] = [];
  for (const id of touchedIds) {
    const def = defById.get(id);
    if (def !== undefined) updated.push(mergeDefinitionAndStats(def, statsMap[id]));
  }
  return Object.freeze(updated);
}

/**
 * Aligns `epochAtCreation` overrides in `statsPath` for lessons created by `params.runIds`.
 *
 * @param {SyncLessonCreationEpochsInStoreParams} params - Store paths, committed run IDs, and updated partition epochs.
 *
 * @returns {Promise<void>} Resolves when `statsPath` is updated.
 */
export async function syncLessonCreationEpochsInStore(
  params: SyncLessonCreationEpochsInStoreParams,
): Promise<void> {
  if (params.runIds.length === 0 || params.updatedEpochs.size === 0) return;
  const runIdSet = new Set(params.runIds);
  const definitions = await readAllLessonDefinitions(params.definitionsDirPath);
  const statsMap = await readLessonStatsFile(params.statsFilePath);
  let mutated = false;
  for (const def of definitions) {
    if (
      def.createdByRunId === undefined ||
      !runIdSet.has(def.createdByRunId) ||
      def.partition === undefined
    ) {
      continue;
    }
    const newEpoch = params.updatedEpochs.get(def.partition);
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
    await atomicWriteJsonFile(params.statsFilePath, statsMap);
  }
}

/**
 * Persists the ISO-8601 emission timestamp for `params.signalId` on `params.lessonId` in `statsPath`.
 *
 * @param {MarkLessonSignalEmittedInStoreParams} params - Stats file path, lesson ID, signal ID, and timestamp.
 *
 * @returns {Promise<void>} Resolves when `statsPath` is atomically updated.
 */
export async function markLessonSignalEmittedInStore(
  params: MarkLessonSignalEmittedInStoreParams,
): Promise<void> {
  const statsMap = await readLessonStatsFile(params.statsFilePath);
  const prev = statsMap[params.lessonId] ?? {
    recentOutcomes: [],
    totalCleanPasses: 0,
    totalViolated: 0,
  };
  statsMap[params.lessonId] = {
    recentOutcomes: prev.recentOutcomes,
    totalCleanPasses: prev.totalCleanPasses,
    totalViolated: prev.totalViolated,
    epochAtCreation: prev.epochAtCreation,
    signalLastEmittedAt: {
      ...(prev.signalLastEmittedAt ?? {}),
      [params.signalId]: params.emittedAt,
    },
    retired: prev.retired,
  };
  await atomicWriteJsonFile(params.statsFilePath, statsMap);
}

/**
 * Marks `params.lessonIds` as `retired: true` in `statsPath` while preserving immutable definition files.
 *
 * @param {RetireLessonsInStoreParams} params - Stats file path and lesson IDs to retire.
 *
 * @returns {Promise<void>} Resolves when `statsPath` is atomically updated.
 */
export async function retireLessonsInStore(params: RetireLessonsInStoreParams): Promise<void> {
  if (params.lessonIds.length === 0) return;
  const statsMap = await readLessonStatsFile(params.statsFilePath);
  for (const id of params.lessonIds) {
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
  await atomicWriteJsonFile(params.statsFilePath, statsMap);
}
