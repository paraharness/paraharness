import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const sharedSubscriptionOne = claudeCode.subscription('max-one', { token: H.env('CLAUDE_MAX_ONE_TOKEN') });
const sharedSubscriptionTwo = claudeCode.subscription('max-two', { token: H.env('CLAUDE_MAX_TWO_TOKEN') });
const sharedSubscriptionThree = claudeCode.subscription('max-three', { token: H.env('CLAUDE_MAX_THREE_TOKEN') });

const sharedQuota = sqlite.quota({ path: '/Users/owner/.harness/account-quota.sqlite' });

const sharedSonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const sharedOpus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const sharedSoonestExpiringFirst = H.policy.account('soonest-expiring-first', ctx =>
  ctx.candidates
    .filter(state => state.cooldownUntil === undefined || state.cooldownUntil.getTime() <= ctx.now.getTime())
    .filter(state => state.shareUsed < state.shareCap && state.utilization < 1)
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0]);

const sharedBuilderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the work item in the worktree. Halt for the owner when a product decision is needed.');
const sharedWriterRole = H.role('writer')
  .intents('read', 'edit', 'record')
  .instructions('Write or revise the documentation page so it is accurate and its links resolve.');

const sharedTaste = H.memory('owner-taste').trust('taste');
const sharedExperience = H.memory('experience').trust('experience');
const sharedRecall = H.recall('scoped-recall', { by: 'specificity', limit: 10 });

const sharedTasteJournal = H.journal('owner-taste', sharedTaste)
  .store(jsonl.memoryStore({ path: '/Users/owner/.harness/taste.jsonl' }))
  .recall(sharedRecall)
  .readBy(sharedBuilderRole, sharedWriterRole);

const codingRunner = local.runner('coding-local');
const codingWorktree = git.worktree({ repo: '/Users/owner/code/product', base: 'main' });
const codingApi = anthropic.account('coding-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('Find deficits in the change: missing tests, broken contracts, unhandled cases. Record lessons that will recur.');

const codingExperience = H.journal('coding-experience', sharedExperience)
  .store(jsonl.memoryStore({ path: '/Users/owner/code/product/.harness/experience.jsonl' }))
  .recall(sharedRecall)
  .readBy(sharedBuilderRole, auditorRole)
  .recordedBy(auditorRole);

const codingPool = H.pool('coding-accounts')
  .accounts(sharedSubscriptionOne, sharedSubscriptionTwo, sharedSubscriptionThree)
  .serves(sharedSonnet, sharedOpus)
  .share(sharedSubscriptionOne, 0.6)
  .share(sharedSubscriptionTwo, 0.6)
  .share(sharedSubscriptionThree, 0.6)
  .drain(sharedSoonestExpiringFirst)
  .fallback(codingApi);

const builderModel = H.policy.model('builder-model', [sharedSonnet, sharedOpus], ctx => {
  const cheaper = ctx.metrics.outcomes({ of: ctx.kind, model: sharedSonnet, window: { lastDays: 14 } });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? sharedOpus : sharedSonnet;
});

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(codingRunner);

const builder = H.agent('builder')
  .role(sharedBuilderRole)
  .model(builderModel)
  .workspace(codingWorktree)
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks))
  .output(z.object({ summary: z.string() }))
  .budgetTokens(400000);

const auditor = H.agent('auditor')
  .role(auditorRole)
  .model(sharedOpus)
  .workspace(codingWorktree)
  .output(z.object({ deficits: z.array(z.string()) }));

const workItemSchema = z.object({
  ref: z.string(),
  title: z.string(),
  description: z.string(),
});

const Todo = H.state('Todo', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Done = H.terminal('Done', 'success');
const Exhausted = H.terminal('Exhausted', 'failure');
const Dropped = H.terminal('Dropped', 'neutral');

const Bug = H.kind('Bug')
  .attributes(workItemSchema)
  .states(Todo, Building, Auditing, Done, Exhausted, Dropped)
  .key(item => item.ref)
  .initial(Todo)
  .onCancelled(Dropped);

const Feature = H.kind('Feature')
  .attributes(workItemSchema)
  .states(Todo, Building, Auditing, Done, Exhausted, Dropped)
  .key(item => item.ref)
  .initial(Todo)
  .onCancelled(Dropped);

const buildAndAudit = H.flow('build-and-audit')
  .input(workItemSchema)
  .params(z.object({ rounds: z.number().int().positive() }))
  .loop(
    'rounds',
    round => round
      .step('build', builder, ctx => ({
        task: `Round ${ctx.iteration + 1}: implement "${ctx.unit.attributes.title}".\n\n${ctx.unit.attributes.description}`,
      }))
      .step('audit', auditor, ctx => ({
        task: `Audit the change for "${ctx.unit.attributes.title}". Builder summary: ${ctx.steps.build.summary}`,
      })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('done', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('exhausted');

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({
  apiKey: linearKey,
  team: 'CORE',
  states: {
    Todo: 'Todo',
    Building: 'In Progress',
    Auditing: 'In Review',
    Done: 'Done',
    Exhausted: 'Needs Owner',
    Dropped: 'Canceled',
  },
});

const bugs = H.lane('bugs', Bug)
  .supply(
    linear.issues({ apiKey: linearKey, team: 'CORE', labels: ['bug'] }),
    (issue, to) => to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(
    folder.files({ path: '/Users/owner/code/product/bugs', glob: '*.md' }),
    (file, to) => to.create({ ref: file.path, title: file.name, description: file.body }),
  )
  .supply(H.operator)
  .store(tracker)
  .handler(buildAndAudit, {
    exits: { done: Done, exhausted: Exhausted },
    during: { build: Building, audit: Auditing },
    params: { rounds: 3 },
  });

const features = H.lane('features', Feature)
  .supply(
    linear.issues({ apiKey: linearKey, team: 'CORE', labels: ['feature'] }),
    (issue, to) => to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(H.operator)
  .store(tracker)
  .handler(buildAndAudit, {
    exits: { done: Done, exhausted: Exhausted },
    during: { build: Building, audit: Auditing },
    params: { rounds: 5 },
  });

const productionProbe = H.operation('production-health-probe')
  .run(H.command('probe-production').argv(['curl', '-fsS', 'https://product.example.com/health']).runner(codingRunner));

const codingSupervisor = claudeCode.supervisor('owner-supervisor-coding', {
  endpoint: 'http://127.0.0.1:7401',
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.send(H.answer, { lanes: [bugs, features] }),
    H.ops.send(H.cancel, { lanes: [bugs, features] }),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productionProbe,
  ],
});

export const codingHarness = H.harness('product-coding')
  .ledger(sqlite.ledger({ path: '/Users/owner/code/product/.harness/ledger.sqlite' }), { quota: sharedQuota })
  .pools(codingPool)
  .lanes(bugs, features)
  .journals(sharedTasteJournal, codingExperience)
  .scheduler(H.scheduler('coding').priority(bugs, features).wip(bugs, 2).boost(features, { afterMinutes: 240 }))
  .clients(codingSupervisor)
  .observers(
    markdown.board({ path: '/Users/owner/code/product/BOARD.md' }),
    markdown.telemetry({ path: '/Users/owner/code/product/TELEMETRY.md' }),
  );

const docsRunner = local.runner('docs-local');
const docsWorktree = git.worktree({ repo: '/Users/owner/code/docs', base: 'main' });

const docsExperience = H.journal('docs-experience', sharedExperience)
  .store(jsonl.memoryStore({ path: '/Users/owner/code/docs/.harness/experience.jsonl' }))
  .recall(sharedRecall)
  .readBy(sharedWriterRole)
  .recordedBy(sharedWriterRole);

const docsPool = H.pool('docs-accounts')
  .accounts(sharedSubscriptionOne, sharedSubscriptionTwo, sharedSubscriptionThree)
  .serves(sharedSonnet)
  .share(sharedSubscriptionOne, 0.3)
  .share(sharedSubscriptionTwo, 0.3)
  .share(sharedSubscriptionThree, 0.3)
  .drain(sharedSoonestExpiringFirst);

const docPageSchema = z.object({
  path: z.string(),
  title: z.string(),
  body: z.string(),
});

const DocQueued = H.state('DocQueued', 'pending');
const DocWriting = H.state('DocWriting', 'active');
const DocChecking = H.state('DocChecking', 'active');
const Published = H.terminal('Published', 'success');
const DocNeedsOwner = H.terminal('DocNeedsOwner', 'failure');

const DocPage = H.kind('DocPage')
  .attributes(docPageSchema)
  .states(DocQueued, DocWriting, DocChecking, Published, DocNeedsOwner)
  .key(page => page.path)
  .initial(DocQueued)
  .onAttemptFailed(DocNeedsOwner);

const docWriter = H.agent('doc-writer')
  .role(sharedWriterRole)
  .model(sharedSonnet)
  .workspace(docsWorktree)
  .output(z.object({ summary: z.string() }));

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(input => ['npx', 'linkinator', input.path])
  .runner(docsRunner);

const writeDocFlow = H.flow('write-doc-page')
  .input(docPageSchema)
  .step('write', docWriter, ctx => ({
    task: `Revise the page "${ctx.unit.attributes.title}" at ${ctx.unit.attributes.path}.`,
    resources: [ctx.unit.attributes.path],
  }))
  .step('linkCheck', linkCheck, ctx => ({ path: ctx.unit.attributes.path }))
  .exit('published');

const docs = H.lane('docs', DocPage)
  .supply(
    folder.files({ path: '/Users/owner/code/docs/pages', glob: '**/*.md' }),
    (file, to) => file.frontmatter['state'] === 'Published'
      ? to.skip()
      : to.create({ path: file.path, title: file.name, body: file.body }),
  )
  .store(folder.frontmatter({ path: '/Users/owner/code/docs/pages' }))
  .handler(writeDocFlow, {
    exits: { published: Published },
    during: { write: DocWriting, linkCheck: DocChecking },
  })
  .retry(H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 60000 }));

const docsSupervisor = claudeCode.supervisor('owner-supervisor-docs', {
  endpoint: 'http://127.0.0.1:7402',
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
  ],
});

export const docsHarness = H.harness('product-docs')
  .ledger(sqlite.ledger({ path: '/Users/owner/code/docs/.harness/ledger.sqlite' }), { quota: sharedQuota })
  .pools(docsPool)
  .lanes(docs)
  .journals(sharedTasteJournal, docsExperience)
  .scheduler(H.scheduler('docs').priority(docs).wip(docs, 2))
  .clients(docsSupervisor)
  .observers(markdown.board({ path: '/Users/owner/code/docs/BOARD.md' }));

export const startCoding = () => codingHarness.start();
export const startDocs = () => docsHarness.start();
