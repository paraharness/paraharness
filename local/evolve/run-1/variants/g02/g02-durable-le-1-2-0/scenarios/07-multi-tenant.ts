import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Candidate } from 'harness-dsl/kernel';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as jsonl from 'harness-dsl/jsonl';
import * as linear from 'harness-dsl/linear';
import * as folder from 'harness-dsl/folder';
import * as git from 'harness-dsl/git';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

export const claudeMaxOne = claudeCode.subscription('claude-max-1', { configDir: H.env('CLAUDE_MAX_1_DIR') });
export const claudeMaxTwo = claudeCode.subscription('claude-max-2', { configDir: H.env('CLAUDE_MAX_2_DIR') });
export const claudeMaxThree = claudeCode.subscription('claude-max-3', { configDir: H.env('CLAUDE_MAX_3_DIR') });
export const subscriptions = [claudeMaxOne, claudeMaxTwo, claudeMaxThree];
export const sharedQuota = sqlite.quota('~/.harness/claude-quota.db');

export const soonestExpiring = H.policy.account('soonest-expiring', c =>
  [...c.eligible].sort((a, b) => a.windowEndsAt - b.windowEndsAt)[0] ?? null,
);

export const mostSpecificFirst = H.policy.recall('most-specific-first', c =>
  [...c.candidates]
    .sort((a, b) => b.specificity - a.specificity || b.track.succeeded - a.track.succeeded)
    .slice(0, c.limit),
);

export const ownerTaste = H.memory.taste('owner-taste');
export const tasteJournal = H.journal('owner-taste', ownerTaste)
  .store(jsonl.memory('~/.harness/owner-taste.jsonl'))
  .recall(mostSpecificFirst);

export const sonnet = claudeCode.model('claude-sonnet-4-5');
export const opus = claudeCode.model('claude-opus-4-1');

const Todo = H.state('Todo', 'pending');
const Building = H.state('Building', 'active');
const Planning = H.state('Planning', 'active');
const Done = H.state('Done', 'terminal', 'success');
const Abandoned = H.state('Abandoned', 'terminal', 'failure');
const Due = H.state('Due', 'pending');
const Probing = H.state('Probing', 'active');
const Healthy = H.state('Healthy', 'terminal', 'success');
const Unhealthy = H.state('Unhealthy', 'terminal', 'failure');

const ticketAttributes = { ref: z.string(), priority: z.number() };
const ticketFields = { title: z.string(), description: z.string() };

const Bug = H.work('Bug')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states([Todo, Building, Done, Abandoned])
  .key(u => u.attributes.ref);
const Feature = H.work('Feature')
  .attributes(ticketAttributes)
  .fields(ticketFields)
  .states([Todo, Building, Done, Abandoned])
  .key(u => u.attributes.ref);
const Epic = H.work('Epic')
  .attributes({ ref: z.string() })
  .fields(ticketFields)
  .states([Todo, Planning, Done, Abandoned])
  .key(u => u.attributes.ref);
const Heartbeat = H.work('ServiceHeartbeat')
  .attributes({ service: z.string(), due: z.number() })
  .states([Due, Probing, Healthy, Unhealthy])
  .key(u => `${u.attributes.service}@${u.attributes.due}`);

const codingExperience = H.memory.experience('coding-experience');
const codingExperienceJournal = H.journal('coding-experience', codingExperience)
  .store(jsonl.memory('coding/.harness/experience.jsonl'))
  .recall(mostSpecificFirst);

const apiFallback = anthropic.account('coding-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const codingPool = H.pool('coding-pool')
  .accounts(subscriptions.map(account => ({ account, share: 0.6 })))
  .prefer(soonestExpiring)
  .fallback(apiFallback);

const builderModel = H.policy.model('builder-model', [sonnet, opus], c => {
  const unit = c.unit;
  if (unit === null) return sonnet;
  const cheaper = c.metrics.success({ model: sonnet, kind: unit.kind, window: { days: 14 } });
  return cheaper.n >= 20 && cheaper.rate !== null && cheaper.rate < 0.85 ? opus : sonnet;
});

const projectChecks = H.command('project-checks', ['npm', 'run', 'check']);

const builderRole = H.role('builder')
  .intents(['read', 'write', 'execute', 'search', 'ask'])
  .instructions('Implement the work item. Address every listed deficit. Ask the owner when a decision is theirs.')
  .input({ title: z.string(), description: z.string(), deficits: z.array(z.string()) })
  .output({ summary: z.string() });
const auditorRole = H.role('auditor')
  .intents(['read', 'execute', 'remember'])
  .instructions('Audit the change against the work item. Report every deficit; report none only when there are none.')
  .input({ title: z.string(), description: z.string(), summary: z.string() })
  .output({ deficits: z.array(z.string()) });
const plannerRole = H.role('planner')
  .intents(['read', 'search'])
  .instructions('Decompose the epic into independently shippable features.')
  .input({ title: z.string(), description: z.string() })
  .output({ features: z.array(z.object({ title: z.string(), description: z.string() })) });

const builder = H.agent('builder', builderRole)
  .model(builderModel)
  .pool(codingPool)
  .recalls([codingExperienceJournal, tasteJournal])
  .leaseWrites()
  .mustPass(projectChecks);
const auditor = H.agent('auditor', auditorRole)
  .model(opus)
  .pool(codingPool)
  .recalls([codingExperienceJournal])
  .records(codingExperienceJournal);
const planner = H.agent('planner', plannerRole)
  .model(opus)
  .pool(codingPool)
  .recalls([tasteJournal]);

const buildAndAudit = H.flow('build-and-audit')
  .requires({ title: z.string(), description: z.string() })
  .params({ rounds: z.number() })
  .loop(
    'rounds',
    { carry: { deficits: z.array(z.string()) }, rounds: c => c.params.rounds },
    round =>
      round
        .step('build', builder, c => ({
          title: c.input.title,
          description: c.input.description,
          deficits: c.carry === null ? [] : c.carry.deficits,
        }))
        .step('audit', auditor, c => ({ title: c.input.title, description: c.input.description, summary: c.out.build.summary })),
    last => (last.audit.deficits.length === 0 ? null : { deficits: last.audit.deficits }),
  )
  .ends(['done', 'gaveUp'], c => (c.out.rounds.exhausted ? 'gaveUp' : 'done'));

const decomposeEpic = H.flow('decompose-epic')
  .requires({ ref: z.string(), title: z.string(), description: z.string() })
  .step('plan', planner, c => ({ title: c.input.title, description: c.input.description }))
  .spawn('features', {
    outlet: 'feature',
    child: { ref: z.string(), title: z.string(), description: z.string() },
    items: c =>
      c.out.plan.features.map((feature, index) => ({
        ref: `${c.input.ref}.${index + 1}`,
        title: feature.title,
        description: feature.description,
      })),
  })
  .ends(['done', 'gaveUp'], c => (c.out.features.every(child => child.verdict === 'success') ? 'done' : 'gaveUp'));

const serviceProbe = H.command('probe-service', ['scripts/probe-service.sh']).parses({ healthy: z.boolean() });
const heartbeatFlow = H.flow('heartbeat')
  .requires({ service: z.string() })
  .step('probe', serviceProbe, c => ({ args: [c.input.service] }))
  .ends(['healthy', 'unhealthy'], c => (c.out.probe.data.healthy ? 'healthy' : 'unhealthy'));

const tracker = { apiKey: H.env('LINEAR_API_KEY'), team: 'ENG' };
const trackerStatus = { Todo: 'Todo', Building: 'In Progress', Planning: 'In Progress', Done: 'Done', Abandoned: 'Canceled' };
const worktrees = git.worktree({ repo: '.', base: 'main', slots: 3 });

const features = H.lane('features', Feature)
  .supply([
    linear.issues(Feature, { ...tracker, labels: ['feature'] }, issue => ({
      create: {
        attributes: { ref: issue.identifier, priority: issue.priority },
        fields: { title: issue.title, description: issue.description },
      },
    })),
    H.supply.operator(),
  ])
  .store(linear.store(Feature, { ...tracker, status: trackerStatus }))
  .runner(worktrees)
  .handler(buildAndAudit, { outcomes: { done: Done, gaveUp: Abandoned }, params: { rounds: 5 } });

const bugs = H.lane('bugs', Bug)
  .supply([
    linear.issues(Bug, { ...tracker, labels: ['bug'] }, issue => ({
      create: {
        attributes: { ref: issue.identifier, priority: issue.priority },
        fields: { title: issue.title, description: issue.description },
      },
    })),
    folder.files(Bug, 'bugs', file => {
      const title = file.frontmatter['title'];
      const priority = file.frontmatter['priority'];
      return {
        create: {
          attributes: { ref: `file:${file.path}`, priority: typeof priority === 'number' ? priority : 3 },
          fields: { title: typeof title === 'string' ? title : file.path, description: file.body },
        },
      };
    }),
    H.supply.operator(),
  ])
  .store(linear.store(Bug, { ...tracker, status: trackerStatus }))
  .runner(worktrees)
  .wip(2)
  .handler(buildAndAudit, { outcomes: { done: Done, gaveUp: Abandoned }, params: { rounds: 3 } });

const epics = H.lane('epics', Epic)
  .supply([
    linear.issues(Epic, { ...tracker, labels: ['epic'] }, issue => ({
      create: { attributes: { ref: issue.identifier }, fields: { title: issue.title, description: issue.description } },
    })),
  ])
  .store(linear.store(Epic, { ...tracker, status: trackerStatus }))
  .wip(1)
  .handler(decomposeEpic, {
    outcomes: { done: Done, gaveUp: Abandoned },
    spawns: {
      feature: child =>
        features.unit({
          attributes: { ref: child.ref, priority: 2 },
          fields: { title: child.title, description: child.description },
        }),
    },
  });

const services = ['api', 'web', 'worker'];
const heartbeats = H.lane('heartbeats', Heartbeat)
  .supply([
    H.supply.schedule(Heartbeat, H.time.every({ minutes: 5 }), c =>
      services.map(service => ({ create: { attributes: { service, due: c.now } } })),
    ),
  ])
  .runner(local.shell({ slots: 3 }))
  .handler(heartbeatFlow, { outcomes: { healthy: Healthy, unhealthy: Unhealthy } });

const bugFromHeartbeat = H.trigger('bug-from-failed-heartbeat', H.on.transition(heartbeats, { to: [Unhealthy] }))
  .creates(e =>
    bugs.unit({
      attributes: { ref: `heartbeat:${e.unit.attributes.service}@${e.unit.attributes.due}`, priority: 1 },
      fields: {
        title: `${e.unit.attributes.service} failed its heartbeat`,
        description: `The heartbeat probe for ${e.unit.attributes.service} reported unhealthy.`,
      },
    }),
  );

const starvedAfterMs = 2 * 60 * 60 * 1000;
const codingSchedule = H.policy.schedule('heartbeats-bugs-features-epics', c => {
  const rank = (x: Candidate): number =>
    x.unit.is(heartbeats) ? 0
      : x.unit.is(features) && x.waitedMs > starvedAfterMs ? 1
      : x.unit.is(bugs) ? 1
      : x.unit.is(features) ? 2
      : 3;
  return { start: [...c.candidates].sort((a, b) => rank(a) - rank(b) || b.waitedMs - a.waitedMs) };
});

const productionHealth = H.command('production-health', ['scripts/production-health.sh']);
const probeProduction = H.operation('probe-production')
  .input({ region: z.string() })
  .invokes(productionHealth, input => ({ args: [input.region] }));

const codingAccess = H.access('coding-owner').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.updateWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
  probeProduction,
]);

export const coding = H.harness('coding-team')
  .ledger(sqlite.ledger('coding/.harness/ledger.db', { quota: sharedQuota }))
  .lanes([heartbeats, bugs, features, epics])
  .triggers([bugFromHeartbeat])
  .schedule(codingSchedule)
  .projections([markdown.board('coding/BOARD.md'), markdown.telemetry('coding/TELEMETRY.md')]);

export const codingControl = H.control('coding-control', coding)
  .clients([claudeCode.supervisor('coding-supervisor', codingAccess, { port: H.slot.port(0) })]);

const DocQueued = H.state('DocQueued', 'pending');
const DocWriting = H.state('DocWriting', 'active');
const DocPublished = H.state('DocPublished', 'terminal', 'success');

const DocPage = H.work('DocPage')
  .attributes({ path: z.string() })
  .fields({ title: z.string(), body: z.string() })
  .states([DocQueued, DocWriting, DocPublished])
  .key(u => u.attributes.path);

const docsExperience = H.memory.experience('docs-experience');
const docsExperienceJournal = H.journal('docs-experience', docsExperience)
  .store(jsonl.memory('docs/.harness/experience.jsonl'))
  .recall(mostSpecificFirst);

const docsPool = H.pool('docs-pool')
  .accounts(subscriptions.map(account => ({ account, share: 0.3 })))
  .prefer(soonestExpiring);

const writerRole = H.role('writer')
  .intents(['read', 'write'])
  .instructions('Revise the page so it is accurate, complete and in the owner\'s voice.')
  .input({ path: z.string(), title: z.string(), body: z.string() })
  .output({ body: z.string() });
const writer = H.agent('writer', writerRole)
  .model(sonnet)
  .pool(docsPool)
  .recalls([tasteJournal, docsExperienceJournal])
  .records(docsExperienceJournal);

const linkCheck = H.command('link-check', ['npx', 'markdown-link-check']);

const writePage = H.flow('write-page')
  .requires({ path: z.string(), title: z.string(), body: z.string() })
  .step('write', writer, c => ({ path: c.input.path, title: c.input.title, body: c.input.body }))
  .step('links', linkCheck, c => ({ args: [c.input.path], stdin: c.out.write.body }))
  .ends(['published'], () => 'published');

const pages = H.lane('pages', DocPage)
  .supply([
    folder.files(DocPage, 'docs', file => {
      const title = file.frontmatter['title'];
      return {
        create: {
          attributes: { path: file.path },
          fields: { title: typeof title === 'string' ? title : file.path, body: file.body },
        },
      };
    }),
  ])
  .store(folder.frontmatter(DocPage, 'docs'))
  .runner(local.shell({ slots: 2, cwd: 'docs' }))
  .handler(writePage, { outcomes: { published: DocPublished } });

const docsAccess = H.access('docs-owner').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.resolveBlocks,
  H.ops.readMemory,
  H.ops.writeMemory,
  H.ops.readTelemetry,
  H.ops.readAccounts,
  H.ops.setShares,
]);

export const docs = H.harness('documentation')
  .ledger(sqlite.ledger('docs/.harness/ledger.db', { quota: sharedQuota }))
  .lanes([pages])
  .projections([markdown.board('docs/BOARD.md'), markdown.telemetry('docs/TELEMETRY.md')]);

export const docsControl = H.control('docs-control', docs)
  .clients([claudeCode.supervisor('docs-supervisor', docsAccess, { port: H.slot.port(1) })]);

export async function main(): Promise<void> {
  await coding.start();
  await codingControl.serve();
  await docs.start();
  await docsControl.serve();
}
