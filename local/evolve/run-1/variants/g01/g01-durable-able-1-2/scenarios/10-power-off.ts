import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as slack from 'harness-dsl/slack';
import * as http from 'harness-dsl/http';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const Requested = H.state('Requested', 'pending');
const Releasing = H.state('Releasing', 'active');
const Released = H.state('Released', 'terminal', 'success');
const RejectedByManager = H.state('RejectedByManager', 'terminal', 'neutral');
const SmokeRed = H.state('SmokeRed', 'terminal', 'failure');
const ReleaseFailed = H.state('ReleaseFailed', 'terminal', 'failure');

const Release = H.work('Release')
  .attributes({ version: z.string(), channel: z.string() })
  .states([Requested, Releasing, Released, RejectedByManager, SmokeRed, ReleaseFailed])
  .key(u => u.attributes.version);

const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokeRunning = H.state('SmokeRunning', 'active');
const SmokePassed = H.state('SmokePassed', 'terminal', 'success');
const SmokeFailed = H.state('SmokeFailed', 'terminal', 'failure');

const Smoke = H.work('Smoke')
  .attributes({ version: z.string(), platform: z.string() })
  .states([SmokeQueued, SmokeRunning, SmokePassed, SmokeFailed])
  .key(u => `${u.attributes.version}:${u.attributes.platform}`);

const subscription = claudeCode.subscription('release-max', { configDir: H.env('CLAUDE_RELEASE_DIR') });
const apiAccount = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const build = H.command('build', ['make', 'release']).parses({ artifact: z.string(), log: z.string() });
const announce = slack.notify('announceRelease', { webhookUrl: H.env('SLACK_RELEASES_WEBHOOK') });
const announcementPosted = H.command('announcementPosted', ['bin/find-announcement', '--json']).parses({ done: z.boolean() });
const smokeTest = H.command('smokeTest', ['bin/smoke', '--json']).parses({ passed: z.boolean(), report: z.string() });

const reviewerRole = H.role('releaseReviewer')
  .intents(['read', 'search'])
  .instructions('Review the release build log and the diff since the last release. List concrete concerns only.')
  .input({ version: z.string(), buildLog: z.string() })
  .output({ approve: z.boolean(), concerns: z.array(z.string()) });

const notesRole = H.role('releaseNotes')
  .intents(['read'])
  .instructions('Write the release notes for users, mentioning resolved concerns.')
  .input({ version: z.string(), concerns: z.array(z.string()) })
  .output({ notes: z.string() });

const reviewer = H.agent('releaseReviewer', reviewerRole).model(claudeCode.model('claude-opus-4-1')).pool(subscription);
const notesWriter = H.agent('releaseNotesWriter', notesRole)
  .model(anthropic.model('claude-sonnet-4-5', { batch: true }))
  .pool(apiAccount);

const releaseApproval = H.decision('releaseApproval', { approved: z.boolean(), note: z.string() });

const platforms = ['linux', 'macos', 'windows'];

const releaseFlow = H.flow('release')
  .requires({ version: z.string(), channel: z.string() })
  .step('build', build, c => ({ args: [c.input.version] }), {
    restart: 'rerun',
    retry: H.retry.exponential({ maxRetries: 2, initialDelayMs: 30000 }),
  })
  .step('announce', announce, c => ({ text: `Release ${c.input.version} is on its way to ${c.input.channel}.` }), {
    restart: { probe: announcementPosted },
  })
  .step('review', reviewer, c => ({ version: c.input.version, buildLog: c.out.build.data.log }), { restart: 'ask' })
  .halt('approval', releaseApproval, {
    ask: c => `Ship ${c.input.version}? Reviewer concerns: ${c.out.review.concerns.length === 0 ? 'none' : c.out.review.concerns.join('; ')}`,
  })
  .exit('rejected', c => !c.out.approval.approved)
  .batch('summarize', notesWriter, c => [{ version: c.input.version, concerns: c.out.review.concerns }])
  .spawn('smoke', {
    outlet: 'smoke',
    child: { version: z.string(), platform: z.string() },
    items: c => platforms.map(platform => ({ version: c.input.version, platform })),
  })
  .ends(['released', 'smokeFailed'], c => (c.out.smoke.every(child => child.verdict === 'success') ? 'released' : 'smokeFailed'));

const smokeFlow = H.flow('smoke')
  .requires({ version: z.string(), platform: z.string() })
  .step('run', smokeTest, c => ({ args: [c.input.version, c.input.platform] }), { restart: 'rerun' })
  .ends(['passed', 'broken'], c => (c.out.run.data.passed ? 'passed' : 'broken'));

const shell = local.shell({ slots: 3 });

const smoke = H.lane('smoke', Smoke)
  .runner(shell)
  .wip(3)
  .handler(smokeFlow, { states: { passed: SmokePassed, broken: SmokeFailed, failed: SmokeFailed } });

const releases = H.lane('releases', Release)
  .supply([H.supply.operator()])
  .runner(shell)
  .wip(1)
  .handler(releaseFlow, {
    states: { released: Released, rejected: RejectedByManager, smokeFailed: SmokeRed, failed: ReleaseFailed },
    spawns: { smoke: child => smoke.unit({ attributes: { version: child.version, platform: child.platform } }) },
  });

const childrenFirst = H.policy.schedule('childrenFirst', c => {
  const tier = (x: (typeof c.candidates)[number]) => (x.is(smoke) ? 0 : 1);
  return { start: [...c.candidates].sort((a, b) => tier(a) - tier(b) || b.waitedMs - a.waitedMs) };
});

const releaseDesk = H.access('releaseDesk').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readTelemetry,
]);

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('.harness/release.sqlite'))
  .lanes([releases, smoke])
  .schedule(childrenFirst)
  .clients([
    claudeCode.supervisor('releaseSupervisor', releaseDesk, { port: H.slot.port(0) }),
    http.server('releaseManagers', releaseDesk, { port: H.slot.port(1), token: H.env('RELEASE_CONTROL_TOKEN') }),
  ])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);
