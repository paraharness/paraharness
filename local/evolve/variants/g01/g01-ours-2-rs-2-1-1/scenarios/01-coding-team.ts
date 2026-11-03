import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Policy } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { folder, schedule, manual } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';
import { plugins } from 'harness-dsl/plugins';

const queued = H.state('queued').pending();
const done = H.state('done').terminal('success');
const incomplete = H.state('incomplete').terminal('failure');
const abandoned = H.state('abandoned').terminal('failure');
const due = H.state('due').pending();
const healthy = H.state('healthy').terminal('success');
const unhealthy = H.state('unhealthy').terminal('failure');

const task = z.object({ title: z.string(), body: z.string() });
const Bug = H.work('Bug').schema(task).states(queued, done, abandoned);
const Feature = H.work('Feature').schema(task).states(queued, done, abandoned);
const Epic = H.work('Epic').schema(task).states(queued, done, incomplete, abandoned);
const ServiceHeartbeat = H.work('ServiceHeartbeat').schema(z.object({ service: z.string() })).states(due, healthy, unhealthy);

const sourceTree = H.resource('source-tree');

const experience = H.memory('experience')
  .content(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');
const taste = H.memory('taste').content(z.object({ preference: z.string() })).trust('taste');

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

const probe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .output(z.object({ ok: z.boolean(), detail: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['curl', '-fsS', `https://${input.service}.internal/health`], { timeoutMs: 10_000 });
    return { ok: result.code === 0, detail: result.stdout || result.stderr };
  });

const productionHealth = H.command('production-health')
  .input(z.object({}))
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (_input, ctx) => {
    const result = await ctx.exec(['scripts/production-health']);
    return { healthy: result.code === 0, detail: result.stdout };
  });

const builderRole = H.role('builder')
  .prompt('Implement the work item in this worktree. Keep the change small and tested.')
  .intents(['read', 'edit', 'shell'])
  .recall(experience, taste)
  .use(plugins.fileLeaseGuard().area(sourceTree, ['src/**', 'test/**']), plugins.stopCheck(projectChecks));
const auditorRole = H.role('auditor')
  .prompt('Audit the change against the work item. List every deficit; list none if there are none.')
  .intents(['read', 'shell'])
  .recall(experience)
  .record(experience);
const plannerRole = H.role('planner')
  .prompt('Decompose the epic into independently shippable features.')
  .intents(['read'])
  .recall(taste);

const buildSkill = H.skill('build')
  .input(z.object({ title: z.string(), body: z.string(), round: z.number() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(input => `Round ${input.round}: ${input.title}\n\n${input.body}`);
const auditSkill = H.skill('audit')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit "${input.title}". Builder summary:\n${input.summary}`);
const planSkill = H.skill('plan')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }))
  .prompt(input => `Epic: ${input.title}\n\n${input.body}`);

const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());

const maxOne = H.account('claude-max-1', claudeCode.driver({ configDir: H.env('CLAUDE_MAX_1_DIR') }));
const maxTwo = H.account('claude-max-2', claudeCode.driver({ configDir: H.env('CLAUDE_MAX_2_DIR') }));
const maxThree = H.account('claude-max-3', claudeCode.driver({ configDir: H.env('CLAUDE_MAX_3_DIR') }));
const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));

const claudePool = H.pool('claude', [maxOne, maxTwo, maxThree])
  .share(maxOne, 0.6)
  .share(maxTwo, 0.6)
  .share(maxThree, 0.9)
  .serves(sonnet, opus)
  .policy(policies.soonestReset())
  .fallback(apiAccount);

const builderSuccess = H.metric('builder-success', H.events.attempts())
  .rate(event => event.outcome === 'succeeded')
  .by('seat', 'model', 'kind')
  .window('14d');

const minimumSamples = 20;
const minimumSuccessRate = 0.85;

const builderModels: Policy<'models'> = H.policy.models('cheap-until-unreliable', choice => {
  const kind = choice.unit.kind === Feature.name ? Feature : Bug;
  const reading = choice.metrics.read(builderSuccess, builder, sonnet, kind);
  const unreliable = reading.samples >= minimumSamples && reading.value !== undefined && reading.value < minimumSuccessRate;
  return unreliable ? [opus, sonnet] : [sonnet, opus];
});

const builder = H.seat('builder').role(builderRole).skill(buildSkill).models(sonnet, opus).policy(builderModels);
const auditor = H.seat('auditor').role(auditorRole).skill(auditSkill).models(sonnet);
const planner = H.seat('planner').role(plannerRole).skill(planSkill).models(opus);

const ownerDecision = H.halt('owner-decision')
  .context(z.object({ question: z.string(), summary: z.string() }))
  .decision(z.object({ answer: z.string() }))
  .ask(context => `${context.question}\n\nWork so far: ${context.summary}`);

const buildAndAudit = H.flow('build-and-audit')
  .input(z.object({ title: z.string(), body: z.string(), rounds: z.number() }))
  .use(plugins.gitWorktree())
  .resources(() => [sourceTree.exclusive()])
  .loop('round', {
    max: state => state.input.rounds,
    body: round => round
      .step('build', builder, state => ({ title: state.input.title, body: state.input.body, round: state.round.iteration }))
      .when(state => state.build.question !== undefined, ask => ask
        .halt('owner', ownerDecision, state => ({ question: state.build.question ?? '', summary: state.build.summary })))
      .step('audit', auditor, state => ({ title: state.input.title, summary: state.build.summary })),
    until: state => state.audit.deficits.length === 0,
  })
  .when(state => state.audit.deficits.length > 0, remaining => remaining.exit('deficitsRemain'))
  .exit('done');

const heartbeatFlow = H.flow('heartbeat')
  .input(z.object({ service: z.string() }))
  .step('probe', probe, state => ({ service: state.input.service }))
  .when(state => !state.probe.ok, down => down.exit('unhealthy'))
  .exit('healthy');

const linearKey = H.env('LINEAR_API_KEY');
const trackerStates = { queued: 'Todo', done: 'Done', incomplete: 'Blocked', abandoned: 'Canceled' };

const features = H.lane('features').of(Feature)
  .from(
    linear.issues({ name: 'linear-features', apiKey: linearKey, team: 'ENG', labels: ['feature'], data: issue => ({ title: issue.title, body: issue.description }) }),
    manual('operator-features'),
  )
  .store(linear.store({ apiKey: linearKey, team: 'ENG', schema: task, states: trackerStates }))
  .handle(buildAndAudit, {
    input: unit => ({ title: unit.data.title, body: unit.data.body, rounds: 5 }),
    exits: { done, deficitsRemain: { to: queued, atMost: 1, then: abandoned } },
    retry: { retries: 2, backoff: { initial: '2m', factor: 2 }, exhausted: abandoned },
  });

const bugs = H.lane('bugs').of(Bug)
  .from(
    linear.issues({ name: 'linear-bugs', apiKey: linearKey, team: 'ENG', labels: ['bug'], data: issue => ({ title: issue.title, body: issue.description }) }),
    folder.files({ name: 'bug-folder', path: 'bugs', glob: '*.md', data: file => ({ title: file.name, body: file.body }) }),
    manual('operator-bugs'),
  )
  .store(linear.store({ apiKey: linearKey, team: 'ENG', schema: task, states: trackerStates }))
  .handle(buildAndAudit, {
    input: unit => ({ title: unit.data.title, body: unit.data.body, rounds: 3 }),
    exits: { done, deficitsRemain: { to: queued, atMost: 1, then: abandoned } },
    retry: { retries: 2, backoff: { initial: '2m', factor: 2 }, exhausted: abandoned },
  })
  .wip(2);

const decomposeEpic = H.flow('decompose-epic')
  .input(task)
  .step('plan', planner, state => ({ title: state.input.title, body: state.input.body }))
  .spawn('features', features, (state, ctx) => state.plan.features.map((feature, index) => ({
    key: `${ctx.unit.key}-feature-${index + 1}`,
    data: { title: feature.title, body: feature.body },
  })))
  .when(state => state.features.some(child => child.verdict !== 'success'), unfinished => unfinished.exit('incomplete'))
  .exit('done');

const epics = H.lane('epics').of(Epic)
  .from(linear.issues({ name: 'linear-epics', apiKey: linearKey, team: 'ENG', labels: ['epic'], data: issue => ({ title: issue.title, body: issue.description }) }))
  .store(linear.store({ apiKey: linearKey, team: 'ENG', schema: task, states: trackerStates }))
  .handle(decomposeEpic, {
    exits: { done, incomplete },
    retry: { retries: 1, exhausted: abandoned },
  })
  .wip(1);

const heartbeats = H.lane('heartbeats').of(ServiceHeartbeat)
  .from(schedule.cron({
    name: 'every-five-minutes',
    cron: '*/5 * * * *',
    children: at => [{ key: `api-${at.toISOString()}`, data: { service: 'api' } }],
  }))
  .handle(heartbeatFlow, {
    exits: { healthy, unhealthy },
    retry: { retries: 0, exhausted: unhealthy },
  });

const unhealthyHeartbeatFilesBug = H.trigger('unhealthy-heartbeat-files-bug')
  .on(H.events.transitions(heartbeats, { to: unhealthy }))
  .do(bugs.create(event => ({
    key: `heartbeat-${event.unit.key}`,
    data: {
      title: `Service ${event.unit.data.service} failed its heartbeat`,
      body: `Heartbeat ${event.unit.key} ended unhealthy at ${event.at.toISOString()}.`,
    },
  })));

const featureStarvationMs = 4 * 60 * 60 * 1000;

const teamOrder = H.policy.units('heartbeats-bugs-features-epics', choice => {
  const priority = (lane: string, queuedAt: Date): number => {
    if (lane === heartbeats.name) return 0;
    if (lane === features.name && choice.now.getTime() - queuedAt.getTime() > featureStarvationMs) return 1;
    if (lane === bugs.name) return 2;
    if (lane === features.name) return 3;
    return 4;
  };
  return [...choice.candidates].sort((a, b) =>
    priority(a.lane, a.queuedAt) - priority(b.lane, b.queuedAt) || a.queuedAt.getTime() - b.queuedAt.getTime());
});

const experienceJournal = H.journal('experience').of(experience)
  .store(jsonl.memory('.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 8 }));
const tasteJournal = H.journal('taste').of(taste)
  .store(jsonl.memory('.harness/taste.jsonl'))
  .recall(policies.specificity({ limit: 12 }));

const supervisor = claudeCode.client({ name: 'supervisor' });

const supervisorGrant = H.grant(
  supervisor,
  H.ops.work.read,
  H.ops.work.write,
  H.ops.resolve(ownerDecision),
  H.ops.attempts.manage,
  H.ops.memory.write(experience),
  H.ops.memory.write(taste),
  H.ops.telemetry.read,
  H.ops.accounts.manage,
  H.operation('production-health', productionHealth),
);

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(claudePool)
  .lanes(heartbeats, bugs, features, epics)
  .journals(experienceJournal, tasteJournal)
  .triggers(unhealthyHeartbeatFilesBug)
  .scheduler(teamOrder)
  .grants(supervisorGrant)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

void codingTeam.start();
