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

const Open = H.state('open', 'pending');
const NeedsOwner = H.state('needs-owner', 'waiting');
const Done = H.terminal('done', 'success');
const Abandoned = H.terminal('abandoned', 'failure');
const Due = H.state('due', 'pending');
const Healthy = H.terminal('healthy', 'success');
const Unhealthy = H.terminal('unhealthy', 'failure');

const service = H.facet('service', ['api', 'worker', 'web']);

const work = z.object({ ref: z.string(), title: z.string(), description: z.string() });
const heartbeatTick = z.object({ service: service.schema, tick: z.string() });

const Epic = H.kind('epic').attributes(work).states(Open, NeedsOwner, Done, Abandoned).key(a => a.ref).initial(Open);
const Feature = H.kind('feature').attributes(work).states(Open, NeedsOwner, Done, Abandoned).key(a => a.ref).initial(Open);
const Bug = H.kind('bug').attributes(work).states(Open, NeedsOwner, Done, Abandoned).key(a => a.ref).initial(Open);
const Heartbeat = H.kind('service-heartbeat')
  .attributes(heartbeatTick)
  .states(Due, Healthy, Unhealthy)
  .key(a => `${a.service}@${a.tick}`)
  .initial(Due);

const builderRole = H.role('builder').intents('read', 'edit', 'run', 'halt').instructions('Implement the change; keep the project checks green.');
const auditorRole = H.role('auditor').intents('read', 'run', 'record').instructions('List every deficit in the change; record lessons as forward-phrased experience.');
const plannerRole = H.role('planner').intents('read').instructions('Decompose an epic into independently shippable features.');

const experience = H.journal('team-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const taste = H.journal('owner-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, plannerRole);

const sharedQuota = sqlite.quota('claude-accounts', { path: '../shared/quota.db' });
const subscriptionA = claudeCode.subscription('claude-a', { token: H.env('CLAUDE_A_TOKEN'), quota: sharedQuota });
const subscriptionB = claudeCode.subscription('claude-b', { token: H.env('CLAUDE_B_TOKEN'), quota: sharedQuota });
const subscriptionC = claudeCode.subscription('claude-c', { token: H.env('CLAUDE_C_TOKEN'), quota: sharedQuota });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedQuota });

const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  [...ctx.candidates]
    .filter(c => (c.cooldownUntil === undefined || c.cooldownUntil.getTime() <= ctx.now.getTime()) && c.shareUsed < c.shareCap)
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const teamPool = H.pool('team')
  .accounts(subscriptionA, subscriptionB, subscriptionC)
  .share(subscriptionA, 0.6)
  .share(subscriptionB, 0.6)
  .share(subscriptionC, 0.4)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.outcomes({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples >= 20 && cheap.successRate < 0.85 ? opus : sonnet;
});

const workstation = local.runner('workstation');
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(workstation);

const worktree = git.worktree({ repo: '.', base: 'main' }).guard({ exclusiveWrites: true, beforeStop: projectChecks });

const ownerDecision = H.halt('owner-decision').decision(z.object({ answer: z.string() }));
const ownerUnblocked = H.signal('owner-unblocked');

const builder = H.seat('builder').role(builderRole).model(builderModel).pool(teamPool).workspace(worktree).halts(ownerDecision);

const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(opus)
  .pool(teamPool)
  .workspace(worktree)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.seat('planner')
  .role(plannerRole)
  .model(opus)
  .pool(teamPool)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const buildAndAudit = H.flow('build-and-audit')
  .input(work)
  .params(z.object({ rounds: z.number().int().positive() }))
  .loop(
    'rounds',
    { schema: z.array(z.string()), initial: [] },
    f =>
      f
        .step('build', builder, ctx => ({
          task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}\n\nOpen deficits:\n${ctx.steps.rounds.join('\n')}`,
          skills: ['typescript'],
        }))
        .step('audit', auditor, ctx => ({
          task: `Audit the change for "${ctx.unit.attributes.title}". Builder report:\n${ctx.steps.build}`,
        })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
      next: ctx => ctx.steps.audit.deficits,
    },
  )
  .exit('shipped', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('unfinished');

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({ apiKey: linearKey, team: 'ENG', workflow: ['Todo', 'In Progress', 'Blocked', 'Done', 'Canceled'] });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['feature'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(H.operator)
  .handler(buildAndAudit, { exits: { shipped: Done, unfinished: NeedsOwner }, params: { rounds: 5 } })
  .store(tracker, {
    states: { open: 'Todo', 'needs-owner': 'Blocked', done: 'Done', abandoned: 'Canceled' },
    inFlight: 'In Progress',
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: NeedsOwner })
  .on(ownerUnblocked, { enter: Open });

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['bug'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ ref: `file/${file.path}`, title: file.name, description: file.body }),
  )
  .supply(H.operator)
  .handler(buildAndAudit, { exits: { shipped: Done, unfinished: NeedsOwner }, params: { rounds: 3 } })
  .store(tracker, {
    states: { open: 'Todo', 'needs-owner': 'Blocked', done: 'Done', abandoned: 'Canceled' },
    inFlight: 'In Progress',
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: NeedsOwner })
  .on(ownerUnblocked, { enter: Open });

const decompose = H.flow('decompose-epic')
  .input(work)
  .step('plan', planner, ctx => ({
    task: `Decompose the epic "${ctx.unit.attributes.title}":\n${ctx.unit.attributes.description}`,
  }))
  .spawn('features', features, ctx =>
    ctx.steps.plan.features.map((feature, index) => ({
      ref: `${ctx.unit.attributes.ref}/${index + 1}`,
      title: feature.title,
      description: feature.description,
    })),
  )
  .exit('complete', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .handler(decompose, { exits: { complete: Done, incomplete: NeedsOwner } })
  .store(tracker, {
    states: { open: 'Todo', 'needs-owner': 'Blocked', done: 'Done', abandoned: 'Canceled' },
    inFlight: 'In Progress',
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300_000, exhausted: NeedsOwner })
  .on(ownerUnblocked, { enter: Open });

const probeService = H.command('probe-service')
  .input(z.object({ service: service.schema }))
  .argv(input => ['./ops/probe', input.service])
  .acceptExitCodes(0, 1)
  .runner(workstation);

const heartbeatFlow = H.flow('service-heartbeat')
  .input(heartbeatTick)
  .step('probe', probeService, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy', ctx => ctx.steps.probe.exitCode === 0)
  .exit('unhealthy');

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    service.values.map(name => to.create({ service: name, tick: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, { exits: { healthy: Healthy, unhealthy: Unhealthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, event => ({
    ref: `heartbeat/${event.unit.attributes.service}`,
    title: `Service ${event.unit.attributes.service} failed its heartbeat`,
    description: `The heartbeat at ${event.unit.attributes.tick} reported the service unhealthy.`,
  }));

const scheduler = H.scheduler('team')
  .expedite(heartbeats)
  .standard(bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .aging(features, { afterMinutes: 180 });

const productionHealth = H.operation(
  'production-health',
  H.command('production-health-probe').argv(['./ops/production-health']).runner(workstation),
);

const supervisor = claudeCode.supervisor('supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workSignal,
    H.ops.resolve(ownerDecision),
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealth,
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(experience, taste)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void codingTeam.start();
