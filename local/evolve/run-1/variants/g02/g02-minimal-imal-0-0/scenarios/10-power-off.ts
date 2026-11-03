import { z } from 'zod';
import { H } from 'harness-dsl';
import type { Runner } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as ssh from 'harness-dsl/ssh';
import * as markdown from 'harness-dsl/markdown';

const platforms = H.resources('platforms', ['linux', 'macos', 'windows']);

const Release = H.kind('release')
  .data(z.object({
    version: z.string(),
    channel: z.string(),
    platforms: z.array(platforms.schema),
    summary: z.string().optional(),
  }))
  .states({
    requested: 'pending',
    smoking: 'waiting',
    verifying: 'pending',
    released: 'success',
    'smoke-failed': 'failure',
    withdrawn: 'neutral',
  }, 'requested');

const Smoke = H.kind('smoke')
  .data(z.object({ version: z.string(), platform: platforms.schema }))
  .states({ queued: 'pending', passed: 'success', broken: 'failure' }, 'queued');

const buildHost = shell.local('build-host', { slots: 1 });

const smokeKey = H.env('SMOKE_SSH_KEY');
const smokeRunners: Record<'linux' | 'macos' | 'windows', Runner> = {
  linux: ssh.host('smoke-linux', { address: 'smoke-linux.internal', user: 'ci', key: smokeKey, slots: 1 }),
  macos: ssh.host('smoke-macos', { address: 'smoke-macos.internal', user: 'ci', key: smokeKey, slots: 1 }),
  windows: ssh.host('smoke-windows', { address: 'smoke-windows.internal', user: 'ci', key: smokeKey, slots: 1 }),
};

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .on(buildHost)
  .restart('rerun');

const announcement = z.object({ version: z.string(), channel: z.string() });

const announcePosted = H.command('announce-posted')
  .input(announcement)
  .argv(input => ['chat-history', '--channel', input.channel, '--find', `Release ${input.version}`, '--fail-if-missing'])
  .on(buildHost);

const announce = H.command('announce')
  .input(announcement)
  .argv(input => ['chat-post', '--channel', input.channel, '--text', `Release ${input.version} is rolling out`])
  .on(buildHost)
  .restart({ check: announcePosted });

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform: platforms.schema }))
  .argv(input => ['smoke', '--version', input.version])
  .on(input => smokeRunners[input.platform])
  .restart('rerun');

const reviewerRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), buildLog: z.string() }))
  .output(z.object({ notes: z.string(), concerns: z.array(z.string()) }))
  .prompt(input => `Review release ${input.version} before approval.\n\nBuild log:\n${input.buildLog}`)
  .intents(['read']);

const summaryRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), review: z.string() }))
  .output(z.object({ text: z.string() }))
  .prompt(input => `Write release notes for ${input.version} from this review:\n\n${input.review}`);

const reviewer = H.agent('release-reviewer', reviewerRole).model(claudeCode.model('opus'));
const summarizer = H.agent('release-summarizer', summaryRole).model(anthropic.model('claude-haiku-4-5'));

const smokeFlow = H.flow('smoke').for(Smoke).does(async ctx => {
  const result = await ctx.run(smokeTest, { version: ctx.unit.data.version, platform: ctx.unit.data.platform });
  return result.ok ? 'passed' : 'broken';
});

const smoke = H.lane('smoke', Smoke)
  .handler(smokeFlow)
  .store(sqlite.store(Smoke, 'smoke.db'))
  .touches(data => [platforms.of(data.platform)]);

const releaseFlow = H.flow('release').for(Release).does(async ctx => {
  if (ctx.unit.state === 'verifying') {
    const children = await ctx.children();
    return children.every(child => child.verdict === 'success') ? 'released' : 'smoke-failed';
  }

  const { version, channel } = ctx.unit.data;

  const built = await ctx.run(build, { version });
  if (!built.ok) return ctx.fail(built.error);

  const announced = await ctx.run(announce, { version, channel });
  if (!announced.ok) return ctx.fail(announced.error);

  const reviewed = await ctx.run(reviewer, { version, buildLog: built.value });
  if (!reviewed.ok) return ctx.fail(reviewed.error);

  const approval = await ctx.halt({
    name: 'release-approval',
    show: `${reviewed.value.notes}\n\nConcerns: ${reviewed.value.concerns.join('; ')}`,
    decision: z.object({ approved: z.boolean(), note: z.string() }),
  });
  if (!approval.approved) return 'withdrawn';

  const summaries = await ctx.batch(summarizer, [{ version, review: reviewed.value.notes }]);
  const summary = summaries[0];
  if (!summary.ok) return ctx.fail(summary.error);
  await ctx.update({ summary: summary.value.text });

  await ctx.spawn(smoke, ctx.unit.data.platforms.map(platform => ({ version, platform })));
  return ctx.until('smoking', { children: true, then: 'verifying' });
});

const releases = H.lane('releases', Release)
  .handler(releaseFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Release, 'releases.db'))
  .wip(1);

const quota = sqlite.quota('quota.db');
const subscription = claudeCode.subscription('release-subscription', { token: H.env('CLAUDE_SUBSCRIPTION_TOKEN'), quota });
const api = anthropic.account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY'), quota });

const firstEligible = H.policy.account('first-eligible', choice =>
  choice.accounts.find(view => view.eligible && view.account.provider === choice.model.provider)?.account ?? null);

const pool = H.pool('release-accounts', [
  { account: subscription, share: 1 },
  { account: api, share: 1 },
], firstEligible);

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('release-ledger.db'))
  .lanes(releases, smoke)
  .pools(pool)
  .scheduler(H.policy.scheduler('releases-first', ({ pending }) => ({
    start: [...pending].sort((x, y) => (x.lane === 'releases' ? 0 : 1) - (y.lane === 'releases' ? 0 : 1)),
  })))
  .clients(claudeCode.supervisor({ grants: [H.ops.readWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('board.md'));
