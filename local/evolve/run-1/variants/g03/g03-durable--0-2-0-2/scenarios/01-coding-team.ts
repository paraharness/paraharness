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

const Todo = H.state('Todo', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const AwaitingOwner = H.state('AwaitingOwner', 'waiting');
const Done = H.terminal('Done', 'success');
const Abandoned = H.terminal('Abandoned', 'failure');
const Cancelled = H.terminal('Cancelled', 'neutral');

const ticketSchema = z.object({ ref: z.string(), title: z.string(), body: z.string() });
const featureSchema = ticketSchema.extend({ epic: z.string().optional() });

const Bug = H.kind('Bug')
  .attributes(ticketSchema)
  .states(Todo, Building, Auditing, AwaitingOwner, Done, Abandoned, Cancelled)
  .key(attrs => attrs.ref)
  .initial(Todo)
  .onAttemptFailed(Abandoned)
  .onCancelled(Cancelled);

const Feature = H.kind('Feature')
  .attributes(featureSchema)
  .states(Todo, Building, Auditing, AwaitingOwner, Done, Abandoned, Cancelled)
  .key(attrs => attrs.ref)
  .initial(Todo)
  .onAttemptFailed(Abandoned)
  .onCancelled(Cancelled);

const Proposed = H.state('Proposed', 'pending');
const Planning = H.state('Planning', 'active');
const Delivering = H.state('Delivering', 'waiting');
const Delivered = H.terminal('Delivered', 'success');
const Stalled = H.terminal('Stalled', 'failure');
const Dropped = H.terminal('Dropped', 'neutral');

const Epic = H.kind('Epic')
  .attributes(ticketSchema)
  .states(Proposed, Planning, Delivering, Delivered, Stalled, Dropped)
  .key(attrs => attrs.ref)
  .initial(Proposed)
  .onAttemptFailed(Stalled)
  .onCancelled(Dropped);

const Due = H.state('Due', 'pending');
const Checking = H.state('Checking', 'active');
const Up = H.terminal('Up', 'success');
const Down = H.terminal('Down', 'failure');

const Heartbeat = H.kind('ServiceHeartbeat')
  .attributes(z.object({ service: z.string() }))
  .states(Due, Checking, Up, Down)
  .key(attrs => attrs.service)
  .initial(Due)
  .onAttemptFailed(Down)
  .onCancelled(Down);

const localRunner = local.runner('local').slots(4);

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);

const heartbeatCheck = H.command('heartbeat-check')
  .input(z.object({ service: z.string() }))
  .argv(input => ['./scripts/heartbeat.sh', input.service])
  .runner(localRunner)
  .acceptExitCodes(1);

const productionProbe = H.command('production-health-probe')
  .argv(['./scripts/probe-production.sh'])
  .runner(localRunner);

const subscriptionA = claudeCode.subscription('claude-sub-a', { token: H.env('CLAUDE_SUB_A_TOKEN') });
const subscriptionB = claudeCode.subscription('claude-sub-b', { token: H.env('CLAUDE_SUB_B_TOKEN') });
const subscriptionC = claudeCode.subscription('claude-sub-c', { token: H.env('CLAUDE_SUB_C_TOKEN') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  [...ctx.candidates]
    .filter(state => state.cooldownUntil === undefined || state.cooldownUntil <= ctx.now)
    .filter(state => state.shareUsed < state.shareCap)
    .sort((left, right) => left.windowResetsAt.getTime() - right.windowResetsAt.getTime())[0],
);

const claudePool = H.pool('claude-pool')
  .accounts(subscriptionA, subscriptionB, subscriptionC)
  .share(subscriptionA, 0.5)
  .share(subscriptionB, 0.5)
  .share(subscriptionC, 0.3)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const cheapModel = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const strongModel = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const builderModel = H.policy.model('builder-model', [cheapModel, strongModel], ctx => {
  const record = ctx.metrics.attempts({ of: ctx.kind, model: cheapModel, window: { lastDays: 14 } });
  return record.samples < 20 || record.successRate >= 0.85 ? cheapModel : strongModel;
});

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search')
  .instructions('Implement the work item in the worktree. If an owner decision is needed, state the question.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('Find deficits against the work item. Record forward-phrased lessons worth keeping.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently deliverable features.');

const repo = H.resource('repo');
const payments = H.resource('payments');

const builder = H.agent('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(claudePool)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks))
  .output(z.object({ summary: z.string(), question: z.string().optional() }));

const auditor = H.agent('auditor')
  .role(auditorRole)
  .model(strongModel)
  .pool(claudePool)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.agent('planner')
  .role(plannerRole)
  .model(strongModel)
  .pool(claudePool)
  .output(z.object({
    features: z.array(z.object({ slug: z.string(), title: z.string(), body: z.string() })),
  }));

const experienceKind = H.memory('experience', 'experience');
const tasteKind = H.memory('taste', 'taste');

const experience = H.corpus('coding-experience', experienceKind)
  .store(jsonl.memoryStore({ path: './.harness/memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const taste = H.corpus('owner-taste', tasteKind)
  .store(jsonl.memoryStore({ path: './.harness/memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, plannerRole);

const ticketFlow = H.flow('ticket')
  .input(ticketSchema)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'build-and-audit',
    flow => flow
      .step('build', builder, ctx => ({
        task: `${ctx.unit.attributes.ref}: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
        resources: [repo],
      }))
      .halt('ownerDecision', {
        ask: ctx => ctx.steps.build.question ?? 'The builder needs an owner decision.',
        decision: z.object({ answer: z.string() }),
        skip: ctx => (ctx.steps.build.question === undefined ? { answer: 'no question asked' } : undefined),
      })
      .step('audit', auditor, ctx => ({
        task: `Audit ${ctx.unit.attributes.ref} against its description.\nBuilder summary: ${ctx.steps.build.summary}\nOwner decision: ${ctx.steps.ownerDecision.answer}\n\n${ctx.unit.attributes.body}`,
        resources: [repo],
      })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('delivered', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('exhausted');

const tracker = linear.store({ apiKey: H.env('LINEAR_API_KEY'), team: 'PROD' });

const ticketStatuses = {
  Todo: 'Todo',
  Building: 'In Progress',
  Auditing: 'In Review',
  AwaitingOwner: 'Blocked',
  Done: 'Done',
  Abandoned: 'Canceled',
  Cancelled: 'Canceled',
} satisfies Record<string, 'Todo' | 'In Progress' | 'In Review' | 'Blocked' | 'Done' | 'Canceled'>;

const ticketMap = {
  exits: { delivered: Done, exhausted: Abandoned },
  during: { build: Building, ownerDecision: AwaitingOwner, audit: Auditing },
};

const bugs = H.lane('bugs', Bug)
  .supply(
    linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PROD', labels: ['bug'] }),
    (issue, to) => to.create({ ref: issue.identifier, title: issue.title, body: issue.description }),
  )
  .supply(
    folder.files({ path: './bugs', glob: '*.md' }),
    (file, to) => to.create({ ref: `folder:${file.name}`, title: file.name, body: file.body }),
  )
  .supply(H.operator)
  .store(tracker, ticketStatuses)
  .handler(ticketFlow, { ...ticketMap, params: { rounds: 3 } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300000 });

const features = H.lane('features', Feature)
  .supply(
    linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PROD', labels: ['feature'] }),
    (issue, to) => to.create({ ref: issue.identifier, title: issue.title, body: issue.description }),
  )
  .supply(H.operator)
  .store(tracker, ticketStatuses)
  .handler(ticketFlow, { ...ticketMap, params: { rounds: 5 } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300000 });

const epicFlow = H.flow('epic')
  .input(ticketSchema)
  .step('plan', planner, ctx => ({
    task: `Decompose epic ${ctx.unit.attributes.ref}: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
    resources: [repo],
  }))
  .spawn('features', features, ctx =>
    ctx.steps.plan.features.map(feature => ({
      ref: `${ctx.unit.attributes.ref}/${feature.slug}`,
      title: feature.title,
      body: feature.body,
      epic: ctx.unit.attributes.ref,
    })),
  )
  .exit('delivered', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('stalled');

const epics = H.lane('epics', Epic)
  .supply(
    linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PROD', labels: ['epic'] }),
    (issue, to) => to.create({ ref: issue.identifier, title: issue.title, body: issue.description }),
  )
  .store(tracker, {
    Proposed: 'Backlog',
    Planning: 'In Progress',
    Delivering: 'In Progress',
    Delivered: 'Done',
    Stalled: 'Blocked',
    Dropped: 'Canceled',
  })
  .handler(epicFlow, {
    exits: { delivered: Delivered, stalled: Stalled },
    during: { plan: Planning, features: Delivering },
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600000 });

const heartbeatFlow = H.flow('heartbeat')
  .input(z.object({ service: z.string() }))
  .step('check', heartbeatCheck, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('up', ctx => ctx.steps.check.exitCode === 0)
  .exit('down');

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(
    H.clock('every-five-minutes').every({ minutes: 5 }),
    (_tick, to) => [to.create({ service: 'api' }), to.create({ service: 'web' }), to.create({ service: 'worker' })],
  )
  .handler(heartbeatFlow, {
    exits: { up: Up, down: Down },
    during: { check: Checking },
  })
  .retry({ maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0 });

const heartbeatBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.when.transition(heartbeats, { to: Down }))
  .create(bugs, event => ({
    ref: `heartbeat:${event.unit.attributes.service}`,
    title: `Service heartbeat failing: ${event.unit.attributes.service}`,
    body: `The heartbeat for ${event.unit.attributes.service} went down at ${event.at.toISOString()}.`,
  }));

const scheduler = H.scheduler('coding-team')
  .priority(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .boost(features, { afterMinutes: 240 });

const productionHealth = H.operation('production-health', productionProbe);

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
    productionHealth,
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: './.harness/ledger.db', quotaPath: '../.shared/quota.db' }))
  .lanes(heartbeats, bugs, features, epics)
  .corpora(experience, taste)
  .triggers(heartbeatBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(
    markdown.board({ path: './.harness/board.md' }),
    markdown.telemetry({ path: './.harness/telemetry.md' }),
  );
