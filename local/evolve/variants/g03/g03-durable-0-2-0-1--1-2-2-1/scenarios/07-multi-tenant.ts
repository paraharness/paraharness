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

export const sharedQuota = sqlite.quota('claude-subscriptions', { path: '~/.harness/shared/quota.db' });

export const maxOne = claudeCode.subscription('max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota: sharedQuota });
export const maxTwo = claudeCode.subscription('max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota: sharedQuota });
export const maxThree = claudeCode.subscription('max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota: sharedQuota });
export const apiFallback = claudeCode.apiKey('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedQuota });

export const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
export const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

export const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  [...ctx.candidates]
    .filter(a => a.shareUsed < a.shareCap && (a.cooldownUntil === undefined || a.cooldownUntil <= ctx.now))
    .sort((x, y) => x.windowResetsAt.getTime() - y.windowResetsAt.getTime())[0]);

function subscriptionPool(name: string, shareCap: number) {
  return H.pool(name)
    .accounts(maxOne, maxTwo, maxThree)
    .share(maxOne, shareCap)
    .share(maxTwo, shareCap)
    .share(maxThree, shareCap)
    .drain(soonestExpiring)
    .fallback(apiFallback);
}

export const builderRole = H.role('builder').intents('read', 'edit', 'run', 'halt').instructions('Implement the ticket in the worktree; stop only when the checks pass.');
export const auditorRole = H.role('auditor').intents('read', 'run', 'record').instructions('List every deficit of the change against the ticket.');
export const plannerRole = H.role('planner').intents('read', 'search').instructions('Decompose the epic into independently shippable features.');
export const writerRole = H.role('writer').intents('read', 'edit').instructions('Write or revise the documentation page.');

export const taste = H.memory('taste', 'taste');
export const experience = H.memory('experience', 'experience');

export const tasteJournal = H.journal('taste', taste)
  .store(jsonl.memoryStore({ path: '~/.harness/shared/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, plannerRole, writerRole);

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({ apiKey: linearKey, team: 'ENG', workflow: ['Todo', 'In Progress', 'Done', 'Canceled'] });
const localRunner = local.runner('local');

const poolA = subscriptionPool('product-subscriptions', 0.6);

const experienceA = H.journal('product-experience', experience)
  .store(jsonl.memoryStore({ path: 'product/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const ticket = z.object({ ref: z.string(), title: z.string(), description: z.string() });

const Open = H.state('Open', 'pending');
const Shipped = H.terminal('Shipped', 'success');
const Dropped = H.terminal('Dropped', 'neutral');
const Abandoned = H.terminal('Abandoned', 'failure');

const bugKind = H.kind('Bug').attributes(ticket).states(Open, Shipped, Dropped, Abandoned).key(a => a.ref).initial(Open);
const featureKind = H.kind('Feature').attributes(ticket).states(Open, Shipped, Dropped, Abandoned).key(a => a.ref).initial(Open);

const EpicOpen = H.state('EpicOpen', 'pending');
const EpicDone = H.terminal('EpicDone', 'success');
const EpicAbandoned = H.terminal('EpicAbandoned', 'failure');
const epicKind = H.kind('Epic').attributes(ticket).states(EpicOpen, EpicDone, EpicAbandoned).key(a => a.ref).initial(EpicOpen);

const ownerReview = H.halt('ownerReview').decision(z.object({ choice: z.enum(['accept', 'drop', 'reopen']) }));
const ownerQuestion = H.halt('ownerQuestion').decision(z.object({ answer: z.string() }));

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const record = ctx.metrics.outcomes({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return record.samples >= 20 && record.successRate < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(poolA)
  .workspace(git.worktree({ repo: '.', base: 'main' }).guard({ leaseEdits: true, beforeStop: projectChecks }))
  .halts(ownerQuestion);

const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(sonnet)
  .pool(poolA)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.seat('planner')
  .role(plannerRole)
  .model(opus)
  .pool(poolA)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const deliver = H.flow('deliver')
  .input(ticket)
  .params(z.object({ rounds: z.number() }))
  .loop('round', f => f
    .step('build', builder, ctx => ({ task: `Implement ${ctx.unit.attributes.ref}: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}` }))
    .step('audit', auditor, ctx => ({ task: `Audit the change for ${ctx.unit.attributes.ref}` })),
  { max: ctx => ctx.params.rounds, until: ctx => ctx.steps.audit.deficits.length === 0 })
  .halt('ownerReview', ownerReview, {
    ask: ctx => `Rounds ran out with deficits: ${ctx.steps.audit.deficits.join('; ')}`,
    when: ctx => ctx.steps.audit.deficits.length > 0,
  })
  .exit('shipped', ctx => ctx.steps.ownerReview === undefined || ctx.steps.ownerReview.choice === 'accept')
  .exit('dropped', ctx => ctx.steps.ownerReview?.choice === 'drop')
  .exit('reopened');

const featureLane = H.lane('features', featureKind)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['feature'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }))
  .supply(H.operator)
  .handler(deliver, { exits: { shipped: Shipped, dropped: Dropped, reopened: Open }, params: { rounds: 5 } })
  .store(tracker, { states: { Open: 'Todo', Shipped: 'Done', Dropped: 'Canceled', Abandoned: 'Canceled' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Abandoned });

const bugLane = H.lane('bugs', bugKind)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['bug'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }))
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ ref: file.path, title: file.name, description: file.body }))
  .supply(H.operator)
  .handler(deliver, { exits: { shipped: Shipped, dropped: Dropped, reopened: Open }, params: { rounds: 3 } })
  .store(tracker, { states: { Open: 'Todo', Shipped: 'Done', Dropped: 'Canceled', Abandoned: 'Canceled' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: Abandoned });

const decompose = H.flow('decompose')
  .input(ticket)
  .step('plan', planner, ctx => ({ task: `Decompose ${ctx.unit.attributes.title}: ${ctx.unit.attributes.description}` }))
  .spawn('features', featureLane, ctx => ctx.steps.plan.features.map(f => ({
    ref: `${ctx.unit.attributes.ref}/${f.title}`,
    title: f.title,
    description: f.description,
  })))
  .exit('abandoned', ctx => ctx.steps.features.some(c => c.verdict === 'failure'))
  .exit('done');

const epicLane = H.lane('epics', epicKind)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }))
  .handler(decompose, { exits: { done: EpicDone, abandoned: EpicAbandoned } })
  .store(tracker, { states: { EpicOpen: 'Todo', EpicDone: 'Done', EpicAbandoned: 'Canceled' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, exhausted: EpicAbandoned });

const productionProbe = H.operation('probe-production', H.command('probe-production').argv(['./scripts/probe', 'production']).runner(localRunner));

export const supervisorA = claudeCode.supervisor('supervisor-product', {
  grants: [
    H.ops.workRead, H.ops.workCreate, H.ops.workUpdate, H.ops.workMove,
    H.ops.resolve(ownerReview, ownerQuestion),
    H.ops.memoryWrite, H.ops.telemetryRead, H.ops.accountsRead, H.ops.accountsShare,
    productionProbe,
  ],
  port: H.slot.port(1),
});

export const product = H.harness('product')
  .ledger(sqlite.ledger({ path: 'product/.harness/ledger.db' }))
  .lanes(bugLane, featureLane, epicLane)
  .journals(tasteJournal, experienceA)
  .scheduler(H.scheduler('product-scheduler')
    .standard(bugLane, featureLane, epicLane)
    .wip(bugLane, 2)
    .wip(epicLane, 1)
    .aging(featureLane, { afterMinutes: 240 }))
  .clients(supervisorA)
  .observers(markdown.board({ path: 'product/BOARD.md' }), markdown.telemetry({ path: 'product/TELEMETRY.md' }));

const poolB = subscriptionPool('docs-subscriptions', 0.3);

const experienceB = H.journal('docs-experience', experience)
  .store(jsonl.memoryStore({ path: 'docs/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(writerRole)
  .recordedBy(writerRole);

const docPage = z.object({ path: z.string(), title: z.string(), body: z.string() });

const DocQueued = H.state('DocQueued', 'pending');
const DocPublished = H.terminal('DocPublished', 'success');
const DocFailed = H.terminal('DocFailed', 'failure');
const docKind = H.kind('DocPage').attributes(docPage).states(DocQueued, DocPublished, DocFailed).key(a => a.path).initial(DocQueued);

const writer = H.seat('writer').role(writerRole).model(sonnet).pool(poolB);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(i => ['npx', 'linkinator', i.path])
  .runner(localRunner);

const writeDoc = H.flow('write-doc')
  .input(docPage)
  .step('write', writer, ctx => ({ task: `Revise ${ctx.unit.attributes.path}: ${ctx.unit.attributes.title}` }))
  .step('linkCheck', linkCheck, ctx => ({ path: ctx.unit.attributes.path }))
  .exit('published');

const docLane = H.lane('docs', docKind)
  .supply(folder.files({ path: 'docs/pages', glob: '*.md' }), (file, to) =>
    to.create({ path: file.path, title: file.name, body: file.body }))
  .handler(writeDoc, { exits: { published: DocPublished } })
  .store(folder.frontmatter({ path: 'docs/pages' }))
  .retry({ maxAttempts: 2, exhausted: DocFailed });

export const supervisorB = claudeCode.supervisor('supervisor-docs', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.memoryWrite, H.ops.telemetryRead, H.ops.accountsRead, H.ops.accountsShare],
  port: H.slot.port(2),
});

export const docs = H.harness('docs')
  .ledger(sqlite.ledger({ path: 'docs/.harness/ledger.db' }))
  .lanes(docLane)
  .journals(tasteJournal, experienceB)
  .scheduler(H.scheduler('docs-scheduler').standard(docLane).wip(docLane, 2))
  .clients(supervisorB)
  .observers(markdown.board({ path: 'docs/BOARD.md' }));

export const ownerSession = claudeCode.session('owner', { endpoints: [supervisorA, supervisorB] });

void product.start();
void docs.start();
