import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as git from 'harness-dsl/git';
import * as markdown from 'harness-dsl/markdown';

const subscription = claude.subscription('claude-release', { token: H.env('CLAUDE_RELEASE_TOKEN') });
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });
const reviewModel = claude.model('claude-sonnet-4');
const batchModel = anthropic.model('claude-haiku-4');
const pool = H.pool('release-accounts', [
  { account: subscription, share: 1 },
  { account: apiAccount, share: 1 },
]);

const localRunner = shell.local('local', { slots: 4 });
const worktree = git.worktree('release-worktree', { repo: '.', slots: 2 });

const release = H.kind('release')
  .data(
    z.object({
      version: z.string(),
      channel: z.string(),
      platforms: z.array(z.string()),
      notes: z.string().optional(),
    })
  )
  .states(
    H.state('requested', 'pending'),
    H.state('released', 'terminal', 'success'),
    H.state('rejected', 'terminal', 'neutral'),
    H.state('smoke-failed', 'terminal', 'failure'),
    H.state('release-stuck', 'terminal', 'failure')
  );

const smoke = H.kind('smoke')
  .data(z.object({ version: z.string(), platform: z.string() }))
  .states(H.state('queued', 'pending'), H.state('passed', 'terminal', 'success'), H.state('failed', 'terminal', 'failure'));

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv(input => ['make', 'release', `VERSION=${input.version}`])
  .on(localRunner)
  .recovery('rerun');

const announcement = z.object({ version: z.string(), channel: z.string() });
const announcementPosted = H.command('announcement-posted')
  .input(announcement)
  .output(z.boolean())
  .argv(input => ['./release/announced.sh', input.channel, input.version])
  .on(localRunner);
const announce = H.command('announce')
  .input(announcement)
  .argv(input => ['./release/announce.sh', input.channel, input.version])
  .on(localRunner)
  .recovery(announcementPosted);

const reviewRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), buildLog: z.string() }))
  .output(z.object({ findings: z.string() }))
  .prompt(input => `Review release ${input.version}. Build log:\n${input.buildLog}`)
  .intents(['read']);
const reviewer = H.seat('release-reviewer', reviewRole).model(reviewModel).on(worktree);

const summaryRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), findings: z.string() }))
  .output(z.object({ notes: z.string() }))
  .prompt(input => `Write release notes for ${input.version} from these findings:\n${input.findings}`);
const summarizer = H.seat('release-summarizer', summaryRole).model(batchModel);
const summarize = H.job('summarize').batch(summarizer, { minutes: 5 });

const approval = H.halt('release-approval', z.object({ approve: z.boolean(), note: z.string().optional() }));

const smokeTest = H.command('smoke-test')
  .input(z.object({ version: z.string(), platform: z.string() }))
  .argv(input => ['./release/smoke.sh', input.platform, input.version])
  .on(localRunner)
  .recovery('rerun');

const runSmoke = H.flow('run-smoke')
  .for(smoke)
  .does(async ctx => {
    const result = await ctx.run(smokeTest, { version: ctx.unit.data.version, platform: ctx.unit.data.platform });
    return result.ok ? 'passed' : 'failed';
  });

const smokeLane = H.lane('smoke', smoke)
  .handler(runSmoke)
  .retries(1, { exhausted: 'failed' })
  .store(sqlite.store(smoke, '.harness/smoke.sqlite'))
  .wip(4);

const shipRelease = H.flow('ship-release')
  .for(release)
  .does(async ctx => {
    const { version, channel, platforms } = ctx.unit.data;
    const built = await ctx.run(build, { version });
    if (!built.ok) return ctx.fail(built.error);
    const announced = await ctx.run(announce, { version, channel });
    if (!announced.ok) return ctx.fail(announced.error);
    const reviewed = await ctx.run(reviewer, { version, buildLog: built.value });
    if (!reviewed.ok) return ctx.fail(reviewed.error);
    const decision = await ctx.halt(approval, reviewed.value.findings);
    if (!decision.approve) return 'rejected';
    const summaries = await ctx.run(summarize, [{ version, findings: reviewed.value.findings }]);
    if (!summaries.ok) return ctx.fail(summaries.error);
    const first = summaries.value.find(item => item.ok);
    if (first === undefined || !first.ok) return ctx.fail('the summary batch returned no notes');
    await ctx.update({ notes: first.value.notes });
    const children = await ctx.spawn(
      smokeLane,
      platforms.map(platform => ({ version, platform }))
    );
    const results = await ctx.sleep({ children });
    return results.every(result => result.state === 'passed') ? 'released' : 'smoke-failed';
  });

const releases = H.lane('releases', release)
  .handler(shipRelease)
  .retries(0, { exhausted: 'release-stuck' })
  .suppliers(H.operator)
  .store(sqlite.store(release, '.harness/releases.sqlite'))
  .wip(1);

export const releaseHarness = H.harness('release')
  .ledger(sqlite.ledger('.harness/ledger.sqlite'))
  .lanes(releases, smokeLane)
  .pools(pool)
  .scheduler(H.policy.scheduler('oldest-first', view => ({ start: [...view.pending].sort((a, b) => b.waitedMs - a.waitedMs) })))
  .clients(
    claude.supervisor('release-manager', {
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.resolve(approval, H.halts.interrupted, H.halts.definitionChanged),
        H.ops.readTelemetry,
      ],
    })
  )
  .observers(markdown.board('.harness/board.md'), markdown.telemetry('.harness/telemetry.md'));
