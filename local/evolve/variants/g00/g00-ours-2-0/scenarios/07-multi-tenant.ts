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

const sharedAccountQuota = sqlite.quota('/srv/owner/shared/account-quota.sqlite');
const subscriptionNames = ['claude-max-1', 'claude-max-2', 'claude-max-3'];
const subscriptions = (projectShare: number) =>
  subscriptionNames.map((name) =>
    H.account(name, claudeCode.driver({ configDir: `/srv/owner/shared/${name}` }))
      .maxQuotaShare(projectShare)
      .quota(sharedAccountQuota),
  );
const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));

const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());

const subscriptionPool = (projectShare: number) =>
  H.pool('subscriptions', subscriptions(projectShare))
    .serves(sonnet, opus)
    .policy(policies.soonestExpiring())
    .fallback(apiAccount);

const taste = H.memory('taste').content(z.object({ rule: z.string() })).trust('taste');
const experience = H.memory('experience').content(z.object({ rule: z.string() })).trust('experience');

const ownerTaste = H.journal('owner-taste')
  .of(taste)
  .store(jsonl.store('/srv/owner/shared/taste.jsonl'))
  .recall(policies.specificity({ limit: 12 }));

const open = H.state('open').pending();
const working = H.state('working').active();
const done = H.state('done').terminal('success');
const failed = H.state('failed').terminal('failure');
const abandoned = H.state('abandoned').terminal('neutral');

const codingExperience = H.journal('experience')
  .of(experience)
  .store(jsonl.store('/srv/product/.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const workSchema = z.object({ title: z.string(), body: z.string(), parentId: z.string().optional() });
const bugKind = H.work('Bug').schema(workSchema).states(open, working, done, failed, abandoned);
const featureKind = H.work('Feature').schema(workSchema).states(open, working, done, failed, abandoned);
const epicKind = H.work('Epic').schema(workSchema).states(open, working, done, failed, abandoned);

const healthy = H.state('healthy').terminal('success');
const down = H.state('down').terminal('failure');
const heartbeatKind = H.work('ServiceHeartbeat').schema(z.object({ service: z.string() })).states(open, working, healthy, down);

const payments = H.resource('payments');
const application = H.resource('application');

const projectChecks = H.command('project-checks').run(async (_input, ctx) => {
  const result = await ctx.sh('npm run check', { timeoutSeconds: 900 });
  if (result.code !== 0) throw new Error(result.stderr);
});

const builderRole = H.role('builder')
  .promptFile('prompts/builder.md')
  .intents(['read', 'edit', 'shell'])
  .recall(experience, taste)
  .use(
    plugins.gitWorktreeIsolation(),
    plugins.fileLeaseGuard([
      { resource: payments, globs: ['src/payments/**'] },
      { resource: application, globs: ['src/**', 'test/**'] },
    ]),
    plugins.stopCheck(projectChecks),
  );
const auditorRole = H.role('auditor').promptFile('prompts/auditor.md').intents(['read', 'shell']).recall(experience).record(experience);
const plannerRole = H.role('planner').promptFile('prompts/planner.md').intents(['read']).recall(taste);

const build = H.skill('build')
  .input(z.object({ title: z.string(), body: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), ownerQuestion: z.string().optional() }))
  .prompt((i) => `Build: ${i.title}\n\n${i.body}\n\nOpen deficits:\n${i.deficits.join('\n')}`);
const audit = H.skill('audit')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt((i) => `Audit the change for "${i.title}". The builder reports: ${i.summary}`);
const plan = H.skill('plan')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }))
  .prompt((i) => `Decompose the epic "${i.title}" into features.\n\n${i.body}`);

const kindSuccessRate = H.metric('kind-success-rate').rate(H.events.terminal({ verdict: 'success' }), H.events.terminal());
const cheaperUntilItSlips = H.policy.seat('cheaper-until-it-slips', ({ unit, metrics }) => {
  const reading = metrics.read(kindSuccessRate, { window: '14d', where: { model: sonnet, kind: unit.kind } });
  const cheaperHolds = reading.samples < 20 || (reading.value ?? 1) >= 0.85;
  return cheaperHolds ? [sonnet, opus] : [opus, sonnet];
});

const builder = H.seat('builder').role(builderRole).models(sonnet, opus).policy(cheaperUntilItSlips);
const auditor = H.agent('auditor').role(auditorRole).model(sonnet);
const planner = H.agent('planner').role(plannerRole).model(opus);

const ownerDecision = H.halt('owner-decision')
  .context(z.object({ question: z.string() }))
  .ask((c) => c.question)
  .decision(z.object({ answer: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .input(z.object({ title: z.string(), body: z.string(), maxRounds: z.number() }))
  .loop('rounds', {
    maxIterations: (s) => s.input.maxRounds,
    initial: (): string[] => [],
    body: (round) =>
      round
        .step('build', builder.call(build), (s) => ({ title: s.input.title, body: s.input.body, deficits: s.carry }))
        .when(
          (s) => s.steps.build.ownerQuestion !== undefined,
          (ask) => ask.halt('owner', ownerDecision, (s) => ({ question: s.steps.build.ownerQuestion ?? '' })),
        )
        .step('audit', auditor.call(audit), (s) => ({ title: s.input.title, summary: s.steps.build.summary })),
    next: (s) => s.steps.audit.deficits,
    until: (s) => s.steps.audit.deficits.length === 0,
  })
  .exit((s) => (s.steps.rounds.completed ? 'delivered' : 'roundsExhausted'));

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({
  apiKey: linearKey,
  team: 'ENG',
  statuses: [
    [open, 'Todo'],
    [working, 'In Progress'],
    [done, 'Done'],
    [failed, 'Blocked'],
    [abandoned, 'Canceled'],
  ],
});
const trackerIssues = (label: string) =>
  linear
    .issues({ apiKey: linearKey, team: 'ENG', labels: [label] })
    .map((issue) => ({ title: issue.title, body: issue.description, parentId: issue.parentId }))
    .key((d) => d.title);

const features = H.lane('features')
  .of(featureKind)
  .from(trackerIssues('feature'), supply.manual())
  .store(tracker)
  .handle(buildAndAudit, (u) => ({ title: u.data.title, body: u.data.body, maxRounds: 5 }))
  .exits({ delivered: done, roundsExhausted: failed })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 300, exhausted: failed });

const bugs = H.lane('bugs')
  .of(bugKind)
  .from(trackerIssues('bug'), supply.folder({ path: 'bugs', schema: workSchema }), supply.manual())
  .store(tracker)
  .handle(buildAndAudit, (u) => ({ title: u.data.title, body: u.data.body, maxRounds: 3 }))
  .exits({ delivered: done, roundsExhausted: failed })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 300, exhausted: failed })
  .wip(2);

const decompose = H.flow('decompose')
  .input(workSchema)
  .step('plan', planner.call(plan), (s) => ({ title: s.input.title, body: s.input.body }))
  .spawn('features', features, (s) => s.steps.plan.features.map((f) => ({ title: f.title, body: f.body, parentId: s.unit.key })))
  .exit((s) => (s.steps.features.every((child) => child.verdict === 'success') ? 'delivered' : 'featuresFailed'));

const epics = H.lane('epics')
  .of(epicKind)
  .from(trackerIssues('epic'))
  .store(tracker)
  .handle(decompose)
  .exits({ delivered: done, featuresFailed: failed })
  .retry({ tries: 1, backoff: 'none', exhausted: failed })
  .wip(1);

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string() }))
  .output(z.object({ healthy: z.boolean() }))
  .effect('repeatable')
  .run(async (i, ctx) => {
    const result = await ctx.sh(`curl -fsS https://${i.service}.internal/health`, { timeoutSeconds: 20 });
    return { healthy: result.code === 0 };
  });

const heartbeat = H.flow('heartbeat')
  .input(z.object({ service: z.string() }))
  .step('probe', probeService)
  .exit((s) => (s.steps.probe.healthy ? 'healthy' : 'down'));

const heartbeats = H.lane('heartbeats')
  .of(heartbeatKind)
  .from(supply.schedule({ cron: '*/5 * * * *', units: () => [{ service: 'api' }, { service: 'worker' }] }))
  .handle(heartbeat)
  .exits({ healthy, down })
  .retry({ tries: 0, backoff: 'none', exhausted: down });

const outageBecomesBug = H.trigger('outage-becomes-bug')
  .on(heartbeats.enters(down))
  .do(
    bugs.create((p) => ({
      title: `${p.unit.data.service} heartbeat failed`,
      body: `The ${p.unit.data.service} heartbeat entered down at ${p.unit.updatedAt.toISOString()}.`,
    })),
  );

const laneOrder = [heartbeats.name, bugs.name, features.name, epics.name];
const starvationSeconds = 4 * 3600;
const codingPriority = H.policy.schedule('heartbeats-bugs-features-epics', ({ candidates }) => {
  const rank = (lane: string, waitingSeconds: number) =>
    lane === heartbeats.name ? 0 : lane === features.name && waitingSeconds > starvationSeconds ? 1 : 2 + laneOrder.indexOf(lane);
  return [...candidates].sort(
    (a, b) => rank(a.lane.name, a.waitingSeconds) - rank(b.lane.name, b.waitingSeconds) || b.waitingSeconds - a.waitingSeconds,
  );
});

const productionHealth = H.command('production-health')
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .run(async (_input, ctx) => {
    const result = await ctx.sh('curl -fsS https://app.example.com/health', { timeoutSeconds: 20 });
    return { healthy: result.code === 0, detail: result.stdout || result.stderr };
  });

export const coding = H.harness('coding')
  .ledger(sqlite.ledger('/srv/product/.harness/ledger.sqlite'))
  .pools(subscriptionPool(0.6))
  .lanes(heartbeats, bugs, features, epics)
  .journals(ownerTaste, codingExperience)
  .triggers(outageBecomesBug)
  .scheduler(H.scheduler().policy(codingPriority))
  .grants(
    H.grant(
      claudeCode.client('owner-coding', { session: 'owner' }),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.resolve(ownerDecision),
      H.ops.memory.write(ownerTaste, codingExperience),
      H.ops.telemetry.read,
      H.ops.accounts.manage,
      H.operation('production-health', productionHealth),
    ),
  )
  .metrics(kindSuccessRate)
  .observe(
    observers.board({ path: '/srv/product/.harness/board.md' }),
    observers.telemetry({ path: '/srv/product/.harness/telemetry.md' }),
  );

const docsExperience = H.journal('experience')
  .of(experience)
  .store(jsonl.store('/srv/docs/.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const published = H.state('published').terminal('success');
const docSchema = z.object({ path: z.string(), title: z.string(), brief: z.string() });
const docPageKind = H.work('DocPage').schema(docSchema).states(open, working, published, failed, abandoned);

const writerRole = H.role('writer').promptFile('prompts/writer.md').intents(['read', 'edit']).recall(taste, experience).record(experience);
const writer = H.agent('writer').role(writerRole).model(sonnet);
const writePage = H.skill('write-page')
  .input(docSchema)
  .output(z.object({ summary: z.string() }))
  .prompt((i) => `Write or revise ${i.path} ("${i.title}"): ${i.brief}`);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .effect('repeatable')
  .run(async (i, ctx) => {
    const result = await ctx.sh(`npx markdown-link-check --quiet ${i.path}`);
    return { broken: result.code === 0 ? [] : result.stdout.split('\n').filter((line) => line.includes('✖')) };
  });

const writeDoc = H.flow('write-doc')
  .input(docSchema)
  .step('write', writer.call(writePage))
  .step('links', linkCheck, (s) => ({ path: s.input.path }))
  .exit((s) => (s.steps.links.broken.length === 0 ? 'published' : 'brokenLinks'));

const docPages = H.lane('doc-pages')
  .of(docPageKind)
  .from(supply.folder({ path: 'docs', schema: docSchema }).key((d) => d.path))
  .store(supply.frontmatter({ path: 'docs' }))
  .handle(writeDoc)
  .exits({ published, brokenLinks: { to: open, maxTimes: 2, then: failed } })
  .retry({ tries: 2, backoff: 'linear', delaySeconds: 120, exhausted: failed })
  .wip(2);

export const docs = H.harness('docs')
  .ledger(sqlite.ledger('/srv/docs/.harness/ledger.sqlite'))
  .pools(subscriptionPool(0.3))
  .lanes(docPages)
  .journals(ownerTaste, docsExperience)
  .scheduler(H.scheduler().policy(H.policy.schedule('oldest-first', ({ candidates }) => [...candidates].sort((a, b) => b.waitingSeconds - a.waitingSeconds))))
  .grants(
    H.grant(
      claudeCode.client('owner-docs', { session: 'owner' }),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.memory.write(ownerTaste, docsExperience),
      H.ops.telemetry.read,
      H.ops.accounts.manage,
    ),
  )
  .observe(observers.board({ path: '/srv/docs/.harness/board.md' }));
