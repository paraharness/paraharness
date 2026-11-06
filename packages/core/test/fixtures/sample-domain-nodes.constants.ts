import { z } from 'zod';
import { deepFreeze } from '../../src/builders/internal/deep-freeze.js';
import type {
  ClaudeModelNode,
  FsProtectGuardNode,
  FsReadToolNode,
  FsTelemetryCollectorNode,
  GitAbortMeta,
  GitCleanWorkingTreeNode,
  GitCowWorktreeNode,
  GitPatchEquivalenceNode,
  GitScopeReceipt,
  GitSnapshotAndResetNode,
  GitSyncReceipt,
  GitWorktreeHandle,
  GithubIssuesTrackerNode,
  GithubWebhookStreamNode,
  LocalCommandNode,
  LocalCommandToolNode,
  NodeRunnerNode,
  SlackApproverNode,
  SlackNotifierNode,
  SqliteLedgerNode,
  SqliteLessonsNode,
  SqliteTopologyNode,
} from '../../src/index.js';
import type { SampleTier1ScopeNode } from './sample-tier1-scope-node.js';
import type { SampleTier2ScopeNode } from './sample-tier2-scope-node.js';

/** Zod schema for a sample `GitScopeReceipt` in tests (using `.default('main')` on `baseBranch`). */
export const SampleScopeReceiptSchema: z.ZodType<GitScopeReceipt, z.ZodTypeDef, unknown> = z.object({
  headRef: z.string(),
  baseRef: z.string(),
  branchName: z.string().optional(),
  baseBranch: z.string().default('main'),
  diffStat: z.string(),
  mutatedFiles: z.array(z.string()),
});

/** Zod schema for a sample `GitSyncReceipt` in tests. */
export const SampleSyncReceiptSchema: z.ZodType<GitSyncReceipt, z.ZodTypeDef, unknown> = z.object({
  rebasedOntoRef: z.string(),
  baseBranch: z.string(),
  updatedFiles: z.array(z.string()),
});

/** Zod schema for sample custom telemetry metrics (`filesRead`, `filesMutated`). */
export const SampleTelemetrySchema = z.object({ filesRead: z.array(z.string()), filesMutated: z.array(z.string()) });

/** Zod schema for sample abort hook metadata (`abortedSnapshotRef`, `resetToRef`). */
export const SampleAbortMetaSchema: z.ZodType<GitAbortMeta, z.ZodTypeDef, unknown> = z.object({
  abortedSnapshotRef: z.string(),
  resetToRef: z.string(),
});

/** Zod schema for sample cross-verifier report (`matrixPassed`, `failingPairs`). */
export const SampleCrossReportSchema = z.object({ matrixPassed: z.boolean(), failingPairs: z.array(z.string()) });

/** Reusable local runner pool AST fixture (`node:runner`). */
export const SampleRunnerNode: NodeRunnerNode = deepFreeze<NodeRunnerNode>({
  type: 'node:runner', id: 'local-runner', slots: 4, maxDaemons: 2,
});

/** Reusable clean working tree check AST fixture (`git:clean-working-tree`). */
export const SampleCleanTreeCheckNode: GitCleanWorkingTreeNode = deepFreeze<GitCleanWorkingTreeNode>({
  type: 'git:clean-working-tree', id: 'git-clean-tree',
});

/** Reusable Tier-1 (`capabilityTier: 'scope'`) isolation scope AST fixture. */
export const Tier1ScopeNode: SampleTier1ScopeNode = deepFreeze<SampleTier1ScopeNode>({
  type: 'sample:tier1-scope', id: 'tier1-scope', capabilityTier: 'scope', supportsCheckpoints: false,
  supportsBranching: false, rootDir: '/tmp/tier1', receiptSchema: z.object({ headSha: z.string() }), syncSchema: z.object({}),
});

/** Reusable Tier-2 (`capabilityTier: 'checkpointable'`) isolation scope AST fixture. */
export const Tier2ScopeNode: SampleTier2ScopeNode = deepFreeze<SampleTier2ScopeNode>({
  type: 'sample:tier2-scope', id: 'tier2-scope', capabilityTier: 'checkpointable', supportsCheckpoints: true,
  supportsBranching: false, snapshotDir: '/tmp/tier2', receiptSchema: SampleScopeReceiptSchema, syncSchema: SampleSyncReceiptSchema,
});

/** Reusable Tier-3 (`capabilityTier: 'branchable'`) isolation scope AST fixture (`git:cow-worktree`). */
export const Tier3ScopeNode: GitCowWorktreeNode = deepFreeze<GitCowWorktreeNode>({
  type: 'git:cow-worktree', id: 'tier3-scope', capabilityTier: 'branchable', supportsCheckpoints: true,
  supportsBranching: true, repo: '/tmp/repo', dir: '/tmp/worktrees', setupCommands: [],
  conflictCleanCheck: SampleCleanTreeCheckNode, receiptSchema: SampleScopeReceiptSchema, syncSchema: SampleSyncReceiptSchema,
});

/** Reusable pre-flight declared tool AST fixture (`effectTracking: 'declared'`). */
export const DeclaredToolNode: FsReadToolNode<GitWorktreeHandle> = deepFreeze<FsReadToolNode<GitWorktreeHandle>>({
  type: 'fs:read', name: 'fs_read', description: 'Read a file from the active workspace.',
  inputSchema: z.object({ path: z.string() }), effectTracking: 'declared', runner: SampleRunnerNode,
});

/** Reusable extra comparison tool AST fixture (`name: 'git_compare'`). */
export const ExtraCompareToolNode: FsReadToolNode<GitWorktreeHandle> = deepFreeze<FsReadToolNode<GitWorktreeHandle>>({
  type: 'fs:read', name: 'git_compare', description: 'Compare two git branches.',
  inputSchema: z.object({ left: z.string(), right: z.string() }), effectTracking: 'declared', runner: SampleRunnerNode,
});

/** Reusable extra search tool AST fixture (`name: 'ast_grep'`). */
export const ExtraSearchToolNode: FsReadToolNode<GitWorktreeHandle> = deepFreeze<FsReadToolNode<GitWorktreeHandle>>({
  type: 'fs:read', name: 'ast_grep', description: 'Search AST patterns across files.',
  inputSchema: z.object({ pattern: z.string() }), effectTracking: 'declared', runner: SampleRunnerNode,
});

/** Reusable one-shot local command step AST fixture (`node:command`). */
export const SampleLocalCommandNode: LocalCommandNode<unknown, { readonly exitCode: number }, GitWorktreeHandle> = deepFreeze<
  LocalCommandNode<unknown, { readonly exitCode: number }, GitWorktreeHandle>
>({
  type: 'node:command', id: 'shell-cmd', runner: SampleRunnerNode, argv: ['sh', '-c', 'echo ok'],
  stdinMode: 'closed', inputSchema: z.unknown(), outputSchema: z.object({ exitCode: z.number() }),
});

/** Reusable post-flight subprocess tool AST fixture (`effectTracking: 'subprocess-post-flight'`). */
export const PostFlightSubprocessToolNode: LocalCommandToolNode<GitWorktreeHandle> = deepFreeze<
  LocalCommandToolNode<GitWorktreeHandle>
>({
  type: 'node:command-tool', name: 'shell_exec', description: 'Execute a local subprocess command.',
  inputSchema: z.object({ cmd: z.string() }), effectTracking: 'subprocess-post-flight', command: SampleLocalCommandNode,
});

/** Reusable filesystem protect policy guard AST fixture (`fs:protect`). */
export const SampleGuardNode: FsProtectGuardNode = deepFreeze<FsProtectGuardNode>({
  type: 'fs:protect', id: 'protect-secrets', globs: ['.env', 'secrets/**'],
});

/** Reusable bidirectional human channel AST fixture (`interactionMode: 'bidirectional'`). */
export const BidirectionalHumanChannelNode: SlackApproverNode = deepFreeze<SlackApproverNode>({
  type: 'slack:approver', interactionMode: 'bidirectional',
  appToken: { type: 'harness:env-ref', key: 'SLACK_APP_TOKEN' },
  botToken: { type: 'harness:env-ref', key: 'SLACK_BOT_TOKEN' }, channel: '#approvals',
});

/** Reusable notify-only human channel AST fixture (`interactionMode: 'notify-only'`). */
export const NotifyOnlyHumanChannelNode: SlackNotifierNode = deepFreeze<SlackNotifierNode>({
  type: 'slack:notifier', interactionMode: 'notify-only',
  webhookUrl: { type: 'harness:env-ref', key: 'SLACK_WEBHOOK_URL' },
});

/** Reusable Claude model AST fixture (`claude:model`). */
export const SampleModelNode: ClaudeModelNode = deepFreeze<ClaudeModelNode>({
  type: 'claude:model', vendor: 'anthropic', alias: 'opus', modelId: 'claude-opus-4-6',
});

/** Reusable SQLite ledger store AST fixture (`sqlite:ledger`). */
export const SampleLedgerNode: SqliteLedgerNode = deepFreeze<SqliteLedgerNode>({ type: 'sqlite:ledger', uri: ':memory:' });

/** Reusable SQLite topology store AST fixture (`sqlite:topology`). */
export const SampleTopologyStoreNode: SqliteTopologyNode = deepFreeze<SqliteTopologyNode>({
  type: 'sqlite:topology', uri: ':memory:',
});

/** Reusable SQLite lesson store AST fixture (`sqlite:lessons`). */
export const SampleLessonStoreNode: SqliteLessonsNode = deepFreeze<SqliteLessonsNode>({
  type: 'sqlite:lessons', uri: ':memory:',
});

/** Reusable filesystem telemetry collector AST fixture (`fs:telemetry`). */
export const SampleTelemetryCollectorNode: FsTelemetryCollectorNode = deepFreeze<FsTelemetryCollectorNode>({
  type: 'fs:telemetry', id: 'fs-telemetry', schema: SampleTelemetrySchema,
});

/** Reusable git snapshot-and-reset abort hook AST fixture (`git:snapshot-and-reset`). */
export const SampleAbortHookNode: GitSnapshotAndResetNode = deepFreeze<GitSnapshotAndResetNode>({
  type: 'git:snapshot-and-reset', id: 'git-snapshot-reset', metaSchema: SampleAbortMetaSchema,
});

/** Reusable git patch-equivalence cross-verifier AST fixture (`git:patch-equivalence`). */
export const SampleCrossVerifierNode: GitPatchEquivalenceNode<z.infer<typeof SampleCrossReportSchema>> = deepFreeze<
  GitPatchEquivalenceNode<z.infer<typeof SampleCrossReportSchema>>
>({
  type: 'git:patch-equivalence', id: 'git-patch-eq', reportSchema: SampleCrossReportSchema,
});

/** Reusable GitHub issues tracker AST fixture (`github:issues`). */
export const SampleTrackerNode: GithubIssuesTrackerNode<
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
export const SampleStreamSourceNode: GithubWebhookStreamNode<{
  readonly prNumber: number;
  readonly merged: boolean;
}> = deepFreeze<
  GithubWebhookStreamNode<{ readonly prNumber: number; readonly merged: boolean }>
>({
  type: 'github:webhook-stream', secret: { type: 'harness:env-ref', key: 'WEBHOOK_SECRET' }, events: ['pull_request.closed'],
});
