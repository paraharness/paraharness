import { H } from '@harness-dsl/core';
import { git } from '@harness-dsl/git';
import { github } from '@harness-dsl/github';
import { mcp } from '@harness-dsl/node';
import { engineeringFlow } from './delivery-and-flow.constants.js';
import { workItem } from './engineering-schemas.schema.js';
import {
  claudeAccounts,
  githubMergeStream,
  githubPrClosedStream,
  ledger,
  owner,
  runner,
  slackBot,
  workerModels,
} from './pools-and-services.constants.js';
import {
  highLeverageLessonSignal,
  steerSignal,
} from './signals-and-interrupts.constants.js';

/**
 * GitHub issues tracker adapter (`acme/app`) authenticated via symbolic `H.env('GITHUB_TOKEN')` (`CODING_SAMPLE.md` §6.9).
 *
 * Polls open issues and synchronizes lifecycle status labels for `engineeringLane`.
 */
export const issuesTracker = github.issues({ repo: 'acme/app', token: H.env('GITHUB_TOKEN') });

/**
 * Priority-aged, DAG-aware engineering work lane (`engineering`) executing `engineeringFlow` (`CODING_SAMPLE.md` §6.9).
 *
 * Polls `issuesTracker` every 60 seconds, maps `'agent-ready'` issues and `partition:*` labels into `workItem` inputs,
 * enforces concurrency 4 with dependency waiting, budget approval, retry backoff, and `steerSignal` worktree-preserving rewinds.
 */
export const engineeringLane = H.lane('engineering')
  .input(workItem)
  .key((item) => item.ref)
  .tracker(issuesTracker, ($) =>
    $
      .everySeconds(60)
      .from((issue) => {
        const labelSet = new Set<string>(issue.labels);
        if (!labelSet.has('agent-ready')) return undefined;

        const partitions: Array<'db' | 'api' | 'web'> = [];
        for (const label of issue.labels) {
          if (label === 'partition:db') {
            partitions.push('db');
          } else if (label === 'partition:api') {
            partitions.push('api');
          } else if (label === 'partition:web') {
            partitions.push('web');
          }
        }

        const hasDeepLabel =
          labelSet.has('epic') || labelSet.has('architecture') || labelSet.has('deep');
        const routingTier = hasDeepLabel || partitions.length > 1 ? 'deep' : 'auto';

        return {
          ref: `#${issue.number}`,
          title: issue.title,
          description: issue.body ?? '',
          routingTier,
          targetPartitions: partitions,
          dependsOn: [],
        };
      })
      .onQueued('queued')
      .onRunning('in-progress')
      .onWaiting('needs-human')
      .onErrored('errored')
      .onCancelled('cancelled')
      .onExit('done', 'pr-open')
      .onExit('abandoned', 'needs-triage')
      .onExit('exhausted', 'needs-triage'),
  )
  .flow(engineeringFlow)
  .concurrency(4)
  .priority('high')
  .agingMinutes(30)
  .waitFor((item) => item.dependsOn, 'abandoned')
  .maxCostUsd(
    20,
    owner
      .withName('budget-approver')
      .output(H.BudgetApprovalSchema),
  )
  .retry(($) => $.tries(2).exponential(5_000).orFail('exhausted'))
  .onSignal(steerSignal, ($) =>
    $
      .update((cur, sig) => ({
        ...cur,
        routingTier: 'deep' as const,
        description: `${cur.description}\n\nOwner steering note: ${sig.note}`,
      }))
      .rewindTo('execute-work', { onRewind: git.keepWorktree() }),
  );

/**
 * Complete top-level production engineering harness (`acme-engineering`) (`CODING_SAMPLE.md` §6.9).
 *
 * Binds the two-temperature `ledger`, capacity pools (`claudeAccounts`, `workerModels`, `runner`),
 * GitHub webhook event streams (`githubMergeStream`, `githubPrClosedStream`), `engineeringLane`,
 * `highLeverageLessonSignal` owner notifications, and MCP + Slack control planes.
 */
export const appHarness = H.harness('acme-engineering')
  .ledger(ledger)
  .pools(claudeAccounts, workerModels, runner)
  .streams(githubMergeStream, githubPrClosedStream)
  .lanes(engineeringLane)
  .onSignal(highLeverageLessonSignal, ($sig) =>
    $sig.notify(owner, (sig) =>
      `High-leverage lesson [${sig.lessonId}] in partition '${sig.partition ?? 'global'}' ` +
      `(${sig.cleanPassCount} clean passes, ${sig.violatedCount} violations):\n"${sig.directive}"\n` +
      `Consider promoting to repoRules or a deterministic check.`,
    ),
  )
  .expose(
    mcp.server({ port: 9100 }),
    slackBot,
  );
