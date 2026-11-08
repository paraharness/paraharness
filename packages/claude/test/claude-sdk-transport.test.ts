import { H, type RuntimeExecutorRegistry } from '@harness-dsl/core';
import { describe, expect, it } from 'vitest';
import {
  ClaudeModelDriver,
  claude,
  defaultClaudeHttpTransport,
} from '../src/index.js';
import { RecordedClaudeTransport } from './fixtures/recorded-claude-transport.js';

function extractFetchUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
}

/**
 * Temporarily replaces `globalThis.fetch` with `mockFetch` for the duration of `work` and restores the original `fetch` in `finally`.
 *
 * @template T Result type returned by `work`.
 *
 * @param {(input: string | URL | Request, init?: RequestInit) => Promise<Response>} mockFetch - Mock fetch implementation.
 * @param {() => Promise<T>} work - Async test body executed while `globalThis.fetch` is mocked.
 *
 * @returns {Promise<T>} Result of `work`.
 */
async function withMockedFetch<T>(
  mockFetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>,
  work: () => Promise<T>,
): Promise<T> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mockFetch;
  try {
    return await work();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

describe('@harness-dsl/claude official @anthropic-ai/sdk transport and HTTP status handling', () => {
  it('dispatches defaultClaudeHttpTransport requests through the official @anthropic-ai/sdk client', async () => {
    const capturedCalls: Array<{
      readonly url: string;
      readonly headers: Headers;
      readonly body: Readonly<Record<string, unknown>>;
    }> = [];

    await withMockedFetch(
      (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        const url = extractFetchUrl(input);
        const headers = new Headers(init?.headers);
        const rawBody = typeof init?.body === 'string' ? init.body : '{}';
        capturedCalls.push({
          url,
          headers,
          body: JSON.parse(rawBody) as Readonly<Record<string, unknown>>,
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              id: 'msg_sdk_01',
              type: 'message',
              role: 'assistant',
              content: [{ type: 'text', text: 'SDK response ok' }],
              usage: { input_tokens: 15, output_tokens: 5 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
      async () => {
        const seat = claude.account('sdk-seat').apiKey(H.env('ANTHROPIC_API_KEY')).toAST();
        const modelNode = claude.model('sonnet', { id: 'claude-sonnet-4-6' }).toAST();
        const driver = new ClaudeModelDriver(defaultClaudeHttpTransport, modelNode, {
          registry: {} as RuntimeExecutorRegistry,
          resolveEnv: () => 'sk-ant-sdk-key-01',
          getRunner: () => {
            throw new Error('Unused');
          },
        });

        const turnResult = await driver.invokeTurn({
          modelId: 'claude-sonnet-4-6',
          accountConfig: seat,
          history: [],
        });

        expect(turnResult.canonical.visibleText).toBe('SDK response ok');
        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
        expect(capturedCalls[0]?.headers.get('x-stainless-lang')).toBe('js');
        expect(capturedCalls[0]?.headers.get('x-api-key')).toBe('sk-ant-sdk-key-01');
        expect(capturedCalls[0]?.body['model']).toBe('claude-sonnet-4-6');
      },
    );
  });

  it('rejects non-JSON HTTP 502 responses via defaultClaudeHttpTransport before JSON parsing', async () => {
    await withMockedFetch(
      (): Promise<Response> =>
        Promise.resolve(
          new Response('<html><body>502 Bad Gateway</body></html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          }),
        ),
      async () => {
        const driver = new ClaudeModelDriver(defaultClaudeHttpTransport);
        await expect(
          driver.invokeTurn({ modelId: 'claude-sonnet-4-6', history: [] }),
        ).rejects.toSatisfy((err: unknown) => {
          const errorObj = err as {
            readonly name?: string;
            readonly status?: number;
            readonly message?: string;
          };
          return (
            errorObj.name !== 'SyntaxError' &&
            errorObj.status === 502 &&
            (errorObj.message?.includes('502') ?? false)
          );
        });
      },
    );
  });

  it('rejects non-JSON HTTP 429 responses via defaultClaudeHttpTransport with parsed resetAtMs', async () => {
    await withMockedFetch(
      (): Promise<Response> =>
        Promise.resolve(
          new Response('Rate limit exceeded (plain text)', {
            status: 429,
            headers: { 'content-type': 'text/plain', 'retry-after': '12' },
          }),
        ),
      async () => {
        const driver = new ClaudeModelDriver(defaultClaudeHttpTransport);
        const beforeMs = Date.now();
        await expect(
          driver.invokeTurn({ modelId: 'claude-sonnet-4-6', history: [] }),
        ).rejects.toSatisfy((err: unknown) => {
          const errorObj = err as {
            readonly name?: string;
            readonly status?: number;
            readonly resetAtMs?: number;
          };
          return (
            errorObj.name !== 'SyntaxError' &&
            errorObj.status === 429 &&
            typeof errorObj.resetAtMs === 'number' &&
            errorObj.resetAtMs >= beforeMs + 11_000 &&
            errorObj.resetAtMs <= Date.now() + 15_000
          );
        });
      },
    );
  });

  it('rejects HTTP 502 responses from RecordedClaudeTransport before JSON.parse(bodyText)', async () => {
    const transport = new RecordedClaudeTransport([
      {
        status: 502,
        bodyText: '502 Bad Gateway',
      },
    ]);
    const driver = new ClaudeModelDriver(transport);
    await expect(
      driver.invokeTurn({ modelId: 'claude-sonnet-4-6', history: [] }),
    ).rejects.toSatisfy((err: unknown) => {
      const errorObj = err as {
        readonly name?: string;
        readonly status?: number;
        readonly message?: string;
      };
      return (
        errorObj.name !== 'SyntaxError' &&
        errorObj.status === 502 &&
        (errorObj.message?.includes('502 Bad Gateway') ?? false)
      );
    });
  });

  it('rejects HTTP 429 responses from RecordedClaudeTransport with parsed resetAtMs', async () => {
    const transport = new RecordedClaudeTransport([
      {
        status: 429,
        bodyText: 'Too Many Requests',
        headers: { 'retry-after': '20' },
      },
    ]);
    const driver = new ClaudeModelDriver(transport);
    const beforeMs = Date.now();
    await expect(
      driver.invokeTurn({ modelId: 'claude-sonnet-4-6', history: [] }),
    ).rejects.toSatisfy((err: unknown) => {
      const errorObj = err as { readonly status?: number; readonly resetAtMs?: number };
      return (
        errorObj.status === 429 &&
        typeof errorObj.resetAtMs === 'number' &&
        errorObj.resetAtMs >= beforeMs + 19_000
      );
    });
  });
});
