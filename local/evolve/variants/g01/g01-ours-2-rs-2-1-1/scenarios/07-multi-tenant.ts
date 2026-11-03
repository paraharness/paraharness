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

const sharedQuota = sqlite.quota('~/.harness/shared-quota.sqlite');

const maxOne = H.account('claude-max-1', claudeCode.driver({ configDir: '~/.claude-max-1' })).quota(sharedQuota);
const maxTwo = H.account('claude-max-2', claudeCode.driver({ configDir: '~/.claude-max-2' })).quota(sharedQuota);
const maxThree = H.account('claude-max-3', claudeCode.driver({ configDir: '~/.claude-max-3' })).quota(sharedQuota);

const sonnet = H.model('claude-sonnet-4-5').pricing(anthropic.pricing());
const opus = H.model('claude-opus-4-1').pricing(anthropic.pricing());

const taste = H.memory('taste').content(z.object({ rule: z.string() })).trust('taste');
const sharedTaste = H.journal('owner-taste').of(taste).store(jsonl.memory('~/.harness/taste.jsonl')).recall(policies.specificity({ limit: 8 }));

const owner = claudeCode.client({ name: 'owner-supervisor' });

const ticketSchema = z.object({ title: z.string(), body: z.string() });
const queued = H.state('queued').pending();
const done = H.state('done').terminal('success');
const abandoned = H.state('abandoned').terminal('failure');
const bug = H.work('Bug').schema(ticketSchema).states(queued, done, abandoned);
const feature = H.work('Feature').schema(ticketSchema).states(queued, done, abandoned);

const codingExperience = H.memory('coding-experience').content(z.object({ rule: z.string() })).trust('experience');
const codingExperienceJournal = H.journal('coding-experience-journal').of(codingExperience).store(jsonl.memory('./coding/.harness/experience.jsonl')).recall(policies.specificity({ limit: 8 }));

const codingRunner = runners.local({ name: 'coding-local', slots: 4 });
const sourceArea = H.resource('source');

const projectChecks = H.command('project-checks')
  .input(z.object({ workspace: z.string() }))
  .output(z.object({ ok: z.boolean(), report: z.string() }))
  .runner(codingRunner)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['npm', 'run', 'check'], { cwd: input.workspace });
    return { ok: result.code === 0, report: result.stdout + result.stderr };
  });

const builderRole = H.role('builder')
  .prompt('Implement the task in the worktree; stop only when the checks pass.')
  .intents(['read', 'edit', 'shell'])
  .recall(taste, codingExperience)
  .use(plugins.fileLeaseGuard().area(sourceArea, ['src/**', 'test/**']), plugins.stopCheck(projectChecks));
const auditorRole = H.role('auditor')
  .prompt('List every deficit in the change; record lessons as experience.')
  .intents(['read'])
  .recall(codingExperience)
  .record(codingExperience);

const buildSkill = H.skill('build').input(z.object({ task: z.string(), round: z.number() })).output(z.object({ summary: z.string() }));
const auditSkill = H.skill('audit').input(z.object({ summary: z.string() })).output(z.object({ deficits: z.array(z.string()) }));

const builderSuccess = H.metric('builder-success', H.events.attempts()).rate(e => e.outcome === 'succeeded').by('model', 'kind').window('14d');
const cheapUntilWorse = H.policy.models('cheap-until-worse', choice => {
  const kind = choice.unit.kind === feature.name ? feature : bug;
  const cheap = choice.metrics.read(builderSuccess, sonnet, kind);
  const cheapIsWorse = cheap.samples >= 20 && cheap.value !== undefined && cheap.value < 0.85;
  return cheapIsWorse ? [opus, sonnet] : [sonnet, opus];
});

const builder = H.seat('builder').role(builderRole).skill(buildSkill).models(sonnet, opus).policy(cheapUntilWorse);
const auditor = H.seat('auditor').role(auditorRole).skill(auditSkill).models(opus);

const buildAndAudit = H.flow('build-and-audit')
  .input(ticketSchema.extend({ rounds: z.number() }))
  .use(plugins.gitWorktree())
  .loop('round', {
    max: s => s.input.rounds,
    body: f => f
      .step('build', builder, s => ({ task: `${s.input.title}\n\n${s.input.body}`, round: s.round.iteration }))
      .step('audit', auditor, s => ({ summary: s.build.summary })),
    until: s => s.audit.deficits.length === 0,
  })
  .when(s => s.audit.deficits.length > 0, f => f.exit('unfinished'))
  .exit('done');

const linearKey = H.env('LINEAR_API_KEY');
const ticketStore = linear.store({ apiKey: linearKey, team: 'ENG', schema: ticketSchema, states: { queued: 'Todo', done: 'Done', abandoned: 'Canceled' } });

const bugs = H.lane('bugs').of(bug)
  .from(
    linear.issues({ name: 'linear-bugs', apiKey: linearKey, team: 'ENG', labels: ['bug'], data: issue => ({ title: issue.title, body: issue.description }) }),
    folder.files({ name: 'bug-folder', path: './coding/bugs', glob: '*.md', data: file => ({ title: file.name, body: file.body }) }),
    manual('operator-bugs'),
  )
  .store(ticketStore)
  .handle(buildAndAudit, { input: unit => ({ ...unit.data, rounds: 3 }), exits: { done, unfinished: abandoned }, retry: { retries: 2, exhausted: abandoned } })
  .wip(2);

const features = H.lane('features').of(feature)
  .from(
    linear.issues({ name: 'linear-features', apiKey: linearKey, team: 'ENG', labels: ['feature'], data: issue => ({ title: issue.title, body: issue.description }) }),
    manual('operator-features'),
  )
  .store(ticketStore)
  .handle(buildAndAudit, { input: unit => ({ ...unit.data, rounds: 5 }), exits: { done, unfinished: abandoned }, retry: { retries: 2, exhausted: abandoned } });

const codingPool = H.pool('coding-pool', [maxOne, maxTwo, maxThree])
  .share(maxOne, 0.6)
  .share(maxTwo, 0.6)
  .share(maxThree, 0.6)
  .serves(sonnet, opus)
  .policy(policies.soonestReset());

const codingOrder = H.policy.units('bugs-before-features', choice =>
  [...choice.candidates].sort((a, b) => (a.lane === bugs.name ? 0 : 1) - (b.lane === bugs.name ? 0 : 1) || a.queuedAt.getTime() - b.queuedAt.getTime()),
);

export const coding = H.harness('coding')
  .ledger(sqlite.ledger('./coding/.harness/ledger.sqlite'))
  .pools(codingPool)
  .lanes(bugs, features)
  .journals(sharedTaste, codingExperienceJournal)
  .scheduler(codingOrder)
  .grants(H.grant(owner, H.ops.work.read, H.ops.work.write, H.ops.attempts.manage, H.ops.memory.write(taste), H.ops.telemetry.read, H.ops.accounts.manage))
  .observe(observers.board({ path: './coding/BOARD.md' }), observers.telemetry({ path: './coding/TELEMETRY.md' }));

const docSchema = z.object({ title: z.string(), body: z.string() });
const draftPage = H.state('draft').pending();
const published = H.state('published').terminal('success');
const brokenLinks = H.state('broken-links').terminal('failure');
const docPage = H.work('DocPage').schema(docSchema).states(draftPage, published, brokenLinks);

const docExperience = H.memory('doc-experience').content(z.object({ rule: z.string() })).trust('experience');
const docExperienceJournal = H.journal('doc-experience-journal').of(docExperience).store(jsonl.memory('./docs/.harness/experience.jsonl')).recall(policies.specificity({ limit: 6 }));

const writerRole = H.role('writer').prompt('Rewrite the page for clarity; keep every link.').intents(['read']).recall(taste, docExperience);
const writeSkill = H.skill('write-page').input(docSchema).output(z.object({ body: z.string() }));
const writer = H.seat('writer').role(writerRole).skill(writeSkill).models(sonnet);

const docsRunner = runners.local({ name: 'docs-local', slots: 2 });
const linkCheck = H.command('link-check')
  .input(z.object({ body: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .runner(docsRunner)
  .effect('repeatable')
  .run(async (input, ctx) => {
    const result = await ctx.exec(['link-check', '--stdin'], { stdin: input.body });
    return { broken: result.stdout.split('\n').filter(line => line.trim() !== '') };
  });

const writePage = H.flow('write-page')
  .input(docSchema)
  .step('write', writer, s => s.input)
  .step('links', linkCheck, s => ({ body: s.write.body }))
  .when(s => s.links.broken.length > 0, f => f.exit('broken'))
  .exit('published');

const pages = H.lane('pages').of(docPage)
  .from(folder.files({ name: 'doc-folder', path: './docs/pages', glob: '**/*.md', data: file => ({ title: String(file.frontmatter.title ?? file.name), body: file.body }) }))
  .store(folder.store({ path: './docs/pages', schema: docSchema }))
  .handle(writePage, { exits: { published, broken: brokenLinks }, retry: { retries: 1, exhausted: brokenLinks } })
  .wip(2);

const docsPool = H.pool('docs-pool', [maxOne, maxTwo, maxThree])
  .share(maxOne, 0.3)
  .share(maxTwo, 0.3)
  .share(maxThree, 0.3)
  .serves(sonnet)
  .policy(policies.soonestReset());

const docsOrder = H.policy.units('oldest-first', choice => [...choice.candidates].sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime()));

export const docs = H.harness('docs')
  .ledger(sqlite.ledger('./docs/.harness/ledger.sqlite'))
  .pools(docsPool)
  .lanes(pages)
  .journals(sharedTaste, docExperienceJournal)
  .scheduler(docsOrder)
  .grants(H.grant(owner, H.ops.work.read, H.ops.work.write, H.ops.attempts.manage, H.ops.memory.write(taste), H.ops.telemetry.read, H.ops.accounts.manage))
  .observe(observers.board({ path: './docs/BOARD.md' }));
