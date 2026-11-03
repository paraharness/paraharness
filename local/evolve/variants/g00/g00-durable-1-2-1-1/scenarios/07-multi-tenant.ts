import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const sharedQuota = sqlite.quota('~/.harness/shared-quota.sqlite');

const claudeOne = claudeCode.subscription('claude-one', { configDir: H.env('CLAUDE_ONE_CONFIG') });
const claudeTwo = claudeCode.subscription('claude-two', { configDir: H.env('CLAUDE_TWO_CONFIG') });
const claudeThree = claudeCode.subscription('claude-three', { configDir: H.env('CLAUDE_THREE_CONFIG') });

const soonestReset = H.policy.account('soonest-reset-first', (c) =>
  [...c.eligible].sort((a, b) => a.windowEndsAt - b.windowEndsAt)[0] ?? null,
);

function subscriptionPool(name: string, share: number) {
  return H.pool(name)
    .accounts([
      { account: claudeOne, share },
      { account: claudeTwo, share },
      { account: claudeThree, share },
    ])
    .prefer(soonestReset);
}

const mostSpecific = H.policy.recall('most-specific-first', (c) =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const ownerTaste = H.memory.taste('owner-taste');
const ownerTasteJournal = H.journal('owner-taste-journal', ownerTaste)
  .store(jsonl.memory('~/.harness/owner-taste.jsonl'))
  .recall(mostSpecific);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const ownerAccess = H.access('owner').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.resolveBlocks,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
]);

const Todo = H.state('Todo', 'pending');
const Building = H.state('Building', 'active');
const AwaitingOwner = H.state('AwaitingOwner', 'waiting');
const Done = H.state('Done', 'terminal', 'success');
const Abandoned = H.state('Abandoned', 'terminal', 'failure');

const Bug = H.work('Bug')
  .attributes({ identifier: z.string(), title: z.string() })
  .fields({ description: z.string() })
  .states([Todo, Building, AwaitingOwner, Done, Abandoned])
  .key((u) => u.attributes.identifier);
const Feature = H.work('Feature')
  .attributes({ identifier: z.string(), title: z.string() })
  .fields({ description: z.string() })
  .states([Todo, Building, AwaitingOwner, Done, Abandoned])
  .key((u) => u.attributes.identifier);

const codingExperienceJournal = H.journal('coding-experience-journal', H.memory.experience('coding-experience'))
  .store(jsonl.memory('coding/.harness/experience.jsonl'))
  .recall(mostSpecific);

const codingPool = subscriptionPool('coding-pool', 0.6);

const builderModel = H.policy.model('builder-model', [sonnet, opus], (c) => {
  const cheap = c.metrics.success({ model: sonnet, window: { days: 14 } });
  return cheap.n >= 20 && cheap.rate !== null && cheap.rate < 0.85 ? opus : sonnet;
});

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'ask'])
  .instructions('Implement the task. Address every listed deficit.')
  .input({ task: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });
const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'remember'])
  .instructions('List every deficit remaining in the change. An empty list means done.')
  .input({ task: z.string(), summary: z.string() })
  .output({ deficits: z.array(z.string()) });

const projectChecks = H.command('project-checks', ['npm', 'run', 'check']);

const builder = H.agent('builder-agent', builderRole)
  .model(builderModel)
  .pool(codingPool)
  .recalls([codingExperienceJournal, ownerTasteJournal])
  .leaseWrites()
  .mustPass(projectChecks);
const auditor = H.agent('auditor-agent', auditorRole)
  .model(sonnet)
  .pool(codingPool)
  .recalls([codingExperienceJournal])
  .records(codingExperienceJournal);

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
          deficits: c.carry === null ? [] : c.carry.deficits,
        }))
        .step('audit', auditor, (c) => ({ task: c.input.title, summary: c.out.build.summary })),
    (last) => (last.audit.deficits.length === 0 ? null : { deficits: last.audit.deficits }),
  )
  .ends(['done', 'abandoned'], (c) => (c.out.rounds.last.audit.deficits.length === 0 ? 'done' : 'abandoned'));

const linearAuth = { apiKey: H.env('LINEAR_API_KEY'), team: 'ENG' };
const linearStatus = { Todo: 'Todo', Building: 'In Progress', AwaitingOwner: 'Blocked', Done: 'Done', Abandoned: 'Canceled' };
const worktrees = git.worktree({ repo: '.', base: 'main', slots: 3 });

const bugs = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { ...linearAuth, labels: ['bug'] }, (issue, s) =>
      s.create({ attributes: { identifier: issue.identifier, title: issue.title }, fields: { description: issue.description } }),
    ),
    folder.files(Bug, 'bugs', (file, s) =>
      s.create({
        attributes: { identifier: file.path, title: String(file.frontmatter.title ?? file.path) },
        fields: { description: file.body },
      }),
    ),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { ...linearAuth, status: linearStatus }))
  .runner(worktrees)
  .wip(2)
  .handler(buildAndAudit, {
    opens: Building,
    blocked: AwaitingOwner,
    params: { rounds: 3 },
    states: { build: Building, audit: Building, done: Done, abandoned: Abandoned },
  });

const features = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { ...linearAuth, labels: ['feature'] }, (issue, s) =>
      s.create({ attributes: { identifier: issue.identifier, title: issue.title }, fields: { description: issue.description } }),
    ),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { ...linearAuth, status: linearStatus }))
  .runner(worktrees)
  .handler(buildAndAudit, {
    opens: Building,
    blocked: AwaitingOwner,
    params: { rounds: 5 },
    states: { build: Building, audit: Building, done: Done, abandoned: Abandoned },
  });

const codingSchedule = H.policy.schedule('bugs-then-features-with-aging', (c) => ({
  start: c.order(
    (x) => (x.is(bugs) ? 0 : x.waitedMs > 6 * 60 * 60 * 1000 ? 0 : 1),
    (x) => -x.waitedMs,
  ),
}));

export const coding = H.harness('coding-team')
  .ledger(sqlite.ledger('coding/.harness/ledger.sqlite', { quota: sharedQuota }))
  .lanes([bugs, features])
  .schedule(codingSchedule)
  .clients([claudeCode.supervisor('coding-supervisor', ownerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('coding/BOARD.md'), markdown.telemetry('coding/TELEMETRY.md')]);

const DocQueued = H.state('DocQueued', 'pending');
const Writing = H.state('Writing', 'active');
const Published = H.state('Published', 'terminal', 'success');
const LinkBroken = H.state('LinkBroken', 'terminal', 'failure');

const DocPage = H.work('DocPage')
  .attributes({ path: z.string() })
  .fields({ title: z.string(), body: z.string() })
  .states([DocQueued, Writing, Published, LinkBroken])
  .failsTo(LinkBroken)
  .key((u) => u.attributes.path);

const docsExperienceJournal = H.journal('docs-experience-journal', H.memory.experience('docs-experience'))
  .store(jsonl.memory('docs/.harness/experience.jsonl'))
  .recall(mostSpecific);

const writerRole = H.role('writer')
  .intents(['read', 'write'])
  .instructions('Rewrite the page so it is accurate, short and linked.')
  .input({ path: z.string(), title: z.string(), body: z.string() })
  .output({ body: z.string() });

const writer = H.agent('writer-agent', writerRole)
  .model(sonnet)
  .pool(subscriptionPool('docs-pool', 0.3))
  .recalls([docsExperienceJournal, ownerTasteJournal])
  .records(docsExperienceJournal);

const linkCheck = H.command('link-check', ['npx', 'linkinator', '--stdin']);

const writeAndCheck = H.flow('write-and-check')
  .requires({ path: z.string(), title: z.string(), body: z.string() })
  .step('write', writer, (c) => ({ path: c.input.path, title: c.input.title, body: c.input.body }))
  .step('linkCheck', linkCheck, (c) => ({ stdin: c.out.write.body }))
  .ends(['published'], () => 'published');

const docPages = H.lane('doc-pages', DocPage)
  .supply([
    folder.files(DocPage, 'docs', (file, s) =>
      s.create({
        attributes: { path: file.path },
        fields: { title: String(file.frontmatter.title ?? file.path), body: file.body },
      }),
    ),
  ])
  .store(folder.frontmatter(DocPage, 'docs'))
  .runner(local.shell({ slots: 2, cwd: 'docs' }))
  .retry(H.retry.fixed({ maxRetries: 2, delayMs: 60_000 }))
  .handler(writeAndCheck, {
    opens: Writing,
    states: { write: Writing, published: Published },
  });

export const docs = H.harness('documentation')
  .ledger(sqlite.ledger('docs/.harness/ledger.sqlite', { quota: sharedQuota }))
  .lanes([docPages])
  .clients([claudeCode.supervisor('docs-supervisor', ownerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('docs/BOARD.md'), markdown.telemetry('docs/TELEMETRY.md')]);

export const runningCoding = coding.start();
export const runningDocs = docs.start();
