import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  executeFlow,
  type ModelTurnRequest,
  type ModelTurnResponse,
} from '@harness-dsl/core';
import { git, GitCowWorktreeScopeDriver } from '@harness-dsl/git';
import { describe, expect, it } from 'vitest';
import { workspace } from '../src/index.js';
import { createEngineeringTestFlowContext } from './fixtures/create-engineering-test-flow-context.js';
import { createIntegrationWorkspaceFixture } from './fixtures/create-integration-workspace-fixture.js';
import { ScriptedIntegrationHumanAdapter } from './fixtures/scripted-integration-human-adapter.js';
import { ScriptedIntegrationModelDriver } from './fixtures/scripted-integration-model-driver.js';

interface LeaseAdjudicationScenarioState {
  workerTurn: number;
  adjudicatorTurn: number;
  evaluatorTurn: number;
  browserPtyOutput: string;
}

interface ScopeTripwireScenarioState {
  fastWorkerTurn: number;
  coordinatorTurn: number;
  inspectedAbortedFileContent: string;
}

function createVipApprovalHumanAdapter(): ScriptedIntegrationHumanAdapter {
  return new ScriptedIntegrationHumanAdapter((req) => {
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
}

function handleLeaseAdjudicatorTurn(
  drv: ScriptedIntegrationModelDriver,
  state: LeaseAdjudicationScenarioState,
): ModelTurnResponse {
  state.adjudicatorTurn += 1;
  if (state.adjudicatorTurn === 1) {
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

function handleLeaseEvaluatorTurn(
  req: ModelTurnRequest,
  drv: ScriptedIntegrationModelDriver,
  state: LeaseAdjudicationScenarioState,
): ModelTurnResponse {
  state.evaluatorTurn += 1;
  if (state.evaluatorTurn === 1) {
    return drv.buildToolCallResponse([
      {
        id: 'eval-activate-ui',
        name: 'activateSkill',
        argsJson: JSON.stringify({ skillId: 'ui-verification' }),
      },
    ]);
  }
  if (state.evaluatorTurn === 2) {
    return drv.buildToolCallResponse([
      {
        id: 'eval-cdp-title',
        name: 'browser-ctl',
        argsJson: JSON.stringify({ input: 'DOM.getTitle' }),
      },
    ]);
  }
  const lastEvalFrame = req.history[req.history.length - 1];
  state.browserPtyOutput =
    lastEvalFrame?.canonical.toolResults?.find((tr) => tr.callId === 'eval-cdp-title')?.content ??
    '';
  return drv.buildStructuredResponse({ accepted: true, deficits: [] });
}

function handleLeaseWorkerTurn(
  req: ModelTurnRequest,
  drv: ScriptedIntegrationModelDriver,
  state: LeaseAdjudicationScenarioState,
): ModelTurnResponse {
  state.workerTurn += 1;
  if (state.workerTurn === 1) {
    return drv.buildToolCallResponse([
      {
        id: 'w-read-impl',
        name: 'read_file',
        argsJson: JSON.stringify({ path: 'packages/api/src/user-endpoint.ts' }),
      },
      {
        id: 'w-read-test',
        name: 'read_file',
        argsJson: JSON.stringify({ path: 'packages/api/test/index.test.ts' }),
      },
      {
        id: 'w-read-spec',
        name: 'read_file',
        argsJson: JSON.stringify({ path: 'PRODUCT_SPEC.md' }),
      },
    ]);
  }

  if (state.workerTurn === 2) {
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
}

function createLeaseAdjudicationModelDriver(
  state: LeaseAdjudicationScenarioState,
): ScriptedIntegrationModelDriver {
  return new ScriptedIntegrationModelDriver((req, _turnIdx, drv) => {
    if (req.roleKey === 'lease-adjudicator') {
      return handleLeaseAdjudicatorTurn(drv, state);
    }
    if (req.roleKey === 'evaluator') {
      return handleLeaseEvaluatorTurn(req, drv, state);
    }
    return handleLeaseWorkerTurn(req, drv, state);
  });
}

function handleTripwireCoordinatorTurn(
  req: ModelTurnRequest,
  drv: ScriptedIntegrationModelDriver,
  state: ScopeTripwireScenarioState,
): ModelTurnResponse {
  state.coordinatorTurn += 1;
  const turn0Text = req.history[0]?.canonical.visibleText ?? '';
  expect(turn0Text).toContain(
    'Created 5 helper modules across packages/api/src before tripwire',
  );
  expect(turn0Text).toContain('refs/harness/aborted/');

  if (state.coordinatorTurn === 1) {
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
          content:
            "export { getUserEndpoint } from './user-endpoint.ts';\nexport const CONSOLIDATED = true;\n",
        }),
      },
    ]);
  }

  const lastCoordFrame = req.history[req.history.length - 1];
  const refReadResult = lastCoordFrame?.canonical.toolResults?.find(
    (tr) => tr.callId === 'coord-read-aborted-ref',
  );
  state.inspectedAbortedFileContent = refReadResult?.content ?? '';
  return drv.buildStructuredResponse({
    summary: 'Inspected aborted fast-path snapshot ref and consolidated API change cleanly',
    discoveredInvariants: [],
    residualRisks: [],
  });
}

function handleTripwireFastWorkerTurn(
  drv: ScriptedIntegrationModelDriver,
  state: ScopeTripwireScenarioState,
): ModelTurnResponse {
  state.fastWorkerTurn += 1;
  if (state.fastWorkerTurn === 1) {
    return drv.buildToolCallResponse([
      {
        id: 'fw-write-1',
        name: 'write_file',
        argsJson: JSON.stringify({
          path: 'packages/api/src/step-1.ts',
          content: 'export const STEP_1 = 1;\n',
        }),
      },
      {
        id: 'fw-write-2',
        name: 'write_file',
        argsJson: JSON.stringify({
          path: 'packages/api/src/step-2.ts',
          content: 'export const STEP_2 = 2;\n',
        }),
      },
      {
        id: 'fw-write-3',
        name: 'write_file',
        argsJson: JSON.stringify({
          path: 'packages/api/src/step-3.ts',
          content: 'export const STEP_3 = 3;\n',
        }),
      },
      {
        id: 'fw-write-4',
        name: 'write_file',
        argsJson: JSON.stringify({
          path: 'packages/api/src/step-4.ts',
          content: 'export const STEP_4 = 4;\n',
        }),
      },
      {
        id: 'fw-write-5',
        name: 'write_file',
        argsJson: JSON.stringify({
          path: 'packages/api/src/step-5.ts',
          content: 'export const STEP_5 = 5;\n',
        }),
      },
    ]);
  }

  return drv.buildStructuredResponse({
    summary: 'Unreachable fast-worker completion',
    discoveredInvariants: [],
    residualRisks: [],
  });
}

function createScopeTripwireModelDriver(
  state: ScopeTripwireScenarioState,
): ScriptedIntegrationModelDriver {
  return new ScriptedIntegrationModelDriver((req, _turnIdx, drv) => {
    if (req.toolChoice === 'none') {
      return drv.buildStructuredResponse({
        reason: 'Exceeded 4 mutated files in fast-path worker',
        implicatedPartitions: ['api'],
        findings: 'Created 5 helper modules across packages/api/src before tripwire',
      });
    }
    if ((req.roleKey ?? '').startsWith('coordinator')) {
      return handleTripwireCoordinatorTurn(req, drv, state);
    }
    return handleTripwireFastWorkerTurn(drv, state);
  });
}

describe('Fast-path Protocol 1 (Existing Test Lease Adjudication) and scopeTripwire promotion E2E', () => {
  it('intercepts existing .test.ts mutation via fs.writeGuard, escalates normativeEscalation to owner, elevates lease across loop, runs real node-pty browser-ctl daemon, and lands PR', async () => {
    const fixture = await createIntegrationWorkspaceFixture();
    try {
      const humanAdapter = createVipApprovalHumanAdapter();
      const state: LeaseAdjudicationScenarioState = {
        workerTurn: 0,
        adjudicatorTurn: 0,
        evaluatorTurn: 0,
        browserPtyOutput: '',
      };
      const modelDriver = createLeaseAdjudicationModelDriver(state);

      const scopeDriver = new GitCowWorktreeScopeDriver({
        ...workspace.toAST(),
        repo: fixture.repoDir,
      });
      const runId = 'run-fast-lease-101';
      const scopeHandle = await scopeDriver.acquireRoot(runId);
      const flowCtx = createEngineeringTestFlowContext({
        fixture,
        runId,
        currentInput: {
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
      });

      try {
        const result = await executeFlow(flowCtx);
        expect(result.exitState).toBe('done');
        expect(humanAdapter.decisionRequests).toHaveLength(1);
        expect(state.browserPtyOutput).toContain('"title":"Acme Portal"');
        expect(state.browserPtyOutput).toContain('"command":"DOM.getTitle"');
        const compiledPrefix = flowCtx.wirePrefixesByGroupId.get('engineering-prefix');
        expect(compiledPrefix?.toolsMode).toBe('role-scoped');
        expect(
          compiledPrefix?.wireToolSchemasByRoleKey['evaluator']?.some(
            (t) => t.name === 'browser-ctl',
          ),
        ).toBe(true);
        const receipt = git.ScopeReceiptSchema.parse(result.scopeReceipt);
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
      const state: ScopeTripwireScenarioState = {
        fastWorkerTurn: 0,
        coordinatorTurn: 0,
        inspectedAbortedFileContent: '',
      };
      const modelDriver = createScopeTripwireModelDriver(state);

      const scopeDriver = new GitCowWorktreeScopeDriver({
        ...workspace.toAST(),
        repo: fixture.repoDir,
      });
      const runId = 'run-fast-tripwire-102';
      const scopeHandle = await scopeDriver.acquireRoot(runId);
      const flowCtx = createEngineeringTestFlowContext({
        fixture,
        runId,
        currentInput: {
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
      });

      try {
        const result = await executeFlow(flowCtx);
        expect(result.exitState).toBe('done');
        expect(flowCtx.currentInput.routingTier).toBe('deep');
        expect(flowCtx.currentInput.description).toContain('refs/harness/aborted/');
        expect(state.inspectedAbortedFileContent).toContain('export const STEP_1 = 1;');
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
