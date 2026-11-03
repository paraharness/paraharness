import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as cc from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const sharedQuota = sqlite.quota('/home/owner/.harness/shared-quota.sqlite');

const subscriptionOne = cc.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1'), quota: sharedQuota });
const subscriptionTwo = cc.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2'), quota: sharedQuota });
const subscriptionThree = cc.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3'), quota: sharedQuota });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedQuota });

const sonnet = cc.model('claude-sonnet-4-5');
const opus = cc.model('claude-opus-4-1');

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const open = choice.accounts.filter(view => view.eligible && view.usedShare < view.share);
  const subscriptions = open
    .filter(view => view.account.plan === 'subscription')
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity));
  return subscriptions[0]?.account ?? open.find(view => view.account.plan === 'metered')?.account ?? null;
});

const taste = H.memory('taste', 'taste');
const experience = H.memory('experience', 'experience');
const ownerTaste = H.journal('owner-taste', taste, jsonl.memory('/home/owner/.harness/taste.jsonl'));

const todo = H.state('todo', 'pending');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const decomposed = H.state('decomposed', 'waiting');
const due = H.state('due', 'pending');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');

const workItem = z.object({ title: z.string(), description: z.string() });
const bug = H.kind('bug').data(workItem).states(todo, done, abandoned);
const feature = H.kind('feature').data(workItem).states(todo, done, abandoned);
const epic = H.kind('epic').data(workItem).states(todo, decomposed, done, abandoned);
const heartbeat = H.kind('service-heartbeat').data(z.object({ service: z.string() })).states(due, healthy, unhealthy);

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()), ownerAnswer: z.string() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(i => `Build: ${i.title}\n${i.description}\nOpen deficits: ${i.deficits.join('; ')}\nOwner answer: ${i.ownerAnswer}`)
  .intents(['read', 'edit', 'execute']);
const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit the change for "${i.title}". Builder says: ${i.summary}. List deficits.`)
  .intents(['read', 'execute']);
const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(i => `Decompose the epic "${i.title}" into features.\n${i.description}`);

const codingExperience = H.journal('coding-experience', experience, jsonl.memory('coding/.harness/experience.jsonl'));

const worktrees = git.worktree('product-repo', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees);

const cheaperUntilItSlips = H.policy.model('cheaper-until-it-slips', choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: sonnet, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder', builderRole)
  .model(cheaperUntilItSlips)
  .on(worktrees)
  .recalls(codingExperience, ownerTaste)
  .guards(cc.fileLeases(), cc.stopCheck(projectChecks));
const auditor = H.seat('auditor', auditorRole).model(opus).on(worktrees).recalls(codingExperience).records(codingExperience);
const planner = H.seat('planner', plannerRole).model(opus).recalls(ownerTaste);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() })).about(z.object({ question: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    let ownerAnswer = '';
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.call(builder, { title, description, deficits, ownerAnswer });
      if (!built.ok) return ctx.fail(built.error);
      const question = built.value.question;
      if (question !== undefined) {
        const decided = await ctx.halt(ownerDecision, question, { question });
        ownerAnswer = decided.answer;
        continue;
      }
      const audit = await ctx.call(auditor, { title, description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`);
  });

const serviceProbe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./scripts/probe.sh', i.service])
  .on(local);

const checkHeartbeat = H.flow('check-heartbeat').for(heartbeat).does(async ctx => {
  const probe = await ctx.call(serviceProbe, { service: ctx.unit.data.service });
  return probe.ok ? 'healthy' : 'unhealthy';
});

const trackerKey = H.env('LINEAR_API_KEY');
const bugTracker = linear.tracker(bug, {
  apiKey: trackerKey,
  team: 'PROD',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { todo: 'Todo', done: 'Done', abandoned: 'Canceled' },
});
const featureTracker = linear.tracker(feature, {
  apiKey: trackerKey,
  team: 'PROD',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { todo: 'Todo', done: 'Done', abandoned: 'Canceled' },
});
const epicTracker = linear.tracker(epic, {
  apiKey: trackerKey,
  team: 'PROD',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { todo: 'Todo', decomposed: 'In Progress', done: 'Done', abandoned: 'Canceled' },
});
const bugFolder = folder.files(bug, {
  dir: 'bugs',
  read: file => ({ title: String(file.frontmatter.title ?? file.path), description: file.body }),
});

const threeRetries = H.retry('three-retries', { retries: 3, backoff: { initialMs: 60_000, factor: 2 } });

const heartbeats = H.lane('heartbeats', heartbeat)
  .handler(checkHeartbeat)
  .suppliers(H.clock('every-five-minutes', heartbeat, { every: { minutes: 5 } }, () => [
    { create: { service: 'api' } },
    { create: { service: 'worker' } },
  ]));
const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2)
  .retry(threeRetries, 'abandoned');
const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker)
  .retry(threeRetries, 'abandoned');

const decomposeEpic = H.flow('decompose-epic').for(epic).does(async ctx => {
  const plan = await ctx.call(planner, ctx.unit.data);
  if (!plan.ok) return ctx.fail(plan.error);
  const children = await ctx.spawn(features, plan.value.features);
  const finished = await ctx.wait('decomposed', { children });
  return finished.every(child => child.state === 'done') ? 'done' : 'abandoned';
});

const epics = H.lane('epics', epic)
  .handler(decomposeEpic)
  .suppliers(epicTracker)
  .store(epicTracker)
  .wip(1)
  .retry(threeRetries, 'abandoned');

const unhealthyServiceFilesBug = H.trigger('unhealthy-service-files-bug', H.on.enters(heartbeat, 'unhealthy'), (event, act) =>
  act.create(bugs, {
    title: `${event.unit.data.service} heartbeat failed`,
    description: `The heartbeat for ${event.unit.data.service} failed at ${event.at.toISOString()}.`,
  })
);

const featureStarvationMs = 2 * 3_600_000;
const priority = (unit: PendingView): number =>
  unit.is(heartbeat) ? 0
  : unit.is(bug) ? 1
  : unit.is(feature) ? (unit.waitedMs > featureStarvationMs ? 0.5 : 2)
  : 3;

const heartbeatsBugsFeaturesEpics = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => priority(a) - priority(b)),
}));

const productionProbe = H.command('production-health-probe')
  .argv(() => ['curl', '-fsS', 'https://example.com/healthz'])
  .on(local);

const codingPool = H.pool('coding-subscriptions', [
  { account: subscriptionOne, share: 0.6 },
  { account: subscriptionTwo, share: 0.6 },
  { account: subscriptionThree, share: 0.6 },
  { account: apiAccount, share: 1 },
], soonestExpiringFirst);

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('coding/.harness/ledger.sqlite'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(codingPool)
  .triggers(unhealthyServiceFilesBug)
  .scheduler(heartbeatsBugsFeaturesEpics)
  .clients(cc.supervisor({
    grants: [
      H.ops.readWork,
      H.ops.writeWork,
      H.ops.resolve(ownerDecision, H.parked),
      H.ops.readMemory,
      H.ops.writeMemory,
      H.ops.readTelemetry,
      H.ops.readAccounts,
      H.ops.setShares,
      H.operation('production-health-probe', productionProbe),
    ],
  }))
  .observers(markdown.board('coding/BOARD.md'), markdown.telemetry('coding/TELEMETRY.md'));

const draft = H.state('draft', 'pending');
const published = H.state('published', 'terminal', 'success');
const docAbandoned = H.state('abandoned', 'terminal', 'failure');

const docPage = H.kind('doc-page')
  .data(z.object({ title: z.string(), path: z.string(), body: z.string() }))
  .states(draft, published, docAbandoned);

const docFolder = folder.files(docPage, {
  dir: 'docs',
  read: file => ({ title: String(file.frontmatter.title ?? file.path), path: file.path, body: file.body }),
  key: file => file.path,
});

const docsExperience = H.journal('docs-experience', experience, jsonl.memory('docs/.harness/experience.jsonl'));
const docsRepo = git.worktree('docs-repo', { repo: '.', slots: 2 });

const writerRole = H.role('writer')
  .input(z.object({ title: z.string(), path: z.string(), body: z.string() }))
  .output(z.object({ body: z.string() }))
  .prompt(i => `Revise the page "${i.title}" at ${i.path}:\n${i.body}`)
  .intents(['read', 'edit']);
const writer = H.seat('writer', writerRole).model(sonnet).on(docsRepo).recalls(ownerTaste, docsExperience).records(docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(i => ['npx', 'markdown-link-check', i.path])
  .on(docsRepo);

const writePage = H.flow('write-page').for(docPage).does(async ctx => {
  const written = await ctx.call(writer, ctx.unit.data);
  if (!written.ok) return ctx.fail(written.error);
  await ctx.update({ body: written.value.body });
  const links = await ctx.call(linkCheck, { path: ctx.unit.data.path });
  if (!links.ok) return ctx.fail(links.error);
  return 'published';
});

const docPages = H.lane('doc-pages', docPage)
  .handler(writePage)
  .suppliers(docFolder)
  .store(docFolder)
  .wip(2)
  .retry(H.retry('docs-two-retries', { retries: 2, backoff: { initialMs: 120_000 } }), 'abandoned');

const docsPool = H.pool('docs-subscriptions', [
  { account: subscriptionOne, share: 0.3 },
  { account: subscriptionTwo, share: 0.3 },
  { account: subscriptionThree, share: 0.3 },
], soonestExpiringFirst);

export const documentation = H.harness('documentation')
  .ledger(sqlite.ledger('docs/.harness/ledger.sqlite'))
  .lanes(docPages)
  .pools(docsPool)
  .clients(cc.supervisor({
    grants: [
      H.ops.readWork,
      H.ops.writeWork,
      H.ops.resolve(H.parked),
      H.ops.readMemory,
      H.ops.writeMemory,
      H.ops.readTelemetry,
      H.ops.readAccounts,
    ],
  }))
  .observers(markdown.board('docs/BOARD.md'), markdown.telemetry('docs/TELEMETRY.md'));
