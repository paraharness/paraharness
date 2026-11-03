import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const sharedQuota = sqlite.quota('owner-subscriptions', { path: '~/.harness/shared/quota.sqlite' });
const sharedSubscriptionOne = claudeCode.subscription('subscription-one', { token: H.env('CLAUDE_TOKEN_ONE'), quota: sharedQuota });
const sharedSubscriptionTwo = claudeCode.subscription('subscription-two', { token: H.env('CLAUDE_TOKEN_TWO'), quota: sharedQuota });
const sharedSubscriptionThree = claudeCode.subscription('subscription-three', { token: H.env('CLAUDE_TOKEN_THREE'), quota: sharedQuota });
const sharedSonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const sharedOpus = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const sharedTaste = H.memory('taste', 'taste');
const sharedExperience = H.memory('experience', 'experience');
const sharedTasteStore = jsonl.memoryStore({ path: '~/.harness/shared/taste.jsonl' });
const sharedSoonestExpiring = H.policy.account('soonest-expiring', ctx =>
  [...ctx.candidates]
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())
    .find(c => c.shareUsed < c.shareCap && (c.cooldownUntil === undefined || c.cooldownUntil <= ctx.now)),
);

const codingApiAccount = claudeCode.apiKey('coding-api', {
  apiKey: H.env('ANTHROPIC_API_KEY'),
  quota: sqlite.quota('coding-api', { path: './.harness/api-quota.sqlite' }),
});

const codingPool = H.pool('coding-subscriptions')
  .accounts(sharedSubscriptionOne, sharedSubscriptionTwo, sharedSubscriptionThree)
  .share(sharedSubscriptionOne, 0.6)
  .share(sharedSubscriptionTwo, 0.6)
  .share(sharedSubscriptionThree, 0.6)
  .drain(sharedSoonestExpiring)
  .fallback(codingApiAccount);

const workItem = z.object({ ref: z.string(), title: z.string(), body: z.string() });
const heartbeatTarget = z.object({ service: z.string() });

const Open = H.state('Open', 'pending');
const Shipped = H.terminal('Shipped', 'success');
const Unfinished = H.terminal('Unfinished', 'failure');
const EpicDone = H.terminal('EpicDone', 'success');
const EpicIncomplete = H.terminal('EpicIncomplete', 'failure');
const HeartbeatDue = H.state('HeartbeatDue', 'pending');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const Bug = H.kind('Bug').attributes(workItem).states(Open, Shipped, Unfinished).key(a => a.ref).initial(Open);
const Feature = H.kind('Feature').attributes(workItem).states(Open, Shipped, Unfinished).key(a => a.ref).initial(Open);
const Epic = H.kind('Epic').attributes(workItem).states(Open, EpicDone, EpicIncomplete).key(a => a.ref).initial(Open);
const Heartbeat = H.kind('Heartbeat').attributes(heartbeatTarget).states(HeartbeatDue, Healthy, Unhealthy).key(a => a.service).initial(HeartbeatDue);

const builderRole = H.role('builder').intents('read', 'edit', 'run', 'halt').instructions('Implement the task in the worktree and leave the checks green.');
const auditorRole = H.role('auditor').intents('read', 'run', 'record').instructions('List every deficit against the task; record forward-phrased lessons.');
const plannerRole = H.role('planner').intents('read', 'search').instructions('Decompose the epic into independently shippable features.');

const ownerDecision = H.halt('owner-decision').decision(z.object({ choice: z.string(), note: z.string() }));

const builderModel = H.policy.model('builder-model', [sharedSonnet, sharedOpus], ctx => {
  const cheaper = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sharedSonnet, window: { lastDays: 14 } });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? sharedOpus : sharedSonnet;
});

const builder = H.seat('builder').role(builderRole).model(builderModel).pool(codingPool)
  .output(z.object({ summary: z.string(), files: z.array(z.string()) }));
const auditor = H.seat('auditor').role(auditorRole).model(sharedSonnet).pool(codingPool)
  .output(z.object({ deficits: z.array(z.string()) }));
const planner = H.seat('planner').role(plannerRole).model(sharedOpus).pool(codingPool)
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }));

const codingRunner = local.runner('coding-local').slots(4);
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(codingRunner);
const worktree = git.worktree({ repo: '.', base: 'main' });
const probe = H.command('service-probe')
  .input(heartbeatTarget)
  .argv(i => ['./scripts/probe.sh', i.service])
  .acceptExitCodes(0, 1)
  .runner(codingRunner);

const deliver = H.flow('deliver')
  .input(workItem)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    { carry: z.object({ deficits: z.array(z.string()) }), initial: { deficits: [] } },
    round => round
      .step('build', builder, ctx => ({
        task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}\n\nOpen deficits: ${ctx.steps.rounds.deficits.join('; ') || 'none'}`,
      }), { workspace: worktree, guard: { leaseFiles: true, beforeStop: projectChecks }, halts: [ownerDecision], afterCrash: 'askDriver' })
      .step('audit', auditor, ctx => ({
        task: `Audit the change for ${ctx.unit.attributes.title}. Builder summary: ${ctx.steps.build.summary}. Files: ${ctx.steps.build.files.join(', ')}`,
      }), { afterCrash: 'askDriver' }),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
      next: ctx => ({ deficits: ctx.steps.audit.deficits }),
    },
  )
  .exit('done', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('unfinished');

const decompose = H.flow('decompose');

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatTarget)
  .step('probe', probe, ctx => ({ service: ctx.unit.attributes.service }), { afterCrash: 'rerun' })
  .exit('healthy', ctx => ctx.steps.probe.exitCode === 0)
  .exit('unhealthy');

const tracker = linear.store({
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  workflow: ['Todo', 'In Progress', 'In Review', 'Done', 'Canceled'],
});
const trackerIssues = (labels: readonly string[]) => linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels });

const bugs = H.lane('bugs', Bug)
  .supply(trackerIssues(['bug']), (issue, to) => to.create({ ref: issue.identifier, title: issue.title, body: issue.description }))
  .supply(folder.files({ path: './bugs', glob: '*.md' }), (file, to) => to.create({ ref: `file:${file.name}`, title: file.name, body: file.body }))
  .supply(H.operator)
  .handler(deliver, { exits: { done: Shipped, unfinished: Unfinished }, params: { rounds: 3 } })
  .store(tracker, { states: { Open: 'Todo', Shipped: 'Done', Unfinished: 'Canceled' }, inFlight: 'In Progress', steps: { audit: 'In Review' } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Unfinished });

const features = H.lane('features', Feature)
  .supply(trackerIssues(['feature']), (issue, to) => to.create({ ref: issue.identifier, title: issue.title, body: issue.description }))
  .supply(H.operator)
  .handler(deliver, { exits: { done: Shipped, unfinished: Unfinished }, params: { rounds: 5 } })
  .store(tracker, { states: { Open: 'Todo', Shipped: 'Done', Unfinished: 'Canceled' }, inFlight: 'In Progress', steps: { audit: 'In Review' } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Unfinished });

const epicFlow = decompose
  .input(workItem)
  .step('plan', planner, ctx => ({ task: `Decompose epic ${ctx.unit.attributes.title}:\n${ctx.unit.attributes.body}` }))
  .spawn('features', features, ctx => ctx.steps.plan.features.map((f, i) => ({ ref: `${ctx.unit.key}-${i + 1}`, title: f.title, body: f.body })))
  .exit('done', ctx => ctx.steps.features.every(c => c.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(trackerIssues(['epic']), (issue, to) => to.create({ ref: issue.identifier, title: issue.title, body: issue.description }))
  .handler(epicFlow, { exits: { done: EpicDone, incomplete: EpicIncomplete } })
  .store(tracker, { states: { Open: 'Todo', EpicDone: 'Done', EpicIncomplete: 'Canceled' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, exhausted: EpicIncomplete });

const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (_tick, to) => ['api', 'worker', 'web'].map(service => to.create({ service })))
  .handler(heartbeatFlow, { exits: { healthy: Healthy, unhealthy: Unhealthy } })
  .retry({ maxAttempts: 1, exhausted: Unhealthy });

const heartbeatFilesBug = H.trigger('heartbeat-files-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, e => ({
    ref: `heartbeat:${e.unit.attributes.service}:${e.at.toISOString()}`,
    title: `Service ${e.unit.attributes.service} failed its heartbeat`,
    body: `The heartbeat probe for ${e.unit.attributes.service} failed at ${e.at.toISOString()}.`,
  }));

const codingTaste = H.journal('taste', sharedTaste).store(sharedTasteStore).recall({ by: 'specificity', limit: 8 }).readBy(builderRole, plannerRole);
const codingExperience = H.journal('experience', sharedExperience)
  .store(jsonl.memoryStore({ path: './.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const productionHealth = H.operation('production-health', H.command('production-probe').argv(['./scripts/probe-production.sh']).runner(codingRunner));

const codingSupervisor = claudeCode.supervisor('coding-supervisor', {
  port: H.slot.port(1),
  grants: [
    H.ops.workRead, H.ops.workCreate, H.ops.workUpdate,
    H.ops.resolve(ownerDecision),
    H.ops.memoryRead, H.ops.memoryWrite,
    H.ops.telemetryRead, H.ops.accountsRead, H.ops.accountsShare,
    productionHealth,
  ],
});

export const codingHarness = H.harness('coding')
  .ledger(sqlite.ledger({ path: './coding/.harness/ledger.sqlite' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(codingTaste, codingExperience)
  .triggers(heartbeatFilesBug)
  .scheduler(H.scheduler('coding')
    .standard(heartbeats, bugs, features, epics)
    .wip(bugs, 2)
    .wip(epics, 1)
    .aging(features, { afterMinutes: 240 }))
  .clients(codingSupervisor)
  .observers(markdown.board({ path: './coding/BOARD.md' }), markdown.telemetry({ path: './coding/TELEMETRY.md' }));

const docsPool = H.pool('docs-subscriptions')
  .accounts(sharedSubscriptionOne, sharedSubscriptionTwo, sharedSubscriptionThree)
  .share(sharedSubscriptionOne, 0.3)
  .share(sharedSubscriptionTwo, 0.3)
  .share(sharedSubscriptionThree, 0.3)
  .drain(sharedSoonestExpiring);

const docPage = z.object({ path: z.string(), title: z.string(), body: z.string() });
const DocQueued = H.state('DocQueued', 'pending');
const DocPublished = H.terminal('DocPublished', 'success');
const DocBrokenLinks = H.terminal('DocBrokenLinks', 'failure');
const DocPage = H.kind('DocPage').attributes(docPage).states(DocQueued, DocPublished, DocBrokenLinks).key(a => a.path).initial(DocQueued);

const writerRole = H.role('writer').intents('read', 'edit').instructions('Write the documentation page so it is accurate and complete.');
const writer = H.seat('writer').role(writerRole).model(sharedSonnet).pool(docsPool).output(z.object({ summary: z.string() }));
const docsRunner = local.runner('docs-local');
const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(i => ['npx', 'linkinator', i.path])
  .acceptExitCodes(0, 1)
  .runner(docsRunner);

const writePage = H.flow('write-page')
  .input(docPage)
  .step('write', writer, ctx => ({ task: `Write ${ctx.unit.attributes.title} at ${ctx.unit.attributes.path}:\n${ctx.unit.attributes.body}` }), { afterCrash: 'askDriver' })
  .step('links', linkCheck, ctx => ({ path: ctx.unit.attributes.path }), { afterCrash: 'rerun' })
  .exit('published', ctx => ctx.steps.links.exitCode === 0)
  .exit('brokenLinks');

const docs = H.lane('docs', DocPage)
  .supply(folder.files({ path: './docs', glob: '**/*.md' }), (file, to) => to.create({ path: file.path, title: file.name, body: file.body }))
  .store(folder.frontmatter({ path: './docs' }))
  .handler(writePage, { exits: { published: DocPublished, brokenLinks: DocBrokenLinks } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300_000, exhausted: DocBrokenLinks });

const docsTaste = H.journal('taste', sharedTaste).store(sharedTasteStore).recall({ by: 'specificity', limit: 8 }).readBy(writerRole);
const docsExperience = H.journal('experience', sharedExperience)
  .store(jsonl.memoryStore({ path: './docs-harness/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(writerRole)
  .recordedBy(writerRole);

const docsSupervisor = claudeCode.supervisor('docs-supervisor', {
  port: H.slot.port(2),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.memoryRead, H.ops.memoryWrite, H.ops.telemetryRead, H.ops.accountsRead, H.ops.accountsShare],
});

export const docsHarness = H.harness('docs')
  .ledger(sqlite.ledger({ path: './docs-harness/.harness/ledger.sqlite' }))
  .lanes(docs)
  .journals(docsTaste, docsExperience)
  .scheduler(H.scheduler('docs').standard(docs).wip(docs, 2))
  .clients(docsSupervisor)
  .observers(markdown.board({ path: './docs-harness/BOARD.md' }));

export const ownerSession = claudeCode.session('owner', { endpoints: [codingSupervisor, docsSupervisor] });
