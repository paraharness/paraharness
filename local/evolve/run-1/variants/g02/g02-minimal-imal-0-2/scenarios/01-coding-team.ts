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

const ticketSchema = z.object({
  title: z.string(),
  body: z.string(),
  areas: z.array(z.string()),
});
const featureSchema = ticketSchema.extend({ epic: z.string().optional() });

const queued = H.state.pending('queued');
const building = H.state.active('building');
const auditing = H.state.active('auditing');
const done = H.state.terminal('done', 'success');
const roundsExhausted = H.state.terminal('rounds-exhausted', 'failure');

const Bug = H.kind('Bug')
  .data(ticketSchema)
  .states([queued, building, auditing, done, roundsExhausted], 'queued');

const Feature = H.kind('Feature')
  .data(featureSchema)
  .states([queued, building, auditing, done, roundsExhausted], 'queued');

const Epic = H.kind('Epic')
  .data(z.object({ title: z.string(), body: z.string() }))
  .states(
    [
      H.state.pending('proposed'),
      H.state.active('planning'),
      H.state.waiting('awaiting-features'),
      H.state.terminal('completed', 'success'),
      H.state.terminal('incomplete', 'failure'),
    ],
    'proposed'
  );

const Heartbeat = H.kind('ServiceHeartbeat')
  .data(z.object({ service: z.string() }))
  .states(
    [
      H.state.pending('due'),
      H.state.active('probing'),
      H.state.terminal('healthy', 'success'),
      H.state.terminal('down', 'failure'),
    ],
    'due'
  );

const payments = H.resource('payments');

const Experience = H.memory('experience', 'fallible');
const Taste = H.memory('taste', 'owner');

const specificFirst = H.policy.recall('specific-then-proven', view =>
  [...view.items]
    .sort(
      (a, b) =>
        b.specificity - a.specificity ||
        (b.trackRecord.value ?? 0.5) - (a.trackRecord.value ?? 0.5)
    )
    .slice(0, 12)
);

const experience = H.library('team-experience', Experience, jsonl.memory('memory/experience.jsonl')).recall(specificFirst);
const taste = H.library('owner-taste', Taste, jsonl.memory('memory/taste.jsonl')).recall(specificFirst);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const builderModel = H.policy.model('cheap-until-below-85', choice => {
  const record = choice.metrics.successRate({ kind: choice.kind, model: sonnet.name, days: 14 });
  const enoughSamples = record.samples >= 20;
  const belowBar = record.value !== null && record.value < 0.85;
  return enoughSamples && belowBar ? opus : sonnet;
});

const worktrees = git.worktree('worktrees', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 2 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).restart('rerun');

const builderRole = H.role('builder')
  .input(
    z.object({
      title: z.string(),
      body: z.string(),
      feedback: z.array(z.string()),
      round: z.number(),
    })
  )
  .output(z.object({ summary: z.string(), files: z.array(z.string()) }))
  .prompt(
    input =>
      `Round ${input.round}. Implement: ${input.title}\n\n${input.body}\n\nOpen deficits:\n${input.feedback.join('\n')}`
  )
  .intents(['read', 'edit', 'execute', 'ask']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string(), files: z.array(z.string()) }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(
    input =>
      `Audit the change for "${input.title}". Builder summary: ${input.summary}. Files: ${input.files.join(', ')}. List every deficit, or none.`
  )
  .intents(['read', 'execute']);

const plannerRole = H.role('planner')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(
    z.object({
      features: z.array(z.object({ title: z.string(), body: z.string(), areas: z.array(z.string()) })),
    })
  )
  .prompt(input => `Decompose the epic "${input.title}" into features.\n\n${input.body}`)
  .intents(['read']);

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(worktrees)
  .recalls(experience, taste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .on(worktrees)
  .recalls(experience)
  .records(experience);

const planner = H.agent('planner', plannerRole).model(opus).recalls(taste);

const ticketFlow = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int() }))
  .does(async ctx => {
    const { title, body, areas } = ctx.unit.data;
    const scope = { skills: areas, resources: areas.includes('payments') ? [payments] : [] };
    let feedback: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round++) {
      await ctx.move('building');
      const built = await ctx.run(builder, { title, body, feedback, round }, { scope });
      if (!built.ok) return ctx.fail(built.error);
      await ctx.move('auditing');
      const audit = await ctx.run(
        auditor,
        { title, summary: built.value.summary, files: built.value.files },
        { scope }
      );
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      feedback = audit.value.deficits;
    }
    return 'rounds-exhausted';
  });

const healthCheck = H.command('service-health')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.internal/health`])
  .on(local)
  .restart('rerun');

const heartbeatFlow = H.flow('heartbeat')
  .for(Heartbeat)
  .does(async ctx => {
    await ctx.move('probing');
    const probe = await ctx.run(healthCheck, { service: ctx.unit.data.service });
    return probe.ok ? 'healthy' : 'down';
  });

const linearKey = H.env('LINEAR_API_KEY');

const ticketStatuses = {
  queued: 'Todo',
  building: 'In Progress',
  auditing: 'In Review',
  done: 'Done',
  'rounds-exhausted': 'Needs Owner',
};

const bugTracker = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'bug',
  read: issue => ({ title: issue.title, body: issue.description, areas: [...issue.labels] }),
  statuses: ticketStatuses,
});

const featureTracker = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'feature',
  read: issue => ({
    title: issue.title,
    body: issue.description,
    areas: [...issue.labels],
    epic: issue.parentId,
  }),
  statuses: ticketStatuses,
});

const epicTracker = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'PRODUCT',
  label: 'epic',
  read: issue => ({ title: issue.title, body: issue.description }),
  statuses: {
    proposed: 'Todo',
    planning: 'In Progress',
    'awaiting-features': 'In Progress',
    completed: 'Done',
    incomplete: 'Needs Owner',
  },
});

const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: file => ({
    title: typeof file.frontmatter.title === 'string' ? file.frontmatter.title : file.path,
    body: file.body,
    areas: [],
  }),
});

const services = ['api', 'web', 'worker'];

const heartbeatClock = H.timetable('every-five-minutes', Heartbeat, { every: { minutes: 5 } }, tick =>
  services.map(service => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
);

const bugs = H.lane('bugs', Bug)
  .handler(ticketFlow, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', Feature)
  .handler(ticketFlow, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const epicFlow = H.flow('decompose-epic')
  .for(Epic)
  .does(async ctx => {
    await ctx.move('planning');
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, body: ctx.unit.data.body });
    if (!plan.ok) return ctx.fail(plan.error);
    await ctx.spawn(
      features,
      plan.value.features.map(feature => ({ ...feature, epic: ctx.unit.key }))
    );
    await ctx.wait('awaiting-features', { children: true });
    const children = await ctx.children();
    return children.every(child => child.verdict === 'success') ? 'completed' : 'incomplete';
  });

const epics = H.lane('epics', Epic).handler(epicFlow).suppliers(epicTracker).store(epicTracker).wip(1);

const heartbeats = H.lane('heartbeats', Heartbeat).handler(heartbeatFlow).suppliers(heartbeatClock);

const heartbeatDown = H.trigger('down-heartbeat-files-bug', H.on.enters(Heartbeat, 'down'), (event, act) =>
  act.create(
    bugs,
    {
      title: `Service ${event.unit.data.service} failed its heartbeat`,
      body: `Heartbeat ${event.unit.key} ended down at ${event.at.toISOString()}.`,
      areas: ['operations', event.unit.data.service],
    },
    { oneOpenPer: `heartbeat:${event.unit.data.service}` }
  )
);

const claudePool = H.pool(
  'claude',
  [
    { account: claudeCode.subscription('max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') }), share: 0.8 },
    { account: claudeCode.subscription('max-2', { token: H.env('CLAUDE_MAX_2_TOKEN') }), share: 0.8 },
    { account: claudeCode.subscription('max-3', { token: H.env('CLAUDE_MAX_3_TOKEN') }), share: 0.5 },
    { account: anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
  ],
  H.policy.account('soonest-expiring-then-api', choice => {
    const subscriptions = choice.accounts
      .filter(view => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share)
      .sort(
        (a, b) =>
          (a.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY) -
          (b.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY)
      );
    const soonest = subscriptions[0];
    if (soonest) return soonest.account;
    const metered = choice.accounts.find(view => view.eligible && view.account.plan === 'metered');
    return metered ? metered.account : null;
  })
);

const kindOrder = [Heartbeat.name, Bug.name, Feature.name, Epic.name];
const featureStarvationMs = 4 * 60 * 60 * 1000;

const teamScheduler = H.policy.scheduler('heartbeats-bugs-features-epics', view => {
  const rank = (unit: PendingView) =>
    unit.kind === Feature.name && unit.waitedMs > featureStarvationMs ? 1 : kindOrder.indexOf(unit.kind);
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const productionProbe = H.command('production-health-probe')
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .argv(() => ['scripts/probe-production.sh', '--json'])
  .on(local)
  .restart('rerun');

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
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(heartbeats, bugs, features, epics)
  .pools(claudePool)
  .triggers(heartbeatDown)
  .scheduler(teamScheduler)
  .clients(supervisor)
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
