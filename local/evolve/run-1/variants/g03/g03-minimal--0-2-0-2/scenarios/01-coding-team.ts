import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const areaSchema = z.enum(['payments', 'auth', 'general']);
type Area = z.infer<typeof areaSchema>;
const area = H.facet('area', ['payments', 'auth', 'general']);
const areaOf = (text: string): Area =>
  /payment|invoice|refund/i.test(text) ? 'payments' : /auth|login|session/i.test(text) ? 'auth' : 'general';

const todo = H.state('todo', 'pending');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');

const bugSchema = z.object({ title: z.string(), description: z.string(), area: areaSchema });
type BugData = z.infer<typeof bugSchema>;
const Bug = H.kind('Bug').data(bugSchema).states(todo, done, abandoned).failsTo('abandoned');

const Feature = H.kind('Feature')
  .data(z.object({ title: z.string(), description: z.string(), area: areaSchema, epic: z.string().optional() }))
  .states(todo, done, abandoned)
  .failsTo('abandoned');

const Epic = H.kind('Epic')
  .data(z.object({ title: z.string(), description: z.string(), area: areaSchema }))
  .states(
    H.state('proposed', 'pending'),
    H.state('in-progress', 'waiting'),
    H.state('checking', 'pending'),
    done,
    abandoned
  );

const Heartbeat = H.kind('ServiceHeartbeat')
  .data(z.object({ service: z.string() }))
  .states(H.state('checking', 'pending'), H.state('healthy', 'terminal', 'success'), H.state('down', 'terminal', 'failure'));

const experienceKind = H.memory('experience', 'experience');
const tasteKind = H.memory('taste', 'taste');
const experience = H.archive('team-experience', experienceKind, jsonl.memory('memory/experience.jsonl'));
const taste = H.archive('owner-taste', tasteKind, jsonl.memory('memory/taste.jsonl'));
const builderBriefing = H.briefing('builder-briefing', [experience, taste]);
const auditorBriefing = H.briefing('auditor-briefing', [experience]);
const plannerBriefing = H.briefing('planner-briefing', [taste]);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const builderModel = H.policy.model('cheaper-until-it-slips', ({ kind, metrics }) => {
  const cheap = metrics.successRate({ kind, model: sonnet, days: 14 });
  const slipping = cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85;
  return slipping ? opus : sonnet;
});

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', ({ accounts }) => {
  const subscriptions = accounts
    .filter((view) => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
    .sort(
      (a, b) =>
        (a.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY) - (b.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY)
    );
  const first = subscriptions[0];
  if (first) return first.account;
  const metered = accounts.find((view) => view.eligible && view.account.plan === 'metered');
  return metered ? metered.account : null;
});

const claudePool = H.pool(
  'claude',
  [
    { account: claudeCode.subscription('max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') }), share: 0.5 },
    { account: claudeCode.subscription('max-2', { token: H.env('CLAUDE_MAX_2_TOKEN') }), share: 0.3 },
    { account: claudeCode.subscription('max-3', { token: H.env('CLAUDE_MAX_3_TOKEN') }), share: 0.2 },
    { account: anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
  ],
  soonestExpiringFirst
);

const worktree = git.worktree('worktree', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktree).recovers('rerun');

const build = H.role('build')
  .input(z.object({ task: z.string(), feedback: z.array(z.string()), ownerAnswer: z.string().optional() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt((input) =>
    [
      input.task,
      ...input.feedback.map((deficit) => `Fix this deficit: ${deficit}`),
      input.ownerAnswer ? `The owner decided: ${input.ownerAnswer}` : '',
    ].join('\n')
  )
  .intents(['read', 'edit', 'execute']);

const audit = H.role('audit')
  .input(z.object({ task: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((input) => `Audit the work for:\n${input.task}\n\nBuilder summary:\n${input.summary}\nList every deficit.`)
  .intents(['read', 'execute']);

const plan = H.role('plan')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt((input) => `Decompose this epic into features:\n${input.title}\n\n${input.description}`)
  .intents(['read']);

const builder = H.agent('builder', build)
  .model(builderModel)
  .on(worktree)
  .recalls(builderBriefing)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.agent('auditor', audit).model(sonnet).on(worktree).recalls(auditorBriefing).records(experience);

const planner = H.agent('planner', plan).model(opus).recalls(plannerBriefing);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() }));

const ticket = H.flow('ticket')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async (ctx) => {
    const data = ctx.unit.data;
    ctx.facet(area, data.area);
    const task = `${data.title}\n\n${data.description}`;
    let feedback: string[] = [];
    let ownerAnswer: string | undefined;
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { task, feedback, ownerAnswer });
      if (!built.ok) return ctx.fail(built.error);
      const question = built.value.question;
      if (question !== undefined) {
        const decision = await ctx.halt(ownerDecision, question);
        ownerAnswer = decision.answer;
        continue;
      }
      const audited = await ctx.run(auditor, { task, summary: built.value.summary });
      if (!audited.ok) return ctx.fail(audited.error);
      if (audited.value.deficits.length === 0) return 'done';
      feedback = audited.value.deficits;
    }
    return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`);
  });

const ticketStatuses = { todo: 'Todo', done: 'Done', abandoned: 'Canceled' };

const bugTracker = linear.tracker(Bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'bug',
  read: (issue) => ({ title: issue.title, description: issue.description, area: areaOf(`${issue.title} ${issue.description}`) }),
  statuses: ticketStatuses,
});

const bugFiles = folder.files(Bug, {
  dir: 'bugs',
  read: (file) => ({
    title: String(file.frontmatter['title'] ?? file.path),
    description: file.body,
    area: areaOf(file.body),
  }),
});

const featureTracker = linear.tracker(Feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'feature',
  read: (issue) => ({
    title: issue.title,
    description: issue.description,
    area: areaOf(`${issue.title} ${issue.description}`),
    epic: issue.parentId,
  }),
  statuses: ticketStatuses,
});

const bugRetry = H.policy.retry('bug-retry', ({ failures }) => (failures >= 2 ? 'stop' : { retryInMs: 15 * 60_000 }));
const featureRetry = H.policy.retry('feature-retry', ({ failures }) => (failures >= 2 ? 'stop' : { retryInMs: 30 * 60_000 }));

const bugs = H.lane('bugs', Bug)
  .handler(ticket, { rounds: 3 })
  .suppliers(bugTracker, bugFiles, H.operator)
  .store(bugTracker)
  .wip(2)
  .retry(bugRetry);

const features = H.lane('features', Feature)
  .handler(ticket, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker)
  .retry(featureRetry);

const epicFlow = H.flow('epic')
  .for(Epic)
  .does(async (ctx) => {
    const epic = ctx.unit.data;
    ctx.facet(area, epic.area);
    const planned = await ctx.run(planner, { title: epic.title, description: epic.description });
    if (!planned.ok) return ctx.fail(planned.error);
    await ctx.spawn(
      features,
      planned.value.features.map((feature) => ({
        title: feature.title,
        description: feature.description,
        area: epic.area,
        epic: ctx.unit.key,
      }))
    );
    return ctx.wait('in-progress', { children: true, then: 'checking' });
  })
  .phase('checking', async (ctx) => {
    const children = await ctx.children(features);
    if (children.some((child) => child.position !== 'terminal')) {
      return ctx.wait('in-progress', { children: true, then: 'checking' });
    }
    return children.every((child) => child.state === 'done') ? 'done' : 'abandoned';
  });

const epicTracker = linear.tracker(Epic, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'epic',
  read: (issue) => ({ title: issue.title, description: issue.description, area: areaOf(`${issue.title} ${issue.description}`) }),
  statuses: {
    proposed: 'Backlog',
    'in-progress': 'In Progress',
    checking: 'In Review',
    done: 'Done',
    abandoned: 'Canceled',
  },
});

const epics = H.lane('epics', Epic).handler(epicFlow).suppliers(epicTracker).store(epicTracker).wip(1);

const services = ['api', 'web', 'worker'];

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv((input) => ['curl', '-fsS', '--max-time', '10', `https://${input.service}.internal/health`])
  .on(local)
  .recovers('rerun');

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .does(async (ctx) => {
    const probed = await ctx.run(probeService, { service: ctx.unit.data.service });
    return probed.ok ? 'healthy' : 'down';
  });

const heartbeats = H.lane('heartbeats', Heartbeat)
  .handler(heartbeatFlow)
  .suppliers(
    H.clock('heartbeat-clock', Heartbeat, { every: { minutes: 5 } }, (tick) =>
      services.map((service) => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
    )
  );

const heartbeatBug = (service: string): BugData => ({
  title: `Heartbeat failing for ${service}`,
  description: `The ${service} health probe failed. Find the cause and restore the service check.`,
  area: 'general',
});

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug', H.on.enters(Heartbeat, 'down'), (event, act) =>
  act.create(bugs, heartbeatBug(event.unit.data.service), `heartbeat-${event.unit.data.service}`)
);

const starvationMs = 4 * 60 * 60_000;

const priority = H.policy.scheduler('heartbeats-bugs-features-epics', (view) => {
  const rank = (unit: PendingView): number => {
    if (unit.lane === heartbeats.name) return 0;
    if (unit.lane === features.name && unit.waitedMs > starvationMs) return 1;
    if (unit.lane === bugs.name) return 2;
    if (unit.lane === features.name) return 3;
    return 4;
  };
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const productionProbe = H.command('production-health-probe')
  .argv(() => ['curl', '-fsS', 'https://app.example.com/health'])
  .on(local)
  .recovers('rerun');

const supervisor = claudeCode.supervisor({
  grants: [
    H.ops.readWork,
    H.ops.writeWork,
    H.ops.resolveHalts,
    H.ops.writeMemory,
    H.ops.readTelemetry,
    H.ops.readAccounts,
    H.ops.setShares,
    H.operation('probe-production', productionProbe),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(priority)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
