import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as anthropic from 'harness-dsl/anthropic';
import * as slack from 'harness-dsl/slack';
import * as claudeCode from 'harness-dsl/claude-code';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const releaseApi = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = anthropic.model('claude-sonnet-4');
const batchHaiku = anthropic.model('claude-haiku-4', { batch: true });
const shell = local.shell({ slots: 4 });

const SmokeQueued = H.state('smoke-queued', 'pending');
const SmokeRunning = H.state('smoke-running', 'active');
const SmokePassed = H.state('smoke-passed', 'terminal', 'success');
const SmokeBroken = H.state('smoke-broken', 'terminal', 'failure');

const Smoke = H.work('smoke')
  .attributes({ version: z.string(), platform: z.string() })
  .states([SmokeQueued, SmokeRunning, SmokePassed, SmokeBroken])
  .key(smoke => `${smoke.attributes.version}/${smoke.attributes.platform}`);

const smokeTest = H.command('smoke-test', ['bin/smoke-test']);

const smokeFlow = H.flow('smoke-test')
  .requires({ version: z.string(), platform: z.string() })
  .mark('running')
  .step('smoke', smokeTest, c => ({ args: [c.input.version, c.input.platform] }), { effect: 'repeatable' })
  .ends(['passed', 'broken'], c => (c.out.smoke.exitCode === 0 ? 'passed' : 'broken'));

const smokeLane = H.lane('smoke', Smoke)
  .store(sqlite.store(Smoke, 'state/smoke.db'))
  .runner(shell)
  .handler(smokeFlow, { states: { running: SmokeRunning, passed: SmokePassed, broken: SmokeBroken, failed: SmokeBroken } });

const Requested = H.state('requested', 'pending');
const Releasing = H.state('releasing', 'active');
const Released = H.state('released', 'terminal', 'success');
const RejectedByManager = H.state('rejected-by-manager', 'terminal', 'neutral');
const SmokeFailed = H.state('smoke-failed', 'terminal', 'failure');
const ReleaseFailed = H.state('release-failed', 'terminal', 'failure');

const Release = H.work('release')
  .attributes({ version: z.string() })
  .fields({ platforms: z.array(z.string()), notes: z.string() })
  .states([Requested, Releasing, Released, RejectedByManager, SmokeFailed, ReleaseFailed])
  .key(release => release.attributes.version);

const build = H.command('build', ['bin/build']);
const releaseChannel = { token: H.env('SLACK_TOKEN'), channel: '#releases' };
const announce = slack.post('release-announcement', releaseChannel);
const announcementPosted = slack.find('release-announcement-posted', releaseChannel);

const releaseReviewer = H.role('release-reviewer')
  .intents(['read', 'execute'])
  .instructions('Review the build output and the release notes; list concerns a release manager must see.')
  .input({ version: z.string(), notes: z.string(), build: z.string() })
  .output({ verdict: z.string(), concerns: z.array(z.string()) });

const releaseSummarizer = H.role('release-summarizer')
  .intents(['read'])
  .instructions('Write the public release summary from the notes and the review.')
  .input({ version: z.string(), notes: z.string(), review: z.string() })
  .output({ summary: z.string() });

const reviewer = H.agent('release-reviewer', releaseReviewer).model(sonnet).pool(releaseApi);
const summarizer = H.agent('release-summarizer', releaseSummarizer).model(batchHaiku).pool(releaseApi);

const releaseFlow = H.flow('release')
  .requires({ version: z.string(), platforms: z.array(z.string()), notes: z.string() })
  .mark('releasing')
  .step('build', build, c => ({ args: [c.input.version] }), { effect: 'repeatable' })
  .step('announce', announce, c => ({ text: `Releasing ${c.input.version}`, dedupeKey: `release-${c.input.version}` }), {
    effect: 'unrepeatable',
    confirm: announcementPosted,
  })
  .step('review', reviewer, c => ({ version: c.input.version, notes: c.input.notes, build: c.out.build.stdout }), {
    effect: 'external',
  })
  .halt('approval', {
    ask: c => `Approve release ${c.input.version}?\n\n${c.out.review.verdict}\n${c.out.review.concerns.join('\n')}`,
    decision: { approved: z.boolean(), comment: z.string() },
  })
  .exit('rejected', c => !c.out.approval.approved)
  .batch('summarize', summarizer, c => [{ version: c.input.version, notes: c.input.notes, review: c.out.review.verdict }])
  .spawn('smoke', {
    outlet: 'smoke',
    child: { version: z.string(), platform: z.string() },
    items: c => c.input.platforms.map(platform => ({ version: c.input.version, platform })),
  })
  .ends(['released', 'smokeFailed'], c => (c.out.smoke.every(child => child.verdict === 'success') ? 'released' : 'smokeFailed'));

const releases = H.lane('releases', Release)
  .supply([H.supply.operator()])
  .store(sqlite.store(Release, 'state/releases.db'))
  .runner(shell)
  .handler(releaseFlow, {
    states: {
      releasing: Releasing,
      rejected: RejectedByManager,
      released: Released,
      smokeFailed: SmokeFailed,
      failed: ReleaseFailed,
    },
    spawns: {
      smoke: H.child(smokeLane, (child: { version: string; platform: string }) => ({ attributes: child })),
    },
  });

const releaseManagerAccess = H.access('release-manager').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.resolveBlocks,
  H.ops.readTelemetry,
]);

export const harness = H.harness('release')
  .ledger(sqlite.ledger('state/release-ledger.db'))
  .lanes([releases, smokeLane])
  .schedule(H.policy.schedule('releases-before-smoke', c => ({
    start: [...c.candidates].sort((a, b) => Number(b.is(releases)) - Number(a.is(releases)) || b.waitedMs - a.waitedMs),
  })))
  .clients([claudeCode.supervisor('release-desk', releaseManagerAccess, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const running = harness.start();
