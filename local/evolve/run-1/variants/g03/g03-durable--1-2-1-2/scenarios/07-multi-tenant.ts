import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const maxOne = claudeCode.subscription('max-1', { configDir: H.env('CLAUDE_MAX_1_DIR') });
const maxTwo = claudeCode.subscription('max-2', { configDir: H.env('CLAUDE_MAX_2_DIR') });
const maxThree = claudeCode.subscription('max-3', { configDir: H.env('CLAUDE_MAX_3_DIR') });
const apiFallback = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sharedAccountQuota = sqlite.quota('~/.harness/accounts.sqlite');

const soonestExpiring = H.policy.account('soonestExpiring', c => {
  const ordered = [...c.eligible].sort((a, b) => a.windowEndsAt - b.windowEndsAt);
  return ordered.length > 0 ? ordered[0] ?? null : null;
});

const bySpecificity = H.policy.recall('bySpecificity', c =>
  [...c.candidates].sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded).slice(0, c.limit),
);

const OwnerTaste = H.memory.taste('ownerTaste');
const Experience = H.memory.experience('experience');
const ownerTaste = H.journal('ownerTaste', OwnerTaste).store(jsonl.memory('~/.harness/taste.jsonl')).recall(bySpecificity);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const Triage = H.state('triage', 'pending');
const Building = H.state('building', 'active');
const Done = H.state('done', 'terminal', 'success');
const Unfinished = H.state('unfinished', 'terminal', 'failure');
const Dropped = H.state('dropped', 'terminal', 'failure');

const Bug = H.work('Bug')
  .attributes({ ref: z.string(), title: z.string() })
  .fields({ description: z.string() })
  .states([Triage, Building, Done, Unfinished, Dropped])
  .key(unit => unit.attributes.ref);
const Feature = H.work('Feature')
  .attributes({ ref: z.string(), title: z.string() })
  .fields({ description: z.string() })
  .states([Triage, Building, Done, Unfinished, Dropped])
  .key(unit => unit.attributes.ref);

const experienceA = H.journal('experienceA', Experience).store(jsonl.memory('project-a/.harness/experience.jsonl')).recall(bySpecificity);

const poolA = H.pool('subscriptionsA')
  .accounts([
    { account: maxOne, share: 0.6 },
    { account: maxTwo, share: 0.6 },
    { account: maxThree, share: 0.6 },
  ])
  .prefer(soonestExpiring)
  .fallback(apiFallback);

const builderModel = H.policy.model('builderModel', [sonnet, opus], c => {
  const unit = c.unit;
  const record = unit === null
    ? c.metrics.success({ model: sonnet, window: { days: 14 } })
    : c.metrics.success({ model: sonnet, kind: unit.kind, window: { days: 14 } });
  return record.n >= 20 && record.rate !== null && record.rate < 0.85 ? opus : sonnet;
});

const projectChecks = H.command('projectChecks', ['npm', 'run', 'check']);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'ask'])
  .instructions('Implement the task in the worktree. Address every listed deficit.')
  .input({ task: z.string(), description: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });
const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'remember'])
  .instructions('List every deficit between the task and the change. Record lessons worth keeping.')
  .input({ task: z.string(), summary: z.string() })
  .output({ deficits: z.array(z.string()) });

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(poolA)
  .recalls([ownerTaste, experienceA])
  .leaseWrites()
  .mustPass(projectChecks);
const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .pool(poolA)
  .recalls([experienceA])
  .records(experienceA);

const buildFlow = H.flow('buildAndAudit')
  .requires({ title: z.string(), description: z.string() })
  .params({ rounds: z.number() })
  .loop(
    'buildRounds',
    { carry: { deficits: z.array(z.string()) }, rounds: c => c.params.rounds },
    round =>
      round
        .step('build', builder, c => ({
          task: c.input.title,
          description: c.input.description,
          deficits: c.carry === null ? [] : c.carry.deficits,
        }))
        .step('audit', auditor, c => ({ task: c.input.title, summary: c.out.build.summary })),
    last => (last.audit.deficits.length === 0 ? null : { deficits: last.audit.deficits }),
  )
  .ends(['built', 'unfinished'], c => (c.out.buildRounds.exhausted ? 'unfinished' : 'built'));

const tracker = { apiKey: H.env('LINEAR_API_KEY'), team: 'PRODUCT' };
const trackerStatus = { triage: 'Todo', building: 'In Progress', done: 'Done', unfinished: 'Blocked', dropped: 'Canceled' };
const worktrees = git.worktree({ repo: 'project-a', base: 'main', slots: 3 });
const retryTwice = H.retry.exponential({ maxRetries: 2, initialDelayMs: 120_000 });

const bugs = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { ...tracker, labels: ['bug'] }, (issue, supply) =>
      supply.create({ attributes: { ref: issue.identifier, title: issue.title }, fields: { description: issue.description } }),
    ),
    folder.files(Bug, 'project-a/bugs', (file, supply) =>
      supply.create({ attributes: { ref: file.path, title: file.path }, fields: { description: file.body } }),
    ),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { ...tracker, status: trackerStatus }))
  .runner(worktrees)
  .wip(2)
  .handler(buildFlow, { opens: Building, params: { rounds: 3 }, ends: { built: Done, unfinished: Unfinished } })
  .retry(retryTwice, { exhausted: Dropped });

const features = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { ...tracker, labels: ['feature'] }, (issue, supply) =>
      supply.create({ attributes: { ref: issue.identifier, title: issue.title }, fields: { description: issue.description } }),
    ),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { ...tracker, status: trackerStatus }))
  .runner(worktrees)
  .handler(buildFlow, { opens: Building, params: { rounds: 5 }, ends: { built: Done, unfinished: Unfinished } })
  .retry(retryTwice, { exhausted: Dropped });

const bugsThenStarvingFeatures = H.policy.schedule('bugsThenStarvingFeatures', c => ({
  start: c.order(
    candidate => (candidate.is(features) && candidate.waitedMs > 86_400_000 ? 0 : candidate.is(bugs) ? 1 : 2),
    candidate => candidate.enqueuedAt,
  ),
}));

const ownerOperations = [
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.resolveBlocks,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
];

export const projectA = H.harness('projectA')
  .ledger(sqlite.ledger('project-a/.harness/ledger.sqlite', { quota: sharedAccountQuota }))
  .lanes([bugs, features])
  .schedule(bugsThenStarvingFeatures)
  .clients([claudeCode.supervisor('ownerA', H.access('ownerA').allows(ownerOperations), { port: H.slot.port(0) })])
  .projections([markdown.board('project-a/BOARD.md'), markdown.telemetry('project-a/TELEMETRY.md')]);

const Queued = H.state('queued', 'pending');
const Writing = H.state('writing', 'active');
const Written = H.state('written', 'terminal', 'success');
const BrokenLinks = H.state('brokenLinks', 'terminal', 'failure');

const DocPage = H.work('DocPage')
  .attributes({ path: z.string(), title: z.string() })
  .fields({ body: z.string() })
  .states([Queued, Writing, Written, BrokenLinks, Dropped])
  .key(unit => unit.attributes.path);

const experienceB = H.journal('experienceB', Experience).store(jsonl.memory('project-b/.harness/experience.jsonl')).recall(bySpecificity);

const poolB = H.pool('subscriptionsB').accounts([
  { account: maxOne, share: 0.3 },
  { account: maxTwo, share: 0.3 },
  { account: maxThree, share: 0.3 },
]).prefer(soonestExpiring);

const writerRole = H.role('writer')
  .intents(['read', 'write'])
  .instructions('Rewrite the page for clarity. Keep every link that still resolves.')
  .input({ title: z.string(), body: z.string() })
  .output({ body: z.string() });
const writer = H.agent('writer', writerRole).model(sonnet).pool(poolB).recalls([ownerTaste, experienceB]).records(experienceB);
const linkCheck = H.command('linkCheck', ['npx', 'linkinator', '--stdin']);

const docFlow = H.flow('writeDoc')
  .requires({ title: z.string(), body: z.string() })
  .step('write', writer, c => ({ title: c.input.title, body: c.input.body }))
  .step('linkCheck', linkCheck, c => ({ stdin: c.out.write.body }))
  .ends(['written', 'brokenLinks'], c => (c.out.linkCheck.exitCode === 0 ? 'written' : 'brokenLinks'));

const docPages = H.lane('docPages', DocPage)
  .supply([
    folder.files(DocPage, 'project-b/docs', (file, supply) =>
      supply.create({ attributes: { path: file.path, title: String(file.frontmatter['title'] ?? file.path) }, fields: { body: file.body } }),
    ),
  ])
  .store(folder.frontmatter(DocPage, 'project-b/docs'))
  .runner(local.shell({ slots: 2, cwd: 'project-b' }))
  .handler(docFlow, { opens: Writing, ends: { written: Written, brokenLinks: BrokenLinks } })
  .retry(retryTwice, { exhausted: Dropped });

export const projectB = H.harness('projectB')
  .ledger(sqlite.ledger('project-b/.harness/ledger.sqlite', { quota: sharedAccountQuota }))
  .lanes([docPages])
  .schedule(H.policy.schedule('oldestFirst', c => ({ start: c.order(candidate => candidate.enqueuedAt) })))
  .clients([claudeCode.supervisor('ownerB', H.access('ownerB').allows(ownerOperations), { port: H.slot.port(1) })])
  .projections([markdown.board('project-b/BOARD.md'), markdown.telemetry('project-b/TELEMETRY.md')]);

void projectA.start();
void projectB.start();
