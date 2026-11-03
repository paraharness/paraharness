import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { PROOF_BRANCH, proofSlugOf } from '../verify/proof-branch.mjs';

export class Refused extends Error {}

export const github = ({ token, repo, base = 'https://api.github.com', fetchImpl }) => {
  const get = async (path, what) => {
    let response;
    try {
      response = await fetchImpl(`${base.replace(/\/$/, '')}/repos/${repo}/${path}`, {
        headers: { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}), 'x-github-api-version': '2022-11-28' },
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new Refused(`GitHub did not answer for ${what} (${error.name})`);
    }
    if (!response.ok) throw new Refused(`GitHub answered ${response.status} for ${what}`);
    return response.json();
  };
  return {
    async pull(number) {
      const body = await get(`pulls/${number}`, `PR #${number}`);
      return { title: body.title ?? '', body: body.body ?? '', merged: Boolean(body.merged_at), headRef: body.head?.ref ?? '', headRepository: body.head?.repo?.full_name ?? '' };
    },
    async openOn(headRef) {
      const owner = repo.split('/')[0];
      return (await get(`pulls?state=open&per_page=1&head=${encodeURIComponent(`${owner}:${headRef}`)}`, `the open PRs on ${headRef}`)).length > 0;
    },
  };
};

export const run = async (argv, env, { fetchImpl = fetch, out = console.log, err = console.error } = {}) => {
  let prs;
  try {
    prs = parseArgs({ args: argv, options: { prs: { type: 'string' } } }).values.prs?.split(/\s+/).filter(Boolean).map(Number) ?? [];
  } catch (error) {
    err(`release-proofs: usage: --prs "<n> …": ${error.message}`);
    return 2;
  }
  if (prs.some((pr) => !Number.isInteger(pr) || pr < 1) || !env.GITHUB_REPOSITORY) {
    err('release-proofs: usage: --prs "<n> …", with GITHUB_REPOSITORY set');
    return 2;
  }
  const gh = github({ token: env.GITHUB_TOKEN, repo: env.GITHUB_REPOSITORY, base: env.GITHUB_API_URL || undefined, fetchImpl });
  const refused = (error, kept) => {
    if (!(error instanceof Refused)) throw error;
    err(`::warning::release-proofs: ${error.message}, so ${kept} stays`);
    return null;
  };
  const slugs = [];
  for (const pr of prs) {
    const pull = await gh.pull(pr).catch((error) => refused(error, `the proof branch of PR #${pr}`));
    const slug = pull?.merged && pull.headRepository === env.GITHUB_REPOSITORY ? proofSlugOf(pull.headRef) : null;
    if (slug === null) continue;
    const reused = await gh.openOn(pull.headRef).catch((error) => refused(error, `${PROOF_BRANCH}${slug}`));
    if (reused) err(`release-proofs: an open PR has the branch ${pull.headRef}, so ${PROOF_BRANCH}${slug} stays`);
    if (reused === false) slugs.push(slug);
  }
  out(`proofs=${slugs.join(' ')}`);
  return 0;
};

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = await run(process.argv.slice(2), process.env);
