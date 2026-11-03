import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate, ShResult } from 'harness-dsl/kernel';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { supply } from 'harness-dsl/supply';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';
import { plugins } from 'harness-dsl/plugins';

const sharedQuota = sqlite.quota('~/.harness/shared/quota.sqlite');

const subscriptionAccounts = (maxQuotaShare: number) =>
  [1, 2, 3].map(n =>
    H.account(`claude-subscription-${n}`, claudeCode.driver({ configDir: H.env(`CLAUDE_CONFIG_DIR_${n}`) }))
      .quota(sharedQuota)
      .maxQuotaShare(maxQuotaShare));

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));

const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());

const taste = H.memory('taste').content(z.object({ rule: z.string() })).trust('taste');
const experience = H.memory('experience').content(z.object({ rule: z.string() })).trust('experience');

const ownerTaste = H.journal('owner-taste')
  .of(taste)
  .store(jsonl.store('~/.harness/shared/taste.jsonl'))
  .recall(policies.specificity({ limit: 12 }));

const ownerSession = claudeCode.client('owner-supervisor', { session: 'owner' });

const queued = H.state('queued').pending();
const running = H.state('running').active();
const ownerReview = H.state('owner-review').waiting();
const done = H.state('done').terminal('success');
const abandoned = H.state('abandoned').terminal('failure');

const succeed = (result: ShResult) => {
  if (result.code === 0) return;
  throw new Error(result.stderr);
};

const workstation = H.runner.local('workstation', { slots: 4 });
const linearKey = H.env('LINEAR_API_KEY');

const issueSchema = z.object({ title: z.string(), body: z.string(), origin: z.string() });
const featureSchema = issueSchema.extend({ epic: z.string().optional() });
type IssueData = z.infer<typeof issueSchema>;
type FeatureData = z.infer<typeof featureSchema>;

const bug = H.work('bug').schema(issueSchema).states(queued, running, ownerReview, done, abandoned);
const feature = H.work('feature').schema(featureSchema).states(queued, running, ownerReview, done, abandoned);
const epic = H.work('epic').schema(issueSchema).states(queued, running, ownerReview, done, abandoned);

const healthy = H.state('healthy').terminal('success');
const down = H.state('down').terminal('failure');
const heartbeatSchema = z.object({ service: z.string() });
type HeartbeatData = z.infer<typeof heartbeatSchema>;
const heartbeat = H.work('service-heartbeat').schema(heartbeatSchema).states(queued, running, healthy, down);

const tracker = linear.store({
  apiKey: linearKey,
  team: 'CORE',
  statuses: [[queued, 'Todo'], [running, 'In Progress'], [ownerReview, 'In Review'], [done, 'Done'], [abandoned, 'Canceled']],
});

const sourceTree = H.resource('source-tree');

const projectChecks = H.command('project-checks')
  .runner(workstation)
  .run(async (_input, ctx) => succeed(await ctx.sh('npm run check')));

const productionHealth = H.command('production-health')
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .runner(workstation)
  .run(async (_input, ctx) => {
    const result = await ctx.sh('./scripts/production-health.sh');
    return { healthy: result.code === 0, detail: result.stdout };
  });

const builderRole = H.role('builder')
  .promptFile('./prompts/builder.md')
  .intents(['read', 'edit', 'shell'])
  .recall(experience, taste)
  .use(
    plugins.gitWorktreeIsolation(),
    plugins.fileLeaseGuard([{ resource: sourceTree, globs: ['src/**', 'test/**'] }]),
    plugins.stopCheck(projectChecks),
  );
const auditorRole = H.role('auditor').promptFile('./prompts/auditor.md').intents(['read', 'shell']).recall(experience).record(experience);
const plannerRole = H.role('planner').promptFile('./prompts/planner.md').intents(['read']).recall(taste);

const builderSuccess = H.metric('builder-success-rate').rate(H.events.terminal({ verdict: 'success' }), H.events.terminal());

const cheaperUntilWeak = H.policy.seat('cheaper-until-weak', input => {
  const reading = input.metrics.read(builderSuccess, {
    window: '14d',
    where: { kind: input.unit.kind, seat: input.seat, model: sonnet },
  });
  const weak = reading.samples >= 20 && (reading.value ?? 1) < 0.85;
  return weak ? [opus, sonnet] : [sonnet, opus];
});

const builder = H.seat('builder').role(builderRole).models(sonnet, opus).policy(cheaperUntilWeak);
const auditor = H.seat('auditor').role(auditorRole).models(sonnet);
const planner = H.seat('planner').role(plannerRole).models(opus);

const buildSkill = H.skill('build')
  .input(z.object({ title: z.string(), body: z.string(), deficits: z.array(z.string()), round: z.number() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(i => `Round ${i.round}: ${i.title}\n\n${i.body}\n\nOpen deficits:\n${i.deficits.join('\n')}`);

const auditSkill = H.skill('audit')
  .input(z.object({ title: z.string(), body: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit the change for ${i.title}.\n\nBuilder summary:\n${i.summary}`);

const planSkill = H.skill('plan-epic')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }))
  .prompt(i => `Decompose the epic into features: ${i.title}\n\n${i.body}`);

const ownerDecision = H.halt('owner-decision')
  .context(z.object({ question: z.string() }))
  .ask(c => c.question)
  .decision(z.object({ answer: z.string() }));

const deliver = H.flow('deliver')
  .input(z.object({ title: z.string(), body: z.string(), rounds: z.number().int() }))
  .loop('rounds', {
    maxIterations: s => s.input.rounds,
    initial: (): string[] => [],
    body: f => f
      .step('build', builder.call(buildSkill), s => ({ title: s.input.title, body: s.input.body, deficits: s.carry, round: s.iteration }))
      .when(s => typeof s.steps.build.question === 'string', b => b
        .halt('owner', ownerDecision, s => ({ question: s.steps.build.question ?? '' })))
      .step('audit', auditor.call(auditSkill), s => ({ title: s.input.title, body: s.input.body, summary: s.steps.build.summary })),
    next: s => s.steps.audit.deficits,
    until: s => s.steps.audit.deficits.length === 0,
  })
  .exit(s => (s.steps.rounds.completed ? 'delivered' : 'roundsExhausted'));

const bugs = H.lane('bugs')
  .of(bug)
  .from(
    linear.issues({ apiKey: linearKey, team: 'CORE', labels: ['bug'] })
      .map((issue): IssueData => ({ title: issue.title, body: issue.description, origin: issue.identifier }))
      .key(d => d.origin),
    supply.folder({ path: './coding/bugs', schema: issueSchema }).key(d => d.origin),
    supply.manual(),
  )
  .store(tracker)
  .handle(deliver, u => ({ title: u.data.title, body: u.data.body, rounds: 3 }))
  .exits({
    delivered: done,
    roundsExhausted: ownerReview,
    failed: { tries: 2, backoff: 'exponential', delaySeconds: 300, then: abandoned },
  })
  .wip(2);

const features = H.lane('features')
  .of(feature)
  .from(
    linear.issues({ apiKey: linearKey, team: 'CORE', labels: ['feature'] })
      .map((issue): FeatureData => ({ title: issue.title, body: issue.description, origin: issue.identifier, epic: issue.parentId }))
      .key(d => d.origin),
    supply.manual(),
  )
  .store(tracker)
  .handle(deliver, u => ({ title: u.data.title, body: u.data.body, rounds: 5 }))
  .exits({
    delivered: done,
    roundsExhausted: ownerReview,
    failed: { tries: 2, backoff: 'exponential', delaySeconds: 300, then: abandoned },
  });

const decomposeEpic = H.flow('decompose-epic')
  .input(issueSchema)
  .step('plan', planner.call(planSkill), s => ({ title: s.input.title, body: s.input.body }))
  .spawn('features', features, s =>
    s.steps.plan.features.map((f, i) => ({ title: f.title, body: f.body, origin: `${s.input.origin}/${i + 1}`, epic: s.input.origin })))
  .exit(s => (s.steps.features.every(c => c.verdict === 'success') ? 'completed' : 'incomplete'));

const epics = H.lane('epics')
  .of(epic)
  .from(
    linear.issues({ apiKey: linearKey, team: 'CORE', labels: ['epic'] })
      .map((issue): IssueData => ({ title: issue.title, body: issue.description, origin: issue.identifier }))
      .key(d => d.origin),
  )
  .store(tracker)
  .handle(decomposeEpic)
  .exits({
    completed: done,
    incomplete: ownerReview,
    failed: { tries: 2, backoff: 'linear', delaySeconds: 600, then: abandoned },
  })
  .wip(1);

const probeService = H.command('probe-service')
  .input(heartbeatSchema)
  .runner(workstation)
  .run(async (input, ctx) => succeed(await ctx.sh(`./scripts/health.sh ${input.service}`, { timeoutSeconds: 30 })));

const heartbeatFlow = H.flow('heartbeat').input(heartbeatSchema).step('probe', probeService).exit('healthy');

const heartbeats = H.lane('heartbeats')
  .of(heartbeat)
  .from(
    supply.schedule<HeartbeatData>({ cron: '*/5 * * * *', units: () => [{ service: 'api' }, { service: 'worker' }] })
      .key(d => d.service),
  )
  .handle(heartbeatFlow)
  .exits({ healthy, failed: { tries: 1, backoff: 'none', then: down } });

const heartbeatFilesBug = H.trigger('heartbeat-down-files-bug')
  .on(heartbeats.enters(down))
  .do(bugs.create(
    e => ({
      title: `${e.unit.data.service} heartbeat failing`,
      body: `The heartbeat for ${e.unit.data.service} failed at ${e.unit.updatedAt.toISOString()}.`,
      origin: `heartbeat/${e.unit.data.service}`,
    }),
    e => `heartbeat/${e.unit.data.service}`,
  ));

const codingLaneOrder = [heartbeats, bugs, features, epics];
const featureStarvationSeconds = 2 * 3600;

const codingSchedule = H.policy.schedule('heartbeats-bugs-features-epics', input => {
  const rank = (c: Candidate) =>
    c.lane === features && c.waitingSeconds > featureStarvationSeconds
      ? 0.5
      : codingLaneOrder.findIndex(l => l === c.lane);
  return [...input.candidates].sort((a, b) => rank(a) - rank(b) || b.waitingSeconds - a.waitingSeconds);
});

const codingExperience = H.journal('coding-experience')
  .of(experience)
  .store(jsonl.store('./coding/.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

export const codingHarness = H.harness('coding-team')
  .ledger(sqlite.ledger('./coding/.harness/ledger.sqlite'))
  .pools(
    H.pool('subscriptions', subscriptionAccounts(0.6))
      .serves(sonnet, opus)
      .policy(policies.soonestExpiring())
      .fallback(apiAccount),
  )
  .lanes(heartbeats, bugs, features, epics)
  .journals(ownerTaste, codingExperience)
  .triggers(heartbeatFilesBug)
  .scheduler(H.scheduler().policy(codingSchedule))
  .grants(H.grant(
    ownerSession,
    H.ops.work.read,
    H.ops.work.write,
    H.ops.resolve(ownerDecision),
    H.ops.memory.write(ownerTaste, codingExperience),
    H.ops.telemetry.read,
    H.ops.accounts.manage,
    H.operation('production-health', productionHealth),
  ))
  .metrics(builderSuccess)
  .observe(
    observers.board({ path: './coding/BOARD.md' }),
    observers.telemetry({ path: './coding/TELEMETRY.md' }),
  );

const published = H.state('published').terminal('success');
const brokenLinks = H.state('broken-links').terminal('failure');
const pageSchema = z.object({ path: z.string(), title: z.string(), body: z.string() });
const docPage = H.work('doc-page').schema(pageSchema).states(queued, running, published, brokenLinks);

const writerRole = H.role('writer').promptFile('./prompts/writer.md').intents(['read', 'edit']).recall(taste, experience);
const writer = H.seat('writer').role(writerRole).models(sonnet);

const writePage = H.skill('write-page')
  .input(pageSchema)
  .output(z.object({ body: z.string() }))
  .prompt(i => `Revise ${i.path} (${i.title}):\n\n${i.body}`);

const docsRunner = H.runner.local('docs-workstation', { slots: 2 });

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .runner(docsRunner)
  .run(async (input, ctx) => succeed(await ctx.sh(`npx linkinator ${input.path}`)));

const writeDoc = H.flow('write-doc')
  .input(pageSchema)
  .step('write', writer.call(writePage))
  .step('links', linkCheck, s => ({ path: s.input.path }))
  .exit('published');

const docPages = H.lane('doc-pages')
  .of(docPage)
  .from(supply.folder({ path: './docs-site/pages', schema: pageSchema }).key(d => d.path))
  .store(supply.frontmatter({ path: './docs-site/pages' }))
  .handle(writeDoc)
  .exits({ published, failed: { tries: 2, backoff: 'linear', delaySeconds: 120, then: brokenLinks } })
  .wip(2);

const docsExperience = H.journal('docs-experience')
  .of(experience)
  .store(jsonl.store('./docs-site/.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

export const docsHarness = H.harness('documentation')
  .ledger(sqlite.ledger('./docs-site/.harness/ledger.sqlite'))
  .pools(
    H.pool('subscriptions', subscriptionAccounts(0.3))
      .serves(sonnet)
      .policy(policies.soonestExpiring()),
  )
  .lanes(docPages)
  .journals(ownerTaste, docsExperience)
  .scheduler(H.scheduler().policy(H.policy.schedule('oldest-first', input =>
    [...input.candidates].sort((a, b) => b.waitingSeconds - a.waitingSeconds))))
  .grants(H.grant(
    ownerSession,
    H.ops.work.read,
    H.ops.work.write,
    H.ops.memory.write(ownerTaste, docsExperience),
    H.ops.telemetry.read,
    H.ops.accounts.manage,
  ))
  .observe(
    observers.board({ path: './docs-site/BOARD.md' }),
    observers.telemetry({ path: './docs-site/TELEMETRY.md' }),
  );
