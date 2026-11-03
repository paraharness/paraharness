import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate } from 'harness-dsl/kernel';
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
const inProgress = H.state('inProgress').active();
const needsReview = H.state('needsReview').waiting();
const done = H.state('done').terminal('success');
const wontDo = H.state('wontDo').terminal('neutral');
const abandoned = H.state('abandoned').terminal('failure');

const scheduled = H.state('scheduled').pending();
const probing = H.state('probing').active();
const healthy = H.state('healthy').terminal('success');
const unhealthy = H.state('unhealthy').terminal('failure');

const taskSchema = z.object({ title: z.string(), body: z.string(), ref: z.string() });
const featureSchema = taskSchema.extend({ epicRef: z.string().optional() });
const deliverySchema = taskSchema.extend({ rounds: z.number().int().positive() });
const heartbeatSchema = z.object({ service: z.string() });

const Epic = H.work('Epic').schema(taskSchema).states(todo, inProgress, needsReview, done, wontDo, abandoned);
const Feature = H.work('Feature').schema(featureSchema).states(todo, inProgress, needsReview, done, wontDo, abandoned);
const Bug = H.work('Bug').schema(taskSchema).states(todo, inProgress, needsReview, done, wontDo, abandoned);
const ServiceHeartbeat = H.work('ServiceHeartbeat').schema(heartbeatSchema).states(scheduled, probing, healthy, unhealthy);

const experience = H.memory('experience').content(z.object({ lesson: z.string() })).trust('experience');
const taste = H.memory('taste').content(z.object({ preference: z.string() })).trust('taste');

const experienceJournal = H.journal('experience')
  .of(experience)
  .store(jsonl.store('memory/experience.jsonl'))
  .recall(policies.specificity({ limit: 8 }));
const tasteJournal = H.journal('taste')
  .of(taste)
  .store(jsonl.store('memory/taste.jsonl'))
  .recall(policies.specificity({ limit: 12 }));

const payments = H.resource('payments');
const webApp = H.resource('webApp');
const platform = H.resource('platform');

const projectChecks = H.command('projectChecks').run(async (_, ctx) => {
  const result = await ctx.sh('npm run check');
  if (result.code !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
});

const builderRole = H.role('builder')
  .prompt('You implement one unit of work in this repository and leave it passing its checks.')
  .intents(['read', 'edit', 'shell'])
  .recall(experience, taste)
  .use(
    plugins.gitWorktreeIsolation(),
    plugins.fileLeaseGuard([
      { resource: payments, globs: ['src/payments/**', 'migrations/**'] },
      { resource: webApp, globs: ['src/web/**'] },
      { resource: platform, globs: ['src/platform/**', 'package.json'] },
    ]),
    plugins.stopCheck(projectChecks),
  );

const auditorRole = H.role('auditor')
  .prompt('You audit a change against its task and list every deficit that remains.')
  .intents(['read', 'shell'])
  .recall(experience)
  .record(experience)
  .use(plugins.gitWorktreeIsolation());

const plannerRole = H.role('planner')
  .prompt('You decompose an epic into independently shippable features.')
  .intents(['read'])
  .recall(taste);

const buildSkill = H.skill('build')
  .input(z.object({ task: z.string(), deficits: z.array(z.string()), guidance: z.string().optional() }))
  .output(z.object({ summary: z.string(), needsDecision: z.boolean(), question: z.string().optional() }))
  .prompt(i => `Task:\n${i.task}\n\nOpen deficits:\n${i.deficits.join('\n') || 'none'}\n\nOwner guidance: ${i.guidance ?? 'none'}`);

const auditSkill = H.skill('audit')
  .input(z.object({ task: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Task:\n${i.task}\n\nBuilder summary:\n${i.summary}\n\nList the deficits that remain.`);

const planSkill = H.skill('plan')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }))
  .prompt(i => `Epic: ${i.title}\n\n${i.body}`);

const sharedQuota = sqlite.quota('~/.harness/quota.db');
const subscriptionA = H.account('subscription-a', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_A') })).maxQuotaShare(0.8).quota(sharedQuota);
const subscriptionB = H.account('subscription-b', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_B') })).maxQuotaShare(0.6).quota(sharedQuota);
const subscriptionC = H.account('subscription-c', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_C') })).maxQuotaShare(0.5).quota(sharedQuota);
const apiAccount = H.account('api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));

const sonnet = H.model('claude-sonnet-4-5', { effort: 'medium' }).pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1', { effort: 'high' }).pricing(anthropic.pricing());

const claudePool = H.pool('claude', [subscriptionA, subscriptionB, subscriptionC])
  .serves(sonnet, opus)
  .policy(policies.soonestExpiring())
  .fallback(apiAccount);

const unitSuccess = H.metric('unitSuccess').rate(H.events.terminal({ verdict: 'success' }), H.events.terminal());

const cheaperUntilWorse = H.policy.seat('cheaperUntilWorse', ({ seat, unit, metrics }) => {
  const cheap = metrics.read(unitSuccess, { window: '14d', where: { kind: unit.kind, seat, model: sonnet } });
  const cheapFalls = cheap.samples >= 20 && cheap.value !== undefined && cheap.value < 0.85;
  return cheapFalls ? [opus, sonnet] : [sonnet, opus];
});

const builder = H.seat('builder').role(builderRole).models(sonnet, opus).policy(cheaperUntilWorse);
const auditor = H.seat('auditor').role(auditorRole).models(opus);
const planner = H.seat('planner').role(plannerRole).models(opus);

const ownerDecision = H.halt('ownerDecision')
  .context(z.object({ task: z.string(), question: z.string() }))
  .ask(c => `${c.task}: ${c.question}`)
  .decision(z.object({ answer: z.string() }));

interface Rounds {
  readonly deficits: string[];
  readonly guidance: string | undefined;
}

const delivery = H.flow('delivery')
  .input(deliverySchema)
  .loop('rounds', {
    maxIterations: s => s.input.rounds,
    initial: (): Rounds => ({ deficits: [], guidance: undefined }),
    body: f =>
      f
        .step('build', builder.call(buildSkill), s => ({
          task: `${s.input.title}\n\n${s.input.body}`,
          deficits: s.carry.deficits,
          guidance: s.carry.guidance,
        }))
        .when(
          s => s.steps.build.needsDecision,
          b => b.halt('ownerDecision', ownerDecision, s => ({ task: s.input.title, question: s.steps.build.question ?? s.steps.build.summary })),
        )
        .step('audit', auditor.call(auditSkill), s => ({ task: s.input.body, summary: s.steps.build.summary })),
    next: s => ({ deficits: s.steps.audit.deficits, guidance: s.steps.ownerDecision?.answer }),
    until: s => s.steps.audit.deficits.length === 0,
  })
  .exit(s => (s.steps.rounds.completed ? 'delivered' : 'deficitsRemain'));

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({
  apiKey: linearKey,
  team: 'ENG',
  statuses: [
    [todo, 'Todo'],
    [inProgress, 'In Progress'],
    [needsReview, 'In Review'],
    [done, 'Done'],
    [wontDo, 'Canceled'],
    [abandoned, 'Abandoned'],
  ],
});

const bugs = H.lane('bugs')
  .of(Bug)
  .from(
    linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['bug'] })
      .map(issue => ({ title: issue.title, body: issue.description, ref: issue.identifier }))
      .key(bug => bug.ref),
    supply.folder({ path: 'inbox/bugs', schema: z.object({ slug: z.string(), title: z.string(), body: z.string() }) })
      .map(file => ({ title: file.title, body: file.body, ref: `file:${file.slug}` }))
      .key(bug => bug.ref),
    supply.manual(),
  )
  .store(tracker)
  .handle(delivery, {
    exits: { delivered: done, deficitsRemain: needsReview },
    retry: { tries: 2, backoff: 'exponential', delaySeconds: 300, exhausted: abandoned },
    input: unit => ({ title: unit.data.title, body: unit.data.body, ref: unit.data.ref, rounds: 3 }),
  })
  .wip(2);

const features = H.lane('features')
  .of(Feature)
  .from(
    linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['feature'] })
      .map(issue => ({ title: issue.title, body: issue.description, ref: issue.identifier, epicRef: issue.parentId }))
      .key(feature => feature.ref),
    supply.manual(),
  )
  .store(tracker)
  .handle(delivery, {
    exits: { delivered: done, deficitsRemain: needsReview },
    retry: { tries: 2, backoff: 'exponential', delaySeconds: 300, exhausted: abandoned },
    input: unit => ({ title: unit.data.title, body: unit.data.body, ref: unit.data.ref, rounds: 5 }),
  });

const decompose = H.flow('decompose')
  .input(taskSchema)
  .step('plan', planner.call(planSkill), s => ({ title: s.input.title, body: s.input.body }))
  .spawn('features', features, s =>
    s.steps.plan.features.map((feature, index) => ({
      title: feature.title,
      body: feature.body,
      ref: `${s.input.ref}/${index + 1}`,
      epicRef: s.input.ref,
    })),
  )
  .exit(s => (s.steps.features.every(child => child.verdict === 'success') ? 'delivered' : 'featuresUnfinished'));

const epics = H.lane('epics')
  .of(Epic)
  .from(
    linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['epic'] })
      .map(issue => ({ title: issue.title, body: issue.description, ref: issue.identifier }))
      .key(epic => epic.ref),
  )
  .store(tracker)
  .handle(decompose, {
    exits: { delivered: done, featuresUnfinished: needsReview },
    retry: { tries: 1, backoff: 'none', exhausted: abandoned },
  })
  .wip(1);

const probeService = H.command('probeService')
  .input(heartbeatSchema)
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .run(async (input, ctx) => {
    const result = await ctx.sh(`curl -fsS --max-time 10 https://${input.service}.internal/healthz`);
    return { healthy: result.code === 0, detail: result.code === 0 ? result.stdout : result.stderr };
  });

const heartbeat = H.flow('heartbeat')
  .input(heartbeatSchema)
  .step('probe', probeService)
  .exit(s => (s.steps.probe.healthy ? 'healthy' : 'unhealthy'));

const heartbeats = H.lane('heartbeats')
  .of(ServiceHeartbeat)
  .from(
    supply.schedule({ cron: '*/5 * * * *', units: () => [{ service: 'api' }, { service: 'web' }, { service: 'worker' }] })
      .key(beat => beat.service),
  )
  .handle(heartbeat, {
    exits: { healthy, unhealthy },
    retry: { tries: 0, backoff: 'none', exhausted: unhealthy },
  });

const heartbeatFailureFilesBug = H.trigger('heartbeatFailureFilesBug')
  .on(H.entered(heartbeats, unhealthy))
  .do(
    H.create(
      bugs,
      p => ({
        title: `${p.unit.data.service} heartbeat failed`,
        body: `The five-minute heartbeat for ${p.unit.data.service} failed at ${p.unit.updatedAt.toISOString()}.`,
        ref: `heartbeat:${p.unit.data.service}`,
      }),
      { key: p => `heartbeat:${p.unit.data.service}` },
    ),
  );

const featureStarvationSeconds = 4 * 3600;

const lanePriority = (candidate: Candidate): number => {
  if (candidate.lane === heartbeats) return 0;
  if (candidate.lane === features && candidate.waitingSeconds > featureStarvationSeconds) return 1;
  if (candidate.lane === bugs) return 2;
  if (candidate.lane === features) return 3;
  return 4;
};

const teamOrder = H.policy.schedule('teamOrder', ({ candidates }) =>
  [...candidates].sort((a, b) => lanePriority(a) - lanePriority(b) || b.waitingSeconds - a.waitingSeconds),
);

const probeProduction = H.command('probeProduction')
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .run(async (_, ctx) => {
    const result = await ctx.sh('curl -fsS --max-time 10 https://app.example.com/healthz');
    return { healthy: result.code === 0, detail: result.code === 0 ? result.stdout : result.stderr };
  });

const supervisor = claudeCode.client('supervisor');

const supervisorGrant = H.grant(
  supervisor,
  H.ops.work.read,
  H.ops.work.write,
  H.ops.resolve(ownerDecision),
  H.ops.memory.write(experienceJournal, tasteJournal),
  H.ops.telemetry.read,
  H.ops.accounts.manage,
  H.operation('productionHealth', probeProduction),
);

export default H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(claudePool)
  .lanes(heartbeats, bugs, features, epics)
  .journals(experienceJournal, tasteJournal)
  .triggers(heartbeatFailureFilesBug)
  .schedule(teamOrder)
  .grants(supervisorGrant)
  .metrics(unitSuccess)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));
