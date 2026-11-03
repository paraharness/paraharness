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

const sharedQuota = sqlite.quota('~/.harness/shared/quota.sqlite');

export const maxOne = H.account('claude-max-1', claudeCode.driver({ configDir: '~/.claude-max-1' })).quota(sharedQuota);
export const maxTwo = H.account('claude-max-2', claudeCode.driver({ configDir: '~/.claude-max-2' })).quota(sharedQuota);
export const maxThree = H.account('claude-max-3', claudeCode.driver({ configDir: '~/.claude-max-3' })).quota(sharedQuota);
export const apiAccount = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(sharedQuota);

export const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
export const opus = H.model('claude-opus-4-1', { budgetTokens: 32000 }).pricing(anthropic.pricing());

export const taste = H.memory('taste')
  .content(z.object({ rule: z.string(), because: z.string() }))
  .trust('taste');
export const experience = H.memory('experience')
  .content(z.object({ action: z.string(), situation: z.string(), because: z.string() }))
  .trust('experience');

export const ownerTaste = H.journal('owner-taste')
  .of(taste)
  .store(jsonl.memory('~/.harness/shared/taste.jsonl'))
  .recall(policies.specificity({ limit: 12 }));

const appCode = H.resource('app-code');
const localRunner = runners.local({ name: 'local', slots: 4 });

const ticket = z.object({ title: z.string(), description: z.string(), labels: z.array(z.string()) });
const open = H.state('open').pending();
const delivered = H.state('delivered').terminal('success');
const abandoned = H.state('abandoned').terminal('failure');

const bug = H.work('Bug').schema(ticket).states(open, delivered, abandoned);
const feature = H.work('Feature').schema(ticket).states(open, delivered, abandoned);

const projectChecks = H.command('project-checks')
  .input(z.object({ workspace: z.string() }))
  .output(z.object({ ok: z.boolean(), report: z.string() }))
  .runner(localRunner)
  .run(async (input, ctx) => {
    const result = await ctx.exec(['npm', 'run', 'check'], { cwd: input.workspace });
    return { ok: result.code === 0, report: result.stdout + result.stderr };
  });

const builder = H.role('builder')
  .promptFile('./prompts/builder.md')
  .intents(['read', 'edit', 'shell'])
  .recall(taste, experience)
  .use(plugins.fileLeaseGuard().area(appCode, ['src/**', 'test/**']), plugins.stopCheck(projectChecks));
const auditor = H.role('auditor')
  .promptFile('./prompts/auditor.md')
  .intents(['read', 'shell'])
  .recall(experience)
  .record(experience);

const build = H.skill('build')
  .input(z.object({ title: z.string(), description: z.string(), round: z.number() }))
  .output(z.object({ summary: z.string(), question: z.string().optional() }))
  .prompt(i => `Round ${i.round}: ${i.title}\n\n${i.description}`);
const audit = H.skill('audit')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit the work on "${i.title}": ${i.summary}`);

const builderModel = H.policy.models('builder-model', c => {
  const reading = c.unit.kind === bug.name ? c.metrics.read(bugDelivery, sonnet) : c.metrics.read(featureDelivery, sonnet);
  const cheapHolds = reading.samples < 20 || (reading.value ?? 1) >= 0.85;
  return cheapHolds ? [sonnet, opus] : [opus, sonnet];
});

const builderSeat = H.seat('builder').role(builder).skill(build).models(sonnet, opus).policy(builderModel);
const auditorSeat = H.seat('auditor').role(auditor).skill(audit).models(sonnet);

const ownerCall = H.halt('owner-call')
  .context(z.object({ question: z.string() }))
  .decision(z.object({ answer: z.string() }));

const buildAndAudit = H.flow('build-and-audit')
  .input(ticket.extend({ rounds: z.number() }))
  .use(plugins.gitWorktree())
  .resources(() => [appCode])
  .loop('round', {
    max: s => s.input.rounds,
    body: f => f
      .step('build', builderSeat, s => ({ title: s.input.title, description: s.input.description, round: s.round.iteration }))
      .when(s => s.build.question !== undefined, b => b.halt('ownerCall', ownerCall, s => ({ question: s.build.question ?? '' })))
      .step('audit', auditorSeat, s => ({ title: s.input.title, summary: s.build.summary })),
    until: s => s.audit.deficits.length === 0,
  })
  .when(s => s.audit.deficits.length > 0, f => f.exit('roundsExhausted'))
  .exit('delivered');

const trackerStore = linear.store({
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'ENG',
  schema: ticket,
  states: { open: 'Todo', delivered: 'Done', abandoned: 'Canceled' },
});

const bugs = H.lane('bugs')
  .of(bug)
  .from(
    linear.issues({ name: 'linear-bugs', apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['bug'], data: i => ({ title: i.title, description: i.description, labels: [...i.labels] }) }),
    folder.files({ name: 'bug-folder', path: './bugs', glob: '*.md', data: f => ({ title: f.name, description: f.body, labels: ['folder'] }) }),
    manual('operator-bugs'),
  )
  .store(trackerStore)
  .handle(buildAndAudit, {
    input: u => ({ ...u.data, rounds: 3 }),
    exits: { delivered, roundsExhausted: abandoned },
    retry: { retries: 2, backoff: { initial: '1m', factor: 2 }, exhausted: abandoned },
  })
  .wip(2);

const features = H.lane('features')
  .of(feature)
  .from(
    linear.issues({ name: 'linear-features', apiKey: H.env('LINEAR_API_KEY'), team: 'ENG', labels: ['feature'], data: i => ({ title: i.title, description: i.description, labels: [...i.labels] }) }),
    manual('operator-features'),
  )
  .store(trackerStore)
  .handle(buildAndAudit, {
    input: u => ({ ...u.data, rounds: 5 }),
    exits: { delivered, roundsExhausted: abandoned },
    retry: { retries: 2, backoff: { initial: '1m', factor: 2 }, exhausted: abandoned },
  });

const bugDelivery = H.metric('bug-delivery', H.events.transitions(bugs, { terminal: true }))
  .rate(e => e.verdict === 'success')
  .by('model')
  .window('14d');
const featureDelivery = H.metric('feature-delivery', H.events.transitions(features, { terminal: true }))
  .rate(e => e.verdict === 'success')
  .by('model')
  .window('14d');

const codingExperience = H.journal('coding-experience')
  .of(experience)
  .store(jsonl.memory('./.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const codingPool = H.pool('coding-subscriptions', [maxOne, maxTwo, maxThree])
  .share(maxOne, 0.6)
  .share(maxTwo, 0.6)
  .share(maxThree, 0.6)
  .serves(sonnet, opus)
  .policy(policies.soonestReset())
  .fallback(apiAccount);

const ownerOperations = [
  H.ops.work.read,
  H.ops.work.write,
  H.ops.attempts.manage,
  H.ops.memory.write(taste),
  H.ops.memory.write(experience),
  H.ops.telemetry.read,
  H.ops.accounts.manage,
] as const;

const bugsBeforeFeatures = H.policy.units('bugs-before-features', c => [
  ...c.candidates.filter(bugs.holds),
  ...c.candidates.filter(x => !bugs.holds(x)),
]);

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger('./coding/.harness/ledger.sqlite'))
  .pools(codingPool)
  .lanes(bugs, features)
  .journals(ownerTaste, codingExperience)
  .scheduler(bugsBeforeFeatures)
  .grants(H.grant(claudeCode.client({ name: 'coding-supervisor', session: 'owner' }), ...ownerOperations), H.grant(ownerCallClient(), H.ops.resolve(ownerCall)))
  .observe(observers.board({ path: './coding/BOARD.md' }), observers.telemetry({ path: './coding/TELEMETRY.md' }));

function ownerCallClient() {
  return claudeCode.client({ name: 'coding-owner-calls', session: 'owner' });
}

const docPage = z.object({ path: z.string(), title: z.string(), body: z.string() });
const queued = H.state('queued').pending();
const published = H.state('published').terminal('success');
const linksBroken = H.state('links-broken').terminal('failure');
const docAbandoned = H.state('doc-abandoned').terminal('failure');
const page = H.work('DocPage').schema(docPage).states(queued, published, linksBroken, docAbandoned);

const writer = H.role('writer').promptFile('./prompts/writer.md').intents(['read', 'edit']).recall(taste, experience).record(experience);
const writePage = H.skill('write-page')
  .input(docPage)
  .output(z.object({ body: z.string() }))
  .prompt(i => `Revise the page "${i.title}" at ${i.path}:\n\n${i.body}`);
const writerSeat = H.seat('writer').role(writer).skill(writePage).models(sonnet);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string(), body: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .runner(localRunner)
  .run(async (input, ctx) => {
    const result = await ctx.exec(['lychee', '--format', 'compact', '-'], { stdin: input.body });
    return { broken: result.code === 0 ? [] : result.stdout.split('\n').filter(line => line.length > 0) };
  });

const writeAndCheck = H.flow('write-and-check')
  .input(docPage)
  .step('write', writerSeat, s => s.input)
  .step('links', linkCheck, s => ({ path: s.input.path, body: s.write.body }))
  .when(s => s.links.broken.length > 0, f => f.exit('broken'))
  .exit('published');

const docPages = H.lane('doc-pages')
  .of(page)
  .from(folder.files({ name: 'doc-folder', path: './docs', glob: '**/*.md', key: f => f.path, data: f => ({ path: f.path, title: f.name, body: f.body }) }))
  .store(folder.store({ path: './docs', schema: docPage }))
  .handle(writeAndCheck, {
    exits: { published, broken: linksBroken },
    retry: { retries: 1, backoff: { initial: '5m', factor: 2 }, exhausted: docAbandoned },
  })
  .wip(2);

const docsExperience = H.journal('docs-experience')
  .of(experience)
  .store(jsonl.memory('./docs-harness/.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const docsPool = H.pool('docs-subscriptions', [maxOne, maxTwo, maxThree])
  .share(maxOne, 0.3)
  .share(maxTwo, 0.3)
  .share(maxThree, 0.3)
  .serves(sonnet)
  .policy(policies.soonestReset());

const oldestFirst = H.policy.units('oldest-first', c => [...c.candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime()));

export const documentation = H.harness('documentation')
  .ledger(sqlite.ledger('./docs-harness/.harness/ledger.sqlite'))
  .pools(docsPool)
  .lanes(docPages)
  .journals(ownerTaste, docsExperience)
  .scheduler(oldestFirst)
  .grants(H.grant(claudeCode.client({ name: 'docs-supervisor', session: 'owner' }), ...ownerOperations))
  .observe(observers.board({ path: './docs-harness/BOARD.md' }), observers.telemetry({ path: './docs-harness/TELEMETRY.md' }));
