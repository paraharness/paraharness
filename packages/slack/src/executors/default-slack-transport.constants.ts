import type { ControlPlaneHandle, HarnessRuntimeController } from '@harness-dsl/core';
import type { SlackTransport } from './slack-transport.js';

/** Default `fetch`-backed Slack Web API and webhook transport. */
export const defaultSlackTransport: SlackTransport = Object.freeze<SlackTransport>({
  async postMessage(
    botToken: string,
    channel: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly ts: string }> {
    const response = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, ...payload }),
    });
    if (!response.ok) {
      throw new Error(`Slack chat.postMessage failed with HTTP ${response.status}.`);
    }
    const body = (await response.json()) as Readonly<Record<string, unknown>>;
    if (body['ok'] === false) {
      throw new Error(`Slack chat.postMessage error: ${String(body['error'] ?? 'unknown')}`);
    }
    return Object.freeze({ ts: typeof body['ts'] === 'string' ? body['ts'] : '0.0' });
  },

  async updateMessage(
    botToken: string,
    channel: string,
    payload: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    const response = await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${botToken}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ channel, ...payload }),
    });
    if (!response.ok) {
      throw new Error(`Slack chat.update failed with HTTP ${response.status}.`);
    }
    const body = (await response.json()) as Readonly<Record<string, unknown>>;
    if (body['ok'] === false) {
      throw new Error(`Slack chat.update error: ${String(body['error'] ?? 'unknown')}`);
    }
  },

  async postWebhook(webhookUrl: string, message: string): Promise<void> {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ text: message }),
    });
    if (!response.ok) {
      throw new Error(`Slack incoming webhook POST failed with HTTP ${response.status}.`);
    }
  },

  async connectSocketMode(
    _appToken: string,
    _controller: HarnessRuntimeController,
  ): Promise<ControlPlaneHandle> {
    return Object.freeze<ControlPlaneHandle>({
      async close(): Promise<void> {
        return undefined;
      },
    });
  },
});
