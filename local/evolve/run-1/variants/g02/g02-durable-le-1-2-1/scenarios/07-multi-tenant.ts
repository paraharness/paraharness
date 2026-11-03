import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as markdown from 'harness-dsl/markdown';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';

const sharedQuota = sqlite.quota('~/.harness/shared/account-quota.sqlite');

const maxOne = claudeCode.subscription('max-one', { configDir: H.env('CLAUDE_MAX_ONE_DIR') });
const maxTwo = claudeCode.subscription('max-two', { configDir: H.env('CLAUDE_MAX_TWO_DIR') });
const maxThree = claudeCode.subscription('max-three', { configDir: H.env('CLAUDE_MAX_THREE_DIR') });
const apiAccount = anthropic.account('owner-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonest-expiring', c =>
  [...c.eligible].sort((x, y) => x.windowEndsAt - y.windowEndsAt)[0] ?? null);

const specificFirst = H.policy.recall('specific-first', c =>
  [...c.candidates]
    .sort((x, y) => y.specificity - x.specificity || y.track.succeeded - x.track.succeeded)
    .slice(0, c.limit));

const ownerTaste = H.memory.taste('owner-taste');
const sharedTaste = H.journal('owner-taste-journal', ownerTaste)
  .store(jsonl.memory('~/.harness/shared/taste.jsonl'))
  .recall(specificFirst);

const cheap = claudeCode.model('claude-sonnet-4-5');
const strong = claudeCode.model('claude-opus-4-1');

const operatorAccess = (name: string) =>
  H.access(name).allows([
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
const Working = H.state('Working', 'active');
const Done = H.state('Done', 'terminal', 'success');
const NeedsOwner = H.state('NeedsOwner', 'waiting');
const Abandoned = H.state('Abandoned', 'terminal', 'neutral');

const Bug = H.work('Bug')
  .attributes({ issueId: z.string(), priority: z.number() })
  .fields({ title: z.string(), description: z.string() })
  .states([Todo, Working, Done, NeedsOwner, Abandoned])
  .key(u => u.attributes.issueId);
const Feature = H.work('Feature')
  .attributes({ issueId: z.string(), priority: z.number() })
  .fields({ title: z.string(), description: z.string() })
  .states([Todo, Working, Done, NeedsOwner, Abandoned])
  .key(u => u.attributes.issueId);

const productExperience = H.journal('product-experience', H.memory.experience('product-experience'))
  .store(jsonl.memory('product/.harness/experience.jsonl'))
  .recall(specificFirst);

const productPool = H.pool('product-subscriptions')
  .accounts([
    { account: maxOne, share: 0.6 },
    { account: maxTwo, share: 0.6 },
    { account: maxThree, share: 0.6 },
  ])
  .prefer(soonestExpiring)
  .fallback(apiAccount);

const builderModel = H.policy.model('builder-model', [cheap, strong], c => {
  if (c.unit === null) return cheap;
  const record = c.metrics.success({ kind: c.unit.kind, model: cheap, window: { days: 14 } });
  return record.n >= 20 && record.rate !== null && record.rate < 0.85 ? strong : cheap;
});

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'ask'])
  .input({ task: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });
const auditorRole = H.role('auditor')
  .intents(['read', 'execute'])
  .input({ task: z.string(), summary: z.string() })
  .output({ deficits: z.array(z.string()) });

const projectChecks = H.command('project-checks', ['npm', 'run', 'check']);

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(productPool)
  .recalls([productExperience, sharedTaste])
  .leaseWrites()
  .mustPass(projectChecks);
const auditor = H.agent('auditor', auditorRole)
  .model(strong)
  .pool(productPool)
  .recalls([productExperience])
  .records(productExperience);

const buildAndAudit = H.flow('build-and-audit')
  .requires({ title: z.string(), description: z.string() })
  .params({ rounds: z.number() })
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: c => c.params.rounds },
    round => round
      .step('build', builder, c => ({ task: `${c.input.title}\n\n${c.input.description}`, deficits: c.carry === null ? [] : c.carry.deficits }))
      .step('audit', auditor, c => ({ task: c.input.title, summary: c.out.build.summary })),
    last => (last.audit.deficits.length > 0 ? { deficits: last.audit.deficits } : null),
  )
  .ends(['done', 'needsOwner'], c => (c.out.rounds.exhausted ? 'needsOwner' : 'done'));

const linearAuth = { apiKey: H.env('LINEAR_API_KEY'), team: 'PROD' };
const trackerStatus = { Todo: 'Todo', Working: 'In Progress', Done: 'Done', NeedsOwner: 'Blocked', Abandoned: 'Canceled' };
const worktrees = git.worktree({ repo: 'product', base: 'main', slots: 3 });

const bugs = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { ...linearAuth, labels: ['bug'] }, (issue, supply) =>
      supply.create({ attributes: { issueId: issue.identifier, priority: issue.priority }, fields: { title: issue.title, description: issue.description } })),
    folder.files(Bug, 'product/bugs', (file, supply) =>
      supply.create({ attributes: { issueId: `file:${file.path}`, priority: 3 }, fields: { title: file.path, description: file.body } })),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { ...linearAuth, status: trackerStatus }))
  .runner(worktrees)
  .wip(2)
  .handler(buildAndAudit, { states: { done: Done, needsOwner: NeedsOwner }, opens: Working, params: { rounds: 3 } });

const features = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { ...linearAuth, labels: ['feature'] }, (issue, supply) =>
      supply.create({ attributes: { issueId: issue.identifier, priority: issue.priority }, fields: { title: issue.title, description: issue.description } })),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { ...linearAuth, status: trackerStatus }))
  .runner(worktrees)
  .handler(buildAndAudit, { states: { done: Done, needsOwner: NeedsOwner }, opens: Working, params: { rounds: 5 } });

export const productHarness = H.harness('product')
  .ledger(sqlite.ledger('product/.harness/ledger.sqlite', { quota: sharedQuota }))
  .lanes([bugs, features])
  .schedule(H.policy.schedule('bugs-then-features', c => ({
    start: c.order(
      x => (x.is(bugs) ? 0 : x.waitedMs > 4 * 3600000 ? 0 : 1),
      x => x.enqueuedAt,
    ),
  })))
  .clients([claudeCode.supervisor('product-supervisor', operatorAccess('product-operator'), { port: H.slot.port(0) })])
  .projections([markdown.board('product/BOARD.md'), markdown.telemetry('product/TELEMETRY.md')]);

const Stale = H.state('Stale', 'pending');
const Writing = H.state('Writing', 'active');
const Published = H.state('Published', 'terminal', 'success');

const DocPage = H.work('DocPage')
  .attributes({ path: z.string() })
  .fields({ title: z.string(), body: z.string() })
  .states([Stale, Writing, Published])
  .key(u => u.attributes.path);

const docsExperience = H.journal('docs-experience', H.memory.experience('docs-experience'))
  .store(jsonl.memory('docs/.harness/experience.jsonl'))
  .recall(specificFirst);

const docsPool = H.pool('docs-subscriptions')
  .accounts([
    { account: maxOne, share: 0.3 },
    { account: maxTwo, share: 0.3 },
    { account: maxThree, share: 0.3 },
  ])
  .prefer(soonestExpiring);

const writerRole = H.role('writer')
  .intents(['read', 'write'])
  .input({ path: z.string(), title: z.string(), body: z.string() })
  .output({ summary: z.string() });

const writer = H.agent('writer', writerRole)
  .model(cheap)
  .pool(docsPool)
  .recalls([sharedTaste, docsExperience])
  .records(docsExperience);

const linkCheck = H.command('link-check', ['npx', 'linkinator']);

const writePage = H.flow('write-page')
  .requires({ path: z.string(), title: z.string(), body: z.string() })
  .step('write', writer, c => ({ path: c.input.path, title: c.input.title, body: c.input.body }))
  .step('links', linkCheck, c => ({ args: [c.input.path] }))
  .ends(['published'], () => 'published');

const pages = H.lane('pages', DocPage)
  .supply([
    folder.files(DocPage, 'docs/pages', (file, supply) =>
      supply.create({ attributes: { path: file.path }, fields: { title: file.path, body: file.body } })),
  ])
  .store(folder.frontmatter(DocPage, 'docs/pages'))
  .runner(local.shell({ slots: 1, cwd: 'docs' }))
  .retry(H.retry.exponential({ maxRetries: 3, initialDelayMs: 60000 }))
  .handler(writePage, { states: { published: Published }, opens: Writing });

export const docsHarness = H.harness('docs')
  .ledger(sqlite.ledger('docs/.harness/ledger.sqlite', { quota: sharedQuota }))
  .lanes([pages])
  .schedule(H.policy.schedule('oldest-page-first', c => ({ start: c.order(x => x.enqueuedAt) })))
  .clients([claudeCode.supervisor('docs-supervisor', operatorAccess('docs-operator'), { port: H.slot.port(1) })])
  .projections([markdown.board('docs/BOARD.md')]);
