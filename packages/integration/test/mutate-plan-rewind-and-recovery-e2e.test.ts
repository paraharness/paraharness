import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createExecutorRegistry,
  createRuntime,
  executeFlow,
  LaneScheduler,
  PoolManager,
  recoverInterruptedRunOnBoot,
  ScopeLockManager,
  ServiceSessionRegistry,
  StepContinuationQueue,
  type AgentContinuationFrame,
  type FlowExecutionContext,
  type GitScopeReceipt,
  type GitWorktreeHandle,
  type HumanAdapter,
} from '@harness-dsl/core';
import { FsJsonlLessonStore, fsExecutors } from '@harness-dsl/fs';
import { GitCowWorktreeScopeDriver, gitExecutors } from '@harness-dsl/git';
import { githubExecutors } from '@harness-dsl/github';
import { markdownExecutors } from '@harness-dsl/markdown';
import { nodeExecutors } from '@harness-dsl/node';
import { postgresExecutors } from '@harness-dsl/postgres';
import { slackExecutors } from '@harness-dsl/slack';
import { SqliteLedgerStore, SqliteTopologyStore, sqliteExecutors } from '@harness-dsl/sqlite';
import { describe, expect, it } from 'vitest';
import {
  appHarness,
  engineeringFlow,
  engineeringLane,
  engineeringPrefix,
  repoLessons,
  repoTopology,
  workspace,
  type WorkItem,
} from '../src/index.js';
import { createIntegrationWorkspaceFixture } from './fixtures/create-integration-workspace-fixture.js';
import { ScriptedIntegrationHumanAdapter } from './fixtures/scripted-integration-human-adapter.js';
import { ScriptedIntegrationModelDriver } from './fixtures/scripted-integration-model-driver.js';

function createFixtureLessonStore(repoDir: string): FsJsonlLessonStore {
  const storeNode = repoLessons.toAST().store;
  if (storeNode.type !== 'fs:jsonl-lesson-store') {
    throw new Error('Expected fs:jsonl-lesson-store');
  }
  return new FsJsonlLessonStore(storeNode, repoDir);
}

function buildFlowContextForRecoveryTest(
  fixture: Awaited<ReturnType<typeof createIntegrationWorkspaceFixture>>,
  runId: string,
  currentInput: WorkItem,
  modelDriver: ScriptedIntegrationModelDriver,
  humanAdapter: ScriptedIntegrationHumanAdapter,
  scopeHandle: GitWorktreeHandle,
  scopeDriver: GitCowWorktreeScopeDriver,
  stores: {
    readonly ledgerStore: SqliteLedgerStore;
    readonly topologyStore: SqliteTopologyStore;
    readonly lessonStore: FsJsonlLessonStore;
  },
): FlowExecutionContext<WorkItem, GitWorktreeHandle> {
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
      ledgers: { 'sqlite:ledger': () => stores.ledgerStore },
      models: { 'claude:model': () => modelDriver },
      humanChannels: {
        'slack:approver': () => humanAdapter,
        'slack:notifier': () => humanAdapter,
      },
    },
  );
  return {
    runId,
    laneId: 'engineering-throughput',
    itemKey: currentInput.ref,
    flow: { ...engineeringFlow.toAST(), scope: { ...workspace.toAST(), repo: fixture.repoDir } },
    currentInput,
    scopeHandle,
    scopeDriver,
    registry,
    env: fixture.env,
    ledgerStore: stores.ledgerStore,
    topologyStore: stores.topologyStore,
    lessonStore: stores.lessonStore,
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

describe('Dynamic .mutatePlan() (spawnTasks, syncRoot, stacked PRs, commitOverlayWhen) and steerSignal / crash recovery E2E', () => {
  it('suspends parent on spawnTasks, runs prerequisite #102 to land fix/#102, wakes parent with syncRoot and syncRunOverlays onto fix/#102, and commits overlays + lesson epochs on changeShippedSignal', async () => {
    const fixture = await createIntegrationWorkspaceFixture();
    try {
      const ledgerStore = new SqliteLedgerStore(fixture.sqlitePath);
      const topologyStore = new SqliteTopologyStore(fixture.sqlitePath);
      const lessonStore = createFixtureLessonStore(fixture.repoDir);
      const humanAdapter = new ScriptedIntegrationHumanAdapter(() => ({
        selectedOptionId: 'ok',
        approveSpecMutation: false,
        unlockedSpecFiles: [],
      }));

      let parentCoordTurn = 0;
      let prereqWorkerTurn = 0;

      const modelDriver = new ScriptedIntegrationModelDriver((req, _turnIdx, drv) => {
        if (req.roleKey === 'evaluator') return drv.buildStructuredResponse({ accepted: true, deficits: [] });

        if ((req.roleKey ?? '').startsWith('coordinator')) {
          parentCoordTurn += 1;
          if (parentCoordTurn === 1) {
            return drv.buildToolCallResponse([
              { id: 'parent-draft-write', name: 'write_file', argsJson: JSON.stringify({ path: 'packages/api/src/parent-draft.ts', content: 'export const PARENT_DRAFT = true;\n' }) },
              {
                id: 'parent-spawn-prereq',
                name: 'spawnTasks',
                argsJson: JSON.stringify({
                  tasks: [
                    {
                      itemKey: '#102',
                      item: { ref: '#102', title: 'Add tenant helper to db', description: 'Prerequisite DB module for #301', routingTier: 'leaf-only', targetPartitions: ['db'], dependsOn: [] },
                    },
                  ],
                }),
              },
            ]);
          }

          if (parentCoordTurn === 2) {
            return drv.buildToolCallResponse([
              { id: 'parent-update-api-contract', name: 'updatePartitionContract', argsJson: JSON.stringify({ partitionId: 'api', newContractText: 'api exports getUserEndpoint and getTenantEndpoint' }) },
              {
                id: 'parent-write-tenant-api',
                name: 'write_file',
                argsJson: JSON.stringify({
                  path: 'packages/api/src/tenant-endpoint.ts',
                  content: 'import { TENANT_DB_READY } from "@acme/db/src/tenant-db.js";\nexport const TENANT_API = TENANT_DB_READY;\n',
                }),
              },
            ]);
          }

          return drv.buildStructuredResponse({ summary: 'Stacked #301 onto prerequisite fix/#102 after wakeup sync', discoveredInvariants: [], residualRisks: [] });
        }

        prereqWorkerTurn += 1;
        if (prereqWorkerTurn === 1) {
          return drv.buildToolCallResponse([
            { id: 'prereq-write-db', name: 'write_file', argsJson: JSON.stringify({ path: 'packages/db/src/tenant-db.ts', content: 'export const TENANT_DB_READY = "ready";\n' }) },
          ]);
        }
        return drv.buildStructuredResponse({ summary: 'Landed prerequisite #102 DB tenant module', discoveredInvariants: [], residualRisks: [] });
      });

      const scopeDriver = new GitCowWorktreeScopeDriver({ ...workspace.toAST(), repo: fixture.repoDir });
      const parentRunId = 'run-parent-301';
      const parentHandle = await scopeDriver.acquireRoot(parentRunId);
      const parentInput: WorkItem = { ref: '#301', title: 'Stacked tenant API feature', description: 'Requires prerequisite #102 DB module', routingTier: 'deep', targetPartitions: ['api'], dependsOn: [] };
      const parentFlowCtx = buildFlowContextForRecoveryTest(fixture, parentRunId, parentInput, modelDriver, humanAdapter, parentHandle, scopeDriver, { ledgerStore, topologyStore, lessonStore });

      const firstPass = await executeFlow(parentFlowCtx);
      expect(firstPass.exitState).toBe('SUSPENDED');
      await scopeDriver.release(parentHandle);

      const prereqRunId = 'run-prereq-102';
      const prereqHandle = await scopeDriver.acquireRoot(prereqRunId);
      const prereqInput: WorkItem = { ref: '#102', title: 'Add tenant helper to db', description: 'Prerequisite DB module for #301', routingTier: 'leaf-only', targetPartitions: ['db'], dependsOn: [] };
      const prereqFlowCtx = buildFlowContextForRecoveryTest(fixture, prereqRunId, prereqInput, modelDriver, humanAdapter, prereqHandle, scopeDriver, { ledgerStore, topologyStore, lessonStore });

      await topologyStore.updateContract(prereqRunId, 'db', 'db exports UserRecord, queryUser, and TENANT_DB_READY', `${prereqRunId}:step-1`);
      const prereqResult = await executeFlow(prereqFlowCtx);
      expect(prereqResult.exitState).toBe('done');
      await ledgerStore.recordRunTerminalReceipt(prereqRunId, '#102', 'done', JSON.stringify(prereqResult.scopeReceipt));
      await scopeDriver.release(prereqHandle);

      const admittedLesson = await lessonStore.admit({
        partition: 'db',
        directive: 'Always export TENANT_DB_READY from tenant-db.ts',
        epochAtCreation: 0,
        createdByRunId: prereqRunId,
      });

      const bootRecords = await ledgerStore.getInterruptedStepsOnBoot();
      const parentBoot = bootRecords.find((r) => r.runId === parentRunId);
      expect(parentBoot?.status).toBe('SUSPENDED');
      expect(parentBoot?.dependsOn).toContain('#102');
      if (parentBoot === undefined) throw new Error('Expected suspended parent boot record');

      const recoveryRes = await recoverInterruptedRunOnBoot({ bootRecord: parentBoot, flow: parentFlowCtx.flow, flowCtx: parentFlowCtx });
      expect(recoveryRes.readyToResume).toBe(true);
      expect(parentFlowCtx.scopeHandle.baseBranch).toBe('fix/#102');

      try {
        const resumedParentResult = await executeFlow(parentFlowCtx);
        expect(resumedParentResult.exitState).toBe('done');
        const parentReceipt = resumedParentResult.scopeReceipt as GitScopeReceipt;
        expect(parentReceipt.baseBranch).toBe('fix/#102');
        await ledgerStore.recordRunTerminalReceipt(parentRunId, '#301', 'done', JSON.stringify({ ...parentReceipt, prerequisiteRunId: prereqRunId }));
      } finally {
        await scopeDriver.release(parentFlowCtx.scopeHandle);
      }

      const prs = await fixture.readCreatedPrs();
      expect(prs.map((p) => ({ head: p.head, base: p.base }))).toEqual([
        { head: 'fix/#102', base: 'main' },
        { head: 'fix/#301', base: 'fix/#102' },
      ]);

      const runtime = createRuntime(appHarness.toAST(), {
        registry: parentFlowCtx.registry,
        env: fixture.env,
        topologyNode: repoTopology.toAST(),
        topologyStore,
        lessonStore,
        humanAdaptersById: parentFlowCtx.humanAdaptersById,
      });
      await runtime.controller.emitSignal('change-shipped', { ref: '#301', mergeCommitSha: 'sha-merge-stacked', baseBranch: 'fix/#102' });
      await runtime.controller.emitSignal('change-shipped', { ref: '#102', mergeCommitSha: 'sha-merge-main', baseBranch: 'main' });

      const canonicalPartitions = await topologyStore.getPartitions();
      expect(canonicalPartitions.get('db')?.contractText).toContain('TENANT_DB_READY');
      expect(canonicalPartitions.get('api')?.contractText).toContain('getTenantEndpoint');

      const recalledCandidates = await lessonStore.queryCandidates({ queryText: 'TENANT_DB_READY', partitions: ['db'] });
      const updatedLesson = recalledCandidates.find((l) => l.id === admittedLesson);
      expect(updatedLesson?.epochAtCreation).toBeGreaterThan(0);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it('executes steerSignal rewindTo with git.keepWorktree() preserving dirty worktree files and recovers mid-tool-batch checkpoint on boot', async () => {
    const fixture = await createIntegrationWorkspaceFixture();
    try {
      const ledgerStore = new SqliteLedgerStore(fixture.sqlitePath);
      const topologyStore = new SqliteTopologyStore(fixture.sqlitePath);
      const lessonStore = createFixtureLessonStore(fixture.repoDir);
      const humanAdapter = new ScriptedIntegrationHumanAdapter(() => ({ selectedOptionId: 'ok', approveSpecMutation: false, unlockedSpecFiles: [] }));
      const modelDriver = new ScriptedIntegrationModelDriver((_req, _turn, drv) =>
        drv.buildStructuredResponse({ summary: 'done', discoveredInvariants: [], residualRisks: [] }),
      );

      const scopeDriver = new GitCowWorktreeScopeDriver({ ...workspace.toAST(), repo: fixture.repoDir });
      const runId = 'run:engineering-throughput:#302';
      const scopeHandle = await scopeDriver.acquireRoot(runId);
      const initialInput: WorkItem = { ref: '#302', title: 'Initial fast-path task', description: 'Original description', routingTier: 'auto', targetPartitions: ['api'], dependsOn: [] };
      const flowCtx = buildFlowContextForRecoveryTest(fixture, runId, initialInput, modelDriver, humanAdapter, scopeHandle, scopeDriver, { ledgerStore, topologyStore, lessonStore });

      try {
        const cleanCkpt = await scopeDriver.serializeCheckpoint(scopeHandle);
        flowCtx.stepBaseCheckpointsByStepId?.set('execute-work', cleanCkpt);
        flowCtx.activeStepId = 'execute-work';
        flowCtx.activeStepExecId = `${runId}:execute-work:1`;

        const dirtyFilePath = path.join(scopeHandle.worktreePath, 'packages/api/src/preserved-on-rewind.ts');
        await writeFile(dirtyFilePath, 'export const KEPT_ACROSS_REWIND = 1;\n', 'utf8');

        const scheduler = new LaneScheduler<WorkItem>({
          lane: { ...engineeringLane.toAST(), flow: flowCtx.flow },
          registry: flowCtx.registry,
          env: fixture.env,
          ledgerStore,
          topologyStore,
          lessonStore,
          humanAdaptersById: flowCtx.humanAdaptersById,
          trackerAdapter: { poll: async () => [], setExternalState: async () => undefined },
        });
        const itemState = await scheduler.enqueueItem({ input: initialInput, runId });
        itemState.status = 'RUNNING';
        itemState.activeFlowCtx = flowCtx as FlowExecutionContext<WorkItem, unknown>;
        await ledgerStore.recordStepStart({
          runId,
          stepExecId: flowCtx.activeStepExecId,
          stepId: 'execute-work',
          executableId: 'execute-work',
          inputMsgId: null,
          baseScopeCheckpoint: cleanCkpt,
          continuationStack: [],
        });

        const rewound = await scheduler.handleSignalRewind('steer', { note: 'Pivot to deep coordinator architecture' }, '#302');
        expect(rewound).toBe(true);
        expect(flowCtx.currentInput.routingTier).toBe('deep');
        expect(flowCtx.currentInput.description).toContain('Owner steering note: Pivot to deep coordinator architecture');
        expect(flowCtx.pendingRewindToStepId).toBe('execute-work');
        expect(await readFile(dirtyFilePath, 'utf8')).toBe('export const KEPT_ACROSS_REWIND = 1;\n');

        const preSubprocessCkpt = await scopeDriver.serializeCheckpoint(scopeHandle);
        await writeFile(dirtyFilePath, 'export const CORRUPTED_MID_SUBPROCESS = 999;\n', 'utf8');
        const crashStepExecId = `${runId}:execute-work:2`;
        const crashFrame: AgentContinuationFrame = {
          kind: 'agent-frame',
          agentId: 'worker',
          roleKey: 'worker',
          modelId: 'claude-sonnet-4-6',
          stepExecId: crashStepExecId,
          inputJson: JSON.stringify(flowCtx.currentInput),
          leafMessageId: null,
          turnsTaken: 1,
          costUsd: 0.01,
          elapsedDurationMs: 10,
          activeLeases: [],
          activeSkillIds: [],
          activeSkillActivations: {},
          observedEffects: [],
          injectedScopedRuleIds: [],
          pausedAtPhase: 'TOOL_BOUNDARY',
          pauseState: {
            kind: 'tool-batch',
            inFlightPreToolCheckpoint: preSubprocessCkpt,
            pendingToolBatch: { completedResults: [], blockedCalls: [], remainingCalls: [] },
          },
        };
        await ledgerStore.recordStepStart({
          runId,
          stepExecId: crashStepExecId,
          stepId: 'execute-work',
          executableId: 'worker',
          inputMsgId: null,
          baseScopeCheckpoint: cleanCkpt,
          continuationStack: [crashFrame],
        });

        const bootRecords = await ledgerStore.getInterruptedStepsOnBoot();
        const crashBoot = bootRecords.find((r) => r.stepExecId === crashStepExecId);
        expect(crashBoot).toBeDefined();
        if (crashBoot === undefined) throw new Error('Expected crashBoot record');

        await recoverInterruptedRunOnBoot({ bootRecord: crashBoot, flow: flowCtx.flow, flowCtx });
        expect(await readFile(dirtyFilePath, 'utf8')).toBe('export const KEPT_ACROSS_REWIND = 1;\n');
      } finally {
        await scopeDriver.release(scopeHandle);
      }
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});
