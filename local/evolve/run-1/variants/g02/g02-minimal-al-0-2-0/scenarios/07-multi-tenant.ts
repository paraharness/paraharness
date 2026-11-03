import { H } from 'harness-dsl';
import { z } from 'zod';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const sharedQuota = '~/.harness/shared-quota.db';

const subscriptions = [
  claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_TOKEN_1') }),
  claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_TOKEN_2') }),
  claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_TOKEN_3') }),
];

const soonestExpiring = H.policy.account('soonest-expiring', (choice) => {
  const usable = choice.accounts.filter((a) => a.eligible && a.usedShare < a.share);
  const sorted = [...usable].sort(
    (x, y) => (x.windowEndsAt ? x.windowEndsAt.getTime() : Infinity) - (y.windowEndsAt ? y.windowEndsAt.getTime() : Infinity)
  );
  return sorted.length > 0 ? sorted[0].account : null;
});

const ownerTaste = H.memory('owner-taste', 'taste');
const experience = H.memory('experience', 'experience');
const sharedTasteArchive = H.archive('owner-taste', ownerTaste, jsonl.memory('~/.harness/owner-taste.jsonl'));

const sonnet = claudeCode.model('claude-sonnet-4');

const supervisorGrants = [
  H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory,
  H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares,
];

const queued = H.state('queued', 'pending');
const building = H.state('building', 'active');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');

const ticket = z.object({ title: z.string(), description: z.string() });

const Bug = H.kind('Bug').data(ticket).states(queued, building, done, abandoned).failsTo('abandoned');
const Feature = H.kind('Feature').data(ticket).states(queued, building, done, abandoned).failsTo('abandoned');

const codingExperience = H.archive('coding-experience', experience, jsonl.memory('coding/.harness/experience.jsonl'));
const codingBriefing = H.briefing('coding-briefing', [sharedTasteArchive, codingExperience]);

const worktree = git.worktree('worktree', { repo: '.', slots: 3 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktree).recovers('rerun');

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt((i) => `Implement: ${i.title}\n\n${i.description}\n\nOpen deficits:\n${i.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((i) => `Audit the change for "${i.title}". Builder summary:\n${i.summary}\nList remaining deficits, or none.`)
  .intents(['read', 'execute']);

const builder = H.agent('builder', builderRole)
  .model(sonnet)
  .on(worktree)
  .recalls(codingBriefing)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(sonnet)
  .on(worktree)
  .recalls(codingBriefing)
  .records(codingExperience);

const buildAndAudit = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int() }))
  .does(async (ctx) => {
    let deficits: string[] = [];
    for (let round = 0; round < ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title: ctx.unit.data.title, description: ctx.unit.data.description, deficits });
      if (!built.ok) return ctx.fail(built.error);
      const audit = await ctx.run(auditor, { title: ctx.unit.data.title, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail('rounds exhausted with deficits remaining');
  });

const ticketStatuses = { queued: 'Todo', building: 'In Progress', done: 'Done', abandoned: 'Canceled' };

const bugTracker = linear.tracker(Bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'bug',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: ticketStatuses,
});

const featureTracker = linear.tracker(Feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  label: 'feature',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: ticketStatuses,
});

const threeTries = H.policy.retry('three-tries', (view) =>
  view.failures >= 3 ? 'stop' : { retryInMs: 60_000 * 2 ** view.failures }
);

const bugs = H.lane('bugs', Bug)
  .handler(buildAndAudit, { rounds: 3 })
  .suppliers(bugTracker, H.operator)
  .store(bugTracker)
  .wip(2)
  .retry(threeTries);

const features = H.lane('features', Feature)
  .handler(buildAndAudit, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker)
  .retry(threeTries);

const codingPool = H.pool(
  'coding-subscriptions',
  subscriptions.map((account) => ({ account, share: 0.6 })),
  soonestExpiring
);

export const coding = H.harness('coding-team')
  .ledger(sqlite.ledger('coding/.harness/ledger.db', { sharedQuota }))
  .lanes(bugs, features)
  .pools(codingPool)
  .clients(http.control({ port: 7401, token: H.env('CODING_CONTROL_TOKEN'), grants: supervisorGrants }))
  .observers(markdown.board('coding/BOARD.md'), markdown.telemetry('coding/TELEMETRY.md'));

const stale = H.state('stale', 'pending');
const writing = H.state('writing', 'active');
const published = H.state('published', 'terminal', 'success');
const broken = H.state('broken', 'terminal', 'failure');

const DocPage = H.kind('DocPage')
  .data(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .states(stale, writing, published, broken)
  .failsTo('broken');

const docsExperience = H.archive('docs-experience', experience, jsonl.memory('docs/.harness/experience.jsonl'));
const docsBriefing = H.briefing('docs-briefing', [sharedTasteArchive, docsExperience]);

const docsRunner = shell.local('docs-local', { slots: 2 });

const writerRole = H.role('writer')
  .input(z.object({ title: z.string(), body: z.string(), brokenLinks: z.array(z.string()) }))
  .output(z.object({ body: z.string() }))
  .prompt((i) => `Revise the page "${i.title}". Fix these broken links: ${i.brokenLinks.join(', ')}\n\n${i.body}`)
  .intents(['read']);

const writer = H.agent('writer', writerRole).model(sonnet).recalls(docsBriefing).records(docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .argv((i) => ['lychee', '--format', 'json', i.path])
  .on(docsRunner)
  .recovers('rerun');

const docFlow = H.flow('doc-page').for(DocPage).does(async (ctx) => {
  let brokenLinks: string[] = [];
  for (let round = 0; round < 2; round++) {
    const written = await ctx.run(writer, { title: ctx.unit.data.title, body: ctx.unit.data.body, brokenLinks });
    if (!written.ok) return ctx.fail(written.error);
    await ctx.update({ body: written.value.body });
    const checked = await ctx.run(linkCheck, { path: ctx.unit.data.path });
    if (!checked.ok) return ctx.fail(checked.error);
    if (checked.value.broken.length === 0) return 'published';
    brokenLinks = checked.value.broken;
  }
  return ctx.fail('links still broken');
});

const docsFolder = folder.files(DocPage, {
  dir: 'docs/pages',
  read: (file) => ({ path: file.path, title: String(file.frontmatter['title'] ?? file.path), body: file.body }),
  write: (data, state) => ({ title: data.title, status: state }),
});

const docPages = H.lane('doc-pages', DocPage)
  .handler(docFlow)
  .suppliers(docsFolder)
  .store(docsFolder)
  .retry(threeTries);

const docsPool = H.pool(
  'docs-subscriptions',
  subscriptions.map((account) => ({ account, share: 0.3 })),
  soonestExpiring
);

export const docs = H.harness('documentation')
  .ledger(sqlite.ledger('docs/.harness/ledger.db', { sharedQuota }))
  .lanes(docPages)
  .pools(docsPool)
  .clients(http.control({ port: 7402, token: H.env('DOCS_CONTROL_TOKEN'), grants: supervisorGrants }))
  .observers(markdown.board('docs/BOARD.md'), markdown.telemetry('docs/TELEMETRY.md'));

export const apiFallback = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
