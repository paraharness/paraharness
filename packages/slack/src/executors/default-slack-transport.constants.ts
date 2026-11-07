import { SocketModeClient } from '@slack/socket-mode';
import { WebClient, type ChatPostMessageArguments, type ChatUpdateArguments } from '@slack/web-api';
import { IncomingWebhook } from '@slack/webhook';
import type { ControlPlaneHandle, HarnessRuntimeController } from '@harness-dsl/core';
import { handleSlackInteractiveEvent } from './internal/handle-slack-interactive-event.js';
import { handleSlackSlashCommandEvent } from './internal/handle-slack-slash-command-event.js';
import type { SlackMessageReceipt, SlackTransport } from './slack-transport.js';

/** Default Slack transport backed by `@slack/web-api`, `@slack/webhook`, and `@slack/socket-mode`. */
export const defaultSlackTransport: SlackTransport = Object.freeze<SlackTransport>({
  async postMessage(
    botToken: string,
    channel: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<SlackMessageReceipt> {
    const client = new WebClient(botToken);
    const text = typeof payload['text'] === 'string' ? payload['text'] : '';
    const args: ChatPostMessageArguments = {
      ...payload,
      channel,
      text,
    };
    const response = await client.chat.postMessage(args);
    if (response.ok === false) {
      throw new Error(`Slack chat.postMessage error: ${String(response.error ?? 'unknown')}`);
    }
    return Object.freeze<SlackMessageReceipt>({
      ts: typeof response.ts === 'string' ? response.ts : '0.0',
    });
  },

  async updateMessage(
    botToken: string,
    channel: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const client = new WebClient(botToken);
    const ts = typeof payload['ts'] === 'string' ? payload['ts'] : '0.0';
    const text = typeof payload['text'] === 'string' ? payload['text'] : '';
    const args: ChatUpdateArguments = {
      ...payload,
      channel,
      ts,
      text,
    };
    const response = await client.chat.update(args);
    if (response.ok === false) {
      throw new Error(`Slack chat.update error: ${String(response.error ?? 'unknown')}`);
    }
  },

  async postWebhook(webhookUrl: string, message: string): Promise<void> {
    const webhook = new IncomingWebhook(webhookUrl);
    await webhook.send({ text: message });
  },

  async connectSocketMode(
    appToken: string,
    controller: HarnessRuntimeController,
    onInteractiveAction?: (
      runId: string,
      requestId: string,
      responsePayload: unknown,
    ) => void,
  ): Promise<ControlPlaneHandle> {
    const socketClient = new SocketModeClient({ appToken });
    const onInteractive = (event: unknown): void => {
      void handleSlackInteractiveEvent(event, onInteractiveAction).catch(() => undefined);
    };
    const onSlashCommand = (event: unknown): void => {
      void handleSlackSlashCommandEvent(event, controller).catch(() => undefined);
    };
    socketClient.on('interactive', onInteractive);
    socketClient.on('slash_commands', onSlashCommand);
    try {
      await socketClient.start();
    } catch (err: unknown) {
      socketClient.removeListener('interactive', onInteractive);
      socketClient.removeListener('slash_commands', onSlashCommand);
      throw err;
    }
    return Object.freeze<ControlPlaneHandle>({
      async close(): Promise<void> {
        try {
          await socketClient.disconnect();
        } finally {
          socketClient.removeListener('interactive', onInteractive);
          socketClient.removeListener('slash_commands', onSlashCommand);
        }
      },
    });
  },
});
