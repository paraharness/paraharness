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

const sharedAccountState = sqlite.quota('~/.harness/accounts.db');

const maxOne = claudeCode.subscription('claude-max-1', { configDir: H.env('CLAUDE_MAX_1_DIR'), quota: sharedAccountState });
const maxTwo = claudeCode.subscription('claude-max-2', { configDir: H.env('CLAUDE_MAX_2_DIR'), quota: sharedAccountState });
const maxThree = claudeCode.subscription('claude-max-3', { configDir: H.env('CLAUDE_MAX_3_DIR'), quota: sharedAccountState });
const apiFallback = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedAccountState });

const soonestExpiring = H.policy.account('soonest-expiring-first', c =>
  [...c.eligible].sort((a, b) => a.windowEndsAt - b.windowEndsAt)[0] ?? null,
);

const ownerTaste = H.memory.taste('owner-taste');
const specificFirst = H.policy.recall('specific-then-proven', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);
const sharedTasteJournal = H.journal('owner-taste-journal', ownerTaste)
  .store(jsonl.memory('~/.harness/owner-taste.jsonl'))
  .recall(specificFirst);

const sonnet = claudeCode.model('claude-sonnet-4');
const haiku = claudeCode.model('claude-haiku-4');

const Todo = H.state('todo', 'pending');
const InProgress = H.state('in-progress', 'active');
const NeedsOwner = H.state('needs-owner', 'waiting');
const Done = H.state('done', 'terminal', 'success');
const RoundsExhausted = H.state('rounds-exhausted', 'terminal', 'failure');

const productPool = H.pool('product-pool')
  .accounts([
    { account: maxOne, share: 0.6 },
    { account: maxTwo, share: 0.6 },
    { account: maxThree, share: 0.6 },
  ])
  .prefer(soonestExpiring)
  .fallback(apiFallback);

const productExperience = H.journal('product-experience', H.memory.experience('product-lessons'))
  .store(jsonl.memory('product/memory/experience.jsonl'))
  .recall(specificFirst);

const Bug = H.work('bug')
  .attributes({ issueId: z.string(), title: z.string() })
  .fields({ description: z.string() })
  .states([Todo, InProgress, NeedsOwner, Done, RoundsExhausted])
  .key(bug => bug.attributes.issueId);

const Feature = H.work('feature')
  .attributes({ issueId: z.string(), title: z.string() })
  .fields({ description: z.string() })
  .states([Todo, InProgress, NeedsOwner, Done, RoundsExhausted])
  .key(feature => feature.attributes.issueId);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'ask', 'remember'])
  .instructions('Implement the task in the worktree. Fix every listed deficit. Ask the owner when a decision is theirs.')
  .input({ task: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });

const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'remember'])
  .instructions('Audit the change against the task. List every remaining deficit; list none when the work is complete.')
  .input({ task: z.string(), change: z.string() })
  .output({ deficits: z.array(z.string()) });

const builderModel = H.policy.model('cheap-until-it-slips', [haiku, sonnet], c => {
  const cheap = c.metrics.success({ kind: c.unit?.kind ?? 'bug', model: haiku, window: { days: 14 } });
  return cheap.n >= 20 && (cheap.rate ?? 0) < 0.85 ? sonnet : haiku;
});

const projectChecks = H.command('project-checks', ['npm', 'run', 'check']);

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(productPool)
  .recalls([productExperience, sharedTasteJournal])
  .leaseWrites()
  .mustPass(projectChecks);

const auditor = H.agent('auditor', auditorRole)
  .model(sonnet)
  .pool(productPool)
  .recalls([productExperience])
  .records(productExperience);

const buildAndAudit = H.flow('build-and-audit')
  .requires({ title: z.string(), description: z.string() })
  .params({ rounds: z.number() })
  .mark('started')
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: c => c.params.rounds },
    round =>
      round
        .step('build', builder, c => ({ task: `${c.input.title}\n\n${c.input.description}`, deficits: c.carry?.deficits ?? [] }))
        .step('audit', auditor, c => ({ task: c.input.title, change: c.out.build.summary })),
    last => (last.audit.deficits.length > 0 ? { deficits: last.audit.deficits } : null),
  )
  .ends(['done', 'exhausted'], c => (c.out.rounds.exhausted ? 'exhausted' : 'done'));

const linearProduct = { apiKey: H.env('LINEAR_API_KEY'), team: 'PRODUCT' };
const trackerStatus = {
  todo: 'Todo',
  'in-progress': 'In Progress',
  'needs-owner': 'Blocked',
  done: 'Done',
  'rounds-exhausted': 'Canceled',
};
const worktrees = git.worktree({ repo: '.', base: 'main', slots: 3 });

const bugs = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { ...linearProduct, labels: ['bug'] }, issue => ({
      attributes: { issueId: issue.identifier, title: issue.title },
      fields: { description: issue.description },
    })),
    folder.files(Bug, 'bugs', file => ({
      attributes: { issueId: file.path, title: file.body.split('\n')[0] ?? file.path },
      fields: { description: file.body },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { ...linearProduct, status: trackerStatus }))
  .runner(worktrees)
  .wip(2)
  .handler(buildAndAudit, {
    states: { started: InProgress, done: Done, exhausted: RoundsExhausted, failed: NeedsOwner },
    params: { rounds: 3 },
  });

const features = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { ...linearProduct, labels: ['feature'] }, issue => ({
      attributes: { issueId: issue.identifier, title: issue.title },
      fields: { description: issue.description },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { ...linearProduct, status: trackerStatus }))
  .runner(worktrees)
  .handler(buildAndAudit, {
    states: { started: InProgress, done: Done, exhausted: RoundsExhausted, failed: NeedsOwner },
    params: { rounds: 5 },
  });

const productionProbe = H.command('production-health-probe', ['bin/probe-production']);
const probeProduction = H.operation('probe-production')
  .input({ service: z.string() })
  .invokes(productionProbe, input => ({ args: [input.service] }));

const priority = (isBug: boolean, isFeature: boolean, waitedMs: number): number =>
  isBug ? 0 : isFeature && waitedMs > 4 * 60 * 60 * 1000 ? 0 : isFeature ? 1 : 2;

const productAccess = H.access('product-owner').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.resolveBlocks,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
  probeProduction,
]);

export const productHarness = H.harness('product')
  .ledger(sqlite.ledger('product/state/ledger.db'))
  .lanes([bugs, features])
  .schedule(
    H.policy.schedule('bugs-then-features-without-starvation', c => ({
      start: [...c.candidates].sort(
        (a, b) => priority(a.is(bugs), a.is(features), a.waitedMs) - priority(b.is(bugs), b.is(features), b.waitedMs),
      ),
    })),
  )
  .clients([claudeCode.supervisor('product-supervisor', productAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('product/BOARD.md'), markdown.telemetry('product/TELEMETRY.md')]);

const docsPool = H.pool('docs-pool')
  .accounts([
    { account: maxOne, share: 0.3 },
    { account: maxTwo, share: 0.3 },
    { account: maxThree, share: 0.3 },
  ])
  .prefer(soonestExpiring)
  .fallback(apiFallback);

const docsExperience = H.journal('docs-experience', H.memory.experience('docs-lessons'))
  .store(jsonl.memory('docs/memory/experience.jsonl'))
  .recall(specificFirst);

const Unwritten = H.state('unwritten', 'pending');
const Writing = H.state('writing', 'active');
const Published = H.state('published', 'terminal', 'success');
const BrokenLinks = H.state('broken-links', 'terminal', 'failure');

const DocPage = H.work('doc-page')
  .attributes({ path: z.string() })
  .fields({ title: z.string(), body: z.string() })
  .states([Unwritten, Writing, NeedsOwner, Published, BrokenLinks])
  .key(page => page.attributes.path);

const writerRole = H.role('writer')
  .intents(['read', 'write'])
  .instructions('Rewrite the page so it is accurate, short and follows the owner taste.')
  .input({ title: z.string(), body: z.string() })
  .output({ body: z.string() });

const writer = H.agent('writer', writerRole)
  .model(sonnet)
  .pool(docsPool)
  .recalls([docsExperience, sharedTasteJournal])
  .records(docsExperience);

const linkCheck = H.command('link-check', ['bin/link-check']);

const writeAndCheck = H.flow('write-and-check')
  .requires({ path: z.string(), title: z.string(), body: z.string() })
  .mark('writing')
  .step('write', writer, c => ({ title: c.input.title, body: c.input.body }))
  .step('linkCheck', linkCheck, c => ({ args: [c.input.path] }))
  .ends(['published', 'brokenLinks'], c => (c.out.linkCheck.exitCode === 0 ? 'published' : 'brokenLinks'));

const docPages = H.lane('doc-pages', DocPage)
  .supply([
    folder.files(DocPage, 'docs/pages', file => ({
      attributes: { path: file.path },
      fields: { title: String(file.frontmatter['title'] ?? file.path), body: file.body },
    })),
  ])
  .store(folder.frontmatter(DocPage, 'docs/pages'))
  .runner(local.shell({ slots: 2, cwd: 'docs' }))
  .handler(writeAndCheck, {
    states: { writing: Writing, published: Published, brokenLinks: BrokenLinks, failed: NeedsOwner },
  });

const docsAccess = H.access('docs-owner').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.resolveBlocks,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
]);

export const docsHarness = H.harness('docs')
  .ledger(sqlite.ledger('docs/state/ledger.db'))
  .lanes([docPages])
  .schedule(H.policy.schedule('longest-waiting-first', c => ({ start: [...c.candidates].sort((a, b) => b.waitedMs - a.waitedMs) })))
  .clients([claudeCode.supervisor('docs-supervisor', docsAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('docs/BOARD.md'), markdown.telemetry('docs/TELEMETRY.md')]);
