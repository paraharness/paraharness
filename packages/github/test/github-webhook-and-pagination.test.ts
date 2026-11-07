import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import { Webhooks } from '@octokit/webhooks';
import { describe, expect, it } from 'vitest';
import {
  H,
  createExecutorRegistry,
  type RuntimeDriverContext,
} from '@harness-dsl/core';
import {
  GithubIssuesTrackerAdapter,
  GithubWebhookStreamSource,
  createGithubExecutors,
  github,
} from '../src/index.js';
import { readHttpRequestBody } from '../src/executors/internal/read-http-request-body.js';
import { RecordedGithubHttpTransport } from './fixtures/recorded-github-http-transport.js';

function createDriverContext(
  env: Readonly<Record<string, string | undefined>>,
  transport?: RecordedGithubHttpTransport,
): RuntimeDriverContext {
  const registry = createExecutorRegistry(createGithubExecutors(transport));
  return {
    registry,
    resolveEnv(value) {
      if (typeof value === 'string') {
        return value;
      }
      return env[value.key];
    },
    getRunner() {
      throw new Error('RunnerDriver not used in github tests.');
    },
  };
}

describe('@harness-dsl/github Octokit pagination and Webhooks verification', () => {
  it('paginates open issues across 100-item pages and filters out pull_request entries', async () => {
    const trackerNode = github.issues({
      repo: 'acme/app',
      token: 'ghp_page_token',
    });
    const transport = new RecordedGithubHttpTransport();

    const page1: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 100; i += 1) {
      page1.push({
        number: i,
        title: `Item ${i}`,
        body: `Body ${i}`,
        labels: ['agent-ready'],
        state: 'open',
        ...(i % 2 === 0 ? { pull_request: { url: `https://api.github.com/pulls/${i}` } } : {}),
      });
    }
    const page2: Array<Record<string, unknown>> = [
      {
        number: 101,
        title: 'Issue 101',
        body: 'Second page issue',
        labels: ['agent-ready'],
        state: 'open',
      },
    ];

    transport.registerResponse(
      'GET',
      '/repos/acme/app/issues?state=open&per_page=100&page=1',
      page1,
    );
    transport.registerResponse(
      'GET',
      '/repos/acme/app/issues?state=open&per_page=100&page=2',
      page2,
    );

    const ctx = createDriverContext({}, transport);
    const adapter = new GithubIssuesTrackerAdapter(trackerNode, ctx, transport);
    const issues = await adapter.poll();

    expect(issues).toHaveLength(51);
    expect(issues[0]?.number).toBe(1);
    expect(issues[50]?.number).toBe(101);
    expect(transport.calls).toHaveLength(2);
  });

  it('verifies signatures via @octokit/webhooks, rejects oversized >10MB bodies with HTTP 413, and handles onEvent 500 errors', async () => {
    const secret = 'whsec_octokit_test';
    const webhooks = new Webhooks({ secret });
    const streamNode = github.webhookStream({
      repo: 'acme/app',
      port: 0,
      secret: H.env('GH_WEBHOOK_SECRET'),
      events: ['pull_request.closed'],
    });
    let shouldFailHandler = false;
    const received: unknown[] = [];
    const source = new GithubWebhookStreamSource(
      streamNode,
      createDriverContext({ GH_WEBHOOK_SECRET: secret }),
    );
    const sub = await source.subscribe(async (ev) => {
      if (shouldFailHandler) {
        throw new Error('Downstream event processor failed');
      }
      received.push(ev);
    });

    try {
      const url = `http://127.0.0.1:${source.getBoundPort()}/webhooks/github`;
      const oversizedBody = Buffer.alloc(10 * 1024 * 1024 + 1024, 65);
      const tooLargeRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
        },
        body: oversizedBody,
      });
      expect(tooLargeRes.status).toBe(413);

      const payload = { action: 'closed', repository: { full_name: 'acme/app' } };
      const rawBody = JSON.stringify(payload);
      const sig = await webhooks.sign(rawBody);

      const okRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
      });
      expect(okRes.status).toBe(200);
      expect(received).toEqual([payload]);

      shouldFailHandler = true;
      const errRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-GitHub-Event': 'pull_request',
          'X-Hub-Signature-256': sig,
        },
        body: rawBody,
        signal: AbortSignal.timeout(500),
      });
      expect(errRes.status).toBe(500);
      await expect(errRes.json()).resolves.toEqual({
        error: 'Downstream event processor failed',
      });
    } finally {
      await sub.close();
    }
  });

  it('detaches readHttpRequestBody listeners on settle, rejects premature close, and rejects duplicate subscribe() (VF-3)', async () => {
    const fakeReq = Object.assign(new EventEmitter(), {
      complete: false,
      pause() {
        return this;
      },
    }) as IncomingMessage;

    const bodyPromise = readHttpRequestBody(fakeReq, 64);
    expect(fakeReq.listenerCount('data')).toBe(1);
    expect(fakeReq.listenerCount('end')).toBe(1);
    expect(fakeReq.listenerCount('error')).toBe(1);
    expect(fakeReq.listenerCount('close')).toBe(1);

    fakeReq.emit('close');
    await expect(bodyPromise).rejects.toThrow(
      'GitHub webhook HTTP request closed prematurely before body completed.',
    );
    expect(fakeReq.listenerCount('data')).toBe(0);
    expect(fakeReq.listenerCount('end')).toBe(0);
    expect(fakeReq.listenerCount('error')).toBe(0);
    expect(fakeReq.listenerCount('close')).toBe(0);

    const streamNode = github.webhookStream({
      repo: 'acme/app',
      port: 0,
      secret: 'whsec_dup_test',
      events: ['pull_request.closed'],
    });
    const source = new GithubWebhookStreamSource(streamNode, createDriverContext({}));
    const sub1 = await source.subscribe(async () => {});
    try {
      await expect(source.subscribe(async () => {})).rejects.toThrow('already subscribed');
    } finally {
      await sub1.close();
    }
  });
});
