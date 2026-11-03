import { z } from 'zod';
import { H, PolicyCtx, Model } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear, LinearIssue } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { markdown } from 'harness-dsl/markdown';

const ticket = z.object({
  externalId: z.string(),
  title: z.string(),
  description: z.string(),
});

const heartbeatAttrs = z.object({ service: z.string(), dueAt: z.string() });

const Open = H.state('Open', 'pending');
const Planning = H.state('Planning', 'active');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Delivering = H.state('Delivering', 'active');
const Done = H.state('Done', 'succeeded');
const Failed = H.state('Failed', 'failed');
const Cancelled = H.state('Cancelled', 'cancelled');
const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.state('Healthy', 'succeeded');
const Unhealthy = H.state('Unhealthy', 'failed');

const Bug = H.kind('Bug')
  .attributes(ticket)
  .states(Open, Building, Auditing, Done, Failed, Cancelled)
  .key(a => a.externalId);
const Feature = H.kind('Feature')
  .attributes(ticket)
  .states(Open, Building, Auditing, Done, Failed, Cancelled)
  .key(a => a.externalId);
const Epic = H.kind('Epic')
  .attributes(ticket)
  .states(Open, Planning, Delivering, Done, Failed, Cancelled)
  .key(a => a.externalId);
const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(heartbeatAttrs)
  .states(Due, Probing, Healthy, Unhealthy, Cancelled)
  .key(a => `${a.service}@${a.dueAt}`);

const max1 = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') });
const max2 = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN') });
const max3 = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  [...ctx.candidates]
    .filter(a => a.shareUsed < a.shareCap)
    .filter(a => a.cooldownUntil === undefined || a.cooldownUntil.getTime() <= ctx.now.getTime())
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const claudePool = H.pool('claude-subscriptions')
  .accounts(max1, max2, max3)
  .share(max1, 0.5)
  .share(max2, 0.3)
  .share(max3, 0.2)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5', pool: claudePool });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1', pool: claudePool });

function chooseBuilderModel(ctx: PolicyCtx): Model {
  const cheaper = ctx.metrics.outcomes({ of: { name: ctx.unit.lane }, model: sonnet, windowDays: 14 });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? opus : sonnet;
}

const builderModel = H.policy.model('builder-model', [sonnet, opus], chooseBuilderModel);

const localRunner = local.runner('local').slots(4);
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);
const worktree = git.worktree({ repo: '.', base: 'main' });

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the unit of work in the worktree. Halt for the owner when a product decision is needed.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('List every deficit in the change. Record lessons that would have prevented a deficit.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');

const buildAgent = H.agent('build-agent')
  .role(builderRole)
  .model(builderModel)
  .workspace(worktree)
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks))
  .budgetTokens(400000)
  .output(z.object({ summary: z.string(), filesChanged: z.array(z.string()) }));

const auditAgent = H.agent('audit-agent')
  .role(auditorRole)
  .model(opus)
  .workspace(worktree)
  .budgetTokens(150000)
  .output(z.object({ deficits: z.array(z.string()) }));

const planAgent = H.agent('plan-agent')
  .role(plannerRole)
  .model(opus)
  .budgetTokens(100000)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const ticketFlow = H.flow('ticket')
  .input(ticket)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    f => f
      .step('build', buildAgent, ctx => ({
        task: `Round ${ctx.iteration + 1}: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
      }))
      .step('audit', auditAgent, ctx => ({
        task: `Audit the change for "${ctx.unit.attributes.title}". Builder summary: ${ctx.steps.build.summary}`,
        resources: ctx.steps.build.filesChanged,
      })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('exhausted');

const linearKey = H.env('LINEAR_API_KEY');
const linearStore = linear.store({
  apiKey: linearKey,
  team: 'PROD',
  states: {
    Open: 'Todo',
    Planning: 'In Progress',
    Building: 'In Progress',
    Auditing: 'In Review',
    Delivering: 'In Progress',
    Done: 'Done',
    Failed: 'Blocked',
    Cancelled: 'Canceled',
  },
});
const fromIssue = (issue: LinearIssue) => ({
  externalId: issue.identifier,
  title: issue.title,
  description: issue.description,
});

const bugLane = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['bug'] }), (issue, to) => to.create(fromIssue(issue)))
  .supply(folder.files({ path: 'inbox/bugs', glob: '*.md' }), (file, to) =>
    to.create({ externalId: `file:${file.name}`, title: file.name, description: file.body }),
  )
  .supply(H.operator)
  .store(linearStore)
  .handler(ticketFlow, {
    params: { rounds: 3 },
    exits: { clean: Done, exhausted: Failed },
    during: { build: Building, audit: Auditing },
    failure: Failed,
  });

const featureLane = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['feature'] }), (issue, to) => to.create(fromIssue(issue)))
  .supply(H.operator)
  .store(linearStore)
  .handler(ticketFlow, {
    params: { rounds: 5 },
    exits: { clean: Done, exhausted: Failed },
    during: { build: Building, audit: Auditing },
    failure: Failed,
  });

const epicFlow = H.flow('epic')
  .input(ticket)
  .step('plan', planAgent, ctx => ({
    task: `Decompose into features: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
  }))
  .spawn('features', featureLane, ctx =>
    ctx.steps.plan.features.map((feature, index) => ({
      externalId: `${ctx.unit.attributes.externalId}-${index + 1}`,
      title: feature.title,
      description: feature.description,
    })),
  )
  .exit('delivered', ctx => ctx.steps.features.every(child => child.outcome === 'succeeded'))
  .exit('incomplete');

const epicLane = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['epic'] }), (issue, to) => to.create(fromIssue(issue)))
  .store(linearStore)
  .handler(epicFlow, {
    exits: { delivered: Done, incomplete: Failed },
    during: { plan: Planning, features: Delivering },
    failure: Failed,
  });

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./scripts/probe.sh', i.service])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatAttrs)
  .step('probe', probeService, ctx => ({ service: ctx.unit.attributes.service }), { timeoutMs: 60000 })
  .exit('healthy');

const services = ['api', 'web', 'worker'];

const heartbeatLane = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    services.map(service => to.create({ service, dueAt: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, {
    exits: { healthy: Healthy },
    during: { probe: Probing },
    failure: Unhealthy,
  });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.when.transition(heartbeatLane, { to: Unhealthy }))
  .create(bugLane, e => ({
    externalId: `heartbeat:${e.unit.attributes.service}:${e.unit.attributes.dueAt}`,
    title: `Service ${e.unit.attributes.service} failed its heartbeat`,
    description: `The heartbeat due at ${e.unit.attributes.dueAt} failed.`,
  }));

const experience = H.memory('experience').trust('experience');
const taste = H.memory('taste').trust('taste');
const mostSpecific = H.recall('most-specific', { by: 'specificity', limit: 8 });

const experienceJournal = H.journal('coding-experience', experience)
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall(mostSpecific)
  .readBy(builderRole, auditorRole)
  .writtenBy(auditorRole);

const tasteJournal = H.journal('owner-taste', taste)
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall(mostSpecific)
  .readBy(builderRole, plannerRole);

const scheduler = H.scheduler('coding-scheduler')
  .priority(heartbeatLane, bugLane, featureLane, epicLane)
  .wip(bugLane, 2)
  .wip(epicLane, 1)
  .boost(featureLane, { afterMinutes: 240 });

const productionHealth = H.operation('production-health').run(
  H.command('probe-production').argv(['./scripts/probe-production.sh']).runner(localRunner),
);

const supervisor = claudeCode.supervisor('supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealth,
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .journals(experienceJournal, tasteJournal)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

export const running = codingTeam.start();
