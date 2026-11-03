import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';

const ticketSchema = z.object({
  title: z.string(),
  description: z.string(),
  ref: z.string(),
  source: z.string(),
});

const heartbeatSchema = z.object({ service: z.string() });

const Queued = H.state('Queued', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Done = H.terminal('Done', 'success');
const Exhausted = H.terminal('Exhausted', 'failure');

const Proposed = H.state('Proposed', 'pending');
const Planning = H.state('Planning', 'active');
const Delivering = H.state('Delivering', 'active');
const Complete = H.terminal('Complete', 'success');
const Incomplete = H.terminal('Incomplete', 'failure');

const Due = H.state('Due', 'pending');
const Checking = H.state('Checking', 'active');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const Bug = H.kind('Bug')
  .attributes(ticketSchema)
  .states(Queued, Building, Auditing, Done, Exhausted)
  .key(attrs => attrs.ref)
  .initial(Queued);

const Feature = H.kind('Feature')
  .attributes(ticketSchema)
  .states(Queued, Building, Auditing, Done, Exhausted)
  .key(attrs => attrs.ref)
  .initial(Queued);

const Epic = H.kind('Epic')
  .attributes(ticketSchema)
  .states(Proposed, Planning, Delivering, Complete, Incomplete)
  .key(attrs => attrs.ref)
  .initial(Proposed);

const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(heartbeatSchema)
  .states(Due, Checking, Healthy, Unhealthy)
  .key(attrs => attrs.service)
  .initial(Due);

const localRunner = local.runner('local').slots(4);

const projectChecks = H.command('project-checks')
  .argv(['npm', 'run', 'check'])
  .runner(localRunner);

const heartbeatCheck = H.command('heartbeat-check')
  .input(heartbeatSchema)
  .argv(input => ['./scripts/heartbeat.sh', input.service])
  .runner(localRunner)
  .acceptExitCodes(0, 1);

const productionProbe = H.command('production-health-probe')
  .argv(['./scripts/probe-production.sh'])
  .runner(localRunner);

const subscriptionA = claudeCode.subscription('claude-a', { token: H.env('CLAUDE_TOKEN_A') });
const subscriptionB = claudeCode.subscription('claude-b', { token: H.env('CLAUDE_TOKEN_B') });
const subscriptionC = claudeCode.subscription('claude-c', { token: H.env('CLAUDE_TOKEN_C') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  ctx.candidates
    .filter(state => state.shareUsed < state.shareCap)
    .filter(state => state.cooldownUntil === undefined || state.cooldownUntil <= ctx.now)
    .slice()
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const claudePool = H.pool('claude-subscriptions')
  .accounts(subscriptionA, subscriptionB, subscriptionC)
  .share(subscriptionA, 0.5)
  .share(subscriptionB, 0.3)
  .share(subscriptionC, 0.2)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const record = ctx.metrics.attempts({ of: ctx.kind, model: sonnet, window: { lastDays: 14 } });
  return record.samples >= 20 && record.successRate < 0.85 ? opus : sonnet;
});

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the change in the worktree. Halt when an owner decision is needed.');

const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('List every deficit in the change. Record lessons that will help future builds.');

const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');

const builder = H.agent('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(claudePool)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks));

const auditor = H.agent('auditor')
  .role(auditorRole)
  .model(sonnet)
  .pool(claudePool)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.agent('planner')
  .role(plannerRole)
  .model(opus)
  .pool(claudePool)
  .output(z.object({
    features: z.array(z.object({ title: z.string(), description: z.string() })),
  }));

const buildFlow = H.flow('build-and-audit')
  .input(z.object({ title: z.string(), description: z.string() }))
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    flow => flow
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

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatSchema)
  .step('check', heartbeatCheck, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy', ctx => ctx.steps.check.exitCode === 0)
  .exit('unhealthy');

const linearKey = H.env('LINEAR_API_KEY');
const trackerStore = linear.store({
  apiKey: linearKey,
  team: 'ENG',
  states: {
    Queued: 'Todo',
    Building: 'In Progress',
    Auditing: 'In Review',
    Done: 'Done',
    Exhausted: 'Canceled',
    Proposed: 'Backlog',
    Planning: 'In Progress',
    Delivering: 'In Progress',
    Complete: 'Done',
    Incomplete: 'Canceled',
  },
});

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('heartbeat-tick').every({ minutes: 5 }), (_tick, to) =>
    ['api', 'web', 'worker'].map(service => to.create({ service })),
  )
  .handler(heartbeatFlow, { exits: { healthy: Healthy, unhealthy: Unhealthy }, during: { check: Checking } });

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['bug'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description, ref: issue.identifier, source: 'linear' }),
  )
  .supply(folder.files({ path: 'inbox/bugs', glob: '*.md' }), (file, to) =>
    to.create({ title: file.name, description: file.body, ref: `folder:${file.path}`, source: 'folder' }),
  )
  .supply(H.operator)
  .store(trackerStore)
  .handler(buildFlow, {
    exits: { clean: Done, exhausted: Exhausted },
    during: { build: Building, audit: Auditing },
    params: { rounds: 3 },
  });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['feature'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description, ref: issue.identifier, source: 'linear' }),
  )
  .supply(H.operator)
  .store(trackerStore)
  .handler(buildFlow, {
    exits: { clean: Done, exhausted: Exhausted },
    during: { build: Building, audit: Auditing },
    params: { rounds: 5 },
  });

const epicFlow = H.flow('decompose-epic')
  .input(ticketSchema)
  .step('plan', planner, ctx => ({
    task: `Decompose the epic "${ctx.unit.attributes.title}" into features.\n\n${ctx.unit.attributes.description}`,
  }))
  .spawn('features', features, ctx =>
    ctx.steps.plan.features.map((feature, index) => ({
      title: feature.title,
      description: feature.description,
      ref: `${ctx.unit.key}/${index + 1}`,
      source: 'epic',
    })),
  )
  .exit('complete', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['epic'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description, ref: issue.identifier, source: 'linear' }),
  )
  .store(trackerStore)
  .handler(epicFlow, {
    exits: { complete: Complete, incomplete: Incomplete },
    during: { plan: Planning, features: Delivering },
  });

const experience = H.journal('engineering-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const taste = H.journal('owner-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(builderRole, plannerRole);

const heartbeatFailureOpensBug = H.trigger('heartbeat-failure-opens-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, event => ({
    title: `Heartbeat failed for ${event.unit.attributes.service}`,
    description: `The service heartbeat for ${event.unit.attributes.service} failed at ${event.at.toISOString()}.`,
    ref: `heartbeat:${event.unit.attributes.service}`,
    source: 'heartbeat',
  }));

const scheduler = H.scheduler('coding-team')
  .priority(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .boost(features, { afterMinutes: 240 });

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
    H.operation('production-health-probe', productionProbe),
  ],
});

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(experience, taste)
  .triggers(heartbeatFailureOpensBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(
    markdown.board({ path: 'BOARD.md' }),
    markdown.telemetry({ path: 'TELEMETRY.md' }),
  );

void harness.start();
