import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';
import * as claude from 'harness-dsl/claude-code';

const Platforms = H.resources('platform', ['linux', 'macos', 'windows']);

const local = shell.local('local', { slots: 2 });
const sshKey = H.env('SMOKE_SSH_KEY');
const linuxHost = ssh.host('smoke-linux', { address: 'smoke-linux.internal', user: 'ci', key: sshKey, slots: 1, hosts: [Platforms.get('linux')] });
const macHost = ssh.host('smoke-macos', { address: 'smoke-macos.internal', user: 'ci', key: sshKey, slots: 1, hosts: [Platforms.get('macos')] });
const windowsHost = ssh.host('smoke-windows', { address: 'smoke-windows.internal', user: 'ci', key: sshKey, slots: 1, hosts: [Platforms.get('windows')] });

const Smoke = H.kind('smoke')
  .data(z.object({ release: z.string(), platform: Platforms.schema }))
  .states([
    H.state('queued', 'pending'),
    H.state('smoking', 'active'),
    H.state('passed', 'terminal', 'success'),
    H.state('failed', 'terminal', 'failure'),
  ], { initial: 'queued', afterFailure: 'failed' });

const smokeTest = H.command('smoke-test')
  .input(z.object({ release: z.string(), platform: z.string() }))
  .argv(i => ['./scripts/smoke', i.release, i.platform])
  .on(linuxHost, macHost, windowsHost)
  .ifInterrupted('rerun');

const smokeFlow = H.flow('smoke').for(Smoke).does(async ctx => {
  await ctx.move('smoking');
  const result = await ctx.run(smokeTest, { release: ctx.unit.data.release, platform: ctx.unit.data.platform }, { timeoutMs: 1_800_000 });
  return result.ok ? 'passed' : 'failed';
});

const smoke = H.lane('smoke', Smoke)
  .handler(smokeFlow)
  .store(sqlite.store(Smoke, 'release.db'))
  .touches(s => [Platforms.get(s.platform)]);

const Release = H.kind('release')
  .data(z.object({ version: z.string(), notes: z.string(), platforms: z.array(Platforms.schema) }))
  .states([
    H.state('requested', 'pending'),
    H.state('building', 'active'),
    H.state('announcing', 'active'),
    H.state('reviewing', 'active'),
    H.state('awaiting-approval', 'active'),
    H.state('summarizing', 'active'),
    H.state('smoke-running', 'waiting'),
    H.state('smoke-finished', 'pending'),
    H.state('verifying', 'active'),
    H.state('held', 'waiting'),
    H.state('released', 'terminal', 'success'),
    H.state('rejected', 'terminal', 'failure'),
    H.state('smoke-failed', 'terminal', 'failure'),
  ], { initial: 'requested', afterFailure: 'held' });

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(i => ['make', 'release', `VERSION=${i.version}`])
  .on(local)
  .ifInterrupted('rerun');

const announcementInput = z.object({ version: z.string(), notes: z.string() });
const announcementExists = H.command('announcement-exists')
  .input(announcementInput)
  .output(z.boolean())
  .argv(i => ['./scripts/channel', 'has-post', `release ${i.version}`]);
const announce = H.command('announce')
  .input(announcementInput)
  .argv(i => ['./scripts/channel', 'post', `Release ${i.version} is coming: ${i.notes}`])
  .on(local)
  .ifInterrupted('ask', announcementExists);

const reviewerRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ concerns: z.array(z.string()), recommendation: z.string() }))
  .prompt(i => `Review release ${i.version} for risk.\n\n${i.notes}`)
  .intents(['read', 'execute']);

const summarizerRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), notes: z.string(), concerns: z.array(z.string()) }))
  .output(z.object({ summary: z.string() }))
  .prompt(i => `Write customer-facing release notes for ${i.version}.\n\n${i.notes}\n\nKnown concerns: ${i.concerns.join('; ')}`);

const reviewer = H.agent('release-reviewer', reviewerRole).model(anthropic.model('claude-opus-4-1')).on(local).ifInterrupted('ask');
const summarizer = H.agent('release-summarizer', summarizerRole).model(anthropic.model('claude-sonnet-4-5'));

const releaseFlow = H.flow('release').for(Release).does(async ctx => {
  const r = ctx.unit.data;

  if (ctx.unit.state === 'smoke-finished') {
    await ctx.move('verifying');
    const children = await ctx.children();
    return children.every(child => child.state === 'passed') ? 'released' : 'smoke-failed';
  }

  await ctx.move('building');
  const built = await ctx.run(build, { version: r.version }, { step: 'build' });
  if (!built.ok) return ctx.fail(built.error);

  await ctx.move('announcing');
  const announced = await ctx.run(announce, { version: r.version, notes: r.notes }, { step: 'announce' });
  if (!announced.ok) return ctx.fail(announced.error);

  await ctx.move('reviewing');
  const review = await ctx.run(reviewer, { version: r.version, notes: r.notes }, { step: 'review' });
  if (!review.ok) return ctx.fail(review.error);

  await ctx.move('awaiting-approval');
  const approval = await ctx.halt({
    name: 'approval',
    show: `${review.value.recommendation}\n\nConcerns:\n${review.value.concerns.join('\n')}`,
    decision: z.object({ approve: z.boolean(), reason: z.string() }),
  });
  if (!approval.approve) return 'rejected';

  await ctx.move('summarizing');
  const summaries = await ctx.batch(summarizer, [{ version: r.version, notes: r.notes, concerns: review.value.concerns }], { step: 'summarize' });
  const summary = summaries[0];
  if (summary === undefined || !summary.ok) return ctx.fail('summary batch returned no result');
  await ctx.update({ notes: summary.value.summary });

  await ctx.spawn(smoke, r.platforms.map(platform => ({ release: r.version, platform })));
  return ctx.wait('smoke-running', { children: true, then: 'smoke-finished' });
});

const releases = H.lane('releases', Release)
  .handler(releaseFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Release, 'release.db'))
  .wip(1);

const api = anthropic.account('api', { apiKey: H.env('ANTHROPIC_API_KEY') });

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('release-ledger.db'))
  .lanes(releases, smoke)
  .pools(H.pool('models', [{ account: api, share: 1 }], H.policy.account('api-only', c => c.accounts.find(a => a.eligible)?.account ?? null)))
  .scheduler(H.policy.scheduler('releases-before-smoke', view => ({
    start: [...view.pending].sort((a, b) => (a.lane === 'releases' ? 0 : 1) - (b.lane === 'releases' ? 0 : 1) || b.waitedMs - a.waitedMs),
  })))
  .clients(claude.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.manageAttempts, H.ops.readTelemetry],
  }))
  .observers(markdown.board('board.md'), markdown.telemetry('telemetry.md'));
