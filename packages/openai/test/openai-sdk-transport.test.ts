import { P, type RuntimeExecutorRegistry } from '@paraharness/core';
import { describe, expect, it } from 'vitest';
import {
  OpenAiModelDriver,
  defaultOpenAiHttpTransport,
  openai,
} from '../src/index.js';
import { RecordedOpenAiTransport } from './fixtures/recorded-openai-transport.js';

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

describe('@paraharness/openai official openai SDK transport and HTTP status handling', () => {
  it('dispatches defaultOpenAiHttpTransport requests through the official openai SDK client', async () => {
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
              id: 'resp_sdk_01',
              output: [
                {
                  type: 'message',
                  id: 'msg_sdk_01',
                  role: 'assistant',
                  content: [{ type: 'output_text', text: 'OpenAI SDK response ok' }],
                },
              ],
              usage: { input_tokens: 18, output_tokens: 6 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
      async () => {
        const seat = openai.account('sdk-seat').apiKey(P.env('OPENAI_API_KEY')).toAST();
        const modelNode = openai.model('gpt5', { id: 'gpt-5' }).toAST();
        const driver = new OpenAiModelDriver(defaultOpenAiHttpTransport, modelNode, {
          registry: {} as RuntimeExecutorRegistry,
          resolveEnv: () => 'sk-proj-openai-sdk-01',
          getRunner: () => {
            throw new Error('Unused');
          },
        });

        const turnResult = await driver.invokeTurn({
          modelId: 'gpt-5',
          accountConfig: seat,
          history: [],
        });

        expect(turnResult.canonical.visibleText).toBe('OpenAI SDK response ok');
        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0]?.url).toBe('https://api.openai.com/v1/responses');
        expect(capturedCalls[0]?.headers.get('x-stainless-lang')).toBe('js');
        expect(capturedCalls[0]?.headers.get('authorization')).toBe('Bearer sk-proj-openai-sdk-01');
        expect(capturedCalls[0]?.body['model']).toBe('gpt-5');
      },
    );
  });

  it('rejects non-JSON HTTP 502 responses via defaultOpenAiHttpTransport before JSON parsing', async () => {
    await withMockedFetch(
      (): Promise<Response> =>
        Promise.resolve(
          new Response('<html><body>502 Bad Gateway</body></html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          }),
        ),
      async () => {
        const driver = new OpenAiModelDriver(defaultOpenAiHttpTransport);
        await expect(
          driver.invokeTurn({ modelId: 'gpt-5', history: [] }),
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

  it('rejects non-JSON HTTP 429 responses via defaultOpenAiHttpTransport with parsed resetAtMs', async () => {
    await withMockedFetch(
      (): Promise<Response> =>
        Promise.resolve(
          new Response('Rate limit exceeded (plain text)', {
            status: 429,
            headers: { 'content-type': 'text/plain', 'retry-after': '15' },
          }),
        ),
      async () => {
        const driver = new OpenAiModelDriver(defaultOpenAiHttpTransport);
        const beforeMs = Date.now();
        await expect(
          driver.invokeTurn({ modelId: 'gpt-5', history: [] }),
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
            errorObj.resetAtMs >= beforeMs + 14_000 &&
            errorObj.resetAtMs <= Date.now() + 18_000
          );
        });
      },
    );
  });

  it('rejects HTTP 502 responses from RecordedOpenAiTransport before JSON.parse(bodyText)', async () => {
    const transport = new RecordedOpenAiTransport([
      {
        status: 502,
        bodyText: '502 Bad Gateway',
      },
    ]);
    const driver = new OpenAiModelDriver(transport);
    await expect(
      driver.invokeTurn({ modelId: 'gpt-5', history: [] }),
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

  it('rejects HTTP 429 responses from RecordedOpenAiTransport with parsed resetAtMs', async () => {
    const transport = new RecordedOpenAiTransport([
      {
        status: 429,
        bodyText: 'Too Many Requests',
        headers: { 'retry-after': '25' },
      },
    ]);
    const driver = new OpenAiModelDriver(transport);
    const beforeMs = Date.now();
    await expect(
      driver.invokeTurn({ modelId: 'gpt-5', history: [] }),
    ).rejects.toSatisfy((err: unknown) => {
      const errorObj = err as { readonly status?: number; readonly resetAtMs?: number };
      return (
        errorObj.status === 429 &&
        typeof errorObj.resetAtMs === 'number' &&
        errorObj.resetAtMs >= beforeMs + 24_000
      );
    });
  });
});
