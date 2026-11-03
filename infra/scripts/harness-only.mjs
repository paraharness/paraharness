#!/usr/bin/env node
/**
 * Is a pull request harness-only (CD-269, owner Q43 A, 8 Oct)? Every change reaches
 * main through a PR and the Mergify queue, harness edits included; a PR that touches
 * only the agents' tooling takes the fast lane: `checks` runs lint and the harness
 * tests, `gate` selects no e2e, `linear-issue` needs no issue id in the title.
 *
 *   node infra/scripts/harness-only.mjs <base> [<head>]
 *     exit 3 and the reason: harness-only, the fast lane; any other exit (0, or a
 *     crash): not, everything runs as for any PR
 *   node infra/scripts/harness-only.mjs --docs-only <compare.json
 *     reads a GitHub compare response on stdin; exit 3: docs-only (CD-436), every
 *     changed path, both sides of a rename, ends in `.md` or is `release/manifest.json`, and
 *     the list is neither empty nor truncated; any other exit: everything runs
 *
 * Harness-only: every file changed between the merge base of <base> and <head>, and
 * <head>, is under `.claude/` or is `CLAUDE.md`. Every other piece of work sits under
 * an epic, so a PR of tests, workflows or docs is not harness-only.
 * A diff that changes nothing is not. The git it asks is the one in the working
 * directory. No dependency: `pr-issue.yml` runs it before anything is installed.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const HARNESS_ONLY = 3;

export const isHarnessPath = (path) =>
  path.startsWith('.claude/') || path === 'CLAUDE.md';

export function harnessOnly(paths) {
  const other = paths.find((path) => !isHarnessPath(path));
  if (paths.length === 0) return { harness: false, why: 'no file changed: not harness-only, everything runs' };
  if (other !== undefined) return { harness: false, why: `${other} is not harness: everything runs` };
  return { harness: true, why: `harness-only (${paths.length} files under .claude/ or CLAUDE.md): the fast lane` };
}

const DOC = /\.md$/;
const RELEASE_RECORD = new Set(['release/CHANGELOG.md', 'release/manifest.json']);

export const DOCS_ONLY = 3;
export const COMPARE_FILE_LIMIT = 300;

export const docsOnly = (paths) => paths.length > 0 && paths.every((path) => DOC.test(path) || RELEASE_RECORD.has(path));

export function comparedPaths(compare) {
  const files = compare.files ?? [];
  if (files.length >= COMPARE_FILE_LIMIT) return [];
  return files.flatMap((file) => [file.filename, file.previous_filename].filter(Boolean));
}

/** The files changed between the merge base of `base` and `head`, and `head`. */
export function changedSinceMergeBase(base, head = 'HEAD', cwd = process.cwd()) {
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const mergeBase = git('merge-base', base, head).trim();
  return git('diff', '--name-only', '--no-renames', mergeBase, head).split('\n').filter(Boolean);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const [base, head = 'HEAD'] = process.argv.slice(2);
  if (base === '--docs-only') {
    const paths = comparedPaths(JSON.parse(readFileSync(0, 'utf8')));
    const docs = docsOnly(paths);
    process.stdout.write(docs ? `docs-only (${paths.length} Markdown files): nothing to lint, typecheck or test\n` : 'not docs-only: everything runs\n');
    process.exit(docs ? DOCS_ONLY : 0);
  }
  if (!base) {
    process.stderr.write('usage: harness-only.mjs <base> [<head>]\n');
    process.exit(2);
  }
  const { harness, why } = harnessOnly(changedSinceMergeBase(base, head));
  process.stdout.write(`${why}\n`);
  process.exit(harness ? HARNESS_ONLY : 0);
}
