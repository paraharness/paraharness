import { H, type Model } from 'harness-dsl';
import { z } from 'zod';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear, type LinearIssue } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { schedule, manual } from 'harness-dsl/supply';
import { local } from 'harness-dsl/runners';
import { drainSoonestExpiring, byApplicability } from 'harness-dsl/policies';
import { board, telemetry } from 'harness-dsl/projections';
import { fileLeaseGuard, stopCheck } from 'harness-dsl/plugins';
import { worktree } from 'harness-dsl/git';

const sharedQuota = sqlite.quota('~/.harness/shared/accounts.sqlite');

const max1 = H.account('max-1', claudeCode.subscription({ configDir: H.env('CLAUDE_MAX_1_DIR') })).quota(sharedQuota);
const max2 = H.account('max-2', claudeCode.subscription({ configDir: H.env('CLAUDE_MAX_2_DIR') })).quota(sharedQuota);
const max3 = H.account('max-3', claudeCode.subscription({ configDir: H.env('CLAUDE_MAX_3_DIR') })).quota(sharedQuota);
const sharedAccounts = [max1, max2, max3];

const Taste = H.memory('taste').content(z.object({ preference: z.string() })).taste();
const sharedTasteJournal = H.journal('owner-taste').of(Taste).store(jsonl.memory('~/.harness/shared/taste.jsonl')).recall(byApplicability({ budgetTokens: 1000 }));

const Experience = H.memory('experience').content(z.object({ action: z.string(), condition: z.string(), reason: z.string() }));

const Todo = H.state('Todo').pending();
const Building = H.state('Building').active();
const Done = H.state('Done').succeeded();
const Abandoned = H.state('Abandoned').failed();
const Cancelled = H.state('Cancelled').cancelled();
const Planning = H.state('Planning').active();
const AwaitingFeatures = H.state('AwaitingFeatures').dormant();
const FeaturesSettled = H.state('FeaturesSettled').pending();
const HeartbeatDue = H.state('HeartbeatDue').pending();
const Probing = H.state('Probing').active();
const Healthy = H.state('Healthy').succeeded();
const Unhealthy = H.state('Unhealthy').failed();

const bugSchema = z.object({ ref: z.string(), title: z.string(), description: z.string(), files: z.array(z.string()).default([]) });
type BugData = z.infer<typeof bugSchema>;
const featureSchema = z.object({ ref: z.string(), title: z.string(), description: z.string(), acceptance: z.array(z.string()).default([]), files: z.array(z.string()).default([]) });
type FeatureData = z.infer<typeof featureSchema>;
const epicSchema = z.object({ ref: z.string(), title: z.string(), description: z.string() });
type EpicData = z.infer<typeof epicSchema>;

const Bug = H.work('bug').schema(bugSchema).states(Todo, Building, Done, Abandoned, Cancelled).key(d => d.ref).resources(d => d.files);
const Feature = H.work('feature').schema(featureSchema).states(Todo, Building, Done, Abandoned, Cancelled).key(d => d.ref).resources(d => d.files);
const Epic = H.work('epic').schema(epicSchema).states(Todo, Planning, AwaitingFeatures, FeaturesSettled, Done, Abandoned, Cancelled).key(d => d.ref);
const ServiceHeartbeat = H.work('service-heartbeat')
  .schema(z.object({ service: z.string(), url: z.string(), at: z.string() }))
  .states(HeartbeatDue, Probing, Healthy, Unhealthy)
  .key(d => `${d.service}@${d.at}`);

const teamExperience = H.journal('coding-team-experience').of(Experience).store(jsonl.memory('memory/experience.jsonl')).recall(byApplicability({ budgetTokens: 2000 }));

const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));

const teamSubscriptions = H.pool('coding-team-subscriptions', sharedAccounts)
  .policy(drainSoonestExpiring)
  .fallback(apiAccount)
  .maxShare(max1, 0.6)
  .maxShare(max2, 0.6)
  .maxShare(max3, 0.6);

const teamSonnet = H.model('coding-team-sonnet', teamSubscriptions, 'claude-sonnet-4-5').pricing(anthropic.pricing());
const teamOpus = H.model('coding-team-opus', teamSubscriptions, 'claude-opus-4-1').pricing(anthropic.pricing());

const cheaperUntilItSlips = H.policy.pick<Model>('cheaper-until-it-slips', ctx => {
  const stats = ctx.metrics.outcomes({ kind: ctx.kind ?? undefined, model: teamSonnet, windowDays: 14 });
  const slipping = stats.samples >= 20 && stats.successRate !== null && stats.successRate < 0.85;
  return slipping ? [teamOpus, teamSonnet] : [teamSonnet, teamOpus];
});
const builderModels = H.pool('builder-models', [teamSonnet, teamOpus]).policy(cheaperUntilItSlips);

const teamWorkstation = local('coding-team-workstation').slots(4);

const projectChecks = H.command('project-checks')
  .runner(teamWorkstation)
  .run(async ctx => {
    await ctx.exec('npm', ['run', 'check']);
  });

const probeService = H.command('probe-service')
  .input(z.object({ service: z.string(), url: z.string() }))
  .runner(teamWorkstation)
  .run(async ctx => {
    await ctx.exec('curl', ['-fsS', '--max-time', '10', ctx.input.url]);
  });

const probeProduction = H.command('probe-production')
  .output(z.object({ healthy: z.boolean(), detail: z.string() }))
  .runner(teamWorkstation)
  .run(async ctx => {
    const result = await ctx.exec('curl', ['-fsS', 'https://app.example.com/health'], { allowFailure: true });
    return { healthy: result.exitCode === 0, detail: result.stdout || result.stderr };
  });

const builderRole = H.role('builder').prompt('You implement the work item in the worktree.').tools('read', 'edit', 'execute', 'search', 'ask').recall(Experience, Taste);
const auditorRole = H.role('auditor').prompt('You list concrete deficits of the change.').tools('read', 'search', 'execute').recall(Experience).record(Experience);
const plannerRole = H.role('planner').prompt('You decompose an epic into features.').tools('read', 'search').recall(Taste);

const build = H.skill('build')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .output(z.object({ summary: z.string(), filesChanged: z.array(z.string()) }))
  .prompt(i => `Implement: ${i.title}\n${i.description}\nOpen deficits:\n${i.deficits.join('\n')}`);
const audit = H.skill('audit')
  .input(z.object({ title: z.string(), description: z.string(), acceptance: z.array(z.string()), buildSummary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit: ${i.title}\n${i.description}\n${i.acceptance.join('\n')}\nBuilder says: ${i.buildSummary}`);
const planEpic = H.skill('plan-epic')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string(), acceptance: z.array(z.string()) })) }))
  .prompt(i => `Decompose: ${i.title}\n${i.description}`);

const builder = H.agent('builder').role(builderRole).model(builderModels).use(worktree({ repo: '.' }), fileLeaseGuard(), stopCheck(projectChecks));
const auditor = H.agent('auditor').role(auditorRole).model(teamOpus).use(worktree({ repo: '.' }));
const planner = H.agent('planner').role(plannerRole).model(teamOpus);

const ticketFlow = H.flow('ticket')
  .of(Bug, Feature)
  .params(z.object({ rounds: z.number().int().positive() }))
  .transition(Building)
  .loop('rounds', {
    maxIterations: s => s.params.rounds,
    body: b =>
      b
        .step('build', builder.perform(build), s => ({ title: s.unit.data.title, description: s.unit.data.description, deficits: s.steps.rounds?.deficits ?? [] }))
        .step('audit', auditor.perform(audit), s => ({
          title: s.unit.data.title,
          description: s.unit.data.description,
          acceptance: 'acceptance' in s.unit.data ? s.unit.data.acceptance : [],
          buildSummary: s.steps.build.summary,
        })),
    carry: { schema: z.object({ deficits: z.array(z.string()) }), from: s => ({ deficits: s.steps.audit.deficits }) },
    until: s => s.steps.audit.deficits.length === 0,
  })
  .transition(s => (s.steps.audit.deficits.length === 0 ? Done : Abandoned));

const trackerKey = H.env('LINEAR_API_KEY');
const ticketStore = linear.store({ apiKey: trackerKey, team: 'ENG', statuses: { Todo: 'Todo', Building: 'In Progress', Done: 'Done', Abandoned: 'Canceled', Cancelled: 'Canceled' } });
const epicStore = linear.store({
  apiKey: trackerKey,
  team: 'ENG',
  statuses: { Todo: 'Todo', Planning: 'In Progress', AwaitingFeatures: 'In Progress', FeaturesSettled: 'In Progress', Done: 'Done', Abandoned: 'Canceled', Cancelled: 'Canceled' },
});

const bugFromIssue = (issue: LinearIssue): BugData => ({ ref: issue.identifier, title: issue.title, description: issue.description, files: [] });
const featureFromIssue = (issue: LinearIssue): FeatureData => ({ ref: issue.identifier, title: issue.title, description: issue.description, acceptance: [], files: [] });
const epicFromIssue = (issue: LinearIssue): EpicData => ({ ref: issue.identifier, title: issue.title, description: issue.description });

const bugs = H.lane('bugs')
  .of(Bug)
  .from(linear.supply({ apiKey: trackerKey, team: 'ENG', labels: ['bug'], map: bugFromIssue }), folder.supply('work/bugs', { glob: '*.md' }), manual())
  .store(ticketStore)
  .handle(ticketFlow, { rounds: 3 })
  .wip(2);

const features = H.lane('features')
  .of(Feature)
  .from(linear.supply({ apiKey: trackerKey, team: 'ENG', labels: ['feature'], map: featureFromIssue }), manual())
  .store(ticketStore)
  .handle(ticketFlow, { rounds: 5 });

const epicFlow = H.flow('epic')
  .of(Epic)
  .transition(Planning)
  .when(
    s => s.children === null,
    b =>
      b
        .step('plan', planner.perform(planEpic), s => ({ title: s.unit.data.title, description: s.unit.data.description }))
        .spawn(
          'features',
          features,
          s => s.steps.plan.features.map((f, i) => ({ ref: `${s.unit.data.ref}-${i + 1}`, title: f.title, description: f.description, acceptance: f.acceptance, files: [] })),
          { wait: AwaitingFeatures, resume: FeaturesSettled },
        ),
  )
  .transition(s => (s.children !== null && s.children.failed > 0 ? Abandoned : Done));

const epics = H.lane('epics')
  .of(Epic)
  .from(linear.supply({ apiKey: trackerKey, team: 'ENG', labels: ['epic'], map: epicFromIssue }))
  .store(epicStore)
  .handle(epicFlow)
  .wip(1);

const services = [{ service: 'api', url: 'https://api.example.com/health' }, { service: 'web', url: 'https://app.example.com/health' }];

const heartbeats = H.lane('heartbeats')
  .of(ServiceHeartbeat)
  .from(schedule('*/5 * * * *', at => services.map(s => ({ service: s.service, url: s.url, at: at.toISOString() }))))
  .handle(
    H.flow('heartbeat')
      .of(ServiceHeartbeat)
      .transition(Probing)
      .step('probe', probeService, s => ({ service: s.unit.data.service, url: s.unit.data.url }))
      .transition(Healthy),
  );

const heartbeatFailureFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(heartbeats.enters(Unhealthy))
  .create(bugs, e => ({
    ref: `heartbeat-${e.unit.data.service}-${e.at.toISOString()}`,
    title: `${e.unit.data.service} heartbeat failed`,
    description: `Heartbeat of ${e.unit.data.url} failed at ${e.at.toISOString()}.`,
    files: [],
  }));

const laneOrder = [heartbeats.name, bugs.name, features.name, epics.name];

const teamPriority = H.policy.schedule('heartbeats-bugs-features-epics', ctx => {
  const starving = ctx.of(features).pending.filter(q => q.waitedMs > 2 * 60 * 60 * 1000);
  const starvingKeys = new Set(starving.map(q => q.unit.key));
  const ranked = [...ctx.pending]
    .filter(q => !(q.lane === features.name && starvingKeys.has(q.unit.key)))
    .sort((a, b) => laneOrder.indexOf(a.lane) - laneOrder.indexOf(b.lane) || b.waitedMs - a.waitedMs);
  return { start: [...ranked.filter(q => q.lane === heartbeats.name), ...starving, ...ranked.filter(q => q.lane !== heartbeats.name)] };
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('.harness/coding-team.sqlite'))
  .lanes(heartbeats, bugs, features, epics)
  .journals(teamExperience, sharedTasteJournal)
  .triggers(heartbeatFailureFilesBug)
  .scheduler(H.scheduler('coding-team').concurrency(4).policy(teamPriority))
  .supervisor(
    H.supervisor('coding-team-owner')
      .endpoint(claudeCode.endpoint({ server: 'coding-team' }))
      .grant(
        H.ops.work.read,
        H.ops.work.write,
        H.ops.blockers.resolve,
        H.ops.memory.write,
        H.ops.telemetry.read,
        H.ops.accounts.manage,
        H.operation('probe-production', probeProduction),
      ),
  )
  .projections(board('BOARD.md'), telemetry('TELEMETRY.md'));

const PageQueued = H.state('PageQueued').pending();
const Writing = H.state('Writing').active();
const Published = H.state('Published').succeeded();
const BrokenLinks = H.state('BrokenLinks').failed();
const PageWithdrawn = H.state('PageWithdrawn').cancelled();

const DocPage = H.work('doc-page')
  .schema(z.object({ path: z.string(), title: z.string(), brief: z.string() }))
  .states(PageQueued, Writing, Published, BrokenLinks, PageWithdrawn)
  .key(d => d.path)
  .resources(d => [d.path]);

const docsExperience = H.journal('docs-experience').of(Experience).store(jsonl.memory('docs/.harness/experience.jsonl')).recall(byApplicability({ budgetTokens: 1200 }));

const docsSubscriptions = H.pool('docs-subscriptions', sharedAccounts)
  .policy(drainSoonestExpiring)
  .maxShare(max1, 0.3)
  .maxShare(max2, 0.3)
  .maxShare(max3, 0.3);

const docsSonnet = H.model('docs-sonnet', docsSubscriptions, 'claude-sonnet-4-5').pricing(anthropic.pricing());

const writerRole = H.role('writer').prompt('You write and revise one documentation page.').tools('read', 'edit', 'search').recall(Taste, Experience).record(Experience);

const writePage = H.skill('write-page')
  .input(z.object({ path: z.string(), title: z.string(), brief: z.string() }))
  .output(z.object({ links: z.array(z.string()) }))
  .prompt(i => `Write ${i.path} titled "${i.title}".\n${i.brief}`);

const writer = H.agent('writer').role(writerRole).model(docsSonnet).use(worktree({ repo: 'docs' }));

const docsWorkstation = local('docs-workstation').slots(2);

const linkCheck = H.command('link-check')
  .input(z.object({ links: z.array(z.string()) }))
  .runner(docsWorkstation)
  .run(async ctx => {
    const broken: string[] = [];
    for (const link of ctx.input.links) {
      const result = await ctx.exec('curl', ['-fsIL', '--max-time', '10', link], { allowFailure: true });
      if (result.exitCode !== 0) broken.push(link);
    }
    if (broken.length > 0) throw new Error(`Broken links: ${broken.join(', ')}`);
  });

const docFlow = H.flow('doc-page')
  .of(DocPage)
  .transition(Writing)
  .step('write', writer.perform(writePage), s => ({ path: s.unit.data.path, title: s.unit.data.title, brief: s.unit.data.brief }))
  .step('links', linkCheck, s => ({ links: s.steps.write.links }))
  .transition(Published);

const pages = H.lane('doc-pages')
  .of(DocPage)
  .from(folder.supply('docs/requests', { glob: '*.md' }))
  .store(folder.store('docs/requests'))
  .handle(docFlow)
  .wip(2);

const docsOrder = H.policy.schedule('docs-oldest-first', ctx => ({ start: [...ctx.pending].sort((a, b) => b.waitedMs - a.waitedMs) }));

export const documentation = H.harness('documentation')
  .ledger(sqlite.ledger('docs/.harness/documentation.sqlite'))
  .lanes(pages)
  .journals(docsExperience, sharedTasteJournal)
  .scheduler(H.scheduler('documentation').concurrency(2).policy(docsOrder))
  .supervisor(
    H.supervisor('documentation-owner')
      .endpoint(claudeCode.endpoint({ server: 'documentation' }))
      .grant(H.ops.work.read, H.ops.work.write, H.ops.blockers.resolve, H.ops.memory.write, H.ops.telemetry.read, H.ops.accounts.manage),
  )
  .projections(board('docs/BOARD.md'), telemetry('docs/TELEMETRY.md'));
