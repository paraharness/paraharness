import { z } from 'zod';
import { H, AccountState } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const sharedQuota = sqlite.quota('claude-subscriptions', { path: '/home/owner/.harness/quota.sqlite' });
const subscriptionOne = claudeCode.subscription('claude-one', { token: H.env('CLAUDE_ONE_TOKEN'), quota: sharedQuota });
const subscriptionTwo = claudeCode.subscription('claude-two', { token: H.env('CLAUDE_TWO_TOKEN'), quota: sharedQuota });
const subscriptionThree = claudeCode.subscription('claude-three', { token: H.env('CLAUDE_THREE_TOKEN'), quota: sharedQuota });
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  ctx.candidates
    .filter(c => c.shareUsed < c.shareCap && (c.cooldownUntil === undefined || c.cooldownUntil <= ctx.now))
    .reduce<AccountState | undefined>(
      (best, c) => (best === undefined || c.windowResetsAt < best.windowResetsAt ? c : best),
      undefined,
    ),
);

const subscriptionPool = (name: string, fraction: number) =>
  H.pool(name)
    .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
    .share(subscriptionOne, fraction)
    .share(subscriptionTwo, fraction)
    .share(subscriptionThree, fraction)
    .drain(soonestExpiring);

const tasteKind = H.memory('owner-taste', 'taste');
const tasteStore = jsonl.memoryStore({ path: '/home/owner/.harness/taste.jsonl' });
const tasteJournal = (...readers: ReturnType<typeof H.role>[]) =>
  H.journal('owner-taste', tasteKind).store(tasteStore).recall({ by: 'specificity', limit: 8 }).readBy(...readers);

const owner = claudeCode.supervisor('owner');

const builderRole = H.role('builder').intents('read', 'edit', 'run', 'search').instructions('Implement the unit of work in the worktree.');
const auditorRole = H.role('auditor').intents('read', 'run', 'record').instructions('List every deficit in the change. Record lessons as experience.');
const plannerRole = H.role('planner').intents('read', 'search').instructions('Decompose work into features.');

const apiAccount = anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedQuota });
const codingPool = subscriptionPool('coding-subscriptions', 0.6).fallback(apiAccount);
const shell = local.runner('coding-shell').slots(4);
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(shell);

const ownerDecision = H.halt('owner-decision').decision(z.object({ answer: z.string() }));

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const record = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return record.samples >= 20 && record.successRate < 0.85 ? opus : sonnet;
});

const builder = H.seat('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(codingPool)
  .workspace(git.worktree({ repo: '/home/owner/code/product', base: 'main' }))
  .guard({ leaseFiles: true, beforeStop: projectChecks })
  .halts(ownerDecision);

const auditor = H.seat('auditor')
  .output(z.object({ deficits: z.array(z.string()) }))
  .role(auditorRole)
  .model(opus)
  .pool(codingPool);

const Open = H.state('Open', 'pending');
const Building = H.state('Building', 'active');
const Done = H.terminal('Done', 'success');
const Dropped = H.terminal('Dropped', 'failure');

const workAttributes = z.object({ title: z.string(), body: z.string(), trackerId: z.string() });

const Bug = H.kind('Bug').attributes(workAttributes).states(Open, Building, Done, Dropped).key(a => a.trackerId).initial(Open);
const Feature = H.kind('Feature').attributes(workAttributes).states(Open, Building, Done, Dropped).key(a => a.trackerId).initial(Open);

const buildAndAudit = H.flow('build-and-audit')
  .input(z.object({ title: z.string(), body: z.string() }))
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    f =>
      f
        .step('build', builder, ctx => ({ task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}` }))
        .step('audit', auditor, ctx => ({ task: `Audit the change for: ${ctx.unit.attributes.title}` })),
    { max: ctx => ctx.params.rounds, until: ctx => ctx.steps.audit.deficits.length === 0 },
  )
  .exit('done');

const trackerKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({ apiKey: trackerKey, team: 'PRODUCT', workflow: ['Todo', 'In Progress', 'Done', 'Canceled'] });
const trackerStates = { Open: 'Todo', Building: 'In Progress', Done: 'Done', Dropped: 'Canceled' } satisfies Record<string, string>;

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PRODUCT', labels: ['bug'] }), (issue, to) =>
    to.create({ title: issue.title, body: issue.description, trackerId: issue.identifier }),
  )
  .supply(folder.files({ path: '/home/owner/code/product/bugs', glob: '*.md' }), (file, to) =>
    to.create({ title: file.name, body: file.body, trackerId: file.path }),
  )
  .supply(H.operator)
  .store(tracker, { Open: 'Todo', Building: 'In Progress', Done: 'Done', Dropped: 'Canceled' })
  .handler(buildAndAudit, { exits: { done: Done }, during: { build: Building, audit: Building }, params: { rounds: 3 } })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 300000, exhausted: Dropped });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: trackerKey, team: 'PRODUCT', labels: ['feature'] }), (issue, to) =>
    to.create({ title: issue.title, body: issue.description, trackerId: issue.identifier }),
  )
  .supply(H.operator)
  .store(tracker, { Open: trackerStates.Open, Building: 'In Progress', Done: 'Done', Dropped: 'Canceled' })
  .handler(buildAndAudit, { exits: { done: Done }, during: { build: Building, audit: Building }, params: { rounds: 5 } })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 600000, exhausted: Dropped });

const codingExperience = H.journal('coding-experience', H.memory('coding-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '/home/owner/code/product/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const codingHarness = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '/home/owner/code/product/.harness/ledger.sqlite' }))
  .lanes(bugs, features)
  .journals(tasteJournal(builderRole, plannerRole), codingExperience)
  .scheduler(H.scheduler('coding-scheduler').priority(bugs, features).wip(bugs, 2).boost(features, { afterMinutes: 240 }))
  .clients(
    owner.client('coding-endpoint', {
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
      ],
    }),
  )
  .observers(
    markdown.board({ path: '/home/owner/code/product/.harness/board.md' }),
    markdown.telemetry({ path: '/home/owner/code/product/.harness/telemetry.md' }),
  );

const writerRole = H.role('writer').intents('read', 'edit').instructions('Write or revise the documentation page in place.');
const docsPool = subscriptionPool('docs-subscriptions', 0.3);
const docsShell = local.runner('docs-shell').slots(2);

const writer = H.seat('writer')
  .role(writerRole)
  .model(sonnet)
  .pool(docsPool)
  .workspace(git.worktree({ repo: '/home/owner/code/docs', base: 'main' }));

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(i => ['npx', 'linkinator', i.path])
  .runner(docsShell);

const Queued = H.state('Queued', 'pending');
const Writing = H.state('Writing', 'active');
const Published = H.terminal('Published', 'success');
const Broken = H.terminal('Broken', 'failure');

const DocPage = H.kind('DocPage')
  .attributes(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .states(Queued, Writing, Published, Broken)
  .key(a => a.path)
  .initial(Queued);

const writePage = H.flow('write-page')
  .input(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .step('write', writer, ctx => ({ task: `Revise ${ctx.unit.attributes.title} at ${ctx.unit.attributes.path}` }))
  .step('links', linkCheck, ctx => ({ path: ctx.unit.attributes.path }))
  .exit('published');

const docPages = H.lane('doc-pages', DocPage)
  .supply(folder.files({ path: '/home/owner/code/docs/pages', glob: '**/*.md' }), (file, to) =>
    to.create({ path: file.path, title: file.name, body: file.body }),
  )
  .store(folder.frontmatter({ path: '/home/owner/code/docs/pages' }))
  .handler(writePage, { exits: { published: Published }, during: { write: Writing, links: Writing } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60000, exhausted: Broken });

const docsExperience = H.journal('docs-experience', H.memory('docs-experience', 'experience'))
  .store(jsonl.memoryStore({ path: '/home/owner/code/docs/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 6 })
  .readBy(writerRole)
  .recordedBy(writerRole);

const docsHarness = H.harness('documentation')
  .ledger(sqlite.ledger({ path: '/home/owner/code/docs/.harness/ledger.sqlite' }))
  .lanes(docPages)
  .journals(tasteJournal(writerRole), docsExperience)
  .scheduler(H.scheduler('docs-scheduler').priority(docPages).wip(docPages, 2))
  .clients(
    owner.client('docs-endpoint', {
      port: H.slot.port(2),
      grants: [H.ops.workRead, H.ops.workCreate, H.ops.memoryWrite, H.ops.telemetryRead, H.ops.accountsRead],
    }),
  )
  .observers(markdown.board({ path: '/home/owner/code/docs/.harness/board.md' }));

void codingHarness.start();
void docsHarness.start();
