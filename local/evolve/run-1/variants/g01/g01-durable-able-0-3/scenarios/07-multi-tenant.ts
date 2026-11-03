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

const sharedAccountsPath = '~/.harness/accounts.sqlite';

const subscriptionOne = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1') });
const subscriptionTwo = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2') });
const subscriptionThree = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3') });
const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4' });

const soonestExpiring = H.policy.account('soonest-expiring', (ctx) =>
  [...ctx.candidates]
    .filter((account) => account.cooldownUntil === undefined || account.cooldownUntil <= ctx.now)
    .filter((account) => account.shareUsed < account.shareCap)
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const builderRole = H.role('builder').intents('read', 'edit', 'run', 'search', 'halt').instructions('Implement the ticket. Keep the project checks green.');
const writerRole = H.role('writer').intents('read', 'edit').instructions('Write and revise documentation pages.');

const taste = H.memory('taste').trust('taste');
const sharedTaste = H.journal('owner-taste', taste)
  .store(jsonl.memoryStore({ path: '~/.harness/taste.jsonl' }))
  .recall(H.recall('taste-by-specificity', { by: 'specificity', limit: 12 }))
  .readBy(builderRole, writerRole);

const experience = H.memory('experience').trust('experience');

const auditorRole = H.role('auditor').intents('read', 'run', 'search').instructions('Find deficits in the change. Report none when there are none.');

const codingExperience = H.journal('coding-experience', experience)
  .store(jsonl.memoryStore({ path: 'coding/memory/experience.jsonl' }))
  .recall(H.recall('coding-experience-recall', { by: 'specificity', limit: 10 }))
  .readBy(builderRole, auditorRole)
  .writtenBy(auditorRole);

const codingPool = H.pool('coding-pool')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, 0.6)
  .share(subscriptionTwo, 0.6)
  .share(subscriptionThree, 0.6)
  .drain(soonestExpiring)
  .fallback(anthropic.account('coding-api', { apiKey: H.env('ANTHROPIC_API_KEY') }));

const builderModel = H.policy.model('builder-model', [sonnet, opus], (ctx) => {
  const record = ctx.metrics.outcomes({ of: ctx.lane, model: sonnet, windowDays: 14 }).attempts;
  return record.samples >= 20 && record.successRate < 0.85 ? opus : sonnet;
});

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(local.runner('coding-local'));

const builder = H.agent('builder')
  .role(builderRole)
  .model(builderModel)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks))
  .output(z.object({ summary: z.string() }))
  .budgetTokens(400000);

const auditor = H.agent('auditor')
  .role(auditorRole)
  .model(opus)
  .output(z.object({ deficits: z.array(z.string()) }))
  .budgetTokens(150000);

const ticketAttrs = z.object({ issueId: z.string(), title: z.string(), description: z.string() });

const Queued = H.state('queued', 'pending');
const Building = H.state('building', 'active');
const Auditing = H.state('auditing', 'active');
const Done = H.state('done', 'terminal', 'success');
const Abandoned = H.state('abandoned', 'terminal', 'failure');
const Cancelled = H.state('cancelled', 'terminal', 'neutral');

const Bug = H.kind('Bug').attributes(ticketAttrs).states(Queued, Building, Auditing, Done, Abandoned, Cancelled).key((bug) => bug.issueId);
const Feature = H.kind('Feature').attributes(ticketAttrs).states(Queued, Building, Auditing, Done, Abandoned, Cancelled).key((feature) => feature.issueId);

const ticketFlow = H.flow('ticket')
  .input(ticketAttrs)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    (round) => round
      .step('build', builder, (ctx) => ({ task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}` }))
      .step('audit', auditor, (ctx) => ({ task: `Audit the change for ${ctx.unit.attributes.title}. Builder summary: ${ctx.steps.build.summary}` })),
    { max: (ctx) => ctx.params.rounds, until: (ctx) => ctx.steps.audit.deficits.length === 0 },
  )
  .exit('clean', (ctx) => ctx.steps.audit.deficits.length === 0)
  .exit('exhausted');

const linearStates = { queued: 'Todo', building: 'In Progress', auditing: 'In Review', done: 'Done', abandoned: 'Canceled', cancelled: 'Canceled' };
const tracker = linear.store({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', states: linearStates });

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['bug'] }), (issue, to) =>
    to.create({ issueId: issue.id, title: issue.title, description: issue.description }))
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ issueId: file.path, title: file.name, description: file.body }))
  .supply(H.operator)
  .store(tracker)
  .handler(ticketFlow, {
    exits: { clean: Done, exhausted: Abandoned },
    during: { build: Building, audit: Auditing },
    failure: Abandoned,
    params: { rounds: 3 },
  })
  .on(H.cancel, { enter: Cancelled });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['feature'] }), (issue, to) =>
    to.create({ issueId: issue.id, title: issue.title, description: issue.description }))
  .supply(H.operator)
  .store(tracker)
  .handler(ticketFlow, {
    exits: { clean: Done, exhausted: Abandoned },
    during: { build: Building, audit: Auditing },
    failure: Abandoned,
    params: { rounds: 5 },
  })
  .on(H.cancel, { enter: Cancelled });

const accountGrants = [H.ops.accountsRead, H.ops.accountsShare];

export const coding = H.harness('coding')
  .ledger(sqlite.ledger({ path: 'coding/ledger.sqlite', accountsPath: sharedAccountsPath }))
  .pool(codingPool)
  .lanes(bugs, features)
  .journals(sharedTaste, codingExperience)
  .scheduler(H.scheduler('coding-scheduler').priority(bugs, features).wip(bugs, 2).boost(features, { afterMinutes: 120 }))
  .clients(claudeCode.supervisor('coding-supervisor', {
    endpoint: 'coding',
    grants: [H.ops.workRead, H.ops.workCreate, H.ops.workUpdate, H.ops.blockersResolve, H.ops.memoryWrite, H.ops.telemetryRead, ...accountGrants],
  }))
  .observers(markdown.board({ path: 'coding/board.md' }), markdown.telemetry({ path: 'coding/telemetry.md' }));

const docsPool = H.pool('docs-pool')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, 0.3)
  .share(subscriptionTwo, 0.3)
  .share(subscriptionThree, 0.3)
  .drain(soonestExpiring);

const docsExperience = H.journal('docs-experience', experience)
  .store(jsonl.memoryStore({ path: 'docs/memory/experience.jsonl' }))
  .recall(H.recall('docs-experience-recall', { by: 'specificity', limit: 10 }))
  .readBy(writerRole)
  .writtenBy(writerRole);

const pageAttrs = z.object({ path: z.string(), title: z.string(), body: z.string() });

const Stale = H.state('stale', 'pending');
const Writing = H.state('writing', 'active');
const Checking = H.state('checking', 'active');
const NeedsFix = H.state('needsFix', 'waiting');
const Published = H.state('published', 'terminal', 'success');
const Failed = H.state('failed', 'terminal', 'failure');
const Withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const DocPage = H.kind('DocPage').attributes(pageAttrs).states(Stale, Writing, Checking, NeedsFix, Published, Failed, Withdrawn).key((page) => page.path);

const writer = H.agent('writer')
  .role(writerRole)
  .model(sonnet)
  .output(z.object({ summary: z.string() }))
  .budgetTokens(120000);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv((input) => ['link-check', input.path])
  .runner(local.runner('docs-local'));

const pageFlow = H.flow('doc-page')
  .input(pageAttrs)
  .step('write', writer, (ctx) => ({ task: `Revise ${ctx.unit.attributes.path}: ${ctx.unit.attributes.title}`, resources: [ctx.unit.attributes.path] }))
  .step('linkCheck', linkCheck, (ctx) => ({ path: ctx.unit.attributes.path }))
  .exit('published', (ctx) => ctx.steps.linkCheck.exitCode === 0)
  .exit('brokenLinks');

const pages = H.lane('pages', DocPage)
  .supply(folder.files({ path: 'docs', glob: '**/*.md' }), (file, to) =>
    to.create({ path: file.path, title: file.name, body: file.body }))
  .store(folder.frontmatter({ path: 'docs' }))
  .handler(pageFlow, {
    exits: { published: Published, brokenLinks: NeedsFix },
    during: { write: Writing, linkCheck: Checking },
    failure: Failed,
  })
  .on(H.cancel, { enter: Withdrawn });

export const docs = H.harness('docs')
  .ledger(sqlite.ledger({ path: 'docs/ledger.sqlite', accountsPath: sharedAccountsPath }))
  .pool(docsPool)
  .lanes(pages)
  .journals(sharedTaste, docsExperience)
  .scheduler(H.scheduler('docs-scheduler').priority(pages).wip(pages, 2))
  .clients(claudeCode.supervisor('docs-supervisor', {
    endpoint: 'docs',
    grants: [H.ops.workRead, H.ops.workUpdate, H.ops.blockersResolve, H.ops.memoryWrite, H.ops.telemetryRead, ...accountGrants],
  }))
  .observers(markdown.board({ path: 'docs/board.md' }));
