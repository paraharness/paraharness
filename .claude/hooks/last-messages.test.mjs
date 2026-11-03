import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { MESSAGE_COUNT } from './last-messages.mjs';
import { LAST_MESSAGES_FILE } from './shared.mjs';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'last-messages.mjs');
const TOTAL_MESSAGES = 130;
const SESSION_ID = 'session-under-test';

function userText(n) {
  return { type: 'user', isSidechain: false, message: { role: 'user', content: `message ${n} from the user` }, timestamp: `2026-10-19T06:47:${String(n % 60).padStart(2, '0')}.000Z` };
}

function assistantText(n) {
  return { type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: `message ${n} from the assistant` }] }, timestamp: `2026-10-19T07:47:${String(n % 60).padStart(2, '0')}.000Z` };
}

function toolUseOnly(n) {
  return { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: `tool-${n}`, name: 'SecretToolName', input: { command: 'ls' } }] } };
}

function toolResultOnly(n) {
  return { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `tool-${n}`, content: 'SECRET TOOL RESULT OUTPUT' }] } };
}

const MIXED_MESSAGE_NUMBER = 100;
const MIXED_TIMESTAMP = '2026-10-19T08:00:00.000Z';

function mixedAssistant(n) {
  return {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'SECRET THINKING TEXT' },
        { type: 'text', text: `message ${n} from the assistant` },
        { type: 'tool_use', id: 'mixed-tool', name: 'MixedToolName', input: {} },
      ],
    },
    timestamp: MIXED_TIMESTAMP,
  };
}

function numberedMessage(n) {
  if (n === MIXED_MESSAGE_NUMBER) return mixedAssistant(n);
  return n % 2 === 1 ? userText(n) : assistantText(n);
}

function buildTranscriptLines() {
  const lines = [];
  for (let n = 1; n <= TOTAL_MESSAGES; n += 1) {
    lines.push(JSON.stringify(numberedMessage(n)));
    if (n % 10 === 0) {
      lines.push(JSON.stringify(toolUseOnly(n)));
      lines.push(JSON.stringify(toolResultOnly(n)));
    }
    if (n === 40) lines.push(JSON.stringify({ type: 'user', isSidechain: true, message: { role: 'user', content: 'SECRET SIDECHAIN TEXT' } }));
    if (n === 50) lines.push(JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'SECRET META TEXT' } }));
    if (n === 60) lines.push(JSON.stringify({ type: 'user', isCompactSummary: true, message: { content: 'SECRET SUMMARY TEXT' } }));
    if (n === 70) lines.push(JSON.stringify({ type: 'system', subtype: 'compact_boundary', content: 'SECRET BOUNDARY TEXT' }));
    if (n === 80) lines.push('this line is { not json');
  }
  return lines;
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'last-messages-test-'));
  const harnessDir = path.join(root, 'harness');
  const transcriptPath = path.join(root, 'transcript.jsonl');
  fs.writeFileSync(transcriptPath, buildTranscriptLines().join('\n') + '\n');
  return { root, harnessDir, transcriptPath };
}

function runHook({ harnessDir, transcriptPath, args = [] }) {
  const input = JSON.stringify({ session_id: SESSION_ID, transcript_path: transcriptPath, cwd: process.cwd(), hook_event_name: 'SessionStart', source: 'compact' });
  return spawnSync(process.execPath, [HOOK, ...args], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_HARNESS_DIR: harnessDir } });
}

function outputPath(harnessDir) {
  return path.join(harnessDir, SESSION_ID, LAST_MESSAGES_FILE);
}

function headings(content) {
  return content.split('\n').filter((line) => line.startsWith('## '));
}

function messageNumbers(content) {
  return [...content.matchAll(/^message (\d+) from the (user|assistant)$/gm)].map((match) => Number(match[1]));
}

test('a message without a timestamp gets a dash', () => {
  const { root, harnessDir } = setup();
  const transcriptPath = path.join(root, 'no-timestamp.jsonl');
  fs.writeFileSync(transcriptPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' } }) + '\n');
  runHook({ harnessDir, transcriptPath });
  assert.equal(fs.readFileSync(outputPath(harnessDir), 'utf8'), '## user -\nhello\n\n');
});

test('writes the last MESSAGE_COUNT messages in order with an empty stdout', () => {
  const first = TOTAL_MESSAGES - MESSAGE_COUNT + 1;
  const { harnessDir, transcriptPath } = setup();
  const result = runHook({ harnessDir, transcriptPath });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  const file = outputPath(harnessDir);
  assert.ok(fs.existsSync(file));
  const content = fs.readFileSync(file, 'utf8');
  assert.equal(headings(content).length, MESSAGE_COUNT);
  assert.deepEqual(messageNumbers(content), Array.from({ length: MESSAGE_COUNT }, (_, i) => i + first));
  assert.equal(headings(content)[0], `## ${numberedMessage(first).type} ${numberedMessage(first).timestamp}`);
  assert.equal(headings(content).at(-1), '## assistant 2026-10-19T07:47:10.000Z');
});

test('leaves out tool calls, tool results, thinking, sidechain, meta, summary and system entries', () => {
  const { harnessDir, transcriptPath } = setup();
  runHook({ harnessDir, transcriptPath });
  const content = fs.readFileSync(outputPath(harnessDir), 'utf8');
  for (const secret of ['SecretToolName', 'MixedToolName', 'SECRET TOOL RESULT OUTPUT', 'SECRET THINKING TEXT', 'SECRET SIDECHAIN TEXT', 'SECRET META TEXT', 'SECRET SUMMARY TEXT', 'SECRET BOUNDARY TEXT', 'not json']) {
    assert.ok(!content.includes(secret), `found ${secret}`);
  }
});

test('the mixed entry contributes only its text block', () => {
  const { harnessDir, transcriptPath } = setup();
  runHook({ harnessDir, transcriptPath });
  const content = fs.readFileSync(outputPath(harnessDir), 'utf8');
  assert.ok(content.includes(`## assistant ${MIXED_TIMESTAMP}\nmessage ${MIXED_MESSAGE_NUMBER} from the assistant\n\n## user`));
  assert.ok(!content.includes('SECRET THINKING TEXT'));
  assert.ok(!content.includes('MixedToolName'));
});

test('--count 5 writes exactly the last 5 messages', () => {
  const { harnessDir, transcriptPath } = setup();
  const result = runHook({ harnessDir, transcriptPath, args: ['--count', '5'] });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  const content = fs.readFileSync(outputPath(harnessDir), 'utf8');
  assert.equal(headings(content).length, 5);
  assert.deepEqual(messageNumbers(content), [126, 127, 128, 129, 130]);
});

test('a message from another session, a system notification and the session\'s own sends are kept', () => {
  const { root, harnessDir } = setup();
  const crossSession = '<cross-session-message from="uds:/tmp/x.sock" from-name="head">\nREADY TIC-000 builder done\n</cross-session-message>';
  const notification = '[SYSTEM NOTIFICATION - NOT USER INPUT]\nBackground agent builder completed';
  const transcriptPath = path.join(root, 'cross-session.jsonl');
  const entries = [
    { type: 'user', message: { role: 'user', content: crossSession }, timestamp: '2026-10-19T09:00:00.000Z' },
    { type: 'user', message: { role: 'user', content: notification }, timestamp: '2026-10-19T09:00:01.000Z' },
    {
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'send-1', name: 'SendMessage', input: { to: 'builder-7', summary: 's', message: 'ANSWER TIC-000 QUESTION cache' } },
          { type: 'tool_use', id: 'send-2', name: 'mcp__claude-code-remote__send_message', input: { session_id: 'session_01abc', message: 'FIX LIST TIC-000 round 2' } },
        ],
      },
      timestamp: '2026-10-19T09:00:02.000Z',
    },
  ];
  fs.writeFileSync(transcriptPath, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  const result = runHook({ harnessDir, transcriptPath });
  assert.equal(result.status, 0);
  const content = fs.readFileSync(outputPath(harnessDir), 'utf8');
  assert.equal(headings(content).length, 4);
  assert.ok(content.includes(`## user 2026-10-19T09:00:00.000Z\n${crossSession}\n`));
  assert.ok(content.includes(`## user 2026-10-19T09:00:01.000Z\n${notification}\n`));
  assert.ok(content.endsWith('## sent to builder-7 2026-10-19T09:00:02.000Z\nANSWER TIC-000 QUESTION cache\n\n## sent to session_01abc 2026-10-19T09:00:02.000Z\nFIX LIST TIC-000 round 2\n\n'));
});

test('a missing transcript writes nothing and exits 0 silently', () => {
  const { root, harnessDir } = setup();
  const result = runHook({ harnessDir, transcriptPath: path.join(root, 'missing.jsonl') });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
  assert.ok(!fs.existsSync(outputPath(harnessDir)));
});
