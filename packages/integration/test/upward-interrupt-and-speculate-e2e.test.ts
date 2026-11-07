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
import { engineeringFlow, engineeringPrefix, repoLessons, workspace, type WorkItem } from '../src/index.js';
import { createIntegrationWorkspaceFixture } from './fixtures/create-integration-workspace-fixture.js';
import { ScriptedIntegrationHumanAdapter } from './fixtures/scripted-integration-human-adapter.js';
import { ScriptedIntegrationModelDriver } from './fixtures/scripted-integration-model-driver.js';

function buildDeepCoordinatorFlowContext(
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

describe('Protocol 2 (Upward Architectural Interrupt) and Protocol 3 (Speculative Tournament) E2E', () => {
  it('handles parallel delegate-partition forks, pauses sibling on contractViolation, updates TECH_DESIGN.md and topology contract, and resumes via resumeFork', async () => {
    const fixture = await createIntegrationWorkspaceFixture();
    try {
      const humanAdapter = new ScriptedIntegrationHumanAdapter(() => ({
        selectedOptionId: 'ok',
        approveSpecMutation: false,
        unlockedSpecFiles: [],
      }));

      let coordinatorTurn = 0;
      let dbWorkerTurn = 0;
      let apiWorkerTurn = 0;

      const modelDriver = new ScriptedIntegrationModelDriver((req, _turnIdx, drv) => {
        if (req.roleKey === 'evaluator') return drv.buildStructuredResponse({ accepted: true, deficits: [] });

        if ((req.roleKey ?? '').startsWith('coordinator')) {
          coordinatorTurn += 1;
          if (coordinatorTurn === 1) {
            return drv.buildToolCallResponse([
              {
                id: 'fork-db-call',
                name: 'delegate-partition',
                argsJson: JSON.stringify({ forkId: 'fork-db', partition: 'db', objective: 'Add role field helper in packages/db', estimatedTurns: 4, contextNotes: 'DB partition fork' }),
              },
              {
                id: 'fork-api-call',
                name: 'delegate-partition',
                argsJson: JSON.stringify({ forkId: 'fork-api', partition: 'api', objective: 'Expose user role in packages/api', estimatedTurns: 4, contextNotes: 'API partition fork' }),
              },
            ]);
          }

          if (coordinatorTurn === 2) {
            const lastToolFrame = req.history[req.history.length - 1];
            const apiForkResult = lastToolFrame?.canonical.toolResults?.find((tr) => tr.callId === 'fork-api-call');
            expect(apiForkResult?.content).toContain('SUSPENDED_ON_INTERRUPT');
            const parsedApiFork = JSON.parse(apiForkResult?.content ?? '{}') as {
              readonly suspendedForkId?: string;
              readonly pausedSiblingForkIds?: readonly string[];
            };
            const suspendedIds = [
              ...(parsedApiFork.suspendedForkId !== undefined ? [parsedApiFork.suspendedForkId] : []),
              ...(parsedApiFork.pausedSiblingForkIds ?? []),
            ];

            return drv.buildToolCallResponse([
              {
                id: 'coord-edit-tech-design',
                name: 'edit_file',
                argsJson: JSON.stringify({
                  path: 'TECH_DESIGN.md',
                  oldString: '`db` exports `UserRecord` and `queryUser`.',
                  newString: '`db` exports `UserRecord`, `queryUser`, and `queryUserRole`.',
                }),
              },
              {
                id: 'coord-edit-db-index',
                name: 'edit_file',
                argsJson: JSON.stringify({
                  path: 'packages/db/src/index.ts',
                  oldString: 'export function queryUser(id: string): UserRecord {\n  return { id, email: `${id}@acme.test` };\n}',
                  newString: 'export function queryUser(id: string): UserRecord {\n  return { id, email: `${id}@acme.test` };\n}\nexport function queryUserRole(id: string): string {\n  return `${id}:member`;\n}',
                }),
              },
              {
                id: 'coord-update-contract',
                name: 'updatePartitionContract',
                argsJson: JSON.stringify({ partitionId: 'db', newContractText: 'db exports UserRecord, queryUser, and queryUserRole' }),
              },
              {
                id: 'coord-resume-forks',
                name: 'resumeFork',
                argsJson: JSON.stringify({
                  suspendedForkIds: suspendedIds,
                  action: 'resume',
                  resolutionSummary: 'Added queryUserRole to packages/db/src/index.ts and updated TECH_DESIGN.md',
                }),
              },
            ]);
          }

          return drv.buildStructuredResponse({
            summary: 'Resolved upward contractViolation and merged both db and api partition forks',
            discoveredInvariants: ['queryUserRole exported from @acme/db'],
            residualRisks: [],
          });
        }

        const turn0Text = req.history[0]?.canonical.visibleText ?? '';
        if (turn0Text.includes('packages/db')) {
          dbWorkerTurn += 1;
          if (dbWorkerTurn === 1) {
            return drv.buildToolCallResponse([
              { id: 'db-write-helper', name: 'write_file', argsJson: JSON.stringify({ path: 'packages/db/src/role-helper.ts', content: 'export const DEFAULT_ROLE = "member";\n' }) },
            ]);
          }
          return drv.buildStructuredResponse({ summary: 'Added role-helper.ts in db partition', discoveredInvariants: [], residualRisks: [] });
        }

        apiWorkerTurn += 1;
        if (apiWorkerTurn === 1) {
          return drv.buildToolCallResponse([
            {
              id: 'api-raise-contract-violation',
              name: 'contract-violation',
              argsJson: JSON.stringify({
                partition: 'db',
                brokenInvariant: 'packages/db/src/index.ts does not export queryUserRole',
                proof: 'packages/api/src/index.ts requires queryUserRole(id)',
                proposedPatch: 'Export queryUserRole(id: string) from packages/db/src/index.ts',
              }),
            },
          ]);
        }

        if (apiWorkerTurn === 2) {
          return drv.buildToolCallResponse([
            {
              id: 'api-write-role-endpoint',
              name: 'write_file',
              argsJson: JSON.stringify({
                path: 'packages/api/src/role-endpoint.ts',
                content: 'import { queryUserRole } from "../../db/src/index.ts";\nexport function getRoleEndpoint(id: string): string {\n  return queryUserRole(id);\n}\n',
              }),
            },
          ]);
        }

        return drv.buildStructuredResponse({ summary: 'Added getRoleEndpoint in packages/api/src/role-endpoint.ts', discoveredInvariants: [], residualRisks: [] });
      });

      const scopeDriver = new GitCowWorktreeScopeDriver({ ...workspace.toAST(), repo: fixture.repoDir });
      const runId = 'run-upward-interrupt-201';
      const scopeHandle = await scopeDriver.acquireRoot(runId);
      const flowCtx = buildDeepCoordinatorFlowContext(
        fixture,
        runId,
        { ref: '#201', title: 'Add role endpoint across db and api', description: 'Expose queryUserRole in db and getRoleEndpoint in api', routingTier: 'deep', targetPartitions: ['db', 'api'], dependsOn: [] },
        modelDriver,
        humanAdapter,
        scopeHandle,
        scopeDriver,
      );

      try {
        const result = await executeFlow(flowCtx);
        expect(result.exitState).toBe('done');
        const receipt = result.scopeReceipt as GitScopeReceipt;
        expect(receipt.mutatedFiles).toEqual(
          expect.arrayContaining(['TECH_DESIGN.md', 'packages/db/src/index.ts', 'packages/db/src/role-helper.ts', 'packages/api/src/role-endpoint.ts']),
        );
        const overlayPartitions = await flowCtx.topologyStore?.getPartitions(runId);
        expect(overlayPartitions?.get('db')?.contractText).toContain('queryUserRole');
      } finally {
        await scopeDriver.release(scopeHandle);
      }
    } finally {
      await fixture.cleanup();
    }
  });

  it('parks speculative Branch 0 on normativeEscalation while Branch 1 completes, runs candidateArbiter unpark-escalation then select-winner with refineWinnerWhen', async () => {
    const fixture = await createIntegrationWorkspaceFixture();
    try {
      let humanPagedDuringInitialRace = false;
      let raceFinished = false;
      const humanAdapter = new ScriptedIntegrationHumanAdapter(() => {
        if (!raceFinished) humanPagedDuringInitialRace = true;
        return {
          selectedOptionId: 'opt-spec-b0',
          approveSpecMutation: true,
          unlockedSpecFiles: ['PRODUCT_SPEC.md'],
          note: 'Approve Branch 0 normative spec and test update',
        };
      });

      let coordinatorTurn = 0;
      let arbiterTurn = 0;
      let adjudicatorTurn = 0;
      let branch0Turn = 0;
      let branch1Turn = 0;
      let refineTurn = 0;
      let crossPollinatedFromBranch1 = '';

      const modelDriver = new ScriptedIntegrationModelDriver((req, _turnIdx, drv) => {
        if (req.roleKey === 'evaluator') return drv.buildStructuredResponse({ accepted: true, deficits: [] });

        if (req.roleKey === 'lease-adjudicator') {
          adjudicatorTurn += 1;
          if (adjudicatorTurn === 1) {
            return drv.buildToolCallResponse([
              {
                id: 'b0-adj-escalate',
                name: 'normative-tradeoff',
                argsJson: JSON.stringify({
                  question: 'Allow Branch 0 to update PRODUCT_SPEC.md and existing api test?',
                  options: [{ id: 'opt-spec-b0', summary: 'Approve spec + existing test update in Branch 0', tradeoffs: 'Updates contract in PRODUCT_SPEC.md' }],
                  recommendation: 'opt-spec-b0',
                }),
              },
            ]);
          }
          return drv.buildStructuredResponse({ approved: true, unlockedGlobs: ['packages/api/test/index.test.ts'], ruling: 'Approved existing test edit for unparked Branch 0' });
        }

        if (req.roleKey === 'candidate-arbiter') {
          raceFinished = true;
          arbiterTurn += 1;
          if (arbiterTurn === 1) {
            return drv.buildStructuredResponse({ decision: 'unpark-escalation', parkedBranchIndex: 0, rationale: 'Branch 0 addresses root cause; unpark its normative escalation' });
          }
          return drv.buildStructuredResponse({
            decision: 'select-winner',
            winnerBranchIndex: 0,
            rationale: 'Branch 0 passed after owner ruling; cherry-pick Branch 1 diagnostic helper via refinement',
            followUpDeficits: ['Copy packages/api/src/branch1-diag.ts from candidate 1'],
          });
        }

        if ((req.roleKey ?? '').startsWith('coordinator')) {
          coordinatorTurn += 1;
          if (coordinatorTurn === 1) {
            return drv.buildToolCallResponse([
              {
                id: 'coord-speculate-1',
                name: 'explore-candidates',
                argsJson: JSON.stringify({
                  partition: 'api',
                  problemStatement: 'Resolve getUserEndpoint query suffix behavior',
                  strategyA: 'Approach 0: Update PRODUCT_SPEC.md and existing test',
                  strategyB: 'Approach 1: Add non-breaking branch1-diag.ts helper only',
                }),
              },
            ]);
          }
          return drv.buildStructuredResponse({ summary: 'Completed speculative tournament with non-destructive unparking and winner refinement', discoveredInvariants: [], residualRisks: [] });
        }

        const turn0Text = req.history[0]?.canonical.visibleText ?? '';
        if (turn0Text.includes('Copy packages/api/src/branch1-diag.ts from candidate 1')) {
          refineTurn += 1;
          if (refineTurn === 1) {
            return drv.buildToolCallResponse([
              { id: 'ref-read-b1', name: 'readCandidateFile', argsJson: JSON.stringify({ branchIndex: 1, path: 'packages/api/src/branch1-diag.ts' }) },
              { id: 'ref-write-b0', name: 'write_file', argsJson: JSON.stringify({ path: 'packages/api/src/branch1-diag.ts', content: 'export const BRANCH_1_DIAG = "cross-pollinated";\n' }) },
            ]);
          }
          const lastFrame = req.history[req.history.length - 1];
          crossPollinatedFromBranch1 = lastFrame?.canonical.toolResults?.find((tr) => tr.callId === 'ref-read-b1')?.content ?? '';
          return drv.buildStructuredResponse({ summary: 'Refined winning Branch 0 with Branch 1 diagnostic module', discoveredInvariants: [], residualRisks: [] });
        }

        if (turn0Text.includes('Approach 0')) {
          branch0Turn += 1;
          if (branch0Turn === 1) {
            return drv.buildToolCallResponse([
              { id: 'b0-edit-impl', name: 'edit_file', argsJson: JSON.stringify({ path: 'packages/api/src/user-endpoint.ts', oldString: 'return queryUser(id).email;', newString: 'return `${queryUser(id).email}?b0=1`;' }) },
              { id: 'b0-edit-test', name: 'edit_file', argsJson: JSON.stringify({ path: 'packages/api/test/index.test.ts', oldString: "'u1@acme.test'", newString: "'u1@acme.test?b0=1'" }) },
              { id: 'b0-edit-spec', name: 'edit_file', argsJson: JSON.stringify({ path: 'PRODUCT_SPEC.md', oldString: 'Users have `id` and `email`.', newString: 'Users have `id` and `email` (`?b0=1`).' }) },
            ]);
          }
          return drv.buildStructuredResponse({ summary: 'Branch 0 updated spec, implementation, and test after unparking', discoveredInvariants: [], residualRisks: [] });
        }

        branch1Turn += 1;
        if (branch1Turn === 1) {
          return drv.buildToolCallResponse([
            { id: 'b1-write-diag', name: 'write_file', argsJson: JSON.stringify({ path: 'packages/api/src/branch1-diag.ts', content: 'export const BRANCH_1_DIAG = "from-branch-1";\n' }) },
          ]);
        }
        return drv.buildStructuredResponse({ summary: 'Branch 1 completed conservative helper module without escalating', discoveredInvariants: [], residualRisks: [] });
      });

      const scopeDriver = new GitCowWorktreeScopeDriver({ ...workspace.toAST(), repo: fixture.repoDir });
      const runId = 'run-speculate-202';
      const scopeHandle = await scopeDriver.acquireRoot(runId);
      const flowCtx = buildDeepCoordinatorFlowContext(
        fixture,
        runId,
        { ref: '#202', title: 'Explore candidate API approaches', description: 'Run speculative tournament across 2 candidate approaches', routingTier: 'deep', targetPartitions: ['api'], dependsOn: [] },
        modelDriver,
        humanAdapter,
        scopeHandle,
        scopeDriver,
      );

      try {
        const result = await executeFlow(flowCtx);
        expect(result.exitState).toBe('done');
        expect(humanPagedDuringInitialRace).toBe(false);
        expect(arbiterTurn).toBe(2);
        expect(humanAdapter.decisionRequests).toHaveLength(1);
        expect(crossPollinatedFromBranch1).toContain('from-branch-1');
        const diagContent = await readFile(path.join(scopeHandle.worktreePath, 'packages/api/src/branch1-diag.ts'), 'utf8');
        expect(diagContent).toContain('cross-pollinated');
      } finally {
        await scopeDriver.release(scopeHandle);
      }
    } finally {
      await fixture.cleanup();
    }
  });
});
