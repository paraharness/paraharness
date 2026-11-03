import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const sharedQuota = '/home/owner/.harness/quota.sqlite';

const subscriptionOne = claude.subscription('claude-max-1', { configDir: H.env('CLAUDE_DIR_1') });
const subscriptionTwo = claude.subscription('claude-max-2', { configDir: H.env('CLAUDE_DIR_2') });
const subscriptionThree = claude.subscription('claude-max-3', { configDir: H.env('CLAUDE_DIR_3') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const sonnet = claude.model('claude-sonnet-4');
const opus = claude.model('claude-opus-4');

const soonestExpiring = H.policy.account('soonest-expiring', (c) =>
  [...c.eligible].sort((a, b) => a.windowEndsAt - b.windowEndsAt)[0] ?? null,
);

const ranked = H.policy.recall('specific-then-proven', (c) =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const ownerTaste = H.memory.taste('owner-taste');
const sharedTasteJournal = H.journal('owner-taste', ownerTaste)
  .store(jsonl.memory('/home/owner/.harness/taste.jsonl'))
  .recall(ranked);

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
const Done = H.state('Done', 'terminal', 'success');
const Abandoned = H.state('Abandoned', 'terminal', 'failure');

const Bug = H.work('Bug')
  .attributes({ identifier: z.string(), title: z.string() })
  .fields({ description: z.string() })
  .states([Todo, Building, Done, Abandoned])
  .key((unit) => unit.attributes.identifier);

const Feature = H.work('Feature')
  .attributes({ identifier: z.string(), title: z.string() })
  .fields({ description: z.string() })
  .states([Todo, Building, Done, Abandoned])
  .key((unit) => unit.attributes.identifier);

const linearConnection = { apiKey: H.env('LINEAR_API_KEY'), team: 'PRODUCT' };

const codingExperience = H.memory.experience('coding-experience');
const codingExperienceJournal = H.journal('coding-experience', codingExperience)
  .store(jsonl.memory('memory/coding-experience.jsonl'))
  .recall(ranked);

const codingPool = H.pool('coding-pool')
  .accounts([
    { account: subscriptionOne, share: 0.6 },
    { account: subscriptionTwo, share: 0.6 },
    { account: subscriptionThree, share: 0.6 },
  ])
  .prefer(soonestExpiring)
  .fallback(apiAccount);

const builderModel = H.policy.model('builder-model', [sonnet, opus], (c) => {
  const cheap = c.metrics.success({ kind: c.unit?.kind ?? 'Bug', model: sonnet, window: { days: 14 } });
  return cheap.n >= 20 && cheap.rate !== null && cheap.rate < 0.85 ? opus : sonnet;
});

const projectChecks = H.command('project-checks', ['pnpm', 'run', 'check']);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'search', 'ask'])
  .instructions('Implement the task. Resolve every listed deficit. Ask the owner when a decision is theirs.')
  .input({ task: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });

const auditorRole = H.role('auditor')
  .intents(['read', 'search', 'remember'])
  .instructions('List every deficit in the change against the task. An empty list means done.')
  .input({ task: z.string(), summary: z.string() })
  .output({ deficits: z.array(z.string()) });

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(codingPool)
  .recalls([codingExperienceJournal, sharedTasteJournal])
  .leaseWrites()
  .mustPass(projectChecks);

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .pool(codingPool)
  .recalls([codingExperienceJournal])
  .records(codingExperienceJournal);

const ticketFlow = H.flow('ticket')
  .requires({ title: z.string(), description: z.string() })
  .params({ rounds: z.number() })
  .mark('building')
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: (c) => c.params.rounds },
    (round) =>
      round
        .step('build', builder, (c) => ({
          task: `${c.input.title}\n\n${c.input.description}`,
          deficits: c.carry?.deficits ?? [],
        }))
        .step('audit', auditor, (c) => ({ task: c.input.title, summary: c.out.build.summary })),
    (last) => (last.audit.deficits.length > 0 ? { deficits: last.audit.deficits } : null),
  )
  .ends(['done', 'abandoned'], (c) => (c.out.rounds.exhausted ? 'abandoned' : 'done'));

const ticketStates = { building: Building, done: Done, abandoned: Abandoned, failed: Abandoned };
const worktrees = git.worktree({ repo: '.', base: 'main', slots: 3 });
const linearStatus = { Todo: 'Todo', Building: 'In Progress', Done: 'Done', Abandoned: 'Canceled' };

const bugs = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { ...linearConnection, labels: ['bug'] }, (issue) => ({
      attributes: { identifier: issue.identifier, title: issue.title },
      fields: { description: issue.description },
    })),
    folder.files(Bug, 'inbox/bugs', (file) => ({
      attributes: { identifier: file.path, title: file.body.split('\n')[0] ?? file.path },
      fields: { description: file.body },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { ...linearConnection, status: linearStatus }))
  .handler(ticketFlow, { states: ticketStates, params: { rounds: 3 } })
  .runner(worktrees)
  .wip(2);

const features = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { ...linearConnection, labels: ['feature'] }, (issue) => ({
      attributes: { identifier: issue.identifier, title: issue.title },
      fields: { description: issue.description },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { ...linearConnection, status: linearStatus }))
  .handler(ticketFlow, { states: ticketStates, params: { rounds: 5 } })
  .runner(worktrees);

export const codingHarness = H.harness('coding-team')
  .ledger(sqlite.ledger('coding-ledger.sqlite', { quotaPath: sharedQuota }))
  .lanes([bugs, features])
  .schedule(H.policy.schedule('bugs-then-features', (c) => ({
    start: [...c.candidates].sort((a, b) => {
      const rank = (x: typeof a) => (x.is(bugs) ? 0 : x.waitedMs > 86_400_000 ? 0 : 1);
      return rank(a) - rank(b) || b.waitedMs - a.waitedMs;
    }),
  })))
  .clients([claude.supervisor('coding-supervisor', ownerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('coding/BOARD.md'), markdown.telemetry('coding/TELEMETRY.md')]);

const Found = H.state('Found', 'pending');
const Writing = H.state('Writing', 'active');
const Published = H.state('Published', 'terminal', 'success');
const BrokenLinks = H.state('BrokenLinks', 'terminal', 'failure');
const WriteFailed = H.state('WriteFailed', 'terminal', 'failure');

const DocPage = H.work('DocPage')
  .attributes({ path: z.string(), title: z.string() })
  .fields({ body: z.string() })
  .states([Found, Writing, Published, BrokenLinks, WriteFailed])
  .key((unit) => unit.attributes.path);

const docsExperience = H.memory.experience('docs-experience');
const docsExperienceJournal = H.journal('docs-experience', docsExperience)
  .store(jsonl.memory('memory/docs-experience.jsonl'))
  .recall(ranked);

const docsPool = H.pool('docs-pool')
  .accounts([
    { account: subscriptionOne, share: 0.3 },
    { account: subscriptionTwo, share: 0.3 },
    { account: subscriptionThree, share: 0.3 },
  ])
  .prefer(soonestExpiring);

const writerRole = H.role('writer')
  .intents(['read', 'write', 'remember'])
  .instructions('Rewrite the page so it is accurate, complete and in the owner style.')
  .input({ path: z.string(), title: z.string(), body: z.string() })
  .output({ body: z.string() });

const writer = H.agent('writer', writerRole)
  .model(sonnet)
  .pool(docsPool)
  .recalls([docsExperienceJournal, sharedTasteJournal])
  .records(docsExperienceJournal);

const linkCheck = H.command('link-check', ['npx', 'linkinator']);

const docFlow = H.flow('doc-page')
  .requires({ path: z.string(), title: z.string(), body: z.string() })
  .mark('writing')
  .step('write', writer, (c) => ({ path: c.input.path, title: c.input.title, body: c.input.body }))
  .step('links', linkCheck, (c) => ({ args: [c.input.path] }), { onRestart: 'rerun' })
  .ends(['published', 'broken'], (c) => (c.out.links.exitCode === 0 ? 'published' : 'broken'));

const docPages = H.lane('doc-pages', DocPage)
  .supply([
    folder.files(DocPage, 'docs', (file) => {
      const title = file.frontmatter['title'];
      return {
        attributes: { path: file.path, title: typeof title === 'string' ? title : file.path },
        fields: { body: file.body },
      };
    }),
  ])
  .store(folder.frontmatter(DocPage, 'docs'))
  .handler(docFlow, {
    states: { writing: Writing, published: Published, broken: BrokenLinks, failed: WriteFailed },
  })
  .runner(local.shell({ slots: 2, cwd: '.' }))
  .wip(2);

export const docsHarness = H.harness('documentation')
  .ledger(sqlite.ledger('docs-ledger.sqlite', { quotaPath: sharedQuota }))
  .lanes([docPages])
  .schedule(H.policy.schedule('oldest-first', (c) => ({
    start: [...c.candidates].sort((a, b) => b.waitedMs - a.waitedMs),
  })))
  .clients([claude.supervisor('docs-supervisor', ownerAccess, { port: H.slot.port(1) })])
  .projections([markdown.board('docs/BOARD.md'), markdown.telemetry('docs/TELEMETRY.md')]);
