import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { jsonl } from 'harness-dsl/jsonl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { linear } from 'harness-dsl/linear';
import { folder, type FolderFile } from 'harness-dsl/folder';
import { git } from 'harness-dsl/git';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const ticket = z.object({ ref: z.string(), title: z.string(), description: z.string() });
const heartbeatAttributes = z.object({ service: z.string(), tickAt: z.string() });

const triage = H.state('Triage', 'pending');
const inProgress = H.state('InProgress', 'active');
const inReview = H.state('InReview', 'active');
const planning = H.state('Planning', 'active');
const awaitingFeatures = H.state('AwaitingFeatures', 'waiting');
const done = H.state('Done', 'terminal', 'success');
const unresolved = H.state('Unresolved', 'terminal', 'failure');
const cancelled = H.state('Cancelled', 'terminal', 'neutral');
const heartbeatDue = H.state('HeartbeatDue', 'pending');
const probing = H.state('Probing', 'active');
const healthy = H.state('Healthy', 'terminal', 'success');
const unhealthy = H.state('Unhealthy', 'terminal', 'failure');

const Bug = H.kind('Bug')
  .attributes(ticket)
  .states(triage, inProgress, inReview, done, unresolved, cancelled)
  .key(attrs => attrs.ref);
const Feature = H.kind('Feature')
  .attributes(ticket)
  .states(triage, inProgress, inReview, done, unresolved, cancelled)
  .key(attrs => attrs.ref);
const Epic = H.kind('Epic')
  .attributes(ticket)
  .states(triage, planning, awaitingFeatures, done, unresolved, cancelled)
  .key(attrs => attrs.ref);
const ServiceHeartbeat = H.kind('ServiceHeartbeat')
  .attributes(heartbeatAttributes)
  .states(heartbeatDue, probing, healthy, unhealthy)
  .key(attrs => `${attrs.service}@${attrs.tickAt}`);

const workstation = local.runner('workstation');

const projectChecks = H.command('project-checks')
  .argv(['npm', 'run', 'check'])
  .runner(workstation);

const serviceProbe = H.command('service-probe')
  .input(z.object({ service: z.string() }))
  .argv(input => ['curl', '-fsS', '--max-time', '10', `https://${input.service}.internal/health`])
  .runner(workstation);

const productionProbe = H.command('production-health-probe')
  .argv(['curl', '-fsS', '--max-time', '10', 'https://app.example.com/health'])
  .runner(workstation);

const claudeMaxA = claudeCode.subscription('claude-max-a', { token: H.env('CLAUDE_MAX_A_TOKEN') });
const claudeMaxB = claudeCode.subscription('claude-max-b', { token: H.env('CLAUDE_MAX_B_TOKEN') });
const claudeMaxC = claudeCode.subscription('claude-max-c', { token: H.env('CLAUDE_MAX_C_TOKEN') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const sonnet = claudeCode.model('sonnet', { id: 'claude-sonnet-4-5' });
const opus = claudeCode.model('opus', { id: 'claude-opus-4-1' });

const soonestExpiringFirst = H.policy.account('soonest-expiring-first', ctx =>
  ctx.candidates
    .filter(candidate => candidate.shareUsed < candidate.shareCap)
    .filter(candidate => !candidate.cooldownUntil || candidate.cooldownUntil <= ctx.now)
    .sort((left, right) => left.windowResetsAt.getTime() - right.windowResetsAt.getTime())[0],
);

const claudePool = H.pool('claude-subscriptions')
  .accounts(claudeMaxA, claudeMaxB, claudeMaxC)
  .share(claudeMaxA, 0.8)
  .share(claudeMaxB, 0.8)
  .share(claudeMaxC, 0.6)
  .drain(soonestExpiringFirst)
  .fallback(apiAccount);

const builderModel = H.policy.model('builder-model-by-track-record', [sonnet, opus], ctx => {
  const cheaper = ctx.metrics.outcomes({ of: ctx.lane, model: sonnet, windowDays: 14 });
  return cheaper.samples >= 20 && cheaper.successRate < 0.85 ? opus : sonnet;
});

const builderRole = H.role('builder')
  .intents('read', 'edit', 'run', 'search', 'halt')
  .instructions('Implement the unit of work in the worktree. Halt for the owner when a product decision is needed.');
const auditorRole = H.role('auditor')
  .intents('read', 'run', 'search', 'record')
  .instructions('Find deficits in the change. Record forward-phrased lessons that would have prevented them.');
const plannerRole = H.role('planner')
  .intents('read', 'search')
  .instructions('Decompose the epic into independently shippable features.');

const worktree = git.worktree({ repo: '.' });

const builder = H.agent('builder-agent')
  .role(builderRole)
  .model(builderModel)
  .workspace(worktree)
  .guards(H.guard.lease(), H.guard.beforeStop(projectChecks))
  .budgetTokens(400000);

const auditor = H.agent('auditor-agent')
  .role(auditorRole)
  .model(opus)
  .workspace(worktree)
  .output(z.object({ deficits: z.array(z.string()) }));

const planner = H.agent('planner-agent')
  .role(plannerRole)
  .model(opus)
  .output(z.object({ features: z.array(z.object({ title: z.string(), description: z.string() })) }));

const engineeringExperience = H.memory('engineering-experience', 'experience');
const ownerTaste = H.memory('owner-taste', 'taste');
const byScope = H.recall('by-scope', { by: 'specificity', limit: 12 });

const experienceJournal = H.journal('experience-journal', engineeringExperience)
  .store(jsonl.memoryStore({ path: '.harness/memory/experience.jsonl' }))
  .recall(byScope)
  .readBy(builderRole, auditorRole)
  .writtenBy(auditorRole);

const tasteJournal = H.journal('taste-journal', ownerTaste)
  .store(jsonl.memoryStore({ path: '.harness/memory/taste.jsonl' }))
  .recall(byScope)
  .readBy(builderRole, plannerRole);

const buildAndAudit = H.flow('build-and-audit')
  .input(ticket)
  .params(z.object({ rounds: z.number().int().positive() }))
  .loop(
    'rounds',
    round =>
      round
        .step('build', builder, ctx => ({
          task: `Implement ${ctx.unit.attributes.ref}: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
          skills: ['implementation'],
        }))
        .step('audit', auditor, ctx => ({
          task: `Audit the change for ${ctx.unit.attributes.ref} against its description and list every remaining deficit.`,
          skills: ['review'],
        })),
    {
      max: ctx => ctx.params.rounds,
      until: ctx => ctx.steps.audit.deficits.length === 0,
    },
  )
  .exit('clean', ctx => ctx.steps.audit.deficits.length === 0)
  .exit('exhausted');

const linearKey = H.env('LINEAR_API_KEY');
const trackerStore = linear.store({
  apiKey: linearKey,
  team: 'ENG',
  states: {
    Triage: 'Triage',
    InProgress: 'In Progress',
    InReview: 'In Review',
    Planning: 'Planning',
    AwaitingFeatures: 'In Progress',
    Done: 'Done',
    Unresolved: 'Canceled',
    Cancelled: 'Canceled',
  },
});

function titleOf(file: FolderFile): string {
  const title = file.frontmatter.title;
  return typeof title === 'string' ? title : file.name;
}

const bugLane = H.lane('bugs', Bug)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['bug'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(folder.files({ path: 'bugs', glob: '*.md' }), (file, to) =>
    to.create({ ref: `file:${file.name}`, title: titleOf(file), description: file.body }),
  )
  .supply(H.operator)
  .store(trackerStore)
  .handler(buildAndAudit, {
    exits: { clean: done, exhausted: unresolved },
    during: { build: inProgress, audit: inReview },
    cancelled,
    params: { rounds: 3 },
  });

const featureLane = H.lane('features', Feature)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['feature'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .supply(H.operator)
  .store(trackerStore)
  .handler(buildAndAudit, {
    exits: { clean: done, exhausted: unresolved },
    during: { build: inProgress, audit: inReview },
    cancelled,
    params: { rounds: 5 },
  });

const decomposeEpic = H.flow('decompose-epic')
  .input(ticket)
  .step('plan', planner, ctx => ({
    task: `Decompose epic ${ctx.unit.attributes.ref}: ${ctx.unit.attributes.title}\n\n${ctx.unit.attributes.description}`,
    skills: ['planning'],
  }))
  .spawn('features', featureLane, ctx =>
    ctx.steps.plan.features.map((feature, index) => ({
      ref: `${ctx.unit.attributes.ref}-f${index + 1}`,
      title: feature.title,
      description: feature.description,
    })),
  )
  .exit('delivered', ctx => ctx.steps.features.every(child => child.verdict === 'success'))
  .exit('incomplete');

const epicLane = H.lane('epics', Epic)
  .supply(linear.issues({ apiKey: linearKey, team: 'ENG', labels: ['epic'] }), (issue, to) =>
    to.create({ ref: issue.identifier, title: issue.title, description: issue.description }),
  )
  .store(trackerStore)
  .handler(decomposeEpic, {
    exits: { delivered: done, incomplete: unresolved },
    during: { plan: planning, features: awaitingFeatures },
    cancelled,
  });

const probeService = H.flow('probe-service')
  .input(heartbeatAttributes)
  .step('probe', serviceProbe, ctx => ({ service: ctx.unit.attributes.service }), {
    timeoutMs: 30000,
    onCrash: 'rerun',
  })
  .exit('healthy');

const heartbeatLane = H.lane('heartbeats', ServiceHeartbeat)
  .supply(H.clock('heartbeat-clock').every({ minutes: 5 }), (tick, to) =>
    to.create({ service: 'api', tickAt: tick.at.toISOString() }),
  )
  .handler(probeService, {
    exits: { healthy },
    during: { probe: probing },
    failure: unhealthy,
  });

const failedHeartbeatFilesBug = H.trigger('failed-heartbeat-files-bug')
  .on(H.when.transition(heartbeatLane, { to: unhealthy }))
  .create(bugLane, event => ({
    ref: `heartbeat:${event.unit.attributes.service}`,
    title: `Service ${event.unit.attributes.service} failed its heartbeat`,
    description: `The heartbeat probe at ${event.unit.attributes.tickAt} failed. Find and fix the cause.`,
  }));

const teamScheduler = H.scheduler('team-scheduler')
  .priority(heartbeatLane, bugLane, featureLane, epicLane)
  .wip(bugLane, 2)
  .wip(epicLane, 1)
  .boost(featureLane, { afterMinutes: 240 });

const supervisor = claudeCode.supervisor('team-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workUpdate,
    H.ops.blockersResolve,
    H.ops.memoryWrite,
    H.ops.telemetryRead,
    H.ops.accountsRead,
    H.ops.accountsShare,
    H.operation('production-health').run(productionProbe),
  ],
});

export const codingTeam = H.harness('coding-team')
  .ledger(sqlite.ledger({ path: '.harness/ledger.db' }))
  .pools(claudePool)
  .lanes(heartbeatLane, bugLane, featureLane, epicLane)
  .journals(experienceJournal, tasteJournal)
  .triggers(failedHeartbeatFilesBug)
  .scheduler(teamScheduler)
  .clients(supervisor)
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));
