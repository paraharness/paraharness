import { H, type PendingView, type SupplyOf } from 'harness-dsl';
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

const sharedQuota = sqlite.quota('~/.harness/shared/quota.db');

const subscriptionOne = claudeCode.subscription('max-one', { token: H.env('CLAUDE_MAX_ONE_TOKEN'), quota: sharedQuota });
const subscriptionTwo = claudeCode.subscription('max-two', { token: H.env('CLAUDE_MAX_TWO_TOKEN'), quota: sharedQuota });
const subscriptionThree = claudeCode.subscription('max-three', { token: H.env('CLAUDE_MAX_THREE_TOKEN'), quota: sharedQuota });
const apiAccount = anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedQuota });

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const eligible = choice.accounts.filter(view => view.eligible && view.usedShare < view.share);
  const subscriptions = eligible
    .filter(view => view.account.plan === 'subscription')
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY) - (b.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY));
  const chosen = subscriptions.length > 0 ? subscriptions[0] : eligible.find(view => view.account.plan === 'metered');
  return chosen ? chosen.account : null;
});

const sharedSubscriptions = (projectShare: number) =>
  H.pool(
    'shared-subscriptions',
    [
      { account: subscriptionOne, share: projectShare },
      { account: subscriptionTwo, share: projectShare },
      { account: subscriptionThree, share: projectShare },
      { account: apiAccount, share: 1 }
    ],
    soonestExpiringFirst
  );

const taste = H.memory('taste', 'taste');
const experience = H.memory('experience', 'experience');
const ownerTaste = H.library('owner-taste', taste, jsonl.memory('~/.harness/shared/taste.jsonl'));

const ownerGrants = [
  H.ops.readWork,
  H.ops.writeWork,
  H.ops.resolveHalts,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares
];

const todo = H.state('todo', 'pending');
const decomposed = H.state('decomposed', 'waiting');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const due = H.state('due', 'pending');
const healthy = H.state('ok', 'terminal', 'success');
const down = H.state('down', 'terminal', 'failure');

const workItem = z.object({ title: z.string(), description: z.string() });

const epic = H.kind('Epic').data(workItem).states(todo, decomposed, done, abandoned);
const feature = H.kind('Feature').data(workItem.extend({ parentId: z.string().optional() })).states(todo, done, abandoned);
const bug = H.kind('Bug').data(workItem).states(todo, done, abandoned);
const heartbeat = H.kind('ServiceHeartbeat').data(z.object({ service: z.string() })).states(due, healthy, down);

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), feedback: z.array(z.string()), answer: z.string().optional() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Build: ${input.title}\n${input.description}\nOpen deficits:\n${input.feedback.join('\n')}\nOwner answer: ${input.answer ?? 'none'}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}". Builder summary: ${input.summary}`)
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(workItem) }))
  .prompt(input => `Decompose the epic "${input.title}" into features.\n${input.description}`)
  .intents(['read']);

const repoWorktree = git.worktree('repo-worktree', { repo: '.', slots: 3 });
const localRunner = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(repoWorktree);
const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(input => ['./scripts/probe', input.service])
  .on(localRunner)
  .recovery('rerun');
const productionHealth = H.command('production-health').argv(() => ['./scripts/production-health']).on(localRunner);

const codingExperience = H.library('coding-experience', experience, jsonl.memory('.harness/experience.jsonl'));

const cheapUntilWeak = H.policy.model('cheap-until-weak', [sonnet, opus], choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: sonnet, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder', builderRole)
  .model(cheapUntilWeak)
  .on(repoWorktree)
  .recalls(codingExperience, ownerTaste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));
const auditor = H.seat('auditor', auditorRole).model(opus).on(repoWorktree).recalls(codingExperience).records(codingExperience);
const planner = H.seat('planner', plannerRole).model(opus).recalls(ownerTaste);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    let feedback: string[] = [];
    let answer: string | undefined;
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title: ctx.unit.data.title, description: ctx.unit.data.description, feedback, answer });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question) {
        const decision = await ctx.halt(ownerDecision, built.value.question);
        answer = decision.answer;
        continue;
      }
      const audit = await ctx.run(auditor, { title: ctx.unit.data.title, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      feedback = audit.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`);
  });

const decomposeEpic = H.flow('decompose-epic')
  .for(epic)
  .does(async ctx => {
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return ctx.fail(plan.error);
    const children = await ctx.spawn(
      featureLane,
      plan.value.features.map(item => ({ title: item.title, description: item.description, parentId: ctx.unit.key }))
    );
    const finished = await ctx.wait('decomposed', { children });
    return finished.every(child => child.state === 'done') ? 'done' : 'abandoned';
  });

const checkHeartbeat = H.flow('check-heartbeat')
  .for(heartbeat)
  .does(async ctx => {
    const probe = await ctx.run(probeService, { service: ctx.unit.data.service });
    return probe.ok ? 'ok' : 'down';
  });

const trackerStatuses = { todo: 'Todo', done: 'Done', abandoned: 'Canceled' };

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: trackerStatuses
});
const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description, parentId: issue.parentId }),
  statuses: trackerStatuses
});
const epicTracker = linear.tracker(epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { todo: 'Todo', decomposed: 'In Progress', done: 'Done', abandoned: 'Canceled' }
});
const bugFolder = folder.files(bug, {
  dir: 'bugs',
  read: file => ({ title: String(file.frontmatter.title ?? file.path), description: file.body }),
  key: file => file.path
});

const services = ['api', 'web', 'worker'];
const everyFiveMinutes = H.clock('heartbeat-every-five-minutes', heartbeat, { every: { minutes: 5 } }, () =>
  services.map((service): SupplyOf<typeof heartbeat> => ({ create: { service }, key: `heartbeat-${service}` }))
);

const heartbeatLane = H.lane('heartbeats', heartbeat).handler(checkHeartbeat).suppliers(everyFiveMinutes);
const bugLane = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);
const featureLane = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);
const epicLane = H.lane('epics', epic).handler(decomposeEpic).suppliers(epicTracker).store(epicTracker).wip(1);

const outageFilesBug = H.trigger('outage-files-bug', H.on.enters(heartbeat, 'down'), (event, act) =>
  act.create(bugLane, {
    title: `Service ${event.unit.data.service} failed its heartbeat`,
    description: `The heartbeat for ${event.unit.data.service} failed at ${event.at.toISOString()}.`
  })
);

const laneOrder = [heartbeat.name, bug.name, feature.name, epic.name];
const featureStarvationMs = 2 * 60 * 60 * 1000;
const rankOf = (unit: PendingView) =>
  unit.kind === feature.name && unit.waitedMs > featureStarvationMs ? 0.5 : laneOrder.indexOf(unit.kind);
const codingScheduler = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
  start: [...view.pending].sort((a, b) => rankOf(a) - rankOf(b))
}));

export const codingHarness = H.harness('coding-team')
  .ledger(sqlite.ledger('coding/.harness/ledger.db'))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .pools(sharedSubscriptions(0.6))
  .triggers(outageFilesBug)
  .scheduler(codingScheduler)
  .clients(
    http.control({
      port: 7401,
      token: H.env('CODING_CONTROL_TOKEN'),
      grants: [...ownerGrants, H.operation('production-health-probe', productionHealth)]
    })
  )
  .observers(markdown.board('coding/BOARD.md'), markdown.telemetry('coding/TELEMETRY.md'));

const stale = H.state('stale', 'pending');
const published = H.state('published', 'terminal', 'success');
const broken = H.state('broken', 'terminal', 'failure');

const docPage = H.kind('DocPage').data(z.object({ path: z.string(), title: z.string() })).states(stale, published, broken);

const docsFolder = folder.files(docPage, {
  dir: 'docs',
  read: file => ({ path: file.path, title: String(file.frontmatter.title ?? file.path) }),
  key: file => file.path
});

const docsWorktree = git.worktree('docs-worktree', { repo: '../docs', slots: 2 });

const writerRole = H.role('writer')
  .input(z.object({ path: z.string(), title: z.string(), brokenLinks: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Revise ${input.path} ("${input.title}"). Fix these links: ${input.brokenLinks.join(', ')}`)
  .intents(['read', 'edit']);

const docsExperience = H.library('docs-experience', experience, jsonl.memory('../docs/.harness/experience.jsonl'));
const writer = H.seat('writer', writerRole).model(sonnet).on(docsWorktree).recalls(docsExperience, ownerTaste);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .argv(input => ['./scripts/link-check', '--json', input.path])
  .on(docsWorktree)
  .recovery('rerun');

const writeDocPage = H.flow('write-doc-page')
  .for(docPage)
  .does(async ctx => {
    let brokenLinks: string[] = [];
    for (let round = 1; round <= 2; round += 1) {
      const written = await ctx.run(writer, { path: ctx.unit.data.path, title: ctx.unit.data.title, brokenLinks });
      if (!written.ok) return ctx.fail(written.error);
      const checked = await ctx.run(linkCheck, { path: ctx.unit.data.path });
      if (!checked.ok) return ctx.fail(checked.error);
      if (checked.value.broken.length === 0) return 'published';
      brokenLinks = checked.value.broken;
    }
    return ctx.fail(`links still broken: ${brokenLinks.join(', ')}`);
  });

const docsRetry = H.policy.attemptRetry('docs-retry-twice', view =>
  view.failedAttempts >= 2 ? 'stop' : { retryInMs: 10 * 60 * 1000 }
);

const docsLane = H.lane('docs', docPage).handler(writeDocPage).suppliers(docsFolder).store(docsFolder).retry(docsRetry, 'broken');

export const docsHarness = H.harness('documentation')
  .ledger(sqlite.ledger('../docs/.harness/ledger.db'))
  .lanes(docsLane)
  .pools(sharedSubscriptions(0.3))
  .clients(http.control({ port: 7402, token: H.env('DOCS_CONTROL_TOKEN'), grants: ownerGrants }))
  .observers(markdown.board('../docs/BOARD.md'));
