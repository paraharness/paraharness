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

const sharedQuota = sqlite.quota('claude-accounts', { path: '../.harness-shared/quota.db' });

const personal = claudeCode.subscription('personal', { token: H.env('CLAUDE_PERSONAL_TOKEN'), quota: sharedQuota });
const team = claudeCode.subscription('team', { token: H.env('CLAUDE_TEAM_TOKEN'), quota: sharedQuota });
const studio = claudeCode.subscription('studio', { token: H.env('CLAUDE_STUDIO_TOKEN'), quota: sharedQuota });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota: sharedQuota });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiring = H.policy.account('soonestExpiring', ctx =>
  [...ctx.candidates]
    .filter(account => account.shareUsed < account.shareCap)
    .filter(account => account.cooldownUntil === undefined || account.cooldownUntil <= ctx.now)
    .sort((a, b) => a.windowResetsAt.getTime() - b.windowResetsAt.getTime())[0],
);

const subscriptions = H.pool('subscriptions')
  .accounts(personal, team, studio)
  .share(personal, 0.5)
  .share(team, 0.3)
  .share(studio, 0.2)
  .drain(soonestExpiring)
  .fallback(apiAccount);

const cheapUntilSlipping = H.policy.model('cheapUntilSlipping', ctx => {
  const [cheapest, ...stronger] = ctx.candidates;
  const record = ctx.metrics.attempts({ of: ctx.kind, seat: ctx.seat, model: cheapest, window: { lastDays: 14 } });
  return record.samples >= 20 && record.successRate < 0.85 ? stronger[0] ?? cheapest : cheapest;
});

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search')
  .instructions('Implement the change in the worktree. Halt for the owner when a product decision is needed.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('List every deficit in the change. Record forward-phrased lessons worth keeping.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently deliverable features.');

const ownerDecision = H.halt('ownerDecision').decision(z.object({ answer: z.string() }));

const workstation = local.runner('workstation').slots(4);
const projectChecks = H.command('projectChecks').argv(['npm', 'run', 'check']).runner(workstation);
const productionHealth = H.command('productionHealth').argv(['./scripts/production-health.sh']).runner(workstation);
const serviceProbe = H.command('serviceProbe')
  .input(z.object({ service: z.string() }))
  .argv(input => ['./scripts/heartbeat.sh', input.service])
  .acceptExitCodes(0, 1)
  .runner(workstation);

const worktree = git.worktree({ repo: '.', base: 'main' });

const builder = H.seat('builder')
  .role(builderRole)
  .model(cheapUntilSlipping, [sonnet, opus])
  .pool(subscriptions)
  .workspace(worktree)
  .guard({ leaseFiles: true, beforeStop: projectChecks })
  .halts(ownerDecision);

const auditor = H.seat('auditor')
  .role(auditorRole)
  .model(opus)
  .pool(subscriptions)
  .workspace(worktree)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.seat('planner')
  .role(plannerRole)
  .model(opus)
  .pool(subscriptions)
  .output(z.object({ features: z.array(z.object({ title: z.string(), body: z.string() })) }));

const experience = H.journal('experience', H.memory('experience', 'experience'))
  .store(jsonl.memoryStore({ path: 'memory/experience.jsonl' }))
  .recall({ by: 'specificity', limit: 12 })
  .readBy(builderRole, auditorRole)
  .recordedBy(auditorRole);

const taste = H.journal('taste', H.memory('taste', 'taste'))
  .store(jsonl.memoryStore({ path: 'memory/taste.jsonl' }))
  .recall({ by: 'specificity', limit: 20 })
  .readBy(builderRole, plannerRole);

const Todo = H.state('Todo', 'pending');
const Done = H.terminal('Done', 'success');
const Unfinished = H.terminal('Unfinished', 'failure');
const Due = H.state('Due', 'pending');
const Up = H.terminal('Up', 'success');
const Down = H.terminal('Down', 'failure');

const workItem = z.object({ ref: z.string(), title: z.string(), body: z.string() });

const Bug = H.kind('Bug').attributes(workItem).states(Todo, Done, Unfinished).key(bug => bug.ref).initial(Todo);
const Feature = H.kind('Feature')
  .attributes(workItem.extend({ epic: z.string().optional() }))
  .states(Todo, Done, Unfinished)
  .key(feature => feature.ref)
  .initial(Todo);
const Epic = H.kind('Epic').attributes(workItem).states(Todo, Done, Unfinished).key(epic => epic.ref).initial(Todo);
const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(z.object({ service: z.string() }))
  .states(Due, Up, Down)
  .key(heartbeat => heartbeat.service)
  .initial(Due);

const delivery = H.flow('delivery')
  .input(z.object({ title: z.string(), body: z.string() }))
  .params(z.object({ rounds: z.number().int().positive() }))
  .step('build', builder, ctx => ({ task: `${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}` }), {
    afterCrash: 'askDriver',
  })
  .loop(
    'review',
    flow =>
      flow
        .step('audit', auditor, ctx => ({ task: `Audit the change made for: ${ctx.unit.attributes.title}` }))
        .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
        .exit('roundsOut', ctx => ctx.iteration >= ctx.params.rounds)
        .step('fix', builder, ctx => ({ task: `Resolve these deficits:\n${ctx.steps.audit.deficits.join('\n')}` }), {
          afterCrash: 'askDriver',
        }),
    { max: ctx => ctx.params.rounds },
  )
  .exit('roundsOut');

const tracker = linear.store({
  apiKey: H.env('LINEAR_API_KEY'),
  team: 'PRODUCT',
  workflow: ['Todo', 'In Progress', 'Blocked', 'Done', 'Canceled'],
});

const bugs = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PRODUCT', labels: ['bug'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }),
  )
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ ref: `file-${file.name}`, title: file.name, body: file.body }),
  )
  .supply(H.operator)
  .store(tracker, {
    states: { Todo: 'Todo', Done: 'Done', Unfinished: 'Canceled' },
    running: 'In Progress',
    blocked: 'Blocked',
  })
  .handler(delivery, {
    params: { rounds: 3 },
    ends: { clean: Done, roundsOut: Unfinished },
    retry: { maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300000, exhausted: Unfinished },
  });

const features = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PRODUCT', labels: ['feature'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }),
  )
  .supply(H.operator)
  .store(tracker, {
    states: { Todo: 'Todo', Done: 'Done', Unfinished: 'Canceled' },
    running: 'In Progress',
    blocked: 'Blocked',
  })
  .handler(delivery, {
    params: { rounds: 5 },
    ends: { clean: Done, roundsOut: Unfinished },
    retry: { maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300000, exhausted: Unfinished },
  });

const decomposition = H.flow('decomposition')
  .input(z.object({ title: z.string(), body: z.string() }))
  .step('plan', planner, ctx => ({ task: `Decompose this epic into features.\n${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.body}` }))
  .spawn('features', features, ctx =>
    ctx.steps.plan.features.map((feature, index) => ({
      ref: `${ctx.unit.key}-${index + 1}`,
      title: feature.title,
      body: feature.body,
      epic: ctx.unit.key,
    })),
  )
  .exit('delivered', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epics = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: H.env('LINEAR_API_KEY'), team: 'PRODUCT', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, body: issue.description }),
  )
  .store(tracker, {
    states: { Todo: 'Todo', Done: 'Done', Unfinished: 'Canceled' },
    running: 'In Progress',
    blocked: 'Blocked',
  })
  .handler(decomposition, {
    ends: { delivered: Done, incomplete: Unfinished },
    retry: { maxAttempts: 2, backoff: 'fixed', initialDelayMs: 600000, exhausted: Unfinished },
  });

const heartbeat = H.flow('heartbeat')
  .input(z.object({ service: z.string() }))
  .step('probe', serviceProbe, ctx => ({ service: ctx.unit.attributes.service }), { afterCrash: 'rerun' })
  .exit('up', ctx => ctx.steps.probe.exitCode === 0)
  .exit('down');

const services = ['api', 'billing', 'search'];

const heartbeats = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('everyFiveMinutes').every({ minutes: 5 }), (_tick, to) => services.map(service => to.create({ service })))
  .handler(heartbeat, {
    ends: { up: Up, down: Down },
    retry: { maxAttempts: 1, backoff: 'fixed', initialDelayMs: 0, exhausted: Down },
  });

const outageBecomesBug = H.trigger('outageBecomesBug')
  .on(H.when.transition(heartbeats, { to: Down }))
  .create(bugs, event => ({
    ref: `heartbeat-${event.unit.attributes.service}`,
    title: `${event.unit.attributes.service} heartbeat failed`,
    body: `The heartbeat for ${event.unit.attributes.service} failed at ${event.at.toISOString()}.`,
  }));

const scheduler = H.scheduler('team')
  .priority(heartbeats, bugs, features, epics)
  .wip(bugs, 2)
  .wip(epics, 1)
  .boost(features, { afterMinutes: 240 });

const supervisor = claudeCode.supervisor('owner').client('coding-team', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.resolve(ownerDecision),
    H.ops.memoryRead,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    H.operation('productionHealth', productionHealth),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .lanes(heartbeats, bugs, features, epics)
  .journals(experience, taste)
  .triggers(outageBecomesBug)
  .scheduler(scheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

void codingTeam.start();
