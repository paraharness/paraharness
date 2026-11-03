import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Model } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const sharedAccountState = sqlite.quota('~/.harness/shared/accounts.db');

const subscriptionA = claudeCode.subscription('claude-max-a', { configDir: H.env('CLAUDE_CONFIG_A'), quota: sharedAccountState });
const subscriptionB = claudeCode.subscription('claude-max-b', { configDir: H.env('CLAUDE_CONFIG_B'), quota: sharedAccountState });
const subscriptionC = claudeCode.subscription('claude-max-c', { configDir: H.env('CLAUDE_CONFIG_C'), quota: sharedAccountState });

const soonestExpiring = H.policy.account('soonest-expiring-window', c =>
  [...c.eligible]
    .filter(account => account.eligible && account.harnessUtilization < account.share)
    .sort((a, b) => a.windowEndsAt - b.windowEndsAt)[0] ?? null,
);

const sharedSubscriptions = (name: string, share: number) =>
  H.pool(name)
    .accounts([
      { account: subscriptionA, share },
      { account: subscriptionB, share },
      { account: subscriptionC, share },
    ])
    .prefer(soonestExpiring);

const specificThenProven = H.policy.recall('specific-then-proven', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const OwnerTaste = H.memory.taste('owner-taste');
const ownerTaste = H.journal('owner-taste-journal', OwnerTaste)
  .store(jsonl.memory('~/.harness/shared/taste.jsonl'))
  .recall(specificThenProven);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const Queued = H.state('queued', 'pending');
const InProgress = H.state('in progress', 'active');
const Done = H.state('done', 'succeeded');
const Abandoned = H.state('abandoned', 'failed');

const ownerAccess = H.access('owner').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.signalWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
]);

const Bug = H.work('Bug')
  .attributes({ priority: z.number() })
  .fields({ title: z.string(), description: z.string() })
  .states([Queued, InProgress, Done, Abandoned]);

const ProductExperience = H.memory.experience('product-experience');
const productExperience = H.journal('product-experience-journal', ProductExperience)
  .store(jsonl.memory('product/.harness/experience.jsonl'))
  .recall(specificThenProven);

const productPool = sharedSubscriptions('product-subscriptions', 0.6);

const builderModel = H.policy.model('builder-model', [sonnet, opus], (c): Model => {
  const cheaper = c.metrics.success({ kind: Bug.name, model: sonnet, windowDays: 14 });
  return cheaper.n >= 20 && cheaper.rate !== null && cheaper.rate < 0.85 ? opus : sonnet;
});

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'ask'])
  .input({ task: z.string(), details: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string(), files: z.array(z.string()) });
const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'remember'])
  .input({ task: z.string(), summary: z.string() })
  .output({ deficits: z.array(z.string()) });

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(productPool)
  .recalls([productExperience, ownerTaste])
  .leaseWrites()
  .mustPass(H.command('project-checks', ['npm', 'run', 'check']));
const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .pool(productPool)
  .recalls([productExperience])
  .records(productExperience);

const deliveryFlow = H.flow('delivery')
  .requires({ title: z.string(), description: z.string() })
  .params({ rounds: z.number() })
  .mark('building')
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: c => c.params.rounds },
    round => round
      .step('build', builder, c => ({ task: c.input.title, details: c.input.description, deficits: c.carry ? c.carry.deficits : [] }))
      .step('audit', auditor, c => ({ task: c.input.title, summary: c.out.build.summary })),
    last => (last.audit.deficits.length === 0 ? null : { deficits: last.audit.deficits }),
  )
  .ends(['shipped', 'gaveUp'], c => (c.out.rounds.last.audit.deficits.length === 0 ? 'shipped' : 'gaveUp'));

const tracker = { apiKey: H.env('LINEAR_API_KEY'), team: 'ENG' };

const bugLane = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { ...tracker, labels: ['bug'] }, issue => ({
      attributes: { priority: issue.priority },
      fields: { title: issue.title, description: issue.description },
    })),
    folder.files(Bug, 'product/inbox/bugs', file => ({
      attributes: { priority: 3 },
      fields: { title: String(file.frontmatter['title'] ?? file.path), description: file.body },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { ...tracker, status: { queued: 'Todo', 'in progress': 'In Progress', done: 'Done', abandoned: 'Canceled' } }))
  .runner(git.worktree({ repo: 'product', base: 'main', slots: 3 }))
  .handler(deliveryFlow, {
    states: { building: InProgress, shipped: Done, gaveUp: Abandoned, failed: Abandoned },
    params: { rounds: 3 },
  })
  .wip(2);

export const productHarness = H.harness('product')
  .ledger(sqlite.ledger('product/.harness/ledger.db'))
  .lanes([bugLane])
  .clients([claudeCode.supervisor('product-supervisor', ownerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('product/.harness/BOARD.md'), markdown.telemetry('product/.harness/TELEMETRY.md')]);

const DocPage = H.work('DocPage')
  .attributes({ path: z.string() })
  .fields({ title: z.string(), body: z.string() })
  .states([Queued, InProgress, Done, Abandoned])
  .key(unit => unit.attributes.path);

const DocsExperience = H.memory.experience('docs-experience');
const docsExperience = H.journal('docs-experience-journal', DocsExperience)
  .store(jsonl.memory('docs/.harness/experience.jsonl'))
  .recall(specificThenProven);

const writerRole = H.role('writer')
  .intents(['read', 'write'])
  .instructions('Bring the page up to date with the code it documents.')
  .input({ path: z.string(), title: z.string(), body: z.string() })
  .output({ summary: z.string() });

const writer = H.agent('writer', writerRole)
  .model(sonnet)
  .pool(sharedSubscriptions('docs-subscriptions', 0.3))
  .recalls([docsExperience, ownerTaste])
  .records(docsExperience);

const linkCheck = H.command('link-check', ['npx', 'linkinator', '--silent']);

const docFlow = H.flow('doc-page')
  .requires({ path: z.string(), title: z.string(), body: z.string() })
  .mark('writing')
  .step('write', writer, c => ({ path: c.input.path, title: c.input.title, body: c.input.body }))
  .step('links', linkCheck, c => ({ args: [c.input.path] }))
  .ends(['published'], () => 'published');

const docLane = H.lane('doc-pages', DocPage)
  .supply([
    folder.files(DocPage, 'docs/pages', file => ({
      attributes: { path: file.path },
      fields: { title: String(file.frontmatter['title'] ?? file.path), body: file.body },
    })),
  ])
  .store(folder.frontmatter(DocPage, 'docs/pages'))
  .runner(local.shell({ slots: 2, cwd: 'docs' }))
  .handler(docFlow, { states: { writing: InProgress, published: Done, failed: Abandoned } });

export const docsHarness = H.harness('docs')
  .ledger(sqlite.ledger('docs/.harness/ledger.db'))
  .lanes([docLane])
  .clients([claudeCode.supervisor('docs-supervisor', ownerAccess, { port: H.slot.port(1) })])
  .projections([markdown.board('docs/.harness/BOARD.md')]);
