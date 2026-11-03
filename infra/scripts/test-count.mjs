#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ownerPackage } from './check-touched.mjs';

const ts = createRequire(import.meta.url)('@typescript/typescript6');

const TEST_FILE = /\.(test|spec)\.[cm]?[jt]sx?$/;
const RUNNERS = new Set(['it', 'test']);
const MODIFIERS = new Set(['only', 'skip', 'todo', 'concurrent', 'sequential', 'fails', 'fixme']);
const TABLES = new Set(['each', 'for']);
const CONDITIONS = new Set(['skipIf', 'runIf']);
const SCRIPT_KINDS = { '.tsx': ts.ScriptKind.TSX, '.jsx': ts.ScriptKind.JSX, '.ts': ts.ScriptKind.TS, '.mts': ts.ScriptKind.TS, '.cts': ts.ScriptKind.TS };
const USAGE = 'usage: test-count.mjs [--base <commit>]';
const BUFFER = 256 * 1024 * 1024;

const chain = (node) => {
  const names = [];
  let at = node;
  while (ts.isPropertyAccessExpression(at)) {
    names.unshift(at.name.text);
    at = at.expression;
  }
  return ts.isIdentifier(at) && RUNNERS.has(at.text) ? names : null;
};

const modified = (names) => names !== null && names.every((name) => MODIFIERS.has(name));

const ending = (names, last) => names !== null && names.length > 0 && last.has(names.at(-1)) && modified(names.slice(0, -1));

const titled = (call) => {
  const body = call.arguments[1];
  return body !== undefined && !ts.isStringLiteralLike(body) && !ts.isTemplateExpression(body);
};

const definitions = (call, text) => {
  const title = call.arguments[0] ? text(call.arguments[0]) : '';
  const names = chain(call.expression);
  if (modified(names)) return names.includes('todo') || titled(call) ? [title] : [];
  const inner = call.expression;
  if (ts.isTaggedTemplateExpression(inner) && ending(chain(inner.tag), TABLES)) return [title];
  if (!ts.isCallExpression(inner)) return [];
  const outer = chain(inner.expression);
  if (ending(outer, CONDITIONS)) return [title];
  if (!ending(outer, TABLES)) return [];
  const table = inner.arguments[0];
  const literal = table && ts.isArrayLiteralExpression(table) && !table.elements.some(ts.isSpreadElement);
  return literal ? table.elements.map((row) => `${title}\0${text(row)}`) : [title];
};

export const testKeys = (text, path) => {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, SCRIPT_KINDS[extname(path)] ?? ts.ScriptKind.JS);
  const keys = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) keys.push(...definitions(node, (part) => part.getText(source)));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return keys;
};

const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: BUFFER });

const paths = (text) => text.split('\0').filter(Boolean);

const baseText = (root, base, path) => {
  const shown = spawnSync('git', ['show', `${base}:${path}`], { cwd: root, encoding: 'utf8', maxBuffer: BUFFER });
  return shown.status === 0 ? shown.stdout : null;
};

const tally = (keys) => keys.reduce((counts, key) => counts.set(key, (counts.get(key) ?? 0) + 1), new Map());

const surplus = (from, over) => [...from].reduce((sum, [key, count]) => sum + Math.max(0, count - (over.get(key) ?? 0)), 0);

export const testDelta = (root, ref) => {
  const base = git(root, 'merge-base', 'HEAD', ref).trim();
  const has = (path) => existsSync(join(root, path));
  const changed = [...new Set([...paths(git(root, 'diff', '--name-only', '--no-renames', '-z', base)), ...paths(git(root, 'ls-files', '--others', '--exclude-standard', '-z'))])];
  const dirs = [...new Set(changed.map((path) => ownerPackage(path, has)).filter(Boolean))].sort();
  return dirs.map((dir) => {
    const owned = (path) => TEST_FILE.test(path) && ownerPackage(path, has) === dir;
    const touched = new Set(changed.filter(owned));
    const current = paths(git(root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z', '--', dir)).filter((path) => owned(path) && has(path));
    const keysOf = (path, text) => (text === null ? [] : testKeys(text, path).map((key) => `${path}\0${key}`));
    const counts = new Map(current.map((path) => [path, keysOf(path, readFileSync(join(root, path), 'utf8'))]));
    const was = tally([...touched].flatMap((path) => keysOf(path, baseText(root, base, path))));
    const now = tally([...touched].flatMap((path) => counts.get(path) ?? []));
    const after = [...counts.values()].reduce((sum, keys) => sum + keys.length, 0);
    const kept = [...counts].filter(([path]) => !touched.has(path)).reduce((sum, [, keys]) => sum + keys.length, 0);
    const before = kept + [...was.values()].reduce((sum, count) => sum + count, 0);
    return { dir, before, after, added: surplus(now, was), removed: surplus(was, now) };
  });
};

const delta = ({ before, after, added, removed }) => `${before} -> ${after} (+${added}/-${removed})`;

export const deltaLines = (rows) => {
  if (rows.length === 0) return ['tests: no package touched'];
  const total = rows.reduce((sum, row) => ({ before: sum.before + row.before, after: sum.after + row.after, added: sum.added + row.added, removed: sum.removed + row.removed }), { before: 0, after: 0, added: 0, removed: 0 });
  return [...rows.map((row) => `tests: ${row.dir} ${delta(row)}`), `tests: total ${delta(total)}`];
};

const main = (argv) => {
  if (!(argv.length === 0 || (argv.length === 2 && argv[0] === '--base' && argv[1]))) {
    console.error(USAGE);
    return 2;
  }
  const root = git(process.cwd(), 'rev-parse', '--show-toplevel').trim();
  for (const line of deltaLines(testDelta(root, argv[1] ?? 'origin/main'))) console.log(line);
  return 0;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
