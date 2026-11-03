import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const sharedQuota = '../shared/account-quota.db';

const maxOne = claudeCode.subscription('max-one', { token: H.env('CLAUDE_MAX_ONE_TOKEN') });
const maxTwo = claudeCode.subscription('max-two', { token: H.env('CLAUDE_MAX_TWO_TOKEN') });
const maxThree = claudeCode.subscription('max-three', { token: H.env('CLAUDE_MAX_THREE_TOKEN') });
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', ctx => {
  const eligible = ctx.candidates.filter(
    c => (c.cooldownUntil === undefined || c.cooldownUntil.getTime() <= ctx.now.getTime()) && c.shareUsed < c.shareCap,
  );
  return [...eligible].sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0];
});

const builder = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the unit on the worktree. Halt for the owner when a product decision is needed.');
const auditor = H.role('auditor')
  .intents('read', 'search', 'record')
  .instructions('Find every deficit against the description. Record lessons that would have prevented them.');
const planner = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');
const writer = H.role('writer')
  .intents('read', 'edit')
  .instructions('Bring the documentation page up to date with the code it describes.');

const ownerTaste = H.memory('owner-taste', 'taste');
const ownerTasteJournal = H.journal('owner-taste-journal', ownerTaste)
  .store(jsonl.memoryStore({ path: '../shared/owner-taste.jsonl' }))
  .recall(H.recall('owner-taste-recall', { by: 'specificity', limit: 15 }))
  .readBy(builder, planner, writer);

const productionHealthProbe = H.operation('production-health-probe').run(
  H.command('probe-production').argv(['curl', '-fsS', 'https://status.internal/health']).runner(local.runner('probe-box')),
);

const ownerSession = claudeCode.supervisor('owner-session', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.blockersResolve,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionHealthProbe,
  ],
});

const codingBox = local.runner('coding-box').slots(4);

const Ticket = z.object({
  issueId: z.string(),
  title: z.string(),
  description: z.string(),
  epicId: z.string().optional(),
});
const EpicAttributes = z.object({ issueId: z.string(), title: z.string(), description: z.string() });
const HeartbeatAttributes = z.object({ service: z.string() });

const Backlog = H.state('backlog', 'pending');
const Building = H.state('building', 'active');
const Auditing = H.state('auditing', 'active');
const Done = H.state('done', 'terminal', 'success');
const Abandoned = H.state('abandoned', 'terminal', 'failure');
const Withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const Bug = H.kind('Bug').attributes(Ticket).states(Backlog, Building, Auditing, Done, Abandoned, Withdrawn).key(t => t.issueId);
const Feature = H.kind('Feature').attributes(Ticket).states(Backlog, Building, Auditing, Done, Abandoned, Withdrawn).key(t => t.issueId);

const Planned = H.state('planned', 'pending');
const Decomposing = H.state('decomposing', 'active');
const AwaitingFeatures = H.state('awaiting-features', 'waiting');
const Delivered = H.state('delivered', 'terminal', 'success');
const Dropped = H.state('dropped', 'terminal', 'failure');
const Epic = H.kind('Epic').attributes(EpicAttributes).states(Planned, Decomposing, AwaitingFeatures, Delivered, Dropped).key(e => e.issueId);

const Due = H.state('due', 'pending');
const Probing = H.state('probing', 'active');
const Healthy = H.state('healthy', 'terminal', 'success');
const Unhealthy = H.state('unhealthy', 'terminal', 'failure');
const ServiceHeartbeat = H.kind('ServiceHeartbeat').attributes(HeartbeatAttributes).states(Due, Probing, Healthy, Unhealthy).key(h => h.service);

const codingExperience = H.memory('coding-experience', 'experience');
const codingExperienceJournal = H.journal('coding-experience-journal', codingExperience)
  .store(jsonl.memoryStore({ path: 'coding/memory/experience.jsonl' }))
  .recall(H.recall('coding-experience-recall', { by: 'specificity', limit: 10 }))
  .readBy(builder, auditor)
  .writtenBy(auditor);

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const record = ctx.metrics.outcomes({ of: ctx.lane, model: sonnet, windowDays: 14 });
  return record.samples >= 20 && record.successRate < 0.85 ? opus : sonnet;
});

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(codingBox);

const builderAgent = H.agent('builder')
  .role(builder)
  .model(builderModel)
  .workspace(git.worktree({ repo: '.' }))
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks))
  .budgetTokens(400_000);

const auditorAgent = H.agent('auditor')
  .role(auditor)
  .model(opus)
  .output(z.object({ deficits: z.array(z.object({ file: z.string(), problem: z.string() })) }));

const plannerAgent = H.agent('planner')
  .role(planner)
  .model(opus)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const ticketFlow = H.flow('build-and-audit')
  .input(Ticket)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    flow => flow
      .step('build', builderAgent, ctx => ({
        task: `Implement ${ctx.unit.attributes.title}: ${ctx.unit.attributes.description}. Round ${ctx.iteration + 1} of ${ctx.params.rounds}.`,
      }))
      .step('audit', auditorAgent, ctx => ({
        task: `Audit the current worktree for ${ctx.unit.attributes.title} against its description; list every deficit.`,
      })),
    { max: ctx => ctx.params.rounds, until: ctx => ctx.steps.audit.deficits.length === 0 },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('outOfRounds');

const ticketMap = {
  exits: { clean: Done, outOfRounds: Abandoned },
  during: { build: Building, audit: Auditing },
  cancelled: Withdrawn,
};

const linearKey = H.env('LINEAR_API_KEY');
const linearStates = { backlog: 'Backlog', building: 'In Progress', auditing: 'In Review', done: 'Done', abandoned: 'Canceled', withdrawn: 'Canceled' };

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'PRD', labels: ['bug'] }), (issue, to) =>
    to.create({ issueId: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ issueId: `folder:${file.name}`, title: file.name, description: file.body }),
  )
  .supply(H.operator)
  .store(linear.store({ apiKey: linearKey, team: 'PRD', states: linearStates }))
  .handler(ticketFlow, { ...ticketMap, params: { rounds: 3 } });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'PRD', labels: ['feature'] }), (issue, to) =>
    to.create({ issueId: issue.identifier, title: issue.title, description: issue.description, epicId: issue.parentId }),
  )
  .supply(H.operator)
  .store(linear.store({ apiKey: linearKey, team: 'PRD', states: linearStates }))
  .handler(ticketFlow, { ...ticketMap, params: { rounds: 5 } });

const epicFlow = H.flow('epic-decomposition')
  .input(EpicAttributes)
  .step('decompose', plannerAgent, ctx => ({ task: `Decompose epic ${ctx.unit.attributes.title}: ${ctx.unit.attributes.description}` }))
  .spawn('features', features, ctx =>
    ctx.steps.decompose.features.map((feature, index) => ({
      issueId: `${ctx.unit.attributes.issueId}/${index + 1}`,
      title: feature.title,
      description: feature.description,
      epicId: ctx.unit.attributes.issueId,
    })),
  )
  .exit('delivered', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('dropped');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'PRD', labels: ['epic'] }), (issue, to) =>
    to.create({ issueId: issue.identifier, title: issue.title, description: issue.description }),
  )
  .store(linear.store({ apiKey: linearKey, team: 'PRD', states: { planned: 'Backlog', decomposing: 'In Progress', 'awaiting-features': 'In Progress', delivered: 'Done', dropped: 'Canceled' } }))
  .handler(epicFlow, {
    exits: { delivered: Delivered, dropped: Dropped },
    during: { decompose: Decomposing, features: AwaitingFeatures },
  });

const services = ['api', 'web', 'worker'];

const heartbeatProbe = H.command('heartbeat-probe')
  .input(HeartbeatAttributes)
  .argv(input => ['service-health', input.service])
  .runner(codingBox);

const heartbeatFlow = H.flow('heartbeat')
  .input(HeartbeatAttributes)
  .step('probe', heartbeatProbe, ctx => ctx.unit.attributes)
  .exit('healthy');

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (_tick, to) => services.map(service => to.create({ service })))
  .handler(heartbeatFlow, { exits: { healthy: Healthy }, during: { probe: Probing }, failure: Unhealthy });

const bugFromFailedHeartbeat = H.trigger('bug-from-failed-heartbeat')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, event => ({
    issueId: `heartbeat:${event.unit.attributes.service}:${event.at.toISOString()}`,
    title: `Service ${event.unit.attributes.service} failed its heartbeat`,
    description: `The heartbeat probe for ${event.unit.attributes.service} failed at ${event.at.toISOString()}.`,
  }));

export const coding = H.harness('coding')
  .ledger(sqlite.ledger({ path: 'coding/state/ledger.db', quotaPath: sharedQuota }))
  .pools(
    H.pool('coding-subscriptions')
      .accounts(maxOne, maxTwo, maxThree)
      .share(maxOne, 0.6)
      .share(maxTwo, 0.6)
      .share(maxThree, 0.6)
      .drain(soonestExpiringFirst)
      .fallback(anthropic.account('coding-api', { apiKey: H.env('ANTHROPIC_API_KEY') })),
  )
  .lanes(heartbeats, bugs, features, epics)
  .journals(ownerTasteJournal, codingExperienceJournal)
  .triggers(bugFromFailedHeartbeat)
  .scheduler(
    H.scheduler('coding-scheduler')
      .priority(heartbeats, bugs, features, epics)
      .wip(bugs, 2)
      .wip(epics, 1)
      .boost(features, { afterMinutes: 120 }),
  )
  .clients(ownerSession)
  .observers(markdown.board({ path: 'coding/board.md' }), markdown.telemetry({ path: 'coding/telemetry.md' }));

const DocPageAttributes = z.object({ path: z.string(), title: z.string(), body: z.string() });

const Stale = H.state('stale', 'pending');
const Writing = H.state('writing', 'active');
const LinkChecking = H.state('link-checking', 'active');
const Published = H.state('published', 'terminal', 'success');
const Broken = H.state('broken', 'terminal', 'failure');
const DocPage = H.kind('DocPage').attributes(DocPageAttributes).states(Stale, Writing, LinkChecking, Published, Broken).key(p => p.path);

const docsExperience = H.memory('docs-experience', 'experience');
const docsExperienceJournal = H.journal('docs-experience-journal', docsExperience)
  .store(jsonl.memoryStore({ path: 'docs/memory/experience.jsonl' }))
  .recall(H.recall('docs-experience-recall', { by: 'specificity', limit: 10 }))
  .readBy(writer);

const writerAgent = H.agent('writer').role(writer).model(sonnet);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(input => ['lychee', input.path])
  .runner(local.runner('docs-box'));

const docFlow = H.flow('doc-page')
  .input(DocPageAttributes)
  .step('write', writerAgent, ctx => ({ task: `Update ${ctx.unit.attributes.path} (${ctx.unit.attributes.title}).`, resources: [ctx.unit.attributes.path] }))
  .step('linkCheck', linkCheck, ctx => ({ path: ctx.unit.attributes.path }))
  .exit('published');

const docPages = H.lane('doc-pages', DocPage)
  .supply(folder.files({ path: 'docs', glob: '**/*.md' }), (file, to) =>
    to.create({ path: file.path, title: file.name, body: file.body }),
  )
  .store(folder.frontmatter({ path: 'docs' }))
  .handler(docFlow, { exits: { published: Published }, during: { write: Writing, linkCheck: LinkChecking }, failure: Broken });

export const documentation = H.harness('documentation')
  .ledger(sqlite.ledger({ path: 'docs/state/ledger.db', quotaPath: sharedQuota }))
  .pools(
    H.pool('docs-subscriptions')
      .accounts(maxOne, maxTwo, maxThree)
      .share(maxOne, 0.3)
      .share(maxTwo, 0.3)
      .share(maxThree, 0.3)
      .drain(soonestExpiringFirst),
  )
  .lanes(docPages)
  .journals(ownerTasteJournal, docsExperienceJournal)
  .scheduler(H.scheduler('docs-scheduler').priority(docPages).wip(docPages, 2))
  .clients(ownerSession)
  .observers(markdown.board({ path: 'docs/board.md' }));
