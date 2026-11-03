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

const todo = H.state('todo').pending();
const inProgress = H.state('in-progress').active();
const done = H.state('done').terminal('success');
const abandoned = H.state('abandoned').terminal('failure');

const heartbeatDue = H.state('due').pending();
const checking = H.state('checking').active();
const healthy = H.state('healthy').terminal('success');
const unhealthy = H.state('unhealthy').terminal('failure');

const ticket = z.object({
  title: z.string(),
  body: z.string(),
  trackerId: z.string().optional(),
});
const serviceSchema = z.object({ service: z.string() });

const bug = H.work('bug').schema(ticket).states(todo, inProgress, done, abandoned);
const feature = H.work('feature').schema(ticket).states(todo, inProgress, done, abandoned);
const epic = H.work('epic').schema(ticket).states(todo, inProgress, done, abandoned);
const serviceHeartbeat = H.work('service-heartbeat').schema(serviceSchema).states(heartbeatDue, checking, healthy, unhealthy);

const payments = H.resource('payments');
const webApp = H.resource('web-app');
const apiServer = H.resource('api-server');

const experience = H.memory('experience')
  .content(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');
const taste = H.memory('taste')
  .content(z.object({ prefer: z.string(), over: z.string(), because: z.string() }))
  .trust('taste');

const experienceJournal = H.journal('experience-journal')
  .of(experience)
  .store(jsonl.store('memory/experience.jsonl'))
  .recall(policies.specificity({ limit: 8 }));
const tasteJournal = H.journal('taste-journal')
  .of(taste)
  .store(jsonl.store('memory/taste.jsonl'))
  .recall(policies.specificity({ limit: 12 }));

const local = H.runner.local('local', { slots: 4 });

const projectChecks = H.command('project-checks')
  .runner(local)
  .run(async (_input, ctx) => {
    const result = await ctx.sh('npm run check');
    if (result.code === 0) return;
    throw new Error(result.stderr);
  });

const builderRole = H.role('builder')
  .promptFile('prompts/builder.md')
  .intents(['read', 'edit', 'shell'])
  .recall(experience, taste)
  .use(
    plugins.gitWorktreeIsolation(),
    plugins.fileLeaseGuard([
      { resource: payments, globs: ['src/payments/**'] },
      { resource: webApp, globs: ['src/web/**'] },
      { resource: apiServer, globs: ['src/api/**'] },
    ]),
    plugins.stopCheck(projectChecks),
  );
const auditorRole = H.role('auditor')
  .promptFile('prompts/auditor.md')
  .intents(['read', 'shell'])
  .recall(experience)
  .record(experience);
const plannerRole = H.role('planner')
  .promptFile('prompts/planner.md')
  .intents(['read'])
  .recall(taste);

const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());

const quota = sqlite.quota('.harness/quota.db');
const subscriptionA = H.account('subscription-a', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_A') })).maxQuotaShare(0.6).quota(quota);
const subscriptionB = H.account('subscription-b', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_B') })).maxQuotaShare(0.5).quota(quota);
const subscriptionC = H.account('subscription-c', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_C') })).maxQuotaShare(0.4).quota(quota);
const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));

const claudePool = H.pool('claude', [subscriptionA, subscriptionB, subscriptionC])
  .serves(sonnet, opus)
  .policy(policies.soonestExpiring())
  .fallback(apiAccount);

const builderSuccess = H.metric('builder-success').rate(
  H.events.terminal({ verdict: 'success' }),
  H.events.terminal(),
);

const cheaperUntilWorse = H.policy.seat('cheaper-until-worse', input => {
  const cheaper = input.metrics.read(builderSuccess, {
    window: '14d',
    where: { kind: input.unit.kind, seat: input.seat, model: sonnet },
  });
  if (cheaper.samples < 20) return [sonnet, opus];
  return (cheaper.value ?? 0) < 0.85 ? [opus, sonnet] : [sonnet, opus];
});

const builder = H.seat('builder').role(builderRole).models(sonnet, opus).policy(cheaperUntilWorse);
const auditor = H.seat('auditor').role(auditorRole).models(sonnet);
const planner = H.seat('planner').role(plannerRole).models(opus);

const buildSkill = H.skill('build')
  .input(z.object({ title: z.string(), body: z.string(), feedback: z.string() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Implement: ${input.title}\n\n${input.body}\n\nOpen feedback:\n${input.feedback}`);
const auditSkill = H.skill('audit')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}". Builder summary: ${input.summary}`);
const planSkill = H.skill('plan-epic')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }))
  .prompt(input => `Decompose the epic "${input.title}" into features.\n\n${input.body}`);

const ownerDecision = H.halt('owner-decision')
  .context(z.object({ question: z.string() }))
  .ask(context => context.question)
  .decision(z.object({ answer: z.string() }));

const deliver = H.flow('deliver')
  .input(ticket.extend({ rounds: z.number().int() }))
  .resources(() => [payments, webApp, apiServer])
  .loop('rounds', {
    maxIterations: s => s.input.rounds,
    initial: () => ({ feedback: '' }),
    body: f => f
      .step('build', builder.call(buildSkill), s => ({ title: s.input.title, body: s.input.body, feedback: s.carry.feedback }))
      .when(
        s => typeof s.steps.build.question === 'string',
        b => b.halt('askOwner', ownerDecision, s => ({ question: s.steps.build.question ?? '' })),
      )
      .step('audit', auditor.call(auditSkill), s => ({ title: s.input.title, summary: s.steps.build.summary })),
    next: s => ({ feedback: [...s.steps.audit.deficits, s.steps.askOwner?.answer ?? ''].join('\n') }),
    until: s => s.steps.audit.deficits.length === 0,
  })
  .exit(s => (s.steps.rounds.completed ? 'delivered' : 'roundsExhausted'));

const deliverBug = H.handler('deliver-bug')
  .of(bug)
  .flow(deliver, unit => ({ ...unit.data, rounds: 3 }))
  .exits({ delivered: done, roundsExhausted: abandoned })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 60, exhausted: abandoned });
const deliverFeature = H.handler('deliver-feature')
  .of(feature)
  .flow(deliver, unit => ({ ...unit.data, rounds: 5 }))
  .exits({ delivered: done, roundsExhausted: abandoned })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 60, exhausted: abandoned });

const linearKey = H.env('LINEAR_API_KEY');
const trackerStatuses = [
  [todo, 'Todo'],
  [inProgress, 'In Progress'],
  [done, 'Done'],
  [abandoned, 'Canceled'],
] as const;
const trackerStore = linear.store({ apiKey: linearKey, team: 'PRODUCT', statuses: trackerStatuses });

const fromTracker = (label: string) =>
  linear.issues({ apiKey: linearKey, team: 'PRODUCT', labels: [label] })
    .map(issue => ({ title: issue.title, body: issue.description, trackerId: issue.identifier }))
    .key(data => data.trackerId);

const bugs = H.lane('bugs', deliverBug)
  .from(fromTracker('bug'), supply.folder({ path: 'work/bugs', schema: ticket }), supply.manual())
  .store(trackerStore)
  .wip(2);
const features = H.lane('features', deliverFeature)
  .from(fromTracker('feature'), supply.manual())
  .store(trackerStore);

const decompose = H.flow('decompose')
  .input(ticket)
  .step('plan', planner.call(planSkill), s => ({ title: s.input.title, body: s.input.body }))
  .spawn('children', features, s => s.steps.plan.features.map(child => ({ title: child.title, body: child.body })))
  .exit(s => (s.steps.children.every(child => child.verdict === 'success') ? 'complete' : 'incomplete'));

const decomposeEpic = H.handler('decompose-epic')
  .of(epic)
  .flow(decompose)
  .exits({ complete: done, incomplete: abandoned })
  .retry({ tries: 1, backoff: 'linear', delaySeconds: 300, exhausted: abandoned });

const epics = H.lane('epics', decomposeEpic)
  .from(fromTracker('epic'))
  .store(trackerStore)
  .wip(1);

const services = ['api', 'web', 'worker'];

const probeService = H.command('probe-service')
  .input(serviceSchema)
  .output(z.object({ healthy: z.boolean(), status: z.number() }))
  .runner(local)
  .run(async (input, ctx) => {
    const response = await fetch(`https://${input.service}.${ctx.resolve(H.env('SERVICE_DOMAIN'))}/health`);
    return { healthy: response.ok, status: response.status };
  });

const heartbeatFlow = H.flow('heartbeat')
  .input(serviceSchema)
  .step('probe', probeService)
  .exit(s => (s.steps.probe.healthy ? 'healthy' : 'unhealthy'));

const checkService = H.handler('check-service')
  .of(serviceHeartbeat)
  .flow(heartbeatFlow)
  .exits({ healthy, unhealthy })
  .retry({ tries: 0, backoff: 'none', exhausted: unhealthy });

const heartbeats = H.lane('heartbeats', checkService)
  .from(supply.schedule({ cron: '*/5 * * * *', units: () => services.map(service => ({ service })) }));

const heartbeatToBug = H.trigger('heartbeat-failure-files-bug')
  .on(heartbeats.enters(unhealthy))
  .do(bugs.create(
    p => ({ title: `Service ${p.unit.data.service} failed its heartbeat`, body: `Heartbeat attempt ${p.attempt?.id ?? 'unknown'} reported unhealthy.` }),
    p => `heartbeat:${p.unit.data.service}`,
  ));

const starvedAfterSeconds = 6 * 3600;

const priority = H.policy.schedule('heartbeats-bugs-features-epics', input => {
  const waitingFeatures = input.of(features);
  return [
    ...input.of(heartbeats),
    ...waitingFeatures.filter(c => c.waitingSeconds > starvedAfterSeconds),
    ...input.of(bugs),
    ...waitingFeatures.filter(c => c.waitingSeconds <= starvedAfterSeconds),
    ...input.of(epics),
  ];
});

const productionHealth = H.operation(
  'production-health-probe',
  H.command('production-health')
    .output(z.object({ healthy: z.boolean(), status: z.number() }))
    .run(async (_input, ctx) => {
      const response = await fetch(ctx.resolve(H.env('PRODUCTION_HEALTH_URL')));
      return { healthy: response.ok, status: response.status };
    }),
);

const supervisor = claudeCode.client('supervisor');
const supervisorGrant = H.grant(
  supervisor,
  H.ops.work.read,
  H.ops.work.write,
  H.ops.resolve(ownerDecision),
  H.ops.memory.write(experienceJournal, tasteJournal),
  H.ops.telemetry.read,
  H.ops.accounts.manage,
  productionHealth,
);

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(claudePool)
  .lanes(heartbeats, bugs, features, epics)
  .journals(experienceJournal, tasteJournal)
  .triggers(heartbeatToBug)
  .scheduler(H.scheduler().policy(priority))
  .grants(supervisorGrant)
  .metrics(builderSuccess)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

void harness.start();
