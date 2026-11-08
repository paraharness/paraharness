import { M, type RuntimeExecutorRegistry } from '@metaharness/core';
import { describe, expect, it } from 'vitest';
import {
  GeminiModelDriver,
  defaultGeminiHttpTransport,
  gemini,
} from '../src/index.js';
import { RecordedGeminiTransport } from './fixtures/recorded-gemini-transport.js';

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

describe('@metaharness/gemini official @google/genai SDK transport and HTTP status handling', () => {
  it('dispatches defaultGeminiHttpTransport requests through the official @google/genai GoogleGenAI client', async () => {
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
              candidates: [
                {
                  content: {
                    role: 'model',
                    parts: [
                      { text: 'Thinking via SDK', thought: true, thoughtSignature: 'sig-sdk-1' },
                      { text: 'Gemini SDK response ok' },
                    ],
                  },
                },
              ],
              usageMetadata: {
                promptTokenCount: 20,
                candidatesTokenCount: 8,
                cachedContentTokenCount: 5,
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
      async () => {
        const seat = gemini.account('sdk-seat').apiKey(M.env('GEMINI_API_KEY')).toAST();
        const modelNode = gemini.model('geminiPro', { id: 'gemini-3.1-pro' }).toAST();
        const driver = new GeminiModelDriver(defaultGeminiHttpTransport, modelNode, {
          registry: {} as RuntimeExecutorRegistry,
          resolveEnv: () => 'AIza-gemini-sdk-01',
          getRunner: () => {
            throw new Error('Unused');
          },
        });

        const turnResult = await driver.invokeTurn({
          modelId: 'gemini-3.1-pro',
          accountConfig: seat,
          history: [],
        });

        expect(turnResult.canonical.visibleText).toBe('Gemini SDK response ok');
        expect(capturedCalls).toHaveLength(1);
        expect(capturedCalls[0]?.url).toBe(
          'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:generateContent',
        );
        expect(capturedCalls[0]?.headers.get('x-goog-api-client')).toContain('google-genai-sdk/');
        expect(capturedCalls[0]?.headers.get('x-goog-api-key')).toBe('AIza-gemini-sdk-01');
      },
    );
  });

  it('rejects non-JSON HTTP 502 responses via defaultGeminiHttpTransport before JSON parsing', async () => {
    await withMockedFetch(
      (): Promise<Response> =>
        Promise.resolve(
          new Response('<html><body>502 Bad Gateway</body></html>', {
            status: 502,
            headers: { 'content-type': 'text/html' },
          }),
        ),
      async () => {
        const driver = new GeminiModelDriver(defaultGeminiHttpTransport);
        await expect(
          driver.invokeTurn({ modelId: 'gemini-3.1-pro', history: [] }),
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

  it('rejects non-JSON HTTP 429 responses via defaultGeminiHttpTransport with parsed resetAtMs', async () => {
    await withMockedFetch(
      (): Promise<Response> =>
        Promise.resolve(
          new Response('Resource exhausted (plain text)', {
            status: 429,
            headers: { 'content-type': 'text/plain', 'retry-after': '18' },
          }),
        ),
      async () => {
        const driver = new GeminiModelDriver(defaultGeminiHttpTransport);
        const beforeMs = Date.now();
        await expect(
          driver.invokeTurn({ modelId: 'gemini-3.1-pro', history: [] }),
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
            errorObj.resetAtMs >= beforeMs + 17_000 &&
            errorObj.resetAtMs <= Date.now() + 21_000
          );
        });
      },
    );
  });

  it('rejects HTTP 502 responses from RecordedGeminiTransport before JSON.parse(bodyText)', async () => {
    const transport = new RecordedGeminiTransport([
      {
        status: 502,
        bodyText: '502 Bad Gateway',
      },
    ]);
    const driver = new GeminiModelDriver(transport);
    await expect(
      driver.invokeTurn({ modelId: 'gemini-3.1-pro', history: [] }),
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

  it('rejects HTTP 429 responses from RecordedGeminiTransport with parsed resetAtMs', async () => {
    const transport = new RecordedGeminiTransport([
      {
        status: 429,
        bodyText: 'Too Many Requests',
        headers: { 'retry-after': '30' },
      },
    ]);
    const driver = new GeminiModelDriver(transport);
    const beforeMs = Date.now();
    await expect(
      driver.invokeTurn({ modelId: 'gemini-3.1-pro', history: [] }),
    ).rejects.toSatisfy((err: unknown) => {
      const errorObj = err as { readonly status?: number; readonly resetAtMs?: number };
      return (
        errorObj.status === 429 &&
        typeof errorObj.resetAtMs === 'number' &&
        errorObj.resetAtMs >= beforeMs + 29_000
      );
    });
  });
});
