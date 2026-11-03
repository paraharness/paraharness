import { z } from 'zod';
import { H } from 'harness-dsl';
import type { PendingView } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const ownerQuota = sqlite.quota('/srv/owner/shared/quota.db');

const sharedSubscriptions = [
  claudeCode.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota: ownerQuota }),
  claudeCode.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota: ownerQuota }),
  claudeCode.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota: ownerQuota }),
];
const sharedApiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: ownerQuota });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', choice => {
  const open = choice.accounts.filter(view => view.eligible && view.account.plan === 'subscription' && view.usedShare < view.share);
  const ordered = [...open].sort(
    (a, b) => (a.windowEndsAt ? a.windowEndsAt.getTime() : Infinity) - (b.windowEndsAt ? b.windowEndsAt.getTime() : Infinity)
  );
  const first = ordered[0];
  if (first) return first.account;
  const metered = choice.accounts.find(view => view.eligible && view.account.plan === 'metered');
  return metered ? metered.account : null;
});

function sharedPool(projectShare: number) {
  return H.pool(
    'owner-accounts',
    [...sharedSubscriptions.map(account => ({ account, share: projectShare })), { account: sharedApiAccount, share: 1 }],
    soonestExpiringFirst
  );
}

const sharedTaste = H.journal('owner-taste', H.memory('taste', 'taste'), jsonl.memory('/srv/owner/shared/taste.jsonl'));
const cheapModel = claudeCode.model('claude-sonnet-4-5');
const strongModel = claudeCode.model('claude-opus-4-1');

const codingExperience = H.journal(
  'coding-experience',
  H.memory('coding-experience', 'experience'),
  jsonl.memory('/srv/coding-team/memory/experience.jsonl')
);

const todo = H.state('todo', 'pending');
const done = H.state('done', 'terminal', 'success');
const wontDo = H.state('wont-do', 'terminal', 'neutral');

const workItem = z.object({ title: z.string(), description: z.string() });
const bug = H.kind('bug').data(workItem).states(todo, done, wontDo);
const feature = H.kind('feature').data(workItem).states(todo, done, wontDo);

const checksRunner = shell.local('checks', { slots: 2 });
const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']).on(checksRunner);

const builderRole = H.role('builder')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Build: ${input.title}\n${input.description}\nOpen deficits:\n${input.deficits.join('\n')}`)
  .intents(['read', 'edit', 'execute']);

const auditorRole = H.role('auditor')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}". Builder summary: ${input.summary}`)
  .intents(['read', 'execute']);

const builderModel = H.policy.model('cheap-until-it-slips', choice => {
  const record = choice.metrics.successRate({ kind: choice.kind, model: cheapModel, days: 14 });
  return record.samples >= 20 && record.value !== null && record.value < 0.85 ? strongModel : cheapModel;
});

const builder = H.seat('builder', builderRole)
  .model(builderModel)
  .on(git.worktree('worktree', { repo: '/srv/coding-team/repo', slots: 3 }))
  .guards(claudeCode.fileLeases(), claudeCode.stopCheck(projectChecks))
  .recalls(codingExperience, sharedTaste);

const auditor = H.seat('auditor', auditorRole).model(strongModel).recalls(codingExperience).records(codingExperience);

const ownerDecision = H.halt('owner-decision', z.object({ proceed: z.boolean(), answer: z.string() })).about(
  z.object({ question: z.string() })
);

const buildAndAudit = H.flow('build-and-audit')
  .for(bug, feature)
  .params(z.object({ rounds: z.number() }))
  .does(async ctx => {
    let deficits: string[] = [];
    let ownerAnswer = '';
    for (let round = 0; round < ctx.params.rounds; round++) {
      const built = await ctx.run(builder, {
        title: ctx.unit.data.title,
        description: `${ctx.unit.data.description}\n${ownerAnswer}`,
        deficits,
      });
      if (built.ok === false) return ctx.fail(built.error);
      const question = built.value.question;
      if (question) {
        const decision = await ctx.halt(ownerDecision, question, { question });
        if (decision.proceed === false) return 'wont-do';
        ownerAnswer = decision.answer;
      }
      const audit = await ctx.run(auditor, { title: ctx.unit.data.title, summary: built.value.summary });
      if (audit.ok === false) return ctx.fail(audit.error);
      if (audit.value.deficits.length === 0) return 'done';
      deficits = audit.value.deficits;
    }
    return ctx.fail('deficits remain after the last round');
  });

const trackerStatuses = { todo: 'Todo', done: 'Done', 'wont-do': 'Canceled' };
const bugTracker = linear.tracker(bug, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'core',
  label: 'bug',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: trackerStatuses,
});
const featureTracker = linear.tracker(feature, {
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'core',
  label: 'feature',
  read: issue => ({ title: issue.title, description: issue.description }),
  statuses: trackerStatuses,
});
const bugFolder = folder.files(bug, {
  dir: '/srv/coding-team/bugs',
  read: file => ({ title: file.path, description: file.body }),
});

const bugs = H.lane('bugs', bug)
  .handler(buildAndAudit, { rounds: 3 })
  .suppliers(bugTracker, bugFolder, H.operator)
  .store(bugTracker)
  .wip(2);

const features = H.lane('features', feature)
  .handler(buildAndAudit, { rounds: 5 })
  .suppliers(featureTracker, H.operator)
  .store(featureTracker);

const bugsBeforeFeatures = H.policy.scheduler('bugs-before-features', view => {
  const rank = (unit: PendingView): number => (unit.lane === bugs.name ? 0 : 1);
  return { start: [...view.pending].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const productionProbe = H.command('production-health-probe')
  .argv(() => ['curl', '-fsS', 'https://example.internal/health'])
  .on(checksRunner);

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('/srv/coding-team/ledger.db'))
  .lanes(bugs, features)
  .pools(sharedPool(0.6))
  .scheduler(bugsBeforeFeatures)
  .clients(
    claudeCode.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(ownerDecision),
        H.ops.writeMemory,
        H.ops.readTelemetry,
        H.ops.readAccounts,
        H.ops.setShares,
        H.operation('production-health-probe', productionProbe),
      ],
    })
  )
  .observers(markdown.board('/srv/coding-team/BOARD.md'), markdown.telemetry('/srv/coding-team/TELEMETRY.md'));

const docsExperience = H.journal(
  'docs-experience',
  H.memory('docs-experience', 'experience'),
  jsonl.memory('/srv/docs/memory/experience.jsonl')
);

const pagePending = H.state('page-pending', 'pending');
const pagePublished = H.state('page-published', 'terminal', 'success');

const docPage = H.kind('doc-page')
  .data(z.object({ path: z.string(), title: z.string(), body: z.string() }))
  .states(pagePending, pagePublished);

const docsFolder = folder.files(docPage, {
  dir: '/srv/docs/pages',
  read: file => ({ path: file.path, title: String(file.frontmatter['title'] ?? file.path), body: file.body }),
  key: file => file.path,
});

const writerRole = H.role('writer')
  .input(z.object({ title: z.string(), body: z.string(), brokenLinks: z.array(z.string()) }))
  .output(z.object({ body: z.string() }))
  .prompt(input => `Revise the page "${input.title}".\nBroken links:\n${input.brokenLinks.join('\n')}\n\n${input.body}`)
  .intents(['read']);

const writer = H.seat('writer', writerRole).model(cheapModel).recalls(docsExperience, sharedTaste);

const docsRunner = shell.local('docs-local', { slots: 2 });
const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .argv(input => ['npx', 'linkcheck', '--json', input.path])
  .on(docsRunner);

const writePage = H.flow('write-page')
  .for(docPage)
  .does(async ctx => {
    let brokenLinks: string[] = [];
    for (let round = 0; round < 3; round++) {
      const written = await ctx.run(writer, { title: ctx.unit.data.title, body: ctx.unit.data.body, brokenLinks });
      if (written.ok === false) return ctx.fail(written.error);
      await ctx.update({ body: written.value.body });
      const checked = await ctx.run(linkCheck, { path: ctx.unit.data.path });
      if (checked.ok === false) return ctx.fail(checked.error);
      if (checked.value.broken.length === 0) return 'page-published';
      brokenLinks = checked.value.broken;
    }
    return ctx.fail('links still broken after three rounds');
  });

const docPages = H.lane('doc-pages', docPage).handler(writePage).suppliers(docsFolder).store(docsFolder).wip(2);

export const documentation = H.harness('documentation')
  .ledger(sqlite.ledger('/srv/docs/ledger.db'))
  .lanes(docPages)
  .pools(sharedPool(0.3))
  .clients(
    claudeCode.supervisor({
      grants: [H.ops.readWork, H.ops.writeWork, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts],
    })
  )
  .observers(markdown.board('/srv/docs/BOARD.md'), markdown.telemetry('/srv/docs/TELEMETRY.md'));

export function startCodingTeam() {
  return codingTeam.start();
}

export function startDocumentation() {
  return documentation.start();
}
