import { z } from 'zod';
import { H, AccountState } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const Todo = H.state('Todo', 'pending');
const NeedsOwner = H.state('NeedsOwner', 'waiting');
const Done = H.terminal('Done', 'success');
const Abandoned = H.terminal('Abandoned', 'failure');
const Scheduled = H.state('Scheduled', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const ticket = z.object({ ref: z.string(), title: z.string(), description: z.string() });
const featureTicket = ticket.extend({ epic: z.string().optional() });
const heartbeatAttrs = z.object({ service: z.string(), checkedAt: z.date() });

const Bug = H.kind('Bug').attributes(ticket).states(Todo, NeedsOwner, Done, Abandoned).key(a => a.ref).initial(Todo);
const Feature = H.kind('Feature').attributes(featureTicket).states(Todo, NeedsOwner, Done, Abandoned).key(a => a.ref).initial(Todo);
const Epic = H.kind('Epic').attributes(ticket).states(Todo, NeedsOwner, Done, Abandoned).key(a => a.ref).initial(Todo);
const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(heartbeatAttrs)
  .states(Scheduled, Healthy, Unhealthy)
  .key(a => `${a.service}@${a.checkedAt.toISOString()}`)
  .initial(Scheduled);

const ownerDecision = H.halt('owner-decision').decision(z.object({ answer: z.string() }));

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the task in the worktree. Fix every listed deficit. Halt for the owner when a product decision is needed.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('Find deficits in the change against the task. Return an empty list when none remain.')
  .output(z.object({ deficits: z.array(z.string()) }));
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.')
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const subscriptionQuota = sqlite.quota('claude-subscriptions', { path: '../shared/quota.sqlite' });
const maxPlanOne = claudeCode.subscription('max-plan-one', { token: H.env('CLAUDE_MAX_ONE_TOKEN'), quota: subscriptionQuota });
const maxPlanTwo = claudeCode.subscription('max-plan-two', { token: H.env('CLAUDE_MAX_TWO_TOKEN'), quota: subscriptionQuota });
const maxPlanThree = claudeCode.subscription('max-plan-three', { token: H.env('CLAUDE_MAX_THREE_TOKEN'), quota: subscriptionQuota });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: subscriptionQuota });

const dedicatedPlanShare = 0.9;
const sharedWithPersonalUseShare = 0.5;

const soonestExpiringWindow = H.policy.account('soonest-expiring-window', ctx =>
  ctx.candidates
    .filter(c => c.shareUsed < c.shareCap && (c.cooldownUntil === undefined || c.cooldownUntil <= ctx.now))
    .reduce<AccountState | undefined>(
      (best, c) => (best === undefined || c.windowResetsAt < best.windowResetsAt ? c : best),
      undefined,
    ),
);

const claudePool = H.pool('claude')
  .accounts(maxPlanOne, maxPlanTwo, maxPlanThree)
  .share(maxPlanOne, dedicatedPlanShare)
  .share(maxPlanTwo, dedicatedPlanShare)
  .share(maxPlanThree, sharedWithPersonalUseShare)
  .drain(soonestExpiringWindow)
  .fallback(apiAccount);

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const minimumSamples = 20;
const minimumCheapSuccessRate = 0.85;

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  if (cheap.samples < minimumSamples) return sonnet;
  return cheap.successRate < minimumCheapSuccessRate ? opus : sonnet;
});

const builder = H.seat('builder').role(builderRole).model(builderModel).pool(claudePool).halts(ownerDecision);
const auditor = H.seat('auditor').role(auditorRole).model(sonnet).pool(claudePool);
const planner = H.seat('planner').role(plannerRole).model(opus).pool(claudePool);

const localRunner = local.runner('local');
const worktree = git.worktree({ repo: '.', base: 'main' });
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);
const probeProduction = H.command('probe-production').argv(['./scripts/health-probe.sh', '--env', 'production']).runner(localRunner);

const buildAndAudit = H.flow('build-and-audit')
  .input(ticket)
  .params(z.object({ rounds: z.number().int().positive() }))
  .loop(
    'rounds',
    z.object({ deficits: z.array(z.string()) }),
    round =>
      round
        .step(
          'build',
          builder,
          ctx => ({
            task: [
              ctx.unit.attributes.title,
              ctx.unit.attributes.description,
              ...(ctx.steps.rounds?.deficits ?? []).map(d => `Fix deficit: ${d}`),
            ].join('\n\n'),
          }),
          { workspace: worktree, guard: { leaseFiles: true, beforeStop: projectChecks }, afterCrash: 'askDriver' },
        )
        .step(
          'audit',
          auditor,
          ctx => ({ task: `Audit the change for "${ctx.unit.attributes.title}" against:\n${ctx.unit.attributes.description}` }),
          { workspace: worktree, afterCrash: 'askDriver' },
        ),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
      carry: ctx => ({ deficits: ctx.steps.audit.deficits }),
    },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('roundsExhausted');

const heartbeatFlow = H.flow('heartbeat').step('probe', probeProduction, { afterCrash: 'rerun' }).exit('healthy');

const trackerKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({ apiKey: trackerKey, team: 'PROD', workflow: ['Todo', 'In Progress', 'Blocked', 'Done', 'Canceled'] });
const trackerStates = { Todo: 'Todo', NeedsOwner: 'Blocked', Done: 'Done', Abandoned: 'Canceled' } as const satisfies Record<string, string>;

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) => to.create({ service: 'production', checkedAt: tick.at }))
  .handler(heartbeatFlow, { exits: { healthy: Healthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PROD', labels: ['bug'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ ref: `file:${file.path}`, title: file.name, description: file.body }),
  )
  .supply(H.operator)
  .handler(buildAndAudit, { exits: { clean: Done, roundsExhausted: NeedsOwner }, params: { rounds: 3 } })
  .store(tracker, { states: trackerStates, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: NeedsOwner })
  .on(H.cancel, { enter: Abandoned });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PROD', labels: ['feature'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(H.operator)
  .handler(buildAndAudit, { exits: { clean: Done, roundsExhausted: NeedsOwner }, params: { rounds: 5 } })
  .store(tracker, { states: trackerStates, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: NeedsOwner })
  .on(H.cancel, { enter: Abandoned });

const planEpic = H.flow('plan-epic')
  .input(ticket)
  .step('plan', planner, ctx => ({
    task: `Decompose this epic into features.\n${ctx.unit.attributes.title}\n${ctx.unit.attributes.description}`,
  }))
  .spawn('features', features, ctx =>
    ctx.steps.plan.features.map((f, i) => ({
      ref: `${ctx.unit.attributes.ref}-f${i + 1}`,
      title: f.title,
      description: f.description,
      epic: ctx.unit.attributes.ref,
    })),
  )
  .exit('featuresDone', ctx => ctx.steps.features.every(c => c.verdict === 'success'))
  .exit('featuresIncomplete');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PROD', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .handler(planEpic, { exits: { featuresDone: Done, featuresIncomplete: NeedsOwner } })
  .store(tracker, { states: trackerStates, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300_000, exhausted: NeedsOwner })
  .on(H.cancel, { enter: Abandoned });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, e => ({
    ref: `heartbeat-${e.unit.attributes.service}-${e.at.toISOString()}`,
    title: `Heartbeat failed for ${e.unit.attributes.service}`,
    description: `The production health probe failed at ${e.at.toISOString()}. Find the cause and fix it.`,
  }));

const experience = H.journal('coding-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const taste = H.journal('owner-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, plannerRole);

const scheduler = H.scheduler('coding-team')
  .standard(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .aging(features, { afterMinutes: 240 });

const productionHealthProbe = H.operation('production-health-probe', probeProduction);

const supervisor = claudeCode.supervisor('supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.resolve(ownerDecision),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealthProbe,
  ],
});

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: 'harness.sqlite' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(experience, taste)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
