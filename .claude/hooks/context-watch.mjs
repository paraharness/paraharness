import { closeSync, fstatSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isEntryPoint, NOTE_ADVISED_CHARACTERS, parseLine, readStdin, sessionFolder } from './shared.mjs';

export const TAIL_BYTES = 262144;
const NOTE_ROOM_TOKENS = 60000;
const OUTPUT_RESERVE_TOKENS = 20000;
const COMPACT_BUFFER_TOKENS = 13000;
const STATE_FILE = 'context-watch.json';
const POST_TOOL_USE = 'PostToolUse';

function readRange(fd, start, end) {
  const buffer = Buffer.alloc(end - start);
  readSync(fd, buffer, 0, buffer.length, start);
  return buffer.toString('utf8');
}

function isMainUsageEntry(entry) {
  return entry?.type === 'assistant' && entry.isSidechain !== true && entry.message?.usage != null;
}

function lastUsageContext(text) {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const entry = parseLine(lines[index]);
    if (!isMainUsageEntry(entry)) continue;
    const usage = entry.message.usage;
    return (
      (usage.input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0) +
      (usage.output_tokens || 0)
    );
  }
  return null;
}

function contextInUse(transcriptPath) {
  const fd = openSync(transcriptPath, 'r');
  try {
    const size = fstatSync(fd).size;
    for (let tailBytes = TAIL_BYTES; ; tailBytes *= 2) {
      const start = Math.max(0, size - tailBytes);
      const context = lastUsageContext(readRange(fd, start, size));
      if (context != null || start === 0) return context;
    }
  } finally {
    closeSync(fd);
  }
}

function compactionPoint(env) {
  const window = Number(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW);
  if (!Number.isInteger(window) || window <= 0) return null;
  return window - OUTPUT_RESERVE_TOKENS - COMPACT_BUFFER_TOKENS;
}

function thousands(tokens) {
  return `${Math.round(tokens / 1000)}k`;
}

function noticeText(compactAt) {
  return `**Compaction at ${thousands(compactAt)}; you are at ${thousands(compactAt - NOTE_ROOM_TOKENS)}.** Write your note now, before any other tool call: \`pnpm grounding --role <ROLE>\`, with the note on stdin, under ${NOTE_ADVISED_CHARACTERS} characters. Say what you are doing, the decisions in force, the next step, and at the end the files to re-read in order. Then carry on with your work; nothing else changes, and ${thousands(NOTE_ROOM_TOKENS)} is left after the note.`;
}

function formatOutput(eventName, notice) {
  if (eventName === POST_TOOL_USE) {
    return JSON.stringify({ hookSpecificOutput: { hookEventName: POST_TOOL_USE, additionalContext: notice } });
  }
  return notice;
}

async function main() {
  const input = JSON.parse(await readStdin());
  if (input.agent_id) return;
  const compactAt = compactionPoint(process.env);
  if (compactAt == null) return;
  const context = contextInUse(input.transcript_path);
  if (context == null) return;
  const statePath = path.join(sessionFolder(input.session_id), STATE_FILE);
  if (context < compactAt - NOTE_ROOM_TOKENS) {
    rmSync(statePath, { force: true });
    return;
  }
  try {
    writeFileSync(statePath, JSON.stringify({ compactAt }), { flag: 'wx' });
  } catch (error) {
    if (error.code === 'EEXIST') return;
    throw error;
  }
  process.stdout.write(formatOutput(input.hook_event_name, noticeText(compactAt)) + '\n');
}

if (isEntryPoint(import.meta.url)) {
  try {
    await main();
  } catch {
    process.exitCode = 0;
  }
}
