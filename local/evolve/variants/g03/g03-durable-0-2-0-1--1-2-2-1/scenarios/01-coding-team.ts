import { z } from 'zod';
import { H } from 'harness-dsl';
import { linear, LinearIssue } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const quota = sqlite.quota('claude-subscriptions', { path: '../shared/quota.sqlite' });
const subscriptionA = claudeCode.subscription('subscription-a', { token: H.env('CLAUDE_TOKEN_A'), quota });
const subscriptionB = claudeCode.subscription('subscription-b', { token: H.env('CLAUDE_TOKEN_B'), quota });
const subscriptionC = claudeCode.subscription('subscription-c', { token: H.env('CLAUDE_TOKEN_C'), quota });
const apiAccount = claudeCode.apiKey('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', ctx =>
  ctx.candidates
    .filter(state => state.shareUsed < state.shareCap && (state.cooldownUntil === undefined || state.cooldownUntil <= ctx.now))
    .sort((left, right) => left.windowResetsAt.getTime() - right.windowResetsAt.getTime())[0]);

const claudePool = H.pool('claude')
  .accounts(subscriptionA, subscriptionB, subscriptionC)
  .share(subscriptionA, 0.6)
  .share(subscriptionB, 0.6)
  .share(subscriptionC, 0.4)
  .drain(soonestExpiringFirst)
  .fallback(apiAccount);

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const localRunner = local.runner('local').slots(4);

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the unit of work in the worktree until the project checks pass.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('List every deficit against the request. Record lessons that will help future builds.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Split the epic into independently shippable features.');

const workSchema = z.object({
  ref: z.string(),
  title: z.string(),
  description: z.string(),
  notes: z.array(z.string()),
});

const open = H.state('open', 'pending');
const shipped = H.terminal('shipped', 'success');
const dropped = H.terminal('dropped', 'neutral');
const abandoned = H.terminal('abandoned', 'failure');

const bug = H.kind('Bug').attributes(workSchema).states(open, shipped, dropped, abandoned).initial(open).key(work => work.ref);
const feature = H.kind('Feature').attributes(workSchema).states(open, shipped, dropped, abandoned).initial(open).key(work => work.ref);
const epic = H.kind('Epic').attributes(workSchema).states(open, shipped, dropped, abandoned).initial(open).key(work => work.ref);

const service = H.facet('service', ['api', 'web', 'worker']);
const due = H.state('due', 'pending');
const healthy = H.terminal('healthy', 'success');
const unhealthy = H.terminal('unhealthy', 'failure');
const heartbeat = H.kind('ServiceHeartbeat')
  .attributes(z.object({ service: service.schema }))
  .states(due, healthy, unhealthy)
  .initial(due);

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);
const worktree = git.worktree({ repo: '.', base: 'main' }).guard({ leaseEdits: true, beforeStop: projectChecks });

const ownerDecision = H.halt('owner-decision').decision(z.object({ answer: z.string() }));
const ownerReview = H.halt('owner-review').decision(z.object({
  verdict: z.enum(['accept', 'drop', 'reopen']),
  notes: z.string(),
}));

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
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const deliver = H.flow('deliver')
  .input(workSchema)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'round',
    { schema: z.array(z.string()), initial: [] },
    round => round
      .step('build', builder, ctx => ({
        task: `${ctx.unit.attributes.title}\n${ctx.unit.attributes.description}\nOwner notes: ${ctx.unit.attributes.notes.join('; ')}\nOpen deficits:\n${ctx.steps.round.join('\n')}`,
      }), { afterCrash: 'askDriver' })
      .step('audit', auditor, ctx => ({
        task: `Audit the change for ${ctx.unit.attributes.title}. Builder summary: ${ctx.steps.build.summary}`,
      }), { afterCrash: 'askDriver' }),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
      next: ctx => ctx.steps.audit.deficits,
    },
  )
  .halt('review', ownerReview, {
    ask: ctx => `Deficits remain after ${ctx.params.rounds} rounds:\n${ctx.steps.audit.deficits.join('\n')}`,
    when: ctx => ctx.steps.audit.deficits.length > 0,
  })
  .exit('shipped', ctx => ctx.steps.review === undefined || ctx.steps.review.verdict === 'accept')
  .exit('dropped', ctx => ctx.steps.review?.verdict === 'drop')
  .exit('reopened', {
    update: ctx => ({ notes: [...ctx.unit.attributes.notes, ctx.steps.review?.notes ?? 'reopened by owner'] }),
  });

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({
  apiKey: linearKey,
  team: 'PRD',
  workflow: ['Todo', 'In Progress', 'In Review', 'Done', 'Canceled'],
});
const fromIssue = (issue: LinearIssue) => ({
  ref: issue.identifier,
  title: issue.title,
  description: issue.description,
  notes: [],
});

const bugLane = H.lane('bugs', bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'PRD', labels: ['bug'] }), (issue, to) => to.create(fromIssue(issue)))
  .supply(folder.files({ path: 'inbox/bugs', glob: '*.md' }), (file, to) => to.create({
    ref: file.path,
    title: file.name,
    description: file.body,
    notes: [],
  }))
  .supply(H.operator)
  .handler(deliver, { exits: { shipped, dropped, reopened: open }, params: { rounds: 3 } })
  .store(tracker, {
    states: { open: 'Todo', shipped: 'Done', dropped: 'Canceled', abandoned: 'Canceled' },
    inFlight: 'In Progress',
    steps: { review: 'In Review' },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: abandoned })
  .on(H.cancel, { enter: dropped });

const featureLane = H.lane('features', feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'PRD', labels: ['feature'] }), (issue, to) => to.create(fromIssue(issue)))
  .supply(H.operator)
  .handler(deliver, { exits: { shipped, dropped, reopened: open }, params: { rounds: 5 } })
  .store(tracker, {
    states: { open: 'Todo', shipped: 'Done', dropped: 'Canceled', abandoned: 'Canceled' },
    inFlight: 'In Progress',
    steps: { review: 'In Review' },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: abandoned })
  .on(H.cancel, { enter: dropped });

const decompose = H.flow('decompose')
  .input(workSchema)
  .step('plan', planner, ctx => ({
    task: `Decompose the epic ${ctx.unit.attributes.title}:\n${ctx.unit.attributes.description}`,
  }), { afterCrash: 'askDriver' })
  .spawn('features', featureLane, ctx => ctx.steps.plan.features.map((planned, index) => ({
    ref: `${ctx.unit.key}-${index + 1}`,
    title: planned.title,
    description: planned.description,
    notes: [],
  })))
  .exit('completed', ctx => ctx.steps.features.every(child => child.verdict === 'success' || child.verdict === 'neutral'))
  .exit('incomplete');

const epicLane = H.lane('epics', epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'PRD', labels: ['epic'] }), (issue, to) => to.create(fromIssue(issue)))
  .handler(decompose, { exits: { completed: shipped, incomplete: abandoned } })
  .store(tracker, {
    states: { open: 'Todo', shipped: 'Done', dropped: 'Canceled', abandoned: 'Canceled' },
    inFlight: 'In Progress',
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300000, exhausted: abandoned })
  .on(H.cancel, { enter: dropped });

const probeService = H.command('probe-service')
  .input(z.object({ service: service.schema }))
  .argv(input => ['./scripts/probe.sh', input.service])
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(z.object({ service: service.schema }))
  .step('probe', probeService, ctx => ({ service: ctx.unit.attributes.service }), { afterCrash: 'rerun' })
  .exit('healthy');

const heartbeatLane = H.lane('heartbeats', heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) => service.values.map(name => to.create({ service: name })))
  .handler(heartbeatFlow, { exits: { healthy } })
  .retry({ maxAttempts: 1, exhausted: unhealthy });

const unhealthyServiceFilesBug = H.trigger('unhealthy-service-files-bug')
  .on(H.when.transition(heartbeatLane, { to: unhealthy }))
  .create(bugLane, event => ({
    ref: `heartbeat-${event.unit.attributes.service}-${event.at.toISOString()}`,
    title: `Service ${event.unit.attributes.service} failed its heartbeat`,
    description: `The heartbeat probe for ${event.unit.attributes.service} failed at ${event.at.toISOString()}.`,
    notes: [],
  }));

const experience = H.memory('experience', 'experience');
const taste = H.memory('taste', 'taste');

const experienceJournal = H.journal('coding-experience', experience)
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const tasteJournal = H.journal('owner-taste', taste)
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 20 })
  .readBy(builderRole, plannerRole);

const scheduler = H.scheduler('coding-team')
  .expedite(heartbeatLane)
  .standard(bugLane, featureLane, epicLane)
  .wip(bugLane, 2)
  .wip(epicLane, 1)
  .aging(featureLane, { afterMinutes: 240 });

const productionProbe = H.command('production-health-probe')
  .argv(['./scripts/probe-production.sh'])
  .runner(localRunner);

const supervisor = claudeCode.supervisor('supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workMove,
    H.ops.workCancel,
    H.ops.resolve(ownerDecision, ownerReview),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    H.operation('production-health', productionProbe),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .journals(experienceJournal, tasteJournal)
  .triggers(unhealthyServiceFilesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void codingTeam.start();
