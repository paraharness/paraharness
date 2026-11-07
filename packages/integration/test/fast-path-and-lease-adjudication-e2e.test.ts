import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  createExecutorRegistry,
  executeFlow,
  PoolManager,
  ScopeLockManager,
  ServiceSessionRegistry,
  StepContinuationQueue,
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
  engineeringFlow,
  engineeringPrefix,
  repoLessons,
  workspace,
  type WorkItem,
} from '../src/index.js';
import { createIntegrationWorkspaceFixture } from './fixtures/create-integration-workspace-fixture.js';
import { ScriptedIntegrationHumanAdapter } from './fixtures/scripted-integration-human-adapter.js';
import { ScriptedIntegrationModelDriver } from './fixtures/scripted-integration-model-driver.js';

function buildEngineeringTestFlowContext(
  fixture: Awaited<ReturnType<typeof createIntegrationWorkspaceFixture>>,
  runId: string,
  currentInput: WorkItem,
  modelDriver: ScriptedIntegrationModelDriver,
  humanAdapter: ScriptedIntegrationHumanAdapter,
  scopeHandle: GitWorktreeHandle,
  scopeDriver: GitCowWorktreeScopeDriver,
): FlowExecutionContext<WorkItem, GitWorktreeHandle> {
  const lessonStoreNode = repoLessons.toAST().store;
  if (lessonStoreNode.type !== 'fs:jsonl-lesson-store') {
    throw new Error('Expected fs:jsonl-lesson-store');
  }
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
    ledgerStore: new SqliteLedgerStore(fixture.sqlitePath),
    topologyStore: new SqliteTopologyStore(fixture.sqlitePath),
    lessonStore: new FsJsonlLessonStore(lessonStoreNode, fixture.repoDir),
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
    observedRunEffects: [],
    activeStepId: null,
    activeStepExecId: null,
    activeStepAbortController: new AbortController(),
  };
}

describe('Fast-path Protocol 1 (Existing Test Lease Adjudication) and scopeTripwire promotion E2E', () => {
  it('intercepts existing .test.ts mutation via fs.writeGuard, escalates normativeEscalation to owner, elevates lease across loop, and lands PR', async () => {
    const fixture = await createIntegrationWorkspaceFixture();
    try {
      const humanAdapter = new ScriptedIntegrationHumanAdapter((req) => {
        expect(req.humanId).toBe('owner');
        expect(req.payload).toMatchObject({
          question: 'Should getUserEndpoint append ?vip=1 in PRODUCT_SPEC.md?',
        });
        return {
          selectedOptionId: 'opt-approve-vip',
          approveSpecMutation: true,
          unlockedSpecFiles: ['PRODUCT_SPEC.md'],
          note: 'Approve spec and existing test update for VIP email suffix',
        };
      });

      let workerTurn = 0;
      let adjudicatorTurn = 0;
      const modelDriver = new ScriptedIntegrationModelDriver((req, _turnIdx, drv) => {
        if (req.roleKey === 'lease-adjudicator') {
          adjudicatorTurn += 1;
          if (adjudicatorTurn === 1) {
            return drv.buildToolCallResponse([
              {
                id: 'adj-escalate-1',
                name: 'normative-tradeoff',
                argsJson: JSON.stringify({
                  question: 'Should getUserEndpoint append ?vip=1 in PRODUCT_SPEC.md?',
                  options: [
                    {
                      id: 'opt-approve-vip',
                      summary: 'Update PRODUCT_SPEC.md and existing test',
                      tradeoffs: 'Changes public email string format',
                    },
                  ],
                  recommendation: 'opt-approve-vip',
                }),
              },
            ]);
          }
          return drv.buildStructuredResponse({
            approved: true,
            unlockedGlobs: ['packages/api/test/index.test.ts'],
            ruling: 'Owner approved updating PRODUCT_SPEC.md and packages/api/test/index.test.ts',
          });
        }

        if (req.roleKey === 'evaluator') {
          return drv.buildStructuredResponse({ accepted: true, deficits: [] });
        }

        workerTurn += 1;
        if (workerTurn === 1) {
          return drv.buildToolCallResponse([
            { id: 'w-read-impl', name: 'read_file', argsJson: JSON.stringify({ path: 'packages/api/src/user-endpoint.ts' }) },
            { id: 'w-read-test', name: 'read_file', argsJson: JSON.stringify({ path: 'packages/api/test/index.test.ts' }) },
            { id: 'w-read-spec', name: 'read_file', argsJson: JSON.stringify({ path: 'PRODUCT_SPEC.md' }) },
          ]);
        }

        if (workerTurn === 2) {
          return drv.buildToolCallResponse([
            {
              id: 'w-edit-impl',
              name: 'edit_file',
              argsJson: JSON.stringify({
                path: 'packages/api/src/user-endpoint.ts',
                oldString: 'return queryUser(id).email;',
                newString: 'return `${queryUser(id).email}?vip=1`;',
              }),
            },
            {
              id: 'w-edit-existing-test',
              name: 'edit_file',
              argsJson: JSON.stringify({
                path: 'packages/api/test/index.test.ts',
                oldString: "'u1@acme.test'",
                newString: "'u1@acme.test?vip=1'",
              }),
            },
            {
              id: 'w-edit-spec',
              name: 'edit_file',
              argsJson: JSON.stringify({
                path: 'PRODUCT_SPEC.md',
                oldString: 'Users have `id` and `email`.',
                newString: 'Users have `id` and `email` with `?vip=1` query suffix.',
              }),
            },
          ]);
        }

        const lastFrame = req.history[req.history.length - 1];
        const replayedTestEdit = lastFrame?.canonical.toolResults?.find(
          (tr) => tr.callId === 'w-edit-existing-test',
        );
        expect(replayedTestEdit?.isError).toBe(false);
        expect(replayedTestEdit?.content).toContain('[Lease Elevated:');

        return drv.buildStructuredResponse({
          summary: 'Updated getUserEndpoint and existing test under elevated owner + adjudicator lease',
          discoveredInvariants: ['VIP suffix required on getUserEndpoint'],
          residualRisks: [],
        });
      });

      const scopeDriver = new GitCowWorktreeScopeDriver({ ...workspace.toAST(), repo: fixture.repoDir });
      const runId = 'run-fast-lease-101';
      const scopeHandle = await scopeDriver.acquireRoot(runId);
      const flowCtx = buildEngineeringTestFlowContext(
        fixture,
        runId,
        {
          ref: '#101',
          title: 'Append VIP flag to getUserEndpoint',
          description: 'Append ?vip=1 to getUserEndpoint and update test + spec',
          routingTier: 'leaf-only',
          targetPartitions: ['api'],
          dependsOn: [],
        },
        modelDriver,
        humanAdapter,
        scopeHandle,
        scopeDriver,
      );

      try {
        const result = await executeFlow(flowCtx);
        expect(result.exitState).toBe('done');
        expect(humanAdapter.decisionRequests).toHaveLength(1);
        const receipt = result.scopeReceipt as GitScopeReceipt;
        expect(receipt.mutatedFiles).toEqual(
          expect.arrayContaining([
            'PRODUCT_SPEC.md',
            'packages/api/src/user-endpoint.ts',
            'packages/api/test/index.test.ts',
          ]),
        );
        const prs = await fixture.readCreatedPrs();
        expect(prs).toHaveLength(1);
        expect(prs[0]?.head).toBe('fix/#101');
      } finally {
        await scopeDriver.release(scopeHandle);
      }
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it('trips fast-path fs.maxFilesMutated(4), runs 4-step onLimitExceeded flush, snapshots dirty worktree via git.snapshotAndReset, and promotes to coordinator', async () => {
    const fixture = await createIntegrationWorkspaceFixture();
    try {
      const humanAdapter = new ScriptedIntegrationHumanAdapter(() => ({
        selectedOptionId: 'ok',
        approveSpecMutation: false,
        unlockedSpecFiles: [],
      }));

      let fastWorkerTurn = 0;
      let coordinatorTurn = 0;
      let inspectedAbortedFileContent = '';

      const modelDriver = new ScriptedIntegrationModelDriver((req, _turnIdx, drv) => {
        if (req.toolChoice === 'none') {
          return drv.buildStructuredResponse({
            reason: 'Exceeded 4 mutated files in fast-path worker',
            implicatedPartitions: ['api'],
            findings: 'Created 5 helper modules across packages/api/src before tripwire',
          });
        }

        if ((req.roleKey ?? '').startsWith('coordinator')) {
          coordinatorTurn += 1;
          const turn0Text = req.history[0]?.canonical.visibleText ?? '';
          expect(turn0Text).toContain('Created 5 helper modules across packages/api/src before tripwire');
          expect(turn0Text).toContain('refs/harness/aborted/');

          if (coordinatorTurn === 1) {
            const matchRef = /refs\/harness\/aborted\/[^\s"\\]+/.exec(turn0Text);
            const abortedRef = matchRef?.[0] ?? 'refs/harness/aborted/missing';
            return drv.buildToolCallResponse([
              {
                id: 'coord-read-aborted-ref',
                name: 'readRefFile',
                argsJson: JSON.stringify({
                  ref: abortedRef,
                  path: 'packages/api/src/step-1.ts',
                }),
              },
              {
                id: 'coord-write-consolidated',
                name: 'write_file',
                argsJson: JSON.stringify({
                  path: 'packages/api/src/index.ts',
                  content: "export { getUserEndpoint } from './user-endpoint.ts';\nexport const CONSOLIDATED = true;\n",
                }),
              },
            ]);
          }

          const lastCoordFrame = req.history[req.history.length - 1];
          const refReadResult = lastCoordFrame?.canonical.toolResults?.find(
            (tr) => tr.callId === 'coord-read-aborted-ref',
          );
          inspectedAbortedFileContent = refReadResult?.content ?? '';
          return drv.buildStructuredResponse({
            summary: 'Inspected aborted fast-path snapshot ref and consolidated API change cleanly',
            discoveredInvariants: [],
            residualRisks: [],
          });
        }

        fastWorkerTurn += 1;
        if (fastWorkerTurn === 1) {
          return drv.buildToolCallResponse([
            { id: 'fw-write-1', name: 'write_file', argsJson: JSON.stringify({ path: 'packages/api/src/step-1.ts', content: 'export const STEP_1 = 1;\n' }) },
            { id: 'fw-write-2', name: 'write_file', argsJson: JSON.stringify({ path: 'packages/api/src/step-2.ts', content: 'export const STEP_2 = 2;\n' }) },
            { id: 'fw-write-3', name: 'write_file', argsJson: JSON.stringify({ path: 'packages/api/src/step-3.ts', content: 'export const STEP_3 = 3;\n' }) },
            { id: 'fw-write-4', name: 'write_file', argsJson: JSON.stringify({ path: 'packages/api/src/step-4.ts', content: 'export const STEP_4 = 4;\n' }) },
            { id: 'fw-write-5', name: 'write_file', argsJson: JSON.stringify({ path: 'packages/api/src/step-5.ts', content: 'export const STEP_5 = 5;\n' }) },
          ]);
        }

        return drv.buildStructuredResponse({
          summary: 'Unreachable fast-worker completion',
          discoveredInvariants: [],
          residualRisks: [],
        });
      });

      const scopeDriver = new GitCowWorktreeScopeDriver({ ...workspace.toAST(), repo: fixture.repoDir });
      const runId = 'run-fast-tripwire-102';
      const scopeHandle = await scopeDriver.acquireRoot(runId);
      const flowCtx = buildEngineeringTestFlowContext(
        fixture,
        runId,
        {
          ref: '#102',
          title: 'Refactor API helpers',
          description: 'Consolidate API helper modules',
          routingTier: 'auto',
          targetPartitions: ['api'],
          dependsOn: [],
        },
        modelDriver,
        humanAdapter,
        scopeHandle,
        scopeDriver,
      );

      try {
        const result = await executeFlow(flowCtx);
        expect(result.exitState).toBe('done');
        expect(flowCtx.currentInput.routingTier).toBe('deep');
        expect(flowCtx.currentInput.description).toContain('refs/harness/aborted/');
        expect(inspectedAbortedFileContent).toContain('export const STEP_1 = 1;');
        const consolidatedContent = await readFile(
          path.join(scopeHandle.worktreePath, 'packages/api/src/index.ts'),
          'utf8',
        );
        expect(consolidatedContent).toContain('export const CONSOLIDATED = true;');
      } finally {
        await scopeDriver.release(scopeHandle);
      }
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});
