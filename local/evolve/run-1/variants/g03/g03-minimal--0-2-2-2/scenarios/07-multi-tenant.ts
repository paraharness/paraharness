import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

export const subscriptionOne = claude.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1') });
export const subscriptionTwo = claude.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2') });
export const subscriptionThree = claude.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3') });
export const subscriptions = [subscriptionOne, subscriptionTwo, subscriptionThree];
export const sharedQuota = '~/.harness/quota.db';
export const ownerTaste = H.memory('owner-taste', 'taste');
export const sharedTaste = H.library('owner-taste', ownerTaste, jsonl.memory('~/.harness/taste.jsonl'));

export const soonestExpiring = H.policy.account('soonest-expiring-then-metered', ({ accounts }) => {
  const open = accounts
    .filter((a) => a.eligible && a.account.plan === 'subscription' && a.usedShare < a.share)
    .sort((a, b) =>
      (a.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  const first = open[0];
  if (first !== undefined) return first.account;
  const metered = accounts.find((a) => a.eligible && a.account.plan === 'metered');
  return metered === undefined ? null : metered.account;
});

const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');
const codingApi = anthropic.account('coding-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const experience = H.memory('experience', 'experience');
const codingExperience = H.library('coding-experience', experience, jsonl.memory('repos/product/.harness/experience.jsonl'));
const docsExperience = H.library('docs-experience', experience, jsonl.memory('repos/docs/.harness/experience.jsonl'));

const queued = H.state('queued', 'pending');
const building = H.state('building', 'active');
const auditing = H.state('auditing', 'active');
const done = H.state('done', 'terminal', 'success');
const exhausted = H.state('exhausted', 'terminal', 'failure');
const abandoned = H.state('abandoned', 'terminal', 'neutral');

const ticket = z.object({ title: z.string(), description: z.string() });
const Bug = H.kind('Bug').data(ticket).states(queued, building, auditing, done, exhausted, abandoned);
const Feature = H.kind('Feature').data(ticket).states(queued, building, auditing, done, exhausted, abandoned);

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt((t) => `Implement "${t.title}".\n\n${t.description}\n\nOpen deficits:\n${t.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((t) => `Audit the change for "${t.title}" against:\n${t.description}\n\nBuilder summary:\n${t.summary}`)
  .intents(['read', 'execute']);

const builderModel = H.policy.model('cheap-until-unreliable', ({ kind, metrics }) => {
  const cheap = metrics.successRate({ kind, model: sonnet, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const productWorktrees = git.worktree('product-worktrees', { repo: 'repos/product', slots: 3 });

const projectChecks = H.command('project-checks')
  .argv(() => ['npm', 'run', 'check'])
  .on(productWorktrees);

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(productWorktrees)
  .guards(claude.fileLeases(), claude.stopCheck(projectChecks))
  .recalls(codingExperience, sharedTaste);

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .on(productWorktrees)
  .recalls(codingExperience)
  .records(codingExperience);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string(), abandon: z.boolean() }));

const ticketWork = H.flow('ticket-work')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number() }))
  .phases('building', 'auditing')
  .exits('done', 'exhausted', 'abandoned')
  .does(async (ctx) => {
    const work = ctx.unit.data;
    let deficits: string[] = [];
    for (let round = 0; round < ctx.params.rounds; round++) {
      await ctx.move('building');
      const built = await ctx.run(builder, { title: work.title, description: work.description, deficits });
      if (!built.ok) return ctx.fail(built.error);
      const question = built.value.question;
      if (question !== undefined) {
        const answer = await ctx.halt(ownerDecision, question);
        if (answer.abandon) return 'abandoned';
      }
      await ctx.move('auditing');
      const audit = await ctx.run(auditor, { title: work.title, description: work.description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      deficits = audit.value.deficits;
      if (deficits.length === 0) return 'done';
    }
    return 'exhausted';
  });

const trackerStatuses = {
  queued: 'Todo',
  building: 'In Progress',
  auditing: 'In Review',
  done: 'Done',
  exhausted: 'Needs Owner',
  abandoned: 'Canceled',
};

const bugTracker = linear.tracker(Bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'bug',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: trackerStatuses,
});

const featureTracker = linear.tracker(Feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'feature',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: trackerStatuses,
});

const bugFolder = folder.files(Bug, {
  dir: 'repos/product/bugs',
  read: (file) => ({ title: String(file.frontmatter['title'] ?? file.path), description: file.body }),
});

const bugs = H.lane('bugs', Bug)
  .handler(ticketWork, { building, auditing, done, exhausted, abandoned }, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', Feature)
  .handler(ticketWork, { building, auditing, done, exhausted, abandoned }, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

function codingRank(unit: PendingView): number {
  if (unit.is(Bug)) return 0;
  return unit.waitedMs > 4 * 60 * 60 * 1000 ? 0 : 1;
}

const bugsThenFeatures = H.policy.scheduler('bugs-then-features', (view) => ({
  start: [...view.pending].sort((a, b) => codingRank(a) - codingRank(b) || b.waitedMs - a.waitedMs),
}));

const codingPool = H.pool(
  'coding-pool',
  [...subscriptions.map((account) => ({ account, share: 0.6 })), { account: codingApi, share: 1 }],
  soonestExpiring,
);

export const coding = H.harness('coding-team')
  .ledger(sqlite.ledger('repos/product/.harness/ledger.db', { sharedQuota }))
  .lanes(bugs, features)
  .pools(codingPool)
  .scheduler(bugsThenFeatures)
  .clients(
    claude.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolveHalts,
        H.ops.writeMemory,
        H.ops.readTelemetry,
        H.ops.readAccounts,
        H.ops.setShares,
      ],
    }),
    http.control({
      port: 7101,
      token: H.env('CODING_CONTROL_TOKEN'),
      grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
    }),
  )
  .observers(markdown.board('repos/product/board.md'), markdown.telemetry('repos/product/telemetry.md'));

const pageDraft = H.state('page-draft', 'pending');
const writing = H.state('writing', 'active');
const checking = H.state('checking', 'active');
const published = H.state('published', 'terminal', 'success');
const brokenLinks = H.state('broken-links', 'terminal', 'failure');

const DocPage = H.kind('DocPage')
  .data(z.object({ path: z.string(), title: z.string() }))
  .states(pageDraft, writing, checking, published, brokenLinks);

const docFiles = folder.files(DocPage, {
  dir: 'repos/docs/pages',
  read: (file) => ({ path: file.path, title: String(file.frontmatter['title'] ?? file.path) }),
});

const docsWorktrees = git.worktree('docs-worktrees', { repo: 'repos/docs', slots: 2 });

const writerRole = H.role('writer')
  .input(z.object({ path: z.string(), title: z.string(), brokenLinks: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt((p) => `Write or revise the page "${p.title}" at ${p.path}.\nFix these broken links:\n${p.brokenLinks.join('\n')}`)
  .intents(['read', 'edit']);

const writer = H.agent('writer', writerRole)
  .model(sonnet)
  .on(docsWorktrees)
  .recalls(docsExperience, sharedTaste)
  .records(docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .argv((p) => ['link-check', '--json', p.path])
  .on(docsWorktrees);

const writeDoc = H.flow('write-doc')
  .for(DocPage)
  .phases('writing', 'checking')
  .exits('published', 'broken')
  .does(async (ctx) => {
    const page = ctx.unit.data;
    let broken: string[] = [];
    for (let round = 0; round < 2; round++) {
      await ctx.move('writing');
      const written = await ctx.run(writer, { path: page.path, title: page.title, brokenLinks: broken });
      if (!written.ok) return ctx.fail(written.error);
      await ctx.move('checking');
      const checked = await ctx.run(linkCheck, { path: page.path });
      if (!checked.ok) return ctx.fail(checked.error);
      broken = checked.value.broken;
      if (broken.length === 0) return 'published';
    }
    return 'broken';
  });

const docPages = H.lane('doc-pages', DocPage)
  .handler(writeDoc, { writing, checking, published, broken: brokenLinks })
  .suppliers(docFiles)
  .store(docFiles)
  .wip(2);

const docsPool = H.pool(
  'docs-pool',
  subscriptions.map((account) => ({ account, share: 0.3 })),
  soonestExpiring,
);

const oldestPageFirst = H.policy.scheduler('oldest-page-first', (view) => ({
  start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
}));

export const docs = H.harness('documentation')
  .ledger(sqlite.ledger('repos/docs/.harness/ledger.db', { sharedQuota }))
  .lanes(docPages)
  .pools(docsPool)
  .scheduler(oldestPageFirst)
  .clients(
    claude.supervisor({
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
    }),
    http.control({
      port: 7102,
      token: H.env('DOCS_CONTROL_TOKEN'),
      grants: [H.ops.readWork, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
    }),
  )
  .observers(markdown.board('repos/docs/board.md'), markdown.telemetry('repos/docs/telemetry.md'));
