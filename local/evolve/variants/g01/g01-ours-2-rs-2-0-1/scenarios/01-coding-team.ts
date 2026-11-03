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

const open = H.state('open').pending();
const inProgress = H.state('inProgress').active();
const done = H.state('done').terminal('success');
const needsOwner = H.state('needsOwner').waiting();
const abandoned = H.state('abandoned').terminal('failure');

const due = H.state('due').pending();
const probing = H.state('probing').active();
const healthy = H.state('healthy').terminal('success');
const down = H.state('down').terminal('failure');

const ticketSchema = z.object({ title: z.string(), body: z.string() });
const heartbeatSchema = z.object({ service: z.string(), url: z.string() });

const bug = H.work('Bug').schema(ticketSchema).states(open, inProgress, done, needsOwner, abandoned);
const feature = H.work('Feature').schema(ticketSchema).states(open, inProgress, done, needsOwner, abandoned);
const epic = H.work('Epic').schema(ticketSchema).states(open, inProgress, done, needsOwner, abandoned);
const heartbeat = H.work('ServiceHeartbeat').schema(heartbeatSchema).states(due, probing, healthy, down);

const sourceTree = H.resource('sourceTree');

const experience = H.memory('experience')
  .content(z.object({ do: z.string(), when: z.string(), because: z.string() }))
  .trust('experience');
const taste = H.memory('taste').content(z.object({ prefer: z.string() })).trust('taste');

const experienceJournal = H.journal('experience').of(experience).store(jsonl.store('memory/experience.jsonl')).recall(policies.specificity({ limit: 8 }));
const tasteJournal = H.journal('taste').of(taste).store(jsonl.store('memory/taste.jsonl')).recall(policies.specificity({ limit: 12 }));

const ownerDecision = H.halt('ownerDecision')
  .context(z.object({ question: z.string() }))
  .ask(c => c.question)
  .decision(z.object({ answer: z.string() }));

const local = H.runner.local('local', { slots: 4 });

const projectChecks = H.command('projectChecks')
  .runner(local)
  .effect('repeatable')
  .run(async (_input, ctx) => {
    const result = await ctx.sh('npm run check');
    if (result.code !== 0) throw new Error(result.stderr);
  });

const probeService = H.command('probeService')
  .input(heartbeatSchema)
  .runner(local)
  .effect('repeatable')
  .run(async input => {
    const response = await fetch(input.url);
    if (!response.ok) throw new Error(`${input.service} answered ${response.status}`);
  });

const productionHealth = H.command('productionHealth')
  .output(z.object({ ok: z.boolean(), status: z.number() }))
  .runner(local)
  .effect('repeatable')
  .run(async () => {
    const response = await fetch('https://app.example.com/health');
    return { ok: response.ok, status: response.status };
  });

const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());

const quota = sqlite.quota('.harness/quota.db');
const subscriptionA = H.account('claude-a', claudeCode.driver({ configDir: H.env('CLAUDE_A_CONFIG') })).maxQuotaShare(0.5).quota(quota);
const subscriptionB = H.account('claude-b', claudeCode.driver({ configDir: H.env('CLAUDE_B_CONFIG') })).maxQuotaShare(0.3).quota(quota);
const subscriptionC = H.account('claude-c', claudeCode.driver({ configDir: H.env('CLAUDE_C_CONFIG') })).maxQuotaShare(0.2).quota(quota);
const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(quota);

const claudePool = H.pool('claude', [subscriptionA, subscriptionB, subscriptionC])
  .serves(sonnet, opus)
  .policy(policies.soonestExpiring())
  .fallback(apiAccount);

const kindSuccessRate = H.metric('kindSuccessRate').rate(H.events.terminal({ verdict: 'success' }), H.events.terminal());

const cheaperUntilItSlips = H.policy.seat('cheaperUntilItSlips', ({ unit, seat, metrics }) => {
  const reading = metrics.read(kindSuccessRate, { window: '14d', where: { kind: unit.kind, seat, model: sonnet } });
  if (reading.samples < 20 || reading.value === undefined) return [sonnet, opus];
  return reading.value < 0.85 ? [opus, sonnet] : [sonnet, opus];
});

const builderRole = H.role('builder')
  .promptFile('roles/builder.md')
  .intents(['read', 'edit', 'shell'])
  .recall(experience, taste)
  .use(
    plugins.gitWorktreeIsolation(),
    plugins.fileLeaseGuard([{ resource: sourceTree, globs: ['src/**', 'test/**'] }]),
    plugins.stopCheck(projectChecks),
  );
const auditorRole = H.role('auditor').promptFile('roles/auditor.md').intents(['read', 'shell']).recall(experience).record(experience);
const plannerRole = H.role('planner').promptFile('roles/planner.md').intents(['read']).recall(taste);

const builder = H.seat('builder').role(builderRole).models(sonnet, opus).policy(cheaperUntilItSlips);
const auditor = H.seat('auditor').role(auditorRole).models(opus);
const planner = H.seat('planner').role(plannerRole).models(opus);

const buildSkill = H.skill('build')
  .input(z.object({ title: z.string(), body: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(i => `Implement: ${i.title}\n\n${i.body}\n\nOpen deficits:\n${i.deficits.join('\n')}`);

const auditSkill = H.skill('audit')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit the change for "${i.title}". Builder summary: ${i.summary}`);

const planSkill = H.skill('planEpic')
  .input(ticketSchema)
  .output(z.object({ features: z.array(ticketSchema) }))
  .prompt(i => `Decompose the epic "${i.title}" into features.\n\n${i.body}`);

const buildAndAudit = H.flow('buildAndAudit')
  .input(z.object({ title: z.string(), body: z.string(), rounds: z.number() }))
  .resources(() => [H.lease.shared(sourceTree)])
  .loop('rounds', {
    maxIterations: s => s.input.rounds,
    initial: (): { readonly deficits: readonly string[] } => ({ deficits: [] }),
    body: round => round
      .step('build', builder.call(buildSkill), s => ({ title: s.input.title, body: s.input.body, deficits: [...s.carry.deficits] }))
      .when(
        s => s.steps.build.question !== undefined,
        ask => ask.halt('ownerDecision', ownerDecision, s => ({ question: s.steps.build.question ?? '' })),
      )
      .step('audit', auditor.call(auditSkill), s => ({ title: s.input.title, summary: s.steps.build.summary })),
    next: s => ({ deficits: s.steps.audit.deficits }),
    until: s => s.steps.audit.deficits.length === 0,
  })
  .exit(s => (s.steps.rounds.completed ? 'done' : 'roundsExhausted'));

const heartbeatFlow = H.flow('heartbeat').input(heartbeatSchema).step('probe', probeService).exit('healthy');

const linearKey = H.env('LINEAR_API_KEY');
const trackerStore = linear.store({
  apiKey: linearKey,
  team: 'PRD',
  statuses: [[open, 'Todo'], [inProgress, 'In Progress'], [done, 'Done'], [needsOwner, 'In Review'], [abandoned, 'Canceled']],
});

const trackerIssues = (label: string) =>
  linear.issues({ apiKey: linearKey, team: 'PRD', labels: [label] })
    .key(issue => issue.identifier)
    .map(issue => ({ title: issue.title, body: issue.description }));

const failedRetry = { tries: 2, backoff: 'exponential', delaySeconds: 300, then: abandoned } as const;

const heartbeats = H.lane('heartbeats')
  .of(heartbeat)
  .from(supply.schedule({ cron: '*/5 * * * *', units: () => [{ service: 'api', url: 'https://api.example.com/health' }] }))
  .handle(heartbeatFlow)
  .exits({ healthy, failed: { tries: 1, backoff: 'none', then: down } });

const bugs = H.lane('bugs')
  .of(bug)
  .from(trackerIssues('bug'), supply.folder({ path: 'work/bugs', schema: ticketSchema }), supply.manual())
  .store(trackerStore)
  .handle(buildAndAudit, unit => ({ ...unit.data, rounds: 3 }))
  .exits({ done, roundsExhausted: needsOwner, failed: failedRetry })
  .wip(2);

const features = H.lane('features')
  .of(feature)
  .from(trackerIssues('feature'), supply.manual())
  .store(trackerStore)
  .handle(buildAndAudit, unit => ({ ...unit.data, rounds: 5 }))
  .exits({ done, roundsExhausted: needsOwner, failed: failedRetry });

const decomposeEpic = H.flow('decomposeEpic')
  .input(ticketSchema)
  .step('plan', planner.call(planSkill))
  .spawn('features', features, s => s.steps.plan.features)
  .exit(s => (s.steps.features.every(child => child.verdict === 'success') ? 'done' : 'incomplete'));

const epics = H.lane('epics')
  .of(epic)
  .from(trackerIssues('epic'))
  .store(trackerStore)
  .handle(decomposeEpic)
  .exits({ done, incomplete: needsOwner, failed: failedRetry })
  .wip(1);

const heartbeatFilesBug = H.trigger('heartbeatFilesBug')
  .on(heartbeats.enters(down))
  .do(bugs.create(
    p => ({ title: `Service ${p.unit.data.service} failed its heartbeat`, body: `Probe of ${p.unit.data.url} failed at ${p.unit.updatedAt.toISOString()}.` }),
    p => `heartbeat-${p.unit.data.service}`,
  ));

function rank(candidate: Candidate): number {
  if (candidate.lane === heartbeats) return 0;
  if (candidate.lane === features && candidate.waitingSeconds > 4 * 3600) return 0.5;
  if (candidate.lane === bugs) return 1;
  if (candidate.lane === features) return 2;
  return 3;
}

const teamPriority = H.policy.schedule('teamPriority', ({ candidates }) =>
  [...candidates].sort((a, b) => rank(a) - rank(b) || b.waitingSeconds - a.waitingSeconds),
);

const supervisor = claudeCode.client('supervisor');

export const harness = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .pools(claudePool)
  .lanes(heartbeats, bugs, features, epics)
  .journals(experienceJournal, tasteJournal)
  .triggers(heartbeatFilesBug)
  .scheduler(H.scheduler().policy(teamPriority))
  .grants(H.grant(
    supervisor,
    H.ops.work.read,
    H.ops.work.write,
    H.ops.resolve(ownerDecision),
    H.ops.memory.write(tasteJournal, experienceJournal),
    H.ops.telemetry.read,
    H.ops.accounts.manage,
    H.operation('probeProduction', productionHealth),
  ))
  .metrics(kindSuccessRate)
  .observe(observers.board({ path: 'BOARD.md' }), observers.telemetry({ path: 'TELEMETRY.md' }));

export const running = harness.start();
