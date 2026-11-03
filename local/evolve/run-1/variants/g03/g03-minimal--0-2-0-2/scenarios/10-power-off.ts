import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claudeCode from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const platformSchema = z.enum(['linux', 'macos', 'windows']);

const requested = H.state('requested', 'pending');
const releasing = H.state('releasing', 'active');
const smoking = H.state('smoking', 'waiting');
const verifying = H.state('verifying', 'pending');
const released = H.state('released', 'terminal', 'success');
const releaseRejected = H.state('release-rejected', 'terminal', 'failure');
const smokeFailed = H.state('smoke-failed', 'terminal', 'failure');

const Release = H.kind('Release')
  .data(z.object({ version: z.string(), channel: z.string(), summary: z.string().optional() }))
  .states(requested, releasing, smoking, verifying, released, releaseRejected, smokeFailed);

const smokeQueued = H.state('smoke-queued', 'pending');
const smokeRunning = H.state('smoke-running', 'active');
const smokePassed = H.state('smoke-passed', 'terminal', 'success');
const smokeBroken = H.state('smoke-broken', 'terminal', 'failure');

const Smoke = H.kind('Smoke')
  .data(z.object({ release: z.string(), platform: platformSchema }))
  .states(smokeQueued, smokeRunning, smokePassed, smokeBroken);

const local = shell.local('release-host', { slots: 3 });

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .output(z.object({ artifact: z.string(), log: z.string() }))
  .argv(r => ['make', 'release', `VERSION=${r.version}`])
  .on(local)
  .recovers('rerun');

const announcement = z.object({ version: z.string(), channel: z.string() });
const announcePosted = H.command('announce-posted')
  .input(announcement)
  .output(z.boolean())
  .argv(a => ['chat-history', '--channel', a.channel, '--contains', `Releasing ${a.version}`])
  .on(local);
const announce = H.command('announce')
  .input(announcement)
  .argv(a => ['chat-post', '--channel', a.channel, '--text', `Releasing ${a.version}`])
  .on(local)
  .recovers(announcePosted);

const smokeTest = H.command('smoke-test')
  .input(z.object({ release: z.string(), platform: platformSchema }))
  .argv(s => ['smoke', '--release', s.release, '--platform', s.platform])
  .on(local)
  .recovers('rerun');

const reviewRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), buildLog: z.string() }))
  .output(z.object({ verdict: z.enum(['ship', 'hold']), notes: z.string() }))
  .prompt(r => `Review release ${r.version}. Build log:\n${r.buildLog}`)
  .intents(['read']);
const notesRole = H.role('release-notes')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ summary: z.string() }))
  .prompt(r => `Write release notes for ${r.version} from:\n${r.notes}`);

const reviewer = H.agent('release-reviewer', reviewRole).model(claudeCode.model('claude-opus-4')).on(local);
const summarizer = H.agent('release-summarizer', notesRole).model(anthropic.model('claude-haiku-4'));

const releaseApproval = H.halt('release-approval', z.object({ approved: z.boolean(), note: z.string() }));

const smokeFlow = H.flow('smoke').for(Smoke).does(async ctx => {
  await ctx.move('smoke-running');
  const result = await ctx.run(smokeTest, { release: ctx.unit.data.release, platform: ctx.unit.data.platform });
  return result.ok ? 'smoke-passed' : 'smoke-broken';
});
const smokeLane = H.lane('smoke', Smoke).handler(smokeFlow).store(sqlite.store(Smoke, 'release/units.db'));

const releaseFlow = H.flow('release')
  .for(Release)
  .does(async ctx => {
    const release = ctx.unit.data;
    await ctx.move('releasing');
    const built = await ctx.run(build, { version: release.version });
    if (!built.ok) return ctx.fail(built.error);
    const announced = await ctx.run(announce, { version: release.version, channel: release.channel });
    if (!announced.ok) return ctx.fail(announced.error);
    const reviewed = await ctx.run(reviewer, { version: release.version, buildLog: built.value.log });
    if (!reviewed.ok) return ctx.fail(reviewed.error);
    const approval = await ctx.halt(releaseApproval, `${release.version}: reviewer says ${reviewed.value.verdict}\n${reviewed.value.notes}`);
    if (!approval.approved) return 'release-rejected';
    const summaries = await ctx.batch(summarizer, [{ version: release.version, notes: reviewed.value.notes }]);
    const lines: string[] = [];
    for (const summary of summaries) {
      if (!summary.ok) return ctx.fail(summary.error);
      lines.push(summary.value.summary);
    }
    await ctx.update({ summary: lines.join('\n') });
    await ctx.spawn(smokeLane, platformSchema.options.map(platform => ({ release: release.version, platform })));
    return ctx.wait('smoking', { children: true, then: 'verifying' });
  })
  .phase('verifying', async ctx => {
    const smokes = await ctx.children(smokeLane);
    if (smokes.some(smoke => smoke.position !== 'terminal')) return ctx.wait('smoking', { children: true, then: 'verifying' });
    return smokes.every(smoke => smoke.state === 'smoke-passed') ? 'released' : 'smoke-failed';
  });

const releaseLane = H.lane('releases', Release).handler(releaseFlow).suppliers(H.operator).store(sqlite.store(Release, 'release/units.db')).wip(1);

const sameProvider = H.policy.account('same-provider', choice => {
  for (const view of choice.accounts) if (view.eligible && view.account.provider === choice.model.provider) return view.account;
  return null;
});

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('release/ledger.db'))
  .lanes(releaseLane, smokeLane)
  .pools(
    H.pool(
      'release-accounts',
      [
        { account: claudeCode.subscription('release-max', { token: H.env('CLAUDE_RELEASE_TOKEN') }), share: 1 },
        { account: anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
      ],
      sameProvider
    )
  )
  .scheduler(H.policy.scheduler('releases-before-smoke', view => ({
    start: [...view.pending].sort((x, y) => (x.lane === releaseLane.name ? 0 : 1) - (y.lane === releaseLane.name ? 0 : 1) || y.waitedMs - x.waitedMs),
  })))
  .clients(claudeCode.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('release/board.md'), markdown.telemetry('release/telemetry.md'));
