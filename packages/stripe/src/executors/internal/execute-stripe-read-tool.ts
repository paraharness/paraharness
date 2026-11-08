import type { StepExecutionContext, ToolExecutionResult } from '@metaharness/core';
import type { StripeReadToolNode } from '../../nodes/stripe-read-tool-node.js';
import type { StripeGateway } from '../stripe-gateway.js';
import { describeStripeToolEffects } from './describe-stripe-tool-effects.js';

/**
 * Parameters for executing a `StripeReadToolNode` invocation via `executeStripeReadTool`.
 *
 * Bundles the passive tool AST node, raw model input, active step execution context, and Stripe gateway.
 */
export interface ExecuteStripeReadToolParams {
  /** Passive Stripe tool AST node. */
  readonly node: StripeReadToolNode;
  /** Raw tool input payload supplied by the model. */
  readonly input: unknown;
  /** Active step execution context. */
  readonly ctx: StepExecutionContext<unknown>;
  /** Active Stripe gateway implementation. */
  readonly gateway: StripeGateway;
}

/**
 * Dispatches a validated `StripeReadToolNode` tool call to `gateway.stageRefund` or `gateway.listSettlements`.
 *
 * Separates Stripe gateway method dispatch from schema validation and effect recording.
 *
 * @param {StripeReadToolNode}                node    - Passive Stripe tool AST node.
 * @param {Readonly<Record<string, unknown>>} parsed  - Schema-validated tool input object.
 * @param {StripeGateway}                     gateway - Active Stripe gateway implementation.
 *
 * @returns {Promise<unknown>} Gateway response payload, or `undefined` in offline mode.
 */
async function invokeStripeGatewayOperation(
  node: StripeReadToolNode,
  parsed: Readonly<Record<string, unknown>>,
  gateway: StripeGateway,
): Promise<unknown> {
  if (node.name === 'stripe_stage_refund') {
    const journalId = typeof parsed['journalId'] === 'string' ? parsed['journalId'] : undefined;
    return gateway.stageRefund({
      chargeId: String(parsed['chargeId'] ?? ''),
      amountUsd: Number(parsed['amountUsd'] ?? 0),
      journalId,
    });
  }
  const discrepancyId =
    typeof parsed['discrepancyId'] === 'string' ? parsed['discrepancyId'] : undefined;
  return gateway.listSettlements({
    accountRegion: String(parsed['accountRegion'] ?? ''),
    discrepancyId,
  });
}

/**
 * Executes a `StripeReadToolNode` invocation against `params.gateway` and records declared `ToolEffect` descriptors.
 *
 * Validates `params.input` against `params.node.inputSchema`, records effects via `params.ctx.recordEffects`,
 * and returns a frozen JSON `ToolExecutionResult`.
 *
 * @param {ExecuteStripeReadToolParams} params - Stripe tool node, input payload, step execution context, and gateway.
 *
 * @returns {Promise<ToolExecutionResult>} Frozen JSON-serialized tool execution result.
 *
 * @throws {Error} If `params.input` fails `params.node.inputSchema` validation or the Stripe gateway call fails.
 */
export async function executeStripeReadTool(
  params: ExecuteStripeReadToolParams,
): Promise<ToolExecutionResult> {
  const parsed = params.node.inputSchema.parse(params.input) as Readonly<Record<string, unknown>>;
  const effects = describeStripeToolEffects(params.node, parsed);
  params.ctx.recordEffects(effects);
  const result = await invokeStripeGatewayOperation(params.node, parsed, params.gateway);
  const payload = {
    tool: params.node.name,
    status: 'ok',
    input: parsed,
    result,
  };
  return Object.freeze<ToolExecutionResult>({
    content: JSON.stringify(payload),
    isError: false,
  });
}
