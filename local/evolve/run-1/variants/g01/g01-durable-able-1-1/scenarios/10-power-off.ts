import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const platforms = ['linux', 'macos', 'windows'];

const api = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4-5');
const batchHaiku = anthropic.model('claude-haiku-4-5', { batch: true });
const shell = local.shell({ slots: 3, cwd: 'release' });

const RequestedRelease = H.state.pending('RequestedRelease');
const Releasing = H.state.active('Releasing');
const Released = H.state.terminal('Released', 'success');
const ReleaseRejected = H.state.terminal('ReleaseRejected', 'neutral');
const SmokeFailed = H.state.terminal('SmokeFailed', 'failure');
const ReleaseFailed = H.state.terminal('ReleaseFailed', 'failure');

const Release = H.work('Release')
  .attributes({ version: z.string() })
  .states([RequestedRelease, Releasing, Released, ReleaseRejected, SmokeFailed, ReleaseFailed])
  .key(release => release.attributes.version);

const SmokeQueued = H.state.pending('SmokeQueued');
const SmokeRunning = H.state.active('SmokeRunning');
const SmokePassed = H.state.terminal('SmokePassed', 'success');
const SmokeBroken = H.state.terminal('SmokeBroken', 'failure');

const Smoke = H.work('Smoke')
  .attributes({ version: z.string(), platform: z.string() })
  .states([SmokeQueued, SmokeRunning, SmokePassed, SmokeBroken])
  .key(smoke => `${smoke.attributes.version}:${smoke.attributes.platform}`);

const smokeTest = H.command('smoke-test', ['./bin/smoke-test']);

const smokeFlow = H.flow('smoke')
  .requires({ version: z.string(), platform: z.string() })
  .mark('testing')
  .step('run', smokeTest, c => ({ args: [c.input.version, c.input.platform] }), { onRestart: 'rerun' })
  .ends(['passed'], () => 'passed');

const smoke = H.lane('smoke', Smoke)
  .runner(shell)
  .handler(smokeFlow, { states: { testing: SmokeRunning, passed: SmokePassed, failed: SmokeBroken } });

const build = H.command('build-release', ['./bin/build-release']);
const announce = slack.notify('announce-release', { webhookUrl: H.env('RELEASE_CHANNEL_WEBHOOK') });

const releaseReviewer = H.role('release-reviewer')
  .intents(['read'])
  .instructions('Review the build log and changelog for release risks.')
  .input({ version: z.string(), buildLog: z.string() })
  .output({ verdict: z.string(), risks: z.array(z.string()) });

const releaseNotesWriter = H.role('release-notes-writer')
  .intents(['read'])
  .instructions('Write the release summary for customers.')
  .input({ version: z.string(), review: z.string(), note: z.string() })
  .output({ summary: z.string() });

const reviewer = H.agent('release-reviewer', releaseReviewer).model(sonnet).pool(api);
const summarizer = H.agent('release-summarizer', releaseNotesWriter).model(batchHaiku).pool(api);

const releaseFlow = H.flow('release')
  .requires({ version: z.string() })
  .mark('releasing')
  .step('build', build, c => ({ args: [c.input.version] }), { onRestart: 'rerun', retry: H.retry.exponential({ maxRetries: 2, initialDelayMs: 30000 }) })
  .step('announce', announce, c => ({ text: `Release ${c.input.version} is built and entering review.` }), { onRestart: 'reconcile' })
  .step('review', reviewer, c => ({ version: c.input.version, buildLog: c.out.build.stdout }), { onRestart: 'reconcile' })
  .halt('approval', {
    ask: c => `Ship ${c.input.version}?\n\n${c.out.review.verdict}\n${c.out.review.risks.join('\n')}`,
    decision: { approved: z.boolean(), note: z.string() },
  })
  .exit('rejected', c => !c.out.approval.approved)
  .batch('summarize', summarizer, c => [{ version: c.input.version, review: c.out.review.verdict, note: c.out.approval.note }])
  .spawn('smoke', {
    outlet: 'platforms',
    child: { version: z.string(), platform: z.string() },
    items: c => platforms.map(platform => ({ version: c.input.version, platform })),
  })
  .ends(['released', 'smokeFailed'], c => (c.out.smoke.every(child => child.verdict === 'success') ? 'released' : 'smokeFailed'));

const releases = H.lane('releases', Release)
  .supply([H.supply.operator()])
  .store(sqlite.store(Release, '.harness/releases.sqlite'))
  .runner(shell)
  .handler(releaseFlow, {
    states: {
      releasing: Releasing,
      rejected: ReleaseRejected,
      released: Released,
      smokeFailed: SmokeFailed,
      failed: ReleaseFailed,
    },
    spawns: {
      platforms: H.child(smoke, (child: { version: string; platform: string }) => ({
        attributes: { version: child.version, platform: child.platform },
      })),
    },
  });

const releaseManager = H.access('release-manager').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.resolveBlocks,
  H.ops.recoverAttempts,
  H.ops.readTelemetry,
]);

const releasesBeforeSmoke = H.policy.schedule('releases-before-smoke', c => ({
  start: [
    ...c.candidates.filter(candidate => candidate.is(releases)),
    ...c.candidates.filter(candidate => !candidate.is(releases)).sort((a, b) => b.waitedMs - a.waitedMs),
  ],
}));

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes([releases, smoke])
  .schedule(releasesBeforeSmoke)
  .clients([claudeCode.supervisor('release-supervisor', releaseManager, { port: H.slot.port(0) })])
  .projections([markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md')]);
