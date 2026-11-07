import type {
  StepExecutionContext,
  ToolDriver,
  ToolEffect,
  ToolExecutionResult,
} from '@harness-dsl/core';
import type { StripeReadToolNode } from '../../nodes/stripe-read-tool-node.js';
import type { StripeGateway } from '../stripe-gateway.js';
import { describeStripeToolEffects } from './evaluate-stripe-refund-effects.js';

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
 * Executes a `StripeReadToolNode` invocation against `gateway` and records declared `ToolEffect` descriptors.
 *
 * Validates `input` against `node.inputSchema`, records effects via `ctx.recordEffects`, and returns a JSON `ToolExecutionResult`.
 *
 * @param {StripeReadToolNode}            node    - Passive Stripe tool AST node.
 * @param {unknown}                       input   - Raw tool input payload.
 * @param {StepExecutionContext<unknown>} ctx     - Active step execution context.
 * @param {StripeGateway}                 gateway - Active Stripe gateway implementation.
 *
 * @returns {Promise<ToolExecutionResult>} Frozen JSON-serialized tool execution result.
 *
 * @throws {Error} If `input` fails `node.inputSchema` validation or the Stripe gateway call fails.
 */
export async function executeStripeReadTool(
  node: StripeReadToolNode,
  input: unknown,
  ctx: StepExecutionContext<unknown>,
  gateway: StripeGateway,
): Promise<ToolExecutionResult> {
  const parsed = node.inputSchema.parse(input) as Readonly<Record<string, unknown>>;
  const effects = describeStripeToolEffects(node, parsed);
  ctx.recordEffects(effects);
  const result = await invokeStripeGatewayOperation(node, parsed, gateway);
  const payload =
    result !== undefined
      ? { tool: node.name, status: 'ok', input: parsed, result }
      : { tool: node.name, status: 'ok', input: parsed };
  return Object.freeze<ToolExecutionResult>({
    content: JSON.stringify(payload),
    isError: false,
  });
}

/**
 * Creates a frozen `ToolDriver<StripeReadToolNode, unknown>` bound to `gateway`.
 *
 * Binds `describeStripeToolEffects` for pre-flight policy inspection and `executeStripeReadTool` for execution.
 *
 * @param {StripeGateway} gateway - Active Stripe gateway implementation.
 *
 * @returns {ToolDriver<StripeReadToolNode, unknown>} Frozen `ToolDriver` for `'stripe:read-tool'`.
 */
export function createStripeReadToolDriver(
  gateway: StripeGateway,
): ToolDriver<StripeReadToolNode, unknown> {
  return Object.freeze<ToolDriver<StripeReadToolNode, unknown>>({
    describeEffects(node: StripeReadToolNode, args: unknown): readonly ToolEffect[] {
      return describeStripeToolEffects(node, args);
    },
    execute(
      node: StripeReadToolNode,
      input: unknown,
      ctx: StepExecutionContext<unknown>,
    ): Promise<ToolExecutionResult> {
      return executeStripeReadTool(node, input, ctx, gateway);
    },
  });
}
