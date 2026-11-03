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

const sharedQuotaPath = '~/.harness/shared-quota.sqlite';

const subscriptionOne = claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1') });
const subscriptionTwo = claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2') });
const subscriptionThree = claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3') });

const soonestExpiring = H.policy.account('soonest-expiring', (ctx) =>
  [...ctx.candidates]
    .filter((state) => state.shareUsed < state.shareCap)
    .filter((state) => state.cooldownUntil === undefined || state.cooldownUntil < ctx.now)
    .sort((left, right) => left.windowResetsAt.getTime() - right.windowResetsAt.getTime())[0],
);

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the ticket. Keep changes minimal and tested.');
const plannerRole = H.role('planner').intents('read', 'search').instructions('Decompose work into tickets.');
const writerRole = H.role('writer')
  .intents('read', 'edit', 'record')
  .instructions('Bring the page up to date with the code it documents.');

const ownerTaste = H.corpus('owner-taste', H.memory('owner-taste', 'taste'))
  .store(jsonl.memoryStore({ path: '~/.harness/owner-taste.jsonl' }))
  .recall({ by: 'specificity', limit: 20 })
  .readBy(builderRole, plannerRole, writerRole);

const ownerSupervisor = claudeCode.supervisor('owner-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.blockersResolve,
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
  ],
});

const localRunner = local.runner('local');

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });
const apiFallback = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const codingPool = H.pool('coding-pool')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, 0.6)
  .share(subscriptionTwo, 0.6)
  .share(subscriptionThree, 0.6)
  .drain(soonestExpiring)
  .fallback(apiFallback);

const builderModel = H.policy.model('builder-model', [sonnet, opus], (ctx) => {
  const cheap = ctx.metrics.attempts({ of: ctx.kind, model: sonnet, window: { lastDays: 14 } });
  return cheap.samples >= 20 && cheap.successRate < 0.85 ? opus : sonnet;
});

const auditorRole = H.role('auditor')
  .intents('read', 'run', 'record')
  .instructions('List every deficit against the ticket. Return none only when there are none.');

const codingExperience = H.corpus('coding-experience', H.memory('coding-experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'project-a/memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);

const builder = H.agent('builder')
  .role(builderRole)
  .model(builderModel)
  .pool(codingPool)
  .workspace(git.worktree({ repo: 'project-a', base: 'main' }))
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks));

const auditor = H.agent('auditor')
  .role(auditorRole)
  .model(opus)
  .pool(codingPool)
  .output(z.object({ deficits: z.array(z.string()) }));

const ticketSchema = z.object({ issueId: z.string(), title: z.string(), description: z.string() });

const Todo = H.state('Todo', 'pending');
const Building = H.state('Building', 'active');
const Done = H.terminal('Done', 'success');
const Abandoned = H.terminal('Abandoned', 'failure');
const Cancelled = H.terminal('Cancelled', 'neutral');

const Bug = H.kind('Bug')
  .attributes(ticketSchema)
  .states(Todo, Building, Done, Abandoned, Cancelled)
  .key((ticket) => ticket.issueId)
  .initial(Todo)
  .onAttemptFailed(Abandoned)
  .onCancelled(Cancelled);

const Feature = H.kind('Feature')
  .attributes(ticketSchema)
  .states(Todo, Building, Done, Abandoned, Cancelled)
  .key((ticket) => ticket.issueId)
  .initial(Todo)
  .onAttemptFailed(Abandoned)
  .onCancelled(Cancelled);

const buildAndAudit = H.flow('build-and-audit')
  .input(ticketSchema)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    (round) =>
      round
        .step('build', builder, (ctx) => ({ task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}` }))
        .step('audit', auditor, (ctx) => ({ task: `Audit the change for: ${ctx.unit.attributes.title}` })),
    { max: (ctx) => ctx.params.rounds, until: (ctx) => ctx.steps.audit.deficits.length === 0 },
  )
  .exit('done', (ctx) => ctx.steps.audit.deficits.length === 0)
  .exit('outOfRounds');

const linearStore = linear.store({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG' });
const linearStates = {
  Todo: 'Todo',
  Building: 'In Progress',
  Done: 'Done',
  Abandoned: 'Canceled',
  Cancelled: 'Canceled',
} as const satisfies Record<string, string>;

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['bug'] }), (issue, to) =>
    to.create({ issueId: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(folder.files({ path: 'project-a/bugs', glob: '*.md' }), (file, to) =>
    to.create({ issueId: file.path, title: file.name, description: file.body }),
  )
  .supply(H.operator)
  .store(linearStore, linearStates)
  .handler(buildAndAudit, {
    exits: { done: Done, outOfRounds: Abandoned },
    during: { build: Building, audit: Building },
    params: { rounds: 3 },
  });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['feature'] }), (issue, to) =>
    to.create({ issueId: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(H.operator)
  .store(linearStore, linearStates)
  .handler(buildAndAudit, {
    exits: { done: Done, outOfRounds: Abandoned },
    during: { build: Building, audit: Building },
    params: { rounds: 5 },
  });

export const codingTeam = H.harness('project-a')
  .ledger(sqlite.ledger({ path: 'project-a/state/ledger.sqlite', quotaPath: sharedQuotaPath }))
  .lanes(bugs, features)
  .corpora(ownerTaste, codingExperience)
  .scheduler(H.scheduler('project-a-scheduler').priority(bugs, features).wip(bugs, 2).boost(features, { afterMinutes: 240 }))
  .clients(ownerSupervisor)
  .observers(markdown.board({ path: 'project-a/BOARD.md' }), markdown.telemetry({ path: 'project-a/TELEMETRY.md' }));

const docsPool = H.pool('docs-pool')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, 0.3)
  .share(subscriptionTwo, 0.3)
  .share(subscriptionThree, 0.3)
  .drain(soonestExpiring);

const docsExperience = H.corpus('docs-experience', H.memory('docs-experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'project-b/memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 15 })
  .readBy(writerRole)
  .recordedBy(writerRole);

const writer = H.agent('writer')
  .role(writerRole)
  .model(sonnet)
  .pool(docsPool)
  .workspace(git.worktree({ repo: 'project-b', base: 'main' }));

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv((input) => ['npx', 'linkinator', input.path])
  .runner(localRunner);

const pageSchema = z.object({ path: z.string(), title: z.string(), body: z.string() });

const Stale = H.state('Stale', 'pending');
const Writing = H.state('Writing', 'active');
const Checking = H.state('Checking', 'active');
const Current = H.terminal('Current', 'success');
const WriteFailed = H.terminal('WriteFailed', 'failure');
const Dropped = H.terminal('Dropped', 'neutral');

const DocPage = H.kind('DocPage')
  .attributes(pageSchema)
  .states(Stale, Writing, Checking, Current, WriteFailed, Dropped)
  .key((page) => page.path)
  .initial(Stale)
  .onAttemptFailed(WriteFailed)
  .onCancelled(Dropped);

const docFlow = H.flow('doc-page')
  .input(pageSchema)
  .step('write', writer, (ctx) => ({ task: `Update ${ctx.unit.attributes.path}: ${ctx.unit.attributes.title}` }))
  .step('linkCheck', linkCheck, (ctx) => ({ path: ctx.unit.attributes.path }))
  .exit('current');

const docPages = H.lane('doc-pages', DocPage)
  .supply(folder.files({ path: 'project-b/docs', glob: '**/*.md' }), (file, to) =>
    to.create({ path: file.path, title: file.name, body: file.body }),
  )
  .store(folder.frontmatter({ path: 'project-b/docs' }))
  .handler(docFlow, {
    exits: { current: Current },
    during: { write: Writing, linkCheck: Checking },
  });

export const documentation = H.harness('project-b')
  .ledger(sqlite.ledger({ path: 'project-b/state/ledger.sqlite', quotaPath: sharedQuotaPath }))
  .lanes(docPages)
  .corpora(ownerTaste, docsExperience)
  .scheduler(H.scheduler('project-b-scheduler').priority(docPages))
  .clients(ownerSupervisor)
  .observers(markdown.board({ path: 'project-b/BOARD.md' }));
