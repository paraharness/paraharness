import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as slack from 'harness-dsl/slack';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const shell = local.shell({ slots: 4, cwd: 'release' });
const platforms: readonly string[] = ['linux', 'macos', 'windows'];

const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokeTesting = H.state('SmokeTesting', 'active');
const SmokePassed = H.state('SmokePassed', 'terminal', 'success');
const SmokeBroken = H.state('SmokeBroken', 'terminal', 'failure');

const Smoke = H.work('Smoke')
  .attributes({ version: z.string(), platform: z.string() })
  .states([SmokeQueued, SmokeTesting, SmokePassed, SmokeBroken])
  .key(u => `${u.attributes.version}/${u.attributes.platform}`);

const smokeTest = H.command('smoke-test', ['scripts/smoke-test.sh']).parses({ passed: z.boolean() });

const runSmoke = H.flow('run-smoke')
  .requires({ version: z.string(), platform: z.string() })
  .step('test', smokeTest, c => ({ args: [c.input.version, c.input.platform] }), { restart: 'rerun' })
  .exit('broken', c => c.out.test.data.passed === false)
  .ends(['passed'], () => 'passed');

const smoke = H.lane('smoke', Smoke)
  .runner(shell)
  .retry(H.retry.fixed({ maxRetries: 2, delayMs: 30000 }))
  .handler(runSmoke, { states: { broken: SmokeBroken, passed: SmokePassed }, opens: SmokeTesting });

const Requested = H.state('Requested', 'pending');
const Building = H.state('Building', 'active');
const Approving = H.state('Approving', 'active');
const Smoking = H.state('Smoking', 'active');
const Released = H.state('Released', 'terminal', 'success');
const SmokeFailed = H.state('SmokeFailed', 'terminal', 'failure');
const Rejected = H.state('Rejected', 'terminal', 'neutral');

const Release = H.work('Release')
  .attributes({ version: z.string() })
  .states([Requested, Building, Approving, Smoking, Released, SmokeFailed, Rejected])
  .key(u => u.attributes.version);

const build = H.command('build', ['scripts/build.sh']);
const announce = slack.notify('release-announcement', { webhookUrl: H.env('SLACK_RELEASES_WEBHOOK') });
const announcementPosted = H.command('announcement-posted', ['scripts/announcement-posted.sh']).parses({ done: z.boolean() });

const releaseReviewer = H.role('release-reviewer')
  .intents(['read'])
  .input({ version: z.string(), buildLog: z.string() })
  .output({ notes: z.string(), concerns: z.array(z.string()) });
const reviewer = H.agent('release-review', releaseReviewer)
  .model(claudeCode.model('claude-opus-4-1'))
  .pool(claudeCode.subscription('release-max', { configDir: H.env('CLAUDE_RELEASE_DIR') }));

const releaseWriter = H.role('release-writer')
  .input({ version: z.string(), review: z.string() })
  .output({ summary: z.string() });
const summarizer = H.agent('release-summary', releaseWriter)
  .model(anthropic.model('claude-haiku-4-5', { batch: true }))
  .pool(anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') }));

const releaseApproval = H.decision('release-approval', { ship: z.boolean(), note: z.string() });

const shipRelease = H.flow('ship-release')
  .requires({ version: z.string() })
  .step('build', build, c => ({ args: [c.input.version] }), { restart: 'rerun' })
  .step('announce', announce, c => ({ text: `Release ${c.input.version} is built and entering review.` }), { restart: { probe: announcementPosted } })
  .step('review', reviewer, c => ({ version: c.input.version, buildLog: c.out.build.stdout }), { restart: 'ask' })
  .mark('approving')
  .halt('approval', releaseApproval, {
    ask: c => `Ship ${c.input.version}?\n\n${c.out.review.notes}\n\nConcerns: ${c.out.review.concerns.join('; ')}`,
  })
  .exit('rejected', c => c.out.approval.ship === false)
  .batch('summarize', summarizer, c => [{ version: c.input.version, review: c.out.review.notes }])
  .mark('smoking')
  .spawn('smoke', {
    outlet: 'smoke',
    child: { version: z.string(), platform: z.string() },
    items: c => platforms.map(platform => ({ version: c.input.version, platform })),
  })
  .ends(['released', 'smokeFailed'], c => (c.out.smoke.every(child => child.verdict === 'success') ? 'released' : 'smokeFailed'));

const releases = H.lane('releases', Release)
  .supply([H.supply.operator()])
  .runner(shell)
  .wip(1)
  .retry(H.retry.fixed({ maxRetries: 1, delayMs: 60000 }))
  .handler(shipRelease, {
    states: { approving: Approving, smoking: Smoking, rejected: Rejected, released: Released, smokeFailed: SmokeFailed },
    opens: Building,
    spawns: { smoke: child => smoke.unit({ attributes: { version: child.version, platform: child.platform } }) },
  });

const releaseManager = H.access('release-manager').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readTelemetry,
]);

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes([releases, smoke])
  .schedule(H.policy.schedule('releases-then-smoke', c => ({
    start: c.order(x => (x.is(releases) ? 0 : 1), x => x.enqueuedAt),
  })))
  .clients([claudeCode.supervisor('release-supervisor', releaseManager, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const node = releaseHarness.start();
