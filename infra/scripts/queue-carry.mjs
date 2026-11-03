#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { readPlan } from './check-touched.mjs';
import { CannotAsk, findEvidence, githubApi, repoFromUrl } from './gate-status.mjs';

export const QUEUE_SENDER = 'mergify[bot]';
const GATE = fileURLToPath(new URL('./gate.sh', import.meta.url));

const short = (sha) => sha.slice(0, 7);
const decline = (reason) => ({ carried: false, reason });

const gitIn = (cwd) => (args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const isAncestor = (git, commit, of) => {
  try {
    git(['merge-base', '--is-ancestor', commit, of]);
    return true;
  } catch {
    return false;
  }
};

const cleanMergeTree = (git, ours, theirs) => {
  try {
    return git(['merge-tree', '--write-tree', ours, theirs]);
  } catch {
    return null;
  }
};

const planAgainst = (cwd, base) => {
  const text = execFileSync('bash', [GATE, '--plan', '--base', base], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const plan = readPlan(text);
  if (plan.lane !== 'full' && !text.split('\n').some((line) => line.startsWith('reach='))) throw new Error(`gate.sh --plan --base ${short(base)} named no reach`);
  return plan;
};

const passedChecks = async (api, git, sha) => {
  const evidence = await findEvidence({ api, sha, tree: git(['rev-parse', `${sha}^{tree}`]), need: ['checks'], parents: git(['rev-list', '--parents', '-n', '1', sha]).split(' ').slice(1) });
  return evidence.passed;
};

export const decide = async ({ sender, cwd, api }) => {
  if (sender !== QUEUE_SENDER) return decline(`not a merge-queue update (sent by ${sender || 'no one'})`);
  const git = gitIn(cwd);
  const [head, ...parents] = git(['rev-list', '--parents', '-n', '1', 'HEAD']).split(' ');
  if (parents.length !== 2) return decline(`${short(head)} is not a merge of main into the pull request`);
  const [previous, main] = parents;
  if (!isAncestor(git, main, 'origin/main')) return decline(`${short(head)}'s second parent ${short(main)} is not on main`);
  if (cleanMergeTree(git, previous, main) !== git(['rev-parse', 'HEAD^{tree}'])) return decline(`${short(head)} is not a clean merge of ${short(main)} into ${short(previous)}`);

  const pullRequest = planAgainst(cwd, main);
  if (pullRequest.lane === 'full') return decline('the pull request changes a global file');
  const delta = planAgainst(cwd, previous);
  if (delta.lane === 'full') return decline("main's delta changes a global file");
  const both = pullRequest.reach.filter((dir) => delta.reach.includes(dir));
  if (both.length > 0) return decline(`the pull request and main's delta both reach ${both.join(', ')}`);

  if (!(await passedChecks(api, git, previous))) return decline(`the pull request's previous head ${short(previous)} has no passed checks/tree`);
  const commits = git(['rev-list', main, `^${previous}`]).split('\n').filter(Boolean);
  for (const commit of commits) {
    if (!(await passedChecks(api, git, commit))) return decline(`main's ${short(commit)} in the delta has no passed checks/tree`);
  }
  return {
    carried: true,
    reason: `${short(previous)} passed, and so did main's ${commits.length} commit(s) since; the pull request reaches [${pullRequest.reach.join(' ')}], main's delta [${delta.reach.join(' ')}]`,
  };
};

export const run = async (argv, env, { fetchImpl = fetch, out = console.log, err = console.error, cwd = process.cwd() } = {}) => {
  const at = argv.indexOf('--sender');
  const sender = at >= 0 ? argv[at + 1] : undefined;
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  let decision;
  try {
    const repo = env.GITHUB_REPOSITORY || repoFromUrl(gitIn(cwd)(['remote', 'get-url', 'origin']));
    if (!token || !repo) throw new CannotAsk('no GitHub token or repository here');
    decision = await decide({ sender, cwd, api: githubApi({ token, repo, base: env.GITHUB_API_URL || undefined, fetchImpl }) });
  } catch (error) {
    decision = decline(`could not decide (${error.message.split('\n')[0]})`);
  }
  err(`queue-carry: ${decision.carried ? 'carried' : 'no carry'}: ${decision.reason}`);
  out(`carried=${decision.carried}`);
  return 0;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
