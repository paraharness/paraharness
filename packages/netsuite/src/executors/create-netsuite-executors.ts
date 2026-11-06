import type {
  AbortHookExecutionInput,
  CheckEvaluationResult,
  IsolationScope,
  PolicyGuardEvaluationInput,
  PolicyGuardEvaluationResult,
  RuntimeDriverContext,
  RuntimeExecutorRegistrySlice,
  StepExecutionContext,
  ToolDriver,
  ToolEffect,
  ToolExecutionResult,
} from '@harness-dsl/core';
import type { DraftJournalReceipt } from '../nodes/draft-journal-receipt.js';
import type { NetSuiteBalanceZeroCheckNode } from '../nodes/netsuite-balance-zero-check-node.js';
import type { NetSuiteClosedPeriodGuardNode } from '../nodes/netsuite-closed-period-guard-node.js';
import type { NetSuiteDraftHandle } from '../nodes/netsuite-draft-handle.js';
import type { NetSuiteDraftScopeNode } from '../nodes/netsuite-draft-scope-node.js';
import type { NetSuiteJournalToolNode } from '../nodes/netsuite-journal-tool-node.js';
import '../nodes/netsuite-registry-augmentation.js';
import type { NetSuiteRollbackAbortHookNode } from '../nodes/netsuite-rollback-abort-hook-node.js';
import { executeNetSuiteRollbackAbortHook } from './internal/execute-netsuite-rollback-abort-hook.js';
import {
  describeNetSuiteJournalToolEffects,
  evaluateNetSuiteBalanceZeroCheck,
  evaluateNetSuiteClosedPeriodGuard,
  executeNetSuiteJournalToolCall,
} from './internal/netsuite-journal-evaluation.js';
import { NetSuiteDraftScopeDriver } from './netsuite-draft-scope-driver.js';

/**
 * Creates a `RuntimeExecutorRegistrySlice` registering `@harness-dsl/netsuite` scope, tool, policy guard, check, and abort hook executors.
 *
 * Registers `'netsuite:draft-scope'` under `scopes`, `'netsuite:journal-tool'` under `tools`,
 * `'netsuite:closed-period-guard'` under `policyGuards`, `'netsuite:balance-zero-check'` under `checks`,
 * and `'netsuite:rollback-abort-hook'` under `abortHooks`.
 *
 * @returns {RuntimeExecutorRegistrySlice} Frozen runtime executor registry slice for `@harness-dsl/netsuite`.
 */
export function createNetSuiteExecutors(): RuntimeExecutorRegistrySlice {
  const journalToolDriver: ToolDriver<NetSuiteJournalToolNode<unknown>, unknown> = Object.freeze<
    ToolDriver<NetSuiteJournalToolNode<unknown>, unknown>
  >({
    describeEffects: (
      tool: NetSuiteJournalToolNode<unknown>,
      rawInput: unknown,
      scopeHandle: unknown,
    ): readonly ToolEffect[] => describeNetSuiteJournalToolEffects(tool, rawInput, scopeHandle),
    execute: (
      tool: NetSuiteJournalToolNode<unknown>,
      rawInput: unknown,
      ctx: StepExecutionContext<unknown>,
    ): Promise<ToolExecutionResult> => executeNetSuiteJournalToolCall(tool, rawInput, ctx),
  });

  return Object.freeze<RuntimeExecutorRegistrySlice>({
    scopes: Object.freeze({
      'netsuite:draft-scope': (
        node: NetSuiteDraftScopeNode,
        _ctx: RuntimeDriverContext,
      ): IsolationScope<NetSuiteDraftHandle, DraftJournalReceipt> =>
        new NetSuiteDraftScopeDriver(node),
    }),
    tools: Object.freeze({
      'netsuite:journal-tool': journalToolDriver,
    }),
    policyGuards: Object.freeze({
      'netsuite:closed-period-guard': (
        node: NetSuiteClosedPeriodGuardNode,
        input: PolicyGuardEvaluationInput,
        _ctx: StepExecutionContext<unknown>,
      ): Promise<PolicyGuardEvaluationResult> => evaluateNetSuiteClosedPeriodGuard(node, input),
    }),
    checks: Object.freeze({
      'netsuite:balance-zero-check': (
        node: NetSuiteBalanceZeroCheckNode<unknown>,
        _input: void,
        ctx: StepExecutionContext<unknown>,
      ): Promise<CheckEvaluationResult> => evaluateNetSuiteBalanceZeroCheck(node, ctx),
    }),
    abortHooks: Object.freeze({
      'netsuite:rollback-abort-hook': (
        node: NetSuiteRollbackAbortHookNode<unknown>,
        input: AbortHookExecutionInput<unknown>,
        ctx: StepExecutionContext<unknown>,
      ): Promise<Record<string, unknown>> => executeNetSuiteRollbackAbortHook(node, input, ctx),
    }),
  });
}
