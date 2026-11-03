import { H } from 'harness-dsl';
import { z } from 'zod';
import * as anthropic from 'harness-dsl/anthropic';
import * as claudeCode from 'harness-dsl/claude-code';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const local = shell.local('local', { slots: 4 });

const requested = H.state('requested', 'pending');
const smoking = H.state('smoking', 'waiting');
const smoked = H.state('smoked', 'pending');
const released = H.state('released', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const smokeFailed = H.state('smokeFailed', 'terminal', 'failure');

const Release = H.kind('Release')
  .data(z.object({
    version: z.string(),
    platforms: z.array(z.string()),
    summary: z.string().optional(),
  }))
  .states(requested, smoking, smoked, released, rejected, smokeFailed);

const queued = H.state('queued', 'pending');
const passed = H.state('passed', 'terminal', 'success');
const failedSmoke = H.state('failedSmoke', 'terminal', 'failure');

const Smoke = H.kind('Smoke')
  .data(z.object({ version: z.string(), platform: z.string() }))
  .states(queued, passed, failedSmoke);

const version = z.object({ version: z.string() });

const build = H.command('build')
  .input(version)
  .argv((i) => ['make', 'release', `VERSION=${i.version}`])
  .on(local)
  .recovers('rerun');

const announcementPosted = H.command('announcement-posted')
  .input(version)
  .output(z.boolean())
  .argv((i) => ['chatops', 'has-posted', '--channel', 'releases', '--match', `Release ${i.version}`])
  .on(local);

const announce = H.command('announce')
  .input(version)
  .argv((i) => ['chatops', 'post', '--channel', 'releases', '--text', `Release ${i.version} is rolling out`])
  .on(local)
  .recovers(announcementPosted);

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform: z.string() }))
  .argv((i) => ['smoke', '--platform', i.platform, '--version', i.version])
  .on(local)
  .recovers('rerun');

const reviewRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), buildLog: z.string() }))
  .output(z.object({ concerns: z.array(z.string()) }))
  .prompt((i) => `Review release ${i.version}. Build log:\n${i.buildLog}\nList concerns for the release manager.`)
  .intents(['read']);

const summaryRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), concerns: z.array(z.string()) }))
  .output(z.object({ text: z.string() }))
  .prompt((i) => `Write release notes for ${i.version}. Reviewer concerns:\n${i.concerns.join('\n')}`);

const reviewer = H.agent('release-reviewer', reviewRole).model(claudeCode.model('claude-sonnet-4'));
const summarizer = H.agent('release-summarizer', summaryRole).model(anthropic.model('claude-haiku-4'));

const releaseApproval = H.halt('release-approval', z.object({ approved: z.boolean(), note: z.string() }));

const releaseFlow = H.flow('release')
  .for(Release)
  .does(async (ctx) => {
    const release = ctx.unit.data;
    const built = await ctx.run(build, { version: release.version });
    if (!built.ok) return ctx.fail(built.error);
    const announced = await ctx.run(announce, { version: release.version });
    if (!announced.ok) return ctx.fail(announced.error);
    const reviewed = await ctx.run(reviewer, { version: release.version, buildLog: built.value });
    if (!reviewed.ok) return ctx.fail(reviewed.error);
    const decision = await ctx.halt(releaseApproval, reviewed.value.concerns.join('\n'));
    if (!decision.approved) return 'rejected';
    const [summary] = await ctx.batch(summarizer, [{ version: release.version, concerns: reviewed.value.concerns }]);
    if (summary && summary.ok) await ctx.update({ summary: summary.value.text });
    await ctx.spawn(smoke, release.platforms.map((platform) => ({ version: release.version, platform })));
    return ctx.wait('smoking', { children: true, then: 'smoked' });
  })
  .phase('smoked', async (ctx) => {
    const children = await ctx.children();
    return children.every((child) => child.state === 'passed') ? 'released' : 'smokeFailed';
  });

const smokeFlow = H.flow('smoke').for(Smoke).does(async (ctx) => {
  const result = await ctx.run(smokeTest, { version: ctx.unit.data.version, platform: ctx.unit.data.platform });
  return result.ok ? 'passed' : 'failedSmoke';
});

const releases = H.lane('releases', Release)
  .handler(releaseFlow)
  .suppliers(H.operator)
  .store(sqlite.store(Release, '.harness/releases.db'));

const smoke = H.lane('smoke', Smoke)
  .handler(smokeFlow)
  .store(sqlite.store(Smoke, '.harness/smoke.db'))
  .wip(4);

const pool = H.pool('release-accounts', [
  { account: claudeCode.subscription('claude-max', { token: H.env('CLAUDE_TOKEN') }), share: 1 },
  { account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]);

export const release = H.harness('release')
  .ledger(sqlite.ledger('.harness/ledger.db'))
  .lanes(releases, smoke)
  .pools(pool)
  .clients(claudeCode.supervisor({ grants: [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry] }))
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
