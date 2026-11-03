import { H } from 'harness-dsl';
import { z } from 'zod';
import { subscription, model as claudeModel, supervisor } from 'harness-dsl/claude-code';
import { account, model as apiModel } from 'harness-dsl/anthropic';
import { ledger, store } from 'harness-dsl/sqlite';
import { worktree } from 'harness-dsl/git';
import { local } from 'harness-dsl/shell';
import { board } from 'harness-dsl/markdown';

const releaseTree = worktree('release-worktrees', { repo: '/repos/product', slots: 2 });
const releaseShell = local('release-shell', { slots: 2 });
const smokeShell = local('smoke-shell', { slots: 3 });

const claude = subscription('release-claude', { token: H.env('RELEASE_CLAUDE_TOKEN') });
const api = account('release-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const sonnet = claudeModel('claude-sonnet-4-5');
const batchSonnet = apiModel('claude-sonnet-4-5-batch');

const platform = z.enum(['linux', 'macos', 'windows']);

const requested = H.state('requested', 'pending');
const smoking = H.state('smoking', 'waiting');
const released = H.state('released', 'terminal', 'success');
const rejected = H.state('rejected', 'terminal', 'neutral');
const broken = H.state('broken', 'terminal', 'failure');
const release = H.kind('release')
  .data(z.object({ version: z.string(), platforms: z.array(platform), notes: z.string().optional() }))
  .states(requested, smoking, released, rejected, broken);

const queued = H.state('queued', 'pending');
const passed = H.state('passed', 'terminal', 'success');
const smokeFailed = H.state('smoke-failed', 'terminal', 'failure');
const smoke = H.kind('smoke').data(z.object({ version: z.string(), platform })).states(queued, passed, smokeFailed);

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .on(releaseTree)
  .recovery('rerun');

const announcement = z.object({ version: z.string(), channel: z.string() });
const wasAnnounced = H.command('was-announced')
  .input(announcement)
  .output(z.boolean())
  .argv(input => ['chat-search', input.channel, `Release ${input.version} is building`])
  .on(releaseShell);
const announce = H.command('announce')
  .input(announcement)
  .argv(input => ['chat-post', input.channel, `Release ${input.version} is building`])
  .on(releaseShell)
  .recovery(wasAnnounced);

const reviewRole = H.role('release-review')
  .input(z.object({ version: z.string() }))
  .output(z.object({ notes: z.string() }))
  .prompt(input => `Review the release candidate ${input.version} and list risks.`)
  .intents(['read']);
const reviewer = H.seat('release-reviewer', reviewRole).model(sonnet).on(releaseTree);

const notesRole = H.role('release-notes')
  .input(z.object({ version: z.string(), review: z.string() }))
  .output(z.object({ notes: z.string() }))
  .prompt(input => `Write release notes for ${input.version} from this review:\n${input.review}`);
const summarizer = H.seat('release-summarizer', notesRole).model(batchSonnet);

const releaseApproval = H.halt('release-approval', z.object({ approved: z.boolean(), note: z.string().optional() })).about(
  z.object({ version: z.string(), review: z.string() })
);

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform }))
  .argv(input => ['smoke', input.platform, input.version])
  .on(smokeShell)
  .recovery('rerun');

const runSmoke = H.flow('run-smoke')
  .for(smoke)
  .does(async ctx => {
    const result = await ctx.run(smokeTest, ctx.unit.data);
    return result.ok ? 'passed' : 'smoke-failed';
  });

const smokeLane = H.lane('smoke', smoke)
  .handler(runSmoke)
  .retries(1, { backoff: { first: { minutes: 2 } }, exhausted: 'smoke-failed' })
  .store(store(smoke, '/srv/release/smoke.sqlite'))
  .wip(3);

const shipRelease = H.flow('ship-release')
  .for(release)
  .does(async ctx => {
    const { version, platforms } = ctx.unit.data;
    const built = await ctx.run(build, { version });
    if (!built.ok) return ctx.fail(built.error);
    const posted = await ctx.run(announce, { version, channel: '#releases' });
    if (!posted.ok) return ctx.fail(posted.error);
    const reviewed = await ctx.run(reviewer, { version });
    if (!reviewed.ok) return ctx.fail(reviewed.error);
    const approval = await ctx.halt(releaseApproval, reviewed.value.notes, { version, review: reviewed.value.notes });
    if (!approval.approved) return 'rejected';
    const summaries = await ctx.batch(summarizer, [{ version, review: reviewed.value.notes }]);
    const summary = summaries[0];
    if (summary === undefined || !summary.ok) return ctx.fail('release notes batch returned nothing usable');
    await ctx.update({ notes: summary.value.notes });
    const children = await ctx.spawn(smokeLane, platforms.map(target => ({ version, platform: target })));
    const results = await ctx.suspend('smoking', { children });
    return results.every(child => child.state === 'passed') ? 'released' : 'broken';
  });

const releaseLane = H.lane('releases', release)
  .handler(shipRelease)
  .retries(1, { backoff: { first: { minutes: 10 } }, exhausted: 'broken' })
  .suppliers(H.operator)
  .store(store(release, '/srv/release/releases.sqlite'))
  .wip(1);

export default H.harness('release')
  .ledger(ledger('/srv/release/ledger.sqlite'))
  .lanes(releaseLane, smokeLane)
  .pools(H.pool('release-claude-pool', [{ account: claude, share: 1 }]), H.pool('release-api-pool', [{ account: api, share: 1 }]))
  .clients(
    supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(releaseApproval, H.halts.interrupted, H.halts.definitionChanged),
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(board('/srv/release/BOARD.md'));
