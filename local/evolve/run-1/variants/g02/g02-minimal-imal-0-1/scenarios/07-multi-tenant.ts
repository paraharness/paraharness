import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
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

const sharedQuota = { sharedQuota: '/srv/harness/shared/account-quota.db' };

const maxOne = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') });
const maxTwo = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN') });
const maxThree = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN') });
const apiFallback = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const usable = choice.accounts.filter(view => view.eligible && view.usedShare < view.share);
  const subscriptions = usable
    .filter(view => view.account.plan === 'subscription')
    .sort((x, y) => (x.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (y.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  const metered = usable.filter(view => view.account.plan === 'metered');
  const [first] = [...subscriptions, ...metered];
  return first ? first.account : null;
});

function subscriptionPool(name: string, share: number) {
  return H.pool(name, [
    { account: maxOne, share },
    { account: maxTwo, share },
    { account: maxThree, share },
    { account: apiFallback, share: 1 },
  ], soonestExpiringFirst);
}

const taste = H.memory('taste', 'owner');
const experience = H.memory('experience', 'fallible');
const ownerTaste = H.library('owner-taste', taste, jsonl.memory('/srv/harness/shared/taste.jsonl'));

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const todo = H.state('todo', 'pending');
const done = H.state('done', { terminal: 'success' });
const abandoned = H.state('abandoned', { terminal: 'failure' });

const bugSchema = z.object({ title: z.string(), description: z.string(), severity: z.enum(['high', 'normal']) });
type BugData = z.infer<typeof bugSchema>;

const Bug = H.kind('bug')
  .data(bugSchema)
  .states([todo, done, abandoned], 'todo')
  .failsTo('abandoned');

const Feature = H.kind('feature')
  .data(z.object({ title: z.string(), description: z.string(), epic: z.string() }))
  .states([todo, done, abandoned], 'todo')
  .failsTo('abandoned');

const productExperience = H.library('product-experience', experience, jsonl.memory('memory/product-experience.jsonl'));

const cheaperUntilItSlips = H.policy.model('cheaper-until-it-slips', choice => {
  const rate = choice.metrics.successRate({ kind: choice.kind, model: sonnet.name, days: 14 });
  if (rate.samples < 20 || rate.value === null) return sonnet;
  return rate.value < 0.85 ? opus : sonnet;
});

const worktrees = git.worktree('product-worktrees', { repo: '.', slots: 3 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees).restart('rerun');

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(work => `Implement: ${work.title}\n\n${work.description}\n\nOpen deficits:\n${work.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute', 'ask']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(work => `Audit the change for "${work.title}". The builder reports: ${work.summary}`)
  .intents(['read', 'execute']);

const builder = H.agent('builder', builderRole)
  .model(cheaperUntilItSlips)
  .on(worktrees)
  .recalls(productExperience, ownerTaste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .on(worktrees)
  .recalls(productExperience)
  .records(productExperience);

const buildAndAudit = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int() }))
  .does(async ctx => {
    const work = ctx.unit.data;
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title: work.title, description: work.description, deficits });
      if (built.ok === false) return ctx.fail(built.error);
      const audit = await ctx.run(auditor, { title: work.title, summary: built.value.summary });
      if (audit.ok === false) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds: ${deficits.join('; ')}`);
  });

const linearKey = H.env('LINEAR_API_KEY');
const trackerStatuses = { todo: 'Todo', done: 'Done', abandoned: 'Canceled' };

const bugTracker = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'bug',
  read: (issue): BugData => ({
    title: issue.title,
    description: issue.description,
    severity: issue.labels.includes('p1') ? 'high' : 'normal',
  }),
  statuses: trackerStatuses,
});

const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: (file): BugData => {
    const title = file.frontmatter['title'];
    return { title: typeof title === 'string' ? title : file.path, description: file.body, severity: 'normal' };
  },
});

const featureTracker = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, epic: issue.parentId ?? '' }),
  statuses: trackerStatuses,
});

const bugs = H.lane('bugs', Bug)
  .handler(buildAndAudit, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', Feature)
  .handler(buildAndAudit, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

function productRank(unit: PendingView): number {
  return unit.is(Bug) ? 0 : 1;
}

const bugsBeforeFeatures = H.policy.scheduler('bugs-before-features', view => ({
  start: [...view.pending].sort((x, y) => productRank(x) - productRank(y) || y.waitedMs - x.waitedMs),
}));

const ownerGrants = [
  H.ops.readWork,
  H.ops.writeWork,
  H.ops.resolveHalts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
];

export const productHarness = H.harness('product')
  .ledger(sqlite.ledger('product/.harness/ledger.db', sharedQuota))
  .lanes(bugs, features)
  .pools(subscriptionPool('product-subscriptions', 0.6))
  .scheduler(bugsBeforeFeatures)
  .clients(http.control({ port: 7401, token: H.env('PRODUCT_CONTROL_TOKEN'), grants: ownerGrants }))
  .observers(markdown.board('product/BOARD.md'), markdown.telemetry('product/TELEMETRY.md'));

const stale = H.state('stale', 'pending');
const published = H.state('published', { terminal: 'success' });
const needsAttention = H.state('needs-attention', { terminal: 'failure' });

const DocPage = H.kind('doc-page')
  .data(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .states([stale, published, needsAttention], 'stale')
  .failsTo('needs-attention');

const docsExperience = H.library('docs-experience', experience, jsonl.memory('docs/.harness/experience.jsonl'));

const docsFolder = folder.files(DocPage, {
  dir: 'docs/pages',
  read: file => {
    const title = file.frontmatter['title'];
    return { path: file.path, title: typeof title === 'string' ? title : file.path, body: file.body };
  },
  write: (page, state) => ({ title: page.title, status: state }),
});

const writerRole = H.role('writer')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ body: z.string() }))
  .prompt(page => `Rewrite the documentation page "${page.title}" so it is current and clear.\n\n${page.body}`)
  .intents(['read']);

const writer = H.agent('writer', writerRole).model(sonnet).recalls(docsExperience, ownerTaste).records(docsExperience);

const docsBox = shell.local('docs-box', { slots: 2 });

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .argv(input => ['link-check', input.path])
  .on(docsBox)
  .restart('rerun');

const writePage = H.flow('write-page').for(DocPage).does(async ctx => {
  const page = ctx.unit.data;
  const written = await ctx.run(writer, { title: page.title, body: page.body });
  if (written.ok === false) return ctx.fail(written.error);
  await ctx.update({ body: written.value.body });
  const links = await ctx.run(linkCheck, { path: page.path });
  if (links.ok === false) return ctx.fail(links.error);
  if (links.value.broken.length > 0) return ctx.fail(`broken links: ${links.value.broken.join(', ')}`);
  return 'published';
});

const docPages = H.lane('doc-pages', DocPage).handler(writePage).suppliers(docsFolder).store(docsFolder).wip(2);

const oldestFirst = H.policy.scheduler('oldest-first', view => ({
  start: [...view.pending].sort((x, y) => y.waitedMs - x.waitedMs),
}));

export const docsHarness = H.harness('docs')
  .ledger(sqlite.ledger('docs/.harness/ledger.db', sharedQuota))
  .lanes(docPages)
  .pools(subscriptionPool('docs-subscriptions', 0.3))
  .scheduler(oldestFirst)
  .clients(http.control({ port: 7402, token: H.env('DOCS_CONTROL_TOKEN'), grants: ownerGrants }))
  .observers(markdown.board('docs/BOARD.md'), markdown.telemetry('docs/TELEMETRY.md'));
