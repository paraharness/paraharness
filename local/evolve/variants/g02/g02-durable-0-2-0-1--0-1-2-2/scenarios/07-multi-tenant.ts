import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const sharedQuota = sqlite.quota('claude-accounts', { path: '/srv/shared/claude-quota.sqlite' });

const subscriptionOne = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota: sharedQuota });
const subscriptionTwo = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota: sharedQuota });
const subscriptionThree = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota: sharedQuota });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedQuota });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  [...ctx.candidates].sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0]);

const taste = H.memory('taste', 'taste');
const experience = H.memory('experience', 'experience');

const builderRole = H.role('builder').intents('read', 'edit', 'run', 'halt').instructions('Implement the work item in the worktree.');
const auditorRole = H.role('auditor').intents('read', 'run', 'record').instructions('List every deficit in the change; record lessons as experience.');
const plannerRole = H.role('planner').intents('read').instructions('Split the epic into independently shippable features.');
const writerRole = H.role('writer').intents('read', 'edit').instructions('Bring the documentation page up to date.');

const ownerTaste = H.journal('owner-taste', taste)
  .store(jsonl.memoryStore({ path: '/srv/shared/owner-taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, plannerRole, writerRole);

const localRunner = local.runner('local').slots(4);

const teamPool = H.pool('product-pool')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, 0.6)
  .share(subscriptionTwo, 0.6)
  .share(subscriptionThree, 0.6)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const productExperience = H.journal('product-experience', experience)
  .store(jsonl.memoryStore({ path: '/work/product/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);

const worktree = git.worktree({ repo: '/work/product', base: 'main' }).guard({ leaseFiles: true, beforeStop: projectChecks });

const ownerDecision = H.halt('owner-decision').decision(z.object({ choice: z.string(), note: z.string() }));

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheaper = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(teamPool)
  .output(z.object({ summary: z.string() }))
  .workspace(worktree)
  .halts(ownerDecision);

const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(sonnet)
  .pool(teamPool)
  .output(z.object({ deficits: z.array(z.string()) }))
  .workspace(worktree);

const planner = H.seat('planner')
  .role(plannerRole)
  .model(opus)
  .pool(teamPool)
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }));

const workSchema = z.object({ ref: z.string(), title: z.string(), body: z.string() });

const Todo = H.state('Todo', 'pending');
const NeedsOwner = H.state('NeedsOwner', 'waiting');
const Done = H.terminal('Done', 'success');
const Abandoned = H.terminal('Abandoned', 'failure');

const bug = H.kind('Bug').attributes(workSchema).states(Todo, NeedsOwner, Done, Abandoned).key(a => a.ref).initial(Todo);
const feature = H.kind('Feature').attributes(workSchema).states(Todo, NeedsOwner, Done, Abandoned).key(a => a.ref).initial(Todo);

const Planned = H.state('Planned', 'pending');
const EpicDone = H.terminal('EpicDone', 'success');
const EpicIncomplete = H.terminal('EpicIncomplete', 'failure');
const epic = H.kind('Epic').attributes(workSchema).states(Planned, EpicDone, EpicIncomplete).key(a => a.ref).initial(Planned);

const deliver = H.flow('deliver')
  .input(workSchema)
  .params(z.object({ rounds: z.number() }))
  .loop('deficits', { schema: z.array(z.string()), initial: [] }, round => round
    .step('build', builder, ctx => ({
      task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}\n\nOpen deficits:\n${ctx.steps.deficits.join('\n')}`,
    }))
    .step('audit', auditor, ctx => ({
      task: `Audit the change for ${ctx.unit.attributes.title}. Builder summary: ${ctx.steps.build.summary}`,
    })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
      next: ctx => ctx.steps.audit.deficits,
    })
  .exit('delivered', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('roundsSpent');

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({ apiKey: linearKey, team: 'PROD', workflow: ['Todo', 'In Progress', 'Blocked', 'Done', 'Canceled'] });

const bugs = H.lane('bugs', bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['bug'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }))
  .supply(folder.files({ path: '/work/product/bugs', glob: '*.md' }), (file, to) =>
    to.create({ ref: file.name, title: file.name, body: file.body }))
  .supply(H.operator)
  .handler(deliver, { exits: { delivered: Done, roundsSpent: NeedsOwner }, params: { rounds: 3 } })
  .store(tracker, { states: { Todo: 'Todo', NeedsOwner: 'Blocked', Done: 'Done', Abandoned: 'Canceled' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300_000, exhausted: Abandoned });

const features = H.lane('features', feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['feature'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }))
  .supply(H.operator)
  .handler(deliver, { exits: { delivered: Done, roundsSpent: NeedsOwner }, params: { rounds: 5 } })
  .store(tracker, { states: { Todo: 'Todo', NeedsOwner: 'Blocked', Done: 'Done', Abandoned: 'Canceled' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300_000, exhausted: Abandoned });

const decompose = H.flow('decompose')
  .input(workSchema)
  .step('plan', planner, ctx => ({ task: `Decompose ${ctx.unit.attributes.title}:\n${ctx.unit.attributes.body}` }))
  .spawn('features', features, ctx => ctx.steps.plan.features.map(f => ({
    ref: `${ctx.unit.attributes.ref}:${f.title}`,
    title: f.title,
    body: f.body,
  })))
  .exit('completed', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }))
  .handler(decompose, { exits: { completed: EpicDone, incomplete: EpicIncomplete } })
  .store(tracker, { states: { Planned: 'Todo', EpicDone: 'Done', EpicIncomplete: 'Canceled' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, exhausted: EpicIncomplete });

const productSupervisor = claudeCode.supervisor('product-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.resolve(ownerDecision),
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
  ],
  port: H.slot.port(1),
});

export const product = H.harness('product')
  .ledger(sqlite.ledger({ path: '/work/product/.harness/ledger.sqlite' }))
  .lanes(bugs, features, epics)
  .journals(ownerTaste, productExperience)
  .scheduler(H.scheduler('product')
    .standard(bugs, features, epics)
    .wip(bugs, 2)
    .wip(epics, 1)
    .aging(features, { afterMinutes: 240 }))
  .clients(productSupervisor)
  .observers(
    markdown.board({ path: '/work/product/BOARD.md' }),
    markdown.telemetry({ path: '/work/product/TELEMETRY.md' }),
  );

const docsPool = H.pool('docs-pool')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, 0.3)
  .share(subscriptionTwo, 0.3)
  .share(subscriptionThree, 0.3)
  .drain(soonestExpiring);

const docsExperience = H.journal('docs-experience', experience)
  .store(jsonl.memoryStore({ path: '/work/docs/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(writerRole)
  .recordedBy(writerRole);

const writer = H.seat('writer')
  .role(writerRole)
  .model(sonnet)
  .pool(docsPool)
  .output(z.object({ body: z.string() }))
  .workspace(git.worktree({ repo: '/work/docs', base: 'main' }));

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(input => ['npx', 'markdown-link-check', input.path])
  .runner(localRunner)
  .acceptExitCodes(0, 1);

const pageSchema = z.object({ path: z.string(), title: z.string(), body: z.string() });

const PageQueued = H.state('PageQueued', 'pending');
const PageNeedsEditor = H.state('PageNeedsEditor', 'waiting');
const Published = H.terminal('Published', 'success');
const PageFailed = H.terminal('PageFailed', 'failure');

const docPage = H.kind('DocPage').attributes(pageSchema).states(PageQueued, PageNeedsEditor, Published, PageFailed).key(a => a.path).initial(PageQueued);

const writePage = H.flow('write-page')
  .input(pageSchema)
  .step('write', writer, ctx => ({ task: `Update ${ctx.unit.attributes.path}:\n${ctx.unit.attributes.body}` }))
  .step('linkCheck', linkCheck, ctx => ({ path: ctx.unit.attributes.path }))
  .exit('brokenLinks', ctx => ctx.steps.linkCheck.exitCode !== 0)
  .exit('published');

const pages = H.lane('pages', docPage)
  .supply(folder.files({ path: '/work/docs/pages', glob: '**/*.md' }), (file, to) =>
    to.create({ path: file.path, title: file.name, body: file.body }))
  .handler(writePage, { exits: { brokenLinks: PageNeedsEditor, published: Published } })
  .store(folder.frontmatter({ path: '/work/docs/pages' }))
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60_000, exhausted: PageFailed });

const docsSupervisor = claudeCode.supervisor('docs-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
  ],
  port: H.slot.port(2),
});

export const docs = H.harness('docs')
  .ledger(sqlite.ledger({ path: '/work/docs/.harness/ledger.sqlite' }))
  .lanes(pages)
  .journals(ownerTaste, docsExperience)
  .scheduler(H.scheduler('docs').standard(pages).wip(pages, 2))
  .clients(docsSupervisor)
  .observers(markdown.board({ path: '/work/docs/BOARD.md' }));

export const ownerSession = claudeCode.session('owner', { endpoints: [productSupervisor, docsSupervisor] });
