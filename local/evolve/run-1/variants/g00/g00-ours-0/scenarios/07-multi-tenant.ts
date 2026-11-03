import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { linear } from 'harness-dsl/linear';
import type { LinearIssue } from 'harness-dsl/linear';
import { folder } from 'harness-dsl/folder';
import type { MarkdownFile } from 'harness-dsl/folder';
import { manual } from 'harness-dsl/supply';
import { drainSoonestExpiring, byApplicability } from 'harness-dsl/policies';
import { board, telemetry } from 'harness-dsl/observers';
import { fileLeaseGuard, gitWorktreeIsolation, stopCommandHook } from 'harness-dsl/plugins';
import { local } from 'harness-dsl/local';

const sharedAccountQuota = sqlite.ledger('~/.harness-dsl/accounts.db');

const max1 = H.account('claude-max-1', claudeCode.driver({ configDir: '~/.claude-max-1' })).ledger(sharedAccountQuota);
const max2 = H.account('claude-max-2', claudeCode.driver({ configDir: '~/.claude-max-2' })).ledger(sharedAccountQuota);
const max3 = H.account('claude-max-3', claudeCode.driver({ configDir: '~/.claude-max-3' })).ledger(sharedAccountQuota);

const Taste = H.memory('taste').content(z.object({ prefer: z.string(), over: z.string() }));
const Experience = H.memory('experience').content(
  z.object({ do: z.string(), when: z.string(), because: z.string() }),
);

const ownerTaste = H.journal('owner-taste')
  .of(Taste)
  .store(jsonl.store('~/.harness-dsl/taste.jsonl'))
  .recall(byApplicability({ budgetTokens: 1000 }));

const Todo = H.state('todo').pending();
const Working = H.state('working').active();
const Done = H.state('done').succeeded();
const Abandoned = H.state('abandoned').failed();
const Cancelled = H.state('cancelled').cancelled();

const ticket = z.object({ title: z.string(), description: z.string(), files: z.array(z.string()) });
type Ticket = z.infer<typeof ticket>;

const Bug = H.work('bug').schema(ticket).states(Todo, Working, Done, Abandoned, Cancelled).resources(t => t.files);
const Feature = H.work('feature').schema(ticket).states(Todo, Working, Done, Abandoned, Cancelled).resources(t => t.files);

const codingExperience = H.journal('coding-experience')
  .of(Experience)
  .store(jsonl.store('coding/.harness/experience.jsonl'))
  .recall(byApplicability({ budgetTokens: 2000 }));

const codingApi = H.account('anthropic-api', anthropic.api({ apiKey: H.env('ANTHROPIC_API_KEY') }));
const codingSubscriptions = H.pool('coding-subscriptions', [max1, max2, max3])
  .policy(drainSoonestExpiring())
  .maxShare(max1, 0.6)
  .maxShare(max2, 0.6)
  .maxShare(max3, 0.6)
  .fallback(codingApi);

const codingSonnet = H.model('coding-sonnet', codingSubscriptions, 'claude-sonnet-4-5');
const codingOpus = H.model('coding-opus', codingSubscriptions, 'claude-opus-4-1');

const builderModels = H.pool('builder-models', [codingSonnet, codingOpus]).policy(
  H.policy.choose('cheaper-until-unreliable', ctx => {
    const cheaper = ctx.metrics.outcomes({ kind: ctx.unit?.kind, model: codingSonnet.name, window: '14d' });
    const unreliable = cheaper.samples >= 20 && cheaper.successRate !== null && cheaper.successRate < 0.85;
    const preferred = unreliable ? codingOpus.name : codingSonnet.name;
    return [...ctx.candidates].sort((a, b) => Number(b.name === preferred) - Number(a.name === preferred));
  }),
);

const builder = H.agent('builder')
  .role(
    H.role('builder')
      .prompt('Implement the work item completely.')
      .tools('read-files', 'edit-files', 'run-commands', 'halt-for-decision')
      .recall(Experience, Taste)
      .use(
        gitWorktreeIsolation({ root: 'coding/.worktrees', baseBranch: 'main' }),
        fileLeaseGuard(),
        stopCommandHook('npm run check', { timeoutMs: 600000 }),
      ),
  )
  .model(builderModels);
const auditor = H.agent('auditor')
  .role(
    H.role('auditor')
      .prompt('List every deficit between the work item and the change.')
      .tools('read-files', 'run-commands', 'record-memory')
      .recall(Experience)
      .record(Experience),
  )
  .model(codingOpus);

const build = H.skill('build')
  .input(z.object({ title: z.string(), description: z.string(), deficits: z.array(z.string()) }))
  .prompt(work => `${work.title}\n\n${work.description}\n\nOpen deficits:\n${work.deficits.join('\n')}`);
const audit = H.skill('audit')
  .input(z.object({ title: z.string(), description: z.string(), buildReport: z.string() }))
  .output(z.object({ deficits: z.array(z.string()) }))
  .prompt(work => `${work.title}\n\n${work.description}\n\n${work.buildReport}`);

type Review = { readonly deficits: readonly string[] };
const noDeficits: Review = { deficits: [] };

const buildAndAudit = H.flow('build-and-audit')
  .for(Bug, Feature)
  .settings(z.object({ maxRounds: z.number().int().positive() }))
  .transition(Working)
  .map((): Review => noDeficits)
  .loop({
    maxIterations: ctx => ctx.settings.maxRounds,
    body: round =>
      round
        .step('build', build.by(builder), {
          input: (review, ctx) => ({
            title: ctx.unit.data.title,
            description: ctx.unit.data.description,
            deficits: [...review.deficits],
          }),
        })
        .step('audit', audit.by(auditor), {
          input: (buildReport, ctx) => ({
            title: ctx.unit.data.title,
            description: ctx.unit.data.description,
            buildReport,
          }),
        })
        .map((found): Review => found),
    until: review => review.deficits.length === 0,
  })
  .transition(review => (review.deficits.length === 0 ? Done : Abandoned))
  .onError(Abandoned);

const linearKey = H.env('LINEAR_API_KEY');
const trackerStates = { todo: 'Todo', working: 'In Progress', done: 'Done', abandoned: 'Canceled', cancelled: 'Canceled' };
const ticketFromIssue = (issue: LinearIssue): Ticket => ({ title: issue.title, description: issue.description, files: [] });

const bugs = H.lane('bugs')
  .of(Bug)
  .from(
    linear.supply<Ticket>({ apiKey: linearKey, team: 'ENG', labels: ['bug'], map: ticketFromIssue }),
    folder.supply<Ticket>({ path: 'coding/inbox/bugs', map: file => ({ title: file.name, description: file.body, files: [] }) }),
    manual<Ticket>(),
  )
  .store(linear.store<Ticket>({ apiKey: linearKey, team: 'ENG', map: ticketFromIssue, states: trackerStates }))
  .handle(buildAndAudit, { maxRounds: 3 })
  .wip(2);

const features = H.lane('features')
  .of(Feature)
  .from(
    linear.supply<Ticket>({ apiKey: linearKey, team: 'ENG', labels: ['feature'], map: ticketFromIssue }),
    manual<Ticket>(),
  )
  .store(linear.store<Ticket>({ apiKey: linearKey, team: 'ENG', map: ticketFromIssue, states: trackerStates }))
  .handle(buildAndAudit, { maxRounds: 5 });

const codingScheduler = H.scheduler('coding')
  .concurrency(3)
  .policy(
    H.policy.schedule('bugs-before-features', ctx => ({
      start: [...ctx.pending].sort(
        (a, b) =>
          Number(a.lane !== bugs.name) - Number(b.lane !== bugs.name) ||
          a.enqueuedAt.getTime() - b.enqueuedAt.getTime(),
      ),
    })),
  );

const ownerGrants = [
  H.ops.work.read,
  H.ops.work.write,
  H.ops.blockers.resolve,
  H.ops.memory.write,
  H.ops.telemetry.read,
  H.ops.accounts.manage,
];

export const codingHarness = H.harness('coding-team')
  .ledger(sqlite.ledger('coding/.harness/ledger.db'))
  .lanes(bugs, features)
  .journals(ownerTaste, codingExperience)
  .scheduler(codingScheduler)
  .supervisor(H.supervisor('owner-coding').client(claudeCode.client({ port: 7401 })).grant(...ownerGrants))
  .observe(board('coding/BOARD.md'), telemetry('coding/TELEMETRY.md'));

const docPage = z.object({ path: z.string(), title: z.string(), body: z.string() });
type DocPageData = z.infer<typeof docPage>;

const PageQueued = H.state('page-queued').pending();
const Writing = H.state('writing').active();
const Published = H.state('published').succeeded();
const LinksBroken = H.state('links-broken').failed();

const DocPage = H.work('doc-page')
  .schema(docPage)
  .states(PageQueued, Writing, Published, LinksBroken)
  .resources(page => [page.path]);

const docsExperience = H.journal('docs-experience')
  .of(Experience)
  .store(jsonl.store('docs/.harness/experience.jsonl'))
  .recall(byApplicability({ budgetTokens: 1500 }));

const docsSubscriptions = H.pool('docs-subscriptions', [max1, max2, max3])
  .policy(drainSoonestExpiring())
  .maxShare(max1, 0.3)
  .maxShare(max2, 0.3)
  .maxShare(max3, 0.3);
const docsSonnet = H.model('docs-sonnet', docsSubscriptions, 'claude-sonnet-4-5');

const writer = H.agent('writer')
  .role(
    H.role('writer')
      .prompt('Rewrite the documentation page so it is accurate, complete and in house style.')
      .tools('read-files')
      .recall(Taste, Experience)
      .record(Experience),
  )
  .model(docsSonnet);

const writePage = H.skill('write-page')
  .input(docPage)
  .output(z.object({ body: z.string() }))
  .prompt(page => `# ${page.title}\n\n${page.body}`);

const docsRunner = H.runner('docs-local', local()).slots(2);

const linkCheck = H.command('link-check')
  .input(z.object({ path: z.string() }))
  .output(z.object({ broken: z.array(z.string()) }))
  .runner(docsRunner)
  .run(async ({ input, exec }) => {
    const result = await exec(`markdown-link-check --quiet ${JSON.stringify(input.path)}`);
    return {
      broken: result.exitCode === 0 ? [] : result.stdout.split('\n').filter(line => line.includes('✖')),
    };
  });

const writeAndCheck = H.flow('write-and-check')
  .for(DocPage)
  .transition(Writing)
  .step('write', writePage.by(writer))
  .patch(written => ({ body: written.body }))
  .step('link-check', linkCheck, { input: (_, ctx) => ({ path: ctx.unit.data.path }) })
  .transition(check => (check.broken.length === 0 ? Published : LinksBroken))
  .onError(LinksBroken);

const pageFromFile = (file: MarkdownFile): DocPageData => {
  const title = file.frontmatter['title'];
  return { path: file.path, title: typeof title === 'string' ? title : file.name, body: file.body };
};

const docPages = H.lane('doc-pages')
  .of(DocPage)
  .from(folder.supply<DocPageData>({ path: 'docs/pages', map: pageFromFile }))
  .store(
    folder.store<DocPageData>({
      path: 'docs/pages',
      map: pageFromFile,
      frontmatter: page => ({ title: page.title }),
    }),
  )
  .handle(writeAndCheck);

const docsScheduler = H.scheduler('docs')
  .concurrency(2)
  .policy(
    H.policy.schedule('oldest-first', ctx => ({
      start: [...ctx.pending].sort((a, b) => a.enqueuedAt.getTime() - b.enqueuedAt.getTime()),
    })),
  );

export const docsHarness = H.harness('documentation')
  .ledger(sqlite.ledger('docs/.harness/ledger.db'))
  .lanes(docPages)
  .journals(ownerTaste, docsExperience)
  .scheduler(docsScheduler)
  .supervisor(H.supervisor('owner-docs').client(claudeCode.client({ port: 7402 })).grant(...ownerGrants))
  .observe(board('docs/BOARD.md'), telemetry('docs/TELEMETRY.md'));

export const runningCoding = codingHarness.start();
export const runningDocs = docsHarness.start();
