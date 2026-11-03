#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { CannotAsk, findEvidence, githubApi, localParents, localTree, repoFromUrl } from './gate-status.mjs';

export const GATE_MAIN = '.github/workflows/gate-main.yml';
export const WALK_LIMIT = 200;

const short = (sha) => sha.slice(0, 7);

export function pushPaths(text) {
  const keys = ['on:', '  push:', '    paths:'];
  const patterns = [];
  let depth = 0;
  for (const line of text.split('\n')) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    if (depth === keys.length) {
      const item = /^ {6}- (?:'([^']*)'|"([^"]*)"|([^'"#\s][^#]*?))\s*$/.exec(line);
      if (!item) break;
      patterns.push(item[1] ?? item[2] ?? item[3]);
      continue;
    }
    if (line === keys[depth]) depth += 1;
    else if (depth > 0 && line.length - line.trimStart().length < depth * 2) break;
  }
  if (patterns.length === 0) throw new Error(`${GATE_MAIN} holds no on.push.paths list this script can read`);
  return patterns;
}

const githubGlob = (pattern) =>
  new RegExp(
    `^${pattern
      .split(/(\*\*\/|\*\*|\*|\?)/)
      .map((part) => ({ '**/': '(?:.*/)?', '**': '.*', '*': '[^/]*', '?': '[^/]' })[part] ?? part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
      .join('')}$`,
  );

export const runsGateMain = (filter, path) =>
  filter.reduce((included, pattern) => (pattern.startsWith('!') ? (githubGlob(pattern.slice(1)).test(path) ? false : included) : githubGlob(pattern).test(path) ? true : included), false);

export async function resolveDeployable({ sha, walk, filter, hasEvidence, firstParent, changed, limit = WALK_LIMIT }) {
  const why = [];
  let at = sha;
  for (let step = 0; step < limit; step += 1) {
    if (await hasEvidence(at)) {
      why.push(`${short(at)} carries a passing gate/tree and checks/tree`);
      return { sha: at, why };
    }
    if (!walk) {
      why.push(`${short(at)} carries no passing gate/tree and checks/tree; a sha named is deployed as named or not at all`);
      return { sha: null, why };
    }
    const paths = changed(at);
    const released = paths.filter((path) => runsGateMain(filter, path));
    if (released.length > 0) {
      why.push(`${short(at)} carries no passing gate/tree and changes ${released.length} path(s) gate-main's filter releases (${released.slice(0, 5).join(', ')}${released.length > 5 ? ', …' : ''})`);
      return { sha: null, why };
    }
    const parent = firstParent(at);
    if (!parent) {
      why.push(`${short(at)} has no parent and no gate evidence`);
      return { sha: null, why };
    }
    why.push(`${short(at)} passed over: its ${paths.length} changed path(s) are all ones gate-main's filter skips, so gate-main never ran on it`);
    at = parent;
  }
  why.push(`no commit with gate evidence within ${limit} first-parent commits`);
  return { sha: null, why };
}

const git = (args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

async function main(argv, env) {
  const { values } = parseArgs({ args: argv, options: { sha: { type: 'string' }, walk: { type: 'boolean', default: false }, filter: { type: 'string', default: GATE_MAIN } } });
  if (!/^[0-9a-f]{40}$/.test(values.sha ?? '')) throw new CannotAsk('usage: --sha <40-hex> [--walk] [--filter <gate-main.yml>]');
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  if (!token) throw new CannotAsk('no GITHUB_TOKEN or GH_TOKEN, so the gate evidence cannot be read');
  const repo = env.GITHUB_REPOSITORY || repoFromUrl(git(['remote', 'get-url', 'origin']));
  if (!repo) throw new CannotAsk('no repository (GITHUB_REPOSITORY, or a github.com origin)');
  const api = githubApi({ token, repo, base: env.GITHUB_API_URL || undefined });
  const filter = pushPaths(readFileSync(values.filter, 'utf8'));
  return resolveDeployable({
    sha: values.sha,
    walk: values.walk,
    filter,
    hasEvidence: async (sha) => (await findEvidence({ api, sha, tree: localTree(sha), need: ['checks', 'gate'], parents: localParents(sha) })).passed,
    firstParent: (sha) => localParents(sha)[0] ?? null,
    changed: (sha) => {
      const parent = localParents(sha)[0];
      return parent ? git(['diff', '--name-only', '--no-renames', parent, sha]).split('\n').filter(Boolean) : [];
    },
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2), process.env).then(
    (result) => {
      for (const line of result.why) console.error(line);
      if (result.sha) console.log(result.sha);
      process.exit(result.sha ? 0 : 1);
    },
    (error) => {
      console.error(`deploy-ref: ${error.message}`);
      process.exit(2);
    },
  );
}
