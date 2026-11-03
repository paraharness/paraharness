import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

export const subscriptionA = claudeCode.subscription('subscriptionA', { token: H.env('CLAUDE_TOKEN_A') });
export const subscriptionB = claudeCode.subscription('subscriptionB', { token: H.env('CLAUDE_TOKEN_B') });
export const subscriptionC = claudeCode.subscription('subscriptionC', { token: H.env('CLAUDE_TOKEN_C') });
export const apiAccount = anthropic.account('apiAccount', { apiKey: H.env('ANTHROPIC_API_KEY') });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiring = H.policy.account('soonestExpiring', ctx =>
  ctx.candidates
    .filter(a => (a.cooldownUntil === undefined || a.cooldownUntil.getTime() <= ctx.now.getTime()) && a.shareUsed < a.shareCap)
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const claudePool = H.pool('claudeSubscriptions')
  .accounts(subscriptionA, subscriptionB, subscriptionC)
  .share(subscriptionA, 0.6)
  .share(subscriptionB, 0.5)
  .share(subscriptionC, 0.4)
  .drain(soonestExpiring)
  .fallback(apiAccount)
  .serves(sonnet, opus);

const builderModel = H.policy.model('builderModel', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.outcomes({ of: ctx.kind, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples < 20 || cheap.successRate >= 0.85 ? sonnet : opus;
});

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the work item in the worktree. Halt for the owner when a decision is not yours to make.');
const auditorRole = H.role('auditor')
  .intents('read', 'search', 'run', 'record')
  .instructions('Find deficits in the change against the work item. Record lessons that will help the next build.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently deliverable features.');

const localRunner = local.runner('local');
const projectChecks = H.command('projectChecks').argv(['npm', 'run', 'check']).runner(localRunner);

const builder = H.agent('builder')
  .role(builderRole)
  .model(builderModel)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks));

const auditor = H.agent('auditor')
  .role(auditorRole)
  .model(sonnet)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.agent('planner')
  .role(plannerRole)
  .model(opus)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const Experience = H.memory('Experience').trust('experience');
const Taste = H.memory('Taste').trust('taste');
const byScope = H.recall('byScope', { by: 'specificity', limit: 12 });

export const experience = H.journal('experience', Experience)
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall(byScope)
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

export const taste = H.journal('taste', Taste)
  .store(jsonl.memoryStore({ path: '.harness/taste.jsonl' }))
  .recall(byScope)
  .readBy(builderRole, plannerRole);

const Queued = H.state('Queued', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Done = H.terminal('Done', 'success');
const Exhausted = H.terminal('Exhausted', 'failure');
const Cancelled = H.terminal('Cancelled', 'neutral');
const Planning = H.state('Planning', 'active');
const AwaitingFeatures = H.state('AwaitingFeatures', 'waiting');
const Delivered = H.terminal('Delivered', 'success');
const Incomplete = H.terminal('Incomplete', 'failure');
const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.terminal('Healthy', 'success');
const Down = H.terminal('Down', 'failure');

const ticketSchema = z.object({ id: z.string(), title: z.string(), description: z.string() });

export const Bug = H.kind('Bug')
  .attributes(ticketSchema)
  .states(Queued, Building, Auditing, Done, Exhausted, Cancelled)
  .key(a => a.id)
  .initial(Queued)
  .onCancelled(Cancelled);

export const Feature = H.kind('Feature')
  .attributes(ticketSchema)
  .states(Queued, Building, Auditing, Done, Exhausted, Cancelled)
  .key(a => a.id)
  .initial(Queued)
  .onCancelled(Cancelled);

export const Epic = H.kind('Epic')
  .attributes(ticketSchema)
  .states(Queued, Planning, AwaitingFeatures, Delivered, Incomplete, Cancelled)
  .key(a => a.id)
  .initial(Queued)
  .onCancelled(Cancelled);

export const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(z.object({ service: z.string(), at: z.string() }))
  .states(HeartbeatDue, Probing, Healthy, Down)
  .key(a => `${a.service}@${a.at}`)
  .initial(HeartbeatDue)
  .onAttemptFailed(Down);

const ticketFlow = H.flow('ticket')
  .input(z.object({ title: z.string(), description: z.string() }))
  .params(z.object({ rounds: z.number().int().positive() }))
  .loop(
    'buildAuditRounds',
    round =>
      round
        .step('build', builder, ctx => ({
          task: `Implement "${ctx.unit.attributes.title}".\n\n${ctx.unit.attributes.description}`,
        }))
        .step('audit', auditor, ctx => ({
          task: `Audit the change for "${ctx.unit.attributes.title}". Builder report:\n${ctx.steps.build}`,
        })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('exhausted');

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({
  apiKey: linearKey,
  team: 'ENG',
  states: {
    Queued: 'Todo',
    Building: 'In Progress',
    Auditing: 'In Review',
    Done: 'Done',
    Exhausted: 'Needs Owner',
    Cancelled: 'Canceled',
    Planning: 'In Progress',
    AwaitingFeatures: 'In Progress',
    Delivered: 'Done',
    Incomplete: 'Needs Owner',
  },
});

export const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['bug'] }), (issue, to) =>
    to.create({ id: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ id: `file-${file.name}`, title: file.name, description: file.body }),
  )
  .supply(H.operator)
  .store(tracker)
  .handler(ticketFlow, {
    exits: { clean: Done, exhausted: Exhausted },
    during: { build: Building, audit: Auditing },
    params: { rounds: 3 },
  });

export const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['feature'] }), (issue, to) =>
    to.create({ id: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(H.operator)
  .store(tracker)
  .handler(ticketFlow, {
    exits: { clean: Done, exhausted: Exhausted },
    during: { build: Building, audit: Auditing },
    params: { rounds: 5 },
  });

const epicFlow = H.flow('epic')
  .input(ticketSchema)
  .step('plan', planner, ctx => ({
    task: `Decompose the epic "${ctx.unit.attributes.title}" into features.\n\n${ctx.unit.attributes.description}`,
  }))
  .spawn('features', features, ctx =>
    ctx.steps.plan.features.map((feature, index) => ({
      id: `${ctx.unit.key}-${index + 1}`,
      title: feature.title,
      description: feature.description,
    })),
  )
  .exit('delivered', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

export const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['epic'] }), (issue, to) =>
    to.create({ id: issue.identifier, title: issue.title, description: issue.description }),
  )
  .store(tracker)
  .handler(epicFlow, {
    exits: { delivered: Delivered, incomplete: Incomplete },
    during: { plan: Planning, features: AwaitingFeatures },
  });

const services = ['api', 'web', 'worker'];

const probe = H.command('probeService')
  .input(z.object({ service: z.string() }))
  .argv(input => ['./scripts/probe.sh', input.service])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(z.object({ service: z.string() }))
  .step('probe', probe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy');

export const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('everyFiveMinutes').every({ minutes: 5 }), (tick, to) =>
    services.map(service => to.create({ service, at: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, {
    exits: { healthy: Healthy },
    during: { probe: Probing },
  });

const heartbeatFailureFilesBug = H.trigger('heartbeatFailureFilesBug')
  .on(H.when.transition(heartbeats, { to: Down }))
  .create(bugs, event => ({
    id: `heartbeat-${event.unit.key}`,
    title: `Service ${event.unit.attributes.service} failed its heartbeat`,
    description: `The heartbeat at ${event.unit.attributes.at} failed. Investigate and fix the service.`,
  }));

const scheduler = H.scheduler('codingTeamScheduler')
  .priority(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .boost(features, { afterMinutes: 240 });

const productionProbe = H.command('productionProbe')
  .argv(['./scripts/production-health.sh'])
  .runner(localRunner);

const productionHealth = H.operation('productionHealth').run(productionProbe);

const supervisor = claudeCode.supervisor('supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.send(H.cancel, { lanes: [bugs, features, epics] }),
    H.ops.send(H.answer, { lanes: [bugs, features] }),
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealth,
  ],
});

export const codingTeam = H.harness('codingTeam')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }), {
    quota: sqlite.quota({ path: '~/.harness/quota.db' }),
  })
  .pools(claudePool)
  .lanes(heartbeats, bugs, features, epics)
  .journals(experience, taste)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
