import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear, LinearIssue } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

export const subscriptionQuota = sqlite.quota('claude-subscriptions', { path: '/var/lib/harness/subscription-quota.sqlite' });

export const maxOne = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota: subscriptionQuota });
export const maxTwo = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota: subscriptionQuota });
export const maxThree = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota: subscriptionQuota });
export const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: subscriptionQuota });

export const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
export const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

export const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  ctx.candidates
    .filter(s => (s.cooldownUntil === undefined || s.cooldownUntil <= ctx.now) && s.shareUsed < s.shareCap)
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

export const builderRole = H.role('builder').intents('read', 'edit', 'run', 'halt').instructions('Implement the unit of work and leave the checks green.');
export const auditorRole = H.role('auditor').intents('read', 'search', 'record').instructions('List every deficit against the request; record lessons worth keeping.');
export const plannerRole = H.role('planner').intents('read', 'search').instructions('Break the request into buildable steps.');
export const writerRole = H.role('writer').intents('read', 'edit').instructions('Write clear documentation pages.');

export const ownerTaste = H.memory('owner-taste', 'taste');
export const ownerTasteJournal = H.journal('owner-taste', ownerTaste)
  .store(jsonl.memoryStore({ path: '/home/owner/.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, plannerRole, writerRole);

export const ownerSession = (clients: Parameters<typeof claudeCode.session>[1]['clients']) => claudeCode.session('owner-supervisor', { clients });

const codingExperience = H.memory('coding-experience', 'experience');
const codingExperienceJournal = H.journal('coding-experience', codingExperience)
  .store(jsonl.memoryStore({ path: 'coding/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const codingPool = H.pool('coding-subscriptions')
  .accounts(maxOne, maxTwo, maxThree)
  .share(maxOne, 0.6)
  .share(maxTwo, 0.6)
  .share(maxThree, 0.6)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const cheap = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples >= 20 && cheap.successRate < 0.85 ? opus : sonnet;
});

const workstation = local.runner('workstation').slots(2);
const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(workstation);

const builder = H.seat('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(codingPool)
  .workspace(git.worktree({ repo: 'coding', base: 'main' }))
  .guard({ leaseFiles: true, beforeStop: projectChecks })
  .output(z.object({ summary: z.string() }));

const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(sonnet)
  .pool(codingPool)
  .output(z.object({ deficits: z.array(z.string()) }));

const workAttributes = z.object({ issueId: z.string(), title: z.string(), body: z.string() });

const triaged = H.state('triaged', 'pending');
const inProgress = H.state('inProgress', 'active');
const done = H.terminal('done', 'success');
const unresolved = H.terminal('unresolved', 'failure');
const withdrawn = H.terminal('withdrawn', 'neutral');

const bugKind = H.kind('Bug').attributes(workAttributes).states(triaged, inProgress, done, unresolved, withdrawn).key(a => a.issueId).initial(triaged);
const featureKind = H.kind('Feature').attributes(workAttributes).states(triaged, inProgress, done, unresolved, withdrawn).key(a => a.issueId).initial(triaged);

const buildAndAudit = H.flow('build-and-audit')
  .input(workAttributes)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    f =>
      f
        .step('build', builder, ctx => ({ task: `Resolve ${ctx.unit.attributes.issueId}: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}` }))
        .step('audit', auditor, ctx => ({ task: `Audit the change for ${ctx.unit.attributes.issueId}. Builder summary: ${ctx.steps.build.summary}` })),
    { max: ctx => ctx.params.rounds, until: ctx => ctx.steps.audit.deficits.length === 0 },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('deficitsRemain');

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({ apiKey: linearKey, team: 'ENG', workflow: ['Todo', 'In Progress', 'Done', 'Canceled'] });
const fromIssue = (issue: LinearIssue) => ({ issueId: issue.identifier, title: issue.title, body: issue.description });

const bugs = H.lane('bugs', bugKind)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['bug'] }), (issue, to) => to.create(fromIssue(issue)))
  .supply(folder.files({ path: 'coding/bugs', glob: '*.md' }), (file, to) => to.create({ issueId: file.name, title: file.name, body: file.body }))
  .supply(H.operator)
  .store(tracker, { triaged: 'Todo', inProgress: 'In Progress', done: 'Done', unresolved: 'Todo', withdrawn: 'Canceled' })
  .handler(buildAndAudit, {
    exits: { clean: done, deficitsRemain: unresolved },
    during: { build: inProgress, audit: inProgress },
    cancelled: withdrawn,
    params: { rounds: 3 },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: unresolved });

const features = H.lane('features', featureKind)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['feature'] }), (issue, to) => to.create(fromIssue(issue)))
  .supply(H.operator)
  .store(tracker, { triaged: 'Todo', inProgress: 'In Progress', done: 'Done', unresolved: 'Todo', withdrawn: 'Canceled' })
  .handler(buildAndAudit, {
    exits: { clean: done, deficitsRemain: unresolved },
    during: { build: inProgress, audit: inProgress },
    cancelled: withdrawn,
    params: { rounds: 5 },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: unresolved });

const codingClient = H.client('coding-supervisor', {
  transport: claudeCode.mcp('coding-mcp', { port: H.slot.port(1) }),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.attemptsRecover,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
  ],
});

export const coding = H.harness('coding')
  .ledger(sqlite.ledger({ path: 'coding/.harness/ledger.sqlite' }))
  .lanes(bugs, features)
  .journals(ownerTasteJournal, codingExperienceJournal)
  .scheduler(H.scheduler('coding-scheduler').priority(bugs, features).wip(bugs, 2).boost(features, { afterMinutes: 240 }))
  .clients(codingClient)
  .observers(markdown.board({ path: 'coding/BOARD.md' }), markdown.telemetry({ path: 'coding/TELEMETRY.md' }));

const docsExperience = H.memory('docs-experience', 'experience');
const docsExperienceJournal = H.journal('docs-experience', docsExperience)
  .store(jsonl.memoryStore({ path: 'docs/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(writerRole)
  .recordedBy(writerRole);

const docsPool = H.pool('docs-subscriptions')
  .accounts(maxOne, maxTwo, maxThree)
  .share(maxOne, 0.3)
  .share(maxTwo, 0.3)
  .share(maxThree, 0.3)
  .drain(soonestExpiring);

const writer = H.seat('writer')
  .role(writerRole)
  .model(sonnet)
  .pool(docsPool)
  .workspace(git.worktree({ repo: 'docs', base: 'main' }))
  .output(z.object({ body: z.string() }));

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(i => ['lychee', '--offline', i.path])
  .acceptExitCodes(0, 2)
  .runner(local.runner('docs-workstation'));

const pageAttributes = z.object({ path: z.string(), title: z.string(), body: z.string() });

const queued = H.state('queued', 'pending');
const writing = H.state('writing', 'active');
const checking = H.state('checking', 'active');
const published = H.terminal('published', 'success');
const brokenLinks = H.terminal('brokenLinks', 'failure');
const dropped = H.terminal('dropped', 'neutral');

const docPageKind = H.kind('DocPage').attributes(pageAttributes).states(queued, writing, checking, published, brokenLinks, dropped).key(a => a.path).initial(queued);

const writePage = H.flow('write-page')
  .input(pageAttributes)
  .step('write', writer, ctx => ({ task: `Write or revise ${ctx.unit.attributes.path}: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}` }))
  .step('linkCheck', linkCheck, ctx => ({ path: ctx.unit.attributes.path }))
  .exit('linksBroken', ctx => ctx.steps.linkCheck.exitCode === 2)
  .exit('written');

const docPages = H.lane('doc-pages', docPageKind)
  .supply(folder.files({ path: 'docs/pages', glob: '**/*.md' }), (file, to) => to.create({ path: file.path, title: file.name, body: file.body }))
  .store(folder.frontmatter({ path: 'docs/pages' }))
  .handler(writePage, {
    exits: { linksBroken: brokenLinks, written: published },
    during: { write: writing, linkCheck: checking },
    cancelled: dropped,
  })
  .retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30000, exhausted: brokenLinks });

const docsClient = H.client('docs-supervisor', {
  transport: claudeCode.mcp('docs-mcp', { port: H.slot.port(2) }),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.memoryWrite, H.ops.telemetryRead, H.ops.accountsRead, H.ops.accountsShare],
});

export const docs = H.harness('docs')
  .ledger(sqlite.ledger({ path: 'docs/.harness/ledger.sqlite' }))
  .lanes(docPages)
  .journals(ownerTasteJournal, docsExperienceJournal)
  .scheduler(H.scheduler('docs-scheduler').priority(docPages).wip(docPages, 2))
  .clients(docsClient)
  .observers(markdown.board({ path: 'docs/BOARD.md' }));

export const supervisor = ownerSession([codingClient, docsClient]);
