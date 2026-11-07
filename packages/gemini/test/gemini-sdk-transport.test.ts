import { H, type RuntimeExecutorRegistry } from '@harness-dsl/core';
import { describe, expect, it } from 'vitest';
import {
  GeminiModelDriver,
  defaultGeminiHttpTransport,
  gemini,
  type GeminiHttpTransport,
} from '../src/index.js';

describe('@harness-dsl/gemini official @google/genai SDK transport and HTTP status handling', () => {
  it('dispatches defaultGeminiHttpTransport requests through the official @google/genai GoogleGenAI client', async () => {
    const capturedCalls: Array<{
      readonly url: string;
      readonly headers: Headers;
      readonly body: Readonly<Record<string, unknown>>;
    }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      const headers = new Headers(init?.headers);
      const rawBody = typeof init?.body === 'string' ? init.body : '{}';
      capturedCalls.push({
        url,
        headers,
        body: JSON.parse(rawBody) as Readonly<Record<string, unknown>>,
      });
      return new Response(
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
          usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 8, cachedContentTokenCount: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    try {
      const seat = gemini.account('sdk-seat').apiKey(H.env('GEMINI_API_KEY')).toAST();
      const modelNode = gemini.model('geminiPro', { id: 'gemini-3.1-pro' }).toAST();
      const driver = new GeminiModelDriver(defaultGeminiHttpTransport, modelNode, {
        registry: {} as RuntimeExecutorRegistry,
        resolveEnv: () => 'AIza-gemini-sdk-01',
        getRunner: () => {
          throw new Error('Unused');
        },
      });

      const res = await driver.invokeTurn({
        modelId: 'gemini-3.1-pro',
        accountConfig: seat,
        history: [],
      });

      expect(res.canonical.visibleText).toBe('Gemini SDK response ok');
      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0]?.url).toBe(
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro:generateContent',
      );
      expect(capturedCalls[0]?.headers.get('x-goog-api-client')).toContain('google-genai-sdk/');
      expect(capturedCalls[0]?.headers.get('x-goog-api-key')).toBe('AIza-gemini-sdk-01');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('checks HTTP status before JSON parsing on non-JSON 502 and 429 responses via defaultGeminiHttpTransport', async () => {
    const originalFetch = globalThis.fetch;
    let mode: '502' | '429' = '502';
    globalThis.fetch = async (): Promise<Response> => {
      if (mode === '502') {
        return new Response('<html><body>502 Bad Gateway</body></html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response('Resource exhausted (plain text)', {
        status: 429,
        headers: { 'content-type': 'text/plain', 'retry-after': '18' },
      });
    };

    try {
      const driver = new GeminiModelDriver(defaultGeminiHttpTransport);
      await expect(
        driver.invokeTurn({ modelId: 'gemini-3.1-pro', history: [] }),
      ).rejects.toSatisfy((err: unknown) => {
        const errorObj = err as { readonly name?: string; readonly status?: number; readonly message?: string };
        return (
          errorObj.name !== 'SyntaxError' &&
          errorObj.status === 502 &&
          (errorObj.message?.includes('502') ?? false)
        );
      });

      mode = '429';
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
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('checks HTTP status before JSON.parse(bodyText) on custom GeminiHttpTransport responses', async () => {
    const customTransport: GeminiHttpTransport = {
      sendGenerateContentRequest: () =>
        Promise.resolve({
          status: 502,
          bodyText: '502 Bad Gateway',
        }),
    };
    const driver = new GeminiModelDriver(customTransport);
    await expect(
      driver.invokeTurn({ modelId: 'gemini-3.1-pro', history: [] }),
    ).rejects.toSatisfy((err: unknown) => {
      const errorObj = err as { readonly name?: string; readonly status?: number; readonly message?: string };
      return (
        errorObj.name !== 'SyntaxError' &&
        errorObj.status === 502 &&
        (errorObj.message?.includes('502 Bad Gateway') ?? false)
      );
    });

    const customRateLimitTransport: GeminiHttpTransport = {
      sendGenerateContentRequest: () =>
        Promise.resolve({
          status: 429,
          bodyText: 'Too Many Requests',
          headers: { 'retry-after': '30' },
        }),
    };
    const rateLimitedDriver = new GeminiModelDriver(customRateLimitTransport);
    const beforeMs = Date.now();
    await expect(
      rateLimitedDriver.invokeTurn({ modelId: 'gemini-3.1-pro', history: [] }),
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
