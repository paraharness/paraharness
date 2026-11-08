import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createRuntime,
  executeFlow,
  executeHierarchicalRewindDrain,
  LaneScheduler,
  recoverInterruptedRunOnBoot,
  type AgentContinuationFrame,
  type FlowExecutionContext,
  type GitWorktreeHandle,
  type ModelTurnResponse,
} from '@metaharness/core';
import { FsJsonlLessonStore } from '@metaharness/fs';
import { git, GitCowWorktreeScopeDriver } from '@metaharness/git';
import { SqliteLedgerStore, SqliteTopologyStore } from '@metaharness/sqlite';
import { describe, expect, it } from 'vitest';
import {
  appHarness,
  engineeringLane,
  repoLessons,
  repoTopology,
  workspace,
  type WorkItem,
} from '../src/index.js';
import { createEngineeringTestFlowContext } from './fixtures/create-engineering-test-flow-context.js';
import { createIntegrationWorkspaceFixture } from './fixtures/create-integration-workspace-fixture.js';
import type { IntegrationWorkspaceHandle } from './fixtures/integration-workspace-handle.js';
import { ScriptedIntegrationHumanAdapter } from './fixtures/scripted-integration-human-adapter.js';
import { ScriptedIntegrationModelDriver } from './fixtures/scripted-integration-model-driver.js';

interface MutatePlanScenarioState {
  parentCoordTurn: number;
  prereqWorkerTurn: number;
}

interface MutatePlanTestStores {
  readonly ledgerStore: SqliteLedgerStore;
  readonly topologyStore: SqliteTopologyStore;
  readonly lessonStore: FsJsonlLessonStore;
}

interface MutatePlanHarnessEnv {
  readonly fixture: IntegrationWorkspaceHandle;
  readonly stores: MutatePlanTestStores;
  readonly humanAdapter: ScriptedIntegrationHumanAdapter;
  readonly modelDriver: ScriptedIntegrationModelDriver;
  readonly scopeDriver: GitCowWorktreeScopeDriver;
}

function createFixtureLessonStore(repoDir: string): FsJsonlLessonStore {
  const storeNode = repoLessons.toAST().store;
  if (storeNode.type !== 'fs:jsonl-lesson-store') {
    throw new Error('Expected fs:jsonl-lesson-store');
  }
  return new FsJsonlLessonStore(storeNode, repoDir);
}

function createMutatePlanTestStores(
  fixture: IntegrationWorkspaceHandle,
): MutatePlanTestStores {
  return {
    ledgerStore: new SqliteLedgerStore(fixture.sqlitePath),
    topologyStore: new SqliteTopologyStore(fixture.sqlitePath),
    lessonStore: createFixtureLessonStore(fixture.repoDir),
  };
}

function handleMutatePlanCoordinatorTurn(
  drv: ScriptedIntegrationModelDriver,
  state: MutatePlanScenarioState,
): ModelTurnResponse {
  state.parentCoordTurn += 1;
  if (state.parentCoordTurn === 1) {
    return drv.buildToolCallResponse([
      {
        id: 'parent-draft-write',
        name: 'write_file',
        argsJson: JSON.stringify({
          path: 'packages/api/src/parent-draft.ts',
          content: 'export const PARENT_DRAFT = true;\n',
        }),
      },
      {
        id: 'parent-spawn-prereq',
        name: 'spawnTasks',
        argsJson: JSON.stringify({
          tasks: [
            {
              itemKey: '#102',
              item: {
                ref: '#102',
                title: 'Add tenant helper to db',
                description: 'Prerequisite DB module for #301',
                routingTier: 'leaf-only',
                targetPartitions: ['db'],
                dependsOn: [],
              },
            },
          ],
        }),
      },
    ]);
  }

  if (state.parentCoordTurn === 2) {
    return drv.buildToolCallResponse([
      {
        id: 'parent-update-api-contract',
        name: 'updatePartitionContract',
        argsJson: JSON.stringify({
          partitionId: 'api',
          newContractText: 'line1: getUserEndpoint\nline2: shared\nline3: getTenantEndpoint',
        }),
      },
      {
        id: 'parent-write-tenant-api',
        name: 'write_file',
        argsJson: JSON.stringify({
          path: 'packages/api/src/tenant-endpoint.ts',
          content:
            'import { TENANT_DB_READY } from "@acme/db/src/tenant-db.js";\nexport const TENANT_API = TENANT_DB_READY;\n',
        }),
      },
    ]);
  }

  return drv.buildStructuredResponse({
    summary: 'Stacked #301 onto prerequisite fix/#102 after wakeup sync',
    discoveredInvariants: [],
    residualRisks: [],
  });
}

function handleMutatePlanPrereqWorkerTurn(
  drv: ScriptedIntegrationModelDriver,
  state: MutatePlanScenarioState,
): ModelTurnResponse {
  state.prereqWorkerTurn += 1;
  if (state.prereqWorkerTurn === 1) {
    return drv.buildToolCallResponse([
      {
        id: 'prereq-write-db',
        name: 'write_file',
        argsJson: JSON.stringify({
          path: 'packages/db/src/tenant-db.ts',
          content: 'export const TENANT_DB_READY = "ready";\n',
        }),
      },
    ]);
  }
  return drv.buildStructuredResponse({
    summary: 'Landed prerequisite #102 DB tenant module',
    discoveredInvariants: [],
    residualRisks: [],
  });
}

function createMutatePlanModelDriver(
  state: MutatePlanScenarioState,
): ScriptedIntegrationModelDriver {
  return new ScriptedIntegrationModelDriver((req, _turnIdx, drv) => {
    if (req.roleKey === 'evaluator') {
      return drv.buildStructuredResponse({ accepted: true, deficits: [] });
    }
    if ((req.roleKey ?? '').startsWith('coordinator')) {
      return handleMutatePlanCoordinatorTurn(drv, state);
    }
    return handleMutatePlanPrereqWorkerTurn(drv, state);
  });
}

async function seedInitialTopologyContract(
  topologyStore: SqliteTopologyStore,
): Promise<void> {
  expect(repoTopology.dependentsOf('db')).toEqual(['api', 'web']);
  expect(repoTopology.affectedBy('db')).toEqual(['db', 'api', 'web']);
  await topologyStore.updateContract(
    'run-seed',
    'api',
    'line1: getUserEndpoint\nline2: shared\nline3: pending',
    'seed:1',
  );
  await topologyStore.commitRunOverlay('run-seed');
}

async function startAndSuspendParent301(
  env: MutatePlanHarnessEnv,
): Promise<FlowExecutionContext<WorkItem, GitWorktreeHandle>> {
  const parentRunId = 'run-parent-301';
  const parentHandle = await env.scopeDriver.acquireRoot(parentRunId);
  const parentInput: WorkItem = {
    ref: '#301',
    title: 'Stacked tenant API feature',
    description: 'Requires prerequisite #102 DB module',
    routingTier: 'deep',
    targetPartitions: ['api'],
    dependsOn: [],
  };
  const parentFlowCtx = createEngineeringTestFlowContext({
    fixture: env.fixture,
    runId: parentRunId,
    currentInput: parentInput,
    modelDriver: env.modelDriver,
    humanAdapter: env.humanAdapter,
    scopeHandle: parentHandle,
    scopeDriver: env.scopeDriver,
    stores: env.stores,
  });

  const firstPass = await executeFlow(parentFlowCtx);
  expect(firstPass.exitState).toBe('SUSPENDED');
  await env.scopeDriver.release(parentHandle);
  return parentFlowCtx;
}

async function runPrerequisite102AndAdmitLesson(
  env: MutatePlanHarnessEnv,
): Promise<string> {
  const prereqRunId = 'run-prereq-102';
  const prereqHandle = await env.scopeDriver.acquireRoot(prereqRunId);
  const prereqInput: WorkItem = {
    ref: '#102',
    title: 'Add tenant helper to db',
    description: 'Prerequisite DB module for #301',
    routingTier: 'leaf-only',
    targetPartitions: ['db'],
    dependsOn: [],
  };
  const prereqFlowCtx = createEngineeringTestFlowContext({
    fixture: env.fixture,
    runId: prereqRunId,
    currentInput: prereqInput,
    modelDriver: env.modelDriver,
    humanAdapter: env.humanAdapter,
    scopeHandle: prereqHandle,
    scopeDriver: env.scopeDriver,
    stores: env.stores,
  });

  await env.stores.topologyStore.updateContract(
    prereqRunId,
    'db',
    'db exports UserRecord, queryUser, and TENANT_DB_READY',
    `${prereqRunId}:step-1`,
  );
  const prereqResult = await executeFlow(prereqFlowCtx);
  expect(prereqResult.exitState).toBe('done');
  await env.stores.ledgerStore.recordRunTerminalReceipt(
    prereqRunId,
    '#102',
    'done',
    JSON.stringify(prereqResult.scopeReceipt),
  );
  await env.scopeDriver.release(prereqHandle);

  return await env.stores.lessonStore.admit({
    partition: 'db',
    directive: 'Always export TENANT_DB_READY from tenant-db.ts',
    epochAtCreation: 0,
    createdByRunId: prereqRunId,
  });
}

async function resumeParent301AfterPrerequisite(
  env: MutatePlanHarnessEnv,
  parentFlowCtx: FlowExecutionContext<WorkItem, GitWorktreeHandle>,
): Promise<void> {
  const bootRecords = await env.stores.ledgerStore.getInterruptedStepsOnBoot();
  const parentBoot = bootRecords.find((r) => r.runId === parentFlowCtx.runId);
  expect(parentBoot?.status).toBe('SUSPENDED');
  expect(parentBoot?.dependsOn).toContain('#102');
  if (parentBoot === undefined) {
    throw new Error('Expected suspended parent boot record');
  }

  const recoveryRes = await recoverInterruptedRunOnBoot({
    bootRecord: parentBoot,
    flow: parentFlowCtx.flow,
    flowCtx: parentFlowCtx,
  });
  expect(recoveryRes.readyToResume).toBe(true);
  expect(parentFlowCtx.scopeHandle.baseBranch).toBe('fix/#102');

  try {
    const resumedParentResult = await executeFlow(parentFlowCtx);
    expect(resumedParentResult.exitState).toBe('done');
    const parentReceipt = git.ScopeReceiptSchema.parse(resumedParentResult.scopeReceipt);
    expect(parentReceipt.baseBranch).toBe('fix/#102');
    await env.stores.ledgerStore.recordRunTerminalReceipt(
      parentFlowCtx.runId,
      '#301',
      'done',
      JSON.stringify({ ...parentReceipt, prerequisiteRunId: 'run-prereq-102' }),
    );
  } finally {
    await env.scopeDriver.release(parentFlowCtx.scopeHandle);
  }
}

async function emitChangeShippedAndVerifyOverlays(
  env: MutatePlanHarnessEnv,
  parentFlowCtx: FlowExecutionContext<WorkItem, GitWorktreeHandle>,
  admittedLessonId: string,
): Promise<void> {
  await env.stores.topologyStore.updateContract(
    'run-concurrent',
    'api',
    'line1: getUserEndpoint + healthCheck\nline2: shared\nline3: pending',
    'conc:1',
  );
  await env.stores.topologyStore.commitRunOverlay('run-concurrent');

  const prs = await env.fixture.readCreatedPrs();
  expect(prs.map((p) => ({ head: p.head, base: p.base }))).toEqual([
    { head: 'fix/#102', base: 'main' },
    { head: 'fix/#301', base: 'fix/#102' },
  ]);

  const runtime = createRuntime(appHarness.toAST(), {
    registry: parentFlowCtx.registry,
    env: env.fixture.env,
    topologyNode: repoTopology.toAST(),
    topologyStore: env.stores.topologyStore,
    lessonStore: env.stores.lessonStore,
    humanAdaptersById: parentFlowCtx.humanAdaptersById,
  });
  await runtime.controller.emitSignal('change-shipped', {
    ref: '#301',
    mergeCommitSha: 'sha-merge-stacked',
    baseBranch: 'fix/#102',
  });
  await runtime.controller.emitSignal('change-shipped', {
    ref: '#102',
    mergeCommitSha: 'sha-merge-main',
    baseBranch: 'main',
  });

  const canonicalPartitions = await env.stores.topologyStore.getPartitions();
  expect(canonicalPartitions.get('db')?.contractText).toContain('TENANT_DB_READY');
  expect(canonicalPartitions.get('api')?.contractText).toBe(
    'line1: getUserEndpoint + healthCheck\nline2: shared\nline3: getTenantEndpoint',
  );

  const recalledCandidates = await env.stores.lessonStore.queryCandidates({
    queryText: 'TENANT_DB_READY',
    partitions: ['db'],
  });
  const updatedLesson = recalledCandidates.find((l) => l.id === admittedLessonId);
  expect(updatedLesson?.epochAtCreation).toBeGreaterThan(0);
  expect(updatedLesson?.relevanceScore).toBeGreaterThan(0);
}

async function verifySteerRewindKeepWorktree(
  flowCtx: FlowExecutionContext<WorkItem, GitWorktreeHandle>,
  stores: MutatePlanTestStores,
  dirtyFilePath: string,
): Promise<string> {
  if (flowCtx.scopeDriver.serializeCheckpoint === undefined) {
    throw new Error('Expected checkpointable scopeDriver');
  }
  const cleanCkpt = await flowCtx.scopeDriver.serializeCheckpoint(flowCtx.scopeHandle);
  flowCtx.stepBaseCheckpointsByStepId?.set('execute-work', cleanCkpt);
  flowCtx.activeStepId = 'execute-work';
  flowCtx.activeStepExecId = `${flowCtx.runId}:execute-work:1`;

  await writeFile(dirtyFilePath, 'export const KEPT_ACROSS_REWIND = 1;\n', 'utf8');

  const scheduler = new LaneScheduler<WorkItem>({
    lane: { ...engineeringLane.toAST(), flow: flowCtx.flow },
    registry: flowCtx.registry,
    env: flowCtx.env,
    ledgerStore: stores.ledgerStore,
    topologyStore: stores.topologyStore,
    lessonStore: stores.lessonStore,
    humanAdaptersById: flowCtx.humanAdaptersById,
    trackerAdapter: { poll: async () => [], setExternalState: async () => undefined },
  });
  const itemState = await scheduler.enqueueItem({
    input: flowCtx.currentInput,
    runId: flowCtx.runId,
  });
  itemState.status = 'RUNNING';
  await stores.ledgerStore.recordStepStart({
    runId: flowCtx.runId,
    stepExecId: flowCtx.activeStepExecId,
    stepId: 'execute-work',
    executableId: 'execute-work',
    inputMsgId: null,
    baseScopeCheckpoint: cleanCkpt,
    continuationStack: [],
  });

  const rewound = await scheduler.handleSignalRewind(
    'steer',
    { note: 'Pivot to deep coordinator architecture' },
    '#302',
  );
  expect(rewound).toBe(true);
  await executeHierarchicalRewindDrain({
    flowCtx,
    rewindToStepId: 'execute-work',
    updatedInput: itemState.input,
    onRewindHook: git.keepWorktree().toAST(),
  });
  expect(flowCtx.currentInput.routingTier).toBe('deep');
  expect(flowCtx.currentInput.description).toContain(
    'Owner steering note: Pivot to deep coordinator architecture',
  );
  expect(flowCtx.pendingRewindToStepId).toBe('execute-work');
  expect(await readFile(dirtyFilePath, 'utf8')).toBe('export const KEPT_ACROSS_REWIND = 1;\n');
  return cleanCkpt;
}

async function verifyMidToolBatchBootRecovery(
  flowCtx: FlowExecutionContext<WorkItem, GitWorktreeHandle>,
  cleanCkpt: string,
  dirtyFilePath: string,
): Promise<void> {
  if (flowCtx.scopeDriver.serializeCheckpoint === undefined) {
    throw new Error('Expected checkpointable scopeDriver');
  }
  const preSubprocessCkpt = await flowCtx.scopeDriver.serializeCheckpoint(flowCtx.scopeHandle);
  await writeFile(dirtyFilePath, 'export const CORRUPTED_MID_SUBPROCESS = 999;\n', 'utf8');
  const crashStepExecId = `${flowCtx.runId}:execute-work:2`;
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
  await flowCtx.ledgerStore?.recordStepStart({
    runId: flowCtx.runId,
    stepExecId: crashStepExecId,
    stepId: 'execute-work',
    executableId: 'worker',
    inputMsgId: null,
    baseScopeCheckpoint: cleanCkpt,
    continuationStack: [crashFrame],
  });

  const bootRecords = (await flowCtx.ledgerStore?.getInterruptedStepsOnBoot()) ?? [];
  const crashBoot = bootRecords.find((r) => r.stepExecId === crashStepExecId);
  expect(crashBoot?.stepExecId).toBe(crashStepExecId);
  if (crashBoot === undefined) {
    throw new Error('Expected crashBoot record');
  }

  await recoverInterruptedRunOnBoot({
    bootRecord: crashBoot,
    flow: flowCtx.flow,
    flowCtx,
  });
  expect(await readFile(dirtyFilePath, 'utf8')).toBe('export const KEPT_ACROSS_REWIND = 1;\n');
}

describe('Dynamic .mutatePlan() (spawnTasks, syncRoot, stacked PRs, commitOverlayWhen) and steerSignal / crash recovery E2E', () => {
  it('suspends parent on spawnTasks, runs prerequisite #102 to land fix/#102, wakes parent with syncRoot and syncRunOverlays onto fix/#102, and commits overlays + lesson epochs on changeShippedSignal', async () => {
    const fixture = await createIntegrationWorkspaceFixture();
    try {
      const stores = createMutatePlanTestStores(fixture);
      const humanAdapter = new ScriptedIntegrationHumanAdapter(() => ({
        selectedOptionId: 'ok',
        approveSpecMutation: false,
        unlockedSpecFiles: [],
      }));
      const state: MutatePlanScenarioState = {
        parentCoordTurn: 0,
        prereqWorkerTurn: 0,
      };
      const modelDriver = createMutatePlanModelDriver(state);
      const scopeDriver = new GitCowWorktreeScopeDriver({
        ...workspace.toAST(),
        repo: fixture.repoDir,
      });
      const harnessEnv: MutatePlanHarnessEnv = {
        fixture,
        stores,
        humanAdapter,
        modelDriver,
        scopeDriver,
      };

      await seedInitialTopologyContract(stores.topologyStore);
      const parentFlowCtx = await startAndSuspendParent301(harnessEnv);
      const admittedLessonId = await runPrerequisite102AndAdmitLesson(harnessEnv);
      await resumeParent301AfterPrerequisite(harnessEnv, parentFlowCtx);
      await emitChangeShippedAndVerifyOverlays(harnessEnv, parentFlowCtx, admittedLessonId);
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it('executes steerSignal rewindTo with git.keepWorktree() preserving dirty worktree files and recovers mid-tool-batch checkpoint on boot', async () => {
    const fixture = await createIntegrationWorkspaceFixture();
    try {
      const stores = createMutatePlanTestStores(fixture);
      const humanAdapter = new ScriptedIntegrationHumanAdapter(() => ({
        selectedOptionId: 'ok',
        approveSpecMutation: false,
        unlockedSpecFiles: [],
      }));
      const modelDriver = new ScriptedIntegrationModelDriver((_req, _turn, drv) =>
        drv.buildStructuredResponse({
          summary: 'done',
          discoveredInvariants: [],
          residualRisks: [],
        }),
      );

      const scopeDriver = new GitCowWorktreeScopeDriver({
        ...workspace.toAST(),
        repo: fixture.repoDir,
      });
      const runId = 'run:engineering-throughput:#302';
      const scopeHandle = await scopeDriver.acquireRoot(runId);
      const initialInput: WorkItem = {
        ref: '#302',
        title: 'Initial fast-path task',
        description: 'Original description',
        routingTier: 'auto',
        targetPartitions: ['api'],
        dependsOn: [],
      };
      const flowCtx = createEngineeringTestFlowContext({
        fixture,
        runId,
        currentInput: initialInput,
        modelDriver,
        humanAdapter,
        scopeHandle,
        scopeDriver,
        stores,
      });

      try {
        const dirtyFilePath = path.join(
          scopeHandle.worktreePath,
          'packages/api/src/preserved-on-rewind.ts',
        );
        const cleanCkpt = await verifySteerRewindKeepWorktree(flowCtx, stores, dirtyFilePath);
        await verifyMidToolBatchBootRecovery(flowCtx, cleanCkpt, dirtyFilePath);
      } finally {
        await scopeDriver.release(scopeHandle);
      }
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});
