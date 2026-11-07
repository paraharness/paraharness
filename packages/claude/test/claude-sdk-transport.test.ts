import { H, type RuntimeExecutorRegistry } from '@harness-dsl/core';
import { describe, expect, it } from 'vitest';
import {
  ClaudeModelDriver,
  claude,
  defaultClaudeHttpTransport,
  type ClaudeHttpTransport,
} from '../src/index.js';

describe('@harness-dsl/claude official @anthropic-ai/sdk transport and HTTP status handling', () => {
  it('dispatches defaultClaudeHttpTransport requests through the official @anthropic-ai/sdk client', async () => {
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
          id: 'msg_sdk_01',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'SDK response ok' }],
          usage: { input_tokens: 15, output_tokens: 5 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };

    try {
      const seat = claude.account('sdk-seat').apiKey(H.env('ANTHROPIC_API_KEY')).toAST();
      const modelNode = claude.model('sonnet', { id: 'claude-sonnet-4-6' }).toAST();
      const driver = new ClaudeModelDriver(defaultClaudeHttpTransport, modelNode, {
        registry: {} as RuntimeExecutorRegistry,
        resolveEnv: () => 'sk-ant-sdk-key-01',
        getRunner: () => {
          throw new Error('Unused');
        },
      });

      const res = await driver.invokeTurn({
        modelId: 'claude-sonnet-4-6',
        accountConfig: seat,
        history: [],
      });

      expect(res.canonical.visibleText).toBe('SDK response ok');
      expect(capturedCalls).toHaveLength(1);
      expect(capturedCalls[0]?.url).toBe('https://api.anthropic.com/v1/messages');
      expect(capturedCalls[0]?.headers.get('x-stainless-lang')).toBe('js');
      expect(capturedCalls[0]?.headers.get('x-api-key')).toBe('sk-ant-sdk-key-01');
      expect(capturedCalls[0]?.body['model']).toBe('claude-sonnet-4-6');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('checks HTTP status before JSON parsing on non-JSON 502 and 429 responses via defaultClaudeHttpTransport', async () => {
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
        headers: { 'content-type': 'text/plain', 'retry-after': '12' },
      });
    };

    try {
      const driver = new ClaudeModelDriver(defaultClaudeHttpTransport);
      await expect(
        driver.invokeTurn({ modelId: 'claude-sonnet-4-6', history: [] }),
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
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('checks HTTP status before JSON.parse(bodyText) on custom ClaudeHttpTransport responses', async () => {
    const customTransport: ClaudeHttpTransport = {
      sendMessagesRequest: () =>
        Promise.resolve({
          status: 502,
          bodyText: '502 Bad Gateway',
        }),
    };
    const driver = new ClaudeModelDriver(customTransport);
    await expect(
      driver.invokeTurn({ modelId: 'claude-sonnet-4-6', history: [] }),
    ).rejects.toSatisfy((err: unknown) => {
      const errorObj = err as { readonly name?: string; readonly status?: number; readonly message?: string };
      return (
        errorObj.name !== 'SyntaxError' &&
        errorObj.status === 502 &&
        (errorObj.message?.includes('502 Bad Gateway') ?? false)
      );
    });

    const customRateLimitTransport: ClaudeHttpTransport = {
      sendMessagesRequest: () =>
        Promise.resolve({
          status: 429,
          bodyText: 'Too Many Requests',
          headers: { 'retry-after': '20' },
        }),
    };
    const rateLimitedDriver = new ClaudeModelDriver(customRateLimitTransport);
    const beforeMs = Date.now();
    await expect(
      rateLimitedDriver.invokeTurn({ modelId: 'claude-sonnet-4-6', history: [] }),
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
