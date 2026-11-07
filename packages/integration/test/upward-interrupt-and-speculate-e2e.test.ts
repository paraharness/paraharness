import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  executeFlow,
  z,
  type FlowExecutionContext,
  type GitWorktreeHandle,
  type ModelTurnRequest,
  type ModelTurnResponse,
  type StepExecutionContext,
} from '@harness-dsl/core';
import { git, GitCowWorktreeScopeDriver } from '@harness-dsl/git';
import { describe, expect, it } from 'vitest';
import { workspace, type WorkItem } from '../src/index.js';
import { createEngineeringTestFlowContext } from './fixtures/create-engineering-test-flow-context.js';
import { createIntegrationWorkspaceFixture } from './fixtures/create-integration-workspace-fixture.js';
import { ScriptedIntegrationHumanAdapter } from './fixtures/scripted-integration-human-adapter.js';
import { ScriptedIntegrationModelDriver } from './fixtures/scripted-integration-model-driver.js';

const suspendedForkToolResultSchema = z.object({
  suspendedForkId: z.string().optional(),
  pausedSiblingForkIds: z.array(z.string()).optional(),
});

interface UpwardInterruptScenarioState {
  coordinatorTurn: number;
  dbWorkerTurn: number;
  apiWorkerTurn: number;
}

interface SpeculateScenarioState {
  humanPagedDuringInitialRace: boolean;
  raceFinished: boolean;
  coordinatorTurn: number;
  arbiterTurn: number;
  adjudicatorTurn: number;
  branch0Turn: number;
  branch1Turn: number;
  refineTurn: number;
  crossPollinatedFromBranch1: string;
  arbiterSecondTurnPrompt: string;
}

function extractSuspendedForkIds(req: ModelTurnRequest): readonly string[] {
  const lastToolFrame = req.history[req.history.length - 1];
  const apiForkResult = lastToolFrame?.canonical.toolResults?.find(
    (tr) => tr.callId === 'fork-api-call',
  );
  expect(apiForkResult?.content).toContain('SUSPENDED_ON_INTERRUPT');
  const parsedApiFork = suspendedForkToolResultSchema.parse(
    JSON.parse(apiForkResult?.content ?? '{}'),
  );
  const suspendedIds: string[] = [];
  if (parsedApiFork.suspendedForkId !== undefined) {
    suspendedIds.push(parsedApiFork.suspendedForkId);
  }
  for (const siblingId of parsedApiFork.pausedSiblingForkIds ?? []) {
    suspendedIds.push(siblingId);
  }
  return suspendedIds;
}

function handleUpwardInterruptCoordinatorTurn(
  req: ModelTurnRequest,
  drv: ScriptedIntegrationModelDriver,
  state: UpwardInterruptScenarioState,
): ModelTurnResponse {
  state.coordinatorTurn += 1;
  if (state.coordinatorTurn === 1) {
    return drv.buildToolCallResponse([
      {
        id: 'fork-db-call',
        name: 'delegate-partition',
        argsJson: JSON.stringify({
          forkId: 'fork-db',
          partition: 'db',
          objective: 'Add role field helper in packages/db',
          estimatedTurns: 4,
          contextNotes: 'DB partition fork',
        }),
      },
      {
        id: 'fork-api-call',
        name: 'delegate-partition',
        argsJson: JSON.stringify({
          forkId: 'fork-api',
          partition: 'api',
          objective: 'Expose user role in packages/api',
          estimatedTurns: 4,
          contextNotes: 'API partition fork',
        }),
      },
    ]);
  }

  if (state.coordinatorTurn === 2) {
    const suspendedIds = extractSuspendedForkIds(req);
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
          oldString:
            'export function queryUser(id: string): UserRecord {\n  return { id, email: `${id}@acme.test` };\n}',
          newString:
            'export function queryUser(id: string): UserRecord {\n  return { id, email: `${id}@acme.test` };\n}\nexport function queryUserRole(id: string): string {\n  return `${id}:member`;\n}',
        }),
      },
      {
        id: 'coord-update-contract',
        name: 'updatePartitionContract',
        argsJson: JSON.stringify({
          partitionId: 'db',
          newContractText: 'db exports UserRecord, queryUser, and queryUserRole',
        }),
      },
      {
        id: 'coord-resume-forks',
        name: 'resumeFork',
        argsJson: JSON.stringify({
          suspendedForkIds: suspendedIds,
          action: 'resume',
          resolutionSummary:
            'Added queryUserRole to packages/db/src/index.ts and updated TECH_DESIGN.md',
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

function handleUpwardInterruptDbWorkerTurn(
  drv: ScriptedIntegrationModelDriver,
  state: UpwardInterruptScenarioState,
): ModelTurnResponse {
  state.dbWorkerTurn += 1;
  if (state.dbWorkerTurn === 1) {
    return drv.buildToolCallResponse([
      {
        id: 'db-write-helper',
        name: 'write_file',
        argsJson: JSON.stringify({
          path: 'packages/db/src/role-helper.ts',
          content: 'export const DEFAULT_ROLE = "member";\n',
        }),
      },
    ]);
  }
  return drv.buildStructuredResponse({
    summary: 'Added role-helper.ts in db partition',
    discoveredInvariants: [],
    residualRisks: [],
  });
}

function handleUpwardInterruptApiWorkerTurn(
  drv: ScriptedIntegrationModelDriver,
  state: UpwardInterruptScenarioState,
): ModelTurnResponse {
  state.apiWorkerTurn += 1;
  if (state.apiWorkerTurn === 1) {
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

  if (state.apiWorkerTurn === 2) {
    return drv.buildToolCallResponse([
      {
        id: 'api-write-role-endpoint',
        name: 'write_file',
        argsJson: JSON.stringify({
          path: 'packages/api/src/role-endpoint.ts',
          content:
            'import { queryUserRole } from "../../db/src/index.ts";\nexport function getRoleEndpoint(id: string): string {\n  return queryUserRole(id);\n}\n',
        }),
      },
    ]);
  }

  return drv.buildStructuredResponse({
    summary: 'Added getRoleEndpoint in packages/api/src/role-endpoint.ts',
    discoveredInvariants: [],
    residualRisks: [],
  });
}

function createUpwardInterruptModelDriver(
  state: UpwardInterruptScenarioState,
): ScriptedIntegrationModelDriver {
  return new ScriptedIntegrationModelDriver((req, _turnIdx, drv) => {
    if (req.roleKey === 'evaluator') {
      return drv.buildStructuredResponse({ accepted: true, deficits: [] });
    }
    if ((req.roleKey ?? '').startsWith('coordinator')) {
      return handleUpwardInterruptCoordinatorTurn(req, drv, state);
    }
    const turn0Text = req.history[0]?.canonical.visibleText ?? '';
    if (turn0Text.includes('packages/db')) {
      return handleUpwardInterruptDbWorkerTurn(drv, state);
    }
    return handleUpwardInterruptApiWorkerTurn(drv, state);
  });
}

function createSpeculateScenarioState(): SpeculateScenarioState {
  return {
    humanPagedDuringInitialRace: false,
    raceFinished: false,
    coordinatorTurn: 0,
    arbiterTurn: 0,
    adjudicatorTurn: 0,
    branch0Turn: 0,
    branch1Turn: 0,
    refineTurn: 0,
    crossPollinatedFromBranch1: '',
    arbiterSecondTurnPrompt: '',
  };
}

function createSpeculateHumanAdapter(
  state: SpeculateScenarioState,
): ScriptedIntegrationHumanAdapter {
  return new ScriptedIntegrationHumanAdapter(() => {
    if (!state.raceFinished) {
      state.humanPagedDuringInitialRace = true;
    }
    return {
      selectedOptionId: 'opt-spec-b0',
      approveSpecMutation: true,
      unlockedSpecFiles: ['PRODUCT_SPEC.md'],
      note: 'Approve Branch 0 normative spec and test update',
    };
  });
}

function handleSpeculateAdjudicatorTurn(
  drv: ScriptedIntegrationModelDriver,
  state: SpeculateScenarioState,
): ModelTurnResponse {
  state.adjudicatorTurn += 1;
  if (state.adjudicatorTurn === 1) {
    return drv.buildToolCallResponse([
      {
        id: 'b0-adj-escalate',
        name: 'normative-tradeoff',
        argsJson: JSON.stringify({
          question: 'Allow Branch 0 to update PRODUCT_SPEC.md and existing api test?',
          options: [
            {
              id: 'opt-spec-b0',
              summary: 'Approve spec + existing test update in Branch 0',
              tradeoffs: 'Updates contract in PRODUCT_SPEC.md',
            },
          ],
          recommendation: 'opt-spec-b0',
        }),
      },
    ]);
  }
  return drv.buildStructuredResponse({
    approved: true,
    unlockedGlobs: ['packages/api/test/index.test.ts'],
    ruling: 'Approved existing test edit for unparked Branch 0',
  });
}

function handleSpeculateArbiterTurn(
  req: ModelTurnRequest,
  drv: ScriptedIntegrationModelDriver,
  state: SpeculateScenarioState,
): ModelTurnResponse {
  state.raceFinished = true;
  state.arbiterTurn += 1;
  if (state.arbiterTurn === 1) {
    return drv.buildStructuredResponse({
      decision: 'unpark-escalation',
      parkedBranchIndex: 0,
      rationale: 'Branch 0 addresses root cause; unpark its normative escalation',
    });
  }
  state.arbiterSecondTurnPrompt = req.history[0]?.canonical.visibleText ?? '';
  return drv.buildStructuredResponse({
    decision: 'select-winner',
    winnerBranchIndex: 0,
    rationale:
      'Branch 0 passed after owner ruling; cherry-pick Branch 1 diagnostic helper via refinement',
    followUpDeficits: ['Copy packages/api/src/branch1-diag.ts from candidate 1'],
  });
}

function handleSpeculateCoordinatorTurn(
  drv: ScriptedIntegrationModelDriver,
  state: SpeculateScenarioState,
): ModelTurnResponse {
  state.coordinatorTurn += 1;
  if (state.coordinatorTurn === 1) {
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
  return drv.buildStructuredResponse({
    summary:
      'Completed speculative tournament with non-destructive unparking and winner refinement',
    discoveredInvariants: [],
    residualRisks: [],
  });
}

function handleSpeculateRefineTurn(
  req: ModelTurnRequest,
  drv: ScriptedIntegrationModelDriver,
  state: SpeculateScenarioState,
): ModelTurnResponse {
  state.refineTurn += 1;
  if (state.refineTurn === 1) {
    return drv.buildToolCallResponse([
      {
        id: 'ref-read-b1',
        name: 'readCandidateFile',
        argsJson: JSON.stringify({
          branchIndex: 1,
          path: 'packages/api/src/branch1-diag.ts',
        }),
      },
      {
        id: 'ref-write-b0',
        name: 'write_file',
        argsJson: JSON.stringify({
          path: 'packages/api/src/branch1-diag.ts',
          content: 'export const BRANCH_1_DIAG = "cross-pollinated";\n',
        }),
      },
    ]);
  }
  const lastFrame = req.history[req.history.length - 1];
  state.crossPollinatedFromBranch1 =
    lastFrame?.canonical.toolResults?.find((tr) => tr.callId === 'ref-read-b1')?.content ?? '';
  return drv.buildStructuredResponse({
    summary: 'Refined winning Branch 0 with Branch 1 diagnostic module',
    discoveredInvariants: [],
    residualRisks: [],
  });
}

function handleSpeculateBranch0Turn(
  drv: ScriptedIntegrationModelDriver,
  state: SpeculateScenarioState,
): ModelTurnResponse {
  state.branch0Turn += 1;
  if (state.branch0Turn === 1) {
    return drv.buildToolCallResponse([
      {
        id: 'b0-edit-impl',
        name: 'edit_file',
        argsJson: JSON.stringify({
          path: 'packages/api/src/user-endpoint.ts',
          oldString: 'return queryUser(id).email;',
          newString: 'return `${queryUser(id).email}?b0=1`;',
        }),
      },
      {
        id: 'b0-edit-test',
        name: 'edit_file',
        argsJson: JSON.stringify({
          path: 'packages/api/test/index.test.ts',
          oldString: "'u1@acme.test'",
          newString: "'u1@acme.test?b0=1'",
        }),
      },
      {
        id: 'b0-edit-spec',
        name: 'edit_file',
        argsJson: JSON.stringify({
          path: 'PRODUCT_SPEC.md',
          oldString: 'Users have `id` and `email`.',
          newString: 'Users have `id` and `email` (`?b0=1`).',
        }),
      },
    ]);
  }
  return drv.buildStructuredResponse({
    summary: 'Branch 0 updated spec, implementation, and test after unparking',
    discoveredInvariants: [],
    residualRisks: [],
  });
}

function handleSpeculateBranch1Turn(
  drv: ScriptedIntegrationModelDriver,
  state: SpeculateScenarioState,
): ModelTurnResponse {
  state.branch1Turn += 1;
  if (state.branch1Turn === 1) {
    return drv.buildToolCallResponse([
      {
        id: 'b1-write-diag',
        name: 'write_file',
        argsJson: JSON.stringify({
          path: 'packages/api/src/branch1-diag.ts',
          content: 'export const BRANCH_1_DIAG = "from-branch-1";\n',
        }),
      },
      {
        id: 'b1-write-boundary-test',
        name: 'write_file',
        argsJson: JSON.stringify({
          path: 'packages/api/test/boundary-contract.test.ts',
          content:
            'import assert from "node:assert/strict";\nimport { getUserEndpoint } from "../src/index.ts";\nassert.equal(typeof getUserEndpoint("u1"), "string");\n',
        }),
      },
    ]);
  }
  return drv.buildStructuredResponse({
    summary: 'Branch 1 completed conservative helper module without escalating',
    discoveredInvariants: [],
    residualRisks: [],
  });
}

function createSpeculateModelDriver(
  state: SpeculateScenarioState,
): ScriptedIntegrationModelDriver {
  return new ScriptedIntegrationModelDriver((req, _turnIdx, drv) => {
    if (req.roleKey === 'evaluator') {
      return drv.buildStructuredResponse({ accepted: true, deficits: [] });
    }
    if (req.roleKey === 'lease-adjudicator') {
      return handleSpeculateAdjudicatorTurn(drv, state);
    }
    if (req.roleKey === 'candidate-arbiter') {
      return handleSpeculateArbiterTurn(req, drv, state);
    }
    if ((req.roleKey ?? '').startsWith('coordinator')) {
      return handleSpeculateCoordinatorTurn(drv, state);
    }
    const turn0Text = req.history[0]?.canonical.visibleText ?? '';
    if (turn0Text.includes('Copy packages/api/src/branch1-diag.ts from candidate 1')) {
      return handleSpeculateRefineTurn(req, drv, state);
    }
    if (turn0Text.includes('Approach 0')) {
      return handleSpeculateBranch0Turn(drv, state);
    }
    return handleSpeculateBranch1Turn(drv, state);
  });
}

async function assertPatchEquivalenceCrossVerifier(
  flowCtx: FlowExecutionContext<WorkItem, GitWorktreeHandle>,
  runId: string,
  scopeHandle: GitWorktreeHandle,
): Promise<void> {
  const patchNode = git.patchEquivalence().toAST();
  const stepCtx: StepExecutionContext<unknown> = {
    runId,
    stepExecId: `${runId}:patch-eq`,
    scopeHandle,
    activePartitions: ['api'],
    activeLeases: [],
    observedEffects: [],
    registry: flowCtx.registry,
    resolveEnv: (v) => (typeof v === 'string' ? v : flowCtx.env[v.key]),
    getRunner: (rNode) => {
      const factory = flowCtx.registry.runners[rNode.type];
      if (factory === undefined) {
        throw new Error(`Missing runner factory for '${rNode.type}'.`);
      }
      return factory(rNode);
    },
    recordEffects: () => undefined,
  };
  const patchEqReports = await flowCtx.registry.crossVerifiers['git:patch-equivalence']?.(
    patchNode,
    [
      { branchIndex: 0, scopeHandle, scopeReceipt: {} },
      { branchIndex: 1, scopeHandle, scopeReceipt: {} },
    ],
    stepCtx,
  );
  expect(patchNode.reportSchema.parse(patchEqReports?.[0]).equivalentBranchIndices).toEqual([
    0, 1,
  ]);
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
      const state: UpwardInterruptScenarioState = {
        coordinatorTurn: 0,
        dbWorkerTurn: 0,
        apiWorkerTurn: 0,
      };
      const modelDriver = createUpwardInterruptModelDriver(state);

      const scopeDriver = new GitCowWorktreeScopeDriver({
        ...workspace.toAST(),
        repo: fixture.repoDir,
      });
      const runId = 'run-upward-interrupt-201';
      const scopeHandle = await scopeDriver.acquireRoot(runId);
      const flowCtx = createEngineeringTestFlowContext({
        fixture,
        runId,
        currentInput: {
          ref: '#201',
          title: 'Add role endpoint across db and api',
          description: 'Expose queryUserRole in db and getRoleEndpoint in api',
          routingTier: 'deep',
          targetPartitions: ['db', 'api'],
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
        const receipt = git.ScopeReceiptSchema.parse(result.scopeReceipt);
        expect(receipt.mutatedFiles).toEqual(
          expect.arrayContaining([
            'TECH_DESIGN.md',
            'packages/db/src/index.ts',
            'packages/db/src/role-helper.ts',
            'packages/api/src/role-endpoint.ts',
          ]),
        );
        const overlayPartitions = await flowCtx.topologyStore?.getPartitions(runId);
        expect(overlayPartitions?.get('db')?.contractText).toContain('queryUserRole');
      } finally {
        await scopeDriver.release(scopeHandle);
      }
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);

  it('parks speculative Branch 0 on normativeEscalation while Branch 1 completes, runs candidateArbiter unpark-escalation then select-winner with refineWinnerWhen', async () => {
    const fixture = await createIntegrationWorkspaceFixture();
    try {
      const state = createSpeculateScenarioState();
      const humanAdapter = createSpeculateHumanAdapter(state);
      const modelDriver = createSpeculateModelDriver(state);

      const scopeDriver = new GitCowWorktreeScopeDriver({
        ...workspace.toAST(),
        repo: fixture.repoDir,
      });
      const runId = 'run-speculate-202';
      const scopeHandle = await scopeDriver.acquireRoot(runId);
      const flowCtx = createEngineeringTestFlowContext({
        fixture,
        runId,
        currentInput: {
          ref: '#202',
          title: 'Explore candidate API approaches',
          description: 'Run speculative tournament across 2 candidate approaches',
          routingTier: 'deep',
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
        expect(state.humanPagedDuringInitialRace).toBe(false);
        expect(state.arbiterTurn).toBe(2);
        expect(state.arbiterSecondTurnPrompt).toContain(
          'packages/api/test/boundary-contract.test.ts',
        );
        expect(state.arbiterSecondTurnPrompt).toContain('"passedCrossTests":1');
        expect(humanAdapter.decisionRequests).toHaveLength(1);
        expect(state.crossPollinatedFromBranch1).toContain('from-branch-1');
        const diagContent = await readFile(
          path.join(scopeHandle.worktreePath, 'packages/api/src/branch1-diag.ts'),
          'utf8',
        );
        expect(diagContent).toContain('cross-pollinated');
        await assertPatchEquivalenceCrossVerifier(flowCtx, runId, scopeHandle);
      } finally {
        await scopeDriver.release(scopeHandle);
      }
    } finally {
      await fixture.cleanup();
    }
  }, 20_000);
});
