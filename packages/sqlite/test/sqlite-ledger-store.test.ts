import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  AgentContinuationFrame,
  SuspendedForkRecord,
  WireFrameRecord,
} from '@harness-dsl/core';
import { SqliteLedgerStore } from '../src/index.js';
import { createTempSqliteDb } from './fixtures/temp-sqlite-db.js';
import type { TempSqliteDbHandle } from './fixtures/temp-sqlite-db-handle.js';

function createSampleWireFrame(
  messageId: string,
  parentMessageId: string | null,
  rawText: string,
): WireFrameRecord {
  const bytes = new TextEncoder().encode(rawText);
  return {
    messageId,
    parentMessageId,
    vendorId: 'anthropic',
    rawWireFrame: bytes,
    canonical: {
      role: 'assistant',
      visibleText: rawText,
      toolCalls: [{ id: `call-${messageId}`, name: 'fs:read', argsJson: '{"path":"a.ts"}' }],
      toolResults: [],
    },
    prefixDigest: `sha-${messageId}`,
    compactedTombstones: {},
  };
}

describe('SqliteLedgerStore durability, DAG mutation, wire frames, and compaction', () => {
  let tempDb: TempSqliteDbHandle;
  let store: SqliteLedgerStore;

  beforeEach(() => {
    tempDb = createTempSqliteDb();
    store = new SqliteLedgerStore(tempDb.dbPath);
  });

  afterEach(() => {
    store.close();
    tempDb.cleanup();
  });

  it('creates or resumes a run while pinning compiledPrefixesJson and tracking step outputs', async () => {
    const initial = await store.createOrResumeRun({
      runId: 'run-1',
      laneId: 'lane-main',
      itemKey: 'ISS-1',
      inputJson: '{"v":1}',
      compiledPrefixesJson: { default: '{"prefix":"pinned-v1"}' },
      costUsd: 0,
      approvedMaxCostUsd: 10,
    });
    expect(initial).toEqual({
      status: 'RUNNING',
      currentStepId: null,
      inputJson: '{"v":1}',
      rewindPendingToStepId: undefined,
      compiledPrefixesJson: { default: '{"prefix":"pinned-v1"}' },
      costUsd: 0,
      approvedMaxCostUsd: 10,
      completedStepOutputsJson: new Map(),
    });

    await store.recordStepStart({
      stepExecId: 'exec-1',
      runId: 'run-1',
      stepId: 'step-a',
      executableId: 'agent-a',
      inputMsgId: null,
      baseScopeCheckpoint: 'cp-base-1',
      continuationStack: [],
    });

    const frame: AgentContinuationFrame = {
      frameType: 'agent',
      stepExecId: 'exec-1',
      agentId: 'agent-a',
      turnIndex: 2,
      leafMessageId: 'msg-2',
      unlockedSkillIds: ['skill-1'],
      unlockedPartitions: ['part-a'],
      activeFenceTokens: { 'part-a': 4 },
      accumulatedSourceIds: ['src-1'],
      observedEffects: [],
      pauseState: {
        kind: 'active-turn',
        turnIndex: 2,
        leafMessageId: 'msg-2',
      },
    };
    await store.updateContinuationStack('run-1', 'exec-1', [frame], {
      baseScopeCheckpoint: 'cp-base-updated',
    });
    await store.updateRunInput('run-1', {
      inputJson: '{"v":2}',
      rewindPendingToStepId: 'step-rewind',
    });

    const interrupted = await store.getInterruptedStepsOnBoot();
    expect(interrupted).toEqual([
      {
        runId: 'run-1',
        laneId: 'lane-main',
        itemKey: 'ISS-1',
        inputJson: '{"v":2}',
        status: 'RUNNING',
        dependsOn: [],
        stepExecId: 'exec-1',
        stepId: 'step-a',
        executableId: 'agent-a',
        baseScopeCheckpoint: 'cp-base-updated',
        headScopeCheckpoint: undefined,
        continuationStack: [frame],
      },
    ]);

    await store.recordStepTransition({
      stepExecId: 'exec-1',
      status: 'COMPLETED',
      outputJson: '{"stepA":"done"}',
      baseScopeCheckpoint: 'cp-base-updated',
      headScopeCheckpoint: 'cp-head-1',
      telemetryJson: JSON.stringify({
        stepExecId: 'exec-1',
        runId: 'run-1',
        stepId: 'step-a',
        executableId: 'agent-a',
        status: 'COMPLETED',
      }),
    });

    const resumed = await store.createOrResumeRun({
      runId: 'run-1',
      laneId: 'lane-main',
      itemKey: 'ISS-1',
      inputJson: '{"v":999}',
      compiledPrefixesJson: { default: '{"prefix":"new-unpinned-attempt"}' },
      approvedMaxCostUsd: 25,
    });
    expect(resumed).toEqual({
      status: 'RUNNING',
      currentStepId: 'step-a',
      inputJson: '{"v":2}',
      rewindPendingToStepId: 'step-rewind',
      compiledPrefixesJson: { default: '{"prefix":"pinned-v1"}' },
      costUsd: 0,
      approvedMaxCostUsd: 25,
      completedStepOutputsJson: new Map([['step-a', '{"stepA":"done"}']]),
    });

    await store.recordRunTerminalReceipt('run-1', 'ISS-1', 'done', '{"sha":"abc1234"}');
    const receipts = await store.getRunTerminalReceipts(['ISS-1']);
    expect(receipts.get('ISS-1')).toEqual({
      runId: 'run-1',
      terminalState: 'done',
      scopeReceiptJson: '{"sha":"abc1234"}',
    });
  });

  it('stacks spawned prerequisite items linearly and enforces DAG cycle and depth limits', async () => {
    await store.mutateLanePlan({
      laneId: 'lane-dag',
      parentRunId: 'run-p',
      parentItemKey: 'T_parent',
      spawnedItems: [
        {
          itemKey: 'T_prevTip',
          inputJson: '{"idx":0}',
          dependsOn: [],
          priority: 'normal',
        },
      ],
      addedDependencies: [],
      maxPrerequisiteDepth: 4,
    });

    await store.mutateLanePlan({
      laneId: 'lane-dag',
      parentRunId: 'run-p',
      parentItemKey: 'T_parent',
      spawnedItems: [
        { itemKey: 'T_1', inputJson: '{"idx":1}', dependsOn: [], priority: 'normal' },
        { itemKey: 'T_2', inputJson: '{"idx":2}', dependsOn: [], priority: 'normal' },
      ],
      addedDependencies: [],
      maxPrerequisiteDepth: 4,
    });

    await expect(
      store.mutateLanePlan({
        laneId: 'lane-dag',
        parentRunId: 'run-p',
        parentItemKey: 'T_parent',
        spawnedItems: [
          { itemKey: 'T_overflow', inputJson: '{"idx":3}', dependsOn: [], priority: 'normal' },
        ],
        addedDependencies: [],
        maxPrerequisiteDepth: 3,
      }),
    ).rejects.toThrow(/maxPrerequisiteDepth/);

    await expect(
      store.mutateLanePlan({
        laneId: 'lane-dag',
        parentRunId: 'run-p',
        parentItemKey: 'T_prevTip',
        spawnedItems: [],
        addedDependencies: ['T_parent'],
        maxPrerequisiteDepth: 10,
      }),
    ).rejects.toThrow(/cycle/i);

    await expect(
      store.mutateLanePlan({
        laneId: 'lane-dag',
        parentRunId: 'run-p',
        parentItemKey: 'T_extra',
        spawnedItems: [],
        addedDependencies: ['T_parent'],
        maxPrerequisiteDepth: 3,
      }),
    ).rejects.toThrow(/maxPrerequisiteDepth/);
  });

  it('tracks suspended forks by monotonic epoch and resolves earlier epochs recursively', async () => {
    const forkEpoch1: SuspendedForkRecord = {
      suspendedForkId: 'fork-db#1',
      forkId: 'fork-db',
      suspensionEpoch: 1,
      runId: 'run-fork',
      parentStepExecId: 'step-exec-p',
      forkToolName: 'fork_db',
      activePartitions: ['db'],
      suspensionReason: 'INTERRUPT_RAISED',
      conflictRetryCount: 0,
      conflictCheckArmed: false,
      continuationStack: [],
    };
    const forkEpoch2: SuspendedForkRecord = {
      ...forkEpoch1,
      suspendedForkId: 'fork-db#2',
      suspensionEpoch: 2,
    };

    await store.recordForkSuspension(forkEpoch1);
    await store.recordForkSuspension(forkEpoch2);

    const activeBefore = await store.getSuspendedForks('run-fork', {
      forkIds: ['fork-db'],
      parentStepExecId: 'step-exec-p',
    });
    expect(activeBefore.map((f) => f.suspendedForkId)).toEqual(['fork-db#1', 'fork-db#2']);

    await store.resolveSuspendedFork('fork-db#2', 'RESUMED');
    const activeAfter = await store.getSuspendedForks('run-fork');
    expect(activeAfter).toEqual([]);
  });

  it('appends, replaces, tombstones, chains, and compacts wire frames without touching active runs for the same itemKey', async () => {
    await store.createOrResumeRun({
      runId: 'run-old',
      laneId: 'lane-1',
      itemKey: 'ISS-SHARED',
      inputJson: '{}',
    });
    await store.createOrResumeRun({
      runId: 'run-active',
      laneId: 'lane-1',
      itemKey: 'ISS-SHARED',
      inputJson: '{}',
    });

    const f1 = createSampleWireFrame('m-1', null, 'root-frame');
    const f2 = createSampleWireFrame('m-2', 'm-1', 'leaf-frame');
    const fActive = createSampleWireFrame('m-active-1', null, 'active-frame');

    await store.appendMessageFrame('run-old', f1);
    await store.appendMessageFrame('run-old', f2);
    await store.appendMessageFrame('run-active', fActive);

    const replacedBytes = new TextEncoder().encode('leaf-frame-with-notes');
    await store.replaceMessageFrame('run-old', {
      ...f2,
      rawWireFrame: replacedBytes,
      canonical: {
        ...f2.canonical,
        visibleText: 'leaf-frame-with-notes',
      },
    });
    await store.markFrameTombstone('run-old', 'm-1', 'call-m-1', '[Compacted tool output]');

    const chainBeforeCompact = await store.getMessageChain('m-2');
    expect(chainBeforeCompact.map((f) => f.messageId)).toEqual(['m-1', 'm-2']);
    expect(chainBeforeCompact[0]?.compactedTombstones).toEqual({
      'call-m-1': '[Compacted tool output]',
    });
    expect(new TextDecoder().decode(chainBeforeCompact[1]?.rawWireFrame)).toBe(
      'leaf-frame-with-notes',
    );

    await store.compactRunFrames('run-old');
    expect((await store.getMessageChain('m-2'))[1]?.rawWireFrame.byteLength).toBeGreaterThan(0);

    await store.recordRunTerminalReceipt('run-old', 'ISS-SHARED', 'done', '{"done":true}');
    await store.compactRunFrames('run-old');

    const chainAfterCompact = await store.getMessageChain('m-2');
    expect(chainAfterCompact[0]?.rawWireFrame.byteLength).toBe(0);
    expect(chainAfterCompact[1]?.rawWireFrame.byteLength).toBe(0);
    expect(chainAfterCompact[1]?.canonical.visibleText).toBe('leaf-frame-with-notes');

    const activeChain = await store.getMessageChain('m-active-1');
    expect(new TextDecoder().decode(activeChain[0]?.rawWireFrame)).toBe('active-frame');
  });
});
