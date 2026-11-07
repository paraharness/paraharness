import { H } from '@harness-dsl/core';
import { claude } from '@harness-dsl/claude';
import { github } from '@harness-dsl/github';
import { local } from '@harness-dsl/node';
import { slack } from '@harness-dsl/slack';
import { sqlite } from '@harness-dsl/sqlite';
import { changeShippedSignal, prClosedUnmergedSignal } from './signals-and-interrupts.constants.js';

/**
 * Local OS subprocess and daemon runner pool configured with 8 execution slots and 8 daemon slots (`CODING_SAMPLE.md` §6.2).
 *
 * Bounds concurrent child process execution and ephemeral service daemons across worktrees.
 */
export const runner = local.runner({ slots: 8, maxDaemons: 8 });

/**
 * Account capacity pool (`claude-accounts`) balancing across two CLI subscriptions with an API key fallback (`CODING_SAMPLE.md` §6.2).
 *
 * Uses the `'soonest-reset'` selection strategy and falls back to `H.env('ANTHROPIC_API_KEY')` on rate-limit exhaustion.
 */
export const claudeAccounts = H.pool('claude-accounts')
  .with(
    claude.cliAccount('sub-a').configDir('~/.claude-a'),
    claude.cliAccount('sub-b').configDir('~/.claude-b'),
  )
  .strategy('soonest-reset')
  .fallback(claude.cliAccount('api-fallback').apiKey(H.env('ANTHROPIC_API_KEY')));

/**
 * Claude Sonnet 4.6 model declaration backed by `claudeAccounts` (`CODING_SAMPLE.md` §6.2).
 *
 * Used as the primary default worker model and contrastive lesson distillation model.
 */
export const sonnet = claude
  .model('sonnet', { id: 'claude-sonnet-4-6' })
  .accountPool(claudeAccounts);

/**
 * Claude Opus 4.6 model declaration backed by `claudeAccounts` (`CODING_SAMPLE.md` §6.2).
 *
 * Used for `coordinator`, `evaluator`, `leaseAdjudicator`, `candidateArbiter`, and retry escalation in `workerModels`.
 */
export const opus = claude
  .model('opus', { id: 'claude-opus-4-6' })
  .accountPool(claudeAccounts);

/**
 * Adaptive model pool (`worker-models`) escalating from `sonnet` to `opus` on retry (`CODING_SAMPLE.md` §6.2).
 *
 * Enforces a minimum empirical success rate of `0.75` after `10` samples before selecting the lower-tier model.
 */
export const workerModels = H.pool('worker-models')
  .with(sonnet, opus)
  .strategy(($) => $.escalateOnRetry().minSuccessRate(0.75).minSamples(10));

/**
 * Two-temperature SQLite checkpoint and trajectory ledger (`.harness/state.sqlite`) (`CODING_SAMPLE.md` §6.2).
 *
 * Retains full wire-level frames in the hot tier during active runs and compacts to cold audit summaries
 * 24 hours after `changeShippedSignal` or 168 hours after terminal `'done'` exit while retaining failed runs for 14 days.
 */
export const ledger = sqlite
  .ledger('.harness/state.sqlite')
  .compactWhen(($c) =>
    $c
      .onSignal(changeShippedSignal, {
        correlateBy: (sig) => sig.ref,
        afterGracePeriodHours: 24,
      })
      .onTerminalExit(['done'], { afterGracePeriodHours: 168 })
      .retainFailedRunsForDays(14),
  );

/**
 * Slack bot adapter configured with symbolic `H.env(...)` credentials (`CODING_SAMPLE.md` §6.2).
 *
 * Serves both as the notification channel for `owner` and as an exposed control-plane surface on `appHarness`.
 */
export const slackBot = slack.bot({
  appToken: H.env('SLACK_APP_TOKEN'),
  botToken: H.env('SLACK_BOT_TOKEN'),
  channel: H.env('SLACK_CHANNEL_ID'),
});

/**
 * Human escalation actor (`owner`) notified via `slackBot` with a 60-second keep-alive window (`CODING_SAMPLE.md` §6.2).
 *
 * Adjudicates exogenous `normativeEscalation` trade-offs, budget approvals, and high-leverage lesson notifications.
 */
export const owner = H.human('owner')
  .keepAliveSeconds(60)
  .notify(slackBot);

/**
 * Deterministic OS command (`drizzle-generate`) generating SQL migrations for `@acme/db` (`CODING_SAMPLE.md` §6.3).
 *
 * Unlocked on demand when an agent pulls `dbMigrationSkill`.
 */
export const drizzleGenerate = local
  .command('drizzle-generate')
  .runner(runner)
  .stdin('closed')
  .env({ CI: 'true', GIT_TERMINAL_PROMPT: '0' })
  .argv(['pnpm', '--filter', '@acme/db', 'db:generate']);

/**
 * Streaming test suite check (`verify-suite`) with stdout circuit-breaking (`CODING_SAMPLE.md` §6.3).
 *
 * Sets `effectTracking: 'subprocess-post-flight'` when mounted via `.asTool()` so `CheckpointableScope.diffEffects()`
 * verifies post-flight that test runs never mutate protected files.
 */
export const verifySuite = local
  .streamCheck('verify-suite')
  .runner(runner)
  .argv(['pnpm', 'test', '--run'])
  .circuitBreakWhenStdout(/FAIL\s+packages\/.*?\n\s*●/, {
    graceLinesAfterMatch: 25,
  })
  .timeoutMinutes(5);

/**
 * Skill-scoped ephemeral PostgreSQL 16 daemon (`local-pg`) with an interactive `psql` channel (`CODING_SAMPLE.md` §6.3).
 *
 * Allocates a collision-free `pgPort` per scope and tears down the container when the skill lease expires.
 */
export const localPostgres = local
  .daemon('local-pg')
  .runner(runner)
  .lifecycle('skill')
  .port('pgPort')
  .start(({ ports, scopeKey }) => [
    'docker', 'run', '--rm',
    '--name', `harness-pg-${scopeKey}`,
    '-p', `${ports.pgPort}:5432`,
    '--tmpfs', '/var/lib/postgresql/data',
    '-e', 'PGDATA=/var/lib/postgresql/data/pgdata',
    '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:16-alpine',
  ])
  .stopCommand(({ scopeKey }) => ['docker', 'rm', '-f', '-v', `harness-pg-${scopeKey}`])
  .readyWhenStdout(
    /listening on IPv4 address "0\.0\.0\.0", port 5432[\s\S]*database system is ready to accept connections/,
  )
  .interact('psql', {
    command: ({ ports }) => ['psql', '-P', 'pager=off', `postgres://postgres@localhost:${ports.pgPort}/postgres`],
    frameDelimiter: /postgres[=>\-#\x27("$\*][#>]\s*$/,
    idleSettleMs: 300,
    timeoutSeconds: 10,
  });

/**
 * Skill-scoped headless browser sandbox daemon (`browser-sandbox`) with a CDP REPL channel (`CODING_SAMPLE.md` §6.3).
 *
 * Allocates `webPort` and `cdpPort` per scope for interactive UI verification in `@acme/web`.
 */
export const browserSandbox = local
  .daemon('browser-sandbox')
  .runner(runner)
  .lifecycle('skill')
  .port('webPort')
  .port('cdpPort')
  .start(({ ports }) => [
    'pnpm', '--filter', '@acme/web', 'dev:headless',
    '--port', String(ports.webPort),
    '--remote-debugging-port', String(ports.cdpPort),
  ])
  .readyWhenStdout(/Ready in \d+ms/)
  .interact('browser-ctl', {
    command: ({ ports }) => ['pnpm', 'tsx', '.harness/bin/cdp-repl.ts', String(ports.cdpPort)],
    frameDelimiter: /cdp>\s*$/,
    idleSettleMs: 250,
    timeoutSeconds: 15,
  });

/**
 * GitHub webhook event stream source listening for `pull_request.closed` events on `acme/app` (`CODING_SAMPLE.md` §6.3).
 *
 * Validates webhook signatures using symbolic `H.env('GH_WEBHOOK_SECRET')`.
 */
export const githubWebhookSource = github.webhookStream({
  repo: 'acme/app',
  secret: H.env('GH_WEBHOOK_SECRET'),
  events: ['pull_request.closed'],
});

/**
 * Filtered event stream (`github-merge-events`) translating merged `fix/<ref>` pull requests into `changeShippedSignal` (`CODING_SAMPLE.md` §6.3).
 *
 * Extracts the issue `ref`, `mergeCommitSha`, and `baseBranch` for stacked-PR topology overlay commitment.
 */
export const githubMergeStream = H.stream('github-merge-events')
  .source(githubWebhookSource)
  .filter((ev) => ev.pull_request.merged === true && /^fix\//.test(ev.pull_request.head.ref))
  .emitSignal(changeShippedSignal, (ev) => ({
    ref: ev.pull_request.head.ref.replace(/^fix\//, ''),
    mergeCommitSha: ev.pull_request.merge_commit_sha,
    baseBranch: ev.pull_request.base.ref,
  }));

/**
 * Filtered event stream (`github-pr-closed-events`) translating unmerged closed `fix/<ref>` pull requests into `prClosedUnmergedSignal` (`CODING_SAMPLE.md` §6.3).
 *
 * Triggers cleanup of any sealed `repoTopology` overlay associated with the closed pull request's `ref`.
 */
export const githubPrClosedStream = H.stream('github-pr-closed-events')
  .source(githubWebhookSource)
  .filter((ev) => ev.pull_request.merged === false && /^fix\//.test(ev.pull_request.head.ref))
  .emitSignal(prClosedUnmergedSignal, (ev) => ({
    ref: ev.pull_request.head.ref.replace(/^fix\//, ''),
  }));
