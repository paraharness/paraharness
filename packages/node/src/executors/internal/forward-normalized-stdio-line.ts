import type { PassThrough } from 'node:stream';
import { isPlainRecord } from './dispatch-control-plane-json-rpc.js';

/**
 * Normalizes a single line of inbound stdio JSON-RPC text into a `Buffer` for `StdioServerTransport`.
 *
 * Emits a JSON-RPC `-32700` parse error to `process.stdout` when `line` is not valid JSON and injects
 * default MCP `initialize` parameters when omitted by lightweight JSON-RPC callers.
 *
 * @param {string}      line            - Trimmed single-line JSON-RPC payload.
 * @param {PassThrough} normalizedStdin - Buffer-only stream feeding `StdioServerTransport`.
 */
export function forwardNormalizedStdioLine(
  line: string,
  normalizedStdin: PassThrough,
): void {
  try {
    const parsed: unknown = JSON.parse(line);
    if (!isPlainRecord(parsed)) {
      throw new SyntaxError('Expected JSON-RPC object');
    }
    if (parsed['method'] === 'initialize' && typeof parsed['params'] !== 'object') {
      const normalized = {
        ...parsed,
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'stdio-client', version: '0.1.0' },
        },
      };
      normalizedStdin.write(Buffer.from(`${JSON.stringify(normalized)}\n`, 'utf8'));
      return;
    }
    normalizedStdin.write(Buffer.from(`${JSON.stringify(parsed)}\n`, 'utf8'));
  } catch {
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`,
    );
  }
}
