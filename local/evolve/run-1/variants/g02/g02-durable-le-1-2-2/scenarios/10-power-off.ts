import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as markdown from 'harness-dsl/markdown';
import * as local from 'harness-dsl/local';

const Requested = H.state('Requested', 'pending');
const Building = H.state('Building', 'active');
const Reviewing = H.state('Reviewing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'active');
const Summarizing = H.state('Summarizing', 'active');
const Smoking = H.state('Smoking', 'active');
const Released = H.state('Released', 'terminal', 'success');
const SmokeFailed = H.state('SmokeFailed', 'terminal', 'failure');
const Rejected = H.state('Rejected', 'terminal', 'neutral');

const Release = H.work('Release')
  .attributes({ version: z.string() })
  .fields({ notes: z.string() })
  .states([Requested, Building, Reviewing, AwaitingApproval, Summarizing, Smoking, Released, SmokeFailed, Rejected])
  .key((u) => u.attributes.version);

const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokeRunning = H.state('SmokeRunning', 'active');
const SmokePassed = H.state('SmokePassed', 'terminal', 'success');
const SmokeBroken = H.state('SmokeBroken', 'terminal', 'failure');

const Smoke = H.work('Smoke')
  .attributes({ release: z.string(), platform: z.string() })
  .states([SmokeQueued, SmokeRunning, SmokePassed, SmokeBroken])
  .fails(SmokeBroken)
  .key((u) => `${u.attributes.release}:${u.attributes.platform}`);

const build = H.command('build-release', ['./bin/build-release']);
const announce = H.command('announce-release', ['./bin/announce-release']);
const announcementPosted = H.command('announcement-posted', ['./bin/announcement-posted', '--json']).parses({ done: z.boolean() });
const smokeTest = H.command('smoke-test', ['./bin/smoke-test']);

const reviewerRole = H.role('release-reviewer')
  .intents(['read', 'execute'])
  .instructions('Review the release build for regressions and risky changes. Give a short verdict a release manager can act on.')
  .input({ version: z.string(), buildLog: z.string() })
  .output({ verdict: z.string() });
const summarizerRole = H.role('release-summarizer')
  .intents([])
  .instructions('Write the public release summary from the notes and the review.')
  .input({ version: z.string(), review: z.string(), notes: z.string() })
  .output({ summary: z.string() });

const subscription = claudeCode.subscription('release-max', { configDir: H.env('CLAUDE_RELEASE_DIR') });
const api = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const reviewer = H.agent('release-reviewer', reviewerRole).model(claudeCode.model('claude-opus-4-1')).pool(subscription);
const summarizer = H.agent('release-summarizer', summarizerRole)
  .model(anthropic.model('claude-sonnet-4-5', { batch: true }))
  .pool(api);

const releaseApproval = H.decision('release-approval', { approved: z.boolean(), note: z.string() });

const platforms = ['linux', 'macos', 'windows'];

const releaseFlow = H.flow('release')
  .requires({ version: z.string(), notes: z.string() })
  .step('build', build, (c) => ({ args: [c.input.version] }), { restart: 'rerun' })
  .step('announce', announce, (c) => ({ args: [c.input.version], stdin: c.input.notes }), {
    restart: { probe: announcementPosted },
  })
  .mark('reviewing')
  .step('review', reviewer, (c) => ({ version: c.input.version, buildLog: c.out.build.stdout }), { restart: 'ask' })
  .mark('awaitingApproval')
  .halt('approval', releaseApproval, { ask: (c) => `Release ${c.input.version}: ${c.out.review.verdict}` })
  .exit('rejected', (c) => !c.out.approval.approved)
  .mark('summarizing')
  .batch('summarize', summarizer, (c) => [{ version: c.input.version, review: c.out.review.verdict, notes: c.input.notes }])
  .mark('smoking')
  .spawn('smoke', {
    outlet: 'platform',
    child: { release: z.string(), platform: z.string() },
    items: (c) => platforms.map((platform) => ({ release: c.input.version, platform })),
  })
  .ends(['released', 'smokeFailed'], (c) => (c.out.smoke.every((s) => s.verdict === 'success') ? 'released' : 'smokeFailed'));

const smokeFlow = H.flow('smoke')
  .requires({ release: z.string(), platform: z.string() })
  .step('smoke', smokeTest, (c) => ({ args: [c.input.release, c.input.platform] }), { restart: 'rerun' })
  .ends(['passed'], () => 'passed');

const runner = local.shell({ slots: 4 });

const smokes = H.lane('smoke', Smoke)
  .runner(runner)
  .handler(smokeFlow, { ends: { passed: SmokePassed } });

const releases = H.lane('releases', Release)
  .supply([H.supply.operator()])
  .runner(runner)
  .wip(1)
  .handler(releaseFlow, {
    ends: { rejected: Rejected, released: Released, smokeFailed: SmokeFailed },
    marks: { reviewing: Reviewing, awaitingApproval: AwaitingApproval, summarizing: Summarizing, smoking: Smoking },
    spawns: { platform: (child) => smokes.unit({ attributes: { release: child.release, platform: child.platform } }) },
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
  .lanes([releases, smokes])
  .schedule(H.policy.schedule('releases-then-smoke', (c) => ({
    start: [...c.candidates.filter((x) => x.is(smokes)), ...c.candidates.filter((x) => x.is(releases))],
  })))
  .clients([claudeCode.supervisor('release-supervisor', releaseManager, { port: H.slot.port(0) })])
  .projections([markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md')]);
