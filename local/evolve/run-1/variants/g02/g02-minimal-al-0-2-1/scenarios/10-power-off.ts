import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as claude from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const api = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const subscription = claude.subscription('claude-max', { token: H.env('CLAUDE_TOKEN') });
const reviewModel = claude.model('claude-opus-4-1');
const batchModel = anthropic.model('claude-haiku-4-5');
const local = shell.local('release-host', { slots: 4 });

const Requested = H.state('requested', 'pending');
const AwaitingSmoke = H.state('awaiting-smoke', 'waiting');
const Smoked = H.state('smoked', 'pending');
const Released = H.state('released', 'terminal', 'success');
const Rejected = H.state('rejected', 'terminal', 'neutral');
const SmokeFailed = H.state('smoke-failed', 'terminal', 'failure');

const Release = H.kind('release')
  .data(z.object({ version: z.string(), platforms: z.array(z.string()), notes: z.string().optional() }))
  .states(Requested, AwaitingSmoke, Smoked, Released, Rejected, SmokeFailed);

const Queued = H.state('queued', 'pending');
const Passed = H.state('passed', 'terminal', 'success');
const Failed = H.state('failed', 'terminal', 'failure');

const Smoke = H.kind('smoke')
  .data(z.object({ version: z.string(), platform: z.string() }))
  .states(Queued, Passed, Failed);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .on(local)
  .recover('rerun');

const announcementPosted = H.command('announcement-posted')
  .input(z.object({ version: z.string() }))
  .output(z.boolean())
  .argv(input => ['announce', '--check', '--channel', 'releases', '--version', input.version])
  .on(local)
  .recover('rerun');

const announce = H.command('announce')
  .input(z.object({ version: z.string() }))
  .argv(input => ['announce', '--channel', 'releases', '--version', input.version])
  .on(local)
  .recover(announcementPosted);

const reviewerRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), buildLog: z.string() }))
  .output(z.object({ concerns: z.array(z.string()) }))
  .prompt(input => `Review release ${input.version}.\n\n${input.buildLog}`)
  .intents(['read']);

const summarizerRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), concerns: z.array(z.string()) }))
  .output(z.object({ notes: z.string() }))
  .prompt(input => `Write release notes for ${input.version}. Known concerns: ${input.concerns.join('; ')}`);

const reviewer = H.agent('release-reviewer', reviewerRole).model(reviewModel).on(local);
const summarizer = H.agent('release-summarizer', summarizerRole).model(batchModel);

const releaseApproval = H.decision('release-approval')
  .input(z.object({ version: z.string(), concerns: z.array(z.string()) }))
  .output(z.object({ approved: z.boolean(), note: z.string().optional() }))
  .show(input => `Release ${input.version}\n\n${input.concerns.join('\n')}`);

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform: z.string() }))
  .argv(input => ['smoke', '--platform', input.platform, '--version', input.version])
  .on(local)
  .recover('rerun');

const runSmoke = H.flow('run-smoke').for(Smoke).does(async ctx => {
  const result = await ctx.run(smokeTest, ctx.unit.data);
  return result.ok ? 'passed' : 'failed';
});

const smoke = H.lane('smoke', Smoke).handler(runSmoke);

const releaseFlow = H.flow('release').for(Release).does(async ctx => {
  const { version, platforms } = ctx.unit.data;
  const built = await ctx.run(build, { version });
  if (built.ok === false) return ctx.fail(built.error);

  const announced = await ctx.run(announce, { version });
  if (announced.ok === false) return ctx.fail(announced.error);

  const review = await ctx.run(reviewer, { version, buildLog: built.value });
  if (review.ok === false) return ctx.fail(review.error);

  const approval = await ctx.decide(releaseApproval, { version, concerns: review.value.concerns });
  if (approval.approved === false) return 'rejected';

  const summaries = await ctx.batch(summarizer, [{ version, concerns: review.value.concerns }]);
  const notes: string[] = [];
  for (const summary of summaries) {
    if (summary.ok === false) return ctx.fail(summary.error);
    notes.push(summary.value.notes);
  }
  await ctx.update({ notes: notes.join('\n\n') });

  await ctx.spawn(smoke, platforms.map(platform => ({ version, platform })));
  return ctx.until('awaiting-smoke', { children: true, then: 'smoked' });
});

const settleRelease = H.flow('settle-release').for(Release).does(async ctx => {
  const children = await ctx.children();
  return children.every(child => child.state === Passed.name) ? 'released' : 'smoke-failed';
});

const releases = H.lane('releases', Release)
  .handler({ requested: releaseFlow, smoked: settleRelease })
  .suppliers(H.operator);

export const running = H.harness('release')
  .ledger(sqlite.ledger('.harness/release.db'))
  .pools(H.pool('release-accounts', [{ account: subscription, share: 1 }, { account: api, share: 1 }]))
  .lanes(releases, smoke)
  .clients(claude.supervisor({
    grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveDecisions, H.ops.readTelemetry],
  }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'))
  .start();
