import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MESSAGE_COUNT } from './last-messages.mjs';
import { isEntryPoint, lastMessagesPath, notePath, parseLine, readStdin, roleFile } from './shared.mjs';

export const HOOK_OUTPUT_LIMIT = 10000;
const LESSONS_RELATIVE_PATH = path.join('.memory', 'LESSONS.md');
const PREFERENCES_RELATIVE_PATH = path.join('.memory', 'OWNER_PREFERENCES.md');
const READING_RELATIVE_PATH = path.join('.memory', 'READING.md');
const COMPACT_SOURCE = 'compact';
const LINE_BREAK = '\n';
const HARNESS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GUARD_LINE = 'You were compacted. Ground before doing anything; change nothing while grounding.';
const NO_NOTE_LINE = 'You were compacted and left no note.';
const CORRUPT = Symbol('corrupt');
const NOTE_HEADING = '## Note from yourself';
const LAST_LINE = 'Read every file your note lists, in its order.';
export const MENU_LINE = 'head: load the head skill; consultant: load the consultant skill; builder: read `.claude/agents/builder.md` whole as your prompt and run its first step; any other role: run your file\'s first step again.';

function lastMessagesLine(sessionId) {
  return `Last ${MESSAGE_COUNT} messages: ${lastMessagesPath(sessionId)}. Read them whole.`;
}

function readNote(file) {
  if (!existsSync(file)) return null;
  const stored = parseLine(readFileSync(file, 'utf8'));
  return typeof stored?.role === 'string' && typeof stored.note === 'string' ? stored : CORRUPT;
}

function requiredReading(memory) {
  const file = path.join(memory, READING_RELATIVE_PATH);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split(LINE_BREAK)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .map((line) => path.resolve(memory, line))
    .filter((listed) => existsSync(listed))
    .map((listed) => `${listed} (whole)`);
}

function requiredReadingLine(memory) {
  const files = requiredReading(memory);
  return files.length === 0 ? [] : [`Read whole, in order: ${files.join('; ')}.`];
}

function readingList(memory, { role }, sessionId) {
  const files = [
    roleFile(HARNESS_ROOT, role),
    path.join(memory, LESSONS_RELATIVE_PATH),
    path.join(memory, PREFERENCES_RELATIVE_PATH),
    path.join(memory, '.memory', 'lessons', `${role.toUpperCase()}.md`),
  ].filter((file) => file && existsSync(file));
  const lastMessages = `${lastMessagesPath(sessionId)} (the last ${MESSAGE_COUNT} messages)`;
  return [...files, ...requiredReading(memory), lastMessages].map((entry, index) => `${index + 1}. ${entry}`);
}

function groundingParts(memory, stored, sessionId) {
  return [GUARD_LINE, 'Read, in order:', ...readingList(memory, stored, sessionId), NOTE_HEADING, stored.note, LAST_LINE];
}

function memoryFilePart(relativePath, memory, roomLeft) {
  const name = path.basename(relativePath);
  const file = path.join(memory, relativePath);
  if (!existsSync(file)) {
    return `${name} not found at ${file}`;
  }
  const content = readFileSync(file, 'utf8').replace(/\n+$/, '');
  return content.length < roomLeft ? content : `${name} over the hook limit: read ${file}`;
}

function mainCheckout(project) {
  try {
    const commonDir = execFileSync('git', ['-C', project, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: 'pipe',
    }).trim();
    return path.dirname(commonDir);
  } catch {
    return project;
  }
}

function hasSessionId(input) {
  return typeof input.session_id === 'string' && input.session_id.length > 0;
}

function render(parts) {
  return parts.join(LINE_BREAK) + LINE_BREAK;
}

function compactHead(noteFile, stored) {
  return stored === CORRUPT ? [`You were compacted and your note at ${noteFile} is corrupt: read it as it stands.`] : [NO_NOTE_LINE];
}

function buildOutput(input) {
  const memory = mainCheckout(process.env.CLAUDE_PROJECT_DIR || input.cwd);
  const compacted = input.source === COMPACT_SOURCE && hasSessionId(input) && !input.agent_id;
  const noteFile = compacted ? notePath(input.session_id) : null;
  const stored = compacted ? readNote(noteFile) : null;
  if (stored && stored !== CORRUPT) return { text: render(groundingParts(memory, stored, input.session_id)), usedNote: noteFile };
  const head = compacted ? compactHead(noteFile, stored) : [];
  const tail = compacted ? [MENU_LINE, lastMessagesLine(input.session_id), ...requiredReadingLine(memory)] : [MENU_LINE];
  const lessons = memoryFilePart(LESSONS_RELATIVE_PATH, memory, HOOK_OUTPUT_LIMIT - render([...head, '', '', ...tail]).length);
  const preferences = memoryFilePart(PREFERENCES_RELATIVE_PATH, memory, HOOK_OUTPUT_LIMIT - render([...head, lessons, '', ...tail]).length);
  return { text: render([...head, lessons, preferences, ...tail]), usedNote: null };
}

async function main() {
  try {
    const { text, usedNote } = buildOutput(JSON.parse(await readStdin()));
    process.stdout.write(text);
    if (usedNote) rmSync(usedNote, { force: true });
  } catch (error) {
    process.stdout.write(`session hook failed: ${String(error.message).replace(/\s+/g, ' ')}${LINE_BREAK}`);
  }
  process.exitCode = 0;
}

if (isEntryPoint(import.meta.url)) {
  await main();
}
