import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

export const sharedAccountState = sqlite.accounts('~/.harness-shared/accounts.sqlite');

export const maxOne = claudeCode.subscription('max-one', { configDir: H.env('CLAUDE_MAX_ONE_DIR') });
export const maxTwo = claudeCode.subscription('max-two', { configDir: H.env('CLAUDE_MAX_TWO_DIR') });
export const maxThree = claudeCode.subscription('max-three', { configDir: H.env('CLAUDE_MAX_THREE_DIR') });
export const apiFallback = anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY') });

export const sonnet = claudeCode.model('claude-sonnet-4-5');
export const opus = claudeCode.model('claude-opus-4-1');

export const soonestExpiring = H.policy.account('soonestExpiring', c =>
  [...c.eligible].sort((a, b) => a.windowEndsAt - b.windowEndsAt)[0] ?? null);

export const specificFirst = H.policy.recall('specificFirst', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit));

export const ownerTaste = H.memory.taste('ownerTaste');
export const sharedTaste = H.journal('sharedTaste', ownerTaste)
  .store(jsonl.memory('~/.harness-shared/taste.jsonl'))
  .recall(specificFirst);

export const ownerSupervision = H.access('ownerSupervision').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
]);

const Todo = H.state('Todo', 'pending');
const Building = H.state('Building', 'active');
const Done = H.state('Done', 'terminal', 'success');
const Abandoned = H.state('Abandoned', 'terminal', 'failure');

const issueAttributes = { issueId: z.string(), area: z.string() };
const issueFields = { title: z.string(), description: z.string() };

const Bug = H.work('Bug')
  .attributes(issueAttributes)
  .fields(issueFields)
  .states([Todo, Building, Done, Abandoned])
  .key(u => u.attributes.issueId);

const Feature = H.work('Feature')
  .attributes(issueAttributes)
  .fields(issueFields)
  .states([Todo, Building, Done, Abandoned])
  .key(u => u.attributes.issueId);

const codingExperience = H.memory.experience('codingExperience');
const codingExperienceJournal = H.journal('codingExperienceJournal', codingExperience)
  .store(jsonl.memory('.harness/coding-experience.jsonl'))
  .recall(specificFirst);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'search', 'ask'])
  .instructions('Implement the task in the worktree. Address every deficit listed. Ask the owner when a decision is theirs.')
  .input({ task: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string(), filesChanged: z.array(z.string()) });

const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'remember'])
  .instructions('Find deficits in the change. Return none when it is complete.')
  .input({ task: z.string(), summary: z.string() })
  .output({ deficits: z.array(z.string()) });

const builderModel = H.policy.model('builderModel', [sonnet, opus], c => {
  const record = c.metrics.success({
    model: sonnet,
    agent: 'builder',
    kind: c.unit === null ? undefined : { name: c.unit.kind },
    window: { days: 14 },
  });
  return record.n >= 20 && record.rate !== null && record.rate < 0.85 ? opus : sonnet;
});

const alphaPool = H.pool('alphaPool')
  .accounts([
    { account: maxOne, share: 0.6 },
    { account: maxTwo, share: 0.6 },
    { account: maxThree, share: 0.6 },
  ])
  .prefer(soonestExpiring)
  .fallback(apiFallback);

const projectChecks = H.command('projectChecks', ['npm', 'run', 'check']);

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(alphaPool)
  .recalls([sharedTaste, codingExperienceJournal])
  .leaseWrites()
  .mustPass(projectChecks);

const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .pool(alphaPool)
  .recalls([codingExperienceJournal])
  .records(codingExperienceJournal);

const buildAndAudit = H.flow('buildAndAudit')
  .requires({ title: z.string(), description: z.string() })
  .params({ rounds: z.number() })
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: c => c.params.rounds },
    round => round
      .step('build', builder, c => ({
        task: `${c.input.title}\n\n${c.input.description}`,
        deficits: c.carry === null ? [] : c.carry.deficits,
      }))
      .step('audit', auditor, c => ({ task: c.input.title, summary: c.out.build.summary })),
    last => (last.audit.deficits.length === 0 ? null : { deficits: last.audit.deficits }),
  )
  .ends(['shipped', 'gaveUp'], c => (c.out.rounds.last.audit.deficits.length === 0 ? 'shipped' : 'gaveUp'));

const tracker = { apiKey: H.env('LINEAR_API_KEY'), team: 'ENG' };
const trackerStatus = { Todo: 'Todo', Building: 'In Progress', Done: 'Done', Abandoned: 'Canceled' };
const worktrees = git.worktree({ repo: '.', base: 'main', slots: 3 });

const bugs = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { ...tracker, labels: ['bug'] }, issue => ({
      attributes: { issueId: issue.identifier, area: issue.labels[0] ?? 'general' },
      fields: { title: issue.title, description: issue.description },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { ...tracker, status: trackerStatus }))
  .runner(worktrees)
  .wip(2)
  .handler(buildAndAudit, { states: { shipped: Done, gaveUp: Abandoned, failed: Abandoned }, params: { rounds: 3 } });

const features = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { ...tracker, labels: ['feature'] }, issue => ({
      attributes: { issueId: issue.identifier, area: issue.labels[0] ?? 'general' },
      fields: { title: issue.title, description: issue.description },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { ...tracker, status: trackerStatus }))
  .runner(worktrees)
  .handler(buildAndAudit, { states: { shipped: Done, gaveUp: Abandoned, failed: Abandoned }, params: { rounds: 5 } });

const bugsBeforeFeatures = H.policy.schedule('bugsBeforeFeatures', c => {
  const starvedMs = 6 * 60 * 60 * 1000;
  const tier = (x: (typeof c.candidates)[number]) =>
    x.is(bugs) ? 1 : x.is(features) && x.waitedMs > starvedMs ? 0 : 2;
  return { start: [...c.candidates].sort((a, b) => tier(a) - tier(b) || b.waitedMs - a.waitedMs) };
});

export const productHarness = H.harness('product')
  .ledger(sqlite.ledger('.harness/product.sqlite', { accounts: sharedAccountState }))
  .lanes([bugs, features])
  .schedule(bugsBeforeFeatures)
  .clients([claudeCode.supervisor('productSupervisor', ownerSupervision, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

const Stale = H.state('Stale', 'pending');
const Writing = H.state('Writing', 'active');
const Published = H.state('Published', 'terminal', 'success');
const LinksBroken = H.state('LinksBroken', 'terminal', 'failure');

const DocPage = H.work('DocPage')
  .attributes({ path: z.string() })
  .fields({ title: z.string(), body: z.string() })
  .states([Stale, Writing, Published, LinksBroken])
  .key(u => u.attributes.path);

const docsExperience = H.memory.experience('docsExperience');
const docsExperienceJournal = H.journal('docsExperienceJournal', docsExperience)
  .store(jsonl.memory('.harness/docs-experience.jsonl'))
  .recall(specificFirst);

const writerRole = H.role('writer')
  .intents(['read', 'write', 'remember'])
  .instructions('Rewrite the page in place so it is accurate and follows the owner taste. Keep the frontmatter.')
  .input({ path: z.string(), title: z.string(), body: z.string() })
  .output({ summary: z.string() });

const betaPool = H.pool('betaPool')
  .accounts([
    { account: maxOne, share: 0.3 },
    { account: maxTwo, share: 0.3 },
    { account: maxThree, share: 0.3 },
  ])
  .prefer(soonestExpiring);

const writer = H.agent('writer', writerRole)
  .model(sonnet)
  .pool(betaPool)
  .recalls([sharedTaste, docsExperienceJournal])
  .records(docsExperienceJournal);

const linkCheck = H.command('linkCheck', ['bin/link-check', '--json']).parses({ broken: z.array(z.string()) });

const docFlow = H.flow('docPage')
  .requires({ path: z.string(), title: z.string(), body: z.string() })
  .step('write', writer, c => ({ path: c.input.path, title: c.input.title, body: c.input.body }))
  .step('links', linkCheck, c => ({ args: [c.input.path] }), { restart: 'rerun' })
  .ends(['published', 'broken'], c => (c.out.links.data.broken.length === 0 ? 'published' : 'broken'));

const docPages = H.lane('docPages', DocPage)
  .supply([
    folder.files(DocPage, 'docs', file => ({
      attributes: { path: file.path },
      fields: { title: String(file.frontmatter.title ?? file.path), body: file.body },
    })),
  ])
  .store(folder.frontmatter(DocPage, 'docs'))
  .runner(local.shell({ slots: 1, cwd: '.' }))
  .wip(1)
  .handler(docFlow, { states: { published: Published, broken: LinksBroken, failed: LinksBroken } });

const docsOldestFirst = H.policy.schedule('docsOldestFirst', c => ({
  start: [...c.candidates].sort((a, b) => b.waitedMs - a.waitedMs),
}));

export const docsHarness = H.harness('docs')
  .ledger(sqlite.ledger('.harness/docs.sqlite', { accounts: sharedAccountState }))
  .lanes([docPages])
  .schedule(docsOldestFirst)
  .clients([claudeCode.supervisor('docsSupervisor', ownerSupervision, { port: H.slot.port(1) })])
  .projections([markdown.board('docs/BOARD.md'), markdown.telemetry('docs/TELEMETRY.md')]);
