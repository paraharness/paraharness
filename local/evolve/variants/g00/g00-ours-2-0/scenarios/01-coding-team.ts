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

const queued = H.state('queued').pending();
const building = H.state('building').active();
const ownerReview = H.state('ownerReview').waiting();
const done = H.state('done').terminal('success');
const abandoned = H.state('abandoned').terminal('failure');
const cancelled = H.state('cancelled').terminal('neutral');
const due = H.state('due').pending();
const checking = H.state('checking').active();
const healthy = H.state('healthy').terminal('success');
const unhealthy = H.state('unhealthy').terminal('failure');

const issueSchema = z.object({ title: z.string(), description: z.string(), reference: z.string().optional() });
const heartbeatSchema = z.object({ service: z.string(), at: z.string() });

const epic = H.work('Epic').schema(issueSchema).states(queued, building, done, abandoned, cancelled);
const feature = H.work('Feature').schema(issueSchema).states(queued, building, ownerReview, done, abandoned, cancelled);
const bug = H.work('Bug').schema(issueSchema).states(queued, building, ownerReview, done, abandoned, cancelled);
const serviceHeartbeat = H.work('ServiceHeartbeat').schema(heartbeatSchema).states(due, checking, healthy, unhealthy);

const payments = H.resource('payments');
const web = H.resource('web');
const platform = H.resource('platform');
const areas = [payments, web, platform];

const ruleSchema = z.object({ action: z.string(), condition: z.string(), reason: z.string() });
const experience = H.memory('experience').content(ruleSchema).trust('experience');
const taste = H.memory('taste').content(z.object({ preference: z.string() })).trust('taste');

const experienceJournal = H.journal('experience')
  .of(experience)
  .store(jsonl.store('memory/experience.jsonl'))
  .recall(policies.specificity({ limit: 12 }));
const tasteJournal = H.journal('taste')
  .of(taste)
  .store(jsonl.store('memory/taste.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const workstation = H.runner.local('workstation', { slots: 4 });

const projectChecks = H.command('project-checks')
  .runner(workstation)
  .effect('repeatable')
  .run(async (_input, ctx) => {
    const result = await ctx.sh('npm run check');
    if (result.code !== 0) throw new Error(result.stderr);
  });

const productionHealth = H.command('production-health')
  .output(z.object({ healthy: z.boolean(), status: z.number() }))
  .runner(workstation)
  .effect('repeatable')
  .run(async (_input, ctx) => {
    const response = await fetch(ctx.resolve(H.env('PRODUCTION_HEALTH_URL')), { signal: ctx.signal });
    return { healthy: response.ok, status: response.status };
  });

const builderRole = H.role('builder')
  .promptFile('prompts/builder.md')
  .intents(['read', 'edit', 'shell'])
  .recall(experience, taste)
  .use(
    plugins.gitWorktreeIsolation(),
    plugins.fileLeaseGuard([
      { resource: payments, globs: ['src/payments/**'] },
      { resource: web, globs: ['src/web/**'] },
      { resource: platform, globs: ['src/platform/**', 'package.json'] },
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

const quota = H.env('SHARED_QUOTA_PATH');
const quotaPartition = sqlite.quota('shared/quota.db');
const subscription = (name: string, configDirVariable: string, share: number) =>
  H.account(name, claudeCode.driver({ configDir: H.env(configDirVariable) }))
    .maxQuotaShare(share)
    .quota(quotaPartition);

const claudeOne = subscription('claude-one', 'CLAUDE_ONE_CONFIG', 0.6);
const claudeTwo = subscription('claude-two', 'CLAUDE_TWO_CONFIG', 0.6);
const claudeThree = subscription('claude-three', 'CLAUDE_THREE_CONFIG', 0.4);
const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(quotaPartition);

const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());

const subscriptions = H.pool('subscriptions', [claudeOne, claudeTwo, claudeThree])
  .serves(sonnet, opus)
  .policy(policies.soonestExpiring())
  .fallback(apiAccount);

const kindSuccessRate = H.metric('kind-success-rate').rate(
  H.events.terminal({ verdict: 'success' }),
  H.events.terminal(),
);

const cheaperUntilItSlips = H.policy.seat('cheaper-until-it-slips', ({ unit, metrics }) => {
  const cheaper = metrics.read(kindSuccessRate, { window: '14d', where: { kind: unit.kind, model: sonnet } });
  const trusted = cheaper.samples < 20 || cheaper.value === undefined || cheaper.value >= 0.85;
  return trusted ? [sonnet, opus] : [opus, sonnet];
});

const builder = H.seat('builder').role(builderRole).models(sonnet, opus).policy(cheaperUntilItSlips);
const auditor = H.agent('auditor').role(auditorRole).model(sonnet);
const planner = H.agent('planner').role(plannerRole).model(opus);

const build = H.skill('build')
  .input(z.object({
    title: z.string(),
    description: z.string(),
    deficits: z.array(z.string()),
    guidance: z.string().optional(),
  }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(i => `Build: ${i.title}\n\n${i.description}\n\nOpen deficits:\n${i.deficits.join('\n')}\n\nOwner guidance: ${i.guidance ?? 'none'}`);

const audit = H.skill('audit')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit the change for "${i.title}". Builder summary:\n${i.summary}\nList every deficit that remains.`);

const planEpic = H.skill('plan-epic')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(i => `Decompose the epic "${i.title}" into features.\n\n${i.description}`);

const ownerDecision = H.halt('owner-decision')
  .context(z.object({ title: z.string(), question: z.string() }))
  .ask(c => `${c.title}: ${c.question}`)
  .decision(z.object({ answer: z.string() }));

type Rounds = { readonly deficits: string[]; readonly guidance: string | undefined };

const deliver = H.flow('deliver')
  .input(z.object({ title: z.string(), description: z.string(), rounds: z.number() }))
  .resources(s => areas.filter(area => s.input.description.toLowerCase().includes(area.name)))
  .loop('rounds', {
    maxIterations: s => s.input.rounds,
    initial: (): Rounds => ({ deficits: [], guidance: undefined }),
    body: round => round
      .step('build', builder.call(build), s => ({
        title: s.input.title,
        description: s.input.description,
        deficits: s.carry.deficits,
        guidance: s.carry.guidance,
      }))
      .when(s => s.steps.build.question !== undefined, ask => ask
        .halt('ownerDecision', ownerDecision, s => ({ title: s.input.title, question: s.steps.build.question ?? '' })))
      .step('audit', auditor.call(audit), s => ({ title: s.input.title, summary: s.steps.build.summary })),
    next: s => ({ deficits: s.steps.audit.deficits, guidance: s.steps.ownerDecision?.answer ?? s.carry.guidance }),
    until: s => s.steps.audit.deficits.length === 0,
  })
  .exit(s => (s.steps.rounds.completed ? 'delivered' : 'roundsExhausted'));

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({
  apiKey: linearKey,
  team: 'ENG',
  statuses: [
    [queued, 'Todo'],
    [building, 'In Progress'],
    [ownerReview, 'In Review'],
    [done, 'Done'],
    [abandoned, 'Canceled'],
    [cancelled, 'Canceled'],
  ],
});
const fromTracker = (label: string) =>
  linear.issues({ apiKey: linearKey, team: 'ENG', labels: [label] })
    .map(issue => ({ title: issue.title, description: issue.description, reference: issue.identifier }))
    .key(data => data.reference);

const bugs = H.lane('bugs')
  .of(bug)
  .from(fromTracker('bug'), supply.folder({ path: 'inbox/bugs', schema: issueSchema }), supply.manual())
  .store(tracker)
  .handle(deliver, unit => ({ title: unit.data.title, description: unit.data.description, rounds: 3 }))
  .exits({ delivered: done, roundsExhausted: ownerReview })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 300, exhausted: abandoned })
  .wip(2);

const features = H.lane('features')
  .of(feature)
  .from(fromTracker('feature'), supply.manual())
  .store(tracker)
  .handle(deliver, unit => ({ title: unit.data.title, description: unit.data.description, rounds: 5 }))
  .exits({ delivered: done, roundsExhausted: ownerReview })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 300, exhausted: abandoned });

const decompose = H.flow('decompose')
  .input(issueSchema)
  .step('plan', planner.call(planEpic), s => ({ title: s.input.title, description: s.input.description }))
  .spawn('features', features, s => s.steps.plan.features.map(f => ({ title: f.title, description: f.description })))
  .exit(s => (s.steps.features.every(child => child.verdict === 'success') ? 'completed' : 'incomplete'));

const epics = H.lane('epics')
  .of(epic)
  .from(fromTracker('epic'))
  .store(tracker)
  .handle(decompose)
  .exits({ completed: done, incomplete: abandoned })
  .retry({ tries: 1, backoff: 'none', exhausted: abandoned })
  .wip(1);

const probeService = H.command('probe-service')
  .input(heartbeatSchema)
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .runner(workstation)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const response = await fetch(ctx.resolve(H.env(`HEALTH_URL_${input.service.toUpperCase()}`)), { signal: ctx.signal });
    return { healthy: response.ok, detail: `HTTP ${response.status}` };
  });

const heartbeat = H.flow('heartbeat')
  .input(heartbeatSchema)
  .step('probe', probeService)
  .exit(s => (s.steps.probe.healthy ? 'healthy' : 'unhealthy'));

const services = ['api', 'web', 'worker'];

const heartbeats = H.lane('heartbeats')
  .of(serviceHeartbeat)
  .from(supply.schedule({
    cron: '*/5 * * * *',
    units: now => services.map(service => ({ service, at: now.toISOString() })),
  }).key(data => `${data.service}-${data.at}`))
  .handle(heartbeat)
  .exits({ healthy, unhealthy })
  .retry({ tries: 1, backoff: 'none', exhausted: unhealthy });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(heartbeats.enters(unhealthy))
  .do(bugs.create(
    p => ({
      title: `Service ${p.unit.data.service} failed its heartbeat`,
      description: `The heartbeat at ${p.unit.data.at} found ${p.unit.data.service} unhealthy.`,
    }),
    p => `heartbeat-${p.unit.data.service}`,
  ));

const featureStarvationSeconds = 4 * 3600;
const laneOrder = [heartbeats.name, bugs.name, features.name, epics.name];

const heartbeatsBugsFeaturesEpics = H.policy.schedule('heartbeats-bugs-features-epics', ({ candidates }) => {
  const rank = (lane: string, waitingSeconds: number) =>
    lane === features.name && waitingSeconds > featureStarvationSeconds ? 0.5 : laneOrder.indexOf(lane);
  return [...candidates].sort((a, b) =>
    rank(a.lane.name, a.waitingSeconds) - rank(b.lane.name, b.waitingSeconds) || b.waitingSeconds - a.waitingSeconds);
});

const supervisor = H.grant(
  claudeCode.client('supervisor', { session: 'coding-team' }),
  H.ops.work.read,
  H.ops.work.write,
  H.ops.resolve(ownerDecision),
  H.ops.memory.write(experienceJournal, tasteJournal),
  H.ops.telemetry.read,
  H.ops.accounts.manage,
  H.operation('production-health', productionHealth),
);

export const sharedQuotaVariable = quota;

export default H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(subscriptions)
  .lanes(heartbeats, bugs, features, epics)
  .journals(experienceJournal, tasteJournal)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(H.scheduler().policy(heartbeatsBugsFeaturesEpics))
  .grants(supervisor)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));
