import { SocketModeClient } from '@slack/socket-mode';
import { describe, expect, it, vi } from 'vitest';
import {
  P,
  createExecutorRegistry,
  z,
  type HarnessRuntimeController,
  type RuntimeDriverContext,
} from '@paraharness/core';
import {
  SlackApproverAdapter,
  SlackNotifierAdapter,
  createSlackExecutors,
  defaultSlackTransport,
  slack,
} from '../src/index.js';
import { handleSlackInteractiveEvent } from '../src/executors/internal/handle-slack-interactive-event.js';
import { handleSlackSlashCommandEvent } from '../src/executors/internal/handle-slack-slash-command-event.js';
import { RecordedSlackTransport } from './fixtures/recorded-slack-transport.js';

function createTestDriverContext(
  env: Readonly<Record<string, string | undefined>>,
  transport: RecordedSlackTransport,
): RuntimeDriverContext {
  const registry = createExecutorRegistry(createSlackExecutors(transport));
  return {
    registry,
    resolveEnv(value) {
      return typeof value === 'string' ? value : env[value.key];
    },
    getRunner() {
      throw new Error('RunnerDriver not used in slack tests.');
    },
  };
}

describe('@paraharness/slack adapter', () => {
  describe('slack.bot bidirectional HumanAdapter and ControlPlaneAdapter', () => {
    it('compiles SlackApproverNode with interactionMode bidirectional and dispatches notify()', async () => {
      const botNode = slack.bot({
        appToken: P.env('SLACK_APP_TOKEN'),
        botToken: P.env('SLACK_BOT_TOKEN'),
        channel: P.env('SLACK_CHANNEL_ID'),
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
        { SLACK_APP_TOKEN: 'xapp-1-token', SLACK_BOT_TOKEN: 'xoxb-bot-token', SLACK_CHANNEL_ID: 'C01234567' },
        transport,
      );
      const adapter = new SlackApproverAdapter(botNode, ctx, transport);
      await adapter.notify('High-leverage lesson promoted.');
      expect(transport.postedMessages).toEqual([
        {
          botToken: 'xoxb-bot-token',
          channel: 'C01234567',
          payload: { kind: 'notification', text: 'High-leverage lesson promoted.' },
          ts: '1000.1',
        },
      ]);
    });

    it('supports requestDecision with schema validation and periodic keepAliveSeconds heartbeats', async () => {
      vi.useFakeTimers();
      try {
        const botNode = slack.bot({ appToken: 'xapp-literal', botToken: 'xoxb-literal', channel: 'C999' });
        const transport = new RecordedSlackTransport();
        const ctx = createTestDriverContext({}, transport);
        const adapter = new SlackApproverAdapter(botNode, ctx, transport);
        const responseSchema = z.object({ approved: z.boolean(), note: z.string() });
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
        expect(transport.postedMessages[0]?.payload['metadata']).toMatchObject({
          requestId: 'req-refund-1',
          runId: 'run-finance-1',
          humanId: 'finance-controller',
        });
        expect(transport.postedMessages[0]?.payload['blocks']).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              type: 'actions',
              block_id: 'req-refund-1',
              elements: expect.arrayContaining([
                expect.objectContaining({ type: 'button', action_id: 'req-refund-1:approve' }),
                expect.objectContaining({ type: 'button', action_id: 'req-refund-1:reject' }),
              ]),
            }),
          ]),
        );
        expect(transport.postedMessages[1]?.payload['kind']).toBe('heartbeat');
        expect(transport.postedMessages[1]?.payload['thread_ts']).toBe('1000.1');
        expect(transport.postedMessages[2]?.payload['kind']).toBe('heartbeat');

        expect(() =>
          adapter.submitDecision('run-finance-1', 'req-refund-1', { approved: 'not-a-boolean' }),
        ).toThrow();

        adapter.submitDecision('run-finance-1', 'req-refund-1', {
          approved: true,
          note: 'Verified against settlement batch.',
        });

        await expect(decisionPromise).resolves.toEqual({
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
      const botNode = slack.bot({ appToken: 'xapp-literal', botToken: 'xoxb-literal', channel: 'C999' });
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

    it('aborts cleanly without hanging or leaking heartbeat timers when signal aborts while postMessage is in flight', async () => {
      vi.useFakeTimers();
      try {
        const botNode = slack.bot({ appToken: 'xapp-literal', botToken: 'xoxb-literal', channel: 'C999' });
        const transport = new RecordedSlackTransport();
        const ctx = createTestDriverContext({}, transport);
        const adapter = new SlackApproverAdapter(botNode, ctx, transport);
        const abortController = new AbortController();
        const originalPostMessage = transport.postMessage.bind(transport);
        vi.spyOn(transport, 'postMessage').mockImplementationOnce(async (botToken, channel, payload) => {
          abortController.abort(new Error('Aborted while postMessage in flight'));
          return originalPostMessage(botToken, channel, payload);
        });

        const decisionPromise = adapter.requestDecision({
          runId: 'run-abort-1',
          requestId: 'req-abort-inflight',
          humanId: 'owner',
          payload: { question: 'Approve rollout?' },
          responseSchema: z.object({ approved: z.boolean() }),
          keepAliveSeconds: 5,
          signal: abortController.signal,
        });
        await expect(decisionPromise).rejects.toThrow(
          "Slack decision request 'req-abort-inflight' for run 'run-abort-1' was aborted.",
        );
        expect(transport.updatedMessages).toEqual([
          {
            botToken: 'xoxb-literal',
            channel: 'C999',
            payload: {
              ts: '1000.1',
              status: 'aborted',
              text: "[ABORTED] Decision request 'req-abort-inflight' for run 'run-abort-1' was aborted.",
            },
          },
        ]);
        await vi.advanceTimersByTimeAsync(20_000);
        expect(transport.postedMessages).toHaveLength(1);
        expect(() =>
          adapter.submitDecision('run-abort-1', 'req-abort-inflight', { approved: true }),
        ).toThrow("No pending Slack decision request found for run 'run-abort-1', request 'req-abort-inflight'.");
      } finally {
        vi.useRealTimers();
      }
    });

    it('connects Socket Mode control plane via start(controller) and emits external signals', async () => {
      const botNode = slack.bot({
        appToken: P.env('SLACK_APP_TOKEN'),
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
          return [{ runId: 'run-active-1', laneId: 'engineering', itemKey: '#42', status: 'RUNNING' }];
        },
      };

      const handle = await adapter.start(controller);
      expect(transport.socketModeConnections).toEqual([
        expect.objectContaining({ appToken: 'xapp-ctrl-token', closed: false }),
      ]);
      expect(typeof transport.socketModeConnections[0]?.onInteractiveAction).toBe('function');

      const pendingInteractive = adapter.requestDecision({
        runId: 'run-active-1',
        requestId: 'req-socket-1',
        humanId: 'owner',
        payload: { question: 'Approve via Socket Mode?' },
        responseSchema: z.object({ approved: z.boolean(), note: z.string() }),
      });
      await Promise.resolve();
      transport.socketModeConnections[0]?.onInteractiveAction?.('', 'req-socket-1', {
        approved: true,
        note: 'Approved via interactive Socket Mode action',
      });
      await expect(pendingInteractive).resolves.toEqual({
        approved: true,
        note: 'Approved via interactive Socket Mode action',
      });

      await adapter.dispatchSignal('steer-signal', { key: '#42', note: 'Use optimistic locking' });
      expect(emittedSignals).toEqual([
        { signalId: 'steer-signal', payload: { key: '#42', note: 'Use optimistic locking' } },
      ]);

      const activeRuns = await adapter.getActiveRuns();
      expect(activeRuns).toEqual([
        { runId: 'run-active-1', laneId: 'engineering', itemKey: '#42', status: 'RUNNING' },
      ]);

      let acked = 0;
      const routedActions: Array<{ runId: string; requestId: string; payload: unknown }> = [];
      const ackFn = async (): Promise<void> => {
        acked += 1;
      };
      await handleSlackInteractiveEvent(
        {
          ack: ackFn,
          body: {
            actions: [{ block_id: 'req-block-1', value: JSON.stringify({ runId: 'run-active-1', requestId: 'req-block-1', approved: true, note: 'ok' }) }],
          },
        },
        (runId, requestId, payload) => {
          routedActions.push({ runId, requestId, payload });
        },
      );
      await handleSlackSlashCommandEvent(
        { ack: ackFn, body: { text: JSON.stringify({ signalId: 'slash-sig', payload: { item: '#42' } }) } },
        controller,
      );
      expect(acked).toBe(2);
      expect(routedActions).toHaveLength(1);
      expect(emittedSignals).toHaveLength(2);
      await handle.close();
      expect(transport.socketModeConnections).toEqual([expect.objectContaining({ appToken: 'xapp-ctrl-token', closed: true })]);
      await expect(adapter.dispatchSignal('steer-signal', {})).rejects.toThrow('Slack Socket Mode control plane is not active');
    });

    it('resolves runId and requestId from body.message.metadata and event_payload when omitted from actions[0].value (VF-3)', async () => {
      let ackCount = 0;
      const routed: Array<{ readonly runId: string; readonly requestId: string; readonly payload: unknown }> = [];
      const ack = async (): Promise<void> => {
        ackCount += 1;
      };

      await handleSlackInteractiveEvent(
        {
          ack,
          body: {
            actions: [{ value: JSON.stringify({ approved: true, note: 'From top-level metadata' }) }],
            message: {
              metadata: {
                runId: 'run-meta-top',
                requestId: 'req-meta-top',
              },
            },
          },
        },
        (runId, requestId, payload) => {
          routed.push({ runId, requestId, payload });
        },
      );

      await handleSlackInteractiveEvent(
        {
          ack,
          body: {
            actions: [{ value: JSON.stringify({ approved: false, note: 'From nested event_payload' }) }],
            message: {
              metadata: {
                event_type: 'harness_decision_request',
                event_payload: {
                  runId: 'run-meta-nested',
                  requestId: 'req-meta-nested',
                },
              },
            },
          },
        },
        (runId, requestId, payload) => {
          routed.push({ runId, requestId, payload });
        },
      );

      expect(ackCount).toBe(2);
      expect(routed).toEqual([
        {
          runId: 'run-meta-top',
          requestId: 'req-meta-top',
          payload: { approved: true, note: 'From top-level metadata' },
        },
        {
          runId: 'run-meta-nested',
          requestId: 'req-meta-nested',
          payload: { approved: false, note: 'From nested event_payload' },
        },
      ]);
    });

    it('shares the same SlackApproverAdapter instance between humanChannels and controlPlanes per RuntimeDriverContext (VF-1)', async () => {
      const botNode = slack.bot({ appToken: 'xapp-1', botToken: 'xoxb-1', channel: 'C111' });
      const transport = new RecordedSlackTransport();
      const executors = createSlackExecutors(transport);
      const drvCtx = createTestDriverContext({}, transport);
      const humanAdapter = executors.humanChannels?.['slack:approver']?.(botNode, drvCtx);
      const controlPlane = executors.controlPlanes?.['slack:approver']?.(botNode, drvCtx);
      if (humanAdapter === undefined || controlPlane === undefined) {
        throw new Error('Expected slack:approver humanChannel and controlPlane factories.');
      }
      expect(humanAdapter).toBe(controlPlane);
      const handle = await controlPlane.start({
        async emitSignal() {},
        async getActiveRuns() {
          return [];
        },
      });
      const decisionPromise = humanAdapter.requestDecision({
        runId: 'run-shared-1',
        requestId: 'req-shared-1',
        humanId: 'owner',
        payload: { question: 'Approve shared instance?' },
        responseSchema: z.object({ approved: z.boolean(), note: z.string() }),
      });
      await Promise.resolve();
      transport.socketModeConnections[0]?.onInteractiveAction?.('', 'req-shared-1', {
        approved: true,
        note: 'Resolved across shared instance',
      });
      await expect(decisionPromise).resolves.toEqual({
        approved: true,
        note: 'Resolved across shared instance',
      });
      await handle.close();
    });

    it('detaches SocketModeClient listeners on close() and suppresses unhandled rejections in fire-and-forget callbacks (VF-2)', async () => {
      let capturedClient: SocketModeClient | undefined;
      const startSpy = vi.spyOn(SocketModeClient.prototype, 'start').mockImplementation(async function (
        this: SocketModeClient,
      ) {
        capturedClient = this;
        return { ok: true };
      });
      const disconnectSpy = vi.spyOn(SocketModeClient.prototype, 'disconnect').mockResolvedValue(undefined);
      try {
        const controller: HarnessRuntimeController = {
          async emitSignal() {},
          async getActiveRuns() {
            return [];
          },
        };
        const handle = await defaultSlackTransport.connectSocketMode?.('xapp-socket-test', controller, () => {
          throw new Error('Stale or already-cancelled requestId');
        });
        expect(capturedClient?.listenerCount('interactive')).toBe(1);
        expect(capturedClient?.listenerCount('slash_commands')).toBe(1);
        capturedClient?.emit('interactive', {
          ack: async () => {},
          body: { actions: [{ block_id: 'req-stale', value: '{"approved":true}' }] },
        });
        await Promise.resolve();
        await handle?.close();
        expect(capturedClient?.listenerCount('interactive')).toBe(0);
        expect(capturedClient?.listenerCount('slash_commands')).toBe(0);
      } finally {
        startSpy.mockRestore();
        disconnectSpy.mockRestore();
      }
    });
  });

  describe('slack.webhook notify-only SlackNotifierAdapter', () => {
    it('compiles SlackNotifierNode with interactionMode notify-only, delivers webhook alerts, and rejects requestDecision', async () => {
      const notifierNode = slack.webhook(P.env('SLACK_WEBHOOK_URL'));
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
        { webhookUrl: 'https://hooks.slack.com/services/T00/B00/X00', message: 'Build pipeline completed.' },
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
