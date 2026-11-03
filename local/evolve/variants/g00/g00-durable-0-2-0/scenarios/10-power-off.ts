import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const releaseBox = local.runner('release-box').slots(2);

const releaseAttributes = z.object({
  version: z.string(),
  commit: z.string(),
  channel: z.string(),
  platforms: z.array(z.string()),
});

const Requested = H.state('Requested', 'pending');
const Building = H.state('Building', 'active');
const Announcing = H.state('Announcing', 'active');
const Reviewing = H.state('Reviewing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Summarizing = H.state('Summarizing', 'active');
const Smoking = H.state('Smoking', 'active');
const Released = H.terminal('Released', 'success');
const SmokeFailed = H.terminal('SmokeFailed', 'failure');
const Rejected = H.terminal('Rejected', 'neutral');
const Withdrawn = H.terminal('Withdrawn', 'neutral');

const Release = H.kind('Release')
  .attributes(releaseAttributes)
  .states(Requested, Building, Announcing, Reviewing, AwaitingApproval, Summarizing, Smoking, Released, SmokeFailed, Rejected, Withdrawn)
  .key(release => release.version)
  .initial(Requested)
  .onCancelled(Withdrawn);

const smokeAttributes = z.object({ version: z.string(), platform: z.string() });

const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokeTesting = H.state('SmokeTesting', 'active');
const SmokePassed = H.terminal('SmokePassed', 'success');
const SmokeBroken = H.terminal('SmokeBroken', 'failure');

const Smoke = H.kind('Smoke')
  .attributes(smokeAttributes)
  .states(SmokeQueued, SmokeTesting, SmokePassed, SmokeBroken)
  .key(smoke => `${smoke.version}/${smoke.platform}`)
  .initial(SmokeQueued);

const smokeTest = H.command('smoke-test')
  .input(smokeAttributes)
  .argv(input => ['./scripts/smoke', '--version', input.version, '--platform', input.platform])
  .acceptExitCodes(0, 1)
  .runner(releaseBox);

const smokeFlow = H.flow('smoke')
  .input(smokeAttributes)
  .step('test', smokeTest, ctx => ({ version: ctx.unit.attributes.version, platform: ctx.unit.attributes.platform }), {
    afterCrash: 'rerun',
  })
  .exit('passed', ctx => ctx.steps.test.exitCode === 0)
  .exit('broken');

const smoke = H.lane('smoke', Smoke)
  .handler(smokeFlow, { exits: { passed: SmokePassed, broken: SmokeBroken }, during: { test: SmokeTesting } });

const build = H.command('build')
  .input(z.object({ commit: z.string() }))
  .argv(input => ['make', 'release', `COMMIT=${input.commit}`])
  .runner(releaseBox);

const announcementInput = z.object({ channel: z.string(), version: z.string() });

const announce = H.command('announce')
  .input(announcementInput)
  .argv(input => ['./scripts/announce', '--channel', input.channel, '--version', input.version])
  .runner(releaseBox);

const announcementPosted = H.command('announcement-posted')
  .input(announcementInput)
  .argv(input => ['./scripts/announce', '--check', '--channel', input.channel, '--version', input.version])
  .output(z.boolean())
  .runner(releaseBox);

const reviewer = H.role('release-reviewer')
  .intents('read', 'search')
  .instructions('Review the release build output and changes. Say ship or hold, with reasons.');

const writer = H.role('changelog-writer')
  .intents('read')
  .instructions('Write the public release summary.');

const subscription = claudeCode.subscription('release-max', { token: H.env('CLAUDE_RELEASE_TOKEN') });
const apiAccount = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const reviewerAgent = H.agent('release-reviewer')
  .role(reviewer)
  .model(claudeCode.model('opus', { id: 'claude-opus-4-1' }))
  .pool(H.pool('release-subscription').accounts(subscription))
  .output(z.object({ verdict: z.enum(['ship', 'hold']), notes: z.string() }));

const summarizer = H.agent('release-summarizer')
  .role(writer)
  .model(anthropic.model('haiku', { id: 'claude-haiku-4-5' }))
  .pool(H.pool('release-api').accounts(apiAccount))
  .output(z.object({ summary: z.string() }));

const releaseFlow = H.flow('release')
  .input(releaseAttributes)
  .step('build', build, ctx => ({ commit: ctx.unit.attributes.commit }), { afterCrash: 'rerun' })
  .step('announce', announce, ctx => ({ channel: ctx.unit.attributes.channel, version: ctx.unit.attributes.version }), {
    afterCrash: 'park',
    alreadyDone: announcementPosted,
  })
  .step(
    'review',
    reviewerAgent,
    ctx => ({
      task: `Review release ${ctx.unit.attributes.version} at ${ctx.unit.attributes.commit}.\n\nBuild output:\n${ctx.steps.build.stdout}`,
    }),
    { afterCrash: 'askDriver' },
  )
  .halt('approval', {
    ask: ctx => `Approve release ${ctx.unit.attributes.version}? Reviewer says ${ctx.steps.review.verdict}: ${ctx.steps.review.notes}`,
    decision: z.object({ approve: z.boolean(), note: z.string() }),
  })
  .exit('rejected', ctx => !ctx.steps.approval.approve)
  .step('summarize', summarizer.batch(), ctx => [
    {
      task: `Summarize release ${ctx.unit.attributes.version} for the changelog. Review notes: ${ctx.steps.review.notes}`,
    },
  ])
  .spawn('smoke', smoke, ctx =>
    ctx.unit.attributes.platforms.map(platform => ({ version: ctx.unit.attributes.version, platform })),
  )
  .exit('released', ctx => ctx.steps.smoke.every(child => child.verdict === 'success'))
  .exit('smokeFailed');

const releases = H.lane('releases', Release)
  .supply(H.operator)
  .store(sqlite.store({ path: '.harness/releases.sqlite' }))
  .handler(releaseFlow, {
    exits: { rejected: Rejected, released: Released, smokeFailed: SmokeFailed },
    during: {
      build: Building,
      announce: Announcing,
      review: Reviewing,
      approval: AwaitingApproval,
      summarize: Summarizing,
      smoke: Smoking,
    },
  });

const releaseManager = claudeCode.supervisor('release-manager', {
  grants: [
    H.ops.workRead,
    H.ops.workCreate,
    H.ops.workCancel,
    H.ops.blockersResolve,
    H.ops.attemptsRecover,
    H.ops.telemetryRead,
  ],
});

const release = H.harness('release')
  .ledger(sqlite.ledger({ path: '.harness/ledger.sqlite' }))
  .lanes(releases, smoke)
  .scheduler(H.scheduler('release').priority(releases, smoke))
  .clients(releaseManager)
  .observers(markdown.board({ path: '.harness/board.md' }), markdown.telemetry({ path: '.harness/telemetry.md' }));

void release.start();
