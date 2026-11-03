import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HEX40 = /^[0-9a-f]{40}$/;
const ISSUE = /\b(?:CD|PAR)-\d+\b/g;
const MERGE_PR = /^Merge pull request #(\d+)\b/;
const SQUASH_PR = /\(#(\d+)\)\s*$/;

export class Refused extends Error {}
export class Usage extends Error {}

export const notesFrom = (commits) => {
  const prs = new Set();
  const issues = new Set();
  for (const { subject, body } of commits) {
    const pr = MERGE_PR.exec(subject) ?? SQUASH_PR.exec(subject);
    if (pr) prs.add(Number(pr[1]));
    for (const issue of `${subject}\n${body}`.match(ISSUE) ?? []) issues.add(issue);
  }
  const issueOrder = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  return { prs: [...prs].sort((a, b) => a - b), issues: [...issues].sort(issueOrder) };
};

export const gitIn =
  (cwd, env = process.env) =>
  (args, { allowFail = false } = {}) => {
    try {
      return execFileSync('git', args, { cwd, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    } catch (error) {
      if (allowFail) return null;
      throw new Refused(`git ${args[0]} failed: ${String(error.stderr ?? error.message).trim().split('\n').at(-1)}`);
    }
  };

const commitOf = (git, ref) => {
  const sha = git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  if (!sha || !HEX40.test(sha)) throw new Usage(`"${ref}" names no commit here`);
  return sha;
};

export const commitsBetween = (git, from, to) => {
  const range = from ? `${from}..${to}` : `${to}^!`;
  const raw = git(['log', '--format=%s%x00%b%x1e', range]) ?? '';
  return raw
    .split('\x1e')
    .map((record) => record.replace(/^\n/, ''))
    .filter((record) => record.includes('\x00'))
    .map((record) => {
      const [subject, body] = record.split('\x00');
      return { subject: subject.trim(), body: (body ?? '').trim() };
    });
};

export const parseArgs = (argv) => {
  const [verb, ...rest] = argv;
  const options = { verb };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (!flag.startsWith('--') || value === undefined) throw new Usage(`${flag} needs a value`);
    options[flag.slice(2)] = value;
    i += 1;
  }
  if (verb !== 'notes') throw new Usage('notes --sha <sha> [--from <ref>]');
  if (!options.sha) throw new Usage('notes needs --sha');
  return options;
};

export const run = (argv, { cwd = process.cwd(), env = process.env, out = console.log, err = console.error } = {}) => {
  try {
    const options = parseArgs(argv);
    const git = gitIn(cwd, env);
    const sha = commitOf(git, options.sha);
    const parent = git(['rev-parse', '--verify', '--quiet', `${sha}^1`], { allowFail: true });
    const from = options.from ? commitOf(git, options.from) : parent;
    const notes = notesFrom(commitsBetween(git, from, sha));
    out(`prs=${notes.prs.join(' ')}`);
    out(`issues=${notes.issues.join(' ')}`);
    return 0;
  } catch (error) {
    if (error instanceof Usage) {
      err(`release-version: usage: ${error.message}`);
      return 2;
    }
    if (error instanceof Refused) {
      err(`release-version: ${error.message}`);
      return 1;
    }
    throw error;
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exitCode = run(process.argv.slice(2));
}
