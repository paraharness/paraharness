import { z } from 'zod';
import { H, Model, Role } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const subscriptionOne = claudeCode.subscription('max-one', { token: H.env('CLAUDE_MAX_ONE_TOKEN') });
const subscriptionTwo = claudeCode.subscription('max-two', { token: H.env('CLAUDE_MAX_TWO_TOKEN') });
const subscriptionThree = claudeCode.subscription('max-three', { token: H.env('CLAUDE_MAX_THREE_TOKEN') });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const sharedQuotaPath = '/home/owner/.harness/quota.sqlite';

const soonestExpiring = H.policy.account('soonest-expiring', ctx => {
  const eligible = ctx.candidates.filter(
    account =>
      account.shareUsed < account.shareCap &&
      (account.cooldownUntil === undefined || account.cooldownUntil <= ctx.now),
  );
  const ordered = [...eligible].sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime());
  return ordered[0];
});

function subscriptionPool(name: string, fraction: number) {
  return H.pool(name)
    .accounts(subscriptionOne, subscriptionTwo, subscriptionThree)
    .share(subscriptionOne, fraction)
    .share(subscriptionTwo, fraction)
    .share(subscriptionThree, fraction)
    .drain(soonestExpiring)
    .fallback(apiAccount);
}

const tasteKind = H.memory('owner-taste', 'taste');
const experienceKind = H.memory('experience', 'experience');
const sharedTasteStore = jsonl.memoryStore({ path: '/home/owner/.harness/taste.jsonl' });

function tasteJournal(...readers: Role[]) {
  return H.journal('taste', tasteKind).store(sharedTasteStore).recall({ by: 'specificity', limit: 12 }).readBy(...readers);
}

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const codingPool = subscriptionPool('coding-subscriptions', 0.6);
const codingRunner = local.runner('coding-box').slots(4);

const workAttributes = z.object({
  title: z.string(),
  description: z.string(),
  issueId: z.string().optional(),
});

const Queued = H.state('Queued', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Planning = H.state('Planning', 'active');
const Delivering = H.state('Delivering', 'active');
const Done = H.terminal('Done', 'success');
const Exhausted = H.terminal('Exhausted', 'failure');
const Abandoned = H.terminal('Abandoned', 'neutral');

const Bug = H.kind('Bug')
  .attributes(workAttributes)
  .states(Queued, Building, Auditing, Done, Exhausted, Abandoned)
  .key(work => work.issueId ?? work.title)
  .initial(Queued)
  .onCancelled(Abandoned);

const Feature = H.kind('Feature')
  .attributes(workAttributes)
  .states(Queued, Building, Auditing, Done, Exhausted, Abandoned)
  .key(work => work.issueId ?? work.title)
  .initial(Queued)
  .onCancelled(Abandoned);

const Epic = H.kind('Epic')
  .attributes(workAttributes)
  .states(Queued, Planning, Delivering, Done, Exhausted, Abandoned)
  .key(work => work.issueId ?? work.title)
  .initial(Queued)
  .onCancelled(Abandoned);

const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.terminal('Healthy', 'success');
const Unhealthy = H.terminal('Unhealthy', 'failure');

const heartbeatAttributes = z.object({ at: z.string() });

const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(heartbeatAttributes)
  .states(Due, Probing, Healthy, Unhealthy)
  .key(beat => beat.at)
  .initial(Due);

const builder = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the change. Halt for the owner when a product decision is needed.');
const auditor = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('Find deficits against the task. Record lessons that will help the next builder.');
const planner = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(codingRunner);

const builderModel = H.policy.model('builder-model', [sonnet, opus], (ctx): Model => {
  const record = ctx.metrics.attempts({ of: ctx.kind, model: sonnet, window: { lastDays: 14 } });
  return record.samples >= 20 && record.successRate < 0.85 ? opus : sonnet;
});

const builderAgent = H.agent('builder')
  .role(builder)
  .model(builderModel)
  .pool(codingPool)
  .workspace(git.worktree({ repo: '.', base: 'main' }))
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks))
  .output(z.object({ summary: z.string(), filesChanged: z.array(z.string()) }));

const auditorAgent = H.agent('auditor')
  .role(auditor)
  .model(opus)
  .pool(codingPool)
  .output(z.object({ deficits: z.array(z.string()) }));

const plannerAgent = H.agent('planner')
  .role(planner)
  .model(opus)
  .pool(codingPool)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const buildAndAudit = H.flow('build-and-audit')
  .input(z.object({ title: z.string(), description: z.string() }))
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    round =>
      round
        .step('build', builderAgent, ctx => ({
          task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
        }))
        .step('audit', auditorAgent, ctx => ({
          task: `Audit the change for "${ctx.unit.attributes.title}": ${ctx.steps.build.summary}`,
          resources: ctx.steps.build.filesChanged,
        })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('done', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('exhausted');

const linearKey = H.env('LINEAR_API_KEY');
const trackerStore = linear.store({
  apiKey: linearKey,
  team: 'ENG',
  states: {
    Queued: 'Todo',
    Building: 'In Progress',
    Auditing: 'In Review',
    Planning: 'In Progress',
    Delivering: 'In Progress',
    Done: 'Done',
    Exhausted: 'Blocked',
    Abandoned: 'Canceled',
  },
});

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['bug'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description, issueId: issue.identifier }),
  )
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ title: file.name, description: file.body }),
  )
  .supply(H.operator)
  .store(trackerStore)
  .handler(buildAndAudit, {
    exits: { done: Done, exhausted: Exhausted },
    during: { build: Building, audit: Auditing },
    params: { rounds: 3 },
  });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['feature'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description, issueId: issue.identifier }),
  )
  .supply(H.operator)
  .store(trackerStore)
  .handler(buildAndAudit, {
    exits: { done: Done, exhausted: Exhausted },
    during: { build: Building, audit: Auditing },
    params: { rounds: 5 },
  });

const deliverEpic = H.flow('deliver-epic')
  .input(workAttributes)
  .step('plan', plannerAgent, ctx => ({ task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}` }))
  .spawn('deliver', features, ctx => ctx.steps.plan.features)
  .exit('completed', ctx => ctx.steps.deliver.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['epic'] }), (issue, to) =>
    to.create({ title: issue.title, description: issue.description, issueId: issue.identifier }),
  )
  .store(trackerStore)
  .handler(deliverEpic, {
    exits: { completed: Done, incomplete: Exhausted },
    during: { plan: Planning, deliver: Delivering },
  });

const serviceHealth = H.command('service-health')
  .argv(['./scripts/health.sh'])
  .acceptExitCodes(0, 1)
  .runner(codingRunner);

const heartbeatFlow = H.flow('heartbeat')
  .input(heartbeatAttributes)
  .step('probe', serviceHealth)
  .exit('healthy', ctx => ctx.steps.probe.exitCode === 0)
  .exit('unhealthy');

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) => to.create({ at: tick.at.toISOString() }))
  .handler(heartbeatFlow, { exits: { healthy: Healthy, unhealthy: Unhealthy }, during: { probe: Probing } });

const unhealthyHeartbeatOpensBug = H.trigger('unhealthy-heartbeat-opens-bug')
  .on(H.when.transition(heartbeats, { to: Unhealthy }))
  .create(bugs, event => ({
    title: `Service heartbeat failed at ${event.unit.attributes.at}`,
    description: 'The five-minute service heartbeat probe reported the service unhealthy.',
  }));

const codingExperience = H.journal('experience', experienceKind)
  .store(jsonl.memoryStore({ path: 'coding/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(builder, auditor)
  .recordedBy(auditor);

const productionHealthProbe = H.operation(
  'production-health-probe',
  H.command('production-health').argv(['./scripts/prod-health.sh']).runner(codingRunner),
);

const coding = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: 'coding/.harness/ledger.sqlite', quotaPath: sharedQuotaPath }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(codingExperience, tasteJournal(builder, planner))
  .triggers(unhealthyHeartbeatOpensBug)
  .scheduler(
    H.scheduler('coding')
      .priority(heartbeats, bugs, features, epics)
      .wip(bugs, 2)
      .wip(epics, 1)
      .boost(features, { afterMinutes: 240 }),
  )
  .clients(
    claudeCode.supervisor('coding-supervisor', {
      endpoint: 'coding',
      grants: [
        H.ops.workRead,
        H.ops.workCreate,
        H.ops.workUpdate,
        H.ops.workCancel,
        H.ops.blockersResolve,
        H.ops.memoryRead,
        H.ops.memoryWrite,
        H.ops.telemetryRead,
        H.ops.accountsRead,
        H.ops.accountsShare,
        productionHealthProbe,
      ],
    }),
  )
  .observers(
    markdown.board({ path: 'coding/.harness/board.md' }),
    markdown.telemetry({ path: 'coding/.harness/telemetry.md' }),
  );

const docsPool = subscriptionPool('docs-subscriptions', 0.3);
const docsRunner = local.runner('docs-box').slots(2);

const docAttributes = z.object({ path: z.string(), title: z.string(), body: z.string() });

const Writing = H.state('Writing', 'active');
const LinkChecking = H.state('LinkChecking', 'active');
const Published = H.terminal('Published', 'success');
const Broken = H.terminal('Broken', 'failure');

const DocPage = H.kind('DocPage')
  .attributes(docAttributes)
  .states(Queued, Writing, LinkChecking, Published, Broken, Abandoned)
  .key(page => page.path)
  .initial(Queued)
  .onCancelled(Abandoned);

const writer = H.role('writer')
  .intents('read', 'edit', 'search')
  .instructions('Write or revise the documentation page so that every link resolves.');

const writerAgent = H.agent('writer')
  .role(writer)
  .model(sonnet)
  .pool(docsPool)
  .workspace(git.worktree({ repo: 'docs', base: 'main' }))
  .output(z.object({ summary: z.string() }));

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(input => ['link-check', input.path])
  .acceptExitCodes(0, 2)
  .runner(docsRunner);

const writePage = H.flow('write-page')
  .input(docAttributes)
  .loop(
    'revise',
    pass =>
      pass
        .step('write', writerAgent, ctx => ({
          task: `Revise ${ctx.unit.attributes.path} ("${ctx.unit.attributes.title}").`,
          resources: [ctx.unit.attributes.path],
        }))
        .step('linkCheck', linkCheck, ctx => ({ path: ctx.unit.attributes.path })),
    { max: 3, until: ctx => ctx.steps.linkCheck.exitCode === 0 },
  )
  .exit('published', ctx => ctx.steps.linkCheck.exitCode === 0)
  .exit('broken');

const docPages = H.lane('doc-pages', DocPage)
  .supply(folder.files({ path: 'docs', glob: '**/*.md' }), (file, to) =>
    to.create({ path: file.path, title: file.name, body: file.body }),
  )
  .store(folder.frontmatter({ path: 'docs' }))
  .handler(writePage, {
    exits: { published: Published, broken: Broken },
    during: { write: Writing, linkCheck: LinkChecking },
  });

const docsExperience = H.journal('experience', experienceKind)
  .store(jsonl.memoryStore({ path: 'docs/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 10 })
  .readBy(writer);

const docs = H.harness('documentation')
  .ledger(sqlite.ledger({ path: 'docs/.harness/ledger.sqlite', quotaPath: sharedQuotaPath }))
  .lanes(docPages)
  .journals(docsExperience, tasteJournal(writer))
  .scheduler(H.scheduler('docs').priority(docPages))
  .clients(
    claudeCode.supervisor('docs-supervisor', {
      endpoint: 'docs',
      grants: [
        H.ops.workRead,
        H.ops.workCreate,
        H.ops.blockersResolve,
        H.ops.memoryRead,
        H.ops.memoryWrite,
        H.ops.telemetryRead,
        H.ops.accountsRead,
        H.ops.accountsShare,
      ],
    }),
  )
  .observers(markdown.board({ path: 'docs/.harness/board.md' }), markdown.telemetry({ path: 'docs/.harness/telemetry.md' }));

void coding.start();
void docs.start();
