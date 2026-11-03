import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Account } from 'harness-dsl';
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

const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());

const subscriptions = (share: number): readonly Account[] => [
  H.account('max-1', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_MAX_1') })).quota(sharedQuota).maxQuotaShare(share),
  H.account('max-2', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_MAX_2') })).quota(sharedQuota).maxQuotaShare(share),
  H.account('max-3', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_MAX_3') })).quota(sharedQuota).maxQuotaShare(share),
];

const taste = H.memory('taste').content(z.object({ preference: z.string() })).trust('taste');
const experience = H.memory('experience').content(z.object({ rule: z.string() })).trust('experience');

const sharedTaste = H.journal('owner-taste')
  .of(taste)
  .store(jsonl.store('~/.harness/shared/taste.jsonl'))
  .recall(policies.specificity({ limit: 12 }));

const ownerSession = (name: string) => claudeCode.client(name, { session: 'owner' });

const local = H.runner.local('local', { slots: 4 });

const queued = H.state('queued').pending();
const working = H.state('working').active();
const needsOwner = H.state('needs-owner').waiting();
const done = H.state('done').terminal('success');
const failed = H.state('failed').terminal('failure');

const workSchema = z.object({ key: z.string(), title: z.string(), description: z.string() });

const bug = H.work('bug').schema(workSchema).states(queued, working, needsOwner, done, failed);
const feature = H.work('feature').schema(workSchema).states(queued, working, needsOwner, done, failed);
const epic = H.work('epic').schema(workSchema).states(queued, working, needsOwner, done, failed);

const due = H.state('due').pending();
const probing = H.state('probing').active();
const healthy = H.state('healthy').terminal('success');
const down = H.state('down').terminal('failure');
const heartbeatSchema = z.object({ service: z.string(), url: z.string() });
const heartbeat = H.work('service-heartbeat').schema(heartbeatSchema).states(due, probing, healthy, down);

const appCode = H.resource('app-code');

const projectChecks = H.command('project-checks')
  .runner(local)
  .run(async (_input, ctx) => {
    const result = await ctx.sh('npm run check');
    if (result.code !== 0) throw new Error(result.stdout + result.stderr);
  });

const builderRole = H.role('builder')
  .prompt('Implement the work item in the worktree. Keep changes minimal and tested.')
  .intents(['read', 'edit', 'shell'])
  .recall(taste, experience)
  .use(
    plugins.gitWorktreeIsolation(),
    plugins.fileLeaseGuard([{ resource: appCode, globs: ['src/**', 'test/**'] }]),
    plugins.stopCheck(projectChecks),
  );

const auditorRole = H.role('auditor')
  .prompt('Find deficits in the change against the work item. List each one plainly.')
  .intents(['read', 'shell'])
  .recall(experience)
  .record(experience);

const plannerRole = H.role('planner')
  .prompt('Decompose the epic into independently deliverable features.')
  .intents(['read'])
  .recall(taste);

const buildSkill = H.skill('build')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Build: ${i.title}\n${i.description}\nOpen deficits:\n${i.deficits.join('\n')}`);

const auditSkill = H.skill('audit')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit the change for ${i.title}. Builder summary: ${i.summary}`);

const planSkill = H.skill('plan')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }))
  .prompt(i => `Epic: ${i.title}\n${i.description}`);

const builderSuccess = H.metric('builder-success-rate').rate(
  H.events.terminal({ verdict: 'success' }),
  H.events.terminal(),
);

const cheapUntilWeak = H.policy.seat('cheap-until-weak', input => {
  const reading = input.metrics.read(builderSuccess, {
    window: '14d',
    where: { kind: input.unit.kind, model: sonnet, seat: input.seat },
  });
  const weak = reading.samples >= 20 && reading.value !== undefined && reading.value < 0.85;
  return weak ? [opus] : [sonnet];
});

const builder = H.seat('builder').role(builderRole).models(sonnet, opus).policy(cheapUntilWeak);
const auditor = H.seat('auditor').role(auditorRole).models(sonnet);
const planner = H.seat('planner').role(plannerRole).models(opus);

const deliver = H.flow('deliver')
  .input(z.object({ title: z.string(), description: z.string(), rounds: z.number() }))
  .loop('rounds', {
    maxIterations: s => s.input.rounds,
    initial: (): string[] => [],
    body: f =>
      f
        .step('build', builder.call(buildSkill), s => ({ title: s.input.title, description: s.input.description, deficits: s.carry }))
        .step('audit', auditor.call(auditSkill), s => ({ title: s.input.title, summary: s.steps.build.summary })),
    next: s => s.steps.audit.deficits,
    until: s => s.steps.audit.deficits.length === 0,
  })
  .when(s => !s.steps.rounds.completed, f => f.exit('unfinished'))
  .exit('delivered');

const deliverBug = H.handler('deliver-bug')
  .of(bug)
  .flow(deliver, u => ({ title: u.data.title, description: u.data.description, rounds: 3 }))
  .exits({ delivered: done, unfinished: needsOwner })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 60, exhausted: failed });

const deliverFeature = H.handler('deliver-feature')
  .of(feature)
  .flow(deliver, u => ({ title: u.data.title, description: u.data.description, rounds: 5 }))
  .exits({ delivered: done, unfinished: needsOwner })
  .retry({ tries: 2, backoff: 'exponential', delaySeconds: 60, exhausted: failed });

const linearKey = H.env('LINEAR_API_KEY');
const trackerStore = linear.store({
  apiKey: linearKey,
  team: 'PRODUCT',
  statuses: [
    [queued, 'Todo'],
    [working, 'In Progress'],
    [needsOwner, 'In Review'],
    [done, 'Done'],
    [failed, 'Canceled'],
  ],
});

const fromTracker = (label: string) =>
  linear
    .issues({ apiKey: linearKey, team: 'PRODUCT', labels: [label] })
    .map(issue => ({ key: issue.identifier, title: issue.title, description: issue.description }))
    .key(data => data.key);

const bugs = H.lane('bugs', deliverBug)
  .from(fromTracker('bug'), supply.folder({ path: './bugs', schema: workSchema }).key(d => d.key), supply.manual())
  .store(trackerStore)
  .wip(2);

const features = H.lane('features', deliverFeature)
  .from(fromTracker('feature'), supply.manual())
  .store(trackerStore);

type EpicExit = 'completed' | 'incomplete';

const decompose = H.flow('decompose')
  .input(workSchema)
  .step('plan', planner.call(planSkill), s => ({ title: s.input.title, description: s.input.description }))
  .spawn('features', features, s =>
    s.steps.plan.features.map(f => ({ key: `${s.input.key}/${f.title}`, title: f.title, description: f.description })),
  )
  .exit((s): EpicExit => (s.steps.features.every(c => c.verdict === 'success') ? 'completed' : 'incomplete'));

const decomposeEpic = H.handler('decompose-epic')
  .of(epic)
  .flow(decompose)
  .exits({ completed: done, incomplete: needsOwner })
  .retry({ tries: 1, backoff: 'none', exhausted: failed });

const epics = H.lane('epics', decomposeEpic).from(fromTracker('epic')).store(trackerStore).wip(1);

const probeService = H.command('probe-service')
  .input(heartbeatSchema)
  .runner(local)
  .effect('repeatable')
  .run(async input => {
    const response = await fetch(input.url);
    if (!response.ok) throw new Error(`${input.service} answered ${response.status}`);
  });

const beat = H.flow('beat').input(heartbeatSchema).step('probe', probeService).exit('healthy');

const beatHandler = H.handler('beat')
  .of(heartbeat)
  .flow(beat)
  .exits({ healthy })
  .retry({ tries: 1, backoff: 'none', exhausted: down });

const heartbeats = H.lane('heartbeats', beatHandler).from(
  supply.schedule<z.infer<typeof heartbeatSchema>>({
    cron: '*/5 * * * *',
    units: () => [{ service: 'api', url: 'https://api.example.com/health' }],
  }),
);

const heartbeatFilesBug = H.trigger('heartbeat-down-files-bug')
  .on(heartbeats.enters(down))
  .do(
    bugs.create(
      p => ({
        key: `heartbeat-${p.unit.data.service}-${p.unit.id}`,
        title: `${p.unit.data.service} heartbeat failed`,
        description: `The heartbeat for ${p.unit.data.service} at ${p.unit.data.url} failed after retries.`,
      }),
      p => `heartbeat-${p.unit.data.service}`,
    ),
  );

const codingExperience = H.journal('coding-experience')
  .of(experience)
  .store(jsonl.store('./coding/.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const productionHealth = H.command('production-health-probe')
  .output(z.object({ healthy: z.boolean(), status: z.number() }))
  .runner(local)
  .run(async () => {
    const response = await fetch('https://api.example.com/health');
    return { healthy: response.ok, status: response.status };
  });

const starvationSeconds = 4 * 3600;

export const coding = H.harness('coding')
  .ledger(sqlite.ledger('./coding/.harness/ledger.sqlite'))
  .pools(
    H.pool('coding-subscriptions', subscriptions(0.6))
      .serves(sonnet, opus)
      .policy(policies.soonestExpiring())
      .fallback(H.account('coding-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }))),
  )
  .lanes(heartbeats, bugs, features, epics)
  .journals(sharedTaste, codingExperience)
  .triggers(heartbeatFilesBug)
  .scheduler(
    H.scheduler().policy(
      H.policy.schedule('heartbeats-bugs-features-epics', input => {
        const waiting = input.of(features);
        return [
          ...input.of(heartbeats),
          ...waiting.filter(c => c.waitingSeconds > starvationSeconds),
          ...input.of(bugs),
          ...waiting.filter(c => c.waitingSeconds <= starvationSeconds),
          ...input.of(epics),
        ];
      }),
    ),
  )
  .grants(
    H.grant(
      ownerSession('coding-supervisor'),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.memory.write(sharedTaste, codingExperience),
      H.ops.telemetry.read,
      H.ops.accounts.manage,
      H.operation('production-health', productionHealth),
    ),
  )
  .metrics(builderSuccess)
  .observe(observers.board({ path: './coding/BOARD.md' }), observers.telemetry({ path: './coding/TELEMETRY.md' }));

const docDraft = H.state('doc-draft').pending();
const writing = H.state('writing').active();
const published = H.state('published').terminal('success');
const brokenLinks = H.state('broken-links').terminal('failure');

const docSchema = z.object({ path: z.string(), title: z.string(), brief: z.string() });
const docPage = H.work('doc-page').schema(docSchema).states(docDraft, writing, published, brokenLinks);

const writerRole = H.role('writer')
  .prompt('Write or revise the documentation page in place.')
  .intents(['read', 'edit'])
  .recall(taste, experience)
  .record(experience);

const writeSkill = H.skill('write-page')
  .input(docSchema)
  .output(z.object({ changed: z.boolean() }))
  .prompt(i => `Page ${i.path}: ${i.title}\n${i.brief}`);

const writer = H.seat('writer').role(writerRole).models(sonnet);

const linkCheck = H.command('link-check')
  .input(docSchema)
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.sh(`npx linkinator ${input.path}`);
    if (result.code !== 0) throw new Error(result.stdout);
  });

const writeDoc = H.flow('write-doc')
  .input(docSchema)
  .step('write', writer.call(writeSkill))
  .step('links', linkCheck)
  .exit('published');

const docsHandler = H.handler('write-doc')
  .of(docPage)
  .flow(writeDoc)
  .exits({ published })
  .retry({ tries: 2, backoff: 'linear', delaySeconds: 120, exhausted: brokenLinks });

const docsExperience = H.journal('docs-experience')
  .of(experience)
  .store(jsonl.store('./docs/.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const pages = H.lane('pages', docsHandler)
  .from(supply.folder({ path: './docs', schema: docSchema }).key(d => d.path))
  .store(supply.frontmatter({ path: './docs' }))
  .wip(2);

export const docs = H.harness('docs')
  .ledger(sqlite.ledger('./docs/.harness/ledger.sqlite'))
  .pools(H.pool('docs-subscriptions', subscriptions(0.3)).serves(sonnet).policy(policies.soonestExpiring()))
  .lanes(pages)
  .journals(sharedTaste, docsExperience)
  .scheduler(H.scheduler().policy(H.policy.schedule('arrival', input => input.of(pages))))
  .grants(
    H.grant(
      ownerSession('docs-supervisor'),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.memory.write(sharedTaste, docsExperience),
      H.ops.telemetry.read,
      H.ops.accounts.manage,
    ),
  )
  .observe(observers.board({ path: './docs/BOARD.md' }), observers.telemetry({ path: './docs/TELEMETRY.md' }));
