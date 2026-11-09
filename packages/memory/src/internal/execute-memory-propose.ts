import path from 'node:path';
import { withFileLock } from '@paraharness/lockfile';
import { z } from 'zod';
import { ClaudeCliDistillerRunner } from '../claude-cli-distiller-runner.js';
import type { MemoryDistillerRunner } from '../memory-distiller-runner.js';
import { MemoryHarnessError } from '../memory-harness-error.js';
import type { MemoryConfig } from '../schemas/memory-config.schema.js';
import type { MemoryRecord } from '../schemas/memory-record.schema.js';
import {
  DistillerStructuredOutputSchema,
  MemoryProposeInputSchema,
  type DistillerStructuredOutput,
  type MemoryBucketStatus,
  type MemoryProposeInput,
  type MemoryProposeOutput,
} from '../schemas/memory-tools.schema.js';
import { assertAllowedRole } from './assert-allowed-role.js';
import { buildDistillerPrompts } from './build-distiller-prompts.js';
import { ensureMemoryGitCheckout } from './ensure-memory-git-checkout.js';
import {
  deduplicateReposArray,
  hydrateAndValidateProposeChoices,
} from './hydrate-and-validate-propose-choices.js';
import { isGlobPattern } from './is-glob-pattern.js';
import { listRepoFiles } from './list-repo-files.js';
import { normalizeMemoryPathArray } from './normalize-memory-path-pattern.js';
import { readMemoryLedger } from './read-memory-ledger.js';
import { composeCumulativeIdRemap } from './reconcile-diverged-memory-ledgers.js';
import { remapOtherSessionStatesAfterLockRelease } from './remap-other-session-states-after-lock-release.js';
import { resolveRecordCapBucket } from './resolve-record-cap-bucket.js';

/**
 * Parameter object for `executeMemoryPropose`.
 */
export interface ExecuteMemoryProposeParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Pre-compiled `forbidRegexes` patterns from `loadMemoryConfig`. */
  readonly compiledForbidRegexes: readonly RegExp[];
  /** Candidate proposal input (`callerRole`, `targetRole`, `type`, `rawText`, `context`, `repos`, `incident`). */
  readonly input: MemoryProposeInput;
  /** Optional injected Distiller runner from `MemoryHarnessOptions`. */
  readonly distillerRunner?: MemoryDistillerRunner;
  /** Current UTC timestamp in epoch milliseconds. */
  readonly nowMs: number;
}

/**
 * Parameter object for `captureProposeLedgerSnapshotUnderLock`.
 */
export interface CaptureProposeSnapshotParams {
  /** Absolute path to the workspace root directory. */
  readonly workspaceRoot: string;
  /** Validated unified memory configuration. */
  readonly config: MemoryConfig;
  /** Candidate proposal input. */
  readonly input: MemoryProposeInput;
  /** Normalized candidate context array, if provided. */
  readonly normalizedContext?: readonly string[];
  /** Deduplicated candidate repos array, if provided. */
  readonly normalizedRepos?: readonly string[];
  /** Tracked workspace-relative POSIX file paths. */
  readonly repoFiles: readonly string[];
  /** Current UTC timestamp in epoch milliseconds. */
  readonly nowMs: number;
}

/**
 * Acquires `<ledgerPath>.lock`, loads an in-memory snapshot of active records, evaluates
 * `bucketStatus` for the synthetic candidate, and immediately releases `<ledgerPath>.lock` before
 * prompt construction or Distiller execution (§6.4 Step 2).
 *
 * @param {CaptureProposeSnapshotParams} params - Workspace root, config, candidate scope, `repoFiles`, and `nowMs`.
 *
 * @returns {Promise<{ readonly records: readonly MemoryRecord[]; readonly bucketStatus: MemoryBucketStatus; readonly cumulativeIdRemap: ReadonlyMap<string, string> }>} Snapshot records, target bucket status, and any checkout reconciliation ID remap.
 */
function captureProposeLedgerSnapshotUnderLock(params: CaptureProposeSnapshotParams): Promise<{
  readonly records: readonly MemoryRecord[];
  readonly bucketStatus: MemoryBucketStatus;
  readonly cumulativeIdRemap: ReadonlyMap<string, string>;
}> {
  const absLedgerPath = path.resolve(params.workspaceRoot, params.config.storage.ledgerPath);
  const ledgerLockPath = `${absLedgerPath}.lock`;
  return withFileLock(ledgerLockPath, async () => {
    const cumulativeIdRemap = new Map<string, string>();
    if (params.config.storage.git.enabled) {
      const checkoutOutcome = await ensureMemoryGitCheckout({
        workspaceRoot: params.workspaceRoot,
        config: params.config,
        isInitCall: false,
        nowMs: params.nowMs,
      });
      composeCumulativeIdRemap(cumulativeIdRemap, checkoutOutcome.cumulativeIdRemap);
    }
    const snapshot = await readMemoryLedger(absLedgerPath, params.nowMs);
    const bucketStatus = resolveRecordCapBucket({
      candidate: {
        type: params.input.type,
        role: params.input.targetRole,
        context: params.normalizedContext,
        repos: params.normalizedRepos,
      },
      records: snapshot.records,
      config: params.config,
      repoFiles: params.repoFiles,
    });
    return Object.freeze({
      records: snapshot.records,
      bucketStatus,
      cumulativeIdRemap,
    });
  });
}

/**
 * Invokes `runner.runDistillerProposal` and validates its return value against
 * `DistillerStructuredOutputSchema`, normalizing any thrown failure into `MemoryHarnessError('DISTILLER_EXECUTION_FAILED')` (§6.4 Step 4).
 *
 * @param {MemoryDistillerRunner}            runner  - Active `MemoryDistillerRunner` instance.
 * @param {Parameters<MemoryDistillerRunner['runDistillerProposal']>[0]} request - Distiller proposal request.
 *
 * @returns {Promise<DistillerStructuredOutput>} Validated `DistillerStructuredOutput`.
 *
 * @throws {MemoryHarnessError} With `'DISTILLER_EXECUTION_FAILED'` when the runner throws or returns invalid schema output.
 */
async function invokeDistillerRunnerSafely(
  runner: MemoryDistillerRunner,
  request: Parameters<MemoryDistillerRunner['runDistillerProposal']>[0],
): Promise<DistillerStructuredOutput> {
  let rawOutput: unknown;
  try {
    rawOutput = await runner.runDistillerProposal(request);
  } catch (err) {
    if (err instanceof MemoryHarnessError && err.code === 'DISTILLER_EXECUTION_FAILED') {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new MemoryHarnessError(
      'DISTILLER_EXECUTION_FAILED',
      `Distiller runner execution failed: ${message}`,
    );
  }
  const validated = DistillerStructuredOutputSchema.safeParse(rawOutput);
  if (!validated.success) {
    throw new MemoryHarnessError(
      'DISTILLER_EXECUTION_FAILED',
      `Distiller runner output failed DistillerStructuredOutputSchema validation: ${validated.error.message}`,
      { issues: validated.error.issues },
    );
  }
  return validated.data;
}

/**
 * Checks whether `config.caps` contains any capacity rule with an explicit glob pattern (`p !== '*' && isGlobPattern(p)`),
 * which is the only condition under which `resolveRecordCapBucket` inspects `repoFiles` (§5.2.1).
 *
 * @param {MemoryConfig} config - Validated unified memory configuration.
 *
 * @returns {boolean} `true` if at least one capacity rule path is an explicit glob pattern; `false` otherwise.
 */
function hasExplicitGlobCapPaths(config: MemoryConfig): boolean {
  return config.caps.some((cap) => cap.paths.some((p) => p !== '*' && isGlobPattern(p)));
}

/**
 * Executes the `memory_propose` tool contract (§6.4): validates roles and candidate fields, snapshots
 * the ledger under `<ledgerPath>.lock` and immediately releases the lock before Distiller execution,
 * builds the KV-cacheable `systemPrompt` and dynamic `userPrompt`, and either resolves the proposal
 * via `MemoryDistillerRunner` / `ClaudeCliDistillerRunner` or returns `delegate_to_subagent`.
 *
 * @param {ExecuteMemoryProposeParams} params - Workspace root, config, compiled regexes, input, optional runner, and `nowMs`.
 *
 * @returns {Promise<MemoryProposeOutput>} Resolved proposal choices or subagent delegation payload.
 *
 * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, `'LESSON_FORMAT_INVALID'`, `'RULE_PROTECTION_VIOLATION'`, `'DISTILLER_EXECUTION_FAILED'`, or `'GIT_SYNC_FAILED'`.
 */
export async function executeMemoryPropose(
  params: ExecuteMemoryProposeParams,
): Promise<MemoryProposeOutput> {
  assertAllowedRole(params.input.callerRole, params.config.allowedRoles, 'callerRole');
  assertAllowedRole(params.input.targetRole, params.config.allowedRoles, 'targetRole');
  const parsedInput = MemoryProposeInputSchema.safeParse(params.input);
  if (!parsedInput.success) {
    throw new MemoryHarnessError(
      'VALIDATION_FAILED',
      `Invalid memory_propose input: ${parsedInput.error.message}`,
      { issues: parsedInput.error.issues },
    );
  }
  const validatedInput = parsedInput.data;
  const normalizedContext =
    validatedInput.context !== undefined
      ? normalizeMemoryPathArray(validatedInput.context, params.workspaceRoot)
      : undefined;
  const normalizedRepos = deduplicateReposArray(validatedInput.repos);
  const repoFiles = hasExplicitGlobCapPaths(params.config)
    ? await listRepoFiles(params.workspaceRoot)
    : [];
  const snapshotOutcome = await captureProposeLedgerSnapshotUnderLock({
    workspaceRoot: params.workspaceRoot,
    config: params.config,
    input: validatedInput,
    normalizedContext,
    normalizedRepos,
    repoFiles,
    nowMs: params.nowMs,
  });
  if (snapshotOutcome.cumulativeIdRemap.size > 0) {
    await remapOtherSessionStatesAfterLockRelease(
      params.workspaceRoot,
      snapshotOutcome.cumulativeIdRemap,
    );
  }
  const normalizedCandidate: MemoryProposeInput = {
    ...validatedInput,
    repos: normalizedRepos !== undefined ? [...normalizedRepos] : undefined,
  };
  const prompts = buildDistillerPrompts({
    workspaceRoot: params.workspaceRoot,
    config: params.config,
    records: snapshotOutcome.records,
    candidate: normalizedCandidate,
    normalizedContext,
    bucketStatus: snapshotOutcome.bucketStatus,
  });
  const outputJsonSchema = z.toJSONSchema(DistillerStructuredOutputSchema) as Readonly<
    Record<string, unknown>
  >;
  const requiresOwnerGo = validatedInput.type === 'rule';
  if (
    params.config.distiller.runner === 'subagent' &&
    params.distillerRunner === undefined
  ) {
    return Object.freeze<MemoryProposeOutput>({
      executionMode: 'delegate_to_subagent',
      type: validatedInput.type,
      requiresOwnerGo,
      bucketStatus: snapshotOutcome.bucketStatus,
      delegateToSubagent: Object.freeze({
        model: params.config.distiller.model,
        effort: params.config.distiller.effort,
        timeoutMs: params.config.distiller.timeoutMs,
        systemPrompt: prompts.systemPrompt,
        userPrompt: prompts.userPrompt,
        outputJsonSchema: { ...outputJsonSchema },
      }),
    });
  }
  const activeRunner = params.distillerRunner ?? new ClaudeCliDistillerRunner();
  const distillerOutput = await invokeDistillerRunnerSafely(activeRunner, {
    model: params.config.distiller.model,
    effort: params.config.distiller.effort,
    timeoutMs: params.config.distiller.timeoutMs,
    systemPrompt: prompts.systemPrompt,
    userPrompt: prompts.userPrompt,
    bucketStatus: snapshotOutcome.bucketStatus,
    outputJsonSchema,
  });
  const hydratedChoices = hydrateAndValidateProposeChoices({
    workspaceRoot: params.workspaceRoot,
    config: params.config,
    compiledForbidRegexes: params.compiledForbidRegexes,
    candidate: normalizedCandidate,
    normalizedContext,
    normalizedRepos,
    records: snapshotOutcome.records,
    repoFiles,
    bucketStatus: snapshotOutcome.bucketStatus,
    distillerOutput,
  });
  return Object.freeze<MemoryProposeOutput>({
    executionMode: 'resolved',
    type: validatedInput.type,
    requiresOwnerGo,
    bucketStatus: snapshotOutcome.bucketStatus,
    matchStatus: distillerOutput.matchStatus,
    tierRejectionReason: distillerOutput.tierRejectionReason,
    recommendedChoiceIndex: distillerOutput.recommendedChoiceIndex,
    choices: [...hydratedChoices],
  });
}
