import { H } from 'harness-dsl';
import type { PendingView, AccountChoice, Account } from 'harness-dsl';
import * as cc from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as shell from 'harness-dsl/shell';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import { z } from 'zod';

const ownerQuota = sqlite.quota('owner-quota', '/home/owner/.harness/quota.sqlite');

function soonestExpiring(choice: AccountChoice): Account | null {
  const subscriptions = choice.accounts
    .filter(a => a.eligible && a.account.plan === 'subscription' && a.usedShare < a.share)
    .sort((x, y) => (x.windowEndsAt?.getTime() ?? Infinity) - (y.windowEndsAt?.getTime() ?? Infinity));
  const first = subscriptions[0];
  if (first) return first.account;
  const metered = choice.accounts.find(a => a.eligible && a.account.plan === 'metered');
  return metered ? metered.account : null;
}

export const shared = {
  quota: ownerQuota,
  subscriptions: [
    cc.subscription('claude-max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota: ownerQuota }),
    cc.subscription('claude-max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota: ownerQuota }),
    cc.subscription('claude-max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota: ownerQuota }),
  ],
  taste: H.archive('owner-taste', H.memory('owner-taste', 'taste'), jsonl.memory('/home/owner/.harness/taste.jsonl')),
  drain: H.policy.account('soonest-expiring-then-api', soonestExpiring),
};

export type Shared = typeof shared;

export function codingTeam(s: Shared) {
  const open = H.state('open', 'pending');
  const building = H.state('building', 'active');
  const done = H.state('done', 'terminal', 'success');
  const abandoned = H.state('abandoned', 'terminal', 'failure');
  const planning = H.state('planning', 'active');
  const awaitingFeatures = H.state('awaiting-features', 'waiting');
  const closing = H.state('closing', 'pending');
  const due = H.state('due', 'pending');
  const checking = H.state('checking', 'active');
  const healthy = H.state('healthy', 'terminal', 'success');
  const unhealthy = H.state('unhealthy', 'terminal', 'failure');

  const workData = z.object({
    title: z.string(),
    description: z.string(),
    area: z.string().optional(),
    epicKey: z.string().optional(),
  });

  const Bug = H.kind('bug').data(workData).states(open, building, done, abandoned).failsTo('abandoned');
  const Feature = H.kind('feature').data(workData).states(open, building, done, abandoned).failsTo('abandoned');
  const Epic = H.kind('epic')
    .data(z.object({ title: z.string(), description: z.string() }))
    .states(open, planning, awaitingFeatures, closing, done, abandoned)
    .failsTo('abandoned');
  const Heartbeat = H.kind('service-heartbeat')
    .data(z.object({ service: z.string() }))
    .states(due, checking, healthy, unhealthy);

  const area = H.tag('area');

  const experience = H.archive('coding-experience', H.memory('coding-experience', 'experience'), jsonl.memory('/home/owner/code/product/.harness/experience.jsonl'));
  const builderBriefing = H.briefing('builder-briefing', [s.taste, experience]);
  const auditorBriefing = H.briefing('auditor-briefing', [experience]);
  const plannerBriefing = H.briefing('planner-briefing', [s.taste]);

  const sonnet = cc.model('claude-sonnet-4-5');
  const opus = cc.model('claude-opus-4-1');

  const builderModel = H.policy.model('cheaper-until-it-slips', choice => {
    const cheap = choice.metrics.successRate({ kind: choice.kind, model: sonnet, days: 14 });
    const slipping = cheap.samples >= 20 && cheap.value !== null && cheap.value < 0.85;
    return slipping ? opus : sonnet;
  });

  const worktrees = git.worktree('product-worktrees', { repo: '/home/owner/code/product', slots: 3 });
  const local = shell.local('product-local', { slots: 4 });

  const projectChecks = H.command('project-checks').argv(() => ['npm', 'run', 'check']);

  const builderRole = H.role('builder')
    .input(z.object({ title: z.string(), description: z.string(), feedback: z.string() }))
    .output(z.object({ summary: z.string(), question: z.string().optional() }))
    .prompt(w => `Implement "${w.title}".\n${w.description}\n\nOpen deficits:\n${w.feedback}`)
    .intents(['read', 'edit', 'execute']);
  const auditorRole = H.role('auditor')
    .input(z.object({ title: z.string(), summary: z.string() }))
    .output(z.object({ deficits: z.array(z.string()) }))
    .prompt(w => `Audit the change for "${w.title}". Builder summary:\n${w.summary}`)
    .intents(['read', 'execute']);
  const plannerRole = H.role('planner')
    .input(z.object({ title: z.string(), description: z.string() }))
    .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
    .prompt(e => `Decompose the epic "${e.title}" into features.\n${e.description}`)
    .intents(['read']);

  const builder = H.agent('builder', builderRole)
    .model(builderModel)
    .on(worktrees)
    .recalls(builderBriefing)
    .guards(cc.fileLeases(), cc.stopCheck(projectChecks));
  const auditor = H.agent('auditor', auditorRole).model(opus).on(worktrees).recalls(auditorBriefing).records(experience);
  const planner = H.agent('planner', plannerRole).model(opus).recalls(plannerBriefing);

  const ownerDecision = H.halt('owner-decision', z.object({ answer: z.string() }));

  const buildFlow = H.flow('build-and-audit')
    .for(Bug, Feature)
    .params(z.object({ rounds: z.number().int() }))
    .does(async ctx => {
      await ctx.move('building');
      const work = ctx.unit.data;
      const scope = { tags: work.area ? [area.is(work.area)] : [] };
      let feedback = '';
      for (let round = 1; round <= ctx.params.rounds; round++) {
        const built = await ctx.run(builder, { title: work.title, description: work.description, feedback }, { scope });
        if (!built.ok) return ctx.fail(built.error);
        if (built.value.question) {
          const answer = await ctx.halt(ownerDecision, built.value.question);
          feedback = answer.answer;
          continue;
        }
        const audit = await ctx.run(auditor, { title: work.title, summary: built.value.summary }, { scope });
        if (!audit.ok) return ctx.fail(audit.error);
        if (audit.value.deficits.length === 0) return 'done';
        feedback = audit.value.deficits.join('\n');
      }
      return ctx.fail('build-and-audit rounds exhausted', 'abandoned');
    });

  const epicFlow = H.flow('plan-epic')
    .for(Epic)
    .does(async ctx => {
      await ctx.move('planning');
      const epic = ctx.unit.data;
      const plan = await ctx.run(planner, { title: epic.title, description: epic.description });
      if (!plan.ok) return ctx.fail(plan.error);
      await ctx.spawn(features, plan.value.features.map(f => ({ title: f.title, description: f.description, epicKey: ctx.unit.key })));
      return ctx.wait('awaiting-features', { children: true, then: 'closing' });
    })
    .phase('closing', async ctx => {
      const children = await ctx.children(features);
      if (children.some(c => c.position !== 'terminal')) return ctx.wait('awaiting-features', { children: true, then: 'closing' });
      return children.every(c => c.state === 'done') ? 'done' : ctx.fail('a feature was abandoned', 'abandoned');
    });

  const healthCheck = H.command('service-health')
    .input(z.object({ service: z.string() }))
    .argv(h => ['curl', '-fsS', `https://${h.service}.internal.example.com/health`])
    .on(local)
    .recovers('rerun');

  const heartbeatFlow = H.flow('heartbeat').for(Heartbeat).does(async ctx => {
    await ctx.move('checking');
    const probe = await ctx.run(healthCheck, { service: ctx.unit.data.service });
    return probe.ok ? 'healthy' : 'unhealthy';
  });

  const linearKey = H.env('LINEAR_API_KEY');
  const ticketStatuses = { open: 'Todo', building: 'In Progress', done: 'Done', abandoned: 'Canceled' };
  const bugTracker = linear.tracker(Bug, {
    apiKey: linearKey,
    team: 'PRODUCT',
    label: 'bug',
    read: i => ({ title: i.title, description: i.description }),
    statuses: ticketStatuses,
  });
  const featureTracker = linear.tracker(Feature, {
    apiKey: linearKey,
    team: 'PRODUCT',
    label: 'feature',
    read: i => ({ title: i.title, description: i.description, epicKey: i.parentId }),
    statuses: ticketStatuses,
  });
  const epicTracker = linear.tracker(Epic, {
    apiKey: linearKey,
    team: 'PRODUCT',
    label: 'epic',
    read: i => ({ title: i.title, description: i.description }),
    statuses: {
      open: 'Todo',
      planning: 'In Progress',
      'awaiting-features': 'In Progress',
      closing: 'In Progress',
      done: 'Done',
      abandoned: 'Canceled',
    },
  });
  const bugFolder = folder.files(Bug, {
    dir: '/home/owner/code/product/bugs',
    read: f => ({
      title: typeof f.frontmatter.title === 'string' ? f.frontmatter.title : f.path,
      description: f.body,
      area: typeof f.frontmatter.area === 'string' ? f.frontmatter.area : undefined,
    }),
  });

  const heartbeats = H.lane('heartbeats', Heartbeat)
    .handler(heartbeatFlow)
    .suppliers(H.clock('every-five-minutes', Heartbeat, { every: { minutes: 5 } }, () =>
      ['api', 'web', 'worker'].map(service => ({ create: { service } }))
    ));
  const bugs = H.lane('bugs', Bug).handler(buildFlow, { rounds: 3 }).suppliers(bugTracker, bugFolder, H.operator).store(bugTracker).wip(2);
  const features = H.lane('features', Feature).handler(buildFlow, { rounds: 5 }).suppliers(featureTracker, H.operator).store(featureTracker);
  const epics = H.lane('epics', Epic).handler(epicFlow).suppliers(epicTracker).store(epicTracker).wip(1);

  const unhealthyFilesBug = H.trigger('unhealthy-service-files-bug', H.on.enters(Heartbeat, 'unhealthy'), (event, act) =>
    act.create(bugs, {
      title: `Service ${event.unit.data.service} failed its heartbeat`,
      description: `The heartbeat at ${event.at.toISOString()} found ${event.unit.data.service} unhealthy.`,
      area: event.unit.data.service,
    }, `heartbeat-${event.unit.data.service}`)
  );

  const starvationMs = 6 * 60 * 60 * 1000;
  const rank = (p: PendingView): number =>
    p.kind === Heartbeat.name ? 0
      : p.kind === Feature.name && p.waitedMs > starvationMs ? 0.5
      : p.kind === Bug.name ? 1
      : p.kind === Feature.name ? 2
      : 3;
  const order = H.policy.scheduler('heartbeats-bugs-features-epics', view => ({
    start: [...view.pending].sort((x, y) => rank(x) - rank(y) || y.waitedMs - x.waitedMs),
  }));

  const pool = H.pool('coding-accounts', [
    ...s.subscriptions.map(account => ({ account, share: 0.6 })),
    { account: anthropic.account('coding-api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
  ], s.drain);

  const productionHealth = H.operation('production-health', H.command('production-health').argv(() => ['curl', '-fsS', 'https://api.example.com/health']));

  const control = http.control({
    port: 7401,
    token: H.env('CODING_CONTROL_TOKEN'),
    grants: [
      H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory,
      H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares, productionHealth,
    ],
  });

  const harness = H.harness('coding-team')
    .ledger(sqlite.ledger('/home/owner/code/product/.harness/ledger.sqlite'))
    .lanes(heartbeats, bugs, features, epics)
    .pools(pool)
    .triggers(unhealthyFilesBug)
    .scheduler(order)
    .clients(control)
    .observers(markdown.board('/home/owner/code/product/BOARD.md'), markdown.telemetry('/home/owner/code/product/TELEMETRY.md'));

  return { harness, control };
}

export function documentation(s: Shared) {
  const drafted = H.state('drafted', 'pending');
  const writing = H.state('writing', 'active');
  const published = H.state('published', 'terminal', 'success');
  const broken = H.state('broken', 'terminal', 'failure');

  const DocPage = H.kind('doc-page')
    .data(z.object({ path: z.string(), title: z.string(), body: z.string() }))
    .states(drafted, writing, published, broken)
    .failsTo('broken');

  const experience = H.archive('docs-experience', H.memory('docs-experience', 'experience'), jsonl.memory('/home/owner/code/docs/.harness/experience.jsonl'));
  const writerBriefing = H.briefing('writer-briefing', [s.taste, experience]);

  const writerRole = H.role('writer')
    .input(z.object({ path: z.string(), title: z.string(), body: z.string() }))
    .output(z.object({ body: z.string() }))
    .prompt(p => `Revise the documentation page "${p.title}" at ${p.path}:\n\n${p.body}`)
    .intents(['read', 'edit']);

  const worktrees = git.worktree('docs-worktrees', { repo: '/home/owner/code/docs', slots: 2 });
  const local = shell.local('docs-local', { slots: 2 });

  const writer = H.agent('writer', writerRole).model(cc.model('claude-sonnet-4-5')).on(worktrees).recalls(writerBriefing).records(experience);
  const linkCheck = H.command('link-check')
    .input(z.object({ path: z.string() }))
    .argv(p => ['lychee', '--no-progress', p.path])
    .on(local)
    .recovers('rerun');

  const pageFlow = H.flow('write-and-link-check').for(DocPage).does(async ctx => {
    await ctx.move('writing');
    const page = ctx.unit.data;
    const written = await ctx.run(writer, page);
    if (!written.ok) return ctx.fail(written.error);
    await ctx.update({ body: written.value.body });
    const links = await ctx.run(linkCheck, { path: page.path });
    return links.ok ? 'published' : ctx.fail(links.error);
  });

  const pages = folder.files(DocPage, {
    dir: '/home/owner/code/docs/pages',
    read: f => ({ path: f.path, title: typeof f.frontmatter.title === 'string' ? f.frontmatter.title : f.path, body: f.body }),
    write: (_page, state) => ({ status: state }),
  });

  const docs = H.lane('doc-pages', DocPage)
    .handler(pageFlow)
    .suppliers(pages)
    .store(pages)
    .retry(H.policy.retry('link-check-twice', v => (v.failures < 2 ? { retryInMs: 60_000 } : 'stop')));

  const pool = H.pool('docs-accounts', s.subscriptions.map(account => ({ account, share: 0.3 })), s.drain);

  const control = http.control({
    port: 7402,
    token: H.env('DOCS_CONTROL_TOKEN'),
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.writeMemory, H.ops.readTelemetry, H.ops.readAccounts, H.ops.setShares],
  });

  const harness = H.harness('documentation')
    .ledger(sqlite.ledger('/home/owner/code/docs/.harness/ledger.sqlite'))
    .lanes(docs)
    .pools(pool)
    .scheduler(H.policy.scheduler('oldest-page-first', view => ({ start: [...view.pending].sort((x, y) => y.waitedMs - x.waitedMs) })))
    .clients(control)
    .observers(markdown.board('/home/owner/code/docs/BOARD.md'), markdown.telemetry('/home/owner/code/docs/TELEMETRY.md'));

  return { harness, control };
}

export const coding = codingTeam(shared);
export const docs = documentation(shared);

export const owner = cc.session('owner', { endpoints: [coding.control.endpoint, docs.control.endpoint] });
