import { relative } from 'node:path';

export const MAX_LINES = 40;
export const SHOWN_FAILURES = 8;
export const LINES_PER_FAILURE = 6;

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[a-zA-Z]`, 'g');

export function stripAnsi(text) {
  return String(text ?? '').replace(ANSI, '');
}

export function duration(ms) {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${String(seconds)}s`;
  return `${String(Math.floor(seconds / 60))}m${String(seconds % 60).padStart(2, '0')}s`;
}

const FRAME = /\(?((?:file:\/\/)?\/[^\s():]+):(\d+):(\d+)\)?/;

export function firstAppFrame(stack, root) {
  for (const line of stripAnsi(stack).split('\n')) {
    const match = FRAME.exec(line);
    if (match === null) continue;
    const file = (match[1] ?? '').replace(/^file:\/\//, '');
    if (file.includes('/node_modules/') || file.startsWith('node:')) continue;
    if (root !== undefined && !file.startsWith(root)) continue;
    return `${root === undefined ? file : relative(root, file)}:${match[2] ?? '?'}`;
  }
  return null;
}

const NOISE = [
  /^\s*at /,
  /^\s*Call log:/,
  /^\s*-\s+(waiting for|navigated to|attempting|element is|retrying|scrolling|done scrolling|performing| {2}-)/,
  /^\s*\d+ × /,
  /^\s*[-+] (Expected|Received)\b/,
  /^\s*[-+]?\s*(Array \[|Object \{|\]|\}),?\s*$/,
  /^\s*$/,
];

export function messageLines(message, limit = LINES_PER_FAILURE) {
  const raw = stripAnsi(message)
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''));
  const resolved = raw.filter((line) => /^\s*-\s+locator resolved to /.test(line));
  const lastResolved = resolved[resolved.length - 1];
  const lines = raw.filter(
    (line) =>
      !NOISE.some((pattern) => pattern.test(line)) &&
      (!/^\s*-\s+locator resolved to /.test(line) || line === lastResolved),
  );
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit - 1), `… ${String(lines.length - limit + 1)} more line(s)`];
}

export function countsLine(runner, counts, ms) {
  const parts = [`${String(counts.passed)} passed`];
  if (counts.failed > 0) parts.push(`${String(counts.failed)} failed`);
  if (counts.flaky > 0) parts.push(`${String(counts.flaky)} flaky`);
  if (counts.skipped > 0) parts.push(`${String(counts.skipped)} skipped`);
  if ((counts.errors ?? 0) > 0) parts.push(`${String(counts.errors)} unhandled errors`);
  if (counts.files !== undefined) parts.unshift(`${String(counts.files)} files`);
  return `${runner}: ${parts.join(', ')} (${duration(ms)})`;
}

export function failureBlock(failures, budget = MAX_LINES - 2) {
  const out = [];
  const shown = failures.slice(0, SHOWN_FAILURES);
  for (const failure of shown) {
    const block = [`✗ ${failure.title}${failure.where === null ? '' : `  ${failure.where}`}`, ...failure.lines.map((line) => `    ${line}`)];
    if (out.length + block.length > budget - 1) break;
    out.push(...block);
  }
  const printed = out.filter((line) => line.startsWith('✗ ')).length;
  const rest = failures.slice(printed);
  if (rest.length > 0) {
    out.push(`… and ${String(rest.length)} more, named without their messages:`);
    for (const failure of rest) out.push(`✗ ${failure.title}${failure.where === null ? '' : `  ${failure.where}`}`);
  }
  return out;
}
