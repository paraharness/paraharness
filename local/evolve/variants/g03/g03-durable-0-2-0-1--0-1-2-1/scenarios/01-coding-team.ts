import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const workItem = z.object({ ref: z.string(), title: z.string(), description: z.string() });
const heartbeatItem = z.object({ service: z.string(), at: z.string() });

const Todo = H.state('Todo', 'pending');
const Stalled = H.state('Stalled', 'waiting');
const Done = H.terminal('Done', 'success');
const Abandoned = H.terminal('Abandoned', 'failure');
const EpicOpen = H.state('EpicOpen', 'pending');
const EpicDelivered = H.terminal('EpicDelivered', 'success');
const EpicPartial = H.terminal('EpicPartial', 'failure');
const BeatDue = H.state('BeatDue', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const Bug = H.kind('Bug').attributes(workItem).states(Todo, Stalled, Done, Abandoned).key(a => a.ref).initial(Todo);
const Feature = H.kind('Feature').attributes(workItem).states(Todo, Stalled, Done, Abandoned).key(a => a.ref).initial(Todo);
const Epic = H.kind('Epic').attributes(workItem).states(EpicOpen, EpicDelivered, EpicPartial).key(a => a.ref).initial(EpicOpen);
const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(heartbeatItem)
  .states(BeatDue, Healthy, Unhealthy)
  .key(a => a.service)
  .initial(BeatDue);

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the task in the worktree and keep the project checks green.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('Find deficits against the task, one sentence each. Report none when the work is complete.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');

const claudeQuota = sqlite.quota('claude-accounts', { path: '../shared/claude-quota.sqlite' });
const subscriptionA = claudeCode.subscription('claude-max-a', { token: H.env('CLAUDE_TOKEN_A'), quota: claudeQuota });
const subscriptionB = claudeCode.subscription('claude-max-b', { token: H.env('CLAUDE_TOKEN_B'), quota: claudeQuota });
const subscriptionC = claudeCode.subscription('claude-max-c', { token: H.env('CLAUDE_TOKEN_C'), quota: claudeQuota });
const apiAccount = claudeCode.apiKey('claude-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: claudeQuota });

const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  ctx.candidates
    .filter(a => a.shareUsed < a.shareCap && (a.cooldownUntil === undefined || a.cooldownUntil <= ctx.now))
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const claudePool = H.pool('claude-subscriptions')
  .accounts(subscriptionA, subscriptionB, subscriptionC)
  .share(subscriptionA, 1)
  .share(subscriptionB, 0.7)
  .share(subscriptionC, 0.5)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheaper = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(claudePool)
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
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const ownerDecision = H.halt('owner-decision').decision(z.object({ choice: z.string(), note: z.string().optional() }));

const localRunner = local.runner('local').slots(4);
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);
const worktree = git.worktree({ repo: '.', base: 'main' });

const buildAudit = H.flow('build-audit')
  .input(workItem)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    { carry: z.object({ deficits: z.array(z.string()) }), initial: { deficits: [] } },
    round =>
      round
        .step(
          'build',
          builder,
          ctx => ({
            task:
              ctx.steps.rounds.deficits.length === 0
                ? `Implement: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`
                : `Implement: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}\n\nFix these deficits from the last audit:\n- ${ctx.steps.rounds.deficits.join('\n- ')}`,
          }),
          {
            workspace: worktree,
            guard: { leaseFiles: true, beforeStop: projectChecks },
            halts: [ownerDecision],
            afterCrash: 'askDriver',
          },
        )
        .step(
          'audit',
          auditor,
          ctx => ({
            task: `Audit the change for: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}\n\nBuilder summary: ${ctx.steps.build.summary}\nFiles: ${ctx.steps.build.filesChanged.join(', ')}`,
          }),
          { workspace: worktree, afterCrash: 'rerun' },
        ),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
      next: ctx => ({ deficits: ctx.steps.audit.deficits }),
    },
  )
  .exit('done', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('incomplete');

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({
  apiKey: linearKey,
  team: 'PRODUCT',
  workflow: ['Todo', 'In Progress', 'Blocked', 'Done', 'Canceled'],
});

const bugLane = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'PRODUCT', labels: ['bug'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(folder.files({ path: './bugs', glob: '*.md' }), (file, to) =>
    to.create({ ref: file.path, title: file.name, description: file.body }),
  )
  .supply(H.operator)
  .handler(buildAudit, { exits: { done: Done, incomplete: Stalled }, params: { rounds: 3 } })
  .store(tracker, {
    states: { Todo: 'Todo', Stalled: 'Blocked', Done: 'Done', Abandoned: 'Canceled' },
    inFlight: 'In Progress',
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: Abandoned });

const featureLane = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'PRODUCT', labels: ['feature'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(H.operator)
  .handler(buildAudit, { exits: { done: Done, incomplete: Stalled }, params: { rounds: 5 } })
  .store(tracker, {
    states: { Todo: 'Todo', Stalled: 'Blocked', Done: 'Done', Abandoned: 'Canceled' },
    inFlight: 'In Progress',
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: Abandoned });

const epicFlow = H.flow('epic-decompose')
  .input(workItem)
  .step('plan', planner, ctx => ({
    task: `Decompose this epic into features.\n\n${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
  }))
  .spawn('features', featureLane, ctx =>
    ctx.steps.plan.features.map((feature, index) => ({
      ref: `${ctx.unit.attributes.ref}-${index + 1}`,
      title: feature.title,
      description: feature.description,
    })),
  )
  .exit('complete', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epicLane = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'PRODUCT', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .handler(epicFlow, { exits: { complete: EpicDelivered, incomplete: EpicPartial } })
  .store(sqlite.store({ path: './.harness/epics.sqlite' }))
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300000, exhausted: EpicPartial });

const heartbeatProbe = H.command('service-heartbeat')
  .argv(['./scripts/heartbeat.sh', 'api'])
  .runner(localRunner)
  .acceptExitCodes(0, 1);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatItem)
  .step('probe', heartbeatProbe, { afterCrash: 'rerun' })
  .exit('healthy', ctx => ctx.steps.probe.exitCode === 0)
  .exit('unhealthy');

const heartbeatLane = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    to.create({ service: 'api', at: tick.at.toISOString() }),
  )
  .handler(heartbeatFlow, { exits: { healthy: Healthy, unhealthy: Unhealthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const heartbeatFilesBug = H.trigger('heartbeat-files-bug')
  .on(H.when.transition(heartbeatLane, { to: Unhealthy }))
  .create(bugLane, e => ({
    ref: `heartbeat-${e.unit.attributes.service}`,
    title: `Service ${e.unit.attributes.service} heartbeat failed`,
    description: `The heartbeat at ${e.unit.attributes.at} failed. Diagnose the service and fix the cause.`,
  }));

const experienceJournal = H.journal('experience', H.memory('engineering-experience', 'experience'))
  .store(jsonl.memoryStore({ path: './memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const tasteJournal = H.journal('taste', H.memory('owner-taste', 'taste'))
  .store(jsonl.memoryStore({ path: './memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 20 })
  .readBy(builderRole, plannerRole);

const scheduler = H.scheduler('coding-team')
  .standard(heartbeatLane, bugLane, featureLane, epicLane)
  .wip(bugLane, 2)
  .wip(epicLane, 1)
  .aging(featureLane, { afterMinutes: 240 });

const productionProbe = H.operation(
  'production-health-probe',
  H.command('production-probe').argv(['./scripts/production-probe.sh']).runner(localRunner),
);

const supervisor = claudeCode.supervisor('supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.resolve(ownerDecision),
    H.ops.attemptsRecover,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionProbe,
  ],
  port: H.slot.port(0),
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: './.harness/ledger.sqlite' }))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .journals(experienceJournal, tasteJournal)
  .triggers(heartbeatFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));

void codingTeam.start();
