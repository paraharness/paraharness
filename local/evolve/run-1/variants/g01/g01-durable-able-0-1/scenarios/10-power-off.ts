import { z } from 'zod';
import { H } from 'harness-dsl';
import { sqlite } from 'harness-dsl/sqlite';
import { anthropic } from 'harness-dsl/anthropic';
import { claudeCode } from 'harness-dsl/claude-code';
import { local } from 'harness-dsl/local';
import { markdown } from 'harness-dsl/markdown';

const releaseBox = local.runner('release-box').slots(2);
const linuxBox = local.runner('smoke-linux');
const macBox = local.runner('smoke-macos');
const windowsBox = local.runner('smoke-windows');

const releaseSubscription = claudeCode.subscription('release-max', { token: H.env('CLAUDE_RELEASE_TOKEN') });
const reviewModel = claudeCode.model('release-opus', { id: 'claude-opus-4-1' });
const batchAccount = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const summaryModel = anthropic.model('release-haiku', { id: 'claude-haiku-4-5' });

const ReleaseAttributes = z.object({ version: z.string(), commit: z.string() });
const Platform = z.enum(['linux', 'macos', 'windows']);
const platforms: readonly z.infer<typeof Platform>[] = ['linux', 'macos', 'windows'];
const SmokeAttributes = z.object({ version: z.string(), platform: Platform });

const Requested = H.state('requested', 'pending');
const Building = H.state('building', 'active');
const Announcing = H.state('announcing', 'active');
const Reviewing = H.state('reviewing', 'active');
const AwaitingApproval = H.state('awaiting-approval', 'waiting');
const Summarizing = H.state('summarizing', 'active');
const Smoking = H.state('smoking', 'waiting');
const Released = H.state('released', 'terminal', 'success');
const Rejected = H.state('rejected', 'terminal', 'failure');
const SmokeFailed = H.state('smoke-failed', 'terminal', 'failure');
const Broken = H.state('broken', 'terminal', 'failure');
const Withdrawn = H.state('withdrawn', 'terminal', 'neutral');

const Release = H.kind('Release')
  .attributes(ReleaseAttributes)
  .states(Requested, Building, Announcing, Reviewing, AwaitingApproval, Summarizing, Smoking, Released, Rejected, SmokeFailed, Broken, Withdrawn)
  .key(r => r.version);

const SmokeQueued = H.state('smoke-queued', 'pending');
const SmokeRunning = H.state('smoke-running', 'active');
const SmokePassed = H.state('smoke-passed', 'terminal', 'success');
const SmokeBroken = H.state('smoke-broken', 'terminal', 'failure');

const Smoke = H.kind('Smoke')
  .attributes(SmokeAttributes)
  .states(SmokeQueued, SmokeRunning, SmokePassed, SmokeBroken)
  .key(s => `${s.version}:${s.platform}`);

const smokeTest = H.command('smoke-test')
  .input(SmokeAttributes)
  .argv(input => ['smoke', input.version, input.platform])
  .runner(input => (input.platform === 'linux' ? linuxBox : input.platform === 'macos' ? macBox : windowsBox));

const smokeFlow = H.flow('smoke')
  .input(SmokeAttributes)
  .step('smoke', smokeTest, ctx => ctx.unit.attributes, { onCrash: 'rerun' })
  .exit('passed');

const smoke = H.lane('smoke', Smoke)
  .store(sqlite.store({ path: 'state/smoke.db' }))
  .handler(smokeFlow, { exits: { passed: SmokePassed }, during: { smoke: SmokeRunning }, failure: SmokeBroken });

const build = H.command('build')
  .input(ReleaseAttributes)
  .argv(input => ['make', 'release', `VERSION=${input.version}`, `COMMIT=${input.commit}`])
  .runner(releaseBox);

const announcementPosted = H.command('announcement-posted')
  .input(ReleaseAttributes)
  .argv(input => ['channel-history', '--channel', 'releases', '--contains', `Release ${input.version}`])
  .output(z.boolean())
  .runner(releaseBox);

const announce = H.command('announce')
  .input(ReleaseAttributes)
  .argv(input => ['channel-post', '--channel', 'releases', '--text', `Release ${input.version} is being prepared.`])
  .check(announcementPosted)
  .runner(releaseBox);

const releaseReviewer = H.role('release-reviewer')
  .intents('read', 'search')
  .instructions('Review the release diff for risk: migrations, breaking API changes, missing changelog entries.');
const changelogWriter = H.role('changelog-writer')
  .intents('read')
  .instructions('Write the user-facing changelog for the release.');

const reviewAgent = H.agent('release-review')
  .role(releaseReviewer)
  .model(reviewModel)
  .output(z.object({ risk: z.enum(['low', 'medium', 'high']), notes: z.string() }));

const changelogAgent = H.agent('changelog')
  .role(changelogWriter)
  .model(summaryModel)
  .output(z.object({ changelog: z.string() }));

const releaseFlow = H.flow('release')
  .input(ReleaseAttributes)
  .step('build', build, ctx => ctx.unit.attributes, { onCrash: 'rerun' })
  .step('announce', announce, ctx => ctx.unit.attributes, { onCrash: 'ask' })
  .step('review', reviewAgent, ctx => ({ task: `Review release ${ctx.unit.attributes.version} at ${ctx.unit.attributes.commit}.` }))
  .halt('approval', {
    ask: ctx => `Ship ${ctx.unit.attributes.version}? Review risk ${ctx.steps.review.risk}: ${ctx.steps.review.notes}`,
    decision: z.object({ approved: z.boolean(), note: z.string() }),
  })
  .exit('rejected', ctx => !ctx.steps.approval.approved)
  .step('summarize', changelogAgent.batch(), ctx => [
    { task: `Write the changelog for ${ctx.unit.attributes.version}. Reviewer notes: ${ctx.steps.review.notes}` },
  ])
  .spawn('smoke', smoke, ctx => platforms.map(platform => ({ version: ctx.unit.attributes.version, platform })))
  .exit('released', ctx => ctx.steps.smoke.every(child => child.verdict === 'success'))
  .exit('smokeFailed');

const releases = H.lane('releases', Release)
  .supply(H.operator)
  .store(sqlite.store({ path: 'state/releases.db' }))
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
    failure: Broken,
    cancelled: Withdrawn,
  });

export const release = H.harness('release')
  .ledger(sqlite.ledger({ path: 'state/release-ledger.db' }))
  .pools(H.pool('release-subscriptions').accounts(releaseSubscription), H.pool('release-batch').accounts(batchAccount))
  .lanes(releases, smoke)
  .scheduler(H.scheduler('release-scheduler').priority(smoke, releases).wip(releases, 1).wip(smoke, 3))
  .clients(
    claudeCode.supervisor('release-manager', {
      grants: [
        H.ops.workRead,
        H.ops.workCreate,
        H.ops.workCancel,
        H.ops.blockersResolve,
        H.ops.attemptsRecover,
        H.ops.telemetryRead,
      ],
    }),
  )
  .observers(markdown.board({ path: 'board.md' }));
