import type { HarnessRuntimeController } from '@metaharness/core';

/**
 * Parameters for dispatching an inbound REST or JSON-RPC control-plane payload.
 *
 * Supplies the parsed JSON request body, the active runtime controller, and the logical server name.
 */
export interface DispatchControlPlaneJsonRpcParams {
  /** Parsed request JSON payload record. */
  readonly body: Record<string, unknown>;
  /** Active harness runtime controller. */
  readonly controller: HarnessRuntimeController;
  /** Logical MCP server name reported in `initialize` responses. */
  readonly serverName: string;
}

/**
 * Narrowing type guard checking whether `value` is a non-null, non-array plain object record.
 *
 * Used across HTTP, SSE, and stdio MCP control-plane adapters to narrow parsed JSON payloads without type casts.
 *
 * @param {unknown} value - Candidate decoded JSON value.
 *
 * @returns {value is Record<string, unknown>} True when `value` is a plain object record.
 */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Dispatches an inbound REST or direct JSON-RPC control-plane payload against `HarnessRuntimeController`.
 *
 * Supports `initialize`, `tools/list`, `tools/call` (`getActiveRuns`, `emitSignal`), `runs/list`,
 * and direct `{ signalId, payload }` signal emission requests.
 *
 * @param {DispatchControlPlaneJsonRpcParams} params - Parsed request body, runtime controller, and server name.
 *
 * @returns {Promise<Record<string, unknown>>} JSON-serializable response payload.
 */
export async function dispatchControlPlaneJsonRpc(
  params: DispatchControlPlaneJsonRpcParams,
): Promise<Record<string, unknown>> {
  const { body, controller, serverName } = params;
  const id = body['id'] ?? null;
  const method = typeof body['method'] === 'string' ? body['method'] : undefined;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: { serverInfo: { name: serverName, version: '0.1.0' } },
    };
  }
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id,
      result: { tools: [{ name: 'getActiveRuns' }, { name: 'emitSignal' }] },
    };
  }
  const rawParams = body['params'];
  const rpcParams = isPlainRecord(rawParams) ? rawParams : body;
  const toolName = typeof rpcParams['name'] === 'string' ? rpcParams['name'] : method;
  const rawArgs = rpcParams['arguments'];
  const toolArgs = isPlainRecord(rawArgs) ? rawArgs : rpcParams;
  if (
    toolName === 'getActiveRuns' ||
    toolName === 'get_active_runs' ||
    toolName === 'runs/list'
  ) {
    const runs = await controller.getActiveRuns();
    return method !== undefined ? { jsonrpc: '2.0', id, result: { runs } } : { ok: true, runs };
  }
  const signalId = typeof toolArgs['signalId'] === 'string' ? toolArgs['signalId'] : undefined;
  if (signalId !== undefined) {
    await controller.emitSignal(signalId, toolArgs['payload']);
    return method !== undefined ? { jsonrpc: '2.0', id, result: { ok: true } } : { ok: true };
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: 'Unsupported control-plane request.' },
  };
}
