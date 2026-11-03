import { z } from 'zod';
import { H } from 'harness-dsl';
import * as anthropic from 'harness-dsl/anthropic';
import * as cc from 'harness-dsl/claude-code';
import * as git from 'harness-dsl/git';
import * as http from 'harness-dsl/http';
import * as markdown from 'harness-dsl/markdown';
import * as shell from 'harness-dsl/shell';
import * as sqlite from 'harness-dsl/sqlite';

const requested = H.state('requested', 'pending');
const awaitingSmoke = H.state('awaitingSmoke', 'waiting');
const concluding = H.state('concluding', 'pending');
const released = H.state('released', 'terminal', 'success');
const smokeFailed = H.state('smokeFailed', 'terminal', 'failure');
const rejected = H.state('rejected', 'terminal', 'failure');

const Release = H.kind('release')
  .data(
    z.object({
      version: z.string(),
      channel: z.string(),
      platforms: z.array(z.string()),
      summary: z.string().optional(),
    }),
  )
  .states(requested, awaitingSmoke, concluding, released, smokeFailed, rejected)
  .failsTo('rejected');

const queued = H.state('queued', 'pending');
const passed = H.state('passed', 'terminal', 'success');
const failedSmoke = H.state('failedSmoke', 'terminal', 'failure');

const Smoke = H.kind('smoke')
  .data(z.object({ release: z.string(), platform: z.string() }))
  .states(queued, passed, failedSmoke);

const local = shell.local('release-local', { slots: 4 });
const worktree = git.worktree('release-worktree', { repo: '.', slots: 1 });

const announcement = z.object({ version: z.string(), channel: z.string() });

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .output(z.object({ artifacts: z.array(z.string()) }))
  .argv((target) => ['make', 'release', `VERSION=${target.version}`])
  .on(local)
  .recovers('rerun');

const announcementPosted = H.command('announcement-posted')
  .input(announcement)
  .output(z.boolean())
  .argv((post) => ['announcement-exists', '--channel', post.channel, '--version', post.version])
  .on(local)
  .recovers('rerun');

const announce = H.command('announce')
  .input(announcement)
  .argv((post) => ['post-announcement', '--channel', post.channel, '--version', post.version])
  .on(local)
  .recovers(announcementPosted);

const smokeTest = H.command('smoke-test')
  .input(z.object({ release: z.string(), platform: z.string() }))
  .argv((target) => ['smoke-test', '--platform', target.platform, '--version', target.release])
  .on(local)
  .recovers('rerun');

const reviewerRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), artifacts: z.array(z.string()) }))
  .output(z.object({ findings: z.string() }))
  .prompt((release) => `Review release ${release.version}. Artifacts:\n${release.artifacts.join('\n')}`)
  .intents(['read', 'execute']);

const summaryRole = H.role('release-summary')
  .input(z.object({ version: z.string(), findings: z.string() }))
  .output(z.object({ text: z.string() }))
  .prompt((release) => `Write release notes for ${release.version} from these review findings.\n\n${release.findings}`);

const reviewer = H.agent('reviewer', reviewerRole).model(cc.model('claude-opus-4-1')).on(worktree);
const summarizer = H.agent('summarizer', summaryRole).model(anthropic.model('claude-sonnet-4-5'));

const releaseApproval = H.halt('release-approval', z.object({ approved: z.boolean(), note: z.string() }));

const smokeFlow = H.flow('smoke')
  .for(Smoke)
  .does(async (ctx) => {
    const result = await ctx.run(smokeTest, { release: ctx.unit.data.release, platform: ctx.unit.data.platform });
    return result.ok ? 'passed' : 'failedSmoke';
  });

const smoke = H.lane('smoke', Smoke).handler(smokeFlow).wip(4);

const releaseFlow = H.flow('release')
  .for(Release)
  .does(async (ctx) => {
    const { version, channel, platforms } = ctx.unit.data;
    const built = await ctx.run(build, { version });
    if (!built.ok) return ctx.fail(built.error);
    const announced = await ctx.run(announce, { version, channel });
    if (!announced.ok) return ctx.fail(announced.error);
    const reviewed = await ctx.run(reviewer, { version, artifacts: built.value.artifacts });
    if (!reviewed.ok) return ctx.fail(reviewed.error);
    const approval = await ctx.halt(releaseApproval, reviewed.value.findings);
    if (!approval.approved) return ctx.fail(approval.note, 'rejected');
    const [summary] = await ctx.batch(summarizer, [{ version, findings: reviewed.value.findings }]);
    if (summary === undefined) return ctx.fail('batch returned no summary');
    if (!summary.ok) return ctx.fail(summary.error);
    await ctx.update({ summary: summary.value.text });
    await ctx.spawn(
      smoke,
      platforms.map((platform) => ({ release: version, platform })),
    );
    return ctx.wait('awaitingSmoke', { children: true, then: 'concluding' });
  })
  .phase('concluding', async (ctx) => {
    const children = await ctx.children(smoke);
    return children.every((child) => child.state === 'passed') ? 'released' : 'smokeFailed';
  });

const releases = H.lane('releases', Release).handler(releaseFlow).suppliers(H.operator).wip(1);

const releaseAccounts = H.pool('release-accounts', [
  { account: cc.subscription('claude-max', { token: H.env('CLAUDE_TOKEN') }), share: 1 },
  { account: anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') }), share: 1 },
]);

const releaseManagerGrants = [H.ops.readWork, H.ops.writeWork, H.ops.resolveHalts, H.ops.readTelemetry];

export const harness = H.harness('release')
  .ledger(sqlite.ledger('.harness/release.db'))
  .lanes(releases, smoke)
  .pools(releaseAccounts)
  .clients(
    cc.supervisor({ grants: releaseManagerGrants }),
    http.control({ port: 7200, token: H.env('RELEASE_CONTROL_TOKEN'), grants: releaseManagerGrants }),
  )
  .observers(markdown.board('BOARD.md'), markdown.telemetry('TELEMETRY.md'));
