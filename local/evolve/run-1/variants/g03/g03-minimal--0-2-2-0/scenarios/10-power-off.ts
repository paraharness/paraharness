import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as markdown from 'harness-dsl/markdown';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';
import * as ssh from 'harness-dsl/ssh';

const platform = z.enum(['linux', 'macos', 'windows']);

const requested = H.state('requested', 'pending');
const releasing = H.state('releasing', 'active');
const awaitingSmoke = H.state('awaiting-smoke', 'waiting');
const released = H.state('released', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const smokeFailed = H.state('smoke-failed', 'terminal', 'failure');
const abandoned = H.state('abandoned', 'terminal', 'failure');

const Release = H.kind('release')
  .data(z.object({
    version: z.string(),
    commit: z.string(),
    channel: z.string(),
    platforms: z.array(platform),
    notes: z.string().optional(),
  }))
  .states(requested, releasing, awaitingSmoke, released, rejected, smokeFailed, abandoned)
  .failsTo('abandoned');

const queued = H.state('queued', 'pending');
const running = H.state('running', 'active');
const passed = H.state('passed', 'terminal', 'success');
const broken = H.state('broken', 'terminal', 'failure');

const Smoke = H.kind('smoke').data(z.object({ version: z.string(), platform })).states(queued, running, passed, broken);

const local = shell.local('local', { slots: 2 });
const smokeKey = H.env('SMOKE_SSH_KEY');
const smokeHosts = {
  linux: ssh.host('smoke-linux', { address: 'smoke-linux.internal', user: 'ci', key: smokeKey, slots: 1 }),
  macos: ssh.host('smoke-macos', { address: 'smoke-macos.internal', user: 'ci', key: smokeKey, slots: 1 }),
  windows: ssh.host('smoke-windows', { address: 'smoke-windows.internal', user: 'ci', key: smokeKey, slots: 1 }),
};

const build = H.command('build')
  .input(z.object({ version: z.string(), commit: z.string() }))
  .output(z.object({ artifact: z.string() }))
  .argv(input => ['release-build', '--version', input.version, '--commit', input.commit])
  .on(local)
  .recovery('rerun');

const announcement = z.object({ version: z.string(), channel: z.string() });

const findAnnouncement = H.command('find-announcement')
  .input(announcement)
  .output(z.boolean())
  .argv(input => ['chat-search', '--channel', input.channel, '--text', `Releasing ${input.version}`])
  .on(local);

const announce = H.command('announce')
  .input(announcement)
  .argv(input => ['chat-post', '--channel', input.channel, '--text', `Releasing ${input.version}`])
  .on(local)
  .recovery(findAnnouncement);

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform }))
  .output(z.object({ passed: z.boolean() }))
  .argv(input => ['smoke', '--version', input.version])
  .on(smokeHosts, input => input.platform)
  .recovery('park');

const reviewRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), artifact: z.string() }))
  .output(z.object({ summary: z.string(), concerns: z.array(z.string()) }))
  .prompt(input => `Review release ${input.version} built as ${input.artifact}. List concerns.`)
  .intents(['read']);

const summaryRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), review: z.string(), note: z.string() }))
  .output(z.object({ notes: z.string() }))
  .prompt(input => `Write release notes for ${input.version}.\nReview: ${input.review}\nManager note: ${input.note}`)
  .intents(['read']);

const reviewer = H.agent('release-reviewer', reviewRole).model(anthropic.model('claude-opus-4-1'));
const summarizer = H.agent('release-summarizer', summaryRole).model(anthropic.model('claude-haiku-4-5'));

const releaseApproval = H.halt('release-approval', z.object({ approved: z.boolean(), note: z.string() }));

const smokeFlow = H.flow('smoke').for(Smoke).does(async ctx => {
  await ctx.move('running');
  const result = await ctx.run(smokeTest, ctx.unit.data);
  if (!result.ok) return ctx.fail(result.error);
  return result.value.passed ? 'passed' : 'broken';
});

const smoke = H.lane('smoke', Smoke).handler(smokeFlow).store(sqlite.store(Smoke, '.harness/units.sqlite')).wip(3);

const releaseFlow = H.flow('release').for(Release).does(async ctx => {
  const { version, commit, channel, platforms } = ctx.unit.data;
  await ctx.move('releasing');

  const built = await ctx.run(build, { version, commit });
  if (!built.ok) return ctx.fail(built.error);

  const announced = await ctx.run(announce, { version, channel });
  if (!announced.ok) return ctx.fail(announced.error);

  const reviewed = await ctx.run(reviewer, { version, artifact: built.value.artifact });
  if (!reviewed.ok) return ctx.fail(reviewed.error);

  const approval = await ctx.halt(releaseApproval, `${reviewed.value.summary}\n\nConcerns:\n${reviewed.value.concerns.join('\n')}`);
  if (!approval.approved) return 'rejected';

  const summaries = await ctx.batch(summarizer, [{ version, review: reviewed.value.summary, note: approval.note }]);
  const summary = summaries[0];
  if (!summary) return ctx.fail('summary batch returned no result');
  if (!summary.ok) return ctx.fail(summary.error);
  await ctx.update({ notes: summary.value.notes });

  const children = await ctx.spawn(smoke, platforms.map(target => ({ version, platform: target })));
  const finished = await ctx.wait('awaiting-smoke', { children });
  return finished.every(child => child.state === 'passed') ? 'released' : 'smoke-failed';
});

const releases = H.lane('releases', Release)
  .handler(releaseFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Release, '.harness/units.sqlite'))
  .retry(H.policy.retry('release-retry', ({ failures }) => (failures > 1 ? 'stop' : { retryInMs: 300_000 })))
  .wip(1);

const pool = H.pool('api', [{ account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 }]);

export const harness = H.harness('release')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(releases, smoke)
  .pools(pool)
  .clients(claudeCode.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
