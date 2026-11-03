import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOWED, REJECTED } from './cases.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function buildTree(configFiles, cases) {
  const tree = mkdtempSync(join(tmpdir(), 'lint-fixtures-'));
  writeFileSync(join(tree, 'package.json'), '{"name":"lint-fixtures","private":true}\n');
  symlinkSync(join(ROOT, 'node_modules'), join(tree, 'node_modules'));
  for (const file of configFiles) copyFileSync(join(ROOT, file), join(tree, file));
  for (const { path, source } of cases) {
    mkdirSync(dirname(join(tree, path)), { recursive: true });
    writeFileSync(join(tree, path), source);
  }
  return tree;
}

function run(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: 'utf8', maxBuffer: 64 << 20, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    if (typeof error.stdout === 'string' && error.stdout.length > 0) return error.stdout;
    throw error;
  }
}

const ruleOf = (code) => (/\(([^)]+)\)$/.exec(code)?.[1] ?? code).split('/').pop();

function lintCases(cases) {
  const tree = buildTree(['.oxlintrc.json'], cases);
  try {
    const output = run(join(ROOT, 'node_modules/.bin/oxlint'), ['-c', '.oxlintrc.json', '-f', 'json', '.'], tree);
    return JSON.parse(output).diagnostics.map((d) => ({
      file: d.filename,
      rule: ruleOf(d.code),
      message: `${d.message} ${d.help ?? ''}`,
    }));
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

export function lintFixtures() {
  return lintCases([...REJECTED, ...ALLOWED]);
}

export function lintSource(path, source) {
  return lintCases([{ path, source }]).map((d) => d.message);
}

export function judge(diagnostics) {
  const failures = [];
  const forFile = (path) => diagnostics.filter((d) => d.file === path);
  for (const c of REJECTED) {
    const found = forFile(c.path).filter(
      (d) => d.rule === c.rule && (c.message === undefined || d.message.includes(c.message)),
    );
    const want = c.count ?? 1;
    if (found.length < want) failures.push(`${c.path}: expected ${String(want)} x ${c.rule}${c.message ? ` "${c.message}"` : ''}, got ${String(found.length)}`);
    if (c.absent && forFile(c.path).some((d) => d.message.includes(c.absent))) failures.push(`${c.path}: must not report "${c.absent}"`);
  }
  for (const c of ALLOWED) {
    const found = forFile(c.path);
    if (found.length > 0) failures.push(`${c.path}: expected clean, got ${found.map((d) => d.rule).join(', ')}`);
  }
  return failures;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const failures = judge(lintFixtures());
  process.stdout.write(`oxlint: ${String(failures.length)} fixture failures\n${failures.join('\n')}\n`);
  process.exit(failures.length === 0 ? 0 : 1);
}
