import { z } from 'zod';
import { H, Account, AccountPolicy } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

const sharedQuota = sqlite.quota('~/.harness/shared-quota.db');
const sharedAccounts: readonly Account[] = [
  claudeCode.subscription('claude-a', { token: H.env('CLAUDE_A_TOKEN'), quota: sharedQuota }),
  claudeCode.subscription('claude-b', { token: H.env('CLAUDE_B_TOKEN'), quota: sharedQuota }),
  claudeCode.subscription('claude-c', { token: H.env('CLAUDE_C_TOKEN'), quota: sharedQuota }),
];
const Taste = H.memory('taste', 'owner');
const sharedTaste = H.library('owner-taste', Taste, jsonl.memory('~/.harness/taste.jsonl'));
const Experience = H.memory('experience', 'fallible');

const soonestExpiringFirst: AccountPolicy = H.policy.account('soonest-expiring-first', choice =>
  [...choice.accounts]
    .filter(view => view.eligible)
    .sort((a, b) => (a.windowEndsAt?.getTime() ?? Infinity) - (b.windowEndsAt?.getTime() ?? Infinity))[0]?.account ?? null);

const poolWithShare = (name: string, share: number) =>
  H.pool(name, sharedAccounts.map(account => ({ account, share })), soonestExpiringFirst);

const sonnet = claudeCode.model('claude-sonnet');
const opus = claudeCode.model('claude-opus');

const codingExperience = H.library('coding-experience', Experience, jsonl.memory('memory/coding-experience.jsonl'));

const ticket = z.object({ title: z.string(), description: z.string(), issueId: z.string().optional() });
const ticketLifecycle = H.lifecycle({
  todo: 'pending',
  building: 'active',
  auditing: 'active',
  done: 'succeeded',
  abandoned: 'failed',
  cancelled: 'cancelled',
});
const Bug = H.kind('Bug').data(ticket).states(ticketLifecycle, 'todo');
const Feature = H.kind('Feature').data(ticket).states(ticketLifecycle, 'todo');

const worktrees = git.worktree('worktrees', { repo: '.', slots: 3 });
const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees);

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Implement: ${input.title}\n\n${input.description}\n\n${input.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute', 'ask']);
const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit "${input.title}":\n\n${input.summary}`)
  .intents(['read', 'execute']);

const builderModel = H.policy.model('builder-model', choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, model: sonnet.name, days: 14 });
  return cheap.samples < 20 || (cheap.value ?? 0) >= 0.85 ? sonnet : opus;
});

const builder = H.agent('builder', builderRole).model(builderModel).on(worktrees)
  .recalls(codingExperience, sharedTaste)
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks));
const auditor = H.agent('auditor', auditorRole).model(opus).on(worktrees)
  .recalls(codingExperience).records(codingExperience);

const ticketFlow = H.flow('build-and-audit')
  .for(Bug, Feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .does(async ctx => {
    const { title, description } = ctx.unit.data;
    let deficits: readonly string[] = [];
    for (let round = 1; round <= ctx.params.rounds; round++) {
      await ctx.move('building');
      const built = await ctx.run(builder, { title, description, deficits: [...deficits] });
      if (!built.ok) return 'abandoned';
      await ctx.move('auditing');
      const audit = await ctx.run(auditor, { title, summary: built.value.summary });
      if (!audit.ok) return 'abandoned';
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return 'abandoned';
  });

const statuses = { todo: 'Todo', building: 'In Progress', auditing: 'In Review', done: 'Done', abandoned: 'Canceled', cancelled: 'Canceled' };
const linearBugs = linear.tracker(Bug, {
  apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', label: 'bug', statuses,
  read: issue => ({ title: issue.title, description: issue.description, issueId: issue.id }),
});
const linearFeatures = linear.tracker(Feature, {
  apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', label: 'feature', statuses,
  read: issue => ({ title: issue.title, description: issue.description, issueId: issue.id }),
});

const bugLane = H.lane('bugs', Bug).handler(ticketFlow, { rounds: 3 }).suppliers(linearBugs, H.operator).store(linearBugs).wip(2);
const featureLane = H.lane('features', Feature).handler(ticketFlow, { rounds: 5 }).suppliers(linearFeatures, H.operator).store(linearFeatures);

const supervisorGrants = [
  H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readMemory, H.ops.writeMemory,
  H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares,
];

export const codingHarness = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/coding-ledger.db'))
  .lanes(bugLane, featureLane)
  .pools(poolWithShare('claude-coding', 0.6))
  .clients(http.control({ port: 7801, token: H.env('CODING_CONTROL_TOKEN'), grants: supervisorGrants }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));

const DocPage = H.kind('DocPage').data(z.object({ path: z.string(), title: z.string(), body: z.string() })).states({
  stale: 'pending',
  writing: 'active',
  checking: 'active',
  published: 'succeeded',
  broken: 'failed',
}, 'stale');

const docsExperience = H.library('docs-experience', Experience, jsonl.memory('memory/docs-experience.jsonl'));
const docsRunner = shell.local('docs-workspace', { slots: 2 });

const writerRole = H.role('writer')
  .input(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Revise the documentation page ${input.path} ("${input.title}"):\n\n${input.body}`)
  .intents(['read', 'edit']);
const writer = H.agent('writer', writerRole).model(sonnet).on(docsRunner)
  .recalls(sharedTaste, docsExperience).records(docsExperience);
const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(input => ['link-check', input.path])
  .on(docsRunner);

const docFlow = H.flow('write-and-check').for(DocPage).does(async ctx => {
  await ctx.move('writing');
  const written = await ctx.run(writer, ctx.unit.data);
  if (!written.ok) return 'broken';
  await ctx.move('checking');
  const links = await ctx.run(linkCheck, { path: ctx.unit.data.path });
  return links.ok ? 'published' : 'broken';
});

const docFiles = folder.files(DocPage, {
  dir: 'docs',
  read: file => ({ path: file.path, title: String(file.frontmatter.title ?? file.path), body: file.body }),
  write: (_data, state) => ({ status: state }),
});

const docLane = H.lane('doc-pages', DocPage).handler(docFlow).suppliers(docFiles).store(docFiles);

export const docsHarness = H.harness('documentation')
  .ledger(sqlite.ledger('.harness/docs-ledger.db'))
  .lanes(docLane)
  .pools(poolWithShare('claude-docs', 0.3))
  .clients(http.control({ port: 7802, token: H.env('DOCS_CONTROL_TOKEN'), grants: supervisorGrants }))
  .observers(markdown.board('DOCS-BOARD.md'), markdown.telemetry('DOCS-TELEMETRY.md'));
