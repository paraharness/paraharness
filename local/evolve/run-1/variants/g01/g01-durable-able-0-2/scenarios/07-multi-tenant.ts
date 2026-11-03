import { z } from 'zod';
import { H, AccountPolicyCtx } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';

const maxSubscription = claudeCode.subscription('ownerMax', { token: H.env('CLAUDE_MAX_TOKEN') });
const proSubscription = claudeCode.subscription('ownerPro', { token: H.env('CLAUDE_PRO_TOKEN') });
const teamSubscription = claudeCode.subscription('ownerTeam', { token: H.env('CLAUDE_TEAM_TOKEN') });
const sharedAccountState = sqlite.accountLedger({ path: '../shared/accounts.db' });

const soonestReset = H.policy.account('soonestReset', (ctx: AccountPolicyCtx) =>
  [...ctx.candidates].sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the work item in the worktree. Halt for the owner when a product decision is needed.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');
const writerRole = H.role('writer')
  .intents('read', 'edit')
  .instructions('Rewrite the documentation page so it is accurate, short and linked.');

const ownerTaste = H.journal('ownerTaste', H.memory('taste').trust('taste'))
  .store(jsonl.memoryStore({ path: '../shared/taste.jsonl' }))
  .recall(H.recall('ownerTasteRecall', { by: 'specificity', limit: 20 }))
  .readBy(builderRole, plannerRole, writerRole);

const codingPool = H.pool('codingPool')
  .accounts(maxSubscription, proSubscription, teamSubscription)
  .share(maxSubscription, 0.6)
  .share(proSubscription, 0.6)
  .share(teamSubscription, 0.6)
  .drain(soonestReset)
  .fallback(anthropic.account('codingApi', { apiKey: H.env('ANTHROPIC_API_KEY') }))
  .ledger(sharedAccountState);

const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('List every deficit of the change against the item. An empty list means done.');

const codingExperience = H.journal('codingExperience', H.memory('codingLesson').trust('experience'))
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall(H.recall('codingExperienceRecall', { by: 'specificity', limit: 15 }))
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const projectChecks = H.command('projectChecks').argv(['npm', 'run', 'check']).runner(local.runner('codingRunner'));

const builderModel = H.policy.model('builderModel', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.outcomes({ of: ctx.kind, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples < 20 || cheap.successRate >= 0.85 ? sonnet : opus;
});

const builder = H.agent('builder')
  .role(builderRole)
  .model(builderModel)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks))
  .output(z.object({ summary: z.string() }));

const auditor = H.agent('auditor')
  .role(auditorRole)
  .model(opus)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.agent('planner')
  .role(plannerRole)
  .model(opus)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const TicketAttributes = z.object({ ref: z.string(), title: z.string(), description: z.string() });

const Todo = H.state('Todo', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Done = H.terminal('Done', 'success');
const Exhausted = H.terminal('Exhausted', 'failure');

const Bug = H.kind('Bug').attributes(TicketAttributes).states(Todo, Building, Auditing, Done, Exhausted).key(t => t.ref).initial(Todo);
const Feature = H.kind('Feature').attributes(TicketAttributes).states(Todo, Building, Auditing, Done, Exhausted).key(t => t.ref).initial(Todo);

const EpicTodo = H.state('EpicTodo', 'pending');
const Planning = H.state('Planning', 'active');
const Decomposed = H.state('Decomposed', 'active');
const EpicDone = H.terminal('EpicDone', 'success');
const EpicIncomplete = H.terminal('EpicIncomplete', 'failure');
const Epic = H.kind('Epic')
  .attributes(TicketAttributes)
  .states(EpicTodo, Planning, Decomposed, EpicDone, EpicIncomplete)
  .key(t => t.ref)
  .initial(EpicTodo);

const ticketFlow = H.flow('ticket')
  .input(TicketAttributes)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'buildAndAudit',
    flow => flow
      .step('build', builder, ctx => ({ task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}` }))
      .step('audit', auditor, ctx => ({ task: `Audit the change for ${ctx.unit.attributes.ref}: ${ctx.unit.attributes.title}` })),
    { max: ctx => ctx.params.rounds, until: ctx => ctx.steps.audit.deficits.length === 0 },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('exhausted');

const linearKey = H.env('LINEAR_API_KEY');
const linearStates = { Todo: 'Todo', Building: 'In Progress', Auditing: 'In Review', Done: 'Done', Exhausted: 'Canceled' };
const ticketStore = linear.store({ apiKey: linearKey, team: 'PROD', states: linearStates });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['feature'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(H.operator)
  .store(ticketStore)
  .handler(ticketFlow, { exits: { clean: Done, exhausted: Exhausted }, during: { build: Building, audit: Auditing }, params: { rounds: 5 } });

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['bug'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ ref: `file-${file.name}`, title: file.name, description: file.body }),
  )
  .supply(H.operator)
  .store(ticketStore)
  .handler(ticketFlow, { exits: { clean: Done, exhausted: Exhausted }, during: { build: Building, audit: Auditing }, params: { rounds: 3 } });

const epicFlow = H.flow('epic')
  .input(TicketAttributes)
  .step('plan', planner, ctx => ({ task: `Decompose ${ctx.unit.attributes.title}:\n\n${ctx.unit.attributes.description}` }))
  .spawn('features', features, ctx =>
    ctx.steps.plan.features.map((feature, index) => ({
      ref: `${ctx.unit.attributes.ref}-${index + 1}`,
      title: feature.title,
      description: feature.description,
    })),
  )
  .exit('complete', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .store(linear.store({ apiKey: linearKey, team: 'PROD', states: { EpicTodo: 'Todo', Planning: 'In Progress', Decomposed: 'In Progress', EpicDone: 'Done', EpicIncomplete: 'Canceled' } }))
  .handler(epicFlow, { exits: { complete: EpicDone, incomplete: EpicIncomplete }, during: { plan: Planning, features: Decomposed } });

const HeartbeatAttributes = z.object({ service: z.string(), tickAt: z.string() });
const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');
const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(HeartbeatAttributes)
  .states(HeartbeatDue, Probing, Healthy, Unhealthy)
  .key(h => `${h.service}@${h.tickAt}`)
  .initial(HeartbeatDue)
  .onAttemptFailed(Unhealthy);

const probe = H.command('probeService')
  .input(z.object({ service: z.string() }))
  .argv(input => ['./scripts/probe', input.service])
  .runner(local.runner('probeRunner'));

const heartbeatFlow = H.flow('heartbeat')
  .input(HeartbeatAttributes)
  .step('probe', probe, ctx => ({ service: ctx.unit.attributes.service }))
  .exit('healthy');

const services = ['api', 'web', 'worker'];
const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('everyFiveMinutes').every({ minutes: 5 }), (tick, to) =>
    services.map(service => to.create({ service, tickAt: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, { exits: { healthy: Healthy }, during: { probe: Probing } });

const heartbeatFailureFilesBug = H.trigger('heartbeatFailureFilesBug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, event => ({
    ref: `heartbeat-${event.unit.attributes.service}-${event.unit.attributes.tickAt}`,
    title: `Service ${event.unit.attributes.service} failed its heartbeat`,
    description: `Heartbeat at ${event.unit.attributes.tickAt} failed.`,
  }));

export const codingTeam = H.harness('codingTeam')
  .ledger(sqlite.ledger({ path: 'state/coding-ledger.db' }))
  .pools(codingPool)
  .lanes(heartbeats, bugs, features, epics)
  .journals(ownerTaste, codingExperience)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(
    H.scheduler('codingScheduler')
      .priority(heartbeats, bugs, features, epics)
      .wip(bugs, 2)
      .wip(epics, 1)
      .boost(features, { afterMinutes: 240 }),
  )
  .clients(
    claudeCode.supervisor('ownerSupervisorCoding', {
      endpoint: 'http://127.0.0.1:7410',
      grants: [
        H.ops.workRead,
        H.ops.workCreate,
        H.ops.workUpdate,
        H.ops.blockersResolve,
        H.ops.memoryWrite,
        H.ops.telemetryRead,
        H.ops.accountsRead,
        H.ops.accountsShare,
      ],
    }),
  )
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

const docsPool = H.pool('docsPool')
  .accounts(maxSubscription, proSubscription, teamSubscription)
  .share(maxSubscription, 0.3)
  .share(proSubscription, 0.3)
  .share(teamSubscription, 0.3)
  .drain(soonestReset)
  .ledger(sharedAccountState);

const docsExperience = H.journal('docsExperience', H.memory('docsLesson').trust('experience'))
  .store(jsonl.memoryStore({ path: 'docs-memory/experience.jsonl' }))
  .recall(H.recall('docsExperienceRecall', { by: 'specificity', limit: 10 }))
  .readBy(writerRole)
  .recordedBy(writerRole);

const DocAttributes = z.object({ path: z.string(), title: z.string(), body: z.string() });
const DocQueued = H.state('DocQueued', 'pending');
const DocWriting = H.state('DocWriting', 'active');
const DocChecking = H.state('DocChecking', 'active');
const DocPublished = H.terminal('DocPublished', 'success');
const DocBroken = H.terminal('DocBroken', 'failure');
const DocPage = H.kind('DocPage')
  .attributes(DocAttributes)
  .states(DocQueued, DocWriting, DocChecking, DocPublished, DocBroken)
  .key(d => d.path)
  .initial(DocQueued)
  .onAttemptFailed(DocBroken);

const writer = H.agent('writer').role(writerRole).model(sonnet).output(z.object({ summary: z.string() }));

const linkCheck = H.command('linkCheck')
  .input(z.object({ path: z.string() }))
  .argv(input => ['npx', 'markdown-link-check', input.path])
  .runner(local.runner('docsRunner'));

const docFlow = H.flow('docPage')
  .input(DocAttributes)
  .step('write', writer, ctx => ({ task: `Revise ${ctx.unit.attributes.title}`, resources: [ctx.unit.attributes.path] }))
  .step('linkCheck', linkCheck, ctx => ({ path: ctx.unit.attributes.path }))
  .exit('published');

const docPages = H.lane('docPages', DocPage)
  .supply(folder.files({ path: 'docs', glob: '**/*.md' }), (file, to) =>
    to.create({ path: file.path, title: file.name, body: file.body }),
  )
  .store(folder.frontmatter({ path: 'docs' }))
  .handler(docFlow, { exits: { published: DocPublished }, during: { write: DocWriting, linkCheck: DocChecking } });

export const documentation = H.harness('documentation')
  .ledger(sqlite.ledger({ path: 'state/docs-ledger.db' }))
  .pools(docsPool)
  .lanes(docPages)
  .journals(ownerTaste, docsExperience)
  .scheduler(H.scheduler('docsScheduler').priority(docPages).wip(docPages, 2))
  .clients(
    claudeCode.supervisor('ownerSupervisorDocs', {
      endpoint: 'http://127.0.0.1:7420',
      grants: [H.ops.workRead, H.ops.workCreate, H.ops.blockersResolve, H.ops.memoryWrite, H.ops.telemetryRead, H.ops.accountsRead],
    }),
  )
  .observers(markdown.board({ path: 'docs-BOARD.md' }));
