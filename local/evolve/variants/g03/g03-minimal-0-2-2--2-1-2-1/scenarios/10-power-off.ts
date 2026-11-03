import { z } from 'zod';
import { H } from 'harness-dsl';
import * as claude from 'harness-dsl/claude-code';
import * as anthropic from 'harness-dsl/anthropic';
import * as sqlite from 'harness-dsl/sqlite';
import * as shell from 'harness-dsl/shell';
import * as markdown from 'harness-dsl/markdown';

const platformSchema = z.enum(['linux', 'macos', 'windows']);

const release = H.kind('release')
  .data(
    z.object({
      version: z.string(),
      channel: z.string(),
      platforms: z.array(platformSchema),
      summary: z.string().optional(),
    })
  )
  .states(
    H.state('requested', 'pending'),
    H.state('awaiting-smoke', 'waiting'),
    H.state('released', 'terminal', 'success'),
    H.state('smoke-failed', 'terminal', 'failure'),
    H.state('rejected', 'terminal', 'neutral')
  );

const smoke = H.kind('smoke')
  .data(z.object({ release: z.string(), platform: platformSchema }))
  .states(H.state('queued', 'pending'), H.state('passed', 'terminal', 'success'), H.state('broken', 'terminal', 'failure'));

const buildHost = shell.local('build-host', { slots: 2 });
const smokeHosts = shell.local('smoke-hosts', { slots: 3 });

const sonnet = anthropic.model('claude-sonnet-4-5');
const apiAccount = anthropic.account('anthropic-api', { apiKey: H.env('ANTHROPIC_API_KEY') });

const build = H.command('build')
  .input(z.object({ version: z.string() }))
  .argv((input) => ['make', 'release', `VERSION=${input.version}`])
  .on(buildHost)
  .recovery('rerun');

const announcementSchema = z.object({ channel: z.string(), version: z.string() });

const announcementPosted = H.command('announcement-posted')
  .input(announcementSchema)
  .output(z.boolean())
  .argv((input) => ['chat-history', 'contains', '--channel', input.channel, '--text', `Release ${input.version}`])
  .on(buildHost);

const announce = H.command('announce')
  .input(announcementSchema)
  .argv((input) => ['chat-post', '--channel', input.channel, '--text', `Release ${input.version} is on its way`])
  .on(buildHost)
  .recovery(announcementPosted);

const reviewerRole = H.role('release-reviewer')
  .input(z.object({ version: z.string(), buildLog: z.string() }))
  .output(z.object({ notes: z.string() }))
  .prompt((input) => `Review release ${input.version}. Build log:\n${input.buildLog}`);

const summarizerRole = H.role('release-summarizer')
  .input(z.object({ version: z.string(), notes: z.string() }))
  .output(z.object({ text: z.string() }))
  .prompt((input) => `Write release notes for ${input.version} from:\n${input.notes}`);

const reviewer = H.seat('release-reviewer', reviewerRole).model(sonnet);
const summarizer = H.seat('release-summarizer', summarizerRole).model(sonnet);

const releaseApproval = H.halt('release-approval', z.object({ approved: z.boolean(), note: z.string().optional() }));

const smokeTest = H.command('smoke-test')
  .input(z.object({ release: z.string(), platform: platformSchema }))
  .argv((input) => ['smoke', '--release', input.release, '--platform', input.platform])
  .on(smokeHosts)
  .recovery('rerun');

const smokeFlow = H.flow('smoke').for(smoke).does(async (ctx) => {
  const result = await ctx.run(smokeTest, ctx.unit.data);
  if (!result.ok) return ctx.fail(result.error);
  return 'passed';
});

const smokeLane = H.lane('smoke', smoke).handler(smokeFlow, { retries: 1, exhausted: 'broken' }).wip(3);

const releaseFlow = H.flow('release').for(release).does(async (ctx) => {
  const { version, channel, platforms } = ctx.unit.data;
  const built = await ctx.run(build, { version });
  if (!built.ok) return ctx.fail(built.error);
  const announced = await ctx.run(announce, { channel, version });
  if (!announced.ok) return ctx.fail(announced.error);
  const reviewed = await ctx.run(reviewer, { version, buildLog: built.value });
  if (!reviewed.ok) return ctx.fail(reviewed.error);
  const approval = await ctx.halt(releaseApproval, reviewed.value.notes);
  if (!approval.approved) return 'rejected';
  const summaries = await ctx.batch(summarizer, [{ version, notes: reviewed.value.notes }]);
  const summary = summaries[0];
  if (summary === undefined || !summary.ok) return ctx.fail('release summary batch failed');
  await ctx.update({ summary: summary.value.text });
  const children = await ctx.spawn(
    smokeLane,
    platforms.map((platform) => ({ release: version, platform }))
  );
  const results = await ctx.suspend('awaiting-smoke', { children });
  return results.every((child) => child.state === 'passed') ? 'released' : 'smoke-failed';
});

const releaseLane = H.lane('releases', release)
  .handler(releaseFlow, { exhausted: H.halts.exhausted })
  .suppliers(H.operator)
  .store(sqlite.store(release, '/srv/release/.harness/releases.sqlite'))
  .wip(1);

export const releaseHarness = H.harness('release-train')
  .ledger(sqlite.ledger('/srv/release/.harness/ledger.sqlite'))
  .lanes(releaseLane, smokeLane)
  .pools(H.pool('api', [{ account: apiAccount, share: 1 }]))
  .clients(
    claude.supervisor({
      grants: [
        H.ops.readWork,
        H.ops.writeWork,
        H.ops.readTelemetry,
        H.ops.resolve(releaseApproval, H.halts.interrupted, H.halts.definitionChanged, H.halts.exhausted),
      ],
    })
  )
  .observers(markdown.board('/srv/release/.harness/board.md'));
