import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as folder from 'harness-dsl/folder';
import * as git from 'harness-dsl/git';
import * as http from 'harness-dsl/http';
import * as jsonl from 'harness-dsl/jsonl';
import * as linear from 'harness-dsl/linear';
import * as markdown from 'harness-dsl/markdown';
import * as sqlite from 'harness-dsl/sqlite';

const subscriptions = [
  claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN') }),
  claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN') }),
  claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN') }),
];
const sharedQuota = '~/.harness/claude-quota.sqlite';
const sonnet = anthropic.model('claude-sonnet-4-5');
const opus = anthropic.model('claude-opus-4-1');

const ownerTasteKind = H.memory('owner-taste', 'taste');
const projectExperience = H.memory('project-experience', 'experience');
const ownerTaste = H.library('owner-taste', ownerTasteKind, jsonl.memory('~/.harness/owner-taste.jsonl'));

const subscriptionsFirstSoonestExpiring = H.policy.account('subscriptions-soonest-expiring', ({ accounts }) => {
  const usable = accounts.filter(view => view.eligible && view.usedShare < view.share);
  const ordered = [...usable].sort((x, y) =>
    (x.account.plan === 'subscription' ? 0 : 1) - (y.account.plan === 'subscription' ? 0 : 1)
    || (x.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER) - (y.windowEndsAt?.getTime() ?? Number.MAX_SAFE_INTEGER));
  return ordered[0]?.account ?? null;
});

const supervisorGrants = [
  H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory,
  H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares,
];

const queued = H.state('queued', 'pending');
const building = H.state('building', 'active');
const done = H.state('done', 'terminal', 'success');
const abandoned = H.state('abandoned', 'terminal', 'failure');

const ticket = z.object({ title: z.string(), description: z.string() });
const Bug = H.kind('bug').data(ticket).states(queued, building, done, abandoned);
const Feature = H.kind('feature').data(ticket).states(queued, building, done, abandoned);

const codingExperience = H.library('coding-experience', projectExperience, jsonl.memory('coding/.harness/experience.jsonl'));
const codeRepo = git.worktree('code', { repo: 'coding', slots: 3 });

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), feedback: z.string() }))
  .output(z.object({ summary: z.string(), needsOwner: z.boolean(), question: z.string() }))
  .prompt(input => `Implement: ${input.title}\n\n${input.description}\n\nOpen deficits:\n${input.feedback}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}". Builder summary:\n${input.summary}`)
  .intents(['read', 'execute']);

const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(codeRepo);

const builderModel = H.policy.model('builder-model', ({ kind, metrics }) => {
  const cheap = metrics.successRate({ kind, model: sonnet, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? opus : sonnet;
});

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .on(codeRepo)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks))
  .recalls(ownerTaste, codingExperience);

const auditor = H.agent('auditor', auditorRole).model(opus).on(codeRepo).recalls(codingExperience).records(codingExperience);

const ownerDecision = H.halt('owner-decision', z.object({ action: z.enum(['continue', 'abandon']), note: z.string() }));

const ticketWork = H.flow('ticket-work').for(Bug, Feature).params(z.object({ rounds: z.number() })).does(async ctx => {
  await ctx.move('building');
  const { title, description } = ctx.unit.data;
  let feedback = '';
  for (let round = 1; round <= ctx.params.rounds; round++) {
    const built = await ctx.run(builder, { title, description, feedback });
    if (!built.ok) return ctx.fail(built.error);
    if (built.value.needsOwner) {
      const decision = await ctx.halt(ownerDecision, built.value.question);
      if (decision.action === 'abandon') return 'abandoned';
      feedback = decision.note;
      continue;
    }
    const audit = await ctx.run(auditor, { title, summary: built.value.summary });
    if (!audit.ok) return ctx.fail(audit.error);
    if (audit.value.deficits.length === 0) return 'done';
    feedback = audit.value.deficits.join('\n');
  }
  return ctx.fail(`deficits remain after ${ctx.params.rounds} rounds`);
});

const linearKey = H.env('LINEAR_API_KEY');
const statuses = { queued: 'Todo', building: 'In Progress', done: 'Done', abandoned: 'Canceled' };
const bugTracker = linear.tracker(Bug, { apiKey: linearKey, team: 'PROD', label: 'bug', read: issue => ({ title: issue.title, description: issue.description }), statuses });
const featureTracker = linear.tracker(Feature, { apiKey: linearKey, team: 'PROD', label: 'feature', read: issue => ({ title: issue.title, description: issue.description }), statuses });

const bugs = H.lane('bugs', Bug).handler(ticketWork, { params: { rounds: 3 } }).suppliers(bugTracker, H.operator).store(bugTracker).wip(2);
const features = H.lane('features', Feature).handler(ticketWork, { params: { rounds: 5 } }).suppliers(featureTracker, H.operator).store(featureTracker);

const codingPool = H.pool('claude-coding', [
  ...subscriptions.map(account => ({ account, share: 0.6 })),
  { account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
], subscriptionsFirstSoonestExpiring);

export const coding = H.harness('coding-team')
  .ledger(sqlite.ledger('coding/.harness/ledger.sqlite', { sharedQuota }))
  .lanes(bugs, features)
  .pools(codingPool)
  .clients(
    claudeCode.supervisor({ grants: supervisorGrants }),
    http.control({ port: 7401, token: H.env('CODING_CONTROL_TOKEN'), grants: supervisorGrants }),
  )
  .observers(markdown.board('coding/BOARD.md'), markdown.telemetry('coding/TELEMETRY.md'));

const stale = H.state('stale', 'pending');
const writing = H.state('writing', 'active');
const published = H.state('published', 'terminal', 'success');
const retired = H.state('retired', 'terminal', 'neutral');

const DocPage = H.kind('doc-page').data(z.object({ title: z.string(), path: z.string() })).states(stale, writing, published, retired);

const docsExperience = H.library('docs-experience', projectExperience, jsonl.memory('docs/.harness/experience.jsonl'));
const docsRepo = git.worktree('docs', { repo: 'docs', slots: 2 });

const writerRole = H.role('writer')
  .input(z.object({ title: z.string(), path: z.string(), brokenLinks: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Bring ${input.path} ("${input.title}") up to date. Broken links to fix:\n${input.brokenLinks.join('\n')}`)
  .intents(['read', 'edit']);

const writer = H.agent('writer', writerRole).model(sonnet).on(docsRepo).recalls(ownerTaste, docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .argv(input => ['link-check', '--json', input.path])
  .on(docsRepo);

const docWork = H.flow('doc-work').for(DocPage).does(async ctx => {
  await ctx.move('writing');
  const { title, path } = ctx.unit.data;
  let brokenLinks: readonly string[] = [];
  for (let pass = 1; pass <= 2; pass++) {
    const written = await ctx.run(writer, { title, path, brokenLinks: [...brokenLinks] });
    if (!written.ok) return ctx.fail(written.error);
    const checked = await ctx.run(linkCheck, { path });
    if (!checked.ok) return ctx.fail(checked.error);
    if (checked.value.broken.length === 0) return 'published';
    brokenLinks = checked.value.broken;
  }
  return ctx.fail(`broken links remain: ${brokenLinks.join(', ')}`);
});

const docsFolder = folder.files(DocPage, {
  dir: 'docs/pages',
  read: file => ({ title: typeof file.frontmatter.title === 'string' ? file.frontmatter.title : file.path, path: file.path }),
});

const pages = H.lane('pages', DocPage).handler(docWork).suppliers(docsFolder).store(docsFolder).wip(2);

const docsPool = H.pool('claude-docs', subscriptions.map(account => ({ account, share: 0.3 })), subscriptionsFirstSoonestExpiring);

export const docs = H.harness('documentation')
  .ledger(sqlite.ledger('docs/.harness/ledger.sqlite', { sharedQuota }))
  .lanes(pages)
  .pools(docsPool)
  .clients(
    claudeCode.supervisor({ grants: supervisorGrants }),
    http.control({ port: 7402, token: H.env('DOCS_CONTROL_TOKEN'), grants: supervisorGrants }),
  )
  .observers(markdown.board('docs/BOARD.md'), markdown.telemetry('docs/TELEMETRY.md'));
