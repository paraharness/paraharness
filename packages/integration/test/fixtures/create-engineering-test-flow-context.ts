import {
  createExecutorRegistry,
  PoolManager,
  ScopeLockManager,
  ServiceSessionRegistry,
  StepContinuationQueue,
  type FlowExecutionContext,
  type GitWorktreeHandle,
  type HumanAdapter,
} from '@metaharness/core';
import { FsJsonlLessonStore, fsExecutors } from '@metaharness/fs';
import { type GitCowWorktreeScopeDriver, gitExecutors } from '@metaharness/git';
import { githubExecutors } from '@metaharness/github';
import { markdownExecutors } from '@metaharness/markdown';
import { nodeExecutors } from '@metaharness/node';
import { postgresExecutors } from '@metaharness/postgres';
import { slackExecutors } from '@metaharness/slack';
import {
  SqliteLedgerStore,
  SqliteTopologyStore,
  sqliteExecutors,
} from '@metaharness/sqlite';
import {
  engineeringFlow,
  engineeringPrefix,
  repoLessons,
  workspace,
  type WorkItem,
} from '../../src/index.js';
import type { IntegrationWorkspaceHandle } from './integration-workspace-handle.js';
import type { ScriptedIntegrationHumanAdapter } from './scripted-integration-human-adapter.js';
import type { ScriptedIntegrationModelDriver } from './scripted-integration-model-driver.js';

/**
 * Named parameter object for `createEngineeringTestFlowContext`.
 *
 * Bundles the temporary workspace fixture, run identifier, initial `WorkItem`, scripted model and human
 * test doubles, CoW worktree scope handle/driver, and optional pre-initialized stores.
 */
export interface CreateEngineeringTestFlowContextParams {
  /** Initialized temporary monorepo workspace fixture handle. */
  readonly fixture: IntegrationWorkspaceHandle;
  /** Unique identifier for the flow run. */
  readonly runId: string;
  /** Initial `WorkItem` payload for the flow run. */
  readonly currentInput: WorkItem;
  /** Scripted model driver responding to agent turns. */
  readonly modelDriver: ScriptedIntegrationModelDriver;
  /** Scripted human adapter responding to human escalations and notifications. */
  readonly humanAdapter: ScriptedIntegrationHumanAdapter;
  /** Acquired root Git CoW worktree handle. */
  readonly scopeHandle: GitWorktreeHandle;
  /** Git CoW worktree scope driver bound to `fixture.repoDir`. */
  readonly scopeDriver: GitCowWorktreeScopeDriver;
  /** Optional pre-created SQLite and JSONL stores shared across multi-run recovery tests. */
  readonly stores?: {
    /** Pre-initialized SQLite ledger store. */
    readonly ledgerStore: SqliteLedgerStore;
    /** Pre-initialized SQLite topology store. */
    readonly topologyStore: SqliteTopologyStore;
    /** Pre-initialized JSONL lesson store. */
    readonly lessonStore: FsJsonlLessonStore;
  };
}

/**
 * Constructs a `FlowExecutionContext<WorkItem, GitWorktreeHandle>` wired to `fixture` and real local stores (`M4-integration.md` §5).
 *
 * Binds `engineeringFlow` over `fixture.repoDir`, registers all peer adapter executor slices with
 * `modelDriver` and `humanAdapter` overrides, and initializes `SqliteLedgerStore`, `SqliteTopologyStore`,
 * and `FsJsonlLessonStore`.
 *
 * @param {CreateEngineeringTestFlowContextParams} params - Test flow context configuration parameters.
 *
 * @returns {FlowExecutionContext<WorkItem, GitWorktreeHandle>} Configured flow execution context ready for `executeFlow`.
 */
export function createEngineeringTestFlowContext(
  params: CreateEngineeringTestFlowContextParams,
): FlowExecutionContext<WorkItem, GitWorktreeHandle> {
  const {
    fixture,
    runId,
    currentInput,
    modelDriver,
    humanAdapter,
    scopeHandle,
    scopeDriver,
    stores,
  } = params;
  const lessonStoreNode = repoLessons.toAST().store;
  if (lessonStoreNode.type !== 'fs:jsonl-lesson-store') {
    throw new Error(
      `Expected repoLessons store type 'fs:jsonl-lesson-store' in run '${runId}', received '${lessonStoreNode.type}'.`,
    );
  }
  const ledgerStore = stores?.ledgerStore ?? new SqliteLedgerStore(fixture.sqlitePath);
  const topologyStore =
    stores?.topologyStore ?? new SqliteTopologyStore(fixture.sqlitePath);
  const lessonStore =
    stores?.lessonStore ?? new FsJsonlLessonStore(lessonStoreNode, fixture.repoDir);
  const registry = createExecutorRegistry(
    sqliteExecutors,
    postgresExecutors,
    fsExecutors,
    markdownExecutors,
    nodeExecutors,
    gitExecutors,
    githubExecutors,
    slackExecutors,
    {
      ledgers: { 'sqlite:ledger': () => ledgerStore },
      models: { 'claude:model': () => modelDriver },
      humanChannels: {
        'slack:approver': () => humanAdapter,
        'slack:notifier': () => humanAdapter,
      },
    },
  );
  const baseFlowAst = engineeringFlow.toAST();
  const baseScopeAst = workspace.toAST();
  return {
    runId,
    laneId: 'engineering-throughput',
    itemKey: currentInput.ref,
    flow: {
      type: baseFlowAst.type,
      id: baseFlowAst.id,
      inputSchema: baseFlowAst.inputSchema,
      scope: {
        type: baseScopeAst.type,
        id: baseScopeAst.id,
        capabilityTier: baseScopeAst.capabilityTier,
        repo: fixture.repoDir,
        dir: baseScopeAst.dir,
        excludeFromCloneGlobs: baseScopeAst.excludeFromCloneGlobs,
        setupCommands: baseScopeAst.setupCommands,
        lockfileGatePath: baseScopeAst.lockfileGatePath,
        checkpointPolicy: baseScopeAst.checkpointPolicy,
        reconcileStrategy: baseScopeAst.reconcileStrategy,
        conflictCleanCheck: baseScopeAst.conflictCleanCheck,
        supportsCheckpoints: baseScopeAst.supportsCheckpoints,
        supportsBranching: baseScopeAst.supportsBranching,
        receiptSchema: baseScopeAst.receiptSchema,
      },
      telemetry: baseFlowAst.telemetry,
      nodes: baseFlowAst.nodes,
      exitState: baseFlowAst.exitState,
    },
    currentInput,
    scopeHandle,
    scopeDriver,
    registry,
    env: fixture.env,
    ledgerStore,
    topologyStore,
    lessonStore,
    lockManager: new ScopeLockManager(),
    continuationQueue: new StepContinuationQueue(),
    poolManager: new PoolManager(),
    serviceRegistry: new ServiceSessionRegistry(),
    humanAdaptersById: new Map<string, HumanAdapter>([
      ['owner', humanAdapter],
      ['slack-bot', humanAdapter],
    ]),
    prefixGroups: [engineeringPrefix.toAST()],
    wirePrefixesByGroupId: new Map(),
    completedStepOutputs: new Map(),
    stepBaseCheckpointsByStepId: new Map(),
    observedRunEffects: [],
    activeStepId: null,
    activeStepExecId: null,
    activeStepAbortController: new AbortController(),
  };
}
