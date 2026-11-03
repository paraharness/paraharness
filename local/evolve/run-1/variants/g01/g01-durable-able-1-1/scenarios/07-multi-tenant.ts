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

const sharedAccountState = sqlite.quota('/home/owner/.harness/accounts.sqlite');

const maxOne = claudeCode.subscription('claude-max-1', { configDir: H.env('CLAUDE_MAX_1_CONFIG_DIR'), quota: sharedAccountState });
const maxTwo = claudeCode.subscription('claude-max-2', { configDir: H.env('CLAUDE_MAX_2_CONFIG_DIR'), quota: sharedAccountState });
const maxThree = claudeCode.subscription('claude-max-3', { configDir: H.env('CLAUDE_MAX_3_CONFIG_DIR'), quota: sharedAccountState });
const apiFallback = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedAccountState });

const soonestExpiring = H.policy.account('soonest-expiring', c =>
  [...c.eligible].sort((a, b) => a.windowEndsAt - b.windowEndsAt)[0] ?? null,
);

const sharedPool = (name: string, share: number) =>
  H.pool(name)
    .accounts([maxOne, maxTwo, maxThree].map(account => ({ account, share })))
    .prefer(soonestExpiring)
    .fallback(apiFallback);

const specificFirst = H.policy.recall('specific-first', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const ownerTaste = H.memory.taste('owner-taste');
const sharedTasteJournal = H.journal('owner-taste-journal', ownerTaste)
  .store(jsonl.memory('/home/owner/.harness/taste.jsonl'))
  .recall(specificFirst);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const Queued = H.state.pending('Queued');
const Working = H.state.active('Working');
const NeedsOwner = H.state.waiting('NeedsOwner');
const Done = H.state.terminal('Done', 'success');
const WontDo = H.state.terminal('WontDo', 'neutral');

const ownerConsole = H.access('owner-console').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.resolveBlocks,
  H.ops.recoverAttempts,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
]);

const linearKey = H.env('LINEAR_API_KEY');

const Bug = H.work('Bug')
  .attributes({ issueId: z.string() })
  .fields({ title: z.string(), description: z.string() })
  .states([Queued, Working, NeedsOwner, Done, WontDo])
  .key(bug => bug.attributes.issueId);

const Feature = H.work('Feature')
  .attributes({ issueId: z.string() })
  .fields({ title: z.string(), description: z.string() })
  .states([Queued, Working, NeedsOwner, Done, WontDo])
  .key(feature => feature.attributes.issueId);

const fromIssue = (issue: linear.LinearIssue) => ({
  attributes: { issueId: issue.identifier },
  fields: { title: issue.title, description: issue.description },
});

const trackerStatus = { Queued: 'Todo', Working: 'In Progress', NeedsOwner: 'Blocked', Done: 'Done', WontDo: 'Canceled' };

const codingExperience = H.memory.experience('coding-experience');
const codingExperienceJournal = H.journal('coding-experience-journal', codingExperience)
  .store(jsonl.memory('project-a/.harness/experience.jsonl'))
  .recall(specificFirst);

const codingPool = sharedPool('coding-pool', 0.6);

const builderModel = H.policy.model('builder-model', [sonnet, opus], (c, [cheaper, stronger]) => {
  const record = c.metrics.success({ kind: c.unit === null ? 'Bug' : c.unit.kind, model: cheaper, window: { days: 14 } });
  return record.n >= 20 && record.rate !== null && record.rate < 0.85 ? stronger : cheaper;
});

const projectChecks = H.command('project-checks', ['npm', 'run', 'check']);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'ask'])
  .instructions('Implement the change. Address every deficit listed. Ask the owner when a product decision is needed.')
  .input({ task: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });

const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'remember'])
  .instructions('Find deficits in the change against the task. Record lessons as forward rules.')
  .input({ task: z.string(), change: z.string() })
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

const buildAndAudit = H.flow('build-and-audit')
  .requires({ title: z.string(), description: z.string() })
  .params({ rounds: z.number() })
  .mark('working')
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: c => c.params.rounds },
    round =>
      round
        .step('build', builder, c => ({
          task: `${c.input.title}\n\n${c.input.description}`,
          deficits: c.carry === null ? [] : c.carry.deficits,
        }), { onRestart: 'reconcile' })
        .step('audit', auditor, c => ({ task: c.input.title, change: c.out.build.summary }), { onRestart: 'reconcile' }),
    last => (last.audit.deficits.length > 0 ? { deficits: last.audit.deficits } : null),
  )
  .ends(['done', 'deficient'], c => (c.out.rounds.last.audit.deficits.length === 0 ? 'done' : 'deficient'));

const worktrees = git.worktree({ repo: 'project-a', base: 'main', slots: 3 });

const bugs = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { apiKey: linearKey, team: 'ENG', labels: ['bug'] }, fromIssue),
    folder.files(Bug, 'project-a/bugs', file => ({
      attributes: { issueId: file.path },
      fields: { title: String(file.frontmatter['title'] ?? file.path), description: file.body },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { apiKey: linearKey, team: 'ENG', status: trackerStatus }))
  .runner(worktrees)
  .wip(2)
  .handler(buildAndAudit, {
    states: { working: Working, done: Done, deficient: NeedsOwner, failed: NeedsOwner },
    params: { rounds: 3 },
  });

const features = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { apiKey: linearKey, team: 'ENG', labels: ['feature'] }, fromIssue),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { apiKey: linearKey, team: 'ENG', status: trackerStatus }))
  .runner(worktrees)
  .handler(buildAndAudit, {
    states: { working: Working, done: Done, deficient: NeedsOwner, failed: NeedsOwner },
    params: { rounds: 5 },
  });

const bugsBeforeFeatures = H.policy.schedule('bugs-before-features', c => {
  const byWait = [...c.candidates].sort((a, b) => b.waitedMs - a.waitedMs);
  const starved = byWait.filter(candidate => candidate.is(features) && candidate.waitedMs > 4 * 3600000);
  const rest = byWait.filter(candidate => !starved.includes(candidate));
  return { start: [...starved, ...rest.filter(candidate => candidate.is(bugs)), ...rest.filter(candidate => !candidate.is(bugs))] };
});

export const codingHarness = H.harness('project-a')
  .ledger(sqlite.ledger('project-a/.harness/ledger.sqlite'))
  .lanes([bugs, features])
  .schedule(bugsBeforeFeatures)
  .clients([claudeCode.supervisor('project-a-supervisor', ownerConsole, { port: H.slot.port(0) })])
  .projections([markdown.board('project-a/.harness/board.md'), markdown.telemetry('project-a/.harness/telemetry.md')]);

const DocPage = H.work('DocPage')
  .attributes({ path: z.string() })
  .fields({ title: z.string(), body: z.string() })
  .states([Queued, Working, NeedsOwner, Done, WontDo])
  .key(page => page.attributes.path);

const docsExperience = H.memory.experience('docs-experience');
const docsExperienceJournal = H.journal('docs-experience-journal', docsExperience)
  .store(jsonl.memory('project-b/.harness/experience.jsonl'))
  .recall(specificFirst);

const writerRole = H.role('writer')
  .intents(['read', 'write'])
  .instructions('Bring the page up to date and keep its frontmatter intact.')
  .input({ title: z.string(), body: z.string() })
  .output({ summary: z.string() });

const writer = H.agent('writer', writerRole)
  .model(sonnet)
  .pool(sharedPool('docs-pool', 0.3))
  .recalls([docsExperienceJournal, sharedTasteJournal])
  .records(docsExperienceJournal);

const linkCheck = H.command('link-check', ['npx', 'markdown-link-check']);

const docFlow = H.flow('write-and-check')
  .requires({ path: z.string(), title: z.string(), body: z.string() })
  .mark('working')
  .step('write', writer, c => ({ title: c.input.title, body: c.input.body }), { onRestart: 'reconcile' })
  .step('linkCheck', linkCheck, c => ({ args: [c.input.path] }), { onRestart: 'rerun' })
  .ends(['published'], () => 'published');

const docPages = H.lane('doc-pages', DocPage)
  .supply([
    folder.files(DocPage, 'project-b/docs', file => ({
      attributes: { path: file.path },
      fields: { title: String(file.frontmatter['title'] ?? file.path), body: file.body },
    })),
  ])
  .store(folder.frontmatter(DocPage, 'project-b/docs'))
  .runner(local.shell({ slots: 2, cwd: 'project-b' }))
  .handler(docFlow, { states: { working: Working, published: Done, failed: NeedsOwner } });

const oldestDocFirst = H.policy.schedule('oldest-doc-first', c => ({
  start: [...c.candidates].sort((a, b) => b.waitedMs - a.waitedMs),
}));

export const docsHarness = H.harness('project-b')
  .ledger(sqlite.ledger('project-b/.harness/ledger.sqlite'))
  .lanes([docPages])
  .schedule(oldestDocFirst)
  .clients([claudeCode.supervisor('project-b-supervisor', ownerConsole, { port: H.slot.port(1) })])
  .projections([markdown.board('project-b/.harness/board.md')]);
