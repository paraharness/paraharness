import { z } from 'zod';
import { H, Account, PolicyCtx, Model } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear, LinearIssue } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { markdown } from 'harness-dsl/markdown';

const sharedAccounts = sqlite.accountLedger({ path: '~/.harness/accounts.db' });

const max1 = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), ledger: sharedAccounts });
const max2 = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), ledger: sharedAccounts });
const max3 = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), ledger: sharedAccounts });

const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  [...ctx.candidates]
    .filter(a => a.shareUsed < a.shareCap)
    .filter(a => a.cooldownUntil === undefined || a.cooldownUntil.getTime() <= ctx.now.getTime())
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const sharedPool = (name: string, share: number, fallback?: Account) => {
  const pool = H.pool(name)
    .accounts(max1, max2, max3)
    .share(max1, share)
    .share(max2, share)
    .share(max3, share)
    .drain(soonestExpiring);
  return fallback === undefined ? pool : pool.fallback(fallback);
};

const ownerTaste = H.memory('taste').trust('taste');
const experience = H.memory('experience').trust('experience');
const mostSpecific = H.recall('most-specific', { by: 'specificity', limit: 8 });

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the unit of work in the worktree. Halt for the owner when a product decision is needed.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('List every deficit in the change. Record lessons that would have prevented a deficit.');
const plannerRole = H.role('planner').intents('read', 'search').instructions('Decompose the epic into features.');
const writerRole = H.role('writer').intents('read', 'edit', 'record').instructions('Keep the page accurate and readable.');

const sharedTasteJournal = H.journal('owner-taste', ownerTaste)
  .store(jsonl.memoryStore({ path: '~/.harness/taste.jsonl' }))
  .recall(mostSpecific)
  .readBy(builderRole, plannerRole, writerRole);

const Open = H.state('Open', 'pending');
const Planning = H.state('Planning', 'active');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Delivering = H.state('Delivering', 'active');
const Done = H.state('Done', 'succeeded');
const Failed = H.state('Failed', 'failed');
const Cancelled = H.state('Cancelled', 'cancelled');
const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.state('Healthy', 'succeeded');
const Unhealthy = H.state('Unhealthy', 'failed');

const ticket = z.object({ externalId: z.string(), title: z.string(), description: z.string() });
const heartbeatAttrs = z.object({ service: z.string(), dueAt: z.string() });

const Bug = H.kind('Bug').attributes(ticket).states(Open, Building, Auditing, Done, Failed, Cancelled).key(a => a.externalId);
const Feature = H.kind('Feature').attributes(ticket).states(Open, Building, Auditing, Done, Failed, Cancelled).key(a => a.externalId);
const Epic = H.kind('Epic').attributes(ticket).states(Open, Planning, Delivering, Done, Failed, Cancelled).key(a => a.externalId);
const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(heartbeatAttrs)
  .states(Due, Probing, Healthy, Unhealthy, Cancelled)
  .key(a => `${a.service}@${a.dueAt}`);

const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const codingPool = sharedPool('coding-pool', 0.6, apiAccount);
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5', pool: codingPool });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1', pool: codingPool });

function chooseBuilderModel(ctx: PolicyCtx): Model {
  const cheaper = ctx.metrics.outcomes({ of: { name: ctx.unit.lane }, model: sonnet, windowDays: 14 });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? opus : sonnet;
}

const codingRunner = local.runner('local').slots(4);
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(codingRunner);
const worktree = git.worktree({ repo: '.', base: 'main' });

const buildAgent = H.agent('build-agent')
  .role(builderRole)
  .model(H.policy.model('builder-model', [sonnet, opus], chooseBuilderModel))
  .workspace(worktree)
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks))
  .budgetTokens(400000)
  .output(z.object({ summary: z.string(), filesChanged: z.array(z.string()) }));
const auditAgent = H.agent('audit-agent')
  .role(auditorRole)
  .model(opus)
  .workspace(worktree)
  .budgetTokens(150000)
  .output(z.object({ deficits: z.array(z.string()) }));
const planAgent = H.agent('plan-agent')
  .role(plannerRole)
  .model(opus)
  .budgetTokens(100000)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const ticketFlow = H.flow('ticket')
  .input(ticket)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    f => f
      .step('build', buildAgent, ctx => ({ task: `Round ${ctx.iteration + 1}: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}` }))
      .step('audit', auditAgent, ctx => ({ task: `Audit "${ctx.unit.attributes.title}": ${ctx.steps.build.summary}`, resources: ctx.steps.build.filesChanged })),
    { max: ctx => ctx.params.rounds, until: ctx => ctx.steps.audit.deficits.length === 0 },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('exhausted');

const linearKey = H.env('LINEAR_API_KEY');
const linearStore = linear.store({
  apiKey: linearKey,
  team: 'PROD',
  states: { Open: 'Todo', Planning: 'In Progress', Building: 'In Progress', Auditing: 'In Review', Delivering: 'In Progress', Done: 'Done', Failed: 'Blocked', Cancelled: 'Canceled' },
});
const fromIssue = (issue: LinearIssue) => ({ externalId: issue.identifier, title: issue.title, description: issue.description });

const bugLane = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['bug'] }), (issue, to) => to.create(fromIssue(issue)))
  .supply(folder.files({ path: 'inbox/bugs', glob: '*.md' }), (file, to) => to.create({ externalId: `file:${file.name}`, title: file.name, description: file.body }))
  .supply(H.operator)
  .store(linearStore)
  .handler(ticketFlow, { params: { rounds: 3 }, exits: { clean: Done, exhausted: Failed }, during: { build: Building, audit: Auditing }, failure: Failed });

const featureLane = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['feature'] }), (issue, to) => to.create(fromIssue(issue)))
  .supply(H.operator)
  .store(linearStore)
  .handler(ticketFlow, { params: { rounds: 5 }, exits: { clean: Done, exhausted: Failed }, during: { build: Building, audit: Auditing }, failure: Failed });

const epicFlow = H.flow('epic')
  .input(ticket)
  .step('plan', planAgent, ctx => ({ task: `Decompose into features: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}` }))
  .spawn('features', featureLane, ctx =>
    ctx.steps.plan.features.map((feature, index) => ({
      externalId: `${ctx.unit.attributes.externalId}-${index + 1}`,
      title: feature.title,
      description: feature.description,
    })),
  )
  .exit('delivered', ctx => ctx.steps.features.every(child => child.outcome === 'succeeded'))
  .exit('incomplete');

const epicLane = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['epic'] }), (issue, to) => to.create(fromIssue(issue)))
  .store(linearStore)
  .handler(epicFlow, { exits: { delivered: Done, incomplete: Failed }, during: { plan: Planning, features: Delivering }, failure: Failed });

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .argv(i => ['./scripts/probe.sh', i.service])
  .runner(codingRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatAttrs)
  .step('probe', probeService, ctx => ({ service: ctx.unit.attributes.service }), { timeoutMs: 60000 })
  .exit('healthy');

const heartbeatLane = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    ['api', 'web', 'worker'].map(service => to.create({ service, dueAt: tick.at.toISOString() })),
  )
  .handler(heartbeatFlow, { exits: { healthy: Healthy }, during: { probe: Probing }, failure: Unhealthy });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.when.transition(heartbeatLane, { to: Unhealthy }))
  .create(bugLane, e => ({
    externalId: `heartbeat:${e.unit.attributes.service}:${e.unit.attributes.dueAt}`,
    title: `Service ${e.unit.attributes.service} failed its heartbeat`,
    description: `The heartbeat due at ${e.unit.attributes.dueAt} failed.`,
  }));

const codingExperience = H.journal('coding-experience', experience)
  .store(jsonl.memoryStore({ path: '.harness/coding-experience.jsonl' }))
  .recall(mostSpecific)
  .readBy(builderRole, auditorRole)
  .writtenBy(auditorRole);

const productionHealth = H.operation('production-health').run(
  H.command('probe-production').argv(['./scripts/probe-production.sh']).runner(codingRunner),
);

const codingSupervisor = claudeCode.supervisor('supervisor-coding', {
  endpoint: 'coding',
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
    productionHealth,
  ],
});

export const codingHarness = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: 'coding/.harness/ledger.db' }))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .journals(codingExperience, sharedTasteJournal)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(
    H.scheduler('coding-scheduler')
      .priority(heartbeatLane, bugLane, featureLane, epicLane)
      .wip(bugLane, 2)
      .wip(epicLane, 1)
      .boost(featureLane, { afterMinutes: 240 }),
  )
  .clients(codingSupervisor)
  .observers(markdown.board({ path: 'coding/BOARD.md' }), markdown.telemetry({ path: 'coding/TELEMETRY.md' }));

const Stale = H.state('Stale', 'pending');
const Writing = H.state('Writing', 'active');
const LinkChecking = H.state('LinkChecking', 'active');
const Published = H.state('Published', 'succeeded');

const docPage = z.object({ path: z.string(), title: z.string(), body: z.string() });

const DocPage = H.kind('DocPage').attributes(docPage).states(Stale, Writing, LinkChecking, Published, Failed, Cancelled).key(a => a.path);

const docsPool = sharedPool('docs-pool', 0.3);
const docsModel = claudeCode.model('docs-sonnet', { id: 'claude-sonnet-4-5', pool: docsPool });

const writeAgent = H.agent('write-agent')
  .role(writerRole)
  .model(docsModel)
  .workspace(git.worktree({ repo: 'docs', base: 'main' }))
  .guards(H.guard.lease())
  .budgetTokens(80000)
  .output(z.object({ summary: z.string() }));

const docsRunner = local.runner('docs-local').slots(2);
const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(i => ['npx', 'markdown-link-check', i.path])
  .runner(docsRunner);

const docFlow = H.flow('doc-page')
  .input(docPage)
  .step('write', writeAgent, ctx => ({ task: `Revise ${ctx.unit.attributes.path}: ${ctx.unit.attributes.title}`, resources: [ctx.unit.attributes.path] }))
  .step('linkCheck', linkCheck, ctx => ({ path: ctx.unit.attributes.path }))
  .exit('published');

const docLane = H.lane('doc-pages', DocPage)
  .supply(folder.files({ path: 'docs', glob: '**/*.md' }), (file, to) => to.create({ path: file.path, title: file.name, body: file.body }))
  .store(folder.frontmatter({ path: 'docs' }))
  .handler(docFlow, { exits: { published: Published }, during: { write: Writing, linkCheck: LinkChecking }, failure: Failed });

const docsExperience = H.journal('docs-experience', experience)
  .store(jsonl.memoryStore({ path: 'docs/.harness/experience.jsonl' }))
  .recall(mostSpecific)
  .readBy(writerRole)
  .writtenBy(writerRole);

const docsSupervisor = claudeCode.supervisor('supervisor-docs', {
  endpoint: 'docs',
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

export const docsHarness = H.harness('documentation')
  .ledger(sqlite.ledger({ path: 'docs/.harness/ledger.db' }))
  .lanes(docLane)
  .journals(docsExperience, sharedTasteJournal)
  .scheduler(H.scheduler('docs-scheduler').priority(docLane))
  .clients(docsSupervisor)
  .observers(markdown.board({ path: 'docs/BOARD.md' }), markdown.telemetry({ path: 'docs/TELEMETRY.md' }));

export const runningCoding = codingHarness.start();
export const runningDocs = docsHarness.start();
