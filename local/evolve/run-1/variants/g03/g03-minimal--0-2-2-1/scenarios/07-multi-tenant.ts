import { z } from 'zod';
import { H } from 'harness-dsl';
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

const sharedQuota = '~/.harness/account-quota.db';

const shared = {
  maxOne: claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') }),
  maxTwo: claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN') }),
  maxThree: claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN') }),
  sonnet: anthropic.model('claude-sonnet-4-5'),
  ownerTaste: H.library('owner-taste', H.memory('taste', 'taste'), jsonl.memory('~/.harness/owner-taste.jsonl')),
  drainSoonestExpiring: H.policy.account('drain-soonest-expiring', ({ accounts }) => {
    const usable = accounts.filter((a) => a.eligible && a.usedShare < a.share);
    const ordered = [...usable].sort((x, y) =>
      x.account.plan === y.account.plan
        ? (x.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (y.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER)
        : x.account.plan === 'subscription' ? -1 : 1
    );
    return ordered[0]?.account ?? null;
  }),
};

const ticket = z.object({ title: z.string(), description: z.string() });

const queued = H.state('queued', 'pending');
const building = H.state('building', 'active');
const shipped = H.state('shipped', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');

const bug = H.kind('bug').data(ticket).states(queued, building, shipped, abandoned).failsTo('abandoned');
const feature = H.kind('feature').data(ticket).states(queued, building, shipped, abandoned).failsTo('abandoned');

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), round: z.number(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().nullable() }))
  .prompt((t) => `Round ${t.round}. Implement: ${t.title}\n\n${t.description}\n\nOpen deficits:\n${t.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), description: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((t) => `Audit the change for "${t.title}". Builder summary: ${t.summary}. List every deficit that remains.`)
  .intents(['read', 'execute']);

const codingExperience = H.library('coding-experience', H.memory('coding-lessons', 'experience'), jsonl.memory('coding/.harness/experience.jsonl'));

const codingShell = shell.local('coding-shell', { slots: 2 });
const codingWorktree = git.worktree('coding-worktree', { repo: '.', slots: 2 });

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(codingShell);

const builder = H.agent('builder', builderRole)
  .model(shared.sonnet)
  .on(codingWorktree)
  .recalls(shared.ownerTaste, codingExperience)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));

const auditor = H.agent('auditor', auditorRole)
  .model(shared.sonnet)
  .on(codingWorktree)
  .recalls(codingExperience)
  .records(codingExperience);

const ownerDecision = H.halt('owner-decision', z.object({
  action: z.enum(['continue', 'abandon']),
  guidance: z.string(),
}));

const ticketWork = H.flow('ticket-work')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async (ctx) => {
    await ctx.move('building');
    const { title, description } = ctx.unit.data;
    let deficits: string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round += 1) {
      const built = await ctx.run(builder, { title, description, round, deficits });
      if (!built.ok) return ctx.fail(built.error);
      if (built.value.question !== null) {
        const answer = await ctx.halt(ownerDecision, built.value.question);
        if (answer.action === 'abandon') return 'abandoned';
        deficits = [answer.guidance];
        continue;
      }
      const audit = await ctx.run(auditor, { title, description, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'shipped';
      deficits = audit.value.deficits;
    }
    return 'abandoned';
  });

const ticketStatuses = { queued: 'Todo', building: 'In Progress', shipped: 'Done', abandoned: 'Canceled' };

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'bug',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: ticketStatuses,
});

const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  label: 'feature',
  read: (issue) => ({ title: issue.title, description: issue.description }),
  statuses: ticketStatuses,
});

const bugs = H.lane('bugs', bug)
  .handler(ticketWork, { params: { rounds: 3 } })
  .suppliers(bugTracker, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', feature)
  .handler(ticketWork, { params: { rounds: 5 } })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const codingApi = anthropic.account('coding-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const codingPool = H.pool('coding-accounts', [
  { account: shared.maxOne, share: 0.6 },
  { account: shared.maxTwo, share: 0.6 },
  { account: shared.maxThree, share: 0.6 },
  { account: codingApi, share: 1 },
], shared.drainSoonestExpiring);

const bugsBeforeFeatures = H.policy.scheduler('bugs-before-features', ({ pending }) => ({
  start: [...pending.filter((u) => u.is(bug)), ...pending.filter((u) => u.is(feature))],
}));

export const codingHarness = H.harness('coding-team')
  .ledger(sqlite.ledger('coding/.harness/ledger.db', { sharedQuota }))
  .lanes(bugs, features)
  .pools(codingPool)
  .scheduler(bugsBeforeFeatures)
  .clients(http.control({
    port: 7401,
    token: H.env('CODING_CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
  }))
  .observers(markdown.board('coding/BOARD.md'), markdown.telemetry('coding/TELEMETRY.md'));

const docPageData = z.object({ title: z.string(), path: z.string() });

const docQueued = H.state('doc-queued', 'pending');
const docWriting = H.state('doc-writing', 'active');
const docPublished = H.state('doc-published', 'terminal', 'success');
const docStuck = H.state('doc-stuck', 'terminal', 'failure');

const docPage = H.kind('doc-page').data(docPageData).states(docQueued, docWriting, docPublished, docStuck).failsTo('doc-stuck');

const writerRole = H.role('writer')
  .input(docPageData)
  .output(z.object({ summary: z.string() }))
  .prompt((p) => `Write or revise the documentation page "${p.title}" at ${p.path}.`)
  .intents(['read', 'edit']);

const docsExperience = H.library('docs-experience', H.memory('docs-lessons', 'experience'), jsonl.memory('docs/.harness/experience.jsonl'));

const docsShell = shell.local('docs-shell', { slots: 2 });
const docsWorktree = git.worktree('docs-worktree', { repo: '../docs', slots: 2 });

const writer = H.agent('writer', writerRole)
  .model(shared.sonnet)
  .on(docsWorktree)
  .recalls(shared.ownerTaste, docsExperience)
  .records(docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv((p) => ['lychee', '--offline', p.path])
  .on(docsShell);

const docWork = H.flow('doc-work').for(docPage).does(async (ctx) => {
  await ctx.move('doc-writing');
  const written = await ctx.run(writer, ctx.unit.data);
  if (!written.ok) return ctx.fail(written.error);
  const links = await ctx.run(linkCheck, { path: ctx.unit.data.path });
  if (!links.ok) return ctx.fail(`broken links: ${links.error}`);
  return 'doc-published';
});

const docFolder = folder.files(docPage, {
  dir: '../docs/pages',
  read: (file) => {
    const title = file.frontmatter['title'];
    return { title: typeof title === 'string' ? title : file.path, path: file.path };
  },
});

const docPages = H.lane('doc-pages', docPage)
  .handler(docWork)
  .suppliers(docFolder)
  .store(docFolder)
  .wip(2);

const docsPool = H.pool('docs-accounts', [
  { account: shared.maxOne, share: 0.3 },
  { account: shared.maxTwo, share: 0.3 },
  { account: shared.maxThree, share: 0.3 },
], shared.drainSoonestExpiring);

export const docsHarness = H.harness('documentation')
  .ledger(sqlite.ledger('docs/.harness/ledger.db', { sharedQuota }))
  .lanes(docPages)
  .pools(docsPool)
  .clients(http.control({
    port: 7402,
    token: H.env('DOCS_CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
  }))
  .observers(markdown.board('docs/BOARD.md'), markdown.telemetry('docs/TELEMETRY.md'));
