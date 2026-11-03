import { z } from 'zod';
import { H, AccountState } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const TicketSchema = z.object({
  title: z.string(),
  description: z.string(),
  trackerId: z.string().optional(),
  resources: z.array(z.string()),
});

const EpicSchema = z.object({
  title: z.string(),
  description: z.string(),
  trackerId: z.string(),
});

const HeartbeatSchema = z.object({ service: z.string() });

const Backlog = H.state('Backlog', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Done = H.terminal('Done', 'success');
const Exhausted = H.terminal('Exhausted', 'failure');
const Cancelled = H.terminal('Cancelled', 'neutral');

const Bug = H.kind('Bug')
  .attributes(TicketSchema)
  .states(Backlog, Building, Auditing, Done, Exhausted, Cancelled)
  .key(a => a.trackerId ?? a.title)
  .initial(Backlog)
  .onAttemptFailed(Exhausted)
  .onCancelled(Cancelled);

const Feature = H.kind('Feature')
  .attributes(TicketSchema)
  .states(Backlog, Building, Auditing, Done, Exhausted, Cancelled)
  .key(a => a.trackerId ?? a.title)
  .initial(Backlog)
  .onAttemptFailed(Exhausted)
  .onCancelled(Cancelled);

const EpicBacklog = H.state('EpicBacklog', 'pending');
const Planning = H.state('Planning', 'active');
const Delivering = H.state('Delivering', 'active');
const EpicDone = H.terminal('EpicDone', 'success');
const EpicIncomplete = H.terminal('EpicIncomplete', 'failure');

const Epic = H.kind('Epic')
  .attributes(EpicSchema)
  .states(EpicBacklog, Planning, Delivering, EpicDone, EpicIncomplete, Cancelled)
  .key(a => a.trackerId)
  .initial(EpicBacklog)
  .onAttemptFailed(EpicIncomplete)
  .onCancelled(Cancelled);

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const Heartbeat = H.kind('ServiceHeartbeat')
  .attributes(HeartbeatSchema)
  .states(HeartbeatDue, Probing, Healthy, Unhealthy)
  .key(a => a.service)
  .initial(HeartbeatDue)
  .onAttemptFailed(Unhealthy);

const maxA = claudeCode.subscription('max-a', { token: H.env('CLAUDE_MAX_A_TOKEN') });
const maxB = claudeCode.subscription('max-b', { token: H.env('CLAUDE_MAX_B_TOKEN') });
const maxC = claudeCode.subscription('max-c', { token: H.env('CLAUDE_MAX_C_TOKEN') });
const apiAccount = anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonestExpiring', ctx =>
  ctx.candidates
    .filter(c => c.cooldownUntil === undefined || c.cooldownUntil.getTime() <= ctx.now.getTime())
    .filter(c => c.shareUsed < c.shareCap)
    .reduce<AccountState | undefined>(
      (best, c) => (best === undefined || c.windowResetsAt.getTime() < best.windowResetsAt.getTime() ? c : best),
      undefined,
    ),
);

const claudePool = H.pool('claude')
  .accounts(maxA, maxB, maxC)
  .share(maxA, 0.5)
  .share(maxB, 0.3)
  .share(maxC, 0.2)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const builderModel = H.policy.model('builderModel', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.attempts({ of: ctx.kind, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples >= 20 && cheap.successRate < 0.85 ? opus : sonnet;
});

const localRunner = local.runner('local');

const projectChecks = H.command('projectChecks')
  .argv(['npm', 'run', 'check'])
  .runner(localRunner);

const healthCheck = H.command('serviceHealthCheck')
  .input(HeartbeatSchema)
  .argv(i => ['./scripts/health.sh', i.service])
  .runner(localRunner);

const productionProbe = H.command('productionProbe')
  .argv(['./scripts/probe-production.sh'])
  .runner(localRunner);

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the unit of work in the worktree. Halt for the owner when a product decision is needed.');

const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('Find deficits in the change. Record forward-phrased experience when a lesson generalises.');

const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');

const builder = H.agent('builder')
  .role(builderRole)
  .model(builderModel)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks))
  .output(z.object({ summary: z.string() }));

const auditor = H.agent('auditor')
  .role(auditorRole)
  .model(opus)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.agent('planner')
  .role(plannerRole)
  .model(opus)
  .output(z.object({
    features: z.array(z.object({
      title: z.string(),
      description: z.string(),
      resources: z.array(z.string()),
    })),
  }));

const Experience = H.memory('experience').trust('experience');
const Taste = H.memory('taste').trust('taste');

const bySpecificity = H.recall('bySpecificity', { by: 'specificity', limit: 12 });

const experienceJournal = H.journal('codingExperience', Experience)
  .store(jsonl.memoryStore({ path: '.harness/memory/experience.jsonl' }))
  .recall(bySpecificity)
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const tasteJournal = H.journal('ownerTaste', Taste)
  .store(jsonl.memoryStore({ path: '.harness/memory/taste.jsonl' }))
  .recall(bySpecificity)
  .readBy(builderRole, plannerRole);

const ticketFlow = H.flow('buildAndAudit')
  .input(z.object({ title: z.string(), description: z.string(), resources: z.array(z.string()) }))
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    f => f
      .step('build', builder, ctx => ({
        task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
        resources: ctx.unit.attributes.resources,
      }))
      .step('audit', auditor, ctx => ({
        task: `Audit the change for "${ctx.unit.attributes.title}". Builder summary: ${ctx.steps.build.summary}`,
        resources: ctx.unit.attributes.resources,
      })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('exhausted');

const tracker = linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PRODUCT' });

const trackerStore = linear.store({
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  states: {
    Backlog: 'Todo',
    Building: 'In Progress',
    Auditing: 'In Review',
    Done: 'Done',
    Exhausted: 'Blocked',
    Cancelled: 'Canceled',
    EpicBacklog: 'Todo',
    Planning: 'In Progress',
    Delivering: 'In Progress',
    EpicDone: 'Done',
    EpicIncomplete: 'Blocked',
  },
});

const bugs = H.lane('bugs', Bug)
  .supply(tracker, (issue, to) =>
    issue.labels.includes('bug')
      ? to.create({ title: issue.title, description: issue.description, trackerId: issue.id, resources: [] })
      : to.skip())
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ title: file.name, description: file.body, resources: [] }))
  .supply(H.operator)
  .store(trackerStore)
  .handler(ticketFlow, {
    exits: { clean: Done, exhausted: Exhausted },
    during: { build: Building, audit: Auditing },
    params: { rounds: 3 },
  });

const features = H.lane('features', Feature)
  .supply(tracker, (issue, to) =>
    issue.labels.includes('feature')
      ? to.create({ title: issue.title, description: issue.description, trackerId: issue.id, resources: [] })
      : to.skip())
  .supply(H.operator)
  .store(trackerStore)
  .handler(ticketFlow, {
    exits: { clean: Done, exhausted: Exhausted },
    during: { build: Building, audit: Auditing },
    params: { rounds: 5 },
  });

const epicFlow = H.flow('decomposeEpic')
  .input(EpicSchema)
  .step('plan', planner, ctx => ({
    task: `Decompose the epic "${ctx.unit.attributes.title}":\n${ctx.unit.attributes.description}`,
  }))
  .spawn('deliver', features, ctx => ctx.steps.plan.features.map(f => ({
    title: f.title,
    description: f.description,
    resources: f.resources,
  })))
  .exit('delivered', ctx => ctx.steps.deliver.every(c => c.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(tracker, (issue, to) =>
    issue.labels.includes('epic')
      ? to.create({ title: issue.title, description: issue.description, trackerId: issue.id })
      : to.skip())
  .store(trackerStore)
  .handler(epicFlow, {
    exits: { delivered: EpicDone, incomplete: EpicIncomplete },
    during: { plan: Planning, deliver: Delivering },
  });

const heartbeatFlow = H.flow('serviceHeartbeat')
  .input(HeartbeatSchema)
  .step('probe', healthCheck, ctx => ({ service: ctx.unit.attributes.service }), { afterCrash: 'rerun' })
  .exit('healthy');

const monitoredServices = ['api', 'web', 'worker'];

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('everyFiveMinutes').every({ minutes: 5 }), (_tick, to) =>
    monitoredServices.map(service => to.create({ service })))
  .handler(heartbeatFlow, {
    exits: { healthy: Healthy },
    during: { probe: Probing },
  });

const unhealthyServiceOpensBug = H.trigger('unhealthyServiceOpensBug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, e => ({
    title: `Service ${e.unit.attributes.service} is failing its heartbeat`,
    description: `The heartbeat for ${e.unit.attributes.service} failed at ${e.at.toISOString()}.`,
    resources: [],
  }));

const scheduler = H.scheduler('codingTeam')
  .priority(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .boost(features, { afterMinutes: 240 });

const productionHealthProbe = H.operation('productionHealthProbe').run(productionProbe);

const supervisor = claudeCode.supervisor('supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealthProbe,
  ],
});

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .pools(claudePool)
  .lanes(heartbeats, bugs, features, epics)
  .journals(experienceJournal, tasteJournal)
  .triggers(unhealthyServiceOpensBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(
    markdown.board({ path: '.harness/board.md' }),
    markdown.telemetry({ path: '.harness/telemetry.md' }),
  );

export const running = harness.start();
