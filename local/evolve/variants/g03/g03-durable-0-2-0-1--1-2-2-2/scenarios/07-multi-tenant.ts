import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const sharedQuota = sqlite.quota('claude-subscriptions', { path: '/home/owner/.harness/quota.sqlite' });

const subscriptionOne = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1'), quota: sharedQuota });
const subscriptionTwo = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2'), quota: sharedQuota });
const subscriptionThree = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3'), quota: sharedQuota });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  [...ctx.candidates]
    .filter(c => (c.cooldownUntil === undefined || c.cooldownUntil <= ctx.now) && c.shareUsed < c.shareCap)
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const builderRole = H.role('builder').intents('read', 'edit', 'run', 'halt').instructions('Implement the unit of work in the worktree.');
const auditorRole = H.role('auditor').intents('read', 'run', 'record').instructions('List every deficit of the change; record lessons.');
const writerRole = H.role('writer').intents('read', 'edit').instructions('Write or revise the documentation page.');

const tasteKind = H.memory('owner-taste', 'taste');
const tasteJournal = H.journal('owner-taste', tasteKind)
  .store(jsonl.memoryStore({ path: '/home/owner/.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole, writerRole);

const productExperienceKind = H.memory('product-experience', 'experience');
const productExperience = H.journal('product-experience', productExperienceKind)
  .store(jsonl.memoryStore({ path: '/home/owner/code/product/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const productPool = H.pool('product-pool')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, 0.6)
  .share(subscriptionTwo, 0.6)
  .share(subscriptionThree, 0.6)
  .drain(soonestExpiring);

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const record = ctx.metrics.outcomes({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return record.samples >= 20 && record.successRate < 0.85 ? opus : sonnet;
});

const repoRunner = local.runner('product-repo').slots(2);
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(repoRunner);
const worktree = git.worktree({ repo: '/home/owner/code/product', base: 'main' }).guard({ leaseFiles: true, beforeStop: projectChecks });

const builder = H.seat('builder').role(builderRole).model(builderModel).pool(productPool).workspace(worktree);
const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(opus)
  .pool(productPool)
  .output(z.object({ deficits: z.array(z.string()) }));

const workAttrs = z.object({ title: z.string(), body: z.string(), trackerId: z.string() });

const Todo = H.state('todo', 'pending');
const Shipped = H.terminal('shipped', 'success');
const OutOfRounds = H.terminal('out-of-rounds', 'failure');
const GaveUp = H.terminal('gave-up', 'failure');

const bugKind = H.kind('bug').attributes(workAttrs).states(Todo, Shipped, OutOfRounds, GaveUp).key(a => a.trackerId).initial(Todo);
const featureKind = H.kind('feature').attributes(workAttrs).states(Todo, Shipped, OutOfRounds, GaveUp).key(a => a.trackerId).initial(Todo);

const buildAndAudit = H.flow('build-and-audit')
  .input(workAttrs)
  .params(z.object({ rounds: z.number().int() }))
  .loop(
    'rounds',
    f =>
      f
        .step('build', builder, ctx => ({ task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}` }))
        .step('audit', auditor, ctx => ({ task: `Audit the change for ${ctx.unit.attributes.title}` })),
    { max: ctx => ctx.params.rounds, until: ctx => ctx.steps.audit.deficits.length === 0 },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('outOfRounds');

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({ apiKey: linearKey, team: 'PROD', workflow: ['Todo', 'In Progress', 'Done', 'Canceled'] });
const trackerStates = {
  states: { todo: 'Todo', shipped: 'Done', 'out-of-rounds': 'Canceled', 'gave-up': 'Canceled' },
  inFlight: 'In Progress',
} as const satisfies object;

const bugs = H.lane('bugs', bugKind)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['bug'] }), (issue, to) =>
    to.create({ title: issue.title, body: issue.description, trackerId: issue.identifier }),
  )
  .supply(folder.files({ path: '/home/owner/code/product/bugs', glob: '*.md' }), (file, to) =>
    to.create({ title: file.name, body: file.body, trackerId: file.path }),
  )
  .supply(H.operator)
  .handler(buildAndAudit, { exits: { clean: Shipped, outOfRounds: OutOfRounds }, params: { rounds: 3 } })
  .store(tracker, { states: { todo: 'Todo', shipped: 'Done', 'out-of-rounds': 'Canceled', 'gave-up': 'Canceled' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: GaveUp });

const features = H.lane('features', featureKind)
  .supply(linear.issues({ apiKey: linearKey, team: 'PROD', labels: ['feature'] }), (issue, to) =>
    to.create({ title: issue.title, body: issue.description, trackerId: issue.identifier }),
  )
  .supply(H.operator)
  .handler(buildAndAudit, { exits: { clean: Shipped, outOfRounds: OutOfRounds }, params: { rounds: 5 } })
  .store(tracker, { states: { todo: 'Todo', shipped: 'Done', 'out-of-rounds': 'Canceled', 'gave-up': 'Canceled' }, inFlight: 'In Progress' })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60_000, exhausted: GaveUp });

const productSupervisor = claudeCode.supervisor('product-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
  ],
  port: H.slot.port(1),
});

export const product = H.harness('product')
  .ledger(sqlite.ledger({ path: '/home/owner/code/product/.harness/ledger.sqlite' }))
  .lanes(bugs, features)
  .journals(tasteJournal, productExperience)
  .scheduler(H.scheduler('product').standard(bugs, features).wip(bugs, 2).aging(features, { afterMinutes: 240 }))
  .clients(productSupervisor)
  .observers(
    markdown.board({ path: '/home/owner/code/product/.harness/board.md' }),
    markdown.telemetry({ path: '/home/owner/code/product/.harness/telemetry.md' }),
  );

const docsExperienceKind = H.memory('docs-experience', 'experience');
const docsExperience = H.journal('docs-experience', docsExperienceKind)
  .store(jsonl.memoryStore({ path: '/home/owner/code/docs/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 6 })
  .readBy(writerRole)
  .recordedBy(writerRole);

const docsPool = H.pool('docs-pool')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, 0.3)
  .share(subscriptionTwo, 0.3)
  .share(subscriptionThree, 0.3)
  .drain(soonestExpiring);

const writer = H.seat('writer').role(writerRole).model(sonnet).pool(docsPool);

const docsRunner = local.runner('docs-repo');
const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(i => ['npx', 'linkinator', i.path])
  .runner(docsRunner)
  .acceptExitCodes(0, 1);

const docAttrs = z.object({ path: z.string(), title: z.string(), body: z.string() });

const ToWrite = H.state('to-write', 'pending');
const Published = H.terminal('published', 'success');
const LinksStayBroken = H.terminal('links-stay-broken', 'failure');
const WriterGaveUp = H.terminal('writer-gave-up', 'failure');

const docPageKind = H.kind('doc-page')
  .attributes(docAttrs)
  .states(ToWrite, Published, LinksStayBroken, WriterGaveUp)
  .key(a => a.path)
  .initial(ToWrite);

const writePage = H.flow('write-page')
  .input(docAttrs)
  .step('write', writer, ctx => ({ task: `Revise ${ctx.unit.attributes.title} at ${ctx.unit.attributes.path}\n\n${ctx.unit.attributes.body}` }))
  .step('links', linkCheck, ctx => ({ path: ctx.unit.attributes.path }))
  .exit('published', ctx => ctx.steps.links.exitCode === 0)
  .exit('brokenLinks');

const docPages = H.lane('doc-pages', docPageKind)
  .supply(folder.files({ path: '/home/owner/code/docs/pages', glob: '**/*.md' }), (file, to) =>
    to.create({ path: file.path, title: file.name, body: file.body }),
  )
  .handler(writePage, {
    exits: { published: Published, brokenLinks: { to: ToWrite, limit: { count: 3, then: LinksStayBroken } } },
  })
  .store(folder.frontmatter({ path: '/home/owner/code/docs/pages' }))
  .retry({ maxAttempts: 2, exhausted: WriterGaveUp });

const docsSupervisor = claudeCode.supervisor('docs-supervisor', {
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.memoryWrite, H.ops.telemetryRead, H.ops.accountsRead, H.ops.accountsShare],
  port: H.slot.port(2),
});

export const docs = H.harness('docs')
  .ledger(sqlite.ledger({ path: '/home/owner/code/docs/.harness/ledger.sqlite' }))
  .lanes(docPages)
  .journals(tasteJournal, docsExperience)
  .scheduler(H.scheduler('docs').standard(docPages).wip(docPages, 2))
  .clients(docsSupervisor)
  .observers(markdown.board({ path: '/home/owner/code/docs/.harness/board.md' }));

export const ownerSession = claudeCode.session('owner', { endpoints: [productSupervisor, docsSupervisor] });

export const trackerStateNames = trackerStates;
