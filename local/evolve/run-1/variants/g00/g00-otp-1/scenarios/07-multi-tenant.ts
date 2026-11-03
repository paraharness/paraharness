import { z } from 'zod';
import { H, Model, ModelChoice, PolicyEnv } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';

export const sharedAccountState = sqlite.accountState('~/.harness/accounts.db');
export const max1 = claude.subscription('max-1', { credentials: H.env('CLAUDE_MAX_1') }).quotaIn(sharedAccountState);
export const max2 = claude.subscription('max-2', { credentials: H.env('CLAUDE_MAX_2') }).quotaIn(sharedAccountState);
export const max3 = claude.subscription('max-3', { credentials: H.env('CLAUDE_MAX_3') }).quotaIn(sharedAccountState);
export const ownerTaste = H.journal('owner-taste', H.memory.taste('owner-taste'))
  .store(jsonl.memory('~/.harness/owner-taste.jsonl'))
  .recall(H.policy.specificity({ limit: 20 }));
export const sonnet = claude.model('sonnet');
export const opus = claude.model('opus');

const productPool = H.pool('product-claude')
  .accounts(max1, max2, max3)
  .share(max1, 0.6)
  .share(max2, 0.6)
  .share(max3, 0.6)
  .order(H.policy.soonestReset());
const docsPool = H.pool('docs-claude')
  .accounts(max1, max2, max3)
  .share(max1, 0.3)
  .share(max2, 0.3)
  .share(max3, 0.3)
  .order(H.policy.soonestReset());

const accountsGrant = (name: string) =>
  H.grant(
    name,
    H.op.readWork,
    H.op.createWork,
    H.op.updateWork,
    H.op.cancelWork,
    H.op.resolveBlocker,
    H.op.writeMemory,
    H.op.readTelemetry,
    H.op.setAccountShare,
  );

const Todo = H.state('todo', 'pending');
const InProgress = H.state('in-progress', 'active');
const Done = H.state('done', 'succeeded');
const Stuck = H.state('stuck', 'failed');
const Dropped = H.state('dropped', 'cancelled');

const TicketSchema = z.object({ ref: z.string(), title: z.string(), description: z.string() });
type TicketData = z.infer<typeof TicketSchema>;
const Bug = H.work('Bug', TicketSchema).states(Todo, InProgress, Done, Stuck, Dropped).key(bug => bug.ref);
const Feature = H.work('Feature', TicketSchema).states(Todo, InProgress, Done, Stuck, Dropped).key(feature => feature.ref);

const productTree = H.resource('product-source');
const productExperience = H.journal('product-experience', H.memory.experience('product-experience'))
  .store(jsonl.memory('.harness/experience.jsonl'))
  .recall(H.policy.specificity({ limit: 12, trackRecord: true }));

const builderModel = H.policy('builder-model', (choice: ModelChoice, env: PolicyEnv): Model => {
  const cheaper = env.metrics.successRate({ kind: choice.kind, model: sonnet, sinceDays: 14 });
  if (cheaper.samples < 20 || cheaper.rate === null) return sonnet;
  return cheaper.rate < 0.85 ? opus : sonnet;
});

const builder = H.agent('builder', H.role('builder').intents('read', 'edit', 'execute', 'search', 'halt').skills('typescript'))
  .model(builderModel)
  .pool(productPool)
  .recall(productExperience, ownerTaste)
  .guards(H.guard.lease(productTree), H.guard.stopCheck(H.command('project-checks').run(() => ['npm', 'run', 'check'])));
const auditor = H.agent('auditor', H.role('auditor').intents('read', 'search', 'execute'))
  .model(opus)
  .pool(productPool)
  .recall(productExperience)
  .record(productExperience)
  .output(z.object({ deficits: z.array(z.string()) }));

const deliver = H.flow<TicketData>('build-and-audit')
  .params(z.object({ maxRounds: z.number() }))
  .exits('clean', 'exhausted')
  .repeat(
    'rounds',
    round => round
      .call('build', builder, ctx => `Round ${ctx.round}: ${ctx.unit.data.title}\n\n${ctx.unit.data.description}`)
      .call('audit', auditor, ctx => `Audit against: ${ctx.unit.data.title}\n\n${ctx.steps.build}`),
    { max: ctx => ctx.params.maxRounds, until: ctx => ctx.steps.audit.deficits.length === 0 },
  )
  .exit(ctx => (ctx.steps.audit.deficits.length === 0 ? 'clean' : 'exhausted'));

const tracker = (label: string) =>
  linear.tracker<TicketData>({
    team: 'ENG',
    apiKey: H.env('LINEAR_API_KEY'),
    labels: [label],
    map: issue => ({ ref: issue.identifier, title: issue.title, description: issue.description }),
    patch: (_ticket, state) => ({ state }),
  });
const linearBugs = tracker('bug');
const linearFeatures = tracker('feature');
const productWorktrees = git.worktrees('product-worktrees', { repo: '.', base: 'main', resource: productTree });

const bugLane = H.lane(Bug)
  .supply(linearBugs, H.supply.operator())
  .store(linearBugs)
  .handler(deliver, { maxRounds: 3 })
  .exits({ clean: Done, exhausted: Stuck, crashed: Stuck })
  .phases({ rounds: InProgress })
  .runner(productWorktrees);
const featureLane = H.lane(Feature)
  .supply(linearFeatures, H.supply.operator())
  .store(linearFeatures)
  .handler(deliver, { maxRounds: 5 })
  .exits({ clean: Done, exhausted: Stuck, crashed: Stuck })
  .phases({ rounds: InProgress })
  .runner(productWorktrees);

export const product = H.harness('product')
  .ledger(sqlite.ledger('.harness/product-ledger.db'))
  .lanes(bugLane, featureLane)
  .scheduler(H.scheduler('product').wip(bugLane, 2))
  .clients(http.server({ grant: accountsGrant('product-owner'), port: H.slot.port(7401), token: H.env('PRODUCT_CONTROL_TOKEN') }))
  .observe(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

const Stale = H.state('stale', 'pending');
const Writing = H.state('writing', 'active');
const Checking = H.state('checking-links', 'active');
const Published = H.state('published', 'succeeded');
const BrokenLinks = H.state('broken-links', 'failed');
const Withdrawn = H.state('withdrawn', 'cancelled');

const DocSchema = z.object({ path: z.string(), title: z.string(), body: z.string() });
type DocData = z.infer<typeof DocSchema>;
const DocPage = H.work('DocPage', DocSchema)
  .states(Stale, Writing, Checking, Published, BrokenLinks, Withdrawn)
  .key(page => page.path);

const docsFolder = folder.markdown<DocData>({
  dir: 'docs',
  map: file => ({ path: file.path, title: String(file.frontmatter.title ?? file.path), body: file.body }),
  frontmatter: (page, state) => ({ title: page.title, status: state }),
});
const docsExperience = H.journal('docs-experience', H.memory.experience('docs-experience'))
  .store(jsonl.memory('.harness/experience.jsonl'))
  .recall(H.policy.specificity({ limit: 10, trackRecord: true }));

const writer = H.agent('writer', H.role('writer').intents('read', 'edit').instructions('Bring the page up to date and keep it concise.'))
  .model(sonnet)
  .pool(docsPool)
  .recall(docsExperience, ownerTaste)
  .record(docsExperience);
const linkCheck = H.command('link-check').run((input: { path: string }) => ['lychee', '--offline', input.path]);

const writePage = H.flow<DocData>('write-page')
  .exits('published', 'broken')
  .call('write', writer, ctx => `Update ${ctx.unit.data.path}: ${ctx.unit.data.title}\n\n${ctx.unit.data.body}`)
  .call('linkCheck', linkCheck, ctx => ({ path: ctx.unit.data.path }), { onFailure: { exit: 'broken' } })
  .exit('published');

const docLane = H.lane(DocPage)
  .supply(docsFolder)
  .store(docsFolder)
  .handler(writePage)
  .exits({ published: Published, broken: BrokenLinks, crashed: BrokenLinks })
  .phases({ write: Writing, linkCheck: Checking })
  .runner(local.runner('docs-local'));

export const documentation = H.harness('documentation')
  .ledger(sqlite.ledger('.harness/docs-ledger.db'))
  .lanes(docLane)
  .clients(http.server({ grant: accountsGrant('docs-owner'), port: H.slot.port(7402), token: H.env('DOCS_CONTROL_TOKEN') }))
  .observe(markdown.board({ path: 'BOARD.md' }));

export const ownerSession = claude.supervisor({ endpoints: ['http://127.0.0.1:7401', 'http://127.0.0.1:7402'] });

void product.start();
void documentation.start();
