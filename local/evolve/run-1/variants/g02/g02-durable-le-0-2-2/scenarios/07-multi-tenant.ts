import { z } from 'zod';
import { H } from 'harness-dsl';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';
import { sqlite } from 'harness-dsl/sqlite';

const subscriptionOne = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') });
const subscriptionTwo = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN') });
const subscriptionThree = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN') });
const sharedQuota = sqlite.accountLedger({ path: '/home/owner/.harness/accounts.sqlite' });
const soonestExpiring = H.policy.account('soonest-expiring', account => account.windowResetsAt.getTime());

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const builder = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the work item in the worktree. Halt for the owner when a product decision is needed.');
const auditor = H.role('auditor')
  .intents('read', 'search', 'record')
  .instructions('List every deficit in the change. Return an empty list only when none remain.');
const writer = H.role('writer')
  .intents('read', 'edit')
  .instructions('Write or revise the documentation page so that it is accurate and every link resolves.');

const taste = H.memory('taste').trust('taste');
const experience = H.memory('experience').trust('experience');

const ownerTaste = H.journal('owner-taste', taste)
  .store(jsonl.memoryStore({ path: '/home/owner/.harness/taste.jsonl' }))
  .recall(H.recall('taste-by-scope', { by: 'specificity', limit: 12 }))
  .readBy(builder, writer);

const ticket = z.object({ issueId: z.string(), title: z.string(), description: z.string() });

const Backlog = H.state('backlog', 'pending');
const Done = H.terminal('done', 'success');
const Exhausted = H.terminal('exhausted', 'failure');
const Cancelled = H.terminal('cancelled', 'neutral');

const Bug = H.kind('Bug')
  .attributes(ticket)
  .states(Backlog, Done, Exhausted, Cancelled)
  .key(t => t.issueId)
  .initial(Backlog)
  .onCancelled(Cancelled);

const Feature = H.kind('Feature')
  .attributes(ticket)
  .states(Backlog, Done, Exhausted, Cancelled)
  .key(t => t.issueId)
  .initial(Backlog)
  .onCancelled(Cancelled);

const codingExperience = H.journal('coding-experience', experience)
  .store(jsonl.memoryStore({ path: 'coding/memory/experience.jsonl' }))
  .recall(H.recall('experience-by-scope', { by: 'specificity', limit: 10 }))
  .readBy(builder, auditor)
  .recordedBy(auditor);

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.attempts({ of: ctx.kind, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples >= 20 && cheap.successRate < 0.85 ? opus : sonnet;
});

const codingRunner = local.runner('coding-local').slots(3);
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(codingRunner);

const builderAgent = H.agent('builder')
  .role(builder)
  .model(builderModel)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks));

const auditorAgent = H.agent('auditor')
  .role(auditor)
  .model(sonnet)
  .output(z.object({ deficits: z.array(z.string()) }));

const ticketFlow = H.flow('ticket')
  .input(ticket)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    flow =>
      flow
        .step('build', builderAgent, ctx => ({
          task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
          skills: [ctx.unit.kind],
        }))
        .step('audit', auditorAgent, ctx => ({ task: `Audit the change for ${ctx.unit.attributes.title}.` })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('done', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('exhausted');

const linearKey = H.env('LINEAR_API_KEY');
const trackerStore = linear.store({
  apiKey: linearKey,
  team: 'ENG',
  states: { backlog: 'Backlog', done: 'Done', exhausted: 'Canceled', cancelled: 'Canceled' },
  whileActive: 'In Progress',
  whileWaiting: 'In Review',
});

const bugs = H.lane('bugs', Bug)
  .supply(H.operator)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['bug'] }), (issue, to) =>
    to.create({ issueId: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ issueId: file.name, title: file.name, description: file.body }),
  )
  .store(trackerStore)
  .handler(ticketFlow, { exits: { done: Done, exhausted: Exhausted }, params: { rounds: 3 } });

const features = H.lane('features', Feature)
  .supply(H.operator)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['feature'] }), (issue, to) =>
    to.create({ issueId: issue.identifier, title: issue.title, description: issue.description }),
  )
  .store(trackerStore)
  .handler(ticketFlow, { exits: { done: Done, exhausted: Exhausted }, params: { rounds: 5 } });

const apiFallback = anthropic.account('coding-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const codingPool = H.pool('coding-subscriptions')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, 0.6)
  .share(subscriptionTwo, 0.6)
  .share(subscriptionThree, 0.6)
  .drain(soonestExpiring)
  .fallback(apiFallback)
  .serves(sonnet, opus)
  .ledger(sharedQuota);

export const coding = H.harness('coding')
  .ledger(sqlite.ledger({ path: 'coding/ledger.sqlite' }))
  .pools(codingPool)
  .lanes(bugs, features)
  .journals(ownerTaste, codingExperience)
  .scheduler(
    H.scheduler('coding')
      .priority(bugs, features)
      .wip(bugs, 2)
      .boost(features, { afterMinutes: 240 }),
  )
  .clients(
    claudeCode.supervisor('owner-on-coding', {
      endpoint: 'coding',
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
  .observers(markdown.board({ path: 'coding/BOARD.md' }), markdown.telemetry({ path: 'coding/TELEMETRY.md' }));

const page = z.object({ path: z.string(), title: z.string() });

const Todo = H.state('todo', 'pending');
const Published = H.terminal('published', 'success');
const BrokenLinks = H.terminal('broken-links', 'failure');
const Withdrawn = H.terminal('withdrawn', 'neutral');

const DocPage = H.kind('DocPage')
  .attributes(page)
  .states(Todo, Published, BrokenLinks, Withdrawn)
  .key(p => p.path)
  .initial(Todo)
  .onCancelled(Withdrawn);

const docsExperience = H.journal('docs-experience', experience)
  .store(jsonl.memoryStore({ path: 'docs/memory/experience.jsonl' }))
  .recall(H.recall('docs-experience-by-scope', { by: 'specificity', limit: 10 }))
  .readBy(writer)
  .recordedBy(writer);

const docsRunner = local.runner('docs-local').slots(2);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(target => ['npx', 'markdown-link-check', target.path])
  .acceptExitCodes(1)
  .runner(docsRunner);

const writerAgent = H.agent('writer').role(writer).model(sonnet);

const docFlow = H.flow('doc-page')
  .input(page)
  .loop(
    'rounds',
    flow =>
      flow
        .step('write', writerAgent, ctx => ({
          task: `Write or revise ${ctx.unit.attributes.title}.`,
          resources: [ctx.unit.attributes.path],
        }))
        .step('linkCheck', linkCheck, ctx => ({ path: ctx.unit.attributes.path })),
    { max: 3, until: ctx => ctx.steps.linkCheck.exitCode === 0 },
  )
  .exit('published', ctx => ctx.steps.linkCheck.exitCode === 0)
  .exit('broken');

const docPages = H.lane('doc-pages', DocPage)
  .supply(folder.files({ path: 'docs', glob: '**/*.md' }), (file, to) =>
    to.create({ path: file.path, title: file.name }),
  )
  .store(folder.frontmatter({ path: 'docs' }))
  .handler(docFlow, { exits: { published: Published, broken: BrokenLinks } });

const docsPool = H.pool('docs-subscriptions')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, 0.3)
  .share(subscriptionTwo, 0.3)
  .share(subscriptionThree, 0.3)
  .drain(soonestExpiring)
  .serves(sonnet)
  .ledger(sharedQuota);

export const docs = H.harness('docs')
  .ledger(sqlite.ledger({ path: 'docs/ledger.sqlite' }))
  .pools(docsPool)
  .lanes(docPages)
  .journals(ownerTaste, docsExperience)
  .scheduler(H.scheduler('docs').priority(docPages))
  .clients(
    claudeCode.supervisor('owner-on-docs', {
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
    }),
  )
  .observers(markdown.board({ path: 'docs/BOARD.md' }), markdown.telemetry({ path: 'docs/TELEMETRY.md' }));
