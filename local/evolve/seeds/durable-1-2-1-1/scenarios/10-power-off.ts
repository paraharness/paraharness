import { z } from 'zod';
import { H } from 'harness-dsl';
import * as sqlite from 'harness-dsl/sqlite';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as slack from 'harness-dsl/slack';
import * as local from 'harness-dsl/local';
import * as markdown from 'harness-dsl/markdown';

const platforms = ['linux', 'macos', 'windows'];

const SmokeQueued = H.state('SmokeQueued', 'pending');
const SmokeRunning = H.state('SmokeRunning', 'active');
const SmokePassed = H.state('SmokePassed', 'terminal', 'success');
const SmokeFailed = H.state('SmokeFailed', 'terminal', 'failure');

const Smoke = H.work('Smoke')
  .attributes({ version: z.string(), platform: z.string() })
  .states([SmokeQueued, SmokeRunning, SmokePassed, SmokeFailed])
  .failsTo(SmokeFailed)
  .key((u) => `${u.attributes.version}/${u.attributes.platform}`);

const Requested = H.state('Requested', 'pending');
const Building = H.state('Building', 'active');
const Reviewing = H.state('Reviewing', 'active');
const AwaitingApproval = H.state('AwaitingApproval', 'waiting');
const Summarizing = H.state('Summarizing', 'waiting');
const AwaitingSmoke = H.state('AwaitingSmoke', 'waiting');
const Held = H.state('Held', 'waiting');
const Released = H.state('Released', 'terminal', 'success');
const Rejected = H.state('Rejected', 'terminal', 'neutral');
const Failed = H.state('Failed', 'terminal', 'failure');

const Release = H.work('Release')
  .attributes({ version: z.string(), commit: z.string() })
  .states([Requested, Building, Reviewing, AwaitingApproval, Summarizing, AwaitingSmoke, Held, Released, Rejected, Failed])
  .failsTo(Failed)
  .key((u) => u.attributes.version);

const build = H.command('build-release', ['make', 'release']);
const announce = slack.notify('announce-release', { webhookUrl: H.env('RELEASE_CHANNEL_WEBHOOK') });
const findAnnouncement = H.command('find-announcement', ['scripts/announced.sh']).parses({ done: z.boolean() });
const runSmoke = H.command('run-smoke', ['scripts/smoke.sh']);

const subscription = claudeCode.subscription('release-subscription', { configDir: H.env('CLAUDE_CONFIG_DIR') });
const api = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const reviewer = H.agent(
  'release-reviewer',
  H.role('release-review')
    .intents(['read', 'execute'])
    .instructions('Review the release for regressions and list your concerns.')
    .output({ concerns: z.array(z.string()) }),
)
  .model(claudeCode.model('claude-opus-4-1'))
  .pool(subscription);

const notesWriter = H.agent(
  'release-notes-writer',
  H.role('release-notes').instructions('Write the release notes.').output({ notes: z.string() }),
)
  .model(anthropic.model('claude-sonnet-4-5', { batch: true }))
  .pool(api);

const releaseCall = H.decision('release-call', { ship: z.boolean(), note: z.string() });

const shipRelease = H.flow('ship-release')
  .requires({ version: z.string(), commit: z.string() })
  .step('build', build, (c) => ({ args: [c.input.commit] }), { restart: 'rerun' })
  .step('announce', announce, (c) => ({ text: `Release ${c.input.version} is on its way.` }), {
    restart: { probe: findAnnouncement },
  })
  .step('review', reviewer, (c) => ({ task: `Review release ${c.input.version} at ${c.input.commit}.\n\n${c.out.build.stdout}` }), {
    restart: 'ask',
  })
  .halt('approval', releaseCall, {
    ask: (c) => `Ship ${c.input.version}? Reviewer concerns: ${c.out.review.concerns.join('; ') || 'none'}`,
  })
  .exit('rejected', (c) => !c.out.approval.ship)
  .batch('summarize', notesWriter, (c) => [{ task: `Release notes for ${c.input.version} at ${c.input.commit}` }])
  .spawn('smoke', {
    outlet: 'smoke',
    child: { version: z.string(), platform: z.string() },
    items: (c) => platforms.map((platform) => ({ version: c.input.version, platform })),
  })
  .ends(['released', 'smokeFailed'], (c) =>
    c.out.smoke.every((child) => child.verdict === 'success') ? 'released' : 'smokeFailed',
  );

const smokeTest = H.flow('smoke-test')
  .requires({ version: z.string(), platform: z.string() })
  .step('run', runSmoke, (c) => ({ args: [c.input.platform, c.input.version] }), { restart: 'rerun' })
  .ends(['passed'], () => 'passed');

const shell = local.shell({ slots: 4 });

const smoke = H.lane('smoke', Smoke)
  .runner(shell)
  .handler(smokeTest, { opens: SmokeRunning, states: { run: SmokeRunning, passed: SmokePassed } });

const releases = H.lane('releases', Release)
  .supply([H.supply.operator()])
  .store(sqlite.store(Release, 'state/releases.sqlite'))
  .runner(shell)
  .handler(shipRelease, {
    opens: Building,
    blocked: Held,
    states: {
      build: Building,
      review: Reviewing,
      approval: AwaitingApproval,
      summarize: Summarizing,
      smoke: AwaitingSmoke,
      rejected: Rejected,
      released: Released,
      smokeFailed: Failed,
    },
    spawns: { smoke: (child) => smoke.unit({ attributes: child }) },
  });

const releaseManager = H.access('release-manager').allows([
  H.ops.readWork,
  H.ops.createWork,
  H.ops.resolveBlocks,
  H.ops.manageAttempts,
  H.ops.readTelemetry,
]);

export const release = H.harness('release')
  .ledger(sqlite.ledger('state/release-ledger.sqlite'))
  .lanes([releases, smoke])
  .clients([claudeCode.supervisor('release-supervisor', releaseManager, { port: H.slot.port(0) })])
  .projections([markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md')]);

export const running = release.start();
