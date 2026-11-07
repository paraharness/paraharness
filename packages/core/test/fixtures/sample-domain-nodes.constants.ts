import { z } from 'zod';
import type { ClaudeModelNode } from '../../src/ast/domain/claude-model-node.js';
import type { FsProtectGuardNode } from '../../src/ast/domain/fs-protect-guard-node.js';
import type { FsReadToolNode } from '../../src/ast/domain/fs-read-tool-node.js';
import type { FsTelemetryCollectorNode } from '../../src/ast/domain/fs-telemetry-collector-node.js';
import type { GitAbortMeta } from '../../src/ast/domain/git-abort-meta.js';
import type { GitCleanWorkingTreeNode } from '../../src/ast/domain/git-clean-working-tree-node.js';
import type { GitCowWorktreeNode } from '../../src/ast/domain/git-cow-worktree-node.js';
import type { GitPatchEquivalenceNode } from '../../src/ast/domain/git-patch-equivalence-node.js';
import type { GitScopeReceipt } from '../../src/ast/domain/git-scope-receipt.js';
import type { GitSnapshotAndResetNode } from '../../src/ast/domain/git-snapshot-and-reset-node.js';
import type { GitSyncReceipt } from '../../src/ast/domain/git-sync-receipt.js';
import type { GitWorktreeHandle } from '../../src/ast/domain/git-worktree-handle.js';
import type { GithubIssuesTrackerNode } from '../../src/ast/domain/github-issues-tracker-node.js';
import type { GithubWebhookStreamNode } from '../../src/ast/domain/github-webhook-stream-node.js';
import type { LocalCommandNode } from '../../src/ast/domain/local-command-node.js';
import type { LocalCommandToolNode } from '../../src/ast/domain/local-command-tool-node.js';
import type { NodeRunnerNode } from '../../src/ast/domain/node-runner-node.js';
import type { SlackApproverNode } from '../../src/ast/domain/slack-approver-node.js';
import type { SlackNotifierNode } from '../../src/ast/domain/slack-notifier-node.js';
import type { SqliteLedgerNode } from '../../src/ast/domain/sqlite-ledger-node.js';
import type { SqliteLessonsNode } from '../../src/ast/domain/sqlite-lessons-node.js';
import type { SqliteTopologyNode } from '../../src/ast/domain/sqlite-topology-node.js';
import { deepFreeze } from '../../src/builders/internal/deep-freeze.js';
import type { SampleTier1ScopeNode } from './sample-tier1-scope-node.js';
import type { SampleTier2ScopeNode } from './sample-tier2-scope-node.js';

/** Zod schema for a sample `GitScopeReceipt` in tests (using `.default('main')` on `baseBranch`). */
export const SAMPLE_SCOPE_RECEIPT_SCHEMA: z.ZodType<GitScopeReceipt> = z.object({
  headRef: z.string(),
  baseRef: z.string(),
  branchName: z.string().optional(),
  baseBranch: z.string().default('main'),
  diffStat: z.string(),
  mutatedFiles: z.array(z.string()),
});

/** Zod schema for a sample `GitSyncReceipt` in tests. */
export const SAMPLE_SYNC_RECEIPT_SCHEMA: z.ZodType<GitSyncReceipt> = z.object({
  rebasedOntoRef: z.string(),
  baseBranch: z.string(),
  updatedFiles: z.array(z.string()),
});

/** Zod schema for sample custom telemetry metrics (`filesRead`, `filesMutated`). */
export const SAMPLE_TELEMETRY_SCHEMA = z.object({ filesRead: z.array(z.string()), filesMutated: z.array(z.string()) });

/** Zod schema for sample abort hook metadata (`abortedSnapshotRef`, `resetToRef`). */
export const SAMPLE_ABORT_META_SCHEMA: z.ZodType<GitAbortMeta> = z.object({
  abortedSnapshotRef: z.string(),
  resetToRef: z.string(),
});

/** Zod schema for sample cross-verifier report (`matrixPassed`, `failingPairs`). */
export const SAMPLE_CROSS_REPORT_SCHEMA = z.object({ matrixPassed: z.boolean(), failingPairs: z.array(z.string()) });

/** Reusable local runner pool AST fixture (`node:runner`). */
export const SAMPLE_RUNNER_NODE: NodeRunnerNode = deepFreeze<NodeRunnerNode>({
  type: 'node:runner', id: 'local-runner', slots: 4, maxDaemons: 2,
});

/** Reusable clean working tree check AST fixture (`git:clean-working-tree`). */
export const SAMPLE_CLEAN_TREE_CHECK_NODE: GitCleanWorkingTreeNode = deepFreeze<GitCleanWorkingTreeNode>({
  type: 'git:clean-working-tree', id: 'git-clean-tree',
});

/** Reusable Tier-1 (`capabilityTier: 'scope'`) isolation scope AST fixture. */
export const SAMPLE_TIER1_SCOPE_NODE: SampleTier1ScopeNode = deepFreeze<SampleTier1ScopeNode>({
  type: 'sample:tier1-scope', id: 'tier1-scope', capabilityTier: 'scope', supportsCheckpoints: false,
  supportsBranching: false, rootDir: '/tmp/tier1', receiptSchema: z.object({ headSha: z.string() }), syncSchema: z.object({}),
});

/** Reusable Tier-2 (`capabilityTier: 'checkpointable'`) isolation scope AST fixture. */
export const SAMPLE_TIER2_SCOPE_NODE: SampleTier2ScopeNode = deepFreeze<SampleTier2ScopeNode>({
  type: 'sample:tier2-scope', id: 'tier2-scope', capabilityTier: 'checkpointable', supportsCheckpoints: true,
  supportsBranching: false, snapshotDir: '/tmp/tier2', receiptSchema: SAMPLE_SCOPE_RECEIPT_SCHEMA, syncSchema: SAMPLE_SYNC_RECEIPT_SCHEMA,
});

/** Reusable Tier-3 (`capabilityTier: 'branchable'`) isolation scope AST fixture (`git:cow-worktree`). */
export const SAMPLE_TIER3_SCOPE_NODE: GitCowWorktreeNode = deepFreeze<GitCowWorktreeNode>({
  type: 'git:cow-worktree', id: 'tier3-scope', capabilityTier: 'branchable', supportsCheckpoints: true,
  supportsBranching: true, repo: '/tmp/repo', dir: '/tmp/worktrees', setupCommands: [],
  conflictCleanCheck: SAMPLE_CLEAN_TREE_CHECK_NODE, receiptSchema: SAMPLE_SCOPE_RECEIPT_SCHEMA, syncSchema: SAMPLE_SYNC_RECEIPT_SCHEMA,
});

/** Reusable pre-flight declared tool AST fixture (`effectTracking: 'declared'`). */
export const SAMPLE_DECLARED_TOOL_NODE: FsReadToolNode<GitWorktreeHandle> = deepFreeze<FsReadToolNode<GitWorktreeHandle>>({
  type: 'fs:read', name: 'fs_read', description: 'Read a file from the active workspace.',
  inputSchema: z.object({ path: z.string() }), effectTracking: 'declared', runner: SAMPLE_RUNNER_NODE,
});

/** Reusable extra comparison tool AST fixture (`name: 'git_compare'`). */
export const SAMPLE_EXTRA_COMPARE_TOOL_NODE: FsReadToolNode<GitWorktreeHandle> = deepFreeze<FsReadToolNode<GitWorktreeHandle>>({
  type: 'fs:read', name: 'git_compare', description: 'Compare two git branches.',
  inputSchema: z.object({ left: z.string(), right: z.string() }), effectTracking: 'declared', runner: SAMPLE_RUNNER_NODE,
});

/** Reusable extra search tool AST fixture (`name: 'ast_grep'`). */
export const SAMPLE_EXTRA_SEARCH_TOOL_NODE: FsReadToolNode<GitWorktreeHandle> = deepFreeze<FsReadToolNode<GitWorktreeHandle>>({
  type: 'fs:read', name: 'ast_grep', description: 'Search AST patterns across files.',
  inputSchema: z.object({ pattern: z.string() }), effectTracking: 'declared', runner: SAMPLE_RUNNER_NODE,
});

/** Reusable one-shot local command step AST fixture (`node:command`). */
export const SAMPLE_LOCAL_COMMAND_NODE: LocalCommandNode<unknown, { readonly exitCode: number }, GitWorktreeHandle> = deepFreeze<
  LocalCommandNode<unknown, { readonly exitCode: number }, GitWorktreeHandle>
>({
  type: 'node:command', id: 'shell-cmd', runner: SAMPLE_RUNNER_NODE, argv: ['sh', '-c', 'echo ok'],
  stdinMode: 'closed', inputSchema: z.unknown(), outputSchema: z.object({ exitCode: z.number() }),
});

/** Reusable post-flight subprocess tool AST fixture (`effectTracking: 'subprocess-post-flight'`). */
export const SAMPLE_POST_FLIGHT_SUBPROCESS_TOOL_NODE: LocalCommandToolNode<GitWorktreeHandle> = deepFreeze<
  LocalCommandToolNode<GitWorktreeHandle>
>({
  type: 'node:command-tool', name: 'shell_exec', description: 'Execute a local subprocess command.',
  inputSchema: z.object({ cmd: z.string() }), effectTracking: 'subprocess-post-flight', command: SAMPLE_LOCAL_COMMAND_NODE,
});

/** Reusable filesystem protect policy guard AST fixture (`fs:protect`). */
export const SAMPLE_GUARD_NODE: FsProtectGuardNode = deepFreeze<FsProtectGuardNode>({
  type: 'fs:protect', id: 'protect-secrets', globs: ['.env', 'secrets/**'],
});

/** Reusable bidirectional human channel AST fixture (`interactionMode: 'bidirectional'`). */
export const SAMPLE_BIDIRECTIONAL_HUMAN_CHANNEL_NODE: SlackApproverNode = deepFreeze<SlackApproverNode>({
  type: 'slack:approver', interactionMode: 'bidirectional',
  appToken: { type: 'harness:env-ref', key: 'SLACK_APP_TOKEN' },
  botToken: { type: 'harness:env-ref', key: 'SLACK_BOT_TOKEN' }, channel: '#approvals',
});

/** Reusable notify-only human channel AST fixture (`interactionMode: 'notify-only'`). */
export const SAMPLE_NOTIFY_ONLY_HUMAN_CHANNEL_NODE: SlackNotifierNode = deepFreeze<SlackNotifierNode>({
  type: 'slack:notifier', interactionMode: 'notify-only',
  webhookUrl: { type: 'harness:env-ref', key: 'SLACK_WEBHOOK_URL' },
});

/** Reusable Claude model AST fixture (`claude:model`). */
export const SAMPLE_MODEL_NODE: ClaudeModelNode = deepFreeze<ClaudeModelNode>({
  type: 'claude:model', vendor: 'anthropic', alias: 'opus', modelId: 'claude-opus-4-6',
});

/** Reusable SQLite ledger store AST fixture (`sqlite:ledger`). */
export const SAMPLE_LEDGER_NODE: SqliteLedgerNode = deepFreeze<SqliteLedgerNode>({ type: 'sqlite:ledger', uri: ':memory:' });

/** Reusable SQLite topology store AST fixture (`sqlite:topology`). */
export const SAMPLE_TOPOLOGY_STORE_NODE: SqliteTopologyNode = deepFreeze<SqliteTopologyNode>({
  type: 'sqlite:topology', uri: ':memory:',
});

/** Reusable SQLite lesson store AST fixture (`sqlite:lessons`). */
export const SAMPLE_LESSON_STORE_NODE: SqliteLessonsNode = deepFreeze<SqliteLessonsNode>({
  type: 'sqlite:lessons', uri: ':memory:',
});

/** Reusable filesystem telemetry collector AST fixture (`fs:telemetry`). */
export const SAMPLE_TELEMETRY_COLLECTOR_NODE: FsTelemetryCollectorNode = deepFreeze<FsTelemetryCollectorNode>({
  type: 'fs:telemetry', id: 'fs-telemetry', schema: SAMPLE_TELEMETRY_SCHEMA,
});

/** Reusable git snapshot-and-reset abort hook AST fixture (`git:snapshot-and-reset`). */
export const SAMPLE_ABORT_HOOK_NODE: GitSnapshotAndResetNode = deepFreeze<GitSnapshotAndResetNode>({
  type: 'git:snapshot-and-reset', id: 'git-snapshot-reset', metaSchema: SAMPLE_ABORT_META_SCHEMA,
});

/** Reusable git patch-equivalence cross-verifier AST fixture (`git:patch-equivalence`). */
export const SAMPLE_CROSS_VERIFIER_NODE: GitPatchEquivalenceNode<z.infer<typeof SAMPLE_CROSS_REPORT_SCHEMA>> = deepFreeze<
  GitPatchEquivalenceNode<z.infer<typeof SAMPLE_CROSS_REPORT_SCHEMA>>
>({
  type: 'git:patch-equivalence', id: 'git-patch-eq', reportSchema: SAMPLE_CROSS_REPORT_SCHEMA,
});

/** Reusable GitHub issues tracker AST fixture (`github:issues`). */
export const SAMPLE_TRACKER_NODE: GithubIssuesTrackerNode<
  { readonly id: string; readonly title: string; readonly ready: boolean },
  'queued' | 'in-progress' | 'needs-human' | 'errored' | 'cancelled' | 'pr-open' | 'abandoned'
> = deepFreeze<
  GithubIssuesTrackerNode<
    { readonly id: string; readonly title: string; readonly ready: boolean },
    'queued' | 'in-progress' | 'needs-human' | 'errored' | 'cancelled' | 'pr-open' | 'abandoned'
  >
>({
  type: 'github:issues', repo: 'acme/app', token: { type: 'harness:env-ref', key: 'GITHUB_TOKEN' },
});

/** Reusable GitHub webhook stream source AST fixture (`github:webhook-stream`). */
export const SAMPLE_STREAM_SOURCE_NODE: GithubWebhookStreamNode<{
  readonly prNumber: number;
  readonly merged: boolean;
}> = deepFreeze<
  GithubWebhookStreamNode<{ readonly prNumber: number; readonly merged: boolean }>
>({
  type: 'github:webhook-stream', secret: { type: 'harness:env-ref', key: 'WEBHOOK_SECRET' }, events: ['pull_request.closed'],
});
