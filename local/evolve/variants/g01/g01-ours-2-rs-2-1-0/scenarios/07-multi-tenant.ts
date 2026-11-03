import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import { folder, manual } from 'harness-dsl/supply';
import { runners } from 'harness-dsl/runners';
import { policies } from 'harness-dsl/policies';
import { observers } from 'harness-dsl/observers';
import { plugins } from 'harness-dsl/plugins';

const sharedQuota = sqlite.quota('~/.harness/shared/quota.db');

const subscriptionOne = H.account('subscription-one', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_ONE') })).quota(sharedQuota);
const subscriptionTwo = H.account('subscription-two', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_TWO') })).quota(sharedQuota);
const subscriptionThree = H.account('subscription-three', claudeCode.driver({ configDir: H.env('CLAUDE_CONFIG_THREE') })).quota(sharedQuota);

const haiku = H.model('claude-haiku-4-5').pricing(anthropic.pricing());
const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());

const taste = H.memory('taste').content(z.object({ text: z.string() })).trust('taste');
const experience = H.memory('experience').content(z.object({ text: z.string() })).trust('experience').curated();

const ownerTaste = H.journal('owner-taste')
  .of(taste)
  .store(jsonl.memory('~/.harness/shared/taste.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const ownerSession = claudeCode.client({ name: 'owner' });

export const shared = {
  subscriptions: [subscriptionOne, subscriptionTwo, subscriptionThree],
  models: { haiku, sonnet, opus },
  taste,
  experience,
  ownerTaste,
  ownerSession,
};

const local = runners.local({ name: 'local', slots: 4 });

const workItem = z.object({ title: z.string(), description: z.string() });
const queued = H.state('queued').pending();
const shipped = H.state('shipped').terminal('success');
const abandoned = H.state('abandoned').terminal('failure');

const bug = H.work('Bug').schema(workItem).states(queued, shipped, abandoned);
const feature = H.work('Feature').schema(workItem).states(queued, shipped, abandoned);
const epic = H.work('Epic').schema(workItem).states(queued, shipped, abandoned);

const sourceTree = H.resource('source-tree');

const projectChecks = H.command('project-checks')
  .input(z.object({ workspace: z.string() }))
  .output(z.object({ ok: z.boolean(), report: z.string() }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['npm', 'run', 'check'], { cwd: input.workspace });
    return { ok: result.code === 0, report: result.stdout + result.stderr };
  });

const builderRole = H.role('builder')
  .promptFile('prompts/builder.md')
  .intents(['read', 'edit', 'shell'])
  .recall(experience, taste)
  .use(plugins.fileLeaseGuard().area(sourceTree, ['src/**', 'test/**']), plugins.stopCheck(projectChecks));
const auditorRole = H.role('auditor').promptFile('prompts/auditor.md').intents(['read', 'shell']).recall(experience).record(experience);
const plannerRole = H.role('planner').promptFile('prompts/planner.md').intents(['read']).recall(taste);

const build = H.skill('build')
  .input(z.object({ title: z.string(), description: z.string(), round: z.number() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Round ${input.round}: ${input.title}\n\n${input.description}`);
const audit = H.skill('audit')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(input => `Audit the change for ${input.title}:\n${input.summary}`);
const plan = H.skill('plan')
  .input(z.object({ title: z.string(), description: z.string() }))
  .output(z.object({ features: z.array(z.object({ key: z.string(), title: z.string(), description: z.string() })) }))
  .prompt(input => `Decompose the epic ${input.title} into features:\n${input.description}`);

const attemptSuccess = H.metric('attempt-success', H.events.attempts())
  .rate(event => event.outcome === 'succeeded')
  .by('model', 'kind')
  .window('14d');

const cheaperUntilItSlips = H.policy.models('cheaper-until-it-slips', choice => {
  const kind = choice.unit.kind === bug.name ? bug : feature;
  const reading = choice.metrics.read(attemptSuccess, haiku, kind);
  const slipping = reading.samples >= 20 && (reading.value ?? 1) < 0.85;
  return slipping ? [opus, haiku] : [haiku, opus];
});

const builder = H.seat('builder').role(builderRole).skill(build).models(haiku, opus).policy(cheaperUntilItSlips);
const auditor = H.seat('auditor').role(auditorRole).skill(audit).models(sonnet);
const planner = H.seat('planner').role(plannerRole).skill(plan).models(opus);

const deliver = H.flow('deliver')
  .input(z.object({ title: z.string(), description: z.string(), rounds: z.number() }))
  .use(plugins.gitWorktree())
  .loop('round', {
    max: state => state.input.rounds,
    body: flow => flow
      .step('build', builder, state => ({ title: state.input.title, description: state.input.description, round: state.round.iteration }))
      .step('audit', auditor, state => ({ title: state.input.title, summary: state.build.summary })),
    until: state => state.audit.deficits.length === 0,
  })
  .when(state => state.audit.deficits.length > 0, flow => flow.exit('unfinished'))
  .exit('shipped');

const tracker = { apiKey: H.env('LINEAR_API_KEY'), team: 'PRODUCT' };
const trackerStore = linear.store({ ...tracker, schema: workItem, states: { queued: 'Todo', shipped: 'Done', abandoned: 'Canceled' } });

const bugs = H.lane('bugs')
  .of(bug)
  .from(
    linear.issues({ name: 'tracker-bugs', ...tracker, labels: ['bug'], data: issue => ({ title: issue.title, description: issue.description }) }),
    folder.files({ name: 'bug-folder', path: 'bugs', glob: '*.md', key: file => file.name, data: file => ({ title: file.name, description: file.body }) }),
    manual('operator-bugs'),
  )
  .store(trackerStore)
  .handle(deliver, {
    input: unit => ({ title: unit.data.title, description: unit.data.description, rounds: 3 }),
    exits: { shipped, unfinished: abandoned },
    retry: { retries: 2, backoff: { initial: '1m', factor: 2 }, exhausted: abandoned },
  })
  .wip(2);

const features = H.lane('features')
  .of(feature)
  .from(
    linear.issues({ name: 'tracker-features', ...tracker, labels: ['feature'], data: issue => ({ title: issue.title, description: issue.description }) }),
    manual('operator-features'),
  )
  .store(trackerStore)
  .handle(deliver, {
    input: unit => ({ title: unit.data.title, description: unit.data.description, rounds: 5 }),
    exits: { shipped, unfinished: abandoned },
    retry: { retries: 2, backoff: { initial: '1m', factor: 2 }, exhausted: abandoned },
  });

const decompose = H.flow('decompose')
  .input(workItem)
  .step('plan', planner, state => ({ title: state.input.title, description: state.input.description }))
  .spawn('features', features, state => state.plan.features.map(child => ({ key: child.key, data: { title: child.title, description: child.description } })))
  .when(state => state.features.every(child => child.verdict === 'success'), flow => flow.exit('done'))
  .exit('incomplete');

const epics = H.lane('epics')
  .of(epic)
  .from(linear.issues({ name: 'tracker-epics', ...tracker, labels: ['epic'], data: issue => ({ title: issue.title, description: issue.description }) }))
  .store(trackerStore)
  .handle(decompose, { exits: { done: shipped, incomplete: abandoned }, retry: { retries: 1, backoff: 'none', exhausted: abandoned } })
  .wip(1);

const laneOrder: readonly string[] = [bugs.name, features.name, epics.name];
const starvationMs = 4 * 60 * 60 * 1000;

const codingOrder = H.policy.units('bugs-features-epics-with-starvation', choice => {
  const starving = choice.candidates.filter(c => c.lane === features.name && choice.now.getTime() - c.queuedAt.getTime() > starvationMs);
  const rest = choice.candidates
    .filter(c => starving.includes(c) === false)
    .sort((a, b) => laneOrder.indexOf(a.lane) - laneOrder.indexOf(b.lane));
  return [...starving, ...rest];
});

const apiFallback = H.account('api-fallback', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));

const codingSubscriptions = H.pool('coding-subscriptions', shared.subscriptions)
  .serves(haiku, sonnet, opus)
  .maxQuotaShare(0.6)
  .policy(policies.soonestReset())
  .fallback(apiFallback);

const codingExperience = H.journal('coding-experience').of(experience).store(jsonl.memory('.harness/experience.jsonl')).recall(policies.specificity());

export const harnessA = H.harness('coding')
  .ledger(sqlite.ledger('.harness/coding-ledger.db'))
  .pools(codingSubscriptions)
  .lanes(bugs, features, epics)
  .journals(shared.ownerTaste, codingExperience)
  .metrics(attemptSuccess)
  .scheduler(codingOrder)
  .grants(H.grant(shared.ownerSession, H.ops.work.read, H.ops.work.write, H.ops.memory.write(taste), H.ops.telemetry.read, H.ops.accounts.manage))
  .observe(observers.board({ path: '.harness/board.md' }), observers.telemetry({ path: '.harness/telemetry.md' }));

const docPage = z.object({ path: z.string(), title: z.string(), brief: z.string() });
const draft = H.state('draft').pending();
const published = H.state('published').terminal('success');
const brokenLinks = H.state('broken-links').terminal('failure');
const docPageKind = H.work('DocPage').schema(docPage).states(draft, published, brokenLinks);

const writerRole = H.role('writer').promptFile('prompts/writer.md').intents(['read', 'edit']).recall(taste, experience);
const writePage = H.skill('write-page')
  .input(z.object({ path: z.string(), title: z.string(), brief: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(input => `Write ${input.path} titled ${input.title}.\n\n${input.brief}`);
const writer = H.seat('writer').role(writerRole).skill(writePage).models(sonnet);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ ok: z.boolean(), broken: z.array(z.string()) }))
  .runner(local)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['npx', 'markdown-link-check', '--quiet', input.path]);
    return { ok: result.code === 0, broken: result.stdout.split('\n').filter(line => line.includes('✖')) };
  });

const writeDoc = H.flow('write-doc')
  .input(docPage)
  .step('write', writer, state => ({ path: state.input.path, title: state.input.title, brief: state.input.brief }))
  .step('links', linkCheck, state => ({ path: state.input.path }))
  .when(state => state.links.ok === false, flow => flow.exit('broken'))
  .exit('published');

const frontmatterText = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

const docs = H.lane('docs')
  .of(docPageKind)
  .from(folder.files({
    name: 'doc-pages',
    path: 'docs',
    glob: '**/*.md',
    key: file => file.path,
    data: file => ({ path: file.path, title: frontmatterText(file.frontmatter.title, file.name), brief: file.body }),
  }))
  .store(folder.store({ path: 'docs', schema: docPage }))
  .handle(writeDoc, { exits: { published, broken: brokenLinks }, retry: { retries: 1, backoff: 'none', exhausted: brokenLinks } })
  .wip(2);

const docsSubscriptions = H.pool('docs-subscriptions', shared.subscriptions)
  .serves(sonnet)
  .maxQuotaShare(0.3)
  .policy(policies.soonestReset());

const docsExperience = H.journal('docs-experience').of(experience).store(jsonl.memory('.harness/experience.jsonl')).recall(policies.specificity());

const docsOrder = H.policy.units('oldest-first', choice => [...choice.candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime()));

export const harnessB = H.harness('docs')
  .ledger(sqlite.ledger('.harness/docs-ledger.db'))
  .pools(docsSubscriptions)
  .lanes(docs)
  .journals(shared.ownerTaste, docsExperience)
  .scheduler(docsOrder)
  .grants(H.grant(shared.ownerSession, H.ops.work.read, H.ops.work.write, H.ops.memory.write(taste), H.ops.telemetry.read, H.ops.accounts.manage))
  .observe(observers.board({ path: '.harness/board.md' }));
