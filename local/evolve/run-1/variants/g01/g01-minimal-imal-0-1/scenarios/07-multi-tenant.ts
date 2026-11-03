import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Account, PendingView } from 'harness-dsl';
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

const sharedQuota = sqlite.quota('~/.harness/shared-quota.db');

export const sharedAccounts: readonly [Account, Account, Account] = [
  claude.subscription('max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota: sharedQuota }),
  claude.subscription('max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota: sharedQuota }),
  claude.subscription('max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota: sharedQuota }),
];

export const OwnerTaste = H.memory('owner-taste', 'taste');
export const sharedTaste = H.library('owner-taste', OwnerTaste, jsonl.memory('~/.harness/owner-taste.jsonl'));

const Experience = H.memory('experience', 'experience');

const soonestExpiring = H.policy.account('soonest-expiring', choice => {
  const ready = choice.accounts.filter(a => a.eligible && a.usedShare < a.share);
  const subscriptions = ready
    .filter(a => a.account.plan === 'subscription')
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity));
  return subscriptions[0]?.account ?? ready.find(a => a.account.plan === 'metered')?.account ?? null;
});

const sharesOf = (share: number) => sharedAccounts.map(account => ({ account, share }));

const sonnet = claude.model('claude-sonnet-4-5');
const opus = claude.model('claude-opus-4-1');

const queued = H.state('queued', 'pending');
const building = H.state('building', 'active');
const auditing = H.state('auditing', 'active');
const triage = H.state('triage', 'waiting');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const wontFix = H.state('wont-fix', 'terminal', 'neutral');
const ticketStates = [queued, building, auditing, triage, done, abandoned, wontFix];

const Bug = H.kind('bug')
  .data(z.object({ title: z.string(), description: z.string(), source: z.string() }))
  .states(ticketStates, { initial: 'queued', afterFailure: 'triage' });

const Feature = H.kind('feature')
  .data(z.object({ title: z.string(), description: z.string(), epic: z.string().optional() }))
  .states(ticketStates, { initial: 'queued', afterFailure: 'triage' });

const Epic = H.kind('epic')
  .data(z.object({ title: z.string(), description: z.string() }))
  .states([
    H.state('proposed', 'pending'),
    H.state('planning', 'active'),
    H.state('in-progress', 'waiting'),
    H.state('features-done', 'pending'),
    H.state('checking', 'active'),
    triage,
    done,
    abandoned,
  ], { initial: 'proposed', afterFailure: 'triage' });

const Heartbeat = H.kind('service-heartbeat')
  .data(z.object({ service: z.string() }))
  .states([H.state('due', 'pending'), H.state('probing', 'active'), H.state('healthy', 'terminal', 'success'), H.state('down', 'terminal', 'failure')], {
    initial: 'due',
    afterFailure: 'down',
  });

const codingExperience = H.library('coding-experience', Experience, jsonl.memory('memory/experience.jsonl'));

const worktrees = git.worktree('app-worktrees', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 2 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees).ifInterrupted('rerun');

const builderModel = H.policy.model('cheap-until-unreliable', choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, model: sonnet.name, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Implement: ${i.title}\n\n${i.description}\n\nOpen deficits:\n${i.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute', 'halt']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit the change for "${i.title}". Builder summary: ${i.summary}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(i => `Decompose this epic into features: ${i.title}\n\n${i.description}`)
  .intents(['read']);

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(worktrees)
  .recalls(codingExperience, sharedTaste)
  .guards(claude.fileLeases(), claude.stopCheck(projectChecks));
const auditor = H.agent('auditor', auditorRole).model(opus).on(worktrees).recalls(codingExperience).records(codingExperience);
const planner = H.agent('planner', plannerRole).model(opus).recalls(sharedTaste);

const ticketFlow = H.flow('ticket')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round++) {
      await ctx.move('building');
      const built = await ctx.run(builder, { title, description, deficits });
      if (!built.ok) return ctx.fail(built.error);
      await ctx.move('auditing');
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return 'triage';
  });

const linearKey = H.env('LINEAR_API_KEY');
const ticketStatuses = {
  queued: 'Todo', building: 'In Progress', auditing: 'In Review', triage: 'Triage',
  done: 'Done', abandoned: 'Canceled', 'wont-fix': "Won't Fix",
};

const linearBugs = linear.tracker(Bug, {
  apiKey: linearKey, team: 'APP', label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description, source: issue.identifier }),
  statuses: ticketStatuses,
});
const folderBugs = folder.files(Bug, {
  dir: 'bugs',
  read: file => ({ title: String(file.frontmatter.title ?? file.path), description: file.body, source: file.path }),
});
const linearFeatures = linear.tracker(Feature, {
  apiKey: linearKey, team: 'APP', label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, epic: issue.parentId }),
  statuses: ticketStatuses,
});
const linearEpics = linear.tracker(Epic, {
  apiKey: linearKey, team: 'APP', label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: {
    proposed: 'Todo', planning: 'In Progress', 'in-progress': 'In Progress', 'features-done': 'In Review',
    checking: 'In Review', triage: 'Triage', done: 'Done', abandoned: 'Canceled',
  },
});

const bugs = H.lane('bugs', Bug).handler(ticketFlow, { rounds: 3 }).suppliers(linearBugs, folderBugs, H.operator).store(linearBugs).wip(2);
const features = H.lane('features', Feature).handler(ticketFlow, { rounds: 5 }).suppliers(linearFeatures, H.operator).store(linearFeatures);

const epicFlow = H.flow('epic').for(Epic).does(async ctx => {
  if (ctx.unit.state === 'features-done') {
    await ctx.move('checking');
    const children = await ctx.children();
    return children.every(child => child.state === 'done') ? 'done' : 'triage';
  }
  await ctx.move('planning');
  const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
  if (!plan.ok) return ctx.fail(plan.error);
  await ctx.spawn(features, plan.value.features.map(f => ({ title: f.title, description: f.description, epic: ctx.unit.key })));
  return ctx.wait('in-progress', { children: true, then: 'features-done' });
});
const epics = H.lane('epics', Epic).handler(epicFlow).suppliers(linearEpics).store(linearEpics).wip(1);

const probe = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./scripts/probe', i.service])
  .on(local)
  .ifInterrupted('rerun');

const heartbeatFlow = H.flow('heartbeat').for(Heartbeat).does(async ctx => {
  await ctx.move('probing');
  const result = await ctx.run(probe, { service: ctx.unit.data.service }, { timeoutMs: 30_000 });
  return result.ok ? 'healthy' : 'down';
});
const services = ['api', 'worker', 'web'];
const heartbeats = H.lane('heartbeats', Heartbeat)
  .handler(heartbeatFlow)
  .suppliers(H.calendar('every-five-minutes', Heartbeat, { every: { minutes: 5 } }, () => services.map(service => ({ create: { service } }))));

const downServiceFilesBug = H.trigger('down-service-files-bug', H.on.enters(Heartbeat, 'down'), (event, act) =>
  act.create(bugs, {
    title: `Service ${event.unit.data.service} failed its heartbeat`,
    description: `Heartbeat ${event.unit.key} ended down at ${event.at.toISOString()}.`,
    source: 'heartbeat',
  }, `heartbeat-down:${event.unit.data.service}`)
);

const laneOrder = ['heartbeats', 'bugs', 'features', 'epics'];
const rank = (u: PendingView): number =>
  u.lane === 'features' && u.waitedMs > 4 * 3_600_000 ? 0.5 : laneOrder.indexOf(u.lane);

const codingScheduler = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs),
}));

const apiFallback = anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY') });

export const coding = H.harness('coding-team')
  .ledger(sqlite.ledger('coding-team.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(H.pool('claude', [...sharesOf(0.6), { account: apiFallback, share: 1 }], soonestExpiring))
  .triggers(downServiceFilesBug)
  .scheduler(codingScheduler)
  .clients(http.control({
    port: 7401,
    token: H.env('CODING_CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
  }))
  .observers(markdown.board('board.md'), markdown.telemetry('telemetry.md'));

const docsExperience = H.library('docs-experience', Experience, jsonl.memory('docs/memory/experience.jsonl'));
const docsWorktrees = git.worktree('docs-worktrees', { repo: '../docs', slots: 2 });

const DocPage = H.kind('doc-page')
  .data(z.object({ path: z.string(), title: z.string(), brief: z.string() }))
  .states([
    H.state('draft', 'pending'),
    H.state('writing', 'active'),
    H.state('link-checking', 'active'),
    H.state('needs-review', 'waiting'),
    H.state('published', 'terminal', 'success'),
  ], { initial: 'draft', afterFailure: 'needs-review' });

const writerRole = H.role('writer')
  .input(z.object({ path: z.string(), title: z.string(), brief: z.string(), brokenLinks: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Write ${i.path} ("${i.title}"): ${i.brief}\nFix these broken links: ${i.brokenLinks.join(', ')}`)
  .intents(['read', 'edit']);

const writer = H.agent('writer', writerRole).model(sonnet).on(docsWorktrees).recalls(sharedTaste, docsExperience).records(docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .argv(i => ['npx', 'link-check', '--json', i.path])
  .on(docsWorktrees)
  .ifInterrupted('rerun');

const docFlow = H.flow('doc-page').for(DocPage).does(async ctx => {
  const page = ctx.unit.data;
  let brokenLinks: string[] = [];
  for (let round = 1; round <= 3; round++) {
    await ctx.move('writing');
    const written = await ctx.run(writer, { path: page.path, title: page.title, brief: page.brief, brokenLinks });
    if (!written.ok) return ctx.fail(written.error);
    await ctx.move('link-checking');
    const checked = await ctx.run(linkCheck, { path: page.path });
    if (!checked.ok) return ctx.fail(checked.error);
    if (checked.value.broken.length === 0) return 'published';
    brokenLinks = checked.value.broken;
  }
  return 'needs-review';
});

const docFiles = folder.files(DocPage, {
  dir: '../docs/pages',
  read: file => ({ path: file.path, title: String(file.frontmatter.title ?? file.path), brief: file.body }),
  write: (_data, state) => ({ status: state }),
});

const docPages = H.lane('doc-pages', DocPage).handler(docFlow).suppliers(docFiles).store(docFiles).wip(2);

export const docs = H.harness('documentation')
  .ledger(sqlite.ledger('../docs/documentation.db'))
  .lanes(docPages)
  .pools(H.pool('claude', sharesOf(0.3), soonestExpiring))
  .scheduler(H.policy.scheduler('oldest-first', view => ({ start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs) })))
  .clients(http.control({
    port: 7402,
    token: H.env('DOCS_CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
  }))
  .observers(markdown.board('../docs/board.md'));
