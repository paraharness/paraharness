import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const LAST_MESSAGES_FILE = 'last-messages.md';
export const NOTE_FILE = 'grounding.json';
export const NOTE_ADVISED_CHARACTERS = (4000).toLocaleString('en-US');
const ROLE_NAME = /^[a-z][a-z-]*$/;

export function sessionFolder(sessionId) {
  const folder = path.join(process.env.CLAUDE_HARNESS_DIR || path.join(os.tmpdir(), 'claude-harness'), sessionId);
  mkdirSync(folder, { recursive: true });
  return folder;
}

export function lastMessagesPath(sessionId) {
  return path.join(sessionFolder(sessionId), LAST_MESSAGES_FILE);
}

export function notePath(sessionId) {
  return path.join(sessionFolder(sessionId), NOTE_FILE);
}

export function roleFile(root, role) {
  const name = role.toLowerCase();
  if (!ROLE_NAME.test(name)) return null;
  const candidates = [path.join(root, '.claude', 'agents', `${name}.md`), path.join(root, '.claude', 'skills', name, 'SKILL.md')];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

export async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

export function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

export function isEntryPoint(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
}
