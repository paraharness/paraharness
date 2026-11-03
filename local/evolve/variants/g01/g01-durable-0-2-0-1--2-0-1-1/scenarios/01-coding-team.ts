import { H } from 'harness-dsl';
import type { AccountState, Router } from 'harness-dsl';
import { z } from 'zod';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear } from 'harness-dsl/linear';
import type { LinearIssue } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { markdown } from 'harness-dsl/markdown';

const WorkAttributes = z.object({
  title: z.string(),
  body: z.string(),
  trackerId: z.string().optional(),
});
type WorkAttrs = z.infer<typeof WorkAttributes>;

const HeartbeatAttributes = z.object({ service: z.string(), dueAt: z.string() });

const Backlog = H.state('Backlog', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const AwaitingOwner = H.state('AwaitingOwner', 'waiting');
const Triage = H.state('Triage', 'waiting');
const Done = H.terminal('Done', 'success');
const Cancelled = H.terminal('Cancelled', 'neutral');

const Bug = H.kind('Bug')
  .attributes(WorkAttributes)
  .states(Backlog, Building, Auditing, AwaitingOwner, Triage, Done, Cancelled)
  .key(work => work.trackerId ?? work.title)
  .initial(Backlog);

const Feature = H.kind('Feature')
  .attributes(WorkAttributes)
  .states(Backlog, Building, Auditing, AwaitingOwner, Triage, Done, Cancelled)
  .key(work => work.trackerId ?? work.title)
  .initial(Backlog);

const Proposed = H.state('Proposed', 'pending');
const Planning = H.state('Planning', 'active');
const Delivering = H.state('Delivering', 'waiting');
const Stalled = H.state('Stalled', 'waiting');
const Delivered = H.terminal('Delivered', 'success');
const Dropped = H.terminal('Dropped', 'neutral');

const Epic = H.kind('Epic')
  .attributes(WorkAttributes)
  .states(Proposed, Planning, Delivering, Stalled, Delivered, Dropped)
  .key(epic => epic.trackerId ?? epic.title)
  .initial(Proposed);

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Probing = H.state('Probing', 'active');
const Up = H.terminal('Up', 'success');
const Down = H.terminal('Down', 'failure');

const Heartbeat = H.kind('ServiceHeartbeat')
  .attributes(HeartbeatAttributes)
  .states(HeartbeatDue, Probing, Up, Down)
  .key(beat => `${beat.service}@${beat.dueAt}`)
  .initial(HeartbeatDue);

const subscriptionOne = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1') });
const subscriptionTwo = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2') });
const subscriptionThree = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiring = H.policy.account('soonest-expiring-window', ctx =>
  ctx.candidates
    .filter(state => (state.cooldownUntil === undefined || state.cooldownUntil <= ctx.now) && state.shareUsed < state.shareCap)
    .reduce<AccountState | undefined>(
      (best, state) => (best === undefined || state.windowResetsAt < best.windowResetsAt ? state : best),
      undefined,
    ),
);

const subscriptions = H.pool('subscriptions')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, 0.6)
  .share(subscriptionTwo, 0.6)
  .share(subscriptionThree, 0.4)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples >= 20 && cheap.successRate < 0.85 ? opus : sonnet;
});

const workstation = local.runner('workstation').slots(4);

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(workstation);

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the work item in the worktree. Ask the owner when a decision is theirs to make.');
const auditorRole = H.role('auditor')
  .intents('read', 'search', 'record')
  .instructions('List every deficit against the work item. Record lessons worth keeping as experience.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently deliverable features.');

const builder = H.seat('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(subscriptions)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guard({ leaseFiles: true, beforeStop: projectChecks })
  .output(z.object({ summary: z.string(), question: z.string().optional() }));

const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(sonnet)
  .pool(subscriptions)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.seat('planner')
  .role(plannerRole)
  .model(opus)
  .pool(subscriptions)
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }));

const OwnerQuestion = H.halt('owner-question').decision(z.object({ answer: z.string() }));

const deliver = H.flow('deliver')
  .input(WorkAttributes)
  .params(z.object({ rounds: z.number().int() }))
  .loop(
    'rounds',
    round =>
      round
        .step('build', builder, ctx => ({
          task: `Round ${ctx.iteration + 1} of ${ctx.params.rounds}: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}`,
        }))
        .halt('ownerDecision', OwnerQuestion, {
          askWhen: ctx => typeof ctx.steps.build.question === 'string',
          ask: ctx => ctx.steps.build.question ?? '',
        })
        .step('audit', auditor, ctx => ({
          task: `Audit the change for "${ctx.unit.attributes.title}". Builder summary: ${ctx.steps.build.summary}. Owner answer: ${ctx.steps.ownerDecision?.answer ?? 'none asked'}`,
        })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('roundsExhausted');

const decompose = H.flow('decompose')
  .input(WorkAttributes)
  .step('plan', planner, ctx => ({ task: `Decompose the epic "${ctx.unit.attributes.title}":\n\n${ctx.unit.attributes.body}` }))
  .spawn('features', featuresLaneRef(), ctx => ctx.steps.plan.features.map(feature => ({ title: feature.title, body: feature.body })))
  .exit('delivered', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const probe = H.command('service-heartbeat').argv(['./scripts/heartbeat.sh', 'api']).runner(workstation);

const heartbeatFlow = H.flow('heartbeat').step('probe', probe).exit('up');

const linearKey = H.env('LINEAR_API_KEY');

const tracker = linear.store({
  apiKey: linearKey,
  team: 'PROD',
  workflow: ['Backlog', 'In Progress', 'In Review', 'Blocked', 'Triage', 'Done', 'Canceled'],
});

const fromIssue = (issue: LinearIssue, to: Router<WorkAttrs>) =>
  to.create({ title: issue.title, body: issue.description, trackerId: issue.identifier });

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['bug'] }), fromIssue)
  .supply(folder.files({ path: './inbox/bugs', glob: '*.md' }), (file, to) => to.create({ title: file.name, body: file.body }))
  .supply(H.operator)
  .store(tracker, {
    Backlog: 'Backlog',
    Building: 'In Progress',
    Auditing: 'In Review',
    AwaitingOwner: 'Blocked',
    Triage: 'Triage',
    Done: 'Done',
    Cancelled: 'Canceled',
  })
  .handler(deliver, {
    params: { rounds: 3 },
    exits: { clean: Done, roundsExhausted: Triage },
    during: { build: Building, audit: Auditing, ownerDecision: AwaitingOwner },
    cancelled: Cancelled,
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Triage });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['feature'] }), fromIssue)
  .supply(H.operator)
  .store(tracker, {
    Backlog: 'Backlog',
    Building: 'In Progress',
    Auditing: 'In Review',
    AwaitingOwner: 'Blocked',
    Triage: 'Triage',
    Done: 'Done',
    Cancelled: 'Canceled',
  })
  .handler(deliver, {
    params: { rounds: 5 },
    exits: { clean: Done, roundsExhausted: Triage },
    during: { build: Building, audit: Auditing, ownerDecision: AwaitingOwner },
    cancelled: Cancelled,
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Triage });

function featuresLaneRef() {
  return features;
}

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['epic'] }), fromIssue)
  .store(tracker, {
    Proposed: 'Backlog',
    Planning: 'In Progress',
    Delivering: 'In Review',
    Stalled: 'Blocked',
    Delivered: 'Done',
    Dropped: 'Canceled',
  })
  .handler(decompose, {
    exits: { delivered: Delivered, incomplete: Stalled },
    during: { plan: Planning, features: Delivering },
    cancelled: Dropped,
  })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300_000, exhausted: Stalled });

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    to.create({ service: 'api', dueAt: tick.at.toISOString() }),
  )
  .handler(heartbeatFlow, { exits: { up: Up }, during: { probe: Probing } })
  .retry({ maxAttempts: 1, exhausted: Down });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.when.transition(heartbeats, { to: Down }))
  .create(bugs, event => ({
    title: `Service ${event.unit.attributes.service} failed its heartbeat`,
    body: `The heartbeat due at ${event.unit.attributes.dueAt} failed. Investigate the service health check.`,
  }));

const experience = H.journal('engineering-experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: './memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const taste = H.journal('owner-taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: './memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, plannerRole);

const scheduler = H.scheduler('coding-team')
  .priority(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .boost(features, { afterMinutes: 240 });

const productionHealth = H.operation(
  'production-health-probe',
  H.command('production-health').argv(['./scripts/production-health.sh']).runner(workstation),
);

const ownerDesk = H.client('owner-desk', {
  transport: claudeCode.mcp('coding-team-mcp'),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.resolve(OwnerQuestion),
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealth,
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: './.harness/ledger.db' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(experience, taste)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(scheduler)
  .clients(ownerDesk)
  .observers(markdown.board({ path: './BOARD.md' }), markdown.telemetry({ path: './TELEMETRY.md' }));

export const supervisor = claudeCode.session('owner', { clients: [ownerDesk] });
