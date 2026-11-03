#!/usr/bin/env node
/**
 * The gate's result as GitHub holds it (CD-179, ARCHITECTURE §20).
 *
 *   node infra/scripts/gate-status.mjs check --sha <sha> [--tree <tree>] [--need checks,gate]
 *   node infra/scripts/gate-status.mjs post  --sha <sha> --tree <tree> --context gate|checks --state success|failure [--url <run>]
 *   node infra/scripts/gate-status.mjs adopt --sha <sha> [--need checks,gate]
 *   node infra/scripts/gate-status.mjs merged-pr --sha <sha> [--need checks]   (the merged PR that made <sha> passed; gate-main)
 *
 * The `checks` and `gate` workflows run on a pull request's MERGE commit
 * (`refs/pull/N/merge`), which lands on no branch, and GitHub files their check
 * runs under the PR's HEAD commit. Neither is main's tip after the merge. What is
 * the same across all three is the TREE, so the unit of evidence is the tree: each
 * workflow ends by posting a commit status on the PR head, context `gate/tree` or
 * `checks/tree`, whose description names the tree it tested and whether it
 * passed. `release` finds that evidence for main's tip and re-posts it on the tip
 * (`adopt`), so a promoted commit then carries its own.
 *
 * `check` asks: did the tree of <sha> (or --tree) pass every --need context? It
 * looks at the statuses of <sha>, of its parents, and of the heads of the pull
 * requests GitHub associates with <sha> (when that lookup is refused, as with a
 * token without Pull requests: read, the commit and its parents still count,
 * CD-204). For each context, the newest status that
 * names the tree decides; a pass followed by a failure on the same tree is a
 * failure. Statuses, not check runs: a fine-grained token can read commit statuses,
 * and the Checks API is closed to it.
 *
 * Only `gate-main` (on main's commit, after the merge, running no tests, owner
 * 5 Oct: it adopts the merged PR's passed result) posts `gate/tree`. So
 * `gate/tree` means the PR that made the commit passed its scope, and it is what
 * `release` and `deploy.yml` ask for.
 *
 * Token: GITHUB_TOKEN, GH_TOKEN, WB_GATE_TOKEN or EDGE_DEPLOY_GIT_TOKEN (read:
 * Commit statuses, Pull requests and Contents; `post` and `adopt` write statuses).
 * Repository: GITHUB_REPOSITORY, else origin's URL. API: GITHUB_API_URL.
 *
 * Exit: 0 passed (one line per context), 1 not passed, 2 cannot ask (no token,
 * unreachable, refused) or a usage error. It never prints the token.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const CONTEXTS = { gate: 'gate/tree', checks: 'checks/tree' };
export const EXIT_PASS = 0;
export const EXIT_MISSING = 1;
export const EXIT_CANNOT_ASK = 2;

const HEX40 = /^[0-9a-f]{40}$/;
const DESCRIPTION = /^tree ([0-9a-f]{40}) (passed|failed)\b/;

export class CannotAsk extends Error {}

export const describeTree = (tree, state) => `tree ${tree} ${state === 'success' ? 'passed' : 'failed'}`;

export const treeOf = (status) => {
  const match = DESCRIPTION.exec(status.description ?? '');
  return match ? match[1] : null;
};

export const verdict = (statuses, context, tree) => {
  const naming = statuses
    .filter((status) => status.context === context && treeOf(status) === tree)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const newest = naming[0];
  if (!newest) return { passed: false, reason: 'none' };
  return { passed: newest.state === 'success', reason: newest.state, status: newest };
};

export const repoFromUrl = (url) => {
  const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url.trim());
  return match ? match[1] : null;
};

export const parseArgs = (argv) => {
  const [verb, ...rest] = argv;
  const options = { verb, need: ['checks', 'gate'] };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flag.startsWith('--') || value === undefined) throw new CannotAsk(`usage: ${flag} needs a value`);
    const key = flag.slice(2);
    if (key === 'need') options.need = value.split(',').filter(Boolean);
    else options[key] = value;
    i += 1;
  }
  if (!['check', 'post', 'adopt', 'merged-pr'].includes(verb)) throw new CannotAsk('usage: check | post | adopt | merged-pr (see the header)');
  if (!HEX40.test(options.sha ?? '')) throw new CannotAsk('usage: --sha needs a full 40-hex commit');
  if (options.tree !== undefined && !HEX40.test(options.tree)) throw new CannotAsk('usage: --tree needs a full 40-hex tree');
  for (const name of options.need) {
    if (!CONTEXTS[name]) throw new CannotAsk(`usage: unknown context "${name}" (checks, gate)`);
  }
  if (verb === 'post') {
    if (!CONTEXTS[options.context]) throw new CannotAsk('usage: post needs --context checks|gate');
    if (!['success', 'failure'].includes(options.state)) throw new CannotAsk('usage: post needs --state success|failure');
    if (!options.tree) throw new CannotAsk('usage: post needs --tree');
  }
  return options;
};

const gitOut = (args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
};

export const localParents = (sha) =>
  gitOut(['cat-file', '-p', sha])
    .split('\n\n')[0]
    .split('\n')
    .filter((line) => line.startsWith('parent '))
    .map((line) => line.slice('parent '.length));

export const localTree = (sha) => gitOut(['rev-parse', '--verify', '--quiet', `${sha}^{tree}`]);

export const PULLS_TRIES = 3;
export const RETRY_BACKOFF_MS = 1000;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const githubApi = ({ token, repo, base = 'https://api.github.com', fetchImpl = fetch, sleep = pause }) => {
  const send = async (method, path, body) => {
    try {
      return await fetchImpl(`${base.replace(/\/$/, '')}/repos/${repo}${path}`, {
        method,
        headers: {
          accept: 'application/vnd.github+json',
          authorization: `Bearer ${token}`,
          'x-github-api-version': '2022-11-28',
          ...(body ? { 'content-type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new CannotAsk(`GitHub did not answer (${error.name})`);
    }
  };
  const request = async (method, path, body, tries = 1) => {
    let response;
    for (let attempt = 1; ; attempt += 1) {
      response = await send(method, path, body);
      if (response.status < 500 || attempt >= tries) break;
      await sleep(RETRY_BACKOFF_MS * attempt);
    }
    if (response.status === 404 && method === 'GET') return [];
    if (!response.ok) throw new CannotAsk(`GitHub answered ${response.status} to ${method} ${path.split('?')[0]}`);
    return response.json();
  };
  const pulls = (sha) => request('GET', `/commits/${sha}/pulls?per_page=20`, undefined, PULLS_TRIES);
  return {
    statuses: (sha) => request('GET', `/commits/${sha}/statuses?per_page=100`),
    pulls,
    pullHeads: async (sha) => (await pulls(sha)).map((pull) => pull.head?.sha).filter(Boolean),
    post: (sha, status) => request('POST', `/statuses/${sha}`, status),
  };
};

export const newestOf = (statuses, context) =>
  statuses
    .filter((status) => status.context === context)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))[0];

const mergedPull = async ({ api, sha, parents }) => {
  try {
    return (await api.pulls(sha)).find((candidate) => candidate.merge_commit_sha === sha && candidate.head?.sha);
  } catch (error) {
    if (!(error instanceof CannotAsk) || parents.length !== 2) throw error;
    return { number: null, head: { sha: parents[1] } };
  }
};

export const mergedPrPassed = async ({ api, sha, need, parents = [] }) => {
  const pull = await mergedPull({ api, sha, parents });
  if (!pull) return { pull: null, results: [], passed: false };
  const statuses = await api.statuses(pull.head.sha);
  const results = need.map((name) => {
    const newest = newestOf(statuses, CONTEXTS[name]);
    return { name, context: CONTEXTS[name], passed: newest?.state === 'success', reason: newest?.state ?? 'none' };
  });
  return { pull, results, passed: results.every((result) => result.passed) };
};

export const findEvidence = async ({ api, sha, tree, need, parents = [] }) => {
  const candidates = [sha, ...parents];
  let pullsSkipped = null;
  try {
    for (const pullHead of await api.pullHeads(sha)) candidates.push(pullHead);
  } catch (error) {
    if (!(error instanceof CannotAsk)) throw error;
    pullsSkipped = error.message;
  }
  const unique = [...new Set(candidates.filter((candidate) => HEX40.test(candidate)))];
  const statuses = [];
  for (const candidate of unique) {
    for (const status of await api.statuses(candidate)) statuses.push({ ...status, on: candidate });
  }
  const results = need.map((name) => ({ name, context: CONTEXTS[name], ...verdict(statuses, CONTEXTS[name], tree) }));
  return { candidates: unique, results, passed: results.every((result) => result.passed), pullsSkipped };
};

const short = (value) => value.slice(0, 7);

export const run = async (argv, env, { fetchImpl = fetch, out = console.log, err = console.error } = {}) => {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err(`gate-status: ${error.message}`);
    return EXIT_CANNOT_ASK;
  }
  const token = env.GITHUB_TOKEN || env.GH_TOKEN || env.WB_GATE_TOKEN || env.EDGE_DEPLOY_GIT_TOKEN;
  if (!token) {
    err('gate-status: no GitHub token here (GITHUB_TOKEN, GH_TOKEN, WB_GATE_TOKEN or EDGE_DEPLOY_GIT_TOKEN), so the gate cannot be asked');
    return EXIT_CANNOT_ASK;
  }
  const repo = env.GITHUB_REPOSITORY || repoFromUrl(gitOut(['remote', 'get-url', 'origin']));
  if (!repo) {
    err('gate-status: no repository (GITHUB_REPOSITORY, or a github.com origin)');
    return EXIT_CANNOT_ASK;
  }
  const api = githubApi({ token, repo, base: env.GITHUB_API_URL || undefined, fetchImpl });
  const url = options.url || (env.GITHUB_RUN_ID ? `${env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${env.GITHUB_RUN_ID}` : undefined);

  try {
    if (options.verb === 'post') {
      await api.post(options.sha, {
        context: CONTEXTS[options.context],
        state: options.state,
        description: describeTree(options.tree, options.state),
        ...(url ? { target_url: url } : {}),
      });
      out(`gate-status: ${CONTEXTS[options.context]} ${options.state} for tree ${short(options.tree)} on ${short(options.sha)}`);
      return EXIT_PASS;
    }

    if (options.verb === 'merged-pr') {
      const need = argv.includes('--need') ? options.need : ['checks'];
      const found = await mergedPrPassed({ api, sha: options.sha, need, parents: localParents(options.sha) });
      if (!found.pull) {
        err(`gate-status: no merged pull request made ${short(options.sha)}`);
        return EXIT_MISSING;
      }
      for (const result of found.results) {
        (result.passed ? out : err)(`${result.context}: ${result.passed ? 'passed' : `newest is ${result.reason}`} on ${found.pull.number ? `#${found.pull.number}'s head` : 'its merged parent'} ${short(found.pull.head.sha)}`);
      }
      return found.passed ? EXIT_PASS : EXIT_MISSING;
    }

    const tree = options.tree || localTree(options.sha);
    if (!HEX40.test(tree)) {
      err(`gate-status: ${short(options.sha)} is not in this clone, so its tree is unknown; pass --tree`);
      return EXIT_CANNOT_ASK;
    }
    const evidence = await findEvidence({ api, sha: options.sha, tree, need: options.need, parents: localParents(options.sha) });
    if (evidence.pullsSkipped) {
      err(`gate-status: ${evidence.pullsSkipped}; looked at ${short(options.sha)} and its parents only`);
    }
    if (!evidence.passed) {
      for (const result of evidence.results.filter((r) => !r.passed)) {
        const why = result.reason === 'none' ? 'no status names this tree' : `its newest status is ${result.reason}`;
        err(`gate-status: ${result.context}: ${why} (tree ${short(tree)}; looked at ${evidence.candidates.map(short).join(', ')})`);
      }
      return EXIT_MISSING;
    }
    for (const result of evidence.results) {
      out(`${result.context}: tree ${short(tree)} passed on ${short(result.status.on)}${result.status.target_url ? ` (${result.status.target_url})` : ''}`);
    }
    if (options.verb === 'adopt') {
      for (const result of evidence.results.filter((r) => r.status.on !== options.sha)) {
        await api.post(options.sha, {
          context: result.context,
          state: 'success',
          description: describeTree(tree, 'success'),
          ...(result.status.target_url ? { target_url: result.status.target_url } : {}),
        });
        out(`gate-status: ${result.context} adopted onto ${short(options.sha)} from ${short(result.status.on)}`);
      }
    }
    return EXIT_PASS;
  } catch (error) {
    if (error instanceof CannotAsk) {
      err(`gate-status: ${error.message}`);
      return EXIT_CANNOT_ASK;
    }
    throw error;
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2), process.env);
}
