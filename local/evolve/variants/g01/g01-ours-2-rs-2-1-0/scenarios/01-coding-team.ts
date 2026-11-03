import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Policy } from 'harness-dsl';
import type { Candidate, TransitionEvent } from 'harness-dsl/kernel';
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

const todo = H.state('todo').pending();
const done = H.state('done').terminal('success');
const unresolved = H.state('unresolved').terminal('failure');
const due = H.state('due').pending();
const healthy = H.state('healthy').terminal('success');
const down = H.state('down').terminal('failure');

const workSchema = z.object({ title: z.string(), body: z.string(), origin: z.string() });
type WorkData = z.infer<typeof workSchema>;
const heartbeatSchema = z.object({ service: z.string() });
type HeartbeatData = z.infer<typeof heartbeatSchema>;

const bug = H.work('bug').schema(workSchema).states(todo, done, unresolved);
const feature = H.work('feature').schema(workSchema).states(todo, done, unresolved);
const epic = H.work('epic').schema(workSchema).states(todo, done, unresolved);
const heartbeat = H.work('service-heartbeat').schema(heartbeatSchema).states(due, healthy, down);

const sourceTree = H.resource('source-tree');

const experience = H.memory('experience').content(z.object({ rule: z.string() })).trust('experience');
const taste = H.memory('taste').content(z.object({ rule: z.string() })).trust('taste');

const experienceLog = H.journal('coding-experience')
  .of(experience)
  .store(jsonl.memory('memory/experience.jsonl'))
  .recall(policies.specificity({ limit: 8 }));
const tasteLog = H.journal('owner-taste')
  .of(taste)
  .store(jsonl.memory('memory/taste.jsonl'))
  .recall(policies.specificity({ limit: 12 }));

const quotaEvents = sqlite.quota('.harness/quota.sqlite');
const max1 = H.account('max-1', claudeCode.driver({ configDir: H.env('CLAUDE_MAX_1_DIR') })).quota(quotaEvents);
const max2 = H.account('max-2', claudeCode.driver({ configDir: H.env('CLAUDE_MAX_2_DIR') })).quota(quotaEvents);
const max3 = H.account('max-3', claudeCode.driver({ configDir: H.env('CLAUDE_MAX_3_DIR') })).quota(quotaEvents);
const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(quotaEvents);

const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());

const claudePool = H.pool('coding-claude', [max1, max2, max3])
  .serves(sonnet, opus)
  .maxQuotaShare(0.5, max1)
  .maxQuotaShare(0.3, max2, max3)
  .policy(policies.soonestReset())
  .fallback(apiAccount);

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

const probeService = H.command('probe-service')
  .input(heartbeatSchema)
  .output(z.object({ status: z.number() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['curl', '-fsS', '-o', '/dev/null', '-w', '%{http_code}', `https://${input.service}/health`]);
    if (result.code !== 0) throw new Error(`${input.service} is unhealthy: ${result.stderr}`);
    return { status: Number(result.stdout) };
  });

const productionHealth = H.command('production-health')
  .input(z.object({ target: z.string() }))
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['./bin/health-probe', input.target]);
    return { healthy: result.code === 0, detail: result.stdout };
  });

const ownerDecision = H.halt('owner-decision')
  .context(z.object({ question: z.string() }))
  .decision(z.object({ answer: z.string() }))
  .ask(c => c.question);

const builderRole = H.role('builder')
  .promptFile('prompts/builder.md')
  .intents(['read', 'edit', 'shell'])
  .recall(experience, taste)
  .use(plugins.fileLeaseGuard().area(sourceTree, ['src/**', 'test/**']), plugins.stopCheck(projectChecks));
const auditorRole = H.role('auditor')
  .promptFile('prompts/auditor.md')
  .intents(['read', 'shell'])
  .recall(experience)
  .record(experience);
const plannerRole = H.role('planner')
  .promptFile('prompts/planner.md')
  .intents(['read'])
  .recall(taste);

const buildSkill = H.skill('build')
  .input(z.object({ title: z.string(), body: z.string(), round: z.number() }))
  .output(z.object({ summary: z.string(), question: z.string() }))
  .prompt(i => `Round ${i.round}: ${i.title}\n\n${i.body}`);
const auditSkill = H.skill('audit')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit the change for "${i.title}": ${i.summary}`);
const planSkill = H.skill('plan-epic')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }))
  .prompt(i => `Decompose the epic "${i.title}" into features.\n\n${i.body}`);

const builderModels: Policy<'models'> = H.policy.models('cheaper-builder-until-85-percent', choice => {
  const kind = [bug, feature].find(k => k.name === choice.unit.kind);
  if (kind === undefined) return [sonnet, opus];
  const cheaper = choice.metrics.read(builderSuccess, sonnet, kind);
  if (cheaper.samples < 20) return [sonnet, opus];
  return (cheaper.value ?? 1) >= 0.85 ? [sonnet, opus] : [opus, sonnet];
});

const builder = H.seat('builder').role(builderRole).skill(buildSkill).models(sonnet, opus).policy(builderModels);
const auditor = H.seat('auditor').role(auditorRole).skill(auditSkill).models(sonnet);
const planner = H.seat('planner').role(plannerRole).skill(planSkill).models(opus);

const builderSuccess = H.metric('builder-success', H.events.attempts().credit([builder], e => e.outcome === 'succeeded'))
  .rate(e => e.credited)
  .by('model', 'kind')
  .window('14d');

const buildAndAudit = H.flow('build-and-audit')
  .input(z.object({ title: z.string(), body: z.string(), rounds: z.number() }))
  .use(plugins.gitWorktree({ base: 'main' }))
  .loop('round', {
    max: s => s.input.rounds,
    body: f =>
      f
        .step('build', builder, s => ({ title: s.input.title, body: s.input.body, round: s.round.iteration }))
        .when(s => s.build.question.length > 0, g => g.halt('decide', ownerDecision, s => ({ question: s.build.question })))
        .step('audit', auditor, s => ({ title: s.input.title, summary: s.build.summary })),
    until: s => s.audit.deficits.length === 0,
  })
  .when(s => s.audit.deficits.length > 0, f => f.exit('unfinished'))
  .exit('done');

const heartbeatFlow = H.flow('service-heartbeat')
  .input(heartbeatSchema)
  .step('probe', probeService, s => ({ service: s.input.service }))
  .exit('healthy');

const linearKey = H.env('LINEAR_API_KEY');
const trackerStates = { todo: 'Todo', done: 'Done', unresolved: 'Canceled' };

const bugs = H.lane('bugs')
  .of(bug)
  .from(
    linear.issues<WorkData>({ name: 'linear-bugs', apiKey: linearKey, team: 'ENG', labels: ['bug'], data: i => ({ title: i.title, body: i.description, origin: i.identifier }) }),
    folder.files<WorkData>({ name: 'bug-folder', path: 'bugs', glob: '*.md', data: f => ({ title: f.name, body: f.body, origin: f.path }) }),
    manual<WorkData>('operator-bugs'),
  )
  .store(linear.store({ apiKey: linearKey, team: 'ENG', schema: workSchema, states: trackerStates }))
  .handle(buildAndAudit, {
    input: u => ({ title: u.data.title, body: u.data.body, rounds: 3 }),
    exits: { done, unfinished: unresolved },
    retry: { retries: 2, backoff: { initial: '5m', factor: 2 }, exhausted: unresolved },
  })
  .wip(2);

const features = H.lane('features')
  .of(feature)
  .from(
    linear.issues<WorkData>({ name: 'linear-features', apiKey: linearKey, team: 'ENG', labels: ['feature'], data: i => ({ title: i.title, body: i.description, origin: i.identifier }) }),
    manual<WorkData>('operator-features'),
  )
  .store(linear.store({ apiKey: linearKey, team: 'ENG', schema: workSchema, states: trackerStates }))
  .handle(buildAndAudit, {
    input: u => ({ title: u.data.title, body: u.data.body, rounds: 5 }),
    exits: { done, unfinished: unresolved },
    retry: { retries: 2, backoff: { initial: '5m', factor: 2 }, exhausted: unresolved },
  });

const epicFlow = H.flow('plan-epic')
  .input(workSchema)
  .step('plan', planner, s => ({ title: s.input.title, body: s.input.body }))
  .spawn('features', features, s =>
    s.plan.features.map((f, i) => ({ key: `${s.input.origin}-feature-${i}`, data: { title: f.title, body: f.body, origin: s.input.origin } })),
  )
  .when(s => s.features.some(r => r.verdict !== 'success'), f => f.exit('incomplete'))
  .exit('done');

const epics = H.lane('epics')
  .of(epic)
  .from(linear.issues<WorkData>({ name: 'linear-epics', apiKey: linearKey, team: 'ENG', labels: ['epic'], data: i => ({ title: i.title, body: i.description, origin: i.identifier }) }))
  .store(linear.store({ apiKey: linearKey, team: 'ENG', schema: workSchema, states: trackerStates }))
  .handle(epicFlow, {
    exits: { done, incomplete: unresolved },
    retry: { retries: 1, backoff: { initial: '10m', factor: 2 }, exhausted: unresolved },
  })
  .wip(1);

const services = ['api', 'web', 'worker'];

const heartbeats = H.lane('heartbeats')
  .of(heartbeat)
  .from(
    schedule.cron<HeartbeatData>({
      name: 'every-five-minutes',
      cron: '*/5 * * * *',
      children: at => services.map(service => ({ key: `${service}-${at.toISOString()}`, data: { service } })),
    }),
  )
  .handle(heartbeatFlow, {
    exits: { healthy },
    retry: { retries: 0, backoff: 'none', exhausted: down },
  });

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.events.transitions(heartbeats, { to: down }))
  .do(
    bugs.create((e: TransitionEvent<HeartbeatData>) => ({
      key: `heartbeat-${e.unit.key}`,
      data: { title: `${e.unit.data.service} heartbeat failed`, body: `Heartbeat ${e.unit.key} failed at ${e.at.toISOString()}.`, origin: 'heartbeat' },
    })),
  );

const laneRank = (candidate: Candidate, now: Date): number => {
  if (candidate.lane === heartbeats.name) return 0;
  if (candidate.lane === bugs.name) return 1;
  if (candidate.lane === features.name) return now.getTime() - candidate.queuedAt.getTime() > 4 * 60 * 60 * 1000 ? 1 : 2;
  return 3;
};

const priority = H.policy.units('heartbeats-bugs-features-epics', choice =>
  [...choice.candidates].sort(
    (a, b) => laneRank(a, choice.now) - laneRank(b, choice.now) || a.queuedAt.getTime() - b.queuedAt.getTime(),
  ),
);

const supervisor = claudeCode.client({ name: 'supervisor' });

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .pools(claudePool)
  .lanes(heartbeats, bugs, features, epics)
  .journals(experienceLog, tasteLog)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(priority)
  .grants(
    H.grant(
      supervisor,
      H.ops.work.read,
      H.ops.work.write,
      H.ops.resolve(ownerDecision),
      H.ops.memory.write(experience),
      H.ops.memory.write(taste),
      H.ops.telemetry.read,
      H.ops.accounts.manage,
      H.operation('production-health', productionHealth),
    ),
  )
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));
