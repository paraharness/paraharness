import { H } from 'harness-dsl';
import { z } from 'zod';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';

const sharedQuotaPath = '/home/owner/.harness/quota.db';

const max1 = claudeCode.subscription('max1', { token: H.env('CLAUDE_MAX1_TOKEN') });
const max2 = claudeCode.subscription('max2', { token: H.env('CLAUDE_MAX2_TOKEN') });
const max3 = claudeCode.subscription('max3', { token: H.env('CLAUDE_MAX3_TOKEN') });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiring = H.policy.account('soonestExpiring', ctx =>
  ctx.candidates
    .filter(account => account.cooldownUntil === undefined || account.cooldownUntil < ctx.now)
    .filter(account => account.shareUsed < account.shareCap)
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0]);

const tasteKind = H.memory('taste', 'taste');
const experienceKind = H.memory('experience', 'experience');

const sharedTaste = H.journal('taste', tasteKind)
  .store(jsonl.memoryStore({ path: '/home/owner/.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 15 });

const localRunner = local.runner('local');
const board = markdown.board({ path: 'BOARD.md' });
const telemetry = markdown.telemetry({ path: 'TELEMETRY.md' });

const Queued = H.state('Queued', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Done = H.terminal('Done', 'success');
const Abandoned = H.terminal('Abandoned', 'failure');

const Proposed = H.state('Proposed', 'pending');
const Planning = H.state('Planning', 'active');
const AwaitingFeatures = H.state('AwaitingFeatures', 'waiting');
const EpicDone = H.terminal('EpicDone', 'success');
const EpicIncomplete = H.terminal('EpicIncomplete', 'failure');

const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const ticketAttrs = z.object({ title: z.string(), description: z.string(), source: z.string() });
const serviceAttrs = z.object({ service: z.string(), url: z.string() });

const Bug = H.kind('Bug')
  .attributes(ticketAttrs)
  .states(Queued, Building, Auditing, Done, Abandoned)
  .key(ticket => ticket.source)
  .initial(Queued);

const Feature = H.kind('Feature')
  .attributes(ticketAttrs)
  .states(Queued, Building, Auditing, Done, Abandoned)
  .key(ticket => ticket.source)
  .initial(Queued);

const Epic = H.kind('Epic')
  .attributes(ticketAttrs)
  .states(Proposed, Planning, AwaitingFeatures, EpicDone, EpicIncomplete)
  .key(ticket => ticket.source)
  .initial(Proposed);

const Heartbeat = H.kind('ServiceHeartbeat')
  .attributes(serviceAttrs)
  .states(HeartbeatDue, Probing, Healthy, Unhealthy)
  .key(beat => beat.service)
  .initial(HeartbeatDue)
  .onAttemptFailed(Unhealthy);

const builder = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the ticket in the worktree. Halt for the owner when a product decision is needed.');
const auditor = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('List every deficit of the change against the ticket. Record lessons worth keeping.');
const planner = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');

const builderModel = H.policy.model('builderModel', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.attempts({ of: ctx.kind, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples >= 20 && cheap.successRate < 0.85 ? opus : sonnet;
});

const codingPool = H.pool('codingTeam')
  .accounts(max1, max2, max3)
  .share(max1, 0.6)
  .share(max2, 0.6)
  .share(max3, 0.6)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const codingExperience = H.journal('codingExperience', experienceKind)
  .store(jsonl.memoryStore({ path: 'coding/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(builder, auditor)
  .recordedBy(auditor);

const projectChecks = H.command('projectChecks').argv(['npm', 'run', 'check']).runner(localRunner);

const builderAgent = H.agent('builder')
  .role(builder)
  .model(builderModel)
  .pool(codingPool)
  .workspace(git.worktree({ repo: 'coding', base: 'main' }))
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks));

const auditorAgent = H.agent('auditor')
  .role(auditor)
  .model(opus)
  .pool(codingPool)
  .output(z.object({ deficits: z.array(z.string()) }));

const plannerAgent = H.agent('planner')
  .role(planner)
  .model(opus)
  .pool(codingPool)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const ticketFlow = H.flow('ticket')
  .input(ticketAttrs)
  .params(z.object({ rounds: z.number() }))
  .loop('rounds', flow => flow
    .step('build', builderAgent, ctx => ({
      task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
    }))
    .step('audit', auditorAgent, ctx => ({
      task: `Audit the change for "${ctx.unit.attributes.title}". Builder report:\n${ctx.steps.build}`,
    })), {
    max: ctx => ctx.params.rounds,
    until: ctx => ctx.steps.audit.deficits.length === 0,
  })
  .exit('done', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('outOfRounds');

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({ apiKey: linearKey, team: 'ENG' });
const ticketStates = { Queued: 'Todo', Building: 'In Progress', Auditing: 'In Review', Done: 'Done', Abandoned: 'Canceled' };
const epicStates = { Proposed: 'Todo', Planning: 'In Progress', AwaitingFeatures: 'In Progress', EpicDone: 'Done', EpicIncomplete: 'Canceled' };

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['bug'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description, source: issue.identifier }))
  .supply(folder.files({ path: 'coding/bugs', glob: '*.md' }), (file, to) =>
    to.create({ title: file.name, description: file.body, source: file.path }))
  .supply(H.operator)
  .store(tracker, ticketStates)
  .handler(ticketFlow, {
    exits: { done: Done, outOfRounds: Abandoned },
    during: { build: Building, audit: Auditing },
    params: { rounds: 3 },
  })
  .retry({ maxAttempts: 2, initialDelayMs: 600000, exhausted: Abandoned });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['feature'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description, source: issue.identifier }))
  .supply(H.operator)
  .store(tracker, ticketStates)
  .handler(ticketFlow, {
    exits: { done: Done, outOfRounds: Abandoned },
    during: { build: Building, audit: Auditing },
    params: { rounds: 5 },
  })
  .retry({ maxAttempts: 2, initialDelayMs: 600000, exhausted: Abandoned });

const epicFlow = H.flow('epic')
  .input(ticketAttrs)
  .step('plan', plannerAgent, ctx => ({
    task: `Decompose this epic into features:\n${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
  }))
  .spawn('features', features, ctx => ctx.steps.plan.features.map((feature, index) => ({
    title: feature.title,
    description: feature.description,
    source: `${ctx.unit.key}/feature-${index + 1}`,
  })))
  .exit('done', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['epic'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description, source: issue.identifier }))
  .store(tracker, epicStates)
  .handler(epicFlow, {
    exits: { done: EpicDone, incomplete: EpicIncomplete },
    during: { plan: Planning, features: AwaitingFeatures },
  })
  .retry({ maxAttempts: 2, initialDelayMs: 600000, exhausted: EpicIncomplete });

const services = [
  { service: 'api', url: 'https://api.example.com/health' },
  { service: 'web', url: 'https://www.example.com/health' },
];

const healthCheck = H.command('healthCheck')
  .input(z.object({ url: z.string() }))
  .argv(input => ['curl', '-fsS', input.url])
  .acceptExitCodes(0, 7, 22, 28)
  .runner(localRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(serviceAttrs)
  .step('probe', healthCheck, ctx => ({ url: ctx.unit.attributes.url }))
  .exit('healthy', ctx => ctx.steps.probe.exitCode === 0)
  .exit('unhealthy');

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('everyFiveMinutes').every({ minutes: 5 }), (tick, to) =>
    services.map(service => to.create({ service: service.service, url: service.url })))
  .handler(heartbeatFlow, {
    exits: { healthy: Healthy, unhealthy: Unhealthy },
    during: { probe: Probing },
  });

const heartbeatFailed = H.trigger('heartbeatFailed')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, event => ({
    title: `${event.unit.attributes.service} heartbeat failed`,
    description: `Health check of ${event.unit.attributes.url} failed at ${event.at.toISOString()}.`,
    source: `heartbeat:${event.unit.attributes.service}:${event.at.toISOString()}`,
  }));

const productionProbe = H.command('productionProbe')
  .argv(['curl', '-fsS', 'https://api.example.com/health/deep'])
  .runner(localRunner);

const codingSupervisor = claudeCode.supervisor('supervisor', {
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
    H.operation('productionHealth', productionProbe),
  ],
});

export const codingTeam = H.harness('codingTeam')
  .ledger(sqlite.ledger({ path: 'coding/ledger.db', quotaPath: sharedQuotaPath }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(sharedTaste.readBy(builder, planner), codingExperience)
  .triggers(heartbeatFailed)
  .scheduler(H.scheduler('codingTeam')
    .priority(heartbeats, bugs, features, epics)
    .wip(bugs, 2)
    .wip(epics, 1)
    .boost(features, { afterMinutes: 240 }))
  .clients(codingSupervisor)
  .observers(board, telemetry);

const DocQueued = H.state('DocQueued', 'pending');
const Writing = H.state('Writing', 'active');
const LinkChecking = H.state('LinkChecking', 'active');
const Published = H.terminal('Published', 'success');
const BrokenLinks = H.terminal('BrokenLinks', 'failure');

const docAttrs = z.object({ path: z.string(), title: z.string(), body: z.string() });

const DocPage = H.kind('DocPage')
  .attributes(docAttrs)
  .states(DocQueued, Writing, LinkChecking, Published, BrokenLinks)
  .key(page => page.path)
  .initial(DocQueued);

const writer = H.role('writer')
  .intents('read', 'edit', 'search')
  .instructions('Write or revise the documentation page so it is accurate and every link resolves.');

const docsPool = H.pool('docs')
  .accounts(max1, max2, max3)
  .share(max1, 0.3)
  .share(max2, 0.3)
  .share(max3, 0.3)
  .drain(soonestExpiring);

const docsExperience = H.journal('docsExperience', experienceKind)
  .store(jsonl.memoryStore({ path: 'docs/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(writer)
  .recordedBy(writer);

const writerAgent = H.agent('writer')
  .role(writer)
  .model(sonnet)
  .pool(docsPool)
  .workspace(git.worktree({ repo: 'docs', base: 'main' }));

const linkCheck = H.command('linkCheck')
  .input(z.object({ path: z.string() }))
  .argv(input => ['lychee', input.path])
  .acceptExitCodes(0, 2)
  .runner(localRunner);

const docFlow = H.flow('docPage')
  .input(docAttrs)
  .loop('revisions', flow => flow
    .step('write', writerAgent, ctx => ({
      task: `Revise ${ctx.unit.attributes.path} ("${ctx.unit.attributes.title}").`,
      resources: [ctx.unit.attributes.path],
    }))
    .step('linkCheck', linkCheck, ctx => ({ path: ctx.unit.attributes.path })), {
    max: 3,
    until: ctx => ctx.steps.linkCheck.exitCode === 0,
  })
  .exit('published', ctx => ctx.steps.linkCheck.exitCode === 0)
  .exit('brokenLinks');

const docs = H.lane('docPages', DocPage)
  .supply(folder.files({ path: 'docs', glob: '**/*.md' }), (file, to) =>
    to.create({ path: file.path, title: file.name, body: file.body }))
  .store(folder.frontmatter({ path: 'docs' }))
  .handler(docFlow, {
    exits: { published: Published, brokenLinks: BrokenLinks },
    during: { write: Writing, linkCheck: LinkChecking },
  })
  .retry({ maxAttempts: 2, initialDelayMs: 600000, exhausted: BrokenLinks });

const docsSupervisor = claudeCode.supervisor('supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.blockersResolve,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
  ],
});

export const documentation = H.harness('documentation')
  .ledger(sqlite.ledger({ path: 'docs/ledger.db', quotaPath: sharedQuotaPath }))
  .lanes(docs)
  .journals(sharedTaste.readBy(writer), docsExperience)
  .scheduler(H.scheduler('documentation').priority(docs))
  .clients(docsSupervisor)
  .observers(markdown.board({ path: 'docs/BOARD.md' }), markdown.telemetry({ path: 'docs/TELEMETRY.md' }));
