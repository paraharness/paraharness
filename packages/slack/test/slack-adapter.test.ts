import { describe, expect, it, vi } from 'vitest';
import {
  H,
  createExecutorRegistry,
  z,
  type HarnessRuntimeController,
  type RuntimeDriverContext,
} from '@harness-dsl/core';
import {
  SlackApproverAdapter,
  SlackNotifierAdapter,
  createSlackExecutors,
  slack,
} from '../src/index.js';
import { RecordedSlackTransport } from './fixtures/recorded-slack-transport.js';

function createTestDriverContext(
  env: Readonly<Record<string, string | undefined>>,
  transport: RecordedSlackTransport,
): RuntimeDriverContext {
  const registry = createExecutorRegistry(createSlackExecutors(transport));
  return {
    registry,
    resolveEnv(value) {
      if (typeof value === 'string') {
        return value;
      }
      return env[value.key];
    },
    getRunner() {
      throw new Error('RunnerDriver not used in slack tests.');
    },
  };
}

describe('@harness-dsl/slack adapter', () => {
  describe('slack.bot bidirectional HumanAdapter and ControlPlaneAdapter', () => {
    it('compiles SlackApproverNode with interactionMode bidirectional and dispatches notify()', async () => {
      const botNode = slack.bot({
        appToken: H.env('SLACK_APP_TOKEN'),
        botToken: H.env('SLACK_BOT_TOKEN'),
        channel: H.env('SLACK_CHANNEL_ID'),
      });

      expect(botNode).toEqual({
        type: 'slack:approver',
        interactionMode: 'bidirectional',
        appToken: { type: 'harness:env-ref', key: 'SLACK_APP_TOKEN' },
        botToken: { type: 'harness:env-ref', key: 'SLACK_BOT_TOKEN' },
        channel: { type: 'harness:env-ref', key: 'SLACK_CHANNEL_ID' },
      });
      expect(Object.isFrozen(botNode)).toBe(true);

      const transport = new RecordedSlackTransport();
      const ctx = createTestDriverContext(
        {
          SLACK_APP_TOKEN: 'xapp-1-token',
          SLACK_BOT_TOKEN: 'xoxb-bot-token',
          SLACK_CHANNEL_ID: 'C01234567',
        },
        transport,
      );
      const adapter = new SlackApproverAdapter(botNode, ctx, transport);

      await adapter.notify('High-leverage lesson promoted.');
      expect(transport.postedMessages).toEqual([
        {
          botToken: 'xoxb-bot-token',
          channel: 'C01234567',
          payload: {
            kind: 'notification',
            text: 'High-leverage lesson promoted.',
          },
          ts: '1000.1',
        },
      ]);
    });

    it('supports requestDecision with schema validation and periodic keepAliveSeconds heartbeats', async () => {
      vi.useFakeTimers();
      try {
        const botNode = slack.bot({
          appToken: 'xapp-literal',
          botToken: 'xoxb-literal',
          channel: 'C999',
        });
        const transport = new RecordedSlackTransport();
        const ctx = createTestDriverContext({}, transport);
        const adapter = new SlackApproverAdapter(botNode, ctx, transport);

        const responseSchema = z.object({
          approved: z.boolean(),
          note: z.string(),
        });

        const decisionPromise = adapter.requestDecision({
          runId: 'run-finance-1',
          requestId: 'req-refund-1',
          humanId: 'finance-controller',
          payload: { proposedJournalId: 'JRN-100', amountUsd: 2500 },
          responseSchema,
          keepAliveSeconds: 10,
        });

        await vi.advanceTimersByTimeAsync(25_000);

        expect(transport.postedMessages).toHaveLength(3);
        expect(transport.postedMessages[0]?.payload['kind']).toBe('decision-request');
        expect(transport.postedMessages[1]?.payload['kind']).toBe('heartbeat');
        expect(transport.postedMessages[1]?.payload['thread_ts']).toBe('1000.1');
        expect(transport.postedMessages[2]?.payload['kind']).toBe('heartbeat');

        expect(() =>
          adapter.submitDecision('run-finance-1', 'req-refund-1', {
            approved: 'not-a-boolean',
          }),
        ).toThrow();

        adapter.submitDecision('run-finance-1', 'req-refund-1', {
          approved: true,
          note: 'Verified against settlement batch.',
        });

        const decision = await decisionPromise;
        expect(decision).toEqual({
          approved: true,
          note: 'Verified against settlement batch.',
        });

        await vi.advanceTimersByTimeAsync(20_000);
        expect(transport.postedMessages).toHaveLength(3);
      } finally {
        vi.useRealTimers();
      }
    });

    it('cancels an active requestDecision via cancelDecision and updates the Slack message as superseded', async () => {
      const botNode = slack.bot({
        appToken: 'xapp-literal',
        botToken: 'xoxb-literal',
        channel: 'C999',
      });
      const transport = new RecordedSlackTransport();
      const ctx = createTestDriverContext({}, transport);
      const adapter = new SlackApproverAdapter(botNode, ctx, transport);

      const decisionPromise = adapter.requestDecision({
        runId: 'run-spec-1',
        requestId: 'req-parked-2',
        humanId: 'owner',
        payload: { question: 'Approve schema migration?' },
        responseSchema: z.object({ approved: z.boolean() }),
      });

      await Promise.resolve();
      await adapter.cancelDecision('run-spec-1', 'req-parked-2');

      await expect(decisionPromise).rejects.toThrow(
        "Slack decision request 'req-parked-2' for run 'run-spec-1' was cancelled and superseded.",
      );

      expect(transport.updatedMessages).toEqual([
        {
          botToken: 'xoxb-literal',
          channel: 'C999',
          payload: {
            ts: '1000.1',
            status: 'cancelled',
            runId: 'run-spec-1',
            requestId: 'req-parked-2',
            text: "[CANCELLED] Decision request 'req-parked-2' for run 'run-spec-1' was superseded.",
          },
        },
      ]);
    });

    it('connects Socket Mode control plane via start(controller) and emits external signals', async () => {
      const botNode = slack.bot({
        appToken: H.env('SLACK_APP_TOKEN'),
        botToken: 'xoxb-literal',
        channel: 'C999',
      });
      const transport = new RecordedSlackTransport();
      const ctx = createTestDriverContext({ SLACK_APP_TOKEN: 'xapp-ctrl-token' }, transport);
      const adapter = new SlackApproverAdapter(botNode, ctx, transport);

      const emittedSignals: Array<{ readonly signalId: string; readonly payload: unknown }> = [];
      const controller: HarnessRuntimeController = {
        async emitSignal(signalId, payload) {
          emittedSignals.push({ signalId, payload });
        },
        async getActiveRuns() {
          return [
            {
              runId: 'run-active-1',
              laneId: 'engineering',
              itemKey: '#42',
              status: 'RUNNING',
            },
          ];
        },
      };

      const handle = await adapter.start(controller);
      expect(transport.socketModeConnections).toEqual([
        { appToken: 'xapp-ctrl-token', closed: false },
      ]);

      await adapter.dispatchSignal('steer-signal', { key: '#42', note: 'Use optimistic locking' });
      expect(emittedSignals).toEqual([
        {
          signalId: 'steer-signal',
          payload: { key: '#42', note: 'Use optimistic locking' },
        },
      ]);

      const activeRuns = await adapter.getActiveRuns();
      expect(activeRuns).toEqual([
        {
          runId: 'run-active-1',
          laneId: 'engineering',
          itemKey: '#42',
          status: 'RUNNING',
        },
      ]);

      await handle.close();
      expect(transport.socketModeConnections).toEqual([
        { appToken: 'xapp-ctrl-token', closed: true },
      ]);
      await expect(adapter.dispatchSignal('steer-signal', {})).rejects.toThrow(
        'Slack Socket Mode control plane is not active',
      );
    });
  });

  describe('slack.webhook notify-only SlackNotifierAdapter', () => {
    it('compiles SlackNotifierNode with interactionMode notify-only, delivers webhook alerts, and rejects requestDecision', async () => {
      const notifierNode = slack.webhook(H.env('SLACK_WEBHOOK_URL'));
      expect(notifierNode).toEqual({
        type: 'slack:notifier',
        interactionMode: 'notify-only',
        webhookUrl: { type: 'harness:env-ref', key: 'SLACK_WEBHOOK_URL' },
      });

      const transport = new RecordedSlackTransport();
      const ctx = createTestDriverContext(
        { SLACK_WEBHOOK_URL: 'https://hooks.slack.com/services/T00/B00/X00' },
        transport,
      );
      const adapter = new SlackNotifierAdapter(notifierNode, ctx, transport);

      await adapter.notify('Build pipeline completed.');
      expect(transport.webhookMessages).toEqual([
        {
          webhookUrl: 'https://hooks.slack.com/services/T00/B00/X00',
          message: 'Build pipeline completed.',
        },
      ]);

      await expect(
        adapter.requestDecision({
          runId: 'run-1',
          requestId: 'req-1',
          humanId: 'alerts-channel',
          payload: {},
          responseSchema: z.unknown(),
        }),
      ).rejects.toThrow("interactionMode 'notify-only'");
    });
  });
});
