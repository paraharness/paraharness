import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const ownerQuota = sqlite.quota('owner-quota', { path: '~/.harness/owner-quota.sqlite' });

const maxOne = claudeCode.subscription('max-1', { token: H.env('CLAUDE_MAX_1_TOKEN'), quota: ownerQuota });
const maxTwo = claudeCode.subscription('max-2', { token: H.env('CLAUDE_MAX_2_TOKEN'), quota: ownerQuota });
const maxThree = claudeCode.subscription('max-3', { token: H.env('CLAUDE_MAX_3_TOKEN'), quota: ownerQuota });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: ownerQuota });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiring = H.policy.account('soonest-expiring', ctx =>
  ctx.candidates
    .filter(state =>
      state.shareUsed < state.shareCap &&
      (state.cooldownUntil === undefined || state.cooldownUntil.getTime() <= ctx.now.getTime()))
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0]);

const builder = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the unit of work on the worktree and keep the project checks green.');
const auditor = H.role('auditor')
  .intents('read', 'search', 'record')
  .instructions('List every deficit of the change against its unit of work; list none when there are none.');
const planner = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');
const writer = H.role('writer')
  .intents('read', 'edit')
  .instructions('Write or revise the documentation page so it is accurate and its links resolve.');

const tasteKind = H.memory('taste', 'taste');
const experienceKind = H.memory('experience', 'experience');

const ownerTaste = H.journal('owner-taste', tasteKind)
  .store(jsonl.memoryStore({ path: '~/.harness/owner-taste.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builder, planner, writer);

const todo = H.state('Todo', 'pending');
const shipped = H.terminal('Done', 'success');
const abandoned = H.terminal('Abandoned', 'failure');
const dropped = H.terminal('Dropped', 'neutral');

const productPool = H.pool('product-pool')
  .accounts(maxOne, maxTwo, maxThree)
  .share(maxOne, 0.6)
  .share(maxTwo, 0.6)
  .share(maxThree, 0.6)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const productExperience = H.journal('product-experience', experienceKind)
  .store(jsonl.memoryStore({ path: './product/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(builder, auditor)
  .recordedBy(auditor);

const issue = z.object({
  title: z.string(),
  body: z.string(),
  trackerId: z.string().optional(),
});

const bug = H.kind('Bug').attributes(issue).states(todo, shipped, abandoned, dropped).key(a => a.trackerId ?? a.title).initial(todo);
const feature = H.kind('Feature').attributes(issue).states(todo, shipped, abandoned, dropped).key(a => a.trackerId ?? a.title).initial(todo);
const epic = H.kind('Epic').attributes(issue).states(todo, shipped, abandoned, dropped).key(a => a.trackerId ?? a.title).initial(todo);

const heartbeatFailed = H.terminal('Unhealthy', 'failure');
const heartbeatHealthy = H.terminal('Healthy', 'success');
const heartbeatDue = H.state('Due', 'pending');
const heartbeat = H.kind('ServiceHeartbeat')
  .attributes(z.object({ service: z.string(), at: z.string() }))
  .states(heartbeatDue, heartbeatHealthy, heartbeatFailed)
  .key(a => `${a.service}@${a.at}`)
  .initial(heartbeatDue);

const localRunner = local.runner('product-local').slots(4);

const projectChecks = H.command('project-checks').argv(['npm', 'run', 'check']).runner(localRunner);

const healthProbe = H.command('health-probe')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', `https://${input.service}.example.com/health`])
  .runner(localRunner);

const productionHealth = H.command('production-health')
  .argv(['curl', '-fsS', 'https://api.example.com/health'])
  .runner(localRunner);

const ownerDecision = H.halt('owner-decision').decision(z.object({ answer: z.string() }));

const builderModel = H.policy.model('builder-cheaper-until-it-slips', [sonnet, opus], ctx => {
  const record = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: sonnet, window: { lastDays: 14 } });
  return record.samples >= 20 && record.successRate < 0.85 ? opus : sonnet;
});

const builderSeat = H.seat('builder')
  .role(builder)
  .model(builderModel)
  .pool(productPool)
  .workspace(git.worktree({ repo: './product', base: 'main' }))
  .guard({ leaseFiles: true, beforeStop: projectChecks })
  .halts(ownerDecision);

const auditorSeat = H.seat('auditor')
  .role(auditor)
  .model(opus)
  .pool(productPool)
  .output(z.object({ deficits: z.array(z.string()) }));

const plannerSeat = H.seat('planner')
  .role(planner)
  .model(opus)
  .pool(productPool)
  .output(z.object({ features: z.array(issue) }));

const buildAndAudit = H.flow('build-and-audit')
  .input(issue)
  .params(z.object({ rounds: z.number() }))
  .loop(
    'rounds',
    flow => flow
      .step('build', builderSeat, ctx => ({ task: `Implement: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}` }), { afterCrash: 'askDriver' })
      .step('audit', auditorSeat, ctx => ({ task: `Audit the change made for: ${ctx.unit.attributes.title}` }), { afterCrash: 'askDriver' }),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('outOfRounds');

const linearKey = H.env('LINEAR_API_KEY');
const tracker = linear.store({ apiKey: linearKey, team: 'ENG', workflow: ['Todo', 'In Progress', 'Done', 'Canceled'] });

const features = H.lane('product-features', feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['feature'] }), (found, to) =>
    to.create({ title: found.title, body: found.description, trackerId: found.identifier }))
  .supply(H.operator)
  .handler(buildAndAudit, { exits: { clean: shipped, outOfRounds: abandoned }, params: { rounds: 5 } })
  .store(tracker, {
    states: { Todo: 'Todo', Done: 'Done', Abandoned: 'Canceled', Dropped: 'Canceled' },
    inFlight: 'In Progress',
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: abandoned })
  .on(H.cancel, { enter: dropped });

const bugs = H.lane('product-bugs', bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['bug'] }), (found, to) =>
    to.create({ title: found.title, body: found.description, trackerId: found.identifier }))
  .supply(folder.files({ path: './product/bugs', glob: '*.md' }), (file, to) =>
    to.create({ title: file.name, body: file.body }))
  .supply(H.operator)
  .handler(buildAndAudit, { exits: { clean: shipped, outOfRounds: abandoned }, params: { rounds: 3 } })
  .store(tracker, {
    states: { Todo: 'Todo', Done: 'Done', Abandoned: 'Canceled', Dropped: 'Canceled' },
    inFlight: 'In Progress',
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 60000, exhausted: abandoned })
  .on(H.cancel, { enter: dropped });

const decompose = H.flow('decompose-epic')
  .input(issue)
  .step('plan', plannerSeat, ctx => ({ task: `Decompose the epic: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}` }))
  .spawn('features', features, ctx => ctx.steps.plan.features)
  .exit('complete', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('product-epics', epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['epic'] }), (found, to) =>
    to.create({ title: found.title, body: found.description, trackerId: found.identifier }))
  .handler(decompose, { exits: { complete: shipped, incomplete: abandoned } })
  .store(tracker, {
    states: { Todo: 'Todo', Done: 'Done', Abandoned: 'Canceled', Dropped: 'Canceled' },
    inFlight: 'In Progress',
  })
  .retry({ maxAttempts: 2, exhausted: abandoned })
  .on(H.cancel, { enter: dropped });

const probe = H.flow('probe-service')
  .input(z.object({ service: z.string(), at: z.string() }))
  .step('probe', healthProbe, ctx => ({ service: ctx.unit.attributes.service }), { afterCrash: 'rerun' })
  .exit('healthy');

const heartbeats = H.lane('product-heartbeats', heartbeat)
  .supply(H.clock('every-five-minutes').every({ minutes: 5 }), (tick, to) =>
    to.create({ service: 'api', at: tick.at.toISOString() }))
  .handler(probe, { exits: { healthy: heartbeatHealthy } })
  .retry({ maxAttempts: 1, exhausted: heartbeatFailed });

const heartbeatFilesBug = H.trigger('heartbeat-failure-files-bug')
  .on(H.when.transition(heartbeats, { to: heartbeatFailed }))
  .create(bugs, event => ({
    title: `Heartbeat failed for ${event.unit.attributes.service}`,
    body: `The ${event.unit.attributes.service} health probe failed at ${event.unit.attributes.at}.`,
  }));

const productHealth = H.operation('production-health', productionHealth);

const productSupervisor = claudeCode.supervisor('product-supervisor', {
  port: H.slot.port(1),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.workCancel,
    H.ops.resolve(ownerDecision),
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    productHealth,
  ],
});

export const product = H.harness('product')
  .ledger(sqlite.ledger({ path: './product/.harness/ledger.sqlite' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(ownerTaste, productExperience)
  .triggers(heartbeatFilesBug)
  .scheduler(
    H.scheduler('product-scheduler')
      .expedite(heartbeats)
      .standard(bugs, features, epics)
      .wip(bugs, 2)
      .wip(epics, 1)
      .aging(features, { afterMinutes: 240 }),
  )
  .clients(productSupervisor)
  .observers(
    markdown.board({ path: './product/.harness/board.md' }),
    markdown.telemetry({ path: './product/.harness/telemetry.md' }),
  );

const docsPool = H.pool('docs-pool')
  .accounts(maxOne, maxTwo, maxThree)
  .share(maxOne, 0.3)
  .share(maxTwo, 0.3)
  .share(maxThree, 0.3)
  .drain(soonestExpiring);

const docsExperience = H.journal('docs-experience', experienceKind)
  .store(jsonl.memoryStore({ path: './docs/.harness/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 8 })
  .readBy(writer)
  .recordedBy(writer);

const pageDraft = H.state('Draft', 'pending');
const pagePublished = H.terminal('Published', 'success');
const pageBroken = H.terminal('Broken', 'failure');
const pageRetired = H.terminal('Retired', 'neutral');

const page = z.object({ path: z.string(), title: z.string() });

const docPage = H.kind('DocPage')
  .attributes(page)
  .states(pageDraft, pagePublished, pageBroken, pageRetired)
  .key(a => a.path)
  .initial(pageDraft);

const docsRunner = local.runner('docs-local').slots(2);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .argv(input => ['npx', 'linkinator', input.path])
  .runner(docsRunner);

const writerSeat = H.seat('writer')
  .role(writer)
  .model(sonnet)
  .pool(docsPool)
  .workspace(git.worktree({ repo: './docs', base: 'main' }));

const writePage = H.flow('write-page')
  .input(page)
  .step('write', writerSeat, ctx => ({ task: `Revise ${ctx.unit.attributes.path}: ${ctx.unit.attributes.title}` }), { afterCrash: 'askDriver' })
  .step('linkCheck', linkCheck, ctx => ({ path: ctx.unit.attributes.path }), { afterCrash: 'rerun' })
  .exit('published');

const docPages = H.lane('doc-pages', docPage)
  .supply(folder.files({ path: './docs/pages', glob: '**/*.md' }), (file, to) =>
    to.create({ path: file.path, title: file.name }))
  .handler(writePage, { exits: { published: pagePublished } })
  .store(folder.frontmatter({ path: './docs/pages' }))
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 300000, exhausted: pageBroken })
  .on(H.cancel, { enter: pageRetired });

const docsSupervisor = claudeCode.supervisor('docs-supervisor', {
  port: H.slot.port(2),
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
  ],
});

export const docs = H.harness('docs')
  .ledger(sqlite.ledger({ path: './docs/.harness/ledger.sqlite' }))
  .lanes(docPages)
  .journals(ownerTaste, docsExperience)
  .scheduler(H.scheduler('docs-scheduler').standard(docPages).wip(docPages, 2))
  .clients(docsSupervisor)
  .observers(markdown.board({ path: './docs/.harness/board.md' }));

export const ownerSession = claudeCode.session('owner', { endpoints: [productSupervisor, docsSupervisor] });
