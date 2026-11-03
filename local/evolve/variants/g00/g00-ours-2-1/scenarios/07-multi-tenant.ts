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
import { plugins } from 'harness-dsl/plugins';
import { observers } from 'harness-dsl/observers';

const sharedQuota = sqlite.quota('~/.harness/shared/quota.sqlite');

export const shared = {
  subscriptions: ['1', '2', '3'].map(n =>
    H.account(`claude-max-${n}`, claudeCode.driver({ configDir: `~/.claude-max-${n}` })).quota(sharedQuota),
  ),
  api: H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') })).quota(sharedQuota),
  sonnet: H.model('claude-sonnet-4-5').pricing(anthropic.pricing()),
  opus: H.model('claude-opus-4-1').pricing(anthropic.pricing()),
  taste: H.memory('taste').content(z.object({ rule: z.string() })).trust('taste'),
  experience: H.memory('experience').content(z.object({ rule: z.string() })).trust('experience'),
};

export const tasteJournal = H.journal('owner-taste')
  .of(shared.taste)
  .store(jsonl.memory('~/.harness/shared/taste.jsonl'))
  .recall(policies.specificity({ limit: 8 }));

const subscriptionPool = (share: number) =>
  H.pool('claude-subscriptions', shared.subscriptions.map(account => account.maxQuotaShare(share)))
    .serves(shared.sonnet, shared.opus)
    .policy(policies.soonestReset())
    .fallback(shared.api);

const queued = H.state('queued').pending();
const building = H.state('building').active();
const shipped = H.state('shipped').terminal('success');
const declined = H.state('declined').terminal('neutral');
const stuck = H.state('stuck').waiting();

const issue = z.object({ title: z.string(), description: z.string() });
const bug = H.work('Bug').schema(issue).states(queued, building, shipped, declined, stuck);
const feature = H.work('Feature').schema(issue).states(queued, building, shipped, declined, stuck);

const sourceTree = H.resource('source-tree');
const productRunner = runners.local({ name: 'product-local', slots: 4 });

const projectChecks = H.command('project-checks')
  .input(z.object({ workspace: z.string() }))
  .output(z.object({ ok: z.boolean(), report: z.string() }))
  .runner(productRunner)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['npm', 'run', 'check'], { cwd: input.workspace });
    return { ok: result.code === 0, report: result.stdout + result.stderr };
  });

const builderRole = H.role('builder')
  .prompt('Implement the issue. Keep the project checks green.')
  .intents(['read', 'edit', 'shell'])
  .recall(shared.experience, shared.taste)
  .use(plugins.fileLeaseGuard().area(sourceTree, ['src/**', 'test/**']), plugins.stopCheck(projectChecks));

const auditorRole = H.role('auditor')
  .prompt('List every deficit of the change against the issue.')
  .intents(['read'])
  .recall(shared.experience)
  .record(shared.experience);

const buildSkill = H.skill('build')
  .input(z.object({ title: z.string(), description: z.string(), round: z.number() }))
  .output(z.object({ summary: z.string(), needsOwner: z.boolean(), question: z.string() }))
  .prompt(i => `Round ${i.round}: ${i.title}\n\n${i.description}`);

const auditSkill = H.skill('audit')
  .input(z.object({ title: z.string(), summary: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(i => `Audit "${i.title}" given this change: ${i.summary}`);

const ownerDecision = H.halt('owner-decision')
  .context(z.object({ question: z.string() }))
  .decision(z.object({ answer: z.string() }))
  .ask(c => c.question);

const cheapUntilWeak = H.policy.models('cheap-until-weak', ({ unit, metrics }) => {
  const reading = metrics.read(unit.lane === bugs.name ? bugSuccess : featureSuccess, { model: shared.sonnet.name });
  const weak = reading.samples >= 20 && (reading.value ?? 1) < 0.85;
  return weak ? [shared.opus, shared.sonnet] : [shared.sonnet, shared.opus];
});

const builder = H.seat('builder').role(builderRole).skill(buildSkill).models(shared.sonnet, shared.opus).policy(cheapUntilWeak);
const auditor = H.seat('auditor').role(auditorRole).skill(auditSkill).models(shared.sonnet);

const buildAndAudit = H.flow('build-and-audit')
  .input(z.object({ title: z.string(), description: z.string(), rounds: z.number() }))
  .use(plugins.gitWorktree())
  .resources(() => [sourceTree])
  .loop('round', {
    max: s => s.input.rounds,
    body: f =>
      f
        .step('build', builder, s => ({ title: s.input.title, description: s.input.description, round: s.round.iteration }))
        .when(s => s.build.needsOwner, b => b.halt('ownerDecision', ownerDecision, s => ({ question: s.build.question })))
        .step('audit', auditor, s => ({ title: s.input.title, summary: s.build.summary })),
    until: s => s.audit.deficits.length === 0,
  })
  .when(s => s.audit.deficits.length > 0, f => f.exit('unfinished'))
  .exit('shipped');

const linearKey = H.env('LINEAR_API_KEY');
const trackerStore = linear.store({
  apiKey: linearKey,
  team: 'CORE',
  schema: issue,
  states: { queued: 'Todo', building: 'In Progress', shipped: 'Done', declined: 'Canceled', stuck: 'Blocked' },
});

const bugs = H.lane('bugs')
  .of(bug)
  .from(
    linear.issues({ name: 'linear-bugs', apiKey: linearKey, team: 'CORE', labels: ['bug'], data: i => ({ title: i.title, description: i.description }) }),
    folder.files({ name: 'bug-folder', path: './bugs', glob: '*.md', data: f => ({ title: f.name, description: f.body }) }),
    manual('operator-bugs'),
  )
  .store(trackerStore)
  .handle(buildAndAudit, {
    input: u => ({ title: u.data.title, description: u.data.description, rounds: 3 }),
    exits: { shipped, unfinished: stuck },
    retry: { retries: 2, backoff: { initial: '5m', factor: 2 }, exhausted: stuck },
  })
  .wip(2);

const features = H.lane('features')
  .of(feature)
  .from(
    linear.issues({ name: 'linear-features', apiKey: linearKey, team: 'CORE', labels: ['feature'], data: i => ({ title: i.title, description: i.description }) }),
    manual('operator-features'),
  )
  .store(trackerStore)
  .handle(buildAndAudit, {
    input: u => ({ title: u.data.title, description: u.data.description, rounds: 5 }),
    exits: { shipped, unfinished: stuck },
    retry: { retries: 2, backoff: { initial: '5m', factor: 2 }, exhausted: stuck },
  });

const bugSuccess = H.metric('bug-success-by-model', H.events.transitions(bugs, { terminal: true }))
  .rate(e => e.verdict === 'success')
  .by('model')
  .window('14d');
const featureSuccess = H.metric('feature-success-by-model', H.events.transitions(features, { terminal: true }))
  .rate(e => e.verdict === 'success')
  .by('model')
  .window('14d');

const productExperience = H.journal('product-experience')
  .of(shared.experience)
  .store(jsonl.memory('./product/.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 6 }));

const productOrder = H.policy.units('bugs-then-features', ({ candidates, now }) => {
  const rank = (c: (typeof candidates)[number]) =>
    c.lane === features.name && now.getTime() - c.queuedAt.getTime() > 4 * 3_600_000 ? 0 : c.lane === bugs.name ? 1 : 2;
  return [...candidates].sort((a, b) => rank(a) - rank(b) || a.queuedAt.getTime() - b.queuedAt.getTime());
});

export const product = H.harness('product')
  .ledger(sqlite.ledger('./product/.harness/ledger.sqlite'))
  .pools(subscriptionPool(0.6))
  .lanes(bugs, features)
  .journals(tasteJournal, productExperience)
  .scheduler(productOrder)
  .grants(
    H.grant(
      claudeCode.client({ name: 'owner-on-product' }),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.resolve(ownerDecision),
      H.ops.memory.write(shared.taste),
      H.ops.telemetry.read,
      H.ops.accounts.manage,
    ),
  )
  .observe(observers.board({ path: './product/BOARD.md' }), observers.telemetry({ path: './product/TELEMETRY.md' }));

const draftPage = H.state('draft').pending();
const writing = H.state('writing').active();
const published = H.state('published').terminal('success');
const needsReview = H.state('needs-review').waiting();

const page = z.object({ title: z.string(), path: z.string(), body: z.string() });
const docPage = H.work('DocPage').schema(page).states(draftPage, writing, published, needsReview);

const docsRunner = runners.local({ name: 'docs-local', slots: 2 });

const writerRole = H.role('writer').prompt('Write clear, accurate documentation.').intents(['read', 'edit']).recall(shared.taste, shared.experience);
const writeSkill = H.skill('write-page')
  .input(z.object({ title: z.string(), body: z.string() }))
  .output(z.object({ body: z.string() }))
  .prompt(i => `Revise the page "${i.title}":\n\n${i.body}`);
const writer = H.seat('writer').role(writerRole).skill(writeSkill).models(shared.sonnet);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string(), body: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .runner(docsRunner)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['lychee', '--format', 'json', '-'], { stdin: input.body });
    return { broken: result.code === 0 ? [] : result.stdout.split('\n').filter(line => line.length > 0) };
  });

const writeDoc = H.flow('write-doc')
  .input(page)
  .step('write', writer, s => ({ title: s.input.title, body: s.input.body }))
  .step('links', linkCheck, s => ({ path: s.input.path, body: s.write.body }))
  .when(s => s.links.broken.length > 0, f => f.exit('brokenLinks'))
  .exit('published');

const docPages = H.lane('doc-pages')
  .of(docPage)
  .from(
    folder.files({
      name: 'doc-folder',
      path: './docs/pages',
      glob: '**/*.md',
      data: f => ({ title: String(f.frontmatter.title ?? f.name), path: f.path, body: f.body }),
    }),
  )
  .store(folder.store({ path: './docs/pages', schema: page }))
  .handle(writeDoc, {
    exits: { published, brokenLinks: needsReview },
    retry: { retries: 1, backoff: 'none', exhausted: needsReview },
  })
  .wip(2);

const docsExperience = H.journal('docs-experience')
  .of(shared.experience)
  .store(jsonl.memory('./docs/.harness/experience.jsonl'))
  .recall(policies.specificity({ limit: 6 }));

export const docs = H.harness('docs')
  .ledger(sqlite.ledger('./docs/.harness/ledger.sqlite'))
  .pools(subscriptionPool(0.3))
  .lanes(docPages)
  .journals(tasteJournal, docsExperience)
  .grants(
    H.grant(
      claudeCode.client({ name: 'owner-on-docs' }),
      H.ops.work.read,
      H.ops.work.write,
      H.ops.memory.write(shared.taste),
      H.ops.telemetry.read,
      H.ops.accounts.manage,
    ),
  )
  .observe(observers.board({ path: './docs/BOARD.md' }), observers.telemetry({ path: './docs/TELEMETRY.md' }));

export const start = {
  product: () => product.start(),
  docs: () => docs.start(),
};
