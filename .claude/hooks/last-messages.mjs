import { createReadStream, existsSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';

import { isEntryPoint, lastMessagesPath, parseLine, readStdin } from './shared.mjs';

export const MESSAGE_COUNT = 50;

const CONVERSATION_TYPES = new Set(['user', 'assistant']);
const SEND_TOOLS = { SendMessage: 'to', 'mcp__claude-code-remote__send_message': 'session_id' };

function readCount(argv) {
  const { values } = parseArgs({ args: argv, options: { count: { type: 'string' } }, strict: false });
  const count = Number.parseInt(values.count, 10);
  return Number.isInteger(count) && count > 0 ? count : MESSAGE_COUNT;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

function sendsOf(content, timestamp) {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => block?.type === 'tool_use' && Object.hasOwn(SEND_TOOLS, block.name) && typeof block.input?.message === 'string')
    .map((block) => ({ heading: `sent to ${block.input[SEND_TOOLS[block.name]]} ${timestamp}`, text: block.input.message }));
}

function toMessages(entry) {
  if (!entry || !CONVERSATION_TYPES.has(entry.type)) return [];
  if (entry.isSidechain === true || entry.isMeta === true || entry.isCompactSummary === true) return [];
  const timestamp = entry.timestamp || '-';
  const text = textOf(entry.message?.content);
  const said = text.trim() === '' ? [] : [{ heading: `${entry.type} ${timestamp}`, text }];
  const sent = entry.type === 'assistant' ? sendsOf(entry.message?.content, timestamp) : [];
  return [...said, ...sent];
}

async function lastMessages(transcriptPath, count) {
  const messages = [];
  const lines = createInterface({ input: createReadStream(transcriptPath, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    messages.push(...toMessages(parseLine(line)));
    if (messages.length > count) messages.splice(0, messages.length - count);
  }
  return messages;
}

function render(messages) {
  return messages.map(({ heading, text }) => `## ${heading}\n${text}\n\n`).join('');
}

async function main() {
  const input = JSON.parse(await readStdin());
  const { session_id: sessionId, transcript_path: transcriptPath } = input;
  if (!sessionId || !transcriptPath || !existsSync(transcriptPath)) return;
  const messages = await lastMessages(transcriptPath, readCount(process.argv.slice(2)));
  writeFileSync(lastMessagesPath(sessionId), render(messages));
}

if (isEntryPoint(import.meta.url)) {
  try {
    await main();
  } catch {
  }
  process.exit(0);
}
