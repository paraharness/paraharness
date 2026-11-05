import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

const THRESHOLD_TOKENS = 700_000;
const TAIL_BYTES = 262_144;

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8');
}

function readRange(fd, start, end) {
  const buffer = Buffer.alloc(end - start);
  readSync(fd, buffer, 0, buffer.length, start);
  return buffer.toString('utf8');
}

function latestPlannerTokens(text) {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (!line) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === 'PLANNER_RESPONSE' && typeof entry.input_tokens === 'number') {
        return (
          (entry.input_tokens || 0) +
          (entry.cache_read_tokens || 0) +
          (entry.output_tokens || 0)
        );
      }
    } catch {
      continue;
    }
  }
  return null;
}

function getContextTokens(transcriptPath) {
  const fd = openSync(transcriptPath, 'r');
  try {
    const size = fstatSync(fd).size;
    for (let tail = TAIL_BYTES; ; tail *= 2) {
      const start = Math.max(0, size - tail);
      const tokens = latestPlannerTokens(readRange(fd, start, size));
      if (tokens != null || start === 0) return tokens;
    }
  } finally {
    closeSync(fd);
  }
}

async function main() {
  const raw = await readStdin();
  const payload = raw ? JSON.parse(raw) : {};
  const transcriptPath = payload.transcriptPath;
  if (!transcriptPath) {
    process.stdout.write('{}\n');
    return;
  }
  const tokens = getContextTokens(transcriptPath);
  if (tokens != null && tokens >= THRESHOLD_TOKENS) {
    process.stdout.write(
      JSON.stringify({
        injectSteps: [
          {
            systemMessage: {
              systemMessage: `CONTEXT_THRESHOLD_700K_REACHED (current=${tokens}). Execute PRE-COMPACTION HANDOFF from docs/LOOP.md immediately.`,
            },
          },
        ],
      }) + '\n',
    );
    return;
  }
  process.stdout.write('{}\n');
}

try {
  await main();
} catch {
  process.stdout.write('{}\n');
}
