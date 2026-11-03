import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Account } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const sharedQuota = sqlite.quota('../shared/account-quota.sqlite');

const max1 = claudeCode.subscription('max-1', { configDir: H.env('CLAUDE_MAX_1_DIR') });
const max2 = claudeCode.subscription('max-2', { configDir: H.env('CLAUDE_MAX_2_DIR') });
const max3 = claudeCode.subscription('max-3', { configDir: H.env('CLAUDE_MAX_3_DIR') });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const subscriptions: readonly Account[] = [max1, max2, max3];

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const soonestExpiring = H.policy.account(
  'soonest-expiring',
  (c) => [...c.eligible].sort((a, b) => a.windowEndsAt - b.windowEndsAt)[0] ?? null,
);

const subscriptionPool = (name: string, share: number) =>
  H.pool(name)
    .accounts(subscriptions.map((account) => ({ account, share })))
    .prefer(soonestExpiring)
    .fallback(apiAccount);

const specificThenProven = H.policy.recall('specific-then-proven', (c) =>
  [...c.candidates]
    .sort(
      (a, b) =>
        b.specificity - a.specificity ||
        b.track.succeeded / Math.max(1, b.track.present) - a.track.succeeded / Math.max(1, a.track.present),
    )
    .slice(0, c.limit),
);

const ownerTaste = H.memory.taste('owner-taste');
const sharedTaste = H.playbook('owner-taste', ownerTaste)
  .store(jsonl.memory('../shared/owner-taste.jsonl'))
  .recall(specificThenProven);

const todo = H.state('todo', 'pending');
const inProgress = H.state('inProgress', 'active');
const done = H.state('done', 'terminal', 'success');
const stalled = H.state('stalled', 'waiting');

const issueShape = { issue: z.string(), title: z.string(), description: z.string() };

const Bug = H.work('bug').attributes(issueShape).states([todo, inProgress, done, stalled]).key((u) => u.attributes.issue);
const Feature = H.work('feature').attributes(issueShape).states([todo, inProgress, done, stalled]).key((u) => u.attributes.issue);
const Epic = H.work('epic').attributes(issueShape).states([todo, inProgress, done, stalled]).key((u) => u.attributes.issue);

const codingExperience = H.memory.experience('coding-experience');
const codingLessons = H.playbook('coding-lessons', codingExperience)
  .store(jsonl.memory('memory/coding-lessons.jsonl'))
  .recall(specificThenProven);

const builderModel = H.policy.model('cheap-until-proven-weak', [sonnet, opus], (c) => {
  const cheap = c.metrics.success({ kind: c.unit?.kind, model: sonnet, window: { days: 14 } });
  return cheap.n >= 20 && cheap.rate !== null && cheap.rate < 0.85 ? opus : sonnet;
});

const codingPool = subscriptionPool('coding-subscriptions', 0.6);

const builder = H.agent(
  'builder',
  H.role('builder')
    .intents(['read', 'write', 'execute', 'ask'])
    .instructions('Implement the task. Address every listed deficit.')
    .input({ task: z.string(), deficits: z.array(z.string()) })
    .output({ summary: z.string() }),
)
  .model(builderModel)
  .pool(codingPool)
  .recalls([sharedTaste, codingLessons])
  .leaseWrites()
  .mustPass(H.command('project-checks', ['npm', 'run', 'check']));

const auditor = H.agent(
  'auditor',
  H.role('auditor')
    .intents(['read', 'execute', 'remember'])
    .instructions('List every deficit in the change. An empty list means it is ready.')
    .input({ task: z.string(), summary: z.string() })
    .output({ deficits: z.array(z.string()) }),
)
  .model(opus)
  .pool(codingPool)
  .recalls([codingLessons])
  .records(codingLessons);

const planner = H.agent(
  'planner',
  H.role('planner')
    .intents(['read'])
    .instructions('Decompose the epic into independently shippable features.')
    .input({ task: z.string() })
    .output({ features: z.array(z.object(issueShape)) }),
)
  .model(opus)
  .pool(codingPool)
  .recalls([sharedTaste]);

const buildAndAudit = H.flow('build-and-audit')
  .requires({ title: z.string(), description: z.string() })
  .params({ rounds: z.number() })
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: (c) => c.params.rounds },
    (round) =>
      round
        .step('build', builder, (c) => ({
          task: `${c.input.title}\n\n${c.input.description}`,
          deficits: c.carry ? c.carry.deficits : [],
        }))
        .step('audit', auditor, (c) => ({ task: c.input.title, summary: c.out.build.summary })),
    (last) => (last.audit.deficits.length > 0 ? { deficits: last.audit.deficits } : null),
  )
  .ends(['done', 'unfinished'], (c) => (c.out.rounds.last.audit.deficits.length === 0 ? 'done' : 'unfinished'));

const decompose = H.flow('decompose-epic')
  .requires({ title: z.string(), description: z.string() })
  .step('plan', planner, (c) => ({ task: `${c.input.title}\n\n${c.input.description}` }))
  .spawn('features', { child: issueShape, items: (c) => c.out.plan.features })
  .ends(['done', 'partial'], (c) => (c.out.features.every((f) => f.verdict === 'success') ? 'done' : 'partial'));

const tracker = { apiKey: H.env('LINEAR_API_KEY'), team: 'PROD' };
const trackerStatus = { todo: 'Todo', inProgress: 'In Progress', done: 'Done', stalled: 'Blocked' };

const bugs = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { ...tracker, labels: ['bug'] }, (issue, supply) =>
      supply.create({ attributes: { issue: issue.identifier, title: issue.title, description: issue.description } }),
    ),
    folder.files(Bug, 'bugs', (file, supply) =>
      supply.create({
        attributes: { issue: file.path, title: String(file.frontmatter['title'] ?? file.path), description: file.body },
      }),
    ),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { ...tracker, status: trackerStatus }))
  .runner(git.worktree({ repo: '.', base: 'main', slots: 3 }))
  .wip(2)
  .retry(H.retry.exponential({ maxRetries: 2, initialDelayMs: 60_000 }))
  .handler(buildAndAudit, { opens: inProgress, ends: { done, unfinished: stalled }, exhausted: stalled, params: { rounds: 3 } });

const features = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { ...tracker, labels: ['feature'] }, (issue, supply) =>
      supply.create({ attributes: { issue: issue.identifier, title: issue.title, description: issue.description } }),
    ),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { ...tracker, status: trackerStatus }))
  .runner(git.worktree({ repo: '.', base: 'main', slots: 3 }))
  .retry(H.retry.exponential({ maxRetries: 2, initialDelayMs: 60_000 }))
  .handler(buildAndAudit, { opens: inProgress, ends: { done, unfinished: stalled }, exhausted: stalled, params: { rounds: 5 } });

const epics = H.lane('epics', Epic)
  .supply([
    linear.issues(Epic, { ...tracker, labels: ['epic'] }, (issue, supply) =>
      supply.create({ attributes: { issue: issue.identifier, title: issue.title, description: issue.description } }),
    ),
  ])
  .store(linear.store(Epic, { ...tracker, status: trackerStatus }))
  .wip(1)
  .handler(decompose, {
    opens: inProgress,
    ends: { done, partial: stalled },
    exhausted: stalled,
    spawns: { features: (child) => features.unit({ attributes: child }) },
  });

const ownerAccess = H.access('owner').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.sendEvents,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.writeMemory,
  H.ops.curateMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
]);

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('coding/ledger.sqlite', { quota: sharedQuota }))
  .lanes([bugs, features, epics])
  .schedule(
    H.policy.schedule('bugs-features-epics', (c) => ({
      start: c.order(
        (x) => (x.is(bugs) ? 0 : x.is(features) ? (x.waitedMs > 7_200_000 ? 0 : 1) : 2),
        (x) => x.enqueuedAt,
      ),
    })),
  )
  .clients([claudeCode.supervisor('owner-coding', ownerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('coding/board.md'), markdown.telemetry('coding/telemetry.md')]);

const draft = H.state('draft', 'pending');
const writing = H.state('writing', 'active');
const published = H.state('published', 'terminal', 'success');

const DocPage = H.work('doc-page')
  .attributes({ path: z.string(), title: z.string() })
  .states([draft, writing, published, stalled])
  .key((u) => u.attributes.path);

const docsExperience = H.memory.experience('docs-experience');
const docsLessons = H.playbook('docs-lessons', docsExperience)
  .store(jsonl.memory('docs-memory/lessons.jsonl'))
  .recall(specificThenProven);

const writer = H.agent(
  'writer',
  H.role('writer')
    .intents(['read', 'write', 'remember'])
    .instructions('Write or revise the page so it is accurate, complete and in house style.')
    .input({ path: z.string(), title: z.string() })
    .output({ summary: z.string() }),
)
  .model(sonnet)
  .pool(subscriptionPool('docs-subscriptions', 0.3))
  .recalls([sharedTaste, docsLessons])
  .records(docsLessons);

const linkCheck = H.command('link-check', ['npx', 'linkinator']);

const writePage = H.flow('write-page')
  .requires({ path: z.string(), title: z.string() })
  .step('write', writer, (c) => ({ path: c.input.path, title: c.input.title }))
  .step('links', linkCheck, (c) => ({ args: [c.input.path] }), { restart: 'rerun' })
  .ends(['published'], () => 'published');

const docPages = H.lane('doc-pages', DocPage)
  .supply([
    folder.files(DocPage, 'docs', (file, supply) =>
      supply.create({ attributes: { path: file.path, title: String(file.frontmatter['title'] ?? file.path) } }),
    ),
  ])
  .store(folder.frontmatter(DocPage, 'docs'))
  .runner(local.shell({ slots: 2, cwd: 'docs' }))
  .retry(H.retry.fixed({ maxRetries: 1, delayMs: 300_000 }))
  .handler(writePage, { opens: writing, ends: { published }, exhausted: stalled });

export const documentation = H.harness('documentation')
  .ledger(sqlite.ledger('docs/ledger.sqlite', { quota: sharedQuota }))
  .lanes([docPages])
  .schedule(H.policy.schedule('oldest-first', (c) => ({ start: c.order((x) => x.enqueuedAt) })))
  .clients([claudeCode.supervisor('owner-docs', ownerAccess, { port: H.slot.port(1) })])
  .projections([markdown.board('docs/board.md'), markdown.telemetry('docs/telemetry.md')]);
