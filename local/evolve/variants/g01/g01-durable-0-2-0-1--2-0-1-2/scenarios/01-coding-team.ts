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

const ownerQuota = sqlite.quota('owner-quota', { path: './state/quota.sqlite' });

const subscriptionA = claudeCode.subscription('claude-a', { token: H.env('CLAUDE_A_TOKEN'), quota: ownerQuota });
const subscriptionB = claudeCode.subscription('claude-b', { token: H.env('CLAUDE_B_TOKEN'), quota: ownerQuota });
const subscriptionC = claudeCode.subscription('claude-c', { token: H.env('CLAUDE_C_TOKEN'), quota: ownerQuota });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: ownerQuota });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  [...ctx.candidates].sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const claudePool = H.pool('claude-subscriptions')
  .accounts(subscriptionA, subscriptionB, subscriptionC)
  .share(subscriptionA, 0.5)
  .share(subscriptionB, 0.5)
  .share(subscriptionC, 0.3)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'halt')
  .instructions('Implement the work item in the worktree. Address every deficit the auditor listed in earlier rounds.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('List every deficit in the change against the work item. Record lessons that will hold next time.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently deliverable features.');

const ownerDecision = H.halt('owner-decision').decision(
  z.object({ choice: z.string(), note: z.string() }),
);

const localRunner = local.runner('local').slots(4);

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);

const serviceProbe = H.command('service-heartbeat')
  .input(z.object({ service: z.string() }))
  .argv(input => ['./ops/heartbeat.sh', input.service])
  .runner(localRunner);

const productionHealthProbe = H.command('production-health-probe')
  .argv(['./ops/probe-production.sh'])
  .runner(localRunner);

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheaper = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(claudePool)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guard({ leaseFiles: true, beforeStop: projectChecks })
  .halts(ownerDecision)
  .output(z.object({ summary: z.string(), filesChanged: z.array(z.string()) }));

const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(sonnet)
  .pool(claudePool)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.seat('planner')
  .role(plannerRole)
  .model(opus)
  .pool(claudePool)
  .output(
    z.object({
      features: z.array(z.object({ slug: z.string(), title: z.string(), description: z.string() })),
    }),
  );

const WorkItem = z.object({ ref: z.string(), title: z.string(), description: z.string() });
const FeatureItem = WorkItem.extend({ epic: z.string().optional() });
const Heartbeat = z.object({ service: z.string(), slot: z.string() });

const Ready = H.state('Ready', 'pending');
const NeedsTriage = H.state('NeedsTriage', 'waiting');
const Done = H.terminal('Done', 'success');
const Cancelled = H.terminal('Cancelled', 'neutral');

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');
const Skipped = H.terminal('Skipped', 'neutral');

const bugKind = H.kind('Bug')
  .attributes(WorkItem)
  .states(Ready, NeedsTriage, Done, Cancelled)
  .key(attrs => attrs.ref)
  .initial(Ready);

const featureKind = H.kind('Feature')
  .attributes(FeatureItem)
  .states(Ready, NeedsTriage, Done, Cancelled)
  .key(attrs => attrs.ref)
  .initial(Ready);

const epicKind = H.kind('Epic')
  .attributes(WorkItem)
  .states(Ready, NeedsTriage, Done, Cancelled)
  .key(attrs => attrs.ref)
  .initial(Ready);

const heartbeatKind = H.kind('ServiceHeartbeat')
  .attributes(Heartbeat)
  .states(HeartbeatDue, Healthy, Unhealthy, Skipped)
  .initial(HeartbeatDue);

const buildAndAudit = H.flow('build-and-audit')
  .input(WorkItem)
  .params(z.object({ rounds: z.number().int() }))
  .loop(
    'rounds',
    round =>
      round
        .step('build', builder, ctx => ({
          task: `Round ${ctx.iteration + 1} of ${ctx.params.rounds}: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
          skills: ['typescript'],
        }))
        .step('audit', auditor, ctx => ({
          task: `Audit this change against "${ctx.unit.attributes.title}": ${ctx.steps.build.summary}\nFiles: ${ctx.steps.build.filesChanged.join(', ')}`,
        })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('roundsExhausted');

const tracker = linear.store({
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  workflow: ['Backlog', 'In Progress', 'Done', 'Canceled'],
});

const bugLane = H.lane('bugs', bugKind)
  .handler(buildAndAudit, { exits: { clean: Done, roundsExhausted: NeedsTriage }, params: { rounds: 3 } })
  .store(tracker, {
    states: { Ready: 'Backlog', NeedsTriage: 'Backlog', Done: 'Done', Cancelled: 'Canceled' },
    inFlight: 'In Progress',
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: NeedsTriage })
  .on(H.cancel, { enter: Cancelled })
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['bug'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(folder.files({ path: './bugs', glob: '*.md' }), (file, to) =>
    to.create({ ref: file.path, title: file.name, description: file.body }),
  )
  .supply(H.operator);

const featureLane = H.lane('features', featureKind)
  .handler(buildAndAudit, { exits: { clean: Done, roundsExhausted: NeedsTriage }, params: { rounds: 5 } })
  .store(tracker, {
    states: { Ready: 'Backlog', NeedsTriage: 'Backlog', Done: 'Done', Cancelled: 'Canceled' },
    inFlight: 'In Progress',
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600_000, exhausted: NeedsTriage })
  .on(H.cancel, { enter: Cancelled })
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['feature'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(H.operator);

const decompose = H.flow('decompose-epic')
  .input(WorkItem)
  .step('plan', planner, ctx => ({
    task: `Decompose the epic "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.description}`,
  }))
  .spawn('features', featureLane, ctx =>
    ctx.steps.plan.features.map(feature => ({
      ref: `${ctx.unit.attributes.ref}/${feature.slug}`,
      title: feature.title,
      description: feature.description,
      epic: ctx.unit.attributes.ref,
    })),
  )
  .exit('delivered', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('partial');

const epicLane = H.lane('epics', epicKind)
  .handler(decompose, { exits: { delivered: Done, partial: NeedsTriage } })
  .store(tracker, {
    states: { Ready: 'Backlog', NeedsTriage: 'Backlog', Done: 'Done', Cancelled: 'Canceled' },
    inFlight: 'In Progress',
  })
  .retry({ maxAttempts: 1, exhausted: NeedsTriage })
  .on(H.cancel, { enter: Cancelled })
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  );

const heartbeat = H.flow('service-heartbeat')
  .input(Heartbeat)
  .step('probe', serviceProbe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy');

const heartbeatLane = H.lane('heartbeats', heartbeatKind)
  .handler(heartbeat, { exits: { healthy: Healthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy })
  .on(H.cancel, { enter: Skipped })
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    to.create({ service: 'api', slot: tick.at.toISOString() }),
  );

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.when.transition(heartbeatLane, { to: Unhealthy }))
  .create(bugLane, event => ({
    ref: `heartbeat/${event.unit.attributes.service}/${event.unit.attributes.slot}`,
    title: `Service heartbeat failed: ${event.unit.attributes.service}`,
    description: `Heartbeat unit ${event.unit.id} failed at ${event.at.toISOString()}.`,
  }));

const experience = H.journal('engineering-experience', H.memory('engineering-experience', 'experience'))
  .store(jsonl.memoryStore({ path: './memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const taste = H.journal('owner-taste', H.memory('owner-taste', 'taste'))
  .store(jsonl.memoryStore({ path: './memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, plannerRole);

const scheduler = H.scheduler('coding-team')
  .standard(heartbeatLane, bugLane, featureLane, epicLane)
  .wip(bugLane, 2)
  .wip(epicLane, 1)
  .aging(featureLane, { afterMinutes: 240 });

const supervisor = claudeCode.supervisor('supervisor', {
  port: H.slot.port(0),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.attemptsRecover,
    H.ops.resolve(ownerDecision),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    H.operation('production-health-probe', productionHealthProbe),
  ],
});

export default H.harness('coding-team')
  .ledger(sqlite.ledger({ path: './state/ledger.sqlite' }))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .journals(experience, taste)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));
