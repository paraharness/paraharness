import { z } from 'zod';
import { H } from 'harness-dsl';
import type { AccountPolicy, PendingView } from 'harness-dsl';
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

const sharedSubscriptions = [
  claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') }),
  claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN') }),
  claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN') }),
];
const sharedQuota = sqlite.quota('~/.harness/shared-quota.db');
const ownerTaste = H.memory('owner-taste', 'taste');
const sharedTasteArchive = H.archive('owner-taste', ownerTaste, jsonl.memory('~/.harness/owner-taste.jsonl'));

function soonestExpiring(name: string): AccountPolicy {
  return H.policy.account(name, choice => {
    const subscriptions = choice.accounts
      .filter(view => view.eligible && view.account.plan === 'subscription')
      .sort((x, y) => (x.windowEndsAt ? x.windowEndsAt.getTime() : Number.POSITIVE_INFINITY) - (y.windowEndsAt ? y.windowEndsAt.getTime() : Number.POSITIVE_INFINITY));
    for (const view of subscriptions) return view.account;
    for (const view of choice.accounts) if (view.eligible && view.account.plan === 'metered') return view.account;
    return null;
  });
}

const cheapModel = claudeCode.model('claude-sonnet-4');
const strongModel = claudeCode.model('claude-opus-4');

const backlog = H.state('backlog', 'pending');
const building = H.state('building', 'active');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');
const planned = H.state('planned', 'pending');
const decomposing = H.state('decomposing', 'active');
const inProgress = H.state('in-progress', 'waiting');
const closing = H.state('closing', 'pending');
const heartbeatDue = H.state('heartbeat-due', 'pending');
const checking = H.state('checking', 'active');
const healthy = H.state('healthy', 'terminal', 'success');
const unhealthy = H.state('unhealthy', 'terminal', 'failure');

const ticketSchema = z.object({ title: z.string(), description: z.string() });
const Bug = H.kind('Bug').data(ticketSchema).states(backlog, building, done, abandoned);
const Feature = H.kind('Feature').data(ticketSchema).states(backlog, building, done, abandoned);
const Epic = H.kind('Epic').data(ticketSchema).states(planned, decomposing, inProgress, closing, done, abandoned);
const ServiceHeartbeat = H.kind('ServiceHeartbeat').data(z.object({ service: z.string() })).states(heartbeatDue, checking, healthy, unhealthy);

const codingExperience = H.memory('coding-experience', 'experience');
const codingExperienceArchive = H.archive('coding-experience', codingExperience, jsonl.memory('coding-team/experience.jsonl'));
const builderBriefing = H.briefing('builder-briefing', [codingExperienceArchive, sharedTasteArchive]);
const auditorBriefing = H.briefing('auditor-briefing', [codingExperienceArchive]);
const plannerBriefing = H.briefing('planner-briefing', [sharedTasteArchive]);

const codeWorktree = git.worktree('code-worktree', { repo: '.', slots: 3 });
const local = shell.local('local', { slots: 4 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(codeWorktree).recovers('rerun');
const healthCheck = H.command('health-check')
  .input(z.object({ service: z.string() }))
  .argv(target => ['curl', '-fsS', `https://${target.service}.internal/health`])
  .on(local)
  .recovers('rerun');
const productionProbe = H.command('production-probe').argv(() => ['curl', '-fsS', 'https://app.example.com/health']).on(local).recovers('rerun');

const builderRole = H.role('builder')
  .input(z.object({ task: z.string(), round: z.number() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(work => `Round ${work.round}. Implement:\n${work.task}`)
  .intents(['read', 'edit', 'execute']);
const auditorRole = H.role('auditor')
  .input(z.object({ task: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(work => `Audit the change for:\n${work.task}\nBuilder summary:\n${work.summary}`)
  .intents(['read', 'execute']);
const plannerRole = H.role('planner')
  .input(ticketSchema)
  .output(z.object({ features: z.array(ticketSchema) }))
  .prompt(epic => `Decompose the epic "${epic.title}" into features.\n${epic.description}`)
  .intents(['read']);

const builderModel = H.policy.model('builder-model', choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, model: cheapModel, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? strongModel : cheapModel;
});

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(codeWorktree)
  .recalls(builderBriefing)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));
const auditor = H.agent('auditor', auditorRole).model(strongModel).on(codeWorktree).recalls(auditorBriefing).records(codingExperienceArchive);
const planner = H.agent('planner', plannerRole).model(strongModel).recalls(plannerBriefing);

const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() }));

const ticketFlow = H.flow('ticket')
  .for(Feature, Bug)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    await ctx.move('building');
    let brief = `${ctx.unit.data.title}\n${ctx.unit.data.description}`;
    for (let round = 1; round <= ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { task: brief, round });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question) {
        const decision = await ctx.halt(ownerDecision, built.value.question);
        brief = `${brief}\nOwner decided: ${decision.answer}`;
        continue;
      }
      const audit = await ctx.run(auditor, { task: brief, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      brief = `${brief}\nDeficits to fix:\n${audit.value.deficits.join('\n')}`;
    }
    return ctx.fail('rounds exhausted with deficits remaining');
  });

const heartbeatFlow = H.flow('heartbeat').for(ServiceHeartbeat).does(async ctx => {
  await ctx.move('checking');
  const probe = await ctx.run(healthCheck, { service: ctx.unit.data.service });
  return probe.ok ? 'healthy' : 'unhealthy';
});

const linearKey = H.env('LINEAR_API_KEY');
const ticketStatuses = { backlog: 'Todo', building: 'In Progress', done: 'Done', abandoned: 'Canceled' };
const bugTracker = linear.tracker(Bug, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: ticketStatuses,
});
const featureTracker = linear.tracker(Feature, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: ticketStatuses,
});
const epicTracker = linear.tracker(Epic, {
  apiKey: linearKey,
  team: 'ENG',
  label: 'epic',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: { planned: 'Todo', decomposing: 'In Progress', 'in-progress': 'In Progress', closing: 'In Review', done: 'Done', abandoned: 'Canceled' },
});
const bugFolder = folder.files(Bug, {
  dir: 'bugs',
  read: file => {
    const title = file.frontmatter['title'];
    return { title: typeof title === 'string' ? title : file.path, description: file.body };
  },
});

const bugLane = H.lane('bugs', Bug).handler(ticketFlow, { rounds: 3 }).suppliers(bugTracker, bugFolder, H.operator).store(bugTracker).wip(2);
const featureLane = H.lane('features', Feature).handler(ticketFlow, { rounds: 5 }).suppliers(featureTracker, H.operator).store(featureTracker);

const epicFlow = H.flow('epic')
  .for(Epic)
  .does(async ctx => {
    await ctx.move('decomposing');
    const plan = await ctx.run(planner, { title: ctx.unit.data.title, description: ctx.unit.data.description });
    if (!plan.ok) return ctx.fail(plan.error);
    await ctx.spawn(featureLane, plan.value.features);
    return ctx.wait('in-progress', { children: true, then: 'closing' });
  })
  .phase('closing', async ctx => {
    const features = await ctx.children(featureLane);
    if (features.some(feature => feature.position !== 'terminal')) return ctx.wait('in-progress', { children: true, then: 'closing' });
    return features.every(feature => feature.state === 'done') ? 'done' : 'abandoned';
  });
const epicLane = H.lane('epics', Epic).handler(epicFlow).suppliers(epicTracker).store(epicTracker).wip(1);

const services = ['api', 'web', 'worker'];
const heartbeatLane = H.lane('heartbeats', ServiceHeartbeat)
  .handler(heartbeatFlow)
  .suppliers(
    H.clock('heartbeat-clock', ServiceHeartbeat, { every: { minutes: 5 } }, tick =>
      services.map(service => ({ create: { service }, key: `${service}-${tick.now.toISOString()}` }))
    )
  );

const heartbeatFilesBug = H.trigger('unhealthy-heartbeat-files-bug', H.on.enters(ServiceHeartbeat, 'unhealthy'), (event, act) =>
  act.create(
    bugLane,
    { title: `Service ${event.unit.data.service} failed its heartbeat`, description: `Heartbeat ${event.unit.key} ended unhealthy at ${event.at.toISOString()}.` },
    `heartbeat-${event.unit.data.service}`
  )
);

const laneOrder = [heartbeatLane.name, bugLane.name, featureLane.name, epicLane.name];
const featureStarvationMs = 4 * 3_600_000;
function priority(unit: PendingView): number {
  if (unit.lane === featureLane.name && unit.waitedMs > featureStarvationMs) return 0.5;
  return laneOrder.indexOf(unit.lane);
}
const codingScheduler = H.policy.scheduler('coding-priority', view => ({
  start: [...view.pending].sort((x, y) => priority(x) - priority(y) || y.waitedMs - x.waitedMs),
}));

const apiAccount = anthropic.account('coding-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const codingPool = H.pool(
  'coding-accounts',
  [...sharedSubscriptions.map(account => ({ account, share: 0.6 })), { account: apiAccount, share: 1 }],
  soonestExpiring('coding-drain-soonest-expiring')
);

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('coding-team/ledger.db', { quota: sharedQuota }))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .pools(codingPool)
  .triggers(heartbeatFilesBug)
  .scheduler(codingScheduler)
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry,
        H.ops.readAccounts, H.ops.setShares, H.operation('production-health', productionProbe),
      ],
    }),
    http.control({
      port: 7401,
      token: H.env('CODING_CONTROL_TOKEN'),
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
    })
  )
  .observers(markdown.board('coding-team/board.md'), markdown.telemetry('coding-team/telemetry.md'));

const docPending = H.state('doc-pending', 'pending');
const writing = H.state('writing', 'active');
const published = H.state('published', 'terminal', 'success');
const DocPage = H.kind('DocPage').data(z.object({ path: z.string(), title: z.string(), body: z.string() })).states(docPending, writing, published);

const docsExperience = H.memory('docs-experience', 'experience');
const docsExperienceArchive = H.archive('docs-experience', docsExperience, jsonl.memory('docs/experience.jsonl'));
const writerBriefing = H.briefing('writer-briefing', [docsExperienceArchive, sharedTasteArchive]);

const docsWorktree = git.worktree('docs-worktree', { repo: '../docs', slots: 2 });

const writerRole = H.role('writer')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ body: z.string() }))
  .prompt(page => `Revise the documentation page "${page.title}".\n\n${page.body}`)
  .intents(['read', 'edit']);
const writer = H.agent('writer', writerRole).model(cheapModel).on(docsWorktree).recalls(writerBriefing).records(docsExperienceArchive);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(page => ['lychee', page.path])
  .on(docsWorktree)
  .recovers('rerun');

const docFlow = H.flow('doc-page').for(DocPage).does(async ctx => {
  await ctx.move('writing');
  const revised = await ctx.run(writer, { title: ctx.unit.data.title, body: ctx.unit.data.body });
  if (!revised.ok) return ctx.fail(revised.error);
  await ctx.update({ body: revised.value.body });
  const links = await ctx.run(linkCheck, { path: ctx.unit.data.path });
  if (!links.ok) return ctx.fail(links.error);
  return 'published';
});

const docFolder = folder.files(DocPage, {
  dir: '../docs/pages',
  read: file => {
    const title = file.frontmatter['title'];
    return { path: file.path, title: typeof title === 'string' ? title : file.path, body: file.body };
  },
  write: (page, state) => ({ title: page.title, status: state }),
});

const docLane = H.lane('doc-pages', DocPage).handler(docFlow).suppliers(docFolder).store(docFolder).wip(2);

const docsPool = H.pool('docs-accounts', sharedSubscriptions.map(account => ({ account, share: 0.3 })), soonestExpiring('docs-drain-soonest-expiring'));

export const documentation = H.harness('documentation')
  .ledger(sqlite.ledger('docs/ledger.db', { quota: sharedQuota }))
  .lanes(docLane)
  .pools(docsPool)
  .scheduler(H.policy.scheduler('docs-oldest-first', view => ({ start: [...view.pending].sort((x, y) => y.waitedMs - x.waitedMs) })))
  .clients(
    http.control({
      port: 7402,
      token: H.env('DOCS_CONTROL_TOKEN'),
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
    })
  )
  .observers(markdown.board('docs/board.md'), markdown.telemetry('docs/telemetry.md'));
