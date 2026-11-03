import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { isEntryPoint, NOTE_ADVISED_CHARACTERS, notePath, readStdin, roleFile } from '../hooks/shared.mjs';

export const NOTE_LIMIT = 5000;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const USAGE = 'wrong arguments: run pnpm grounding --role <ROLE> with the note on stdin';

function say(tag, text) {
  process.stdout.write(`${tag.padEnd(11)}  ${text}\n`);
}

function readRole(argv) {
  try {
    const { values, positionals } = parseArgs({ args: argv, options: { role: { type: 'string' } } });
    return values.role && positionals.length === 0 ? values.role : null;
  } catch {
    return null;
  }
}

async function store(argv) {
  const role = readRole(argv);
  if (!role) return { code: 2, line: USAGE };
  if (!roleFile(ROOT, role)) {
    return { code: 1, line: `unknown role ${role}: name your role, a lessons file such as BUILDER or a file under .claude/agents/ or .claude/skills/` };
  }
  const sessionId = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionId) return { code: 1, line: "no session id: run it from your session's Bash tool" };
  const note = (await readStdin()).trim();
  if (note === '') return { code: 1, line: 'no note on stdin: pipe the note in' };
  if (note.length > NOTE_LIMIT) {
    return { code: 1, line: `${note.length} characters, over ${NOTE_LIMIT}: cut the note under ${NOTE_ADVISED_CHARACTERS} and run again` };
  }
  const target = notePath(sessionId);
  writeFileSync(target, JSON.stringify({ role, note, time: new Date().toISOString() }));
  return { code: 0, stored: target };
}

if (isEntryPoint(import.meta.url)) {
  const result = await store(process.argv.slice(2));
  if (result.stored) say('STORED', result.stored);
  else say('NEXT', result.line);
  process.exitCode = result.code;
}
