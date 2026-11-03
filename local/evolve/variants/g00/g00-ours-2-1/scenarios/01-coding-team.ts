import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { folder, manual, schedule } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';
import { plugins } from 'harness-dsl/plugins';

const ticket = z.object({ title: z.string(), body: z.string(), epic: z.string().optional() });
const epicBrief = z.object({ title: z.string(), body: z.string() });
const heartbeatTarget = z.object({ service: z.string() });
type Ticket = z.infer<typeof ticket>;
type EpicBrief = z.infer<typeof epicBrief>;
type HeartbeatTarget = z.infer<typeof heartbeatTarget>;

const queued = H.state('queued').pending();
const working = H.state('working').active();
const done = H.state('done').terminal('success');
const unfinished = H.state('unfinished').terminal('failure');
const due = H.state('due').pending();
const probing = H.state('probing').active();
const healthy = H.state('healthy').terminal('success');
const unhealthy = H.state('unhealthy').terminal('failure');

const Bug = H.work('bug').schema(ticket).states(queued, working, done, unfinished);
const Feature = H.work('feature').schema(ticket).states(queued, working, done, unfinished);
const Epic = H.work('epic').schema(epicBrief).states(queued, working, done, unfinished);
const ServiceHeartbeat = H.work('service-heartbeat').schema(heartbeatTarget).states(due, probing, healthy, unhealthy);

const appCode = H.resource('app-code');

const ownerDecision = H.halt('owner-decision')
  .context(z.object({ question: z.string() }))
  .decision(z.object({ answer: z.string() }))
  .ask(context => context.question);

const experience = H.memory('experience').content(z.object({ rule: z.string() })).trust('experience');
const taste = H.memory('taste').content(z.object({ rule: z.string() })).trust('taste');

const subscriptionQuota = sqlite.quota('~/.harness/claude-quota.sqlite');
const max1 = H.account('max-1', claudeCode.driver({ configDir: '~/.claude-max-1' })).maxQuotaShare(0.5).quota(subscriptionQuota);
const max2 = H.account('max-2', claudeCode.driver({ configDir: '~/.claude-max-2' })).maxQuotaShare(0.5).quota(subscriptionQuota);
const max3 = H.account('max-3', claudeCode.driver({ configDir: '~/.claude-max-3' })).maxQuotaShare(0.3).quota(subscriptionQuota);
const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));

const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1', { budgetTokens: 32000 }).pricing(anthropic.pricing());

const local = runners.local({ name: 'local', slots: 4 });

const projectChecks = H.command('project-checks')
  .input(z.object({ workspace: z.string() }))
  .output(z.object({ ok: z.boolean(), report: z.string() }))
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['npm', 'run', 'check'], { cwd: input.workspace });
    return { ok: result.code === 0, report: result.stdout + result.stderr };
  });

const probeService = H.command('probe-service')
  .input(heartbeatTarget)
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['curl', '-fsS', `https://${input.service}.internal/health`]);
    return { healthy: result.code === 0, detail: result.stderr };
  });

const productionHealthProbe = H.command('production-health-probe')
  .input(z.object({}))
  .output(z.object({ healthy: z.boolean(), report: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (_input, ctx) => {
    const result = await ctx.exec(['curl', '-fsS', 'https://app.example.com/healthz']);
    return { healthy: result.code === 0, report: result.stdout };
  });

const builder = H.role('builder')
  .promptFile('prompts/builder.md')
  .intents(['read', 'edit', 'shell'])
  .recall(experience, taste)
  .use(plugins.fileLeaseGuard().area(appCode, ['src/**', 'tests/**']), plugins.stopCheck(projectChecks));
const auditor = H.role('auditor')
  .promptFile('prompts/auditor.md')
  .intents(['read', 'shell'])
  .recall(experience)
  .record(experience);
const planner = H.role('planner').promptFile('prompts/planner.md').intents(['read']).recall(taste);

const build = H.skill('build')
  .input(z.object({ title: z.string(), body: z.string(), round: z.number() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Round ${input.round}: ${input.title}\n\n${input.body}`);
const audit = H.skill('audit')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for "${input.title}": ${input.summary}`);
const decompose = H.skill('decompose')
  .input(epicBrief)
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }))
  .prompt(input => `Decompose the epic "${input.title}" into features.\n\n${input.body}`);

const bugs = H.lane('bugs').of(Bug);
const features = H.lane('features').of(Feature);
const epics = H.lane('epics').of(Epic);
const heartbeats = H.lane('heartbeats').of(ServiceHeartbeat);

const bugSuccess = H.metric('bug-success', H.events.transitions(bugs, { terminal: true }))
  .rate(event => event.verdict === 'success')
  .by('model')
  .window('14d');
const featureSuccess = H.metric('feature-success', H.events.transitions(features, { terminal: true }))
  .rate(event => event.verdict === 'success')
  .by('model')
  .window('14d');

const cheapUntilUnreliable = H.policy.models('cheap-until-unreliable', choice => {
  const success = choice.unit.lane === bugs.name ? bugSuccess : featureSuccess;
  const reading = choice.metrics.read(success, { model: sonnet.name });
  const stillReliable = reading.samples < 20 || (reading.value ?? 1) >= 0.85;
  return stillReliable ? [sonnet, opus] : [opus, sonnet];
});

const builderSeat = H.seat('builder-seat').role(builder).skill(build).models(sonnet, opus).policy(cheapUntilUnreliable);
const auditorSeat = H.seat('auditor-seat').role(auditor).skill(audit).models(opus);
const plannerSeat = H.seat('planner-seat').role(planner).skill(decompose).models(opus);

const buildAndAudit = H.flow('build-and-audit')
  .input(ticket.extend({ rounds: z.number() }))
  .use(plugins.gitWorktree({ base: 'main' }))
  .resources(() => [appCode.shared()])
  .loop('round', {
    max: state => state.input.rounds,
    body: round => round
      .step('build', builderSeat, state => ({ title: state.input.title, body: state.input.body, round: state.round.iteration }))
      .when(state => state.build.question !== undefined, ask => ask
        .halt('owner', ownerDecision, state => ({ question: state.build.question ?? '' })))
      .step('audit', auditorSeat, state => ({ title: state.input.title, summary: state.build.summary })),
    until: state => state.audit.deficits.length === 0,
  })
  .when(state => state.audit.deficits.length === 0, clean => clean.exit('clean'))
  .exit('rounds-exhausted');

const decomposeEpic = H.flow('decompose-epic')
  .input(epicBrief)
  .step('plan', plannerSeat, state => ({ title: state.input.title, body: state.input.body }))
  .spawn('features', features, (state, ctx) => state.plan.features.map((feature, index) => ({
    key: `${ctx.unit.key}-f${index + 1}`,
    data: { title: feature.title, body: feature.body, epic: ctx.unit.key },
  })))
  .when(state => state.features.every(child => child.verdict === 'success'), complete => complete.exit('complete'))
  .exit('incomplete');

const heartbeatCheck = H.flow('heartbeat-check')
  .input(heartbeatTarget)
  .step('probe', probeService, state => ({ service: state.input.service }))
  .when(state => state.probe.healthy, ok => ok.exit('healthy'))
  .exit('unhealthy');

const linearKey = H.env('LINEAR_API_KEY');
const ticketStore = linear.store({ apiKey: linearKey, team: 'APP', schema: ticket, states: { queued: 'Todo', working: 'In Progress', done: 'Done', unfinished: 'Canceled' } });
const epicStore = linear.store({ apiKey: linearKey, team: 'APP', schema: epicBrief, states: { queued: 'Todo', working: 'In Progress', done: 'Done', unfinished: 'Canceled' } });

const bugLane = bugs
  .from(
    linear.issues<Ticket>({ name: 'linear-bugs', apiKey: linearKey, team: 'APP', labels: ['bug'], data: issue => ({ title: issue.title, body: issue.description }) }),
    folder.files<Ticket>({ name: 'bug-folder', path: 'bugs', glob: '*.md', data: file => ({ title: file.name, body: file.body }) }),
    manual<Ticket>('operator-bugs'),
  )
  .store(ticketStore)
  .handle(buildAndAudit, {
    input: unit => ({ ...unit.data, rounds: 3 }),
    exits: { clean: done, 'rounds-exhausted': unfinished },
    retry: { retries: 1, backoff: 'none', exhausted: unfinished },
  })
  .wip(2);

const featureLane = features
  .from(
    linear.issues<Ticket>({ name: 'linear-features', apiKey: linearKey, team: 'APP', labels: ['feature'], data: issue => ({ title: issue.title, body: issue.description, epic: issue.parentId }) }),
    manual<Ticket>('operator-features'),
  )
  .store(ticketStore)
  .handle(buildAndAudit, {
    input: unit => ({ ...unit.data, rounds: 5 }),
    exits: { clean: done, 'rounds-exhausted': unfinished },
    retry: { retries: 1, backoff: 'none', exhausted: unfinished },
  });

const epicLane = epics
  .from(linear.issues<EpicBrief>({ name: 'linear-epics', apiKey: linearKey, team: 'APP', labels: ['epic'], data: issue => ({ title: issue.title, body: issue.description }) }))
  .store(epicStore)
  .handle(decomposeEpic, {
    exits: { complete: done, incomplete: unfinished },
    retry: { retries: 1, backoff: 'none', exhausted: unfinished },
  })
  .wip(1);

const heartbeatLane = heartbeats
  .from(schedule.cron<HeartbeatTarget>({
    name: 'heartbeat-every-five-minutes',
    cron: '*/5 * * * *',
    children: at => [{ key: `api-${at.toISOString()}`, data: { service: 'api' } }],
  }))
  .handle(heartbeatCheck, {
    exits: { healthy, unhealthy },
    retry: { retries: 0, backoff: 'none', exhausted: unhealthy },
  });

const unhealthyHeartbeatFilesBug = H.trigger('unhealthy-heartbeat-files-bug')
  .on(H.events.transitions(heartbeatLane, { to: unhealthy }))
  .do(bugLane.create(event => ({
    key: `heartbeat-${event.unit.key}`,
    data: { title: `Heartbeat failed for ${event.unit.data.service}`, body: `The heartbeat ${event.unit.key} reported the service unhealthy.` },
  })));

const laneOrder: readonly string[] = [heartbeatLane.name, bugLane.name, featureLane.name, epicLane.name];
const starvationMs = 4 * 60 * 60 * 1000;

const workPriority = H.policy.units('heartbeats-bugs-features-epics', choice => {
  const byLaneThenAge = [...choice.candidates].sort((a, b) =>
    laneOrder.indexOf(a.lane) - laneOrder.indexOf(b.lane) || a.queuedAt.getTime() - b.queuedAt.getTime());
  const heartbeatsFirst = byLaneThenAge.filter(candidate => candidate.lane === heartbeatLane.name);
  const starvedFeatures = byLaneThenAge.filter(candidate =>
    candidate.lane === featureLane.name && choice.now.getTime() - candidate.queuedAt.getTime() > starvationMs);
  const rest = byLaneThenAge.filter(candidate => !heartbeatsFirst.includes(candidate) && !starvedFeatures.includes(candidate));
  return [...heartbeatsFirst, ...starvedFeatures, ...rest];
});

const supervisor = claudeCode.client({ name: 'supervisor' });

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .pools(H.pool('claude-subscriptions', [max1, max2, max3]).serves(sonnet, opus).policy(policies.soonestReset()).fallback(apiAccount))
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .journals(
    H.journal('experience-journal').of(experience).store(jsonl.memory('.harness/experience.jsonl')).recall(policies.specificity({ limit: 8 })),
    H.journal('taste-journal').of(taste).store(jsonl.memory('.harness/taste.jsonl')).recall(policies.specificity({ limit: 12 })),
  )
  .triggers(unhealthyHeartbeatFilesBug)
  .scheduler(workPriority)
  .grants(H.grant(
    supervisor,
    H.ops.work.read,
    H.ops.work.write,
    H.ops.resolve(ownerDecision),
    H.ops.memory.write(experience),
    H.ops.memory.write(taste),
    H.ops.telemetry.read,
    H.ops.accounts.manage,
    H.operation('production-health', productionHealthProbe),
  ))
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

export default harness;
