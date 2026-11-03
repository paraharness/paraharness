import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('claude-subscriptions', { path: '../shared/quota.db' });
const subscriptionA = claudeCode.subscription('claude-max-a', { token: H.env('CLAUDE_TOKEN_A'), quota });
const subscriptionB = claudeCode.subscription('claude-max-b', { token: H.env('CLAUDE_TOKEN_B'), quota });
const subscriptionC = claudeCode.subscription('claude-max-c', { token: H.env('CLAUDE_TOKEN_C'), quota });
const apiFallback = claudeCode.apiAccount('claude-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });

const soonestResetFirst = H.policy.account('soonest-reset-first', ctx =>
  [...ctx.candidates]
    .filter(s => s.shareUsed < s.shareCap && (s.cooldownUntil === undefined || s.cooldownUntil <= ctx.now))
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0]);

const claudePool = H.pool('claude')
  .accounts(subscriptionA, subscriptionB, subscriptionC)
  .share(subscriptionA, 0.6)
  .share(subscriptionB, 0.6)
  .share(subscriptionC, 0.6)
  .drain(soonestResetFirst)
  .fallback(apiFallback);

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const plannerRole = H.role('planner').intents('read', 'search').instructions('Decompose an epic into independently shippable features.');
const builderRole = H.role('builder').intents('read', 'edit', 'run', 'search', 'halt').instructions('Implement the task in the worktree until the project checks pass.');
const auditorRole = H.role('auditor').intents('read', 'run', 'search', 'record').instructions('List every deficit in the change; record lessons as forward-phrased experience.');

const experience = H.journal('coding-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: '.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const taste = H.journal('owner-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: '../shared/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, plannerRole);

const ownerDecision = H.halt('owner-decision').decision(z.object({ answer: z.string() }));
const ownerReplied = H.signal('owner-replied').payload(z.object({ note: z.string() }));

const localRunner = local.runner('local');
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);
const worktree = git.worktree({ repo: '.', base: 'main' }).guard({ leaseFiles: true, beforeStop: projectChecks });

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheaper = ctx.metrics.outcomes({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(claudePool)
  .workspace(worktree)
  .halts(ownerDecision)
  .output(z.object({ summary: z.string() }));

const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(opus)
  .pool(claudePool)
  .workspace(worktree)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.seat('planner')
  .role(plannerRole)
  .model(opus)
  .pool(claudePool)
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }));

const workItem = z.object({ ref: z.string(), title: z.string(), body: z.string() });

const Ready = H.state('ready', 'pending');
const NeedsOwner = H.state('needs-owner', 'waiting');
const Done = H.terminal('done', 'success');

const bugKind = H.kind('Bug').attributes(workItem).states(Ready, NeedsOwner, Done).key(a => a.ref).initial(Ready);
const featureKind = H.kind('Feature').attributes(workItem).states(Ready, NeedsOwner, Done).key(a => a.ref).initial(Ready);

const EpicOpen = H.state('open', 'pending');
const EpicStalled = H.state('stalled', 'waiting');
const EpicComplete = H.terminal('complete', 'success');
const epicKind = H.kind('Epic').attributes(workItem).states(EpicOpen, EpicStalled, EpicComplete).key(a => a.ref).initial(EpicOpen);

const service = H.facet('service', ['api', 'web', 'worker']);
const heartbeatAttrs = z.object({ service: service.schema });
const HeartbeatDue = H.state('due', 'pending');
const Healthy = H.terminal('healthy', 'success');
const Unhealthy = H.terminal('unhealthy', 'failure');
const heartbeatKind = H.kind('ServiceHeartbeat')
  .attributes(heartbeatAttrs)
  .states(HeartbeatDue, Healthy, Unhealthy)
  .key(a => a.service)
  .initial(HeartbeatDue);

const probeService = H.command('probe-service')
  .input(heartbeatAttrs)
  .argv(i => ['./scripts/probe.sh', i.service])
  .acceptExitCodes(0, 1)
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatAttrs)
  .step('probe', probeService, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy', ctx => ctx.steps.probe.exitCode === 0)
  .exit('unhealthy');

const buildAndAudit = H.flow('build-and-audit')
  .input(workItem)
  .params(z.object({ rounds: z.number().int() }))
  .loop(
    'rounds',
    { schema: z.array(z.string()), initial: [] },
    round => round
      .step('build', builder, ctx => ({
        task: [
          `Implement: ${ctx.unit.attributes.title}`,
          ctx.unit.attributes.body,
          ...ctx.steps.rounds.map(deficit => `Open deficit: ${deficit}`),
        ].join('\n'),
      }))
      .step('audit', auditor, ctx => ({
        task: `Audit the change for: ${ctx.unit.attributes.title}\nBuilder summary: ${ctx.steps.build.summary}`,
      })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
      next: ctx => ctx.steps.audit.deficits,
    },
  )
  .exit('done', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('unresolved');

const trackerKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({ apiKey: trackerKey, team: 'ENG', workflow: ['Todo', 'In Progress', 'Blocked', 'Done'] });

const bugLane = H.lane('bugs', bugKind)
  .supply(linear.issues({ apiKey: trackerKey, team: 'ENG', labels: ['bug'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }))
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ ref: file.path, title: file.name, body: file.body }))
  .supply(H.operator)
  .handler(buildAndAudit, { exits: { done: Done, unresolved: NeedsOwner }, params: { rounds: 3 } })
  .store(tracker, { states: { ready: 'Todo', 'needs-owner': 'Blocked', done: 'Done' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: NeedsOwner })
  .on(ownerReplied, { update: (a, p) => ({ ...a, body: `${a.body}\n\nOwner: ${p.note}` }), enter: Ready });

const featureLane = H.lane('features', featureKind)
  .supply(linear.issues({ apiKey: trackerKey, team: 'ENG', labels: ['feature'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }))
  .supply(H.operator)
  .handler(buildAndAudit, { exits: { done: Done, unresolved: NeedsOwner }, params: { rounds: 5 } })
  .store(tracker, { states: { ready: 'Todo', 'needs-owner': 'Blocked', done: 'Done' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: NeedsOwner })
  .on(ownerReplied, { update: (a, p) => ({ ...a, body: `${a.body}\n\nOwner: ${p.note}` }), enter: Ready });

const decompose = H.flow('decompose')
  .input(workItem)
  .step('plan', planner, ctx => ({
    task: `Decompose this epic into features:\n${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
  }))
  .spawn('features', featureLane, ctx =>
    ctx.steps.plan.features.map((feature, index) => ({
      ref: `${ctx.unit.key}/${index + 1}`,
      title: feature.title,
      body: feature.body,
    })))
  .exit('completed', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('stalled');

const epicLane = H.lane('epics', epicKind)
  .supply(linear.issues({ apiKey: trackerKey, team: 'ENG', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }))
  .handler(decompose, { exits: { completed: EpicComplete, stalled: EpicStalled } })
  .store(tracker, { states: { open: 'Todo', stalled: 'Blocked', complete: 'Done' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: EpicStalled })
  .on(ownerReplied, { update: (a, p) => ({ ...a, body: `${a.body}\n\nOwner: ${p.note}` }), enter: EpicOpen });

const heartbeatLane = H.lane('heartbeats', heartbeatKind)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (_tick, to) =>
    service.values.map(s => to.create({ service: s })))
  .handler(heartbeatFlow, { exits: { healthy: Healthy, unhealthy: Unhealthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.when.transition(heartbeatLane, { to: Unhealthy }))
  .create(bugLane, e => ({
    ref: `heartbeat/${e.unit.attributes.service}`,
    title: `Service ${e.unit.attributes.service} failed its heartbeat`,
    body: `The deterministic heartbeat probe failed at ${e.at.toISOString()}.`,
  }));

const scheduler = H.scheduler('coding')
  .expedite(heartbeatLane)
  .standard(bugLane, featureLane, epicLane)
  .wip(bugLane, 2)
  .wip(epicLane, 1)
  .aging(featureLane, { afterMinutes: 240 });

const productionHealth = H.operation(
  'production-health',
  H.command('probe-production').argv(['./scripts/probe-production.sh']).runner(localRunner),
);

const supervisor = claudeCode.supervisor('supervisor', {
  port: H.slot.port(0),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workSignal,
    H.ops.resolve(ownerDecision),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealth,
  ],
});

export default H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .journals(experience, taste)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
