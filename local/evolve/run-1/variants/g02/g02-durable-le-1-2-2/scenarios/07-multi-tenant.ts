import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as markdown from 'harness-dsl/markdown';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';

const sharedQuotaPartition = '/home/owner/.harness/shared-quota.sqlite';

const maxOne = claudeCode.subscription('max-1', { configDir: H.env('CLAUDE_MAX_1_DIR') });
const maxTwo = claudeCode.subscription('max-2', { configDir: H.env('CLAUDE_MAX_2_DIR') });
const maxThree = claudeCode.subscription('max-3', { configDir: H.env('CLAUDE_MAX_3_DIR') });
const apiFallback = anthropic.account('api-fallback', { apiKey: H.env('ANTHROPIC_API_KEY') });

const soonestExpiring = H.policy.account('soonest-expiring', (c) =>
  [...c.eligible].sort((a, b) => a.windowEndsAt - b.windowEndsAt)[0] ?? null,
);

const mostSpecificFirst = H.policy.recall('most-specific-first', (c) =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

const OwnerTaste = H.memory.taste('owner-taste');
const ownerTaste = H.journal('owner-taste', OwnerTaste)
  .store(jsonl.memory('/home/owner/.harness/taste.jsonl'))
  .recall(mostSpecificFirst);

const sonnet = claudeCode.model('claude-sonnet-4-5');
const opus = claudeCode.model('claude-opus-4-1');

const ownerOperations = [
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.resolveBlocks,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
];

const Backlog = H.state('Backlog', 'pending');
const Building = H.state('Building', 'active');
const Auditing = H.state('Auditing', 'active');
const Planning = H.state('Planning', 'active');
const Delivering = H.state('Delivering', 'active');
const Done = H.state('Done', 'terminal', 'success');
const Abandoned = H.state('Abandoned', 'terminal', 'failure');
const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.state('Healthy', 'terminal', 'success');
const Unhealthy = H.state('Unhealthy', 'terminal', 'failure');

const workAttributes = { source: z.string(), ref: z.string(), priority: z.number() };
const workFields = { title: z.string(), description: z.string() };

const Bug = H.work('Bug')
  .attributes(workAttributes)
  .fields(workFields)
  .states([Backlog, Building, Auditing, Done, Abandoned])
  .key((u) => `${u.attributes.source}:${u.attributes.ref}`);
const Feature = H.work('Feature')
  .attributes(workAttributes)
  .fields(workFields)
  .states([Backlog, Building, Auditing, Done, Abandoned])
  .key((u) => `${u.attributes.source}:${u.attributes.ref}`);
const Epic = H.work('Epic')
  .attributes({ ref: z.string() })
  .fields(workFields)
  .states([Backlog, Planning, Delivering, Done, Abandoned])
  .key((u) => u.attributes.ref);
const ServiceHeartbeat = H.work('ServiceHeartbeat')
  .attributes({ service: z.string() })
  .states([Due, Probing, Healthy, Unhealthy])
  .fails(Unhealthy)
  .key((u) => u.attributes.service);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'ask'])
  .instructions('Implement the work item. Resolve every listed deficit. Ask the owner when a product decision is needed.')
  .input({ title: z.string(), description: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });
const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'remember'])
  .instructions('Audit the change against the work item. List every remaining deficit; list none when the work is complete.')
  .input({ title: z.string(), description: z.string(), summary: z.string() })
  .output({ deficits: z.array(z.string()) });
const plannerRole = H.role('planner')
  .intents(['read'])
  .instructions('Decompose the epic into independently shippable features.')
  .input({ title: z.string(), description: z.string() })
  .output({ features: z.array(z.object(workFields)) });

const ProductExperience = H.memory.experience('product-experience');
const productExperience = H.journal('product-experience', ProductExperience)
  .store(jsonl.memory('product/.harness/experience.jsonl'))
  .recall(mostSpecificFirst);

const productPool = H.pool('product-pool')
  .accounts([
    { account: maxOne, share: 0.6 },
    { account: maxTwo, share: 0.6 },
    { account: maxThree, share: 0.6 },
  ])
  .prefer(soonestExpiring)
  .fallback(apiFallback);

const cheaperUntilItSlips = H.policy.model('cheaper-until-it-slips', [sonnet, opus], (c) => {
  const record = c.metrics.success({ kind: c.kind, model: sonnet, window: { days: 14 } });
  return record.n >= 20 && record.rate !== null && record.rate < 0.85 ? opus : sonnet;
});

const projectChecks = H.command('project-checks', ['npm', 'run', 'check']);

const builder = H.agent('builder', builderRole)
  .model(cheaperUntilItSlips)
  .pool(productPool)
  .recalls([productExperience, ownerTaste])
  .leaseWrites()
  .mustPass(projectChecks);
const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .pool(productPool)
  .recalls([productExperience])
  .records(productExperience);
const planner = H.agent('planner', plannerRole)
  .model(opus)
  .pool(productPool)
  .recalls([ownerTaste]);

const buildAndAudit = H.flow('build-and-audit')
  .requires(workFields)
  .params({ rounds: z.number() })
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: (c) => c.params.rounds },
    (round) =>
      round
        .mark('building')
        .step('build', builder, (c) => ({
          title: c.input.title,
          description: c.input.description,
          deficits: c.carry?.deficits ?? [],
        }))
        .mark('auditing')
        .step('audit', auditor, (c) => ({ title: c.input.title, description: c.input.description, summary: c.out.build.summary })),
    (last) => (last.audit.deficits.length > 0 ? { deficits: last.audit.deficits } : null),
  )
  .exit('abandoned', (c) => c.out.rounds.exhausted)
  .ends(['done'], () => 'done');

const decomposeEpic = H.flow('decompose-epic')
  .requires(workFields)
  .step('plan', planner, (c) => ({ title: c.input.title, description: c.input.description }))
  .mark('delivering')
  .spawn('features', { outlet: 'feature', child: workFields, items: (c) => c.out.plan.features })
  .ends(['done', 'abandoned'], (c) => (c.out.features.every((f) => f.verdict === 'success') ? 'done' : 'abandoned'));

const heartbeatProbe = H.command('service-heartbeat', ['./bin/heartbeat']);

const probeService = H.flow('probe-service')
  .requires({ service: z.string() })
  .step('probe', heartbeatProbe, (c) => ({ args: [c.input.service] }), { timeoutMs: 30000 })
  .ends(['healthy'], () => 'healthy');

const linearKey = H.env('LINEAR_API_KEY');
const trackerStatus = { Backlog: 'Todo', Building: 'In Progress', Auditing: 'In Review', Planning: 'In Progress', Delivering: 'In Progress', Done: 'Done', Abandoned: 'Canceled' };
const worktrees = git.worktree({ repo: 'product', base: 'main', slots: 3 });
const services = ['api', 'billing', 'search'];

const bugs = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { apiKey: linearKey, team: 'ENG', labels: ['bug'] }, (issue, to) =>
      to.create({
        attributes: { source: 'linear', ref: issue.identifier, priority: issue.priority },
        fields: { title: issue.title, description: issue.description },
      }),
    ),
    folder.files(Bug, 'product/bugs', (file, to) =>
      to.create({
        attributes: { source: 'folder', ref: file.path, priority: 3 },
        fields: { title: String(file.frontmatter['title'] ?? file.path), description: file.body },
      }),
    ),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { apiKey: linearKey, team: 'ENG', status: trackerStatus }))
  .runner(worktrees)
  .wip(2)
  .handler(buildAndAudit, {
    ends: { done: Done, abandoned: Abandoned },
    marks: { building: Building, auditing: Auditing },
    params: { rounds: 3 },
  });

const features = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { apiKey: linearKey, team: 'ENG', labels: ['feature'] }, (issue, to) =>
      to.create({
        attributes: { source: 'linear', ref: issue.identifier, priority: issue.priority },
        fields: { title: issue.title, description: issue.description },
      }),
    ),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { apiKey: linearKey, team: 'ENG', status: trackerStatus }))
  .runner(worktrees)
  .handler(buildAndAudit, {
    ends: { done: Done, abandoned: Abandoned },
    marks: { building: Building, auditing: Auditing },
    params: { rounds: 5 },
  });

const epics = H.lane('epics', Epic)
  .supply([
    linear.issues(Epic, { apiKey: linearKey, team: 'ENG', labels: ['epic'] }, (issue, to) =>
      to.create({ attributes: { ref: issue.identifier }, fields: { title: issue.title, description: issue.description } }),
    ),
  ])
  .store(linear.store(Epic, { apiKey: linearKey, team: 'ENG', status: trackerStatus }))
  .wip(1)
  .handler(decomposeEpic, {
    ends: { done: Done, abandoned: Abandoned },
    marks: { delivering: Delivering },
    spawns: {
      feature: (child) => features.unit({ attributes: { source: 'epic', ref: child.title, priority: 2 }, fields: child }),
    },
  });

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply([
    H.supply.schedule(ServiceHeartbeat, H.time.every({ minutes: 5 }), (_c, to) =>
      services.map((service) => to.create({ attributes: { service } })),
    ),
  ])
  .reuseKeys()
  .runner(local.shell({ slots: 3 }))
  .retry(H.retry.fixed({ maxRetries: 0, delayMs: 0 }))
  .handler(probeService, { ends: { healthy: Healthy } });

const unhealthyServiceFilesBug = H.trigger('unhealthy-service-files-bug', H.on.transition(heartbeats, { to: [Unhealthy] }))
  .creates((e) =>
    bugs.unit({
      attributes: { source: 'heartbeat', ref: e.unit.id, priority: 1 },
      fields: {
        title: `${e.unit.attributes.service} heartbeat failed`,
        description: `Heartbeat ${e.unit.id} for ${e.unit.attributes.service} failed its probe.`,
      },
    }),
  );

const productSchedule = H.policy.schedule('heartbeats-bugs-features-epics', (c) => {
  const starvedAfterMs = 2 * 3600000;
  const starved = c.candidates.filter((x) => x.is(features) && x.waitedMs > starvedAfterMs);
  return {
    start: [
      ...c.candidates.filter((x) => x.is(heartbeats)),
      ...starved,
      ...c.candidates.filter((x) => x.is(bugs)),
      ...c.candidates.filter((x) => x.is(features) && x.waitedMs <= starvedAfterMs),
      ...c.candidates.filter((x) => x.is(epics)),
    ],
  };
});

const productionHealth = H.operation('production-health')
  .input({ service: z.string() })
  .invokes(H.command('production-health', ['./bin/production-health']), (input) => ({ args: [input.service] }));

const productOwner = H.access('product-owner').allows([...ownerOperations, productionHealth]);

export const product = H.harness('product')
  .ledger(sqlite.ledger('product/.harness/ledger.sqlite', { quotaPartition: sharedQuotaPartition }))
  .lanes([heartbeats, bugs, features, epics])
  .triggers([unhealthyServiceFilesBug])
  .schedule(productSchedule)
  .clients([claudeCode.supervisor('product-supervisor', productOwner, { port: H.slot.port(0) })])
  .projections([markdown.board('product/.harness/board.md'), markdown.telemetry('product/.harness/telemetry.md')]);

const Stale = H.state('Stale', 'pending');
const Writing = H.state('Writing', 'active');
const Checking = H.state('Checking', 'active');
const Published = H.state('Published', 'terminal', 'success');

const DocPage = H.work('DocPage')
  .attributes({ path: z.string() })
  .fields({ title: z.string(), body: z.string() })
  .states([Stale, Writing, Checking, Published])
  .key((u) => u.attributes.path);

const writerRole = H.role('writer')
  .intents(['read', 'write'])
  .instructions('Rewrite the documentation page so it is accurate, complete and in the owner\'s voice.')
  .input({ path: z.string(), title: z.string(), body: z.string() })
  .output({ summary: z.string() });

const DocsExperience = H.memory.experience('docs-experience');
const docsExperience = H.journal('docs-experience', DocsExperience)
  .store(jsonl.memory('docs/.harness/experience.jsonl'))
  .recall(mostSpecificFirst);

const docsPool = H.pool('docs-pool')
  .accounts([
    { account: maxOne, share: 0.3 },
    { account: maxTwo, share: 0.3 },
    { account: maxThree, share: 0.3 },
  ])
  .prefer(soonestExpiring);

const writer = H.agent('writer', writerRole)
  .model(sonnet)
  .pool(docsPool)
  .recalls([ownerTaste, docsExperience])
  .records(docsExperience);

const linkCheck = H.command('link-check', ['./bin/link-check']);

const writePage = H.flow('write-page')
  .requires({ path: z.string(), title: z.string(), body: z.string() })
  .step('write', writer, (c) => ({ path: c.input.path, title: c.input.title, body: c.input.body }))
  .mark('checking')
  .step('links', linkCheck, (c) => ({ args: [c.input.path] }))
  .ends(['published'], () => 'published');

const docPages = H.lane('doc-pages', DocPage)
  .supply([
    folder.files(DocPage, 'docs/pages', (file, to) =>
      file.frontmatter['status'] === 'needs-writing'
        ? to.create({
            attributes: { path: file.path },
            fields: { title: String(file.frontmatter['title'] ?? file.path), body: file.body },
          })
        : null,
    ),
  ])
  .store(folder.frontmatter(DocPage, 'docs/pages'))
  .reuseKeys()
  .runner(local.shell({ slots: 2, cwd: 'docs' }))
  .handler(writePage, { ends: { published: Published }, marks: { checking: Checking } });

const docsOwner = H.access('docs-owner').allows(ownerOperations);

export const docs = H.harness('docs')
  .ledger(sqlite.ledger('docs/.harness/ledger.sqlite', { quotaPartition: sharedQuotaPartition }))
  .lanes([docPages])
  .schedule(H.policy.schedule('longest-waiting-first', (c) => ({ start: [...c.candidates].sort((a, b) => b.waitedMs - a.waitedMs) })))
  .clients([claudeCode.supervisor('docs-supervisor', docsOwner, { port: H.slot.port(0) })])
  .projections([markdown.board('docs/.harness/board.md'), markdown.telemetry('docs/.harness/telemetry.md')]);
