import { H } from 'harness-dsl';
import type { AccountChoice } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const maxOne = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1') });
const maxTwo = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2') });
const maxThree = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3') });
const sharedAccounts = [maxOne, maxTwo, maxThree];

const sharedQuota = sqlite.quota('~/.harness/accounts.db');

const soonestExpiring = H.policy.account('soonest-expiring', (c: AccountChoice) =>
  c.accounts
    .filter(a => a.eligible && a.account.provider === c.model.provider)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity))[0]?.account ?? null);

const taste = H.memory('taste', 'owner');
const experience = H.memory('experience', 'fallible');

const bySpecificity = H.policy.recall('by-specificity', view =>
  view.items
    .filter(item => item.status === 'accepted')
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 15));

const ownerTaste = H.library('owner-taste', taste, jsonl.memory('~/.harness/taste.jsonl')).recall(bySpecificity);

const sonnet = claudeCode.model('claude-sonnet-4-5');

const queued = H.state('queued', 'pending');
const working = H.state('working', 'active');
const stalled = H.state('stalled', 'waiting');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const ticketLifecycle = H.lifecycle(queued, working, stalled, done, abandoned);

const Bug = H.kind('Bug')
  .data(z.object({ title: z.string(), description: z.string(), severity: z.enum(['low', 'high']) }))
  .states(ticketLifecycle, { initial: 'queued', afterFailure: 'stalled' });
const Feature = H.kind('Feature')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states(ticketLifecycle, { initial: 'queued', afterFailure: 'stalled' });

const projectExperience = H.library('project-a-experience', experience, jsonl.memory('project-a/.harness/experience.jsonl')).recall(bySpecificity);

const worktrees = git.worktree('project-a-worktrees', { repo: 'project-a', slots: 3 });
const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees).onCrash('rerun');

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Implement: ${i.title}\n${i.description}\nOpen deficits:\n${i.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute', 'ask']);
const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit the change for "${i.title}": ${i.summary}`)
  .intents(['read', 'execute']);

const builder = H.agent('builder', builderRole).model(sonnet).on(worktrees)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks))
  .recalls(projectExperience, ownerTaste)
  .onCrash('ask');
const auditor = H.agent('auditor', auditorRole).model(sonnet).on(worktrees)
  .recalls(projectExperience).records(projectExperience)
  .onCrash('ask');

const ticketFlow = H.flow('build-and-audit').for(Bug, Feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    await ctx.move('working');
    let deficits: string[] = [];
    for (let round = 0; round < ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title: ctx.unit.data.title, description: ctx.unit.data.description, deficits });
      if (!built.ok) return ctx.fail(built.error);
      const audit = await ctx.run(auditor, { title: ctx.unit.data.title, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail('build-and-audit rounds exhausted with deficits remaining');
  });

const severityFromLabels = (labels: readonly string[]): 'high' | 'low' => labels.includes('p1') ? 'high' : 'low';

const ticketStatuses = { queued: 'Todo', working: 'In Progress', stalled: 'Blocked', done: 'Done', abandoned: 'Canceled' };
const bugTracker = linear.tracker(Bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PROJ-A',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description, severity: severityFromLabels(issue.labels) }),
  statuses: ticketStatuses,
});
const featureTracker = linear.tracker(Feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PROJ-A',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: ticketStatuses,
});

const bugs = H.lane('bugs', Bug).handler(ticketFlow, { rounds: 3 }).suppliers(bugTracker, H.operator).store(bugTracker).wip(2);
const features = H.lane('features', Feature).handler(ticketFlow, { rounds: 5 }).suppliers(featureTracker, H.operator).store(featureTracker).wip(1);

const projectAPool = H.pool('project-a-subscriptions', [
  { account: maxOne, share: 0.6 },
  { account: maxTwo, share: 0.6 },
  { account: maxThree, share: 0.6 },
], soonestExpiring);

const bugsBeforeFeatures = H.policy.scheduler('bugs-before-features', v => ({
  start: [...v.pending].sort((a, b) => (a.kind === 'Bug' ? 0 : 1) - (b.kind === 'Bug' ? 0 : 1) || b.waitedMs - a.waitedMs),
}));

const supervisorGrants = [
  H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory,
  H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares,
];

export const projectA = H.harness('project-a')
  .ledger(sqlite.ledger('project-a/.harness/ledger.db', { quota: sharedQuota }))
  .lanes(bugs, features)
  .pools(projectAPool)
  .scheduler(bugsBeforeFeatures)
  .clients(
    claudeCode.supervisor({ grants: supervisorGrants }),
    http.control({ port: 7101, token: H.env('PROJECT_A_CONTROL_TOKEN'), grants: supervisorGrants }),
  )
  .observers(markdown.board('project-a/BOARD.md'), markdown.telemetry('project-a/TELEMETRY.md'));

const draftPage = H.state('draft', 'pending');
const writing = H.state('writing', 'active');
const needsHelp = H.state('needs-help', 'waiting');
const published = H.state('published', 'terminal', 'success');

const DocPage = H.kind('DocPage')
  .data(z.object({ path: z.string(), title: z.string(), brief: z.string() }))
  .states([draftPage, writing, needsHelp, published], { initial: 'draft', afterFailure: 'needs-help' });

const docsExperience = H.library('docs-experience', experience, jsonl.memory('docs-site/.harness/experience.jsonl')).recall(bySpecificity);

const docsFolder = folder.files(DocPage, {
  dir: 'docs-site/docs',
  read: file => ({
    path: file.path,
    title: typeof file.frontmatter.title === 'string' ? file.frontmatter.title : file.path,
    brief: typeof file.frontmatter.brief === 'string' ? file.frontmatter.brief : '',
  }),
  write: (_data, state) => ({ status: state }),
});

const docsRunner = shell.local('docs-site', { slots: 2 });

const writerRole = H.role('writer')
  .input(z.object({ path: z.string(), title: z.string(), brief: z.string(), brokenLinks: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Write or revise ${i.path} ("${i.title}"): ${i.brief}\nFix these broken links:\n${i.brokenLinks.join('\n')}`)
  .intents(['read', 'edit']);

const writer = H.agent('writer', writerRole).model(sonnet).on(docsRunner).recalls(docsExperience, ownerTaste).onCrash('ask');

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .argv(i => ['link-check', '--json', i.path])
  .on(docsRunner)
  .onCrash('rerun');

const writePage = H.flow('write-page').for(DocPage).does(async ctx => {
  await ctx.move('writing');
  const page = ctx.unit.data;
  let broken: string[] = [];
  for (let pass = 0; pass < 3; pass++) {
    const written = await ctx.run(writer, { path: page.path, title: page.title, brief: page.brief, brokenLinks: broken });
    if (!written.ok) return ctx.fail(written.error);
    const links = await ctx.run(linkCheck, { path: page.path });
    if (!links.ok) return ctx.fail(links.error);
    if (links.value.broken.length === 0) return 'published';
    broken = links.value.broken;
  }
  return ctx.fail(`links still broken: ${broken.join(', ')}`);
});

const docPages = H.lane('doc-pages', DocPage).handler(writePage).suppliers(docsFolder).store(docsFolder).wip(2);

const docsPool = H.pool('docs-subscriptions', [
  { account: maxOne, share: 0.3 },
  { account: maxTwo, share: 0.3 },
  { account: maxThree, share: 0.3 },
], soonestExpiring);

const docsInOrder = H.policy.scheduler('docs-oldest-first', v => ({
  start: [...v.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

export const docsSite = H.harness('docs-site')
  .ledger(sqlite.ledger('docs-site/.harness/ledger.db', { quota: sharedQuota }))
  .lanes(docPages)
  .pools(docsPool)
  .scheduler(docsInOrder)
  .clients(
    claudeCode.supervisor({ grants: supervisorGrants }),
    http.control({ port: 7102, token: H.env('DOCS_CONTROL_TOKEN'), grants: supervisorGrants }),
  )
  .observers(markdown.board('docs-site/BOARD.md'), markdown.telemetry('docs-site/TELEMETRY.md'));

export const sharedApiFallback = anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY') });
export const sharedDefinitions = { accounts: sharedAccounts, quota: sharedQuota, taste: ownerTaste };
