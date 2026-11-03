import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

export const sharedQuota = sqlite.quota('/home/owner/.harness/claude-quota.sqlite');

export const claudeMax1 = claude.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota: sharedQuota });
export const claudeMax2 = claude.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota: sharedQuota });
export const claudeMax3 = claude.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota: sharedQuota });

export const sonnet = claude.model('claude-sonnet-4-5');
export const haiku = claude.model('claude-haiku-4-5');

export const taste = H.memory('taste', 'taste');
export const experience = H.memory('experience', 'experience');
export const ownerTaste = H.journal('owner-taste', taste, jsonl.memory('/home/owner/.harness/taste.jsonl'));

export const soonestExpiring = H.policy.account('soonest-expiring-subscription-first', choice => {
  const ranked = choice.accounts
    .filter(view => view.eligible && view.usedShare < view.share)
    .sort((a, b) => {
      const planOrder = (a.account.plan === 'subscription' ? 0 : 1) - (b.account.plan === 'subscription' ? 0 : 1);
      if (planOrder !== 0) return planOrder;
      return (a.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY) - (b.windowEndsAt?.getTime() ?? Number.POSITIVE_INFINITY);
    });
  const first = ranked[0];
  return first ? first.account : null;
});

const apiFallback = anthropic.account('coding-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const codingPool = H.pool('coding-accounts', [
  { account: claudeMax1, share: 0.6 },
  { account: claudeMax2, share: 0.6 },
  { account: claudeMax3, share: 0.6 },
  { account: apiFallback, share: 1 },
], soonestExpiring);

const queued = H.state('queued', 'pending');
const done = H.state('done', 'terminal', 'success');
const unfinished = H.state('unfinished', 'terminal', 'failure');

const workData = z.object({ title: z.string(), description: z.string() });
const bug = H.kind('bug').data(workData).states(queued, done, unfinished);
const feature = H.kind('feature').data(workData).states(queued, done, unfinished);

const codingExperience = H.journal('coding-experience', experience, jsonl.memory('./harness/experience.jsonl'));

const worktrees = git.worktree('worktrees', { repo: '.', slots: 3 });
const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(worktrees);

const buildRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Build: ${input.title}\n${input.description}\nOpen deficits:\n${input.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for ${input.title}: ${input.summary}`)
  .intents(['read', 'execute']);

const builderModel = H.policy.model('builder-cheap-until-unreliable', [haiku, sonnet], choice => {
  const cheap = choice.metrics.successRate({ kind: choice.kind, seat: choice.seat, model: haiku, days: 14 });
  return cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85 ? sonnet : haiku;
});

const builder = H.seat('builder', buildRole)
  .model(builderModel)
  .on(worktrees)
  .recalls(ownerTaste, codingExperience)
  .guards(claude.fileLeases(), claude.stopCheck(projectChecks));

const auditor = H.seat('auditor', auditRole)
  .model(sonnet)
  .on(worktrees)
  .recalls(codingExperience)
  .records(codingExperience);

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    let deficits: string[] = [];
    for (let round = 0; round < ctx.params.rounds; round++) {
      const built = await ctx.run(builder, { title: ctx.unit.data.title, description: ctx.unit.data.description, deficits });
      if (!built.ok) return ctx.fail(built.error);
      const audit = await ctx.run(auditor, { title: ctx.unit.data.title, summary: built.value.summary });
      if (!audit.ok) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return 'unfinished';
  });

const linearStatuses = { queued: 'Todo', done: 'Done', unfinished: 'Needs Owner' };

const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'product',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: linearStatuses,
});
const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'product',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: linearStatuses,
});
const bugFolder = folder.files(bug, {
  dir: './bugs',
  read: file => ({ title: file.path, description: file.body }),
});

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .retry({ times: 2, backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'unfinished' })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .retry({ times: 2, backoff: { first: { minutes: 5 }, factor: 2 }, exhausted: 'unfinished' })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

export const coding = H.harness('coding')
  .ledger(sqlite.ledger('./harness/coding-ledger.sqlite'))
  .lanes(bugs, features)
  .pools(codingPool)
  .clients(claude.supervisor({
    grants: [
      H.ops.readWork, H.ops.writeWork, H.ops.writeMemory, H.ops.readTelemetry,
      H.ops.readAccounts, H.ops.setShares, H.ops.resolve(H.halts.interrupted, H.halts.definitionChanged),
    ],
  }))
  .observers(markdown.board('./harness/BOARD.md'), markdown.telemetry('./harness/TELEMETRY.md'));

const docsPool = H.pool('docs-accounts', [
  { account: claudeMax1, share: 0.3 },
  { account: claudeMax2, share: 0.3 },
  { account: claudeMax3, share: 0.3 },
], soonestExpiring);

const stale = H.state('stale', 'pending');
const published = H.state('published', 'terminal', 'success');
const brokenLinks = H.state('broken-links', 'terminal', 'failure');
const docPage = H.kind('doc-page').data(z.object({ path: z.string(), body: z.string() })).states(stale, published, brokenLinks);

const docsExperience = H.journal('docs-experience', experience, jsonl.memory('./docs-harness/experience.jsonl'));
const docsRunner = shell.local('docs-shell', { slots: 2 });

const writerRole = H.role('writer')
  .input(z.object({ path: z.string(), body: z.string() }))
  .output(z.object({ markdown: z.string() }))
  .prompt(input => `Revise the page at ${input.path}:\n${input.body}`);

const writer = H.seat('writer', writerRole).model(sonnet).recalls(ownerTaste, docsExperience);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .argv(input => ['npx', 'linkcheck', '--json', input.path])
  .on(docsRunner);

const writeDoc = H.flow('write-doc').for(docPage).does(async ctx => {
  const written = await ctx.run(writer, { path: ctx.unit.data.path, body: ctx.unit.data.body });
  if (!written.ok) return ctx.fail(written.error);
  await ctx.update({ body: written.value.markdown });
  const checked = await ctx.run(linkCheck, { path: ctx.unit.data.path });
  if (!checked.ok) return ctx.fail(checked.error);
  return checked.value.broken.length === 0 ? 'published' : 'broken-links';
});

const docFolder = folder.files(docPage, {
  dir: './docs',
  read: file => ({ path: file.path, body: file.body }),
});

const docs = H.lane('docs', docPage)
  .handler(writeDoc)
  .retry({ times: 1, exhausted: 'broken-links' })
  .suppliers(docFolder)
  .store(docFolder);

export const documentation = H.harness('documentation')
  .ledger(sqlite.ledger('./docs-harness/ledger.sqlite'))
  .lanes(docs)
  .pools(docsPool)
  .clients(claude.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares, H.ops.writeMemory],
  }))
  .observers(markdown.board('./docs-harness/BOARD.md'));
