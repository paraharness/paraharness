import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const ledgerPath = '/srv/release/ledger.sqlite';
const releaseBox = shell.local('release-box', { slots: 3 });

const platform = z.enum(['linux', 'macos', 'windows']);

const requested = H.state('requested', 'pending');
const smoking = H.state('smoking', 'waiting');
const released = H.state('released', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const smokeFailed = H.state('smoke-failed', 'terminal', 'failure');
const broken = H.state('broken', 'terminal', 'failure');
const release = H.kind('Release')
  .data(z.object({ version: z.string(), platforms: z.array(platform), summary: z.string().optional() }))
  .states(requested, smoking, released, rejected, smokeFailed, broken);

const smokeQueued = H.state('queued', 'pending');
const passed = H.state('passed', 'terminal', 'success');
const failed = H.state('failed', 'terminal', 'failure');
const smoke = H.kind('Smoke')
  .data(z.object({ release: z.string(), version: z.string(), platform }))
  .states(smokeQueued, passed, failed);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .on(releaseBox)
  .recovery('rerun');

const announcementPosted = H.command('announcement-posted')
  .input(z.object({ version: z.string() }))
  .output(z.boolean())
  .argv(input => ['release-chat', 'find', `Releasing ${input.version}`])
  .on(releaseBox);

const announce = H.command('announce')
  .input(z.object({ version: z.string() }))
  .argv(input => ['release-chat', 'post', `Releasing ${input.version}`])
  .on(releaseBox)
  .recovery(announcementPosted);

const reviewer = H.seat(
  'release-reviewer',
  H.role('release-reviewer')
    .input(z.object({ version: z.string(), buildLog: z.string() }))
    .output(z.object({ notes: z.string() }))
    .prompt(input => `Review release ${input.version}. Build log:\n${input.buildLog}`)
    .intents(['read'])
).model(claude.model('claude-sonnet-4-5'));

const summarizer = H.seat(
  'release-summarizer',
  H.role('release-summarizer')
    .input(z.object({ version: z.string(), notes: z.string() }))
    .output(z.object({ summary: z.string() }))
    .prompt(input => `Write release notes for ${input.version}:\n${input.notes}`)
).model(anthropic.model('claude-haiku-4-5'));

const approval = H.halt('release-approval', z.object({ approved: z.boolean(), note: z.string().optional() }));

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform }))
  .argv(input => ['smoke', '--version', input.version, '--platform', input.platform])
  .on(releaseBox)
  .recovery('rerun');

const runSmoke = H.flow('run-smoke').for(smoke).does(async ctx => {
  const tested = await ctx.run(smokeTest, { version: ctx.unit.data.version, platform: ctx.unit.data.platform });
  if (!tested.ok) return ctx.fail(tested);
  return 'passed';
});

const smokes = H.lane('smoke', smoke)
  .handler(runSmoke)
  .retries(1, 'failed')
  .store(sqlite.store(smoke, ledgerPath))
  .wip(3);

const ship = H.flow('ship').for(release).does(async ctx => {
  const version = ctx.unit.data.version;
  const built = await ctx.run(build, { version });
  if (!built.ok) return ctx.fail(built);
  const announced = await ctx.run(announce, { version });
  if (!announced.ok) return ctx.fail(announced);
  const reviewed = await ctx.run(reviewer, { version, buildLog: built.value });
  if (!reviewed.ok) return ctx.fail(reviewed);
  const decision = await ctx.halt(approval, `Release ${version}: ${reviewed.value.notes}`);
  if (!decision.approved) return 'rejected';
  const [summary] = await ctx.batch(summarizer, [{ version, notes: reviewed.value.notes }]);
  if (!summary.ok) return ctx.fail(summary);
  await ctx.update({ summary: summary.value.summary });
  const children = await ctx.spawn(
    smokes,
    ctx.unit.data.platforms.map(target => ({ release: ctx.unit.key, version, platform: target }))
  );
  const results = await ctx.suspend('smoking', { children });
  return results.every(result => result.state === 'passed') ? 'released' : 'smoke-failed';
});

const releases = H.lane('releases', release)
  .handler(ship)
  .retries(1, 'broken', { first: { minutes: 5 } })
  .suppliers(H.operator)
  .store(sqlite.store(release, ledgerPath))
  .wip(1);

const subscription = claude.subscription('claude-max', { token: H.env('CLAUDE_MAX_TOKEN') });
const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });

export const harness = H.harness('release')
  .ledger(sqlite.ledger(ledgerPath))
  .lanes(releases, smokes)
  .pools(H.pool('release-accounts', [{ account: subscription, share: 1 }, { account: api, share: 1 }]))
  .scheduler(H.policy.scheduler('oldest-first', view => ({ start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs) })))
  .clients(
    claude.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(approval, H.halts.interrupted, H.halts.definitionChanged),
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('/srv/release/BOARD.md'));
