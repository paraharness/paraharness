import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';
import { plugins } from 'harness-dsl/plugins';

const sharedQuota = sqlite.quota('/srv/harness/shared/quota.db');

const subscriptions = [
  H.account('claude-max-1', claudeCode.driver({ configDir: H.env('CLAUDE_MAX_1_DIR') })).quota(sharedQuota),
  H.account('claude-max-2', claudeCode.driver({ configDir: H.env('CLAUDE_MAX_2_DIR') })).quota(sharedQuota),
  H.account('claude-max-3', claudeCode.driver({ configDir: H.env('CLAUDE_MAX_3_DIR') })).quota(sharedQuota),
];
const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(sharedQuota);

const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());

const taste = H.memory('taste').content(z.object({ rule: z.string() })).trust('taste');
const experience = H.memory('experience').content(z.object({ rule: z.string() })).trust('experience');

const sharedTaste = H.journal('owner-taste')
  .of(taste)
  .store(jsonl.store('/srv/harness/shared/taste.jsonl'))
  .recall(policies.specificity({ limit: 12 }));

const subscriptionPool = (harness: string, share: number) =>
  H.pool(`${harness}-subscriptions`, subscriptions.map(account => account.maxQuotaShare(share)))
    .serves(sonnet, opus)
    .policy(policies.soonestExpiring())
    .fallback(apiAccount);

const queued = H.state('queued').pending();
const working = H.state('working').active();
const done = H.state('done').terminal('success');
const stuck = H.state('stuck').terminal('failure');

const issueSchema = z.object({ issueId: z.string(), title: z.string(), body: z.string() });

const bug = H.work('bug').schema(issueSchema).states(queued, working, done, stuck);
const feature = H.work('feature').schema(issueSchema).states(queued, working, done, stuck);
const epic = H.work('epic').schema(issueSchema).states(queued, working, done, stuck);

const sourceTree = H.resource('source-tree');
const local = H.runner.local('workstation', { slots: 4 });

const projectChecks = H.command('project-checks')
  .runner(local)
  .run(async (_input, ctx) => {
    const result = await ctx.sh('npm run check');
    if (result.code !== 0) throw new Error(result.stderr);
  });

const builderRole = H.role('builder')
  .promptFile('prompts/builder.md')
  .intents(['read', 'edit', 'shell'])
  .recall(experience, taste)
  .use(
    plugins.gitWorktreeIsolation(),
    plugins.fileLeaseGuard([{ resource: sourceTree, globs: ['src/**', 'test/**'] }]),
    plugins.stopCheck(projectChecks),
  );
const auditorRole = H.role('auditor').promptFile('prompts/auditor.md').intents(['read', 'shell']).recall(experience).record(experience);
const plannerRole = H.role('planner').promptFile('prompts/planner.md').intents(['read']).recall(taste);

const buildSkill = H.skill('build')
  .input(z.object({ title: z.string(), body: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `${i.title}\n\n${i.body}\n\nOpen deficits:\n${i.deficits.join('\n')}`);
const auditSkill = H.skill('audit')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit the change for "${i.title}": ${i.summary}`);
const planSkill = H.skill('plan-epic')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ features: z.array(z.object({ issueId: z.string(), title: z.string(), body: z.string() })) }))
  .prompt(i => `Decompose the epic "${i.title}" into features:\n${i.body}`);

const builderSuccess = H.metric('builder-success-rate').rate(H.events.terminal({ verdict: 'success' }), H.events.terminal());

const cheaperUntilWeak = H.policy.seat('cheaper-until-weak', ({ unit, metrics }) => {
  const reading = metrics.read(builderSuccess, { window: '14d', where: { kind: unit.kind, model: sonnet } });
  const cheapHolds = reading.samples < 20 || (reading.value ?? 1) >= 0.85;
  return cheapHolds ? [sonnet, opus] : [opus, sonnet];
});

const builder = H.seat('builder').role(builderRole).models(sonnet, opus).policy(cheaperUntilWeak);
const auditor = H.seat('auditor').role(auditorRole).models(sonnet);
const planner = H.seat('planner').role(plannerRole).models(opus);

const buildAndAudit = H.flow('build-and-audit')
  .input(z.object({ issueId: z.string(), title: z.string(), body: z.string(), rounds: z.number() }))
  .resources(() => [sourceTree])
  .loop('rounds', {
    maxIterations: s => s.input.rounds,
    initial: (): string[] => [],
    body: f =>
      f
        .step('build', builder.call(buildSkill), s => ({ title: s.input.title, body: s.input.body, deficits: s.carry }))
        .step('audit', auditor.call(auditSkill), s => ({ title: s.input.title, summary: s.steps.build.summary })),
    next: s => s.steps.audit.deficits,
    until: s => s.steps.audit.deficits.length === 0,
  })
  .exit(s => (s.steps.rounds.completed ? 'clean' : 'deficits'));

const trackerKey = H.env('LINEAR_API_KEY');
const trackerStore = linear.store({
  apiKey: trackerKey,
  team: 'PRODUCT',
  statuses: [
    [queued, 'Todo'],
    [working, 'In Progress'],
    [done, 'Done'],
    [stuck, 'Blocked'],
  ],
});
const fromTracker = (label: string) =>
  linear
    .issues({ apiKey: trackerKey, team: 'PRODUCT', labels: [label] })
    .map(issue => ({ issueId: issue.identifier, title: issue.title, body: issue.description }))
    .key(issue => issue.issueId);

const bugs = H.lane('bugs')
  .of(bug)
  .from(fromTracker('bug'), supply.folder({ path: 'inbox/bugs', schema: issueSchema }).key(d => d.issueId), supply.manual())
  .store(trackerStore)
  .wip(2)
  .handle(buildAndAudit, {
    input: unit => ({ ...unit.data, rounds: 3 }),
    exits: { clean: done, deficits: stuck },
    retry: { tries: 2, backoff: 'exponential', delaySeconds: 60, exhausted: stuck },
  });

const features = H.lane('features')
  .of(feature)
  .from(fromTracker('feature'), supply.manual())
  .store(trackerStore)
  .handle(buildAndAudit, {
    input: unit => ({ ...unit.data, rounds: 5 }),
    exits: { clean: done, deficits: stuck },
    retry: { tries: 2, backoff: 'exponential', delaySeconds: 60, exhausted: stuck },
  });

const planEpic = H.flow('plan-epic')
  .input(issueSchema)
  .step('plan', planner.call(planSkill), s => ({ title: s.input.title, body: s.input.body }))
  .spawn('features', features, s => s.steps.plan.features)
  .exit(s => (s.steps.features.every(child => child.verdict === 'success') ? 'complete' : 'incomplete'));

const epics = H.lane('epics')
  .of(epic)
  .from(fromTracker('epic'))
  .store(trackerStore)
  .wip(1)
  .handle(planEpic, {
    exits: { complete: done, incomplete: stuck },
    retry: { tries: 1, backoff: 'linear', delaySeconds: 300, exhausted: stuck },
  });

const codingExperience = H.journal('coding-experience')
  .of(experience)
  .store(jsonl.store('.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const codingOrder = H.policy.schedule('bugs-features-epics', ({ candidates }) => [
  ...candidates.filter(c => c.lane === bugs),
  ...candidates.filter(c => c.lane === features),
  ...candidates.filter(c => c.lane === epics),
]);

const ownerOperations = [
  H.ops.work.read,
  H.ops.work.write,
  H.ops.telemetry.read,
  H.ops.accounts.manage,
  H.ops.memory.write(sharedTaste),
];

export const coding = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(subscriptionPool('coding', 0.6))
  .lanes(bugs, features, epics)
  .journals(sharedTaste, codingExperience)
  .schedule(codingOrder)
  .grants(H.grant(claudeCode.client('owner-supervisor-coding', { session: 'owner' }), ...ownerOperations, H.ops.memory.write(codingExperience)))
  .metrics(builderSuccess)
  .observe(observers.board({ path: '.harness/board.md' }), observers.telemetry({ path: '.harness/telemetry.md' }));

const draftDoc = H.state('draft').pending();
const writing = H.state('writing').active();
const published = H.state('published').terminal('success');
const brokenLinks = H.state('broken-links').terminal('failure');

const docSchema = z.object({ path: z.string(), title: z.string(), brief: z.string() });
const docPage = H.work('doc-page').schema(docSchema).states(draftDoc, writing, published, brokenLinks);

const writerRole = H.role('writer').promptFile('prompts/writer.md').intents(['read', 'edit']).recall(taste, experience).record(experience);
const writeSkill = H.skill('write-page')
  .input(docSchema)
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Write ${i.path} titled "${i.title}": ${i.brief}`);
const writer = H.seat('writer').role(writerRole).models(sonnet);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .runner(local)
  .run(async (i, ctx) => {
    const result = await ctx.sh(`npm run check-links -- ${i.path}`);
    return { broken: result.code === 0 ? [] : result.stdout.split('\n').filter(line => line.length > 0) };
  });

const writePage = H.flow('write-page')
  .input(docSchema)
  .step('write', writer.call(writeSkill))
  .step('links', linkCheck, s => ({ path: s.input.path }))
  .exit(s => (s.steps.links.broken.length === 0 ? 'clean' : 'broken'));

const pages = H.lane('pages')
  .of(docPage)
  .from(supply.folder({ path: 'docs/pages', schema: docSchema }).key(d => d.path))
  .store(supply.frontmatter({ path: 'docs/pages' }))
  .wip(2)
  .handle(writePage, {
    exits: { clean: published, broken: { to: draftDoc, maxTimes: 2, then: brokenLinks } },
    retry: { tries: 2, backoff: 'linear', delaySeconds: 120, exhausted: brokenLinks },
  });

const docsExperience = H.journal('docs-experience')
  .of(experience)
  .store(jsonl.store('.harness/docs-experience.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const oldestFirst = H.policy.schedule('oldest-first', ({ candidates }) =>
  [...candidates].sort((a, b) => b.waitingSeconds - a.waitingSeconds),
);

export const docs = H.harness('documentation')
  .ledger(sqlite.ledger('.harness/docs-ledger.db'))
  .pools(subscriptionPool('docs', 0.3))
  .lanes(pages)
  .journals(sharedTaste, docsExperience)
  .schedule(oldestFirst)
  .grants(H.grant(claudeCode.client('owner-supervisor-docs', { session: 'owner' }), ...ownerOperations, H.ops.memory.write(docsExperience)))
  .observe(observers.board({ path: '.harness/board.md' }), observers.telemetry({ path: '.harness/telemetry.md' }));
