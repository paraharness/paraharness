import { H, type RuntimeExecutorRegistry } from '@harness-dsl/core';
import { describe, expect, it } from 'vitest';
import {
  OpenAiModelDriver,
  defaultOpenAiHttpTransport,
  openai,
  type OpenAiHttpTransport,
} from '../src/index.js';

describe('@harness-dsl/openai official openai SDK transport and HTTP status handling', () => {
  it('dispatches defaultOpenAiHttpTransport requests through the official openai SDK client', async () => {
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
      );
    };

    try {
      const seat = openai.account('sdk-seat').apiKey(H.env('OPENAI_API_KEY')).toAST();
      const modelNode = openai.model('gpt5', { id: 'gpt-5' }).toAST();
      const driver = new OpenAiModelDriver(defaultOpenAiHttpTransport, modelNode, {
        registry: {} as RuntimeExecutorRegistry,
        resolveEnv: () => 'sk-proj-openai-sdk-01',
        getRunner: () => {
          throw new Error('Unused');
        },
      });

      const res = await driver.invokeTurn({
        modelId: 'gpt-5',
        accountConfig: seat,
        history: [],
      });

      expect(res.canonical.visibleText).toBe('OpenAI SDK response ok');
      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0]?.url).toBe('https://api.openai.com/v1/responses');
      expect(capturedCalls[0]?.headers.get('x-stainless-lang')).toBe('js');
      expect(capturedCalls[0]?.headers.get('authorization')).toBe('Bearer sk-proj-openai-sdk-01');
      expect(capturedCalls[0]?.body['model']).toBe('gpt-5');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('checks HTTP status before JSON parsing on non-JSON 502 and 429 responses via defaultOpenAiHttpTransport', async () => {
    const originalFetch = globalThis.fetch;
    let mode: '502' | '429' = '502';
    globalThis.fetch = async (): Promise<Response> => {
      if (mode === '502') {
        return new Response('<html><body>502 Bad Gateway</body></html>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        });
      }
      return new Response('Rate limit exceeded (plain text)', {
        status: 429,
        headers: { 'content-type': 'text/plain', 'retry-after': '15' },
      });
    };

    try {
      const driver = new OpenAiModelDriver(defaultOpenAiHttpTransport);
      await expect(
        driver.invokeTurn({ modelId: 'gpt-5', history: [] }),
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
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('checks HTTP status before JSON.parse(bodyText) on custom OpenAiHttpTransport responses', async () => {
    const customTransport: OpenAiHttpTransport = {
      sendResponsesRequest: () =>
        Promise.resolve({
          status: 502,
          bodyText: '502 Bad Gateway',
        }),
    };
    const driver = new OpenAiModelDriver(customTransport);
    await expect(
      driver.invokeTurn({ modelId: 'gpt-5', history: [] }),
    ).rejects.toSatisfy((err: unknown) => {
      const errorObj = err as { readonly name?: string; readonly status?: number; readonly message?: string };
      return (
        errorObj.name !== 'SyntaxError' &&
        errorObj.status === 502 &&
        (errorObj.message?.includes('502 Bad Gateway') ?? false)
      );
    });

    const customRateLimitTransport: OpenAiHttpTransport = {
      sendResponsesRequest: () =>
        Promise.resolve({
          status: 429,
          bodyText: 'Too Many Requests',
          headers: { 'retry-after': '25' },
        }),
    };
    const rateLimitedDriver = new OpenAiModelDriver(customRateLimitTransport);
    const beforeMs = Date.now();
    await expect(
      rateLimitedDriver.invokeTurn({ modelId: 'gpt-5', history: [] }),
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
