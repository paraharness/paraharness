import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  H,
  createExecutorRegistry,
  z,
  type RuntimeDriverContext,
  type StepExecutionContext,
} from '@harness-dsl/core';
import {
  GithubIssuesTrackerAdapter,
  GithubWebhookStreamSource,
  createGithubExecutors,
  github,
} from '../src/index.js';
import { RecordedGithubHttpTransport } from './fixtures/recorded-github-http-transport.js';

function createTestDriverContext(
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

function createTestStepContext(
  env: Readonly<Record<string, string | undefined>>,
  transport: RecordedGithubHttpTransport,
): StepExecutionContext<unknown> {
  const driverCtx = createTestDriverContext(env, transport);
  return {
    runId: 'run-gh-1',
    stepExecId: 'step-gh-1',
    scopeHandle: undefined,
    activePartitions: ['api'],
    activeLeases: [],
    observedEffects: [],
    registry: driverCtx.registry,
    resolveEnv: (val) => driverCtx.resolveEnv(val),
    getRunner: (node) => driverCtx.getRunner(node),
    recordEffects() {
      return undefined;
    },
  };
}

describe('@harness-dsl/github adapter', () => {
  describe('github.issues builder and GithubIssuesTrackerAdapter', () => {
    it('compiles passive GithubIssuesTrackerNode and polls/updates issue labels using resolved EnvRef', async () => {
      const trackerNode = github.issues({
        repo: 'acme/app',
        token: H.env('GITHUB_TOKEN'),
        labels: ['agent-ready', 'partition:api'],
      });

      expect(trackerNode).toEqual({
        type: 'github:issues',
        repo: 'acme/app',
        token: { type: 'harness:env-ref', key: 'GITHUB_TOKEN' },
        labels: ['agent-ready', 'partition:api'],
      });
      expect(Object.isFrozen(trackerNode)).toBe(true);

      const transport = new RecordedGithubHttpTransport();
      transport.registerResponse(
        'GET',
        '/repos/acme/app/issues?state=open&labels=agent-ready%2Cpartition%3Aapi&per_page=100&page=1',
        [
          {
            number: 42,
            title: 'Fix race condition in checkout',
            body: 'Repro steps included.',
            labels: [{ name: 'agent-ready' }, 'partition:api'],
            state: 'open',
            html_url: 'https://github.com/acme/app/issues/42',
          },
          {
            number: 43,
            title: 'PR masquerading as issue in GitHub REST API',
            body: 'Should be filtered out because pull_request key exists.',
            labels: [{ name: 'agent-ready' }],
            state: 'open',
            html_url: 'https://github.com/acme/app/pull/43',
            pull_request: { url: 'https://api.github.com/repos/acme/app/pulls/43' },
          },
        ],
      );
      transport.registerResponse('POST', '/repos/acme/app/issues/42/labels', [
        { name: 'agent-ready' },
        { name: 'partition:api' },
        { name: 'in-progress' },
      ]);

      const ctx = createTestDriverContext({ GITHUB_TOKEN: 'ghp_secret_123' }, transport);
      const adapter = new GithubIssuesTrackerAdapter(trackerNode, ctx, transport);

      const polled = await adapter.poll();
      expect(polled).toEqual([
        {
          number: 42,
          title: 'Fix race condition in checkout',
          body: 'Repro steps included.',
          labels: ['agent-ready', 'partition:api'],
          state: 'open',
          htmlUrl: 'https://github.com/acme/app/issues/42',
        },
      ]);

      await adapter.setExternalState('#42', 'in-progress');
      expect(transport.calls).toEqual([
        {
          method: 'GET',
          path: '/repos/acme/app/issues?state=open&labels=agent-ready%2Cpartition%3Aapi&per_page=100&page=1',
          token: 'ghp_secret_123',
          body: undefined,
        },
        {
          method: 'POST',
          path: '/repos/acme/app/issues/42/labels',
          token: 'ghp_secret_123',
          body: { labels: ['in-progress'] },
        },
      ]);
    });

    it('rejects missing GITHUB_TOKEN environment variable at poll time', async () => {
      const trackerNode = github.issues({
        repo: 'acme/app',
        token: H.env('MISSING_GH_TOKEN'),
      });
      const transport = new RecordedGithubHttpTransport();
      const ctx = createTestDriverContext({}, transport);
      const adapter = new GithubIssuesTrackerAdapter(trackerNode, ctx, transport);

      await expect(adapter.poll()).rejects.toThrow(
        "Missing required GitHub secret/token 'MISSING_GH_TOKEN'",
      );
    });
  });

  describe('github.webhookStream builder and GithubWebhookStreamSource', () => {
    it('applies default port 3000 and path /webhooks/github on AST node', () => {
      const streamNode = github.webhookStream({
        repo: 'acme/app',
        secret: H.env('GH_WEBHOOK_SECRET'),
        events: ['pull_request.closed'],
      });

      expect(streamNode).toEqual({
        type: 'github:webhook-stream',
        repo: 'acme/app',
        port: 3000,
        path: '/webhooks/github',
        secret: { type: 'harness:env-ref', key: 'GH_WEBHOOK_SECRET' },
        events: ['pull_request.closed'],
      });
    });

    it('verifies HMAC-SHA256 X-Hub-Signature-256 and filters deliveries by event and repository', async () => {
      const secret = 'whsec_test_secret';
      const streamNode = github.webhookStream({
        repo: 'acme/app',
        port: 0,
        path: '/webhooks/github',
        secret: H.env('GH_WEBHOOK_SECRET'),
        events: ['pull_request.closed'],
      });

      const ctx = createTestDriverContext({ GH_WEBHOOK_SECRET: secret });
      const source = new GithubWebhookStreamSource(streamNode, ctx);
      const receivedEvents: unknown[] = [];

      const subscription = await source.subscribe(async (ev) => {
        receivedEvents.push(ev);
      });

      try {
        const boundPort = source.getBoundPort();
        expect(typeof boundPort).toBe('number');
        const url = `http://127.0.0.1:${boundPort}/webhooks/github`;

        const validPayload = {
          action: 'closed',
          repository: { full_name: 'acme/app' },
          pull_request: {
            number: 101,
            merged: true,
            merge_commit_sha: 'abc1234',
            head: { ref: 'fix/#42' },
            base: { ref: 'main' },
          },
        };
        const validRaw = JSON.stringify(validPayload);
        const validSig = `sha256=${createHmac('sha256', secret).update(validRaw).digest('hex')}`;

        const badSigRes = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': 'sha256=deadbeef',
          },
          body: validRaw,
        });
        expect(badSigRes.status).toBe(401);
        expect(receivedEvents).toHaveLength(0);

        const wrongRepoPayload = {
          ...validPayload,
          repository: { full_name: 'other/repo' },
        };
        const wrongRepoRaw = JSON.stringify(wrongRepoPayload);
        const wrongRepoSig = `sha256=${createHmac('sha256', secret).update(wrongRepoRaw).digest('hex')}`;
        const wrongRepoRes = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': wrongRepoSig,
          },
          body: wrongRepoRaw,
        });
        expect(wrongRepoRes.status).toBe(202);
        expect(receivedEvents).toHaveLength(0);

        const wrongActionPayload = {
          ...validPayload,
          action: 'opened',
        };
        const wrongActionRaw = JSON.stringify(wrongActionPayload);
        const wrongActionSig = `sha256=${createHmac('sha256', secret).update(wrongActionRaw).digest('hex')}`;
        const wrongActionRes = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': wrongActionSig,
          },
          body: wrongActionRaw,
        });
        expect(wrongActionRes.status).toBe(202);
        expect(receivedEvents).toHaveLength(0);

        const okRes = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
            'X-Hub-Signature-256': validSig,
          },
          body: validRaw,
        });
        expect(okRes.status).toBe(200);
        expect(receivedEvents).toEqual([validPayload]);
      } finally {
        await subscription.close();
      }
    });
  });

  describe('github.createOrUpdatePr builder and step executor', () => {
    it('creates a new PR when no open PR exists and updates an existing open PR when found', async () => {
      const prInputSchema = z.object({
        ref: z.string(),
        title: z.string(),
        summary: z.string(),
        targetBase: z.string(),
      });
      const prOutputSchema = z.object({
        number: z.number(),
        html_url: z.string(),
      });

      const prStepNode = github
        .createOrUpdatePr('open-or-update-pr', {
          repo: 'acme/app',
          token: H.env('GITHUB_TOKEN'),
          branch: (item: z.infer<typeof prInputSchema>) => `fix/${item.ref}`,
          baseBranch: (item: z.infer<typeof prInputSchema>) => item.targetBase,
          title: (item: z.infer<typeof prInputSchema>) => item.title,
          body: (item: z.infer<typeof prInputSchema>) => item.summary,
        })
        .input(prInputSchema)
        .output(prOutputSchema)
        .toAST();

      expect(prStepNode.type).toBe('github:create-or-update-pr');
      expect(prStepNode.id).toBe('open-or-update-pr');

      const transport = new RecordedGithubHttpTransport();
      const ctx = createTestStepContext({ GITHUB_TOKEN: 'ghp_pr_token' }, transport);
      const stepExecutor = ctx.registry.steps['github:create-or-update-pr'];
      if (stepExecutor === undefined) {
        throw new Error('Expected github:create-or-update-pr step executor to be registered.');
      }

      transport.registerResponse(
        'GET',
        '/repos/acme/app/pulls?state=open&head=acme%3Afix%2F%2342',
        [],
      );
      transport.registerResponse('POST', '/repos/acme/app/pulls', {
        number: 77,
        html_url: 'https://github.com/acme/app/pull/77',
      });

      const created = await stepExecutor(
        prStepNode,
        {
          ref: '#42',
          title: 'Fix #42 checkout race',
          summary: 'Resolves #42 cleanly.',
          targetBase: 'main',
        },
        ctx,
      );
      expect(created).toEqual({
        number: 77,
        html_url: 'https://github.com/acme/app/pull/77',
      });

      transport.registerResponse(
        'GET',
        '/repos/acme/app/pulls?state=open&head=acme%3Afix%2F%2342',
        [{ number: 77, html_url: 'https://github.com/acme/app/pull/77' }],
      );
      transport.registerResponse('PATCH', '/repos/acme/app/pulls/77', {
        number: 77,
        html_url: 'https://github.com/acme/app/pull/77',
      });

      const updated = await stepExecutor(
        prStepNode,
        {
          ref: '#42',
          title: 'Fix #42 checkout race (v2)',
          summary: 'Updated PR description.',
          targetBase: 'fix/#41',
        },
        ctx,
      );
      expect(updated).toEqual({
        number: 77,
        html_url: 'https://github.com/acme/app/pull/77',
      });
      expect(transport.calls[3]).toEqual({
        method: 'PATCH',
        path: '/repos/acme/app/pulls/77',
        token: 'ghp_pr_token',
        body: {
          title: 'Fix #42 checkout race (v2)',
          body: 'Updated PR description.',
          base: 'fix/#41',
        },
      });
    });
  });
});
