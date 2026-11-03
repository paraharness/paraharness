import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Account, AccountChoice, PendingView, Pool } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sharedAccountQuota = sqlite.quota('~/.harness/accounts.db');

const subscriptions = [
  claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') }),
  claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN') }),
  claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN') }),
];
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

function soonestExpiringThenMetered(choice: AccountChoice): Account | null {
  const open = choice.accounts
    .filter(view => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort((x, y) =>
      (x.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (y.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  const first = open[0];
  if (first) return first.account;
  const metered = choice.accounts.find(view => view.eligible && view.account.plan === 'metered');
  return metered ? metered.account : null;
}

const drainSoonestExpiring = H.policy.account('drain-soonest-expiring', soonestExpiringThenMetered);

function claudePool(name: string, projectShare: number): Pool {
  return H.pool(
    name,
    [...subscriptions.map(account => ({ account, share: projectShare })), { account: apiAccount, share: 1 }],
    drainSoonestExpiring,
  );
}

const specificThenProven = H.policy.recall('specific-then-proven', view =>
  view.items
    .filter(item => item.status === 'accepted')
    .sort((x, y) => y.specificity - x.specificity || (y.trackRecord.value ?? 0) - (x.trackRecord.value ?? 0))
    .slice(0, 12));

const Taste = H.memory('taste', 'owner');
const Experience = H.memory('experience', 'fallible');
const ownerTaste = H.library('owner-taste', Taste, jsonl.memory('~/.harness/taste.jsonl')).recall(specificThenProven);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const threeTries = H.policy.retry('three-tries', view =>
  view.failures >= 3 ? 'stop' : { retryInMs: 60_000 * 2 ** view.failures });

const queued = H.state.pending('queued');
const building = H.state.active('building');
const auditing = H.state.active('auditing');
const planning = H.state.active('planning');
const awaitingFeatures = H.state.waiting('awaiting-features');
const done = H.state.terminal('done', 'success');
const abandoned = H.state.terminal('abandoned', 'failure');
const ticketStates = [queued, building, auditing, done, abandoned];

const Bug = H.kind('bug')
  .data(z.object({ title: z.string(), body: z.string() }))
  .states(ticketStates, 'queued')
  .onFailure('abandoned');

const Feature = H.kind('feature')
  .data(z.object({ title: z.string(), body: z.string(), epic: z.string().optional() }))
  .states(ticketStates, 'queued')
  .onFailure('abandoned');

const Epic = H.kind('epic')
  .data(z.object({ title: z.string(), body: z.string() }))
  .states([queued, planning, awaitingFeatures, done, abandoned], 'queued')
  .onFailure('abandoned');

const due = H.state.pending('due');
const probing = H.state.active('probing');
const healthy = H.state.terminal('healthy', 'success');
const unhealthy = H.state.terminal('unhealthy', 'failure');

const Heartbeat = H.kind('service-heartbeat')
  .data(z.object({ service: z.string(), detail: z.string().optional() }))
  .states([due, probing, healthy, unhealthy], 'due');

const codingExperience = H.library('coding-experience', Experience, jsonl.memory('coding/.harness/experience.jsonl'))
  .recall(specificThenProven);

const codingTree = git.worktree('coding-worktree', { repo: 'coding', slots: 3 });
const codingShell = shell.local('coding-shell', { slots: 4 });

const projectChecks = H.command('project-checks')
  .argv(() => ['npm', 'run', 'check'])
  .on(codingTree)
  .restart('rerun');

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), body: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(work => `Implement: ${work.title}\n\n${work.body}\n\nOpen deficits:\n${work.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute', 'ask']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), body: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(work => `Audit the change for "${work.title}". Builder summary: ${work.summary}. List remaining deficits.`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }))
  .prompt(epic => `Decompose this epic into independently shippable features.\n\n${epic.title}\n\n${epic.body}`)
  .intents(['read']);

const cheaperUntilItSlips = H.policy.model('cheaper-until-it-slips', choice => {
  const cheaper = choice.metrics.successRate({ kind: choice.kind, model: sonnet.name, days: 14 });
  return cheaper.samples >= 20 && cheaper.value !== null && cheaper.value < 0.85 ? opus : sonnet;
});

const builder = H.agent('builder', builderRole)
  .model(cheaperUntilItSlips)
  .on(codingTree)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks))
  .recalls(codingExperience, ownerTaste);

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .on(codingTree)
  .recalls(codingExperience)
  .records(codingExperience);

const planner = H.agent('planner', plannerRole)
  .model(opus)
  .recalls(ownerTaste);

const buildAndAudit = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    const { title, body } = ctx.unit.data;
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round++) {
      await ctx.move('building');
      const built = await ctx.run(builder, { title, body, deficits });
      if (!built.ok) return ctx.fail(built.error);
      await ctx.move('auditing');
      const audit = await ctx.run(auditor, { title, body, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      deficits = audit.value.deficits;
      if (deficits.length === 0) return 'done';
    }
    return ctx.fail(`${deficits.length} deficits remain after ${ctx.params.rounds} rounds`);
  });

const ticketStatuses = {
  queued: 'Todo',
  building: 'In Progress',
  auditing: 'In Review',
  done: 'Done',
  abandoned: 'Canceled',
};
const linearKey = H.env('LINEAR_API_KEY');

const bugTracker = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'bug',
  read: issue => ({ title: issue.title, body: issue.description }),
  statuses: ticketStatuses,
});

const bugFolder = folder.files(Bug, {
  dir: 'coding/bugs',
  read: file => ({ title: String(file.frontmatter['title'] ?? file.path), body: file.body }),
});

const featureTracker = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'feature',
  read: issue => ({ title: issue.title, body: issue.description, epic: issue.parentId }),
  statuses: ticketStatuses,
});

const epicTracker = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'epic',
  read: issue => ({ title: issue.title, body: issue.description }),
  statuses: { queued: 'Todo', planning: 'In Progress', 'awaiting-features': 'In Progress', done: 'Done', abandoned: 'Canceled' },
});

const bugs = H.lane('bugs', Bug)
  .handler(buildAndAudit, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2)
  .retry(threeTries);

const features = H.lane('features', Feature)
  .handler(buildAndAudit, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker)
  .retry(threeTries);

const decomposeEpic = H.flow('decompose-epic').for(Epic).does(async ctx => {
  const existing = await ctx.children();
  if (existing.length > 0) {
    if (existing.some(child => child.position !== 'terminal')) {
      return ctx.rest('awaiting-features', { children: true, then: 'queued' });
    }
    return existing.every(child => child.verdict === 'success') ? 'done' : 'abandoned';
  }
  await ctx.move('planning');
  const plan = await ctx.run(planner, { title: ctx.unit.data.title, body: ctx.unit.data.body });
  if (!plan.ok) return ctx.fail(plan.error);
  await ctx.spawn(features, plan.value.features.map(feature => ({ ...feature, epic: ctx.unit.key })));
  return ctx.rest('awaiting-features', { children: true, then: 'queued' });
});

const epics = H.lane('epics', Epic)
  .handler(decomposeEpic)
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1)
  .retry(threeTries);

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .argv(input => ['./ops/probe', input.service])
  .on(codingShell)
  .restart('rerun');

const probeHeartbeat = H.flow('probe-heartbeat').for(Heartbeat).does(async ctx => {
  await ctx.move('probing');
  const probe = await ctx.run(probeService, { service: ctx.unit.data.service });
  if (!probe.ok) {
    await ctx.update({ detail: probe.error });
    return 'unhealthy';
  }
  await ctx.update({ detail: probe.value.detail });
  return probe.value.healthy ? 'healthy' : 'unhealthy';
});

const services = ['api', 'web', 'worker'];

const heartbeats = H.lane('heartbeats', Heartbeat)
  .handler(probeHeartbeat)
  .suppliers(H.timetable('every-five-minutes', Heartbeat, { every: { minutes: 5 } }, tick =>
    services.map(service => ({ create: { service }, key: `${service}@${tick.now.toISOString()}` }))));

const failedHeartbeatFilesBug = H.trigger(
  'failed-heartbeat-files-bug',
  H.on.enters(Heartbeat, 'unhealthy'),
  (event, act) => act.create(
    bugs,
    { title: `${event.unit.data.service} heartbeat failed`, body: event.unit.data.detail ?? 'no detail' },
    { oneOpenPer: `heartbeat:${event.unit.data.service}` },
  ),
);

const laneOrder = ['heartbeats', 'bugs', 'features', 'epics'];
const featureStarvationMs = 4 * 60 * 60 * 1000;

const codingPriority = H.policy.scheduler('heartbeats-bugs-features-epics', view => {
  const rank = (unit: PendingView): number =>
    unit.lane === 'features' && unit.waitedMs > featureStarvationMs ? 0.5 : laneOrder.indexOf(unit.lane);
  return { start: [...view.pending].sort((x, y) => rank(x) - rank(y) || y.waitedMs - x.waitedMs) };
});

const productionHealth = H.command('production-health')
  .argv(() => ['./ops/health', '--env', 'production'])
  .on(codingShell)
  .restart('rerun');

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('coding/.harness/ledger.db', { quota: sharedAccountQuota }))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool('coding-claude', 0.6))
  .triggers(failedHeartbeatFilesBug)
  .scheduler(codingPriority)
  .clients(claudeCode.supervisor({
    grants: [
      H.ops.readWork,
      H.ops.writeWork,
      H.ops.resolveHalts,
      H.ops.writeMemory,
      H.ops.readTelemetry,
      H.ops.readAccounts,
      H.ops.setShares,
      H.operation('probe-production', productionHealth),
    ],
  }))
  .observers(markdown.board('coding/BOARD.md'), markdown.telemetry('coding/TELEMETRY.md'));

const stale = H.state.pending('stale');
const writing = H.state.active('writing');
const checkingLinks = H.state.active('checking-links');
const published = H.state.terminal('published', 'success');

const DocPage = H.kind('doc-page')
  .data(z.object({ path: z.string(), title: z.string(), brief: z.string() }))
  .states([stale, writing, checkingLinks, published, abandoned], 'stale')
  .onFailure('abandoned');

const docsExperience = H.library('docs-experience', Experience, jsonl.memory('docs/.harness/experience.jsonl'))
  .recall(specificThenProven);

const docsTree = git.worktree('docs-worktree', { repo: 'docs', slots: 2 });

const writerRole = H.role('writer')
  .input(z.object({ path: z.string(), title: z.string(), brief: z.string(), brokenLinks: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(page => `Rewrite ${page.path} ("${page.title}"): ${page.brief}\n\nFix these broken links:\n${page.brokenLinks.join('\n')}`)
  .intents(['read', 'edit']);

const writer = H.agent('writer', writerRole)
  .model(sonnet)
  .on(docsTree)
  .recalls(ownerTaste, docsExperience)
  .records(docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .argv(input => ['link-check', '--json', input.path])
  .on(docsTree)
  .restart('rerun');

const writeDocPage = H.flow('write-doc-page').for(DocPage).does(async ctx => {
  const page = ctx.unit.data;
  let broken: string[] = [];
  for (let round = 1; round <= 3; round++) {
    await ctx.move('writing');
    const written = await ctx.run(writer, { ...page, brokenLinks: broken });
    if (!written.ok) return ctx.fail(written.error);
    await ctx.move('checking-links');
    const checked = await ctx.run(linkCheck, { path: page.path });
    if (!checked.ok) return ctx.fail(checked.error);
    broken = checked.value.broken;
    if (broken.length === 0) return 'published';
  }
  return ctx.fail(`${broken.length} links still broken after 3 rounds`);
});

const docFolder = folder.files(DocPage, {
  dir: 'docs/pages',
  read: file => ({
    path: file.path,
    title: String(file.frontmatter['title'] ?? file.path),
    brief: String(file.frontmatter['brief'] ?? ''),
  }),
  write: (page, state) => ({ title: page.title, brief: page.brief, status: state }),
});

const pages = H.lane('pages', DocPage)
  .handler(writeDocPage)
  .suppliers(docFolder)
  .store(docFolder)
  .wip(2)
  .retry(threeTries);

export const documentation = H.harness('documentation')
  .ledger(sqlite.ledger('docs/.harness/ledger.db', { quota: sharedAccountQuota }))
  .lanes(pages)
  .pools(claudePool('docs-claude', 0.3))
  .scheduler(H.policy.scheduler('oldest-first', view => ({
    start: [...view.pending].sort((x, y) => y.waitedMs - x.waitedMs),
  })))
  .clients(claudeCode.supervisor({
    grants: [
      H.ops.readWork,
      H.ops.writeWork,
      H.ops.resolveHalts,
      H.ops.writeMemory,
      H.ops.readTelemetry,
      H.ops.readAccounts,
    ],
  }))
  .observers(markdown.board('docs/BOARD.md'), markdown.telemetry('docs/TELEMETRY.md'));
