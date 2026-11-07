import { PassThrough } from 'node:stream';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { forwardNormalizedStdioLine } from './forward-normalized-stdio-line.js';

/**
 * Mutable line-accumulator state for framing newline-delimited JSON-RPC messages over `process.stdin`.
 *
 * Retains trailing partial line text between `'data'` chunks.
 */
export interface StdioLineAccumulatorState {
  /** Unterminated partial line buffered from previous `process.stdin` chunks. */
  remainder: string;
}

/**
 * Parameters for consuming a raw `process.stdin` chunk into normalized JSON-RPC lines.
 *
 * Bundles the line accumulator state, incoming chunk, and normalized `PassThrough` stream.
 */
export interface ConsumeBufferedStdioChunkParams {
  /** Mutable line accumulator state. */
  readonly state: StdioLineAccumulatorState;
  /** Newly received `process.stdin` data chunk. */
  readonly chunk: Buffer | string;
  /** Buffer-only `PassThrough` stream connected to `StdioServerTransport`. */
  readonly normalizedStdin: PassThrough;
}

/**
 * Appends `params.chunk` to `params.state.remainder` and forwards every complete newline-delimited line.
 *
 * Leaves any trailing unterminated segment in `params.state.remainder` for subsequent chunks.
 *
 * @param {ConsumeBufferedStdioChunkParams} params - Accumulator state, incoming chunk, and target stream.
 */
export function consumeBufferedStdioChunk(params: ConsumeBufferedStdioChunkParams): void {
  const { state, chunk, normalizedStdin } = params;
  state.remainder += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
  let newlineIdx = state.remainder.indexOf('\n');
  while (newlineIdx !== -1) {
    const line = state.remainder.slice(0, newlineIdx).trim();
    state.remainder = state.remainder.slice(newlineIdx + 1);
    newlineIdx = state.remainder.indexOf('\n');
    if (line.length > 0) {
      forwardNormalizedStdioLine(line, normalizedStdin);
    }
  }
}

/**
 * Connects a `StdioServerTransport` to `mcpServer` with Buffer-normalized `process.stdin` framing.
 *
 * Prevents `@modelcontextprotocol/sdk` `ReadBuffer` from receiving raw string chunks (which lack `.subarray`)
 * while routing all valid JSON-RPC messages through `StdioServerTransport` and `McpServer`.
 *
 * @param {McpServer} mcpServer - Configured MCP server instance.
 *
 * @returns {Promise<() => Promise<void>>} Teardown callback detaching `process.stdin` and closing `mcpServer`.
 */
export async function connectStdioControlPlaneTransport(
  mcpServer: McpServer,
): Promise<() => Promise<void>> {
  const normalizedStdin = new PassThrough();
  const transport = new StdioServerTransport(normalizedStdin, process.stdout);
  await mcpServer.connect(transport);
  const state: StdioLineAccumulatorState = { remainder: '' };
  const onData = (chunk: Buffer | string): void => {
    consumeBufferedStdioChunk({ state, chunk, normalizedStdin });
  };
  process.stdin.on('data', onData);
  process.stdin.unref?.();
  return async (): Promise<void> => {
    process.stdin.removeListener('data', onData);
    if (process.stdin.listenerCount('data') === 0) process.stdin.pause();
    normalizedStdin.end();
    await mcpServer.close();
  };
}
