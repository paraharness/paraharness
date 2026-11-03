import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate } from 'harness-dsl/kernel';
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

const queued = H.state('queued').pending();
const done = H.state('done').terminal('success');
const abandoned = H.state('abandoned').terminal('failure');
const due = H.state('due').pending();
const healthy = H.state('healthy').terminal('success');
const unhealthy = H.state('unhealthy').terminal('failure');

const ticketSchema = z.object({ title: z.string(), body: z.string(), reporter: z.string() });
const epicSchema = z.object({ title: z.string(), body: z.string() });
const serviceSchema = z.object({ service: z.string(), url: z.string() });

const epic = H.work('Epic').schema(epicSchema).states(queued, done, abandoned);
const feature = H.work('Feature').schema(ticketSchema).states(queued, done, abandoned);
const bug = H.work('Bug').schema(ticketSchema).states(queued, done, abandoned);
const heartbeat = H.work('ServiceHeartbeat').schema(serviceSchema).states(due, healthy, unhealthy);

const appCode = H.resource('app-code');

const experience = H.memory('experience').content(z.object({ rule: z.string() })).trust('experience');
const taste = H.memory('taste').content(z.object({ rule: z.string() })).trust('taste');

const lessons = H.journal('lessons').of(experience).store(jsonl.memory('.harness/experience.jsonl')).recall(policies.specificity({ limit: 8 }));
const preferences = H.journal('preferences').of(taste).store(jsonl.memory('.harness/taste.jsonl')).recall(policies.specificity({ limit: 12 }));

const quota = sqlite.quota('.harness/quota.db');
const max1 = H.account('max-1', claudeCode.driver({ configDir: H.env('CLAUDE_MAX_1_DIR') })).quota(quota);
const max2 = H.account('max-2', claudeCode.driver({ configDir: H.env('CLAUDE_MAX_2_DIR') })).quota(quota);
const max3 = H.account('max-3', claudeCode.driver({ configDir: H.env('CLAUDE_MAX_3_DIR') })).quota(quota);
const api = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(quota);

const sonnet = H.model('claude-sonnet-4-5', { budgetTokens: 32000 }).pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1', { budgetTokens: 32000 }).pricing(anthropic.pricing());

const claude = H.pool('claude', [max1, max2, max3, api])
  .share(max1, 0.8)
  .share(max2, 0.8)
  .share(max3, 0.5)
  .serves(sonnet, opus)
  .policy(policies.soonestReset())
  .fallback(api);

const bugs = H.lane('bugs').of(bug);
const features = H.lane('features').of(feature);
const epics = H.lane('epics').of(epic);
const heartbeats = H.lane('heartbeats').of(heartbeat);

const bugSuccess = H.metric('bug-success-by-model', H.events.transitions(bugs, { terminal: true }))
  .rate(e => e.verdict === 'success')
  .by('model')
  .window('14d');
const featureSuccess = H.metric('feature-success-by-model', H.events.transitions(features, { terminal: true }))
  .rate(e => e.verdict === 'success')
  .by('model')
  .window('14d');

const cheaperUntilSlip = H.policy.models('cheaper-until-slip', c => {
  const outcomes = c.unit.lane === features.name ? featureSuccess : bugSuccess;
  const cheap = c.metrics.read(outcomes, sonnet);
  const slipped = cheap.samples >= 20 && (cheap.value ?? 1) < 0.85;
  return slipped ? [opus, sonnet] : [sonnet, opus];
});

const local = runners.local({ name: 'local', slots: 4 });

const projectChecks = H.command('project-checks')
  .input(z.object({ workspace: z.string() }))
  .output(z.object({ ok: z.boolean(), report: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['npm', 'run', 'check'], { cwd: input.workspace });
    return { ok: result.code === 0, report: result.stdout + result.stderr };
  });

const probe = H.command('probe-service')
  .input(serviceSchema)
  .output(z.object({ healthy: z.boolean(), status: z.number() }))
  .runner(local)
  .effect('repeatable')
  .run(async input => {
    const response = await fetch(input.url);
    return { healthy: response.ok, status: response.status };
  });

const ownerCall = H.halt('owner-call')
  .context(z.object({ question: z.string() }))
  .decision(z.object({ answer: z.string() }))
  .ask(c => c.question);

const buildChange = H.skill('build-change')
  .input(z.object({ title: z.string(), body: z.string(), round: z.number() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(i => `Round ${i.round}. Implement: ${i.title}\n\n${i.body}`);

const auditChange = H.skill('audit-change')
  .input(z.object({ title: z.string(), summary: z.string(), round: z.number() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit round ${i.round} of "${i.title}". Builder summary:\n${i.summary}\nList every deficit that remains.`);

const planEpic = H.skill('plan-epic')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ features: z.array(z.object({ key: z.string(), title: z.string(), body: z.string() })) }))
  .prompt(i => `Decompose the epic "${i.title}" into features.\n\n${i.body}`);

const builderRole = H.role('builder')
  .promptFile('prompts/builder.md')
  .intents(['read', 'edit', 'shell'])
  .recall(experience, taste)
  .use(plugins.fileLeaseGuard().area(appCode, ['src/**', 'tests/**']), plugins.stopCheck(projectChecks));
const auditorRole = H.role('auditor')
  .promptFile('prompts/auditor.md')
  .intents(['read', 'shell'])
  .recall(experience)
  .record(experience);
const plannerRole = H.role('planner')
  .promptFile('prompts/planner.md')
  .intents(['read'])
  .recall(taste);

const builder = H.seat('builder').role(builderRole).skill(buildChange).models(sonnet, opus).policy(cheaperUntilSlip);
const auditor = H.seat('auditor').role(auditorRole).skill(auditChange).models(opus);
const planner = H.seat('planner').role(plannerRole).skill(planEpic).models(opus);

const ticketFlow = H.flow('build-and-audit')
  .input(z.object({ title: z.string(), body: z.string(), rounds: z.number() }))
  .use(plugins.gitWorktree({ base: 'main' }))
  .loop('round', {
    max: s => s.input.rounds,
    body: f => f
      .step('build', builder, s => ({ title: s.input.title, body: s.input.body, round: s.round.iteration }))
      .when(s => s.build.question !== undefined, g => g.halt('ownerCall', ownerCall, s => ({ question: s.build.question ?? '' })))
      .step('audit', auditor, s => ({ title: s.input.title, summary: s.build.summary, round: s.round.iteration })),
    until: s => s.audit.deficits.length === 0,
  })
  .when(s => s.audit.deficits.length === 0, f => f.exit('done'))
  .exit('roundsOut');

const epicFlow = H.flow('decompose-epic')
  .input(epicSchema)
  .step('plan', planner, s => ({ title: s.input.title, body: s.input.body }))
  .spawn('features', features, s => s.plan.features.map(f => ({ key: f.key, data: { title: f.title, body: f.body, reporter: 'epic' } })))
  .when(s => s.features.every(child => child.verdict === 'success'), f => f.exit('delivered'))
  .exit('incomplete');

const heartbeatFlow = H.flow('heartbeat')
  .input(serviceSchema)
  .step('probe', probe, s => s.input)
  .when(s => !s.probe.healthy, f => f.exit('unhealthy'))
  .exit('healthy');

const trackerStates = { [queued.name]: 'Todo', [done.name]: 'Done', [abandoned.name]: 'Canceled' };
const linearKey = H.env('LINEAR_API_KEY');
const ticketStore = linear.store({ apiKey: linearKey, team: 'PRD', schema: ticketSchema, states: trackerStates });
const epicStore = linear.store({ apiKey: linearKey, team: 'PRD', schema: epicSchema, states: trackerStates });

const bugLane = bugs
  .from(
    linear.issues({ name: 'linear-bugs', apiKey: linearKey, team: 'PRD', labels: ['bug'], data: i => ({ title: i.title, body: i.description, reporter: 'linear' }) }),
    folder.files({ name: 'bug-folder', path: 'bugs', glob: '*.md', data: file => ({ title: file.name, body: file.body, reporter: 'folder' }) }),
    manual('operator-bugs'),
  )
  .store(ticketStore)
  .handle(ticketFlow, {
    input: u => ({ title: u.data.title, body: u.data.body, rounds: 3 }),
    exits: { done, roundsOut: { to: queued, atMost: 1, then: abandoned } },
    retry: { retries: 2, backoff: { initial: '2m', factor: 2 }, exhausted: abandoned },
  })
  .wip(2);

const featureLane = features
  .from(
    linear.issues({ name: 'linear-features', apiKey: linearKey, team: 'PRD', labels: ['feature'], data: i => ({ title: i.title, body: i.description, reporter: 'linear' }) }),
    manual('operator-features'),
  )
  .store(ticketStore)
  .handle(ticketFlow, {
    input: u => ({ title: u.data.title, body: u.data.body, rounds: 5 }),
    exits: { done, roundsOut: { to: queued, atMost: 1, then: abandoned } },
    retry: { retries: 2, backoff: { initial: '2m', factor: 2 }, exhausted: abandoned },
  });

const epicLane = epics
  .from(linear.issues({ name: 'linear-epics', apiKey: linearKey, team: 'PRD', labels: ['epic'], data: i => ({ title: i.title, body: i.description }) }))
  .store(epicStore)
  .handle(epicFlow, {
    exits: { delivered: done, incomplete: { to: queued, atMost: 2, then: abandoned } },
    retry: { retries: 1, backoff: { initial: '10m', factor: 2 }, exhausted: abandoned },
  })
  .wip(1);

const heartbeatLane = heartbeats
  .from(schedule.cron({
    name: 'heartbeat-every-5m',
    cron: '*/5 * * * *',
    children: at => [{ key: `api-${at.toISOString()}`, data: { service: 'api', url: 'https://api.example.com/health' } }],
  }))
  .handle(heartbeatFlow, {
    exits: { healthy, unhealthy },
    retry: { retries: 0, backoff: 'none', exhausted: unhealthy },
  });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.events.transitions(heartbeats, { to: unhealthy }))
  .do(bugs.create(e => ({
    key: `heartbeat-${e.unit.key}`,
    data: { title: `Service ${e.unit.data.service} failed its heartbeat`, body: `Probe of ${e.unit.data.url} failed at ${e.at.toISOString()}.`, reporter: 'heartbeat' },
  })));

const laneOrder: readonly string[] = [heartbeats.name, bugs.name, features.name, epics.name];
const featureStarvedAfterMs = 6 * 60 * 60 * 1000;
const rank = (candidate: Candidate, now: Date): number =>
  candidate.lane === features.name && now.getTime() - candidate.queuedAt.getTime() > featureStarvedAfterMs
    ? 0.5
    : laneOrder.indexOf(candidate.lane);

const priority = H.policy.units('heartbeats-bugs-features-epics', c =>
  [...c.candidates].sort((a, b) => rank(a, c.now) - rank(b, c.now) || a.queuedAt.getTime() - b.queuedAt.getTime()));

const supervisor = H.grant(
  claudeCode.client({ name: 'supervisor' }),
  H.ops.work.read,
  H.ops.work.write,
  H.ops.resolve(ownerCall),
  H.ops.attempts.manage,
  H.ops.memory.write(experience),
  H.ops.memory.write(taste),
  H.ops.telemetry.read,
  H.ops.accounts.manage,
  H.operation('probe-production', probe),
);

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(claude)
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .journals(lessons, preferences)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(priority)
  .grants(supervisor)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

void codingTeam.start();
