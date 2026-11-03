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

const ownerQuota = sqlite.quota('owner-subscriptions', { path: '/home/owner/.harness/quota.sqlite' });

const subscriptionOne = claudeCode.subscription('claude-one', { token: H.env('CLAUDE_ONE_TOKEN'), quota: ownerQuota });
const subscriptionTwo = claudeCode.subscription('claude-two', { token: H.env('CLAUDE_TWO_TOKEN'), quota: ownerQuota });
const subscriptionThree = claudeCode.subscription('claude-three', { token: H.env('CLAUDE_THREE_TOKEN'), quota: ownerQuota });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: ownerQuota });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  ctx.candidates
    .filter(c => c.cooldownUntil === undefined || c.cooldownUntil.getTime() <= ctx.now.getTime())
    .filter(c => c.shareUsed < c.shareCap)
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const ownerTaste = H.memory('taste', 'taste');
const experience = H.memory('experience', 'experience');

const builderRole = H.role('builder').intents('read', 'edit', 'run', 'search', 'halt').instructions('Implement the work item in the worktree.');
const auditorRole = H.role('auditor').intents('read', 'search', 'record').instructions('List every deficit of the change; an empty list means done.');
const writerRole = H.role('writer').intents('read', 'edit').instructions('Bring the documentation page up to date.');

const sharedTasteJournal = H.journal('owner-taste', ownerTaste)
  .store(jsonl.memoryStore({ path: '/home/owner/.harness/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builderRole, auditorRole, writerRole);

const codingPool = H.pool('coding-pool')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, 0.6)
  .share(subscriptionTwo, 0.6)
  .share(subscriptionThree, 0.6)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const docsPool = H.pool('docs-pool')
  .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
  .share(subscriptionOne, 0.3)
  .share(subscriptionTwo, 0.3)
  .share(subscriptionThree, 0.3)
  .drain(soonestExpiring);

const localRunner = local.runner('local');

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);

const worktree = git.worktree({ repo: '/home/owner/code/product', base: 'main' })
  .guard({ exclusiveWrites: true, beforeStop: projectChecks });

const ownerDecision = H.halt('owner-decision').decision(z.object({ choice: z.string(), note: z.string() }));

const builderModel = H.policy.model('builder-model', [sonnet, opus], ctx => {
  const record = ctx.metrics.outcomes({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return record.samples < 20 || record.successRate >= 0.85 ? sonnet : opus;
});

const builder = H.seat('builder').role(builderRole).model(builderModel).pool(codingPool).workspace(worktree).halts(ownerDecision);
const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(opus)
  .pool(codingPool)
  .output(z.object({ deficits: z.array(z.string()) }));

const codingExperience = H.journal('coding-experience', experience)
  .store(jsonl.memoryStore({ path: '/home/owner/code/product/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 6 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const trackedIssue = z.object({ issueId: z.string(), title: z.string(), description: z.string() });

const Open = H.state('open', 'pending');
const Done = H.terminal('done', 'success');
const Failed = H.terminal('failed', 'failure');

const bug = H.kind('Bug').attributes(trackedIssue).states(Open, Done, Failed).key(a => a.issueId).initial(Open);
const feature = H.kind('Feature').attributes(trackedIssue).states(Open, Done, Failed).key(a => a.issueId).initial(Open);

const buildAndAudit = H.flow('build-and-audit')
  .input(trackedIssue)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    round => round
      .step('build', builder, ctx => ({ task: `Implement ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}` }))
      .step('audit', auditor, ctx => ({ task: `Audit the change for ${ctx.unit.attributes.title}. Builder report:\n${ctx.steps.build}` })),
    { max: ctx => ctx.params.rounds, until: ctx => ctx.steps.audit.deficits.length === 0 },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('roundsExhausted');

const tracker = linear.store({ apiKey: H.env('LINEAR_API_KEY'), team: 'PRD', workflow: ['Todo', 'In Progress', 'Done', 'Canceled'] });
const trackerMap = { states: { open: 'Todo', done: 'Done', failed: 'Canceled' }, inFlight: 'In Progress' } as const;

const bugs = H.lane('bugs', bug)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PRD', labels: ['bug'] }), (issue, to) =>
    to.create({ issueId: issue.identifier, title: issue.title, description: issue.description }))
  .supply(folder.files({ path: '/home/owner/code/product/bugs', glob: '*.md' }), (file, to) =>
    to.create({ issueId: file.name, title: file.name, description: file.body }))
  .supply(H.operator)
  .store(tracker, trackerMap)
  .handler(buildAndAudit, { exits: { clean: Done, roundsExhausted: Failed }, params: { rounds: 3 } })
  .retry({ maxAttempts: 2, exhausted: Failed });

const features = H.lane('features', feature)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PRD', labels: ['feature'] }), (issue, to) =>
    to.create({ issueId: issue.identifier, title: issue.title, description: issue.description }))
  .supply(H.operator)
  .store(tracker, trackerMap)
  .handler(buildAndAudit, { exits: { clean: Done, roundsExhausted: Failed }, params: { rounds: 5 } })
  .retry({ maxAttempts: 2, exhausted: Failed });

const codingSupervisor = claudeCode.supervisor('coding-supervisor', {
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
});

export const coding = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '/home/owner/code/product/.harness/ledger.sqlite' }))
  .lanes(bugs, features)
  .journals(sharedTasteJournal, codingExperience)
  .scheduler(H.scheduler('coding-scheduler').standard(bugs, features).wip(bugs, 2).aging(features, { afterMinutes: 240 }))
  .clients(codingSupervisor)
  .observers(
    markdown.board({ path: '/home/owner/code/product/.harness/board.md' }),
    markdown.telemetry({ path: '/home/owner/code/product/.harness/telemetry.md' }),
  );

const docAttrs = z.object({ path: z.string(), title: z.string(), body: z.string() });

const Stale = H.state('stale', 'pending');
const Published = H.terminal('published', 'success');
const Broken = H.terminal('broken', 'failure');

const docPage = H.kind('DocPage').attributes(docAttrs).states(Stale, Published, Broken).key(a => a.path).initial(Stale);

const writer = H.seat('writer').role(writerRole).model(sonnet).pool(docsPool);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(i => ['npx', 'linkinator', i.path])
  .runner(localRunner);

const writePage = H.flow('write-page')
  .input(docAttrs)
  .step('write', writer, ctx => ({ task: `Update ${ctx.unit.attributes.path}:\n${ctx.unit.attributes.body}` }))
  .step('linkCheck', linkCheck, ctx => ({ path: ctx.unit.attributes.path }))
  .exit('published');

const docsDocs = H.lane('doc-pages', docPage)
  .supply(folder.files({ path: '/home/owner/code/docs/pages', glob: '**/*.md' }), (file, to) =>
    to.create({ path: file.path, title: file.name, body: file.body }))
  .store(folder.frontmatter({ path: '/home/owner/code/docs/pages' }))
  .handler(writePage, { exits: { published: Published } })
  .retry({ maxAttempts: 2, exhausted: Broken });

const docsExperience = H.journal('docs-experience', experience)
  .store(jsonl.memoryStore({ path: '/home/owner/code/docs/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 6 })
  .readBy(writerRole)
  .recordedBy(writerRole);

const docsSupervisor = claudeCode.supervisor('docs-supervisor', {
  port: H.slot.port(2),
  grants: [H.ops.workRead, H.ops.workCreate, H.ops.memoryWrite, H.ops.telemetryRead, H.ops.accountsRead, H.ops.accountsShare],
});

export const docs = H.harness('documentation')
  .ledger(sqlite.ledger({ path: '/home/owner/code/docs/.harness/ledger.sqlite' }))
  .lanes(docsDocs)
  .journals(sharedTasteJournal, docsExperience)
  .scheduler(H.scheduler('docs-scheduler').standard(docsDocs).wip(docsDocs, 2))
  .clients(docsSupervisor)
  .observers(markdown.board({ path: '/home/owner/code/docs/.harness/board.md' }));

export const ownerSession = claudeCode.session('owner-session', { endpoints: [codingSupervisor, docsSupervisor] });
