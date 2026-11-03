import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView, Pool } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const sharedAccountState = '/home/owner/.harness/accounts.db';

const subscriptionOne = claude.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1') });
const subscriptionTwo = claude.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2') });
const subscriptionThree = claude.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiringThenApi = H.policy.account('soonest-expiring-then-api', choice => {
  const subscriptions = choice.accounts
    .filter(a => a.eligible && a.account.plan === 'subscription' && a.usedShare < a.share)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity));
  const soonest = subscriptions[0];
  if (soonest) return soonest.account;
  return choice.accounts.find(a => a.eligible && a.account.plan === 'metered')?.account ?? null;
});

function sharedSubscriptions(name: string, windowShare: number): Pool {
  return H.pool(name, [
    { account: subscriptionOne, share: windowShare },
    { account: subscriptionTwo, share: windowShare },
    { account: subscriptionThree, share: windowShare },
    { account: apiAccount, share: 1 },
  ], soonestExpiringThenApi);
}

const taste = H.memory('taste', 'owner');
const experience = H.memory('experience', 'fallible');

const specificFirst = H.policy.recall('specific-first', view =>
  [...view.items]
    .sort((a, b) => b.specificity - a.specificity || (b.trackRecord.value ?? 0) - (a.trackRecord.value ?? 0))
    .slice(0, 12)
);

const ownerTaste = H.library('owner-taste', taste, jsonl.memory('/home/owner/.harness/taste.jsonl')).recall(specificFirst);

const sonnet = claude.model('claude-sonnet-4-5');
const opus = claude.model('claude-opus-4-1');

const queued = H.state('queued', 'pending');
const building = H.state('building', 'active');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const dropped = H.state('dropped', 'terminal', 'neutral');
const decomposing = H.state('decomposing', 'active');
const awaitingFeatures = H.state('awaiting-features', 'waiting');
const due = H.state('due', 'pending');
const checking = H.state('checking', 'active');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');
const skipped = H.state('skipped', 'terminal', 'neutral');

const Bug = H.kind('Bug')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states([queued, building, done, abandoned, dropped], { initial: 'queued', afterFailure: 'abandoned', afterCancel: 'dropped' });

const Feature = H.kind('Feature')
  .data(z.object({ title: z.string(), description: z.string(), epic: z.string().optional() }))
  .states([queued, building, done, abandoned, dropped], { initial: 'queued', afterFailure: 'abandoned', afterCancel: 'dropped' });

const Epic = H.kind('Epic')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states([queued, decomposing, awaitingFeatures, done, abandoned, dropped], { initial: 'queued', afterFailure: 'abandoned', afterCancel: 'dropped' });

const Heartbeat = H.kind('ServiceHeartbeat')
  .data(z.object({ service: z.string(), url: z.string() }))
  .states([due, checking, healthy, unhealthy, skipped], { initial: 'due', afterFailure: 'unhealthy', afterCancel: 'skipped' });

const ticketStatuses = { queued: 'Todo', building: 'In Progress', done: 'Done', abandoned: 'Canceled', dropped: 'Duplicate' };
const linearKey = H.env('LINEAR_API_KEY');

const bugTracker = linear.tracker(Bug, {
  apiKey: linearKey, team: 'PRODUCT', label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: ticketStatuses,
});
const featureTracker = linear.tracker(Feature, {
  apiKey: linearKey, team: 'PRODUCT', label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses: ticketStatuses,
});
const epicTracker = linear.tracker(Epic, {
  apiKey: linearKey, team: 'PRODUCT', label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { ...ticketStatuses, decomposing: 'In Progress', 'awaiting-features': 'In Progress' },
});
const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: file => ({ title: String(file.frontmatter.title ?? file.path), description: file.body }),
});

const productWorktree = git.worktree('product-worktree', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });
const codingExperience = H.library('coding-experience', experience, jsonl.memory('memory/experience.jsonl')).recall(specificFirst);

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(productWorktree).restart('rerun');

const cheaperUntilItSlips = H.policy.model('cheaper-until-success-below-0.85', choice => {
  const record = choice.metrics.successRate({ kind: choice.kind, model: sonnet.name, days: 14 });
  if (record.samples < 20 || record.value === null) return sonnet;
  return record.value >= 0.85 ? sonnet : opus;
});

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), filesTouched: z.array(z.string()) }))
  .prompt(t => `Implement "${t.title}".\n\n${t.description}\n\nOpen deficits:\n${t.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute', 'ask']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(a => `Audit the change for "${a.title}": ${a.summary}. List every remaining deficit.`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(e => `Decompose the epic "${e.title}" into features.\n\n${e.description}`)
  .intents(['read']);

const builder = H.agent('builder', builderRole)
  .model(cheaperUntilItSlips)
  .on(productWorktree)
  .recalls(codingExperience, ownerTaste)
  .guards(claude.fileLeases(), claude.stopCheck(projectChecks));
const auditor = H.agent('auditor', auditorRole).model(opus).on(productWorktree).recalls(codingExperience).records(codingExperience);
const planner = H.agent('planner', plannerRole).model(opus).recalls(ownerTaste);

const buildAndAudit = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async ctx => {
    await ctx.move('building');
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title: ctx.unit.data.title, description: ctx.unit.data.description, deficits });
      if (!built.ok) return ctx.fail(built.error);
      const audit = await ctx.run(auditor, { title: ctx.unit.data.title, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`);
  });

const bugLane = H.lane('bugs', Bug)
  .handler(buildAndAudit, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const featureLane = H.lane('features', Feature)
  .handler(buildAndAudit, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const decomposeEpic = H.flow('decompose-epic').for(Epic).does(async ctx => {
  await ctx.move('decomposing');
  const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
  if (!plan.ok) return ctx.fail(plan.error);
  await ctx.spawn(featureLane, plan.value.features.map(f => ({ title: f.title, description: f.description, epic: ctx.unit.key })));
  return ctx.until('awaiting-features', { children: true, then: 'done' });
});

const epicLane = H.lane('epics', Epic).handler(decomposeEpic).suppliers(epicTracker).store(epicTracker).wip(1);

const serviceHeartbeat = H.command('service-heartbeat')
  .input(z.object({ service: z.string(), url: z.string() }))
  .argv(s => ['curl', '-fsS', '--max-time', '10', s.url])
  .on(local)
  .restart('rerun');

const checkHeartbeat = H.flow('check-heartbeat').for(Heartbeat).does(async ctx => {
  await ctx.move('checking');
  const probe = await ctx.run(serviceHeartbeat, ctx.unit.data);
  return probe.ok ? 'healthy' : 'unhealthy';
});

const heartbeatLane = H.lane('heartbeats', Heartbeat).handler(checkHeartbeat);

const monitoredServices = [
  { service: 'api', url: 'https://api.example.com/health' },
  { service: 'web', url: 'https://www.example.com/health' },
];

const heartbeatEveryFiveMinutes = H.trigger(
  'heartbeat-every-five-minutes',
  H.on.clock({ every: { minutes: 5 } }),
  (event, act) => monitoredServices.map(s => act.create(heartbeatLane, s, `heartbeat:${s.service}:${event.at.toISOString()}`))
);

const unhealthyHeartbeatFilesBug = H.trigger(
  'unhealthy-heartbeat-files-bug',
  H.on.enters(Heartbeat, 'unhealthy'),
  (event, act) => act.create(bugLane, {
    title: `${event.unit.data.service} heartbeat failed`,
    description: `The heartbeat for ${event.unit.data.service} at ${event.unit.data.url} failed at ${event.at.toISOString()}.`,
  }, `heartbeat-bug:${event.unit.data.service}`)
);

const codingLaneOrder = ['heartbeats', 'bugs', 'features', 'epics'];
const featureStarvationMs = 2 * 60 * 60 * 1000;
const codingRank = (unit: PendingView) =>
  unit.lane === 'features' && unit.waitedMs > featureStarvationMs ? 0.5 : codingLaneOrder.indexOf(unit.lane);

const productionHealth = H.command('production-health-probe')
  .argv(() => ['curl', '-fsS', 'https://api.example.com/health/deep'])
  .on(local)
  .restart('rerun');

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('coding-team.db', { sharedQuota: sharedAccountState }))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .pools(sharedSubscriptions('coding-subscriptions', 0.6))
  .triggers(heartbeatEveryFiveMinutes, unhealthyHeartbeatFilesBug)
  .scheduler(H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
    start: [...view.pending].sort((a, b) => codingRank(a) - codingRank(b) || b.waitedMs - a.waitedMs),
  })))
  .clients(http.control({
    port: 7101,
    token: H.env('CODING_CONTROL_TOKEN'),
    grants: [
      H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry,
      H.ops.readAccounts, H.ops.setShares, H.operation('production-health', productionHealth),
    ],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

const draftPage = H.state('draft', 'pending');
const writing = H.state('writing', 'active');
const published = H.state('published', 'terminal', 'success');
const rejectedPage = H.state('rejected', 'terminal', 'failure');
const shelved = H.state('shelved', 'terminal', 'neutral');

const DocPage = H.kind('DocPage')
  .data(z.object({ title: z.string(), path: z.string(), brief: z.string() }))
  .states([draftPage, writing, published, rejectedPage, shelved], { initial: 'draft', afterFailure: 'rejected', afterCancel: 'shelved' });

const docPages = folder.files(DocPage, {
  dir: 'docs',
  read: file => ({ title: String(file.frontmatter.title ?? file.path), path: file.path, brief: file.body }),
  write: (page, state) => ({ title: page.title, status: state }),
});

const docsWorktree = git.worktree('docs-worktree', { repo: '.', slots: 2 });
const docsExperience = H.library('docs-experience', experience, jsonl.memory('memory/docs-experience.jsonl')).recall(specificFirst);

const writerRole = H.role('writer')
  .input(z.object({ title: z.string(), path: z.string(), brief: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(p => `Write or revise the page "${p.title}" at ${p.path}.\n\n${p.brief}`)
  .intents(['read', 'edit']);

const writer = H.agent('writer', writerRole).model(sonnet).on(docsWorktree).recalls(ownerTaste, docsExperience).records(docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(p => ['lychee', '--offline', p.path])
  .on(docsWorktree)
  .restart('rerun');

const writePage = H.flow('write-page').for(DocPage).does(async ctx => {
  await ctx.move('writing');
  const written = await ctx.run(writer, ctx.unit.data);
  if (!written.ok) return ctx.fail(written.error);
  const links = await ctx.run(linkCheck, { path: ctx.unit.data.path });
  return links.ok ? 'published' : ctx.fail(links.error);
});

const docLane = H.lane('doc-pages', DocPage).handler(writePage).suppliers(docPages).store(docPages).wip(2);

export const documentation = H.harness('documentation')
  .ledger(sqlite.ledger('documentation.db', { sharedQuota: sharedAccountState }))
  .lanes(docLane)
  .pools(sharedSubscriptions('docs-subscriptions', 0.3))
  .scheduler(H.policy.scheduler('oldest-first', view => ({
    start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs),
  })))
  .clients(http.control({
    port: 7102,
    token: H.env('DOCS_CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
  }))
  .observers(markdown.board('docs/BOARD.md'), markdown.telemetry('docs/TELEMETRY.md'));
