import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { TAIL_BYTES } from './context-watch.mjs';

const HOOK_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'context-watch.mjs');
const OVERSIZED_ENTRY_BYTES = 400 * 1024;
const WINDOW = '348000';
const NOTICE = '**Compaction at 315k; you are at 255k.** Write your note now, before any other tool call: `pnpm grounding --role <ROLE>`, with the note on stdin, under 4,000 characters. Say what you are doing, the decisions in force, the next step, and at the end the files to re-read in order. Then carry on with your work; nothing else changes, and 60k is left after the note.';

function tempDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'context-watch-test-'));
}

function userEntry(text) {
  return JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: text } });
}

function assistantEntry({ input = 32, cacheCreation = 1029, cacheRead = 0, output = 3510, sidechain = false }) {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: sidechain,
    message: {
      role: 'assistant',
      usage: {
        input_tokens: input,
        cache_creation_input_tokens: cacheCreation,
        cache_read_input_tokens: cacheRead,
        output_tokens: output,
      },
      content: [{ type: 'text', text: 'ok' }],
    },
  });
}

function writeTranscript(dir, lines) {
  const transcriptPath = path.join(dir, 'transcript.jsonl');
  writeFileSync(transcriptPath, lines.join('\n') + '\n');
  return transcriptPath;
}

function runHook({ harnessDir, transcriptPath, sessionId = 'session-a', eventName = 'UserPromptSubmit', extraInput = {}, env = {} }) {
  const input = { session_id: sessionId, transcript_path: transcriptPath, cwd: harnessDir, hook_event_name: eventName, ...extraInput };
  const childEnv = { ...process.env, CLAUDE_HARNESS_DIR: harnessDir, CLAUDE_CODE_AUTO_COMPACT_WINDOW: WINDOW, ...env };
  return spawnSync(process.execPath, [HOOK_PATH], { input: JSON.stringify(input), env: childEnv, encoding: 'utf8' });
}

function baseLines(lastUsage) {
  return [
    userEntry('hello'),
    assistantEntry({ cacheRead: 50000 }),
    'this line is not json',
    userEntry('next'),
    assistantEntry(lastUsage),
  ];
}

test('below the notice point prints nothing', () => {
  const dir = tempDir();
  const transcriptPath = writeTranscript(dir, baseLines({ input: 0, cacheCreation: 0, cacheRead: 100000 }));
  const result = runHook({ harnessDir: dir, transcriptPath });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('PostToolUse prints the notice as additionalContext JSON', () => {
  const dir = tempDir();
  const transcriptPath = writeTranscript(dir, baseLines({ input: 15000, cacheCreation: 0, cacheRead: 290000 }));
  const result = runHook({ harnessDir: dir, transcriptPath, eventName: 'PostToolUse' });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.equal(output.hookSpecificOutput.additionalContext, NOTICE);
});

test('a sidechain entry after the main entry does not count', () => {
  const dir = tempDir();
  const lines = [
    ...baseLines({ input: 0, cacheCreation: 0, cacheRead: 100000 }),
    assistantEntry({ input: 0, cacheCreation: 0, cacheRead: 900000, sidechain: true }),
  ];
  const transcriptPath = writeTranscript(dir, lines);
  const result = runHook({ harnessDir: dir, transcriptPath });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('a subagent has no watch', () => {
  const dir = tempDir();
  const transcriptPath = writeTranscript(dir, baseLines({ input: 15000, cacheCreation: 0, cacheRead: 290000 }));
  const result = runHook({ harnessDir: dir, transcriptPath, extraInput: { agent_id: 'agent-1', agent_type: 'builder' } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});

test('a session started as an agent has the watch', () => {
  const dir = tempDir();
  const transcriptPath = writeTranscript(dir, baseLines({ input: 15000, cacheCreation: 0, cacheRead: 290000 }));
  const result = runHook({ harnessDir: dir, transcriptPath, extraInput: { agent_type: 'builder' } });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), NOTICE);
});

test('the notice fires once at the notice point and again only after the context fell below it', () => {
  const dir = tempDir();
  const runAt = (cacheRead) => {
    const transcriptPath = writeTranscript(dir, baseLines({ input: 0, cacheCreation: 0, cacheRead, output: 0 }));
    const result = runHook({ harnessDir: dir, transcriptPath });
    assert.equal(result.status, 0);
    return result.stdout.trim();
  };
  assert.equal(runAt(254999), '');
  assert.equal(runAt(255000), NOTICE);
  assert.equal(runAt(255000), '');
  assert.equal(runAt(314000), '');
  assert.equal(runAt(100000), '');
  assert.equal(runAt(295000), NOTICE);
});

test('concurrent hook runs print the notice exactly once', async () => {
  const dir = tempDir();
  const transcriptPath = writeTranscript(dir, baseLines({ input: 0, cacheCreation: 0, cacheRead: 300000 }));
  const input = JSON.stringify({ session_id: 'session-a', transcript_path: transcriptPath, cwd: dir, hook_event_name: 'PostToolUse' });
  const env = { ...process.env, CLAUDE_HARNESS_DIR: dir, CLAUDE_CODE_AUTO_COMPACT_WINDOW: WINDOW };
  const runOnce = () =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [HOOK_PATH], { env });
      let stdout = '';
      child.stdout.on('data', (chunk) => {
        stdout += chunk;
      });
      child.on('close', () => resolve(stdout));
      child.stdin.end(input);
    });
  const outputs = await Promise.all(Array.from({ length: 8 }, runOnce));
  assert.equal(outputs.filter((stdout) => stdout !== '').length, 1);
});

test('the notice point and its numbers follow the auto-compact window', () => {
  const rows = [
    { window: '200000', cacheRead: 106999, output: 0, head: '' },
    { window: '200000', cacheRead: 107000, output: 0, head: '**Compaction at 167k; you are at 107k.**' },
    { window: '200000', cacheRead: 103490, output: 3510, head: '**Compaction at 167k; you are at 107k.**' },
    { window: '', cacheRead: 900000, output: 0, head: '' },
  ];
  for (const { window, cacheRead, output, head } of rows) {
    const dir = tempDir();
    const transcriptPath = writeTranscript(dir, baseLines({ input: 0, cacheCreation: 0, cacheRead, output }));
    const result = runHook({ harnessDir: dir, transcriptPath, env: { CLAUDE_CODE_AUTO_COMPACT_WINDOW: window } });
    assert.equal(result.status, 0);
    assert.equal(result.stdout.trim().slice(0, head.length), head);
    assert.equal(result.stdout === '', head === '');
  }
});

test('a transcript larger than the tail still reads the last usage', () => {
  const dir = tempDir();
  const padding = [];
  let paddingBytes = 0;
  while (paddingBytes < TAIL_BYTES * 2) {
    const entry = assistantEntry({ input: 1, cacheCreation: 1, cacheRead: 1 });
    padding.push(userEntry('x'.repeat(500)), entry);
    paddingBytes += entry.length + 520;
  }
  const lines = [...padding, ...baseLines({ input: 15000, cacheCreation: 0, cacheRead: 290000 })];
  const transcriptPath = writeTranscript(dir, lines);
  const result = runHook({ harnessDir: dir, transcriptPath });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), NOTICE);
});

test('an entry larger than the tail after the last usage still reads that usage', () => {
  const dir = tempDir();
  assert.ok(OVERSIZED_ENTRY_BYTES > TAIL_BYTES);
  const lines = [...baseLines({ input: 15000, cacheCreation: 0, cacheRead: 290000 }), userEntry('x'.repeat(OVERSIZED_ENTRY_BYTES))];
  const transcriptPath = writeTranscript(dir, lines);
  const result = runHook({ harnessDir: dir, transcriptPath });
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), NOTICE);
});

test('a missing transcript prints nothing', () => {
  const dir = tempDir();
  const result = runHook({ harnessDir: dir, transcriptPath: path.join(dir, 'missing.jsonl') });
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '');
});
