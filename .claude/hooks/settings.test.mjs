import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const settings = JSON.parse(readFileSync(new URL('../settings.json', import.meta.url), 'utf8'));
const PROJECT_VARIABLE = '$CLAUDE_PROJECT_DIR';
const HARNESS_HOOKS = ['session.mjs', 'last-messages.mjs', 'context-watch.mjs', 'proof-shots.mjs'];

function hookCommands(groups) {
  return groups.flatMap((group) => group.hooks.map((hook) => hook.command));
}

function harnessGroups(groups) {
  return groups.filter((group) => group.hooks.some((hook) => hook.command.includes('/.claude/hooks/')));
}

function singleHook(group) {
  assert.equal(group.hooks.length, 1);
  const [hook] = group.hooks;
  assert.deepEqual(Object.keys(hook).sort(), ['command', 'type']);
  assert.equal(hook.type, 'command');
  return hook.command;
}

function assertCommand(command, script) {
  assert.ok(command.startsWith('node '));
  assert.ok(command.includes(PROJECT_VARIABLE));
  assert.ok(command.endsWith(`/.claude/hooks/${script}`));
}

function assertOneUnmatchedHarnessGroup(groups, script) {
  const own = harnessGroups(groups);
  assert.equal(own.length, 1);
  assert.ok(!('matcher' in own[0]));
  assertCommand(singleHook(own[0]), script);
}

test('every hook under .claude/hooks is one of the harness mechanisms', () => {
  for (const command of Object.values(settings.hooks).flatMap(hookCommands)) {
    if (!command.includes('/.claude/hooks/')) continue;
    assert.ok(HARNESS_HOOKS.some((script) => command.endsWith(`/.claude/hooks/${script}`)), command);
  }
});

test('PreToolUse runs the proof-shot guard on Read, and no Stop hook belongs to the harness', () => {
  const own = harnessGroups(settings.hooks.PreToolUse);
  assert.equal(own.length, 1);
  assert.equal(own[0].matcher, 'Read');
  assertCommand(singleHook(own[0]), 'proof-shots.mjs');
  assert.equal(harnessGroups(settings.hooks.Stop ?? []).length, 0);
});

test('SessionStart runs the session hook always and last-messages on compact', () => {
  const groups = harnessGroups(settings.hooks.SessionStart);
  assert.equal(groups.length, 2);
  const unmatched = groups.filter((group) => !('matcher' in group));
  const compact = groups.filter((group) => group.matcher === 'compact');
  assert.equal(unmatched.length, 1);
  assert.equal(compact.length, 1);
  assertCommand(singleHook(unmatched[0]), 'session.mjs');
  assertCommand(singleHook(compact[0]), 'last-messages.mjs');
});

test('UserPromptSubmit runs the context watch', () => {
  assertOneUnmatchedHarnessGroup(settings.hooks.UserPromptSubmit, 'context-watch.mjs');
});

test('PostToolUse runs the context watch', () => {
  assertOneUnmatchedHarnessGroup(settings.hooks.PostToolUse, 'context-watch.mjs');
});
