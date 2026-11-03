import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as local from 'harness-dsl/local';
import * as slack from 'harness-dsl/slack';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';

const Requested = H.state('Requested', 'pending');
const Releasing = H.state('Releasing', 'active');
const Released = H.state('Released', 'terminal', 'success');
const SmokeFailed = H.state('SmokeFailed', 'terminal', 'failure');
const Rejected = H.state('Rejected', 'terminal', 'neutral');

const Release = H.work('Release')
  .attributes({ version: z.string(), channel: z.string() })
  .states([Requested, Releasing, Released, SmokeFailed, Rejected])
  .key(u => u.attributes.version);

const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokeRunning = H.state('SmokeRunning', 'active');
const SmokePassed = H.state('SmokePassed', 'terminal', 'success');
const SmokeBroken = H.state('SmokeBroken', 'terminal', 'failure');

const Smoke = H.work('Smoke')
  .attributes({ version: z.string(), platform: z.string() })
  .states([SmokeQueued, SmokeRunning, SmokePassed, SmokeBroken])
  .onFailure(SmokeBroken)
  .key(u => `${u.attributes.version}/${u.attributes.platform}`);

const api = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const reviewModel = anthropic.model('claude-sonnet-4-5');
const summaryModel = anthropic.model('claude-haiku-4-5', { batch: true });

const releaseReviewerRole = H.role('release-reviewer')
  .intents(['read'])
  .instructions('Review the build log for release blockers.')
  .input({ version: z.string(), buildLog: z.string() })
  .output({ blockers: z.array(z.string()), notes: z.string() });
const releaseReviewer = H.agent('release-reviewer', releaseReviewerRole).model(reviewModel).pool(api);

const summarizerRole = H.role('release-summarizer')
  .intents(['read'])
  .instructions('Write the public release summary.')
  .input({ version: z.string(), review: z.string() })
  .output({ summary: z.string() });
const summarizer = H.agent('release-summarizer', summarizerRole).model(summaryModel).pool(api);

const buildRelease = H.command('build-release', ['make', 'release']);
const announcement = slack.notify('release-announcement', { webhookUrl: H.env('SLACK_RELEASE_WEBHOOK') });
const announcementPosted = H.command('announcement-posted', ['scripts/announcement-posted.sh'])
  .parses({ done: z.boolean() });
const releaseApproval = H.decision('release-approval', { approved: z.boolean(), note: z.string() });
const smokeTest = H.command('smoke-test', ['scripts/smoke-test.sh']);

const platforms = ['linux', 'macos', 'windows'];

const releaseFlow = H.flow('release')
  .requires({ version: z.string(), channel: z.string() })
  .step('build', buildRelease, c => ({ args: [c.input.version] }), { restart: 'rerun' })
  .step('announce', announcement, c => ({ text: `Release ${c.input.version} is being prepared for ${c.input.channel}.` }), {
    restart: { probe: announcementPosted },
  })
  .step('review', releaseReviewer, c => ({ version: c.input.version, buildLog: c.out.build.stdout }), { restart: 'ask' })
  .halt('approval', releaseApproval, {
    ask: c => `Approve release ${c.input.version}? Blockers: ${c.out.review.blockers.length}. ${c.out.review.notes}`,
  })
  .exit('rejected', c => !c.out.approval.approved)
  .batch('summarize', summarizer, c => [{ version: c.input.version, review: c.out.review.notes }])
  .spawn('smoke', {
    outlet: 'platform',
    child: { version: z.string(), platform: z.string() },
    items: c => platforms.map(platform => ({ version: c.input.version, platform })),
  })
  .ends(['released', 'smokeFailed'], c => (c.out.smoke.every(child => child.verdict === 'success') ? 'released' : 'smokeFailed'));

const smokeFlow = H.flow('smoke')
  .requires({ version: z.string(), platform: z.string() })
  .step('test', smokeTest, c => ({ args: [c.input.version, c.input.platform] }), { restart: 'rerun' })
  .ends(['passed'], () => 'passed');

const smoke = H.lane('smoke', Smoke)
  .runner(local.shell({ slots: 3 }))
  .handler(smokeFlow, { outcomes: { passed: SmokePassed } });

const releases = H.lane('releases', Release)
  .supply([H.supply.operator()])
  .runner(local.shell({ slots: 1 }))
  .handler(releaseFlow, {
    outcomes: { rejected: Rejected, released: Released, smokeFailed: SmokeFailed },
    spawns: {
      platform: child => smoke.unit({ attributes: { version: child.version, platform: child.platform } }),
    },
  });

const releaseManagerAccess = H.access('release-manager').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readTelemetry,
]);

export const harness = H.harness('release')
  .ledger(sqlite.ledger('.harness/release.db'))
  .lanes([releases, smoke])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const control = H.control('release-control', harness)
  .clients([claudeCode.supervisor('release-manager', releaseManagerAccess, { port: H.slot.port(0) })]);

export async function main(): Promise<void> {
  await harness.start();
  await control.serve();
}
