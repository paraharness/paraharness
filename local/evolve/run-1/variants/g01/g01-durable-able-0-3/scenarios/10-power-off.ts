import { z } from 'zod';
import { H } from 'harness-dsl';
import { claudeCode } from 'harness-dsl/claude-code';
import { anthropic } from 'harness-dsl/anthropic';
import { sqlite } from 'harness-dsl/sqlite';
import { ssh } from 'harness-dsl/ssh';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const subscription = claudeCode.subscription('release-subscription', { token: H.env('CLAUDE_TOKEN') });
const apiAccount = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const reviewModel = claudeCode.model('opus-session', { id: 'claude-opus-4' });
const batchModel = anthropic.model('haiku-batch', { id: 'claude-haiku-4' });

const buildHost = ssh.host('build-host', { host: 'build.internal', user: 'release', key: H.env('BUILD_SSH_KEY') }).slots(1);
const smokeRunner = local.runner('smoke-local').slots(4);

const smokeAttrs = z.object({ version: z.string(), platform: z.string() });

const SmokeQueued = H.state('queued', 'pending');
const SmokeRunning = H.state('running', 'active');
const SmokePassed = H.state('passed', 'terminal', 'success');
const SmokeBroken = H.state('broken', 'terminal', 'failure');
const SmokeCancelled = H.state('cancelled', 'terminal', 'neutral');

const Smoke = H.kind('Smoke')
  .attributes(smokeAttrs)
  .states(SmokeQueued, SmokeRunning, SmokePassed, SmokeBroken, SmokeCancelled)
  .key((smoke) => `${smoke.version}/${smoke.platform}`);

const smokeTest = H.command('smoke-test')
  .input(smokeAttrs)
  .argv((input) => ['smoke', '--version', input.version, '--platform', input.platform])
  .runner(smokeRunner);

const smokeFlow = H.flow('smoke')
  .input(smokeAttrs)
  .step('test', smokeTest, (ctx) => ({ version: ctx.unit.attributes.version, platform: ctx.unit.attributes.platform }), { afterCrash: 'rerun' })
  .exit('passed', (ctx) => ctx.steps.test.exitCode === 0)
  .exit('broken');

const smoke = H.lane('smoke', Smoke)
  .handler(smokeFlow, {
    exits: { passed: SmokePassed, broken: SmokeBroken },
    during: { test: SmokeRunning },
    failure: SmokeBroken,
  })
  .on(H.cancel, { enter: SmokeCancelled });

const releaseAttrs = z.object({ version: z.string(), channel: z.string(), platforms: z.array(z.string()) });

const Requested = H.state('requested', 'pending');
const Building = H.state('building', 'active');
const Announcing = H.state('announcing', 'active');
const Reviewing = H.state('reviewing', 'active');
const AwaitingApproval = H.state('awaitingApproval', 'active');
const Summarizing = H.state('summarizing', 'active');
const AwaitingSmoke = H.state('awaitingSmoke', 'waiting');
const Released = H.state('released', 'terminal', 'success');
const Rejected = H.state('rejected', 'terminal', 'neutral');
const SmokeFailed = H.state('smokeFailed', 'terminal', 'failure');
const ReleaseFailed = H.state('failed', 'terminal', 'failure');
const ReleaseCancelled = H.state('cancelled', 'terminal', 'neutral');

const Release = H.kind('Release')
  .attributes(releaseAttrs)
  .states(Requested, Building, Announcing, Reviewing, AwaitingApproval, Summarizing, AwaitingSmoke, Released, Rejected, SmokeFailed, ReleaseFailed, ReleaseCancelled)
  .key((release) => release.version);

const build = H.command('build-release')
  .input(z.object({ version: z.string() }))
  .argv((input) => ['make', 'release', `VERSION=${input.version}`])
  .runner(buildHost);

const announcement = z.object({ version: z.string(), channel: z.string() });

const announce = H.command('announce-release')
  .input(announcement)
  .argv((input) => ['announce', '--channel', input.channel, '--version', input.version])
  .runner(buildHost);

const announcementPosted = H.command('announcement-posted')
  .input(announcement)
  .argv((input) => ['announce', '--check', '--channel', input.channel, '--version', input.version])
  .output(z.boolean())
  .runner(buildHost);

const releaseReviewer = H.role('release-reviewer').intents('read', 'search').instructions('Review the release diff and list concerns.');
const summaryWriter = H.role('summary-writer').intents('read').instructions('Write release notes for users.');

const review = H.agent('release-review')
  .role(releaseReviewer)
  .model(reviewModel)
  .output(z.object({ concerns: z.array(z.string()) }))
  .budgetTokens(200000);

const summarizer = H.agent('release-summary').role(summaryWriter).model(batchModel).budgetTokens(20000);

const releaseFlow = H.flow('release')
  .input(releaseAttrs)
  .step('build', build, (ctx) => ({ version: ctx.unit.attributes.version }), {
    afterCrash: 'rerun',
    retry: { retries: 2, backoff: 'exponential', initialDelayMs: 60000 },
  })
  .step('announce', announce, (ctx) => ({ version: ctx.unit.attributes.version, channel: ctx.unit.attributes.channel }), {
    afterCrash: { parkUnless: announcementPosted },
  })
  .step('review', review, (ctx) => ({ task: `Review release ${ctx.unit.attributes.version}.` }), { afterCrash: 'ask' })
  .halt('approval', {
    ask: (ctx) => `Approve release ${ctx.unit.attributes.version}? Review concerns: ${ctx.steps.review.concerns.join('; ') || 'none'}`,
    decision: z.object({ approved: z.boolean(), note: z.string() }),
  })
  .exit('rejected', (ctx) => !ctx.steps.approval.approved)
  .step('summarize', summarizer.batch(), (ctx) => [
    { task: `Release notes for ${ctx.unit.attributes.version}. Approver note: ${ctx.steps.approval.note}` },
  ])
  .spawn('smoke', smoke, (ctx) => ctx.unit.attributes.platforms.map((platform) => ({ version: ctx.unit.attributes.version, platform })))
  .exit('released', (ctx) => ctx.steps.smoke.every((child) => child.verdict === 'success'))
  .exit('smokeFailed');

const releases = H.lane('releases', Release)
  .supply(H.operator)
  .handler(releaseFlow, {
    exits: { rejected: Rejected, released: Released, smokeFailed: SmokeFailed },
    waits: { smoke: AwaitingSmoke },
    during: { build: Building, announce: Announcing, review: Reviewing, approval: AwaitingApproval, summarize: Summarizing },
    failure: ReleaseFailed,
  })
  .on(H.cancel, { enter: ReleaseCancelled });

export const release = H.harness('release')
  .ledger(sqlite.ledger({ path: 'state/ledger.sqlite' }))
  .pool(H.pool('release-pool').accounts(subscription, apiAccount))
  .lanes(releases, smoke)
  .scheduler(H.scheduler('release-scheduler').priority(releases, smoke).wip(releases, 1))
  .clients(claudeCode.supervisor('release-desk', {
    grants: [H.ops.workRead, H.ops.workCreate, H.ops.workCancel, H.ops.blockersResolve, H.ops.telemetryRead],
  }))
  .observers(markdown.board({ path: 'board.md' }), markdown.telemetry({ path: 'telemetry.md' }));
