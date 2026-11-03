import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { NOTE_FILE } from '../hooks/shared.mjs';

import { NOTE_LIMIT } from './grounding.mjs';

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'grounding.mjs');
const SESSION_ID = 'session-abc';

function run(args, note, sessionId = SESSION_ID) {
  const harness = mkdtempSync(path.join(os.tmpdir(), 'grounding-test-'));
  const env = { ...process.env, CLAUDE_HARNESS_DIR: harness, CLAUDE_CODE_SESSION_ID: sessionId };
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { input: note, env, encoding: 'utf8' });
  return { ...result, notePath: path.join(harness, SESSION_ID, NOTE_FILE) };
}

test('stores the role, the note and the time in the session folder', () => {
  const { status, stdout, notePath } = run(['--role', 'BUILDER'], 'Doing X.\nNext: Y.\n');
  assert.equal(status, 0);
  assert.equal(stdout, `STORED       ${notePath}\n`);
  const stored = JSON.parse(readFileSync(notePath, 'utf8'));
  assert.equal(stored.role, 'BUILDER');
  assert.equal(stored.note, 'Doing X.\nNext: Y.');
  assert.ok(!Number.isNaN(Date.parse(stored.time)));
});

test('refuses and stores nothing', () => {
  const rows = [
    { args: ['--role', 'builder'], note: 'x'.repeat(NOTE_LIMIT + 1), status: 1, line: `NEXT         ${NOTE_LIMIT + 1} characters, over ${NOTE_LIMIT}: cut the note under 4,000 and run again` },
    { args: ['--role', 'shared'], note: 'n', status: 1, line: 'NEXT         unknown role shared: name your role, a lessons file such as BUILDER or a file under .claude/agents/ or .claude/skills/' },
    { args: ['--role', '../agents/builder'], note: 'n', status: 1, line: 'NEXT         unknown role ../agents/builder: name your role, a lessons file such as BUILDER or a file under .claude/agents/ or .claude/skills/' },
    { args: [], note: 'n', status: 2, line: 'NEXT         wrong arguments: run pnpm grounding --role <ROLE> with the note on stdin' },
    { args: ['--role', 'builder'], note: 'n', sessionId: '', status: 1, line: "NEXT         no session id: run it from your session's Bash tool" },
    { args: ['--role', 'builder'], note: ' \n', status: 1, line: 'NEXT         no note on stdin: pipe the note in' },
  ];
  for (const { args, note, sessionId, status, line } of rows) {
    const result = run(args, note, sessionId);
    assert.equal(result.status, status);
    assert.equal(result.stdout, `${line}\n`);
    assert.ok(!existsSync(result.notePath));
  }
});
