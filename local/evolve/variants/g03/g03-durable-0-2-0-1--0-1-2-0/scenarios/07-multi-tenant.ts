import { z } from 'zod';
import { H, type AccountState } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

export const ownerSubscriptionQuota = sqlite.quota('owner-subscriptions', { path: '/home/owner/.harness/subscription-quota.db' });

export const subscriptionOne = claudeCode.subscription('subscription-one', { token: H.env('CLAUDE_TOKEN_ONE'), quota: ownerSubscriptionQuota });
export const subscriptionTwo = claudeCode.subscription('subscription-two', { token: H.env('CLAUDE_TOKEN_TWO'), quota: ownerSubscriptionQuota });
export const subscriptionThree = claudeCode.subscription('subscription-three', { token: H.env('CLAUDE_TOKEN_THREE'), quota: ownerSubscriptionQuota });

export const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
export const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

export const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  ctx.candidates
    .filter(candidate => candidate.shareUsed < candidate.shareCap && (candidate.cooldownUntil === undefined || candidate.cooldownUntil <= ctx.now))
    .reduce<AccountState | undefined>(
      (best, candidate) => (best === undefined || candidate.windowResetsAt < best.windowResetsAt ? candidate : best),
      undefined,
    ));

export const builder = H.role('builder').intents('read', 'edit', 'run', 'halt').instructions('Implement the unit in the worktree until the checks pass.');
export const planner = H.role('planner').intents('read', 'search').instructions('Split an epic into independently shippable features.');
export const writer = H.role('writer').intents('read', 'edit').instructions('Write and revise documentation pages.');

export const taste = H.memory('taste', 'taste');
export const experience = H.memory('experience', 'experience');

export const ownerTaste = H.journal('owner-taste', taste)
  .store(jsonl.memoryStore({ path: '/home/owner/.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builder, planner, writer);

const projectAApiQuota = sqlite.quota('project-a-api', { path: 'project-a/.harness/api-quota.db' });
const projectAApi = anthropic.account('project-a-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: projectAApiQuota });

const projectAPool = H.pool('project-a-subscriptions')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, 0.6)
  .share(subscriptionTwo, 0.6)
  .share(subscriptionThree, 0.6)
  .drain(soonestExpiring)
  .fallback(projectAApi);

const auditor = H.role('auditor').intents('read', 'search', 'record').instructions('Find deficits in the change; record lessons as forward-phrased experience.');

const cheapUntilItSlips = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const record = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return record.samples >= 20 && record.successRate < 0.85 ? opus : sonnet;
});

const builderSeat = H.seat('builder').role(builder).model(cheapUntilItSlips).pool(projectAPool);
const auditorSeat = H.seat('auditor').role(auditor).model(sonnet).pool(projectAPool);
const plannerSeat = H.seat('planner').role(planner).model(opus).pool(projectAPool);

const projectARunner = local.runner('project-a-local');
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(projectARunner);
const ownerDecision = H.halt('owner-decision').decision(z.object({ answer: z.string() }));

const builderCall = H.call('build', builderSeat)
  .workspace(git.worktree({ repo: 'project-a', base: 'main' }))
  .guard({ leaseFiles: true, beforeStop: projectChecks })
  .halts(ownerDecision);
const auditorCall = H.call('audit', auditorSeat).output(z.object({ deficits: z.array(z.string()) }));

const WorkItem = z.object({ ref: z.string(), title: z.string(), body: z.string() });

const Todo = H.state('Todo', 'pending');
const Done = H.terminal('Done', 'success');
const Stuck = H.terminal('Stuck', 'failure');

const Bug = H.kind('Bug').attributes(WorkItem).states(Todo, Done, Stuck).key(item => item.ref).initial(Todo);
const Feature = H.kind('Feature').attributes(WorkItem).states(Todo, Done, Stuck).key(item => item.ref).initial(Todo);
const Epic = H.kind('Epic').attributes(WorkItem).states(Todo, Done, Stuck).key(item => item.ref).initial(Todo);

const buildAndAudit = H.flow('build-and-audit')
  .input(WorkItem)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    { schema: z.array(z.string()), initial: [] },
    round =>
      round
        .step('build', builderCall, ctx => ({
          text: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}\n\nOpen deficits: ${ctx.steps.rounds.join('; ')}`,
        }))
        .step('audit', auditorCall, ctx => ({ text: `Audit the change for ${ctx.unit.attributes.ref}: ${ctx.unit.attributes.title}` })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
      next: ctx => ctx.steps.audit.deficits,
    },
  )
  .exit('done', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('outOfRounds');

const planCall = H.call('plan', plannerSeat).output(z.object({ features: z.array(WorkItem) }));

const tracker = linear.store({ apiKey: H.env('LINEAR_API_KEY'), team: 'APP', workflow: ['Todo', 'In Progress', 'Done', 'Canceled'] });

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'APP', labels: ['bug'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }))
  .supply(folder.files({ path: 'project-a/bugs', glob: '*.md' }), (file, to) =>
    to.create({ ref: file.path, title: file.name, body: file.body }))
  .supply(H.operator)
  .store(tracker, { states: { Todo: 'Todo', Done: 'Done', Stuck: 'Canceled' }, inFlight: 'In Progress' })
  .handler(buildAndAudit, { exits: { done: Done, outOfRounds: Stuck }, params: { rounds: 3 } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300000, exhausted: Stuck });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'APP', labels: ['feature'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }))
  .supply(H.operator)
  .store(tracker, { states: { Todo: 'Todo', Done: 'Done', Stuck: 'Canceled' }, inFlight: 'In Progress' })
  .handler(buildAndAudit, { exits: { done: Done, outOfRounds: Stuck }, params: { rounds: 5 } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300000, exhausted: Stuck });

const decomposeEpic = H.flow('decompose-epic')
  .input(WorkItem)
  .step('plan', planCall, ctx => ({ text: `Split into features: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}` }))
  .spawn('features', features, ctx => ctx.steps.plan.features)
  .exit('done', ctx => ctx.steps.features.every(feature => feature.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'APP', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }))
  .store(tracker, { states: { Todo: 'Todo', Done: 'Done', Stuck: 'Canceled' }, inFlight: 'In Progress' })
  .handler(decomposeEpic, { exits: { done: Done, incomplete: Stuck } })
  .retry({ maxAttempts: 1, exhausted: Stuck });

const Due = H.state('Due', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');
const ServiceName = z.object({ service: z.string() });

const ServiceHeartbeat = H.kind('ServiceHeartbeat').attributes(ServiceName).states(Due, Healthy, Unhealthy).key(beat => beat.service).initial(Due);

const probeService = H.command('probe-service')
  .input(ServiceName)
  .argv(input => ['./scripts/probe', input.service])
  .runner(projectARunner);

const probeFlow = H.flow('probe-service').input(ServiceName).step('probe', probeService, ctx => ({ service: ctx.unit.attributes.service })).exit('healthy');

const monitoredServices = ['api', 'worker', 'web'];

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) => monitoredServices.map(service => to.create({ service })))
  .handler(probeFlow, { exits: { healthy: Healthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const unhealthyServiceFilesBug = H.trigger('unhealthy-service-files-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, event => ({
    ref: `heartbeat-${event.unit.attributes.service}-${event.at.toISOString()}`,
    title: `${event.unit.attributes.service} heartbeat failed`,
    body: `The deterministic probe of ${event.unit.attributes.service} failed at ${event.at.toISOString()}.`,
  }));

const projectAExperience = H.journal('project-a-experience', experience)
  .store(jsonl.memoryStore({ path: 'project-a/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builder, auditor)
  .recordedBy(auditor);

const productionHealthProbe = H.operation('production-health-probe', H.command('production-health').argv(['./scripts/production-health']).runner(projectARunner));

export const projectASupervisor = claudeCode.supervisor('project-a-supervisor', {
  port: H.slot.port(1),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.resolve(ownerDecision),
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealthProbe,
  ],
});

export const projectA = H.harness('project-a')
  .ledger(sqlite.ledger({ path: 'project-a/.harness/ledger.db' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(ownerTaste, projectAExperience)
  .triggers(unhealthyServiceFilesBug)
  .scheduler(
    H.scheduler('project-a')
      .standard(heartbeats, bugs, features, epics)
      .wip(bugs, 2)
      .wip(epics, 1)
      .aging(features, { afterMinutes: 240 }),
  )
  .clients(projectASupervisor)
  .observers(markdown.board({ path: 'project-a/BOARD.md' }), markdown.telemetry({ path: 'project-a/TELEMETRY.md' }));

const projectBPool = H.pool('project-b-subscriptions')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, 0.3)
  .share(subscriptionTwo, 0.3)
  .share(subscriptionThree, 0.3)
  .drain(soonestExpiring);

const writerSeat = H.seat('writer').role(writer).model(sonnet).pool(projectBPool);
const writeCall = H.call('write-page', writerSeat).workspace(git.worktree({ repo: 'project-b', base: 'main' }));
const linkCheck = H.command('link-check').argv(['npm', 'run', 'check-links']).runner(local.runner('project-b-local'));

const PageRef = z.object({ path: z.string(), title: z.string() });
const PageQueued = H.state('PageQueued', 'pending');
const PagePublished = H.terminal('PagePublished', 'success');
const PageBroken = H.terminal('PageBroken', 'failure');
const DocPage = H.kind('DocPage').attributes(PageRef).states(PageQueued, PagePublished, PageBroken).key(page => page.path).initial(PageQueued);

const writePage = H.flow('write-page')
  .input(PageRef)
  .step('write', writeCall, ctx => ({ text: `Revise ${ctx.unit.attributes.path} (${ctx.unit.attributes.title}).` }))
  .step('linkCheck', linkCheck)
  .exit('published');

const docs = H.lane('docs', DocPage)
  .supply(folder.files({ path: 'project-b/docs', glob: '**/*.md' }), (file, to) => to.create({ path: file.path, title: file.name }))
  .store(folder.frontmatter({ path: 'project-b/docs' }))
  .handler(writePage, { exits: { published: PagePublished } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000, exhausted: PageBroken });

const projectBExperience = H.journal('project-b-experience', experience)
  .store(jsonl.memoryStore({ path: 'project-b/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(writer)
  .recordedBy(writer);

export const projectBSupervisor = claudeCode.supervisor('project-b-supervisor', {
  port: H.slot.port(2),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.workUpdate, H.ops.memoryWrite, H.ops.telemetryRead, H.ops.accountsRead, H.ops.accountsShare],
});

export const projectB = H.harness('project-b')
  .ledger(sqlite.ledger({ path: 'project-b/.harness/ledger.db' }))
  .lanes(docs)
  .journals(ownerTaste, projectBExperience)
  .scheduler(H.scheduler('project-b').standard(docs).wip(docs, 2))
  .clients(projectBSupervisor)
  .observers(markdown.board({ path: 'project-b/BOARD.md' }), markdown.telemetry({ path: 'project-b/TELEMETRY.md' }));

export const ownerSession = claudeCode.session('owner-session', { endpoints: [projectASupervisor, projectBSupervisor] });
