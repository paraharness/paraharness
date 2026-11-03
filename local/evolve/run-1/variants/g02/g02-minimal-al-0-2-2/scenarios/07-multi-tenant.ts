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
import * as markdown from 'harness-dsl/markdown';

const sharedQuota = '~/.harness/accounts.db';
const subscriptionOne = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1') });
const subscriptionTwo = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2') });
const subscriptionThree = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const subscriptions = [subscriptionOne, subscriptionTwo, subscriptionThree];

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', ({ accounts }) => {
  const [first] = accounts
    .filter((view) => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (b.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  if (first === undefined) {
    return accounts.find((view) => view.eligible && view.account.plan === 'metered')?.account ?? null;
  }
  return first.account;
});

const experience = H.memory('experience', 'experience');
const taste = H.memory('taste', 'taste');
const ownerTaste = H.library('owner-taste', taste, jsonl.memory('~/.harness/owner-taste.jsonl'));

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const codingExperience = H.library('coding-experience', experience, jsonl.memory('coding/.harness/experience.jsonl'));

const queued = H.state('queued', 'pending');
const building = H.state('building', 'active');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const decomposing = H.state('decomposing', 'active');
const awaitingFeatures = H.state('awaiting-features', 'waiting');
const due = H.state('due', 'pending');
const probing = H.state('probing', 'active');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');

const ticket = z.object({ title: z.string(), description: z.string() });
const Bug = H.kind('Bug').data(ticket).states(queued, building, done, abandoned);
const Feature = H.kind('Feature').data(ticket).states(queued, building, done, abandoned);
const Epic = H.kind('Epic').data(ticket).states(queued, decomposing, awaitingFeatures, done, abandoned);
const Heartbeat = H.kind('ServiceHeartbeat').data(z.object({ service: z.string() })).states(due, probing, healthy, unhealthy);

const worktree = git.worktree('coding-worktree', { repo: 'coding', slots: 3 });
const local = shell.local('coding-local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktree);

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), notes: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().nullable() }))
  .prompt((work) => `Build: ${work.title}\n${work.description}\nAddress:\n${work.notes.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((work) => `Audit the change for "${work.title}". Builder summary:\n${work.summary}\nList every deficit.`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(ticket)
  .output(z.object({ features: z.array(ticket) }))
  .prompt((epic) => `Decompose this epic into features: ${epic.title}\n${epic.description}`)
  .intents(['read']);

const builderModel = H.policy.model('builder-model', ({ kind, metrics }) => {
  const cheap = metrics.successRate({ kind, model: sonnet, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(worktree)
  .recalls(codingExperience, ownerTaste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .on(worktree)
  .recalls(codingExperience)
  .records(codingExperience);

const planner = H.agent('planner', plannerRole).model(opus).recalls(ownerTaste);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number() }))
  .does(async (ctx) => {
    const { title, description } = ctx.unit.data;
    await ctx.move('building');
    let notes: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title, description, notes });
      if (built.ok === false) return ctx.fail(built.error);
      const question = built.value.question;
      if (question === null) {
        const audit = await ctx.run(auditor, { title, summary: built.value.summary });
        if (audit.ok === false) return ctx.fail(audit.error);
        if (audit.value.deficits.length === 0) return 'done';
        notes = audit.value.deficits;
      } else {
        const decision = await ctx.halt(ownerDecision, question);
        notes = [...notes, `The owner decided: ${decision.answer}`];
      }
    }
    return 'abandoned';
  });

const linearKey = H.env('LINEAR_API_KEY');
const ticketStatuses = { queued: 'Todo', building: 'In Progress', done: 'Done', abandoned: 'Canceled' };

const bugTracker = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'CORE',
  label: 'bug',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: ticketStatuses,
});
const bugFolder = folder.files(Bug, {
  dir: 'coding/bugs',
  read: (file) => ({ title: String(file.frontmatter['title'] ?? file.path), description: file.body }),
});
const featureTracker = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'CORE',
  label: 'feature',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: ticketStatuses,
});
const epicTracker = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'CORE',
  label: 'epic',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: { queued: 'Todo', decomposing: 'In Progress', 'awaiting-features': 'In Progress', done: 'Done', abandoned: 'Canceled' },
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

const decomposeEpic = H.flow('decompose-epic').for(Epic).does(async (ctx) => {
  await ctx.move('decomposing');
  const plan = await ctx.run(planner, ctx.unit.data);
  if (plan.ok === false) return ctx.fail(plan.error);
  const children = await ctx.spawn(features, plan.value.features);
  const finished = await ctx.wait('awaiting-features', { children });
  return finished.every((feature) => feature.state === 'done') ? 'done' : 'abandoned';
});

const epics = H.lane('epics', Epic).handler(decomposeEpic).suppliers(epicTracker).store(epicTracker).wip(1);

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv((target) => ['curl', '-fsS', `https://${target.service}.internal/health`])
  .on(local);

const checkHeartbeat = H.flow('check-heartbeat').for(Heartbeat).does(async (ctx) => {
  await ctx.move('probing');
  const probe = await ctx.run(probeService, { service: ctx.unit.data.service });
  return probe.ok ? 'healthy' : 'unhealthy';
});

const heartbeats = H.lane('heartbeats', Heartbeat)
  .handler(checkHeartbeat)
  .suppliers(H.clock('every-five-minutes', Heartbeat, { every: { minutes: 5 } }, () =>
    ['api', 'web', 'worker'].map((service) => ({ create: { service } }))));

const heartbeatFilesBug = H.trigger('failed-heartbeat-files-bug', H.on.enters(Heartbeat, 'unhealthy'), (event, act) =>
  act.create(bugs, {
    title: `${event.unit.data.service} failed its heartbeat`,
    description: `The heartbeat for ${event.unit.data.service} failed at ${event.at.toISOString()}.`,
  }));

const codingOrder = H.policy.scheduler('coding-order', ({ pending }) => {
  const rank = (unit: PendingView): number =>
    unit.is(Heartbeat) ? 0
      : unit.is(Bug) ? 1
        : unit.is(Feature) ? (unit.waitedMs > 14_400_000 ? 0.5 : 2)
          : 3;
  return { start: [...pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const productionProbe = H.command('production-health-probe')
  .argv(() => ['curl', '-fsS', 'https://app.example.com/health'])
  .on(local);

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('coding/.harness/ledger.db', { sharedQuota }))
  .lanes(heartbeats, bugs, features, epics)
  .pools(H.pool('coding-accounts', [
    ...subscriptions.map((account) => ({ account, share: 0.6 })),
    { account: apiAccount, share: 1 },
  ], soonestExpiringFirst))
  .triggers(heartbeatFilesBug)
  .scheduler(codingOrder)
  .clients(claudeCode.supervisor({
    grants: [
      H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory,
      H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares,
      H.operation('production-health-probe', productionProbe),
    ],
  }))
  .observers(markdown.board('coding/BOARD.md'), markdown.telemetry('coding/TELEMETRY.md'));

const docsExperience = H.library('docs-experience', experience, jsonl.memory('docs/.harness/experience.jsonl'));

const drafted = H.state('drafted', 'pending');
const writing = H.state('writing', 'active');
const published = H.state('published', 'terminal', 'success');
const brokenLinks = H.state('broken-links', 'terminal', 'failure');

const DocPage = H.kind('DocPage')
  .data(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .states(drafted, writing, published, brokenLinks);

const docsWorktree = git.worktree('docs-worktree', { repo: 'docs', slots: 2 });

const writerRole = H.role('writer')
  .input(z.object({ path: z.string(), title: z.string(), linkErrors: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt((page) => `Write or revise ${page.path} ("${page.title}"). Fix these broken links if any:\n${page.linkErrors}`)
  .intents(['read', 'edit']);

const writer = H.agent('writer', writerRole).model(sonnet).on(docsWorktree).recalls(ownerTaste, docsExperience).records(docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv((page) => ['lychee', '--offline', page.path])
  .on(docsWorktree);

const writePage = H.flow('write-page').for(DocPage).does(async (ctx) => {
  const { path, title } = ctx.unit.data;
  await ctx.move('writing');
  let linkErrors = '';
  for (let round = 1; round <= 2; round += 1) {
    const written = await ctx.run(writer, { path, title, linkErrors });
    if (written.ok === false) return ctx.fail(written.error);
    const checked = await ctx.run(linkCheck, { path });
    if (checked.ok) return 'published';
    linkErrors = checked.error;
  }
  return 'broken-links';
});

const docFolder = folder.files(DocPage, {
  dir: 'docs/pages',
  read: (file) => ({ path: file.path, title: String(file.frontmatter['title'] ?? file.path), body: file.body }),
});

const pages = H.lane('pages', DocPage).handler(writePage).suppliers(docFolder).store(docFolder);

export const documentation = H.harness('documentation')
  .ledger(sqlite.ledger('docs/.harness/ledger.db', { sharedQuota }))
  .lanes(pages)
  .pools(H.pool('docs-accounts', subscriptions.map((account) => ({ account, share: 0.3 })), soonestExpiringFirst))
  .scheduler(H.policy.scheduler('oldest-first', ({ pending }) => ({
    start: [...pending].sort((a, b) => b.waitedMs - a.waitedMs),
  })))
  .clients(claudeCode.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts],
  }))
  .observers(markdown.board('docs/BOARD.md'));
