import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const shell = local.runner('release-shell').slots(3);
const quota = sqlite.quota('release-quota', { path: 'data/quota.sqlite' });
const store = sqlite.store({ path: 'data/units.sqlite' });

const subscription = claudeCode.subscription('claude-release', { token: H.env('CLAUDE_TOKEN'), quota });
const reviewModel = claudeCode.model('release-reviewer-model', { id: 'claude-opus-4-1' });
const apiAccount = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });
const summaryModel = anthropic.model('summary-model', { id: 'claude-haiku-4-5' });

const sessionPool = H.pool('sessions').accounts(subscription);
const batchPool = H.pool('batch').accounts(apiAccount);

const reviewerRole = H.role('release-reviewer').intents('read', 'run').instructions('Review the release diff and changelog.');
const summarizerRole = H.role('release-summarizer').intents('read').instructions('Write release notes in plain language.');

const reviewer = H.seat('release-reviewer')
  .output(z.object({ approve: z.boolean(), notes: z.string() }))
  .role(reviewerRole)
  .model(reviewModel)
  .pool(sessionPool);

const summarizer = H.seat('release-summarizer')
  .output(z.object({ summary: z.string() }))
  .role(summarizerRole)
  .model(summaryModel)
  .pool(batchPool);

const summaryBatch = summarizer.batch({ pollEveryMinutes: 5 });

const releaseInput = z.object({ version: z.string(), channel: z.string() });

const build = H.command('build')
  .input(releaseInput)
  .argv(i => ['make', 'release', `VERSION=${i.version}`])
  .runner(shell);

const announce = H.command('announce')
  .input(releaseInput)
  .argv(i => ['post-message', '--channel', i.channel, '--text', `Release ${i.version} is on its way`])
  .runner(shell);

const announcementPosted = H.command('announcement-posted')
  .input(releaseInput)
  .argv(i => ['find-message', '--channel', i.channel, '--contains', `Release ${i.version}`])
  .output(z.boolean())
  .runner(shell);

const releaseApproval = H.halt('release-approval').decision(z.object({ approved: z.boolean(), note: z.string() }));

const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokeRunning = H.state('SmokeRunning', 'active');
const SmokePassed = H.terminal('SmokePassed', 'success');
const SmokeFailed = H.terminal('SmokeFailed', 'failure');

const smokeAttributes = z.object({ release: z.string(), platform: z.string() });

const Smoke = H.kind('Smoke')
  .attributes(smokeAttributes)
  .states(SmokeQueued, SmokeRunning, SmokePassed, SmokeFailed)
  .key(a => `${a.release}:${a.platform}`)
  .initial(SmokeQueued);

const smokeTest = H.command('smoke-test')
  .input(smokeAttributes)
  .argv(i => ['smoke', '--platform', i.platform, '--version', i.release])
  .runner(shell);

const runSmoke = H.flow('run-smoke')
  .input(smokeAttributes)
  .step('test', smokeTest, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .exit('passed');

const smoke = H.lane('smoke', Smoke)
  .store(store)
  .handler(runSmoke, { exits: { passed: SmokePassed }, during: { test: SmokeRunning } })
  .retry({ maxAttempts: 2, backoff: 'fixed', initialDelayMs: 60000, exhausted: SmokeFailed });

const Requested = H.state('Requested', 'pending');
const Releasing = H.state('Releasing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Summarizing = H.state('Summarizing', 'waiting');
const Smoking = H.state('Smoking', 'waiting');
const Released = H.terminal('Released', 'success');
const Rejected = H.terminal('Rejected', 'failure');
const SmokeBroken = H.terminal('SmokeBroken', 'failure');
const Abandoned = H.terminal('Abandoned', 'failure');

const Release = H.kind('Release')
  .attributes(releaseInput)
  .states(Requested, Releasing, AwaitingApproval, Summarizing, Smoking, Released, Rejected, SmokeBroken, Abandoned)
  .key(a => a.version)
  .initial(Requested);

const platforms = ['linux', 'macos', 'windows'];

const ship = H.flow('ship-release')
  .input(releaseInput)
  .step('build', build, ctx => ctx.unit.attributes, { afterCrash: 'rerun' })
  .step('announce', announce, ctx => ctx.unit.attributes, { afterCrash: 'park', alreadyDone: announcementPosted })
  .step('review', reviewer, ctx => ({ task: `Review release ${ctx.unit.attributes.version}` }), { afterCrash: 'askDriver' })
  .halt('approval', releaseApproval, {
    ask: ctx => `Approve release ${ctx.unit.attributes.version}? Reviewer: ${ctx.steps.review.notes}`,
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .job('summarize', summaryBatch, ctx => [
    { task: `Release notes for ${ctx.unit.attributes.version}. Review notes: ${ctx.steps.review.notes}` },
  ])
  .spawn('smoke', smoke, ctx => platforms.map(platform => ({ release: ctx.unit.attributes.version, platform })))
  .exit('smokeFailed', ctx => ctx.steps.smoke.some(child => child.verdict !== 'success'))
  .exit('released');

const releases = H.lane('releases', Release)
  .supply(H.operator)
  .store(store)
  .handler(ship, {
    exits: { rejected: Rejected, smokeFailed: SmokeBroken, released: Released },
    during: {
      build: Releasing,
      announce: Releasing,
      review: Releasing,
      approval: AwaitingApproval,
      summarize: Summarizing,
      smoke: Smoking,
    },
  })
  .retry({ maxAttempts: 2, backoff: 'exponential', initialDelayMs: 300000, exhausted: Abandoned });

const releaseManager = claudeCode.supervisor('release-manager').client('release-supervisor', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.resolve(releaseApproval),
    H.ops.attemptsRecover,
    H.ops.telemetryRead,
  ],
});

const harness = H.harness('release')
  .ledger(sqlite.ledger({ path: 'data/ledger.sqlite' }))
  .lanes(releases, smoke)
  .scheduler(H.scheduler('release-scheduler').priority(releases, smoke).wip(releases, 1).wip(smoke, 3))
  .clients(releaseManager)
  .observers(markdown.board({ path: 'data/board.md' }), markdown.telemetry({ path: 'data/telemetry.md' }));

void harness.start();
