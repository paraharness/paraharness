import type { HarnessRuntimeController } from '@metaharness/core';

/**
 * Acknowledges an inbound Slack Socket Mode slash command and forwards JSON signal payloads to `controller.emitSignal`.
 *
 * Parses `{ signalId, payload }` from `command.text` when present and invokes `controller.emitSignal`.
 *
 * @param {unknown}                  event      - Raw Socket Mode `'slash_commands'` event envelope.
 * @param {HarnessRuntimeController} controller - Active runtime controller.
 *
 * @returns {Promise<void>} Resolves once `ack()` and signal emission complete.
 */
export async function handleSlackSlashCommandEvent(
  event: unknown,
  controller: HarnessRuntimeController,
): Promise<void> {
  if (typeof event !== 'object' || event === null) {
    return;
  }
  const envelope = event as Readonly<Record<string, unknown>>;
  if (typeof envelope['ack'] === 'function') {
    await (envelope['ack'] as () => Promise<void>)();
  }
  const body =
    typeof envelope['body'] === 'object' && envelope['body'] !== null
      ? (envelope['body'] as Readonly<Record<string, unknown>>)
      : {};
  const text = typeof body['text'] === 'string' ? body['text'].trim() : '';
  if (!text.startsWith('{')) {
    return;
  }
  try {
    const parsed = JSON.parse(text) as Readonly<Record<string, unknown>>;
    if (typeof parsed['signalId'] === 'string') {
      await controller.emitSignal(parsed['signalId'], parsed['payload']);
    }
  } catch {
    return;
  }
}
