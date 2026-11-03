import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { ssh } from 'harness-dsl/ssh';
import { markdown } from 'harness-dsl/markdown';

const releaseSubscription = claudeCode.subscription('release-subscription', { token: H.env('CLAUDE_SUBSCRIPTION_TOKEN') });
const apiAccount = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const reviewModel = claudeCode.model('opus', { id: 'claude-opus-4' });
const summaryModel = anthropic.model('haiku-batch', { id: 'claude-haiku-4' });
const subscriptionPool = H.pool('release-subscription').accounts(releaseSubscription);
const apiPool = H.pool('release-api').accounts(apiAccount);

const buildHost = ssh.host('build-host', { host: 'build.internal', user: 'release', key: H.env('BUILD_SSH_KEY') }).slots(1);
const smokeHost = ssh.host('smoke-host', { host: 'smoke.internal', user: 'release', key: H.env('SMOKE_SSH_KEY') }).slots(4);
const harnessStore = sqlite.store({ path: '.harness/units.sqlite' });

const smokeAttributes = z.object({ version: z.string(), platform: z.string() });
const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokeRunning = H.state('SmokeRunning', 'active');
const SmokePassed = H.state('SmokePassed', 'terminal', 'success');
const SmokeBroken = H.state('SmokeBroken', 'terminal', 'failure');
const Smoke = H.kind('Smoke')
  .attributes(smokeAttributes)
  .states(SmokeQueued, SmokeRunning, SmokePassed, SmokeBroken)
  .key(smoke => `${smoke.version}/${smoke.platform}`);

const smokeLabAttachOrStart = H.command('smoke-lab-attach-or-start')
  .input(smokeAttributes)
  .argv(input => ['smoke-lab', 'run', '--job', `release-${input.version}-${input.platform}`, '--attach'])
  .runner(smokeHost);

const smokeFlow = H.flow('smoke')
  .input(smokeAttributes)
  .step('smoke', smokeLabAttachOrStart, ctx => ({ version: ctx.unit.attributes.version, platform: ctx.unit.attributes.platform }), { restart: 'rerun' })
  .exit('passed', ctx => ctx.steps.smoke.exitCode === 0)
  .exit('broken');

const smokeLane = H.lane('smoke', Smoke)
  .store(harnessStore)
  .handler(smokeFlow, {
    exits: { passed: SmokePassed, broken: SmokeBroken },
    during: { smoke: SmokeRunning },
  });

const releaseAttributes = z.object({
  version: z.string(),
  channel: z.string(),
  platforms: z.array(z.string()),
});

const ReleaseQueued = H.state('ReleaseQueued', 'pending');
const Building = H.state('Building', 'active');
const Announcing = H.state('Announcing', 'active');
const Reviewing = H.state('Reviewing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Summarizing = H.state('Summarizing', 'active');
const SmokeTesting = H.state('SmokeTesting', 'waiting');
const Released = H.state('Released', 'terminal', 'success');
const Rejected = H.state('Rejected', 'terminal', 'failure');
const SmokeFailed = H.state('SmokeFailed', 'terminal', 'failure');
const ReleaseFailed = H.state('ReleaseFailed', 'terminal', 'failure');

const Release = H.kind('Release')
  .attributes(releaseAttributes)
  .states(ReleaseQueued, Building, Announcing, Reviewing, AwaitingApproval, Summarizing, SmokeTesting, Released, Rejected, SmokeFailed, ReleaseFailed)
  .key(release => release.version);

const buildRelease = H.command('build-release')
  .input(z.object({ version: z.string() }))
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .runner(buildHost);

const announcement = z.object({ version: z.string(), channel: z.string() });

const announceRelease = H.command('announce-release')
  .input(announcement)
  .argv(input => ['post-announcement', '--channel', input.channel, '--version', input.version])
  .runner(buildHost);

const announcementPosted = H.command('announcement-posted')
  .input(announcement)
  .argv(input => ['find-announcement', '--channel', input.channel, '--version', input.version, '--json'])
  .output(z.object({ done: z.boolean() }))
  .runner(buildHost);

const releaseReviewerRole = H.role('release-reviewer').intents('read', 'search').instructions('Review the release diff and changelog. List concerns that should block the release.');
const releaseReviewer = H.agent('release-reviewer')
  .role(releaseReviewerRole)
  .model(reviewModel)
  .output(z.object({ ready: z.boolean(), concerns: z.array(z.string()) }));

const notesWriterRole = H.role('release-notes-writer').intents('read').instructions('Write release notes for the given audience.');
const notesWriter = H.agent('release-notes-writer').role(notesWriterRole).model(summaryModel);

const releaseFlow = H.flow('release')
  .input(releaseAttributes)
  .step('build', buildRelease, ctx => ({ version: ctx.unit.attributes.version }), {
    restart: 'rerun',
    retry: H.retry({ maxAttempts: 3, backoff: 'exponential', initialDelayMs: 30_000 }),
  })
  .step('announce', announceRelease, ctx => ({ version: ctx.unit.attributes.version, channel: ctx.unit.attributes.channel }), {
    restart: { parkUnless: announcementPosted },
  })
  .step('review', releaseReviewer, ctx => ({ task: `Review release ${ctx.unit.attributes.version}` }), { restart: 'ask' })
  .halt('approval', {
    ask: ctx => `Approve release ${ctx.unit.attributes.version}? Reviewer ready: ${ctx.steps.review.ready}. Concerns: ${ctx.steps.review.concerns.join('; ') || 'none'}`,
    decision: z.object({ approved: z.boolean(), notes: z.string() }),
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('summarize', notesWriter.batch(), ctx => [
    { task: `Release notes for users of ${ctx.unit.attributes.version}` },
    { task: `Release notes for operators of ${ctx.unit.attributes.version}` },
    { task: `Release notes for support staff of ${ctx.unit.attributes.version}` },
  ])
  .spawn('smoke', smokeLane, ctx => ctx.unit.attributes.platforms.map(platform => ({ version: ctx.unit.attributes.version, platform })))
  .exit('released', ctx => ctx.steps.smoke.every(child => child.verdict === 'success'))
  .exit('smokeFailed');

const releaseLane = H.lane('releases', Release)
  .supply(H.operator)
  .store(harnessStore)
  .handler(releaseFlow, {
    exits: { rejected: Rejected, released: Released, smokeFailed: SmokeFailed },
    during: {
      build: Building,
      announce: Announcing,
      review: Reviewing,
      approval: AwaitingApproval,
      summarize: Summarizing,
      smoke: SmokeTesting,
    },
    failure: ReleaseFailed,
  });

export const harness = H.harness('release')
  .ledger(sqlite.ledger({ path: '.harness/release.sqlite' }))
  .pools(subscriptionPool, apiPool)
  .lanes(releaseLane, smokeLane)
  .scheduler(H.scheduler('release').priority(smokeLane, releaseLane).wip(releaseLane, 1))
  .clients(claudeCode.supervisor('release-manager', {
    grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.blockersResolve, H.ops.telemetryRead],
  }))
  .observers(markdown.board({ path: 'BOARD.md' }), markdown.telemetry({ path: 'TELEMETRY.md' }));

export const running = harness.start();
