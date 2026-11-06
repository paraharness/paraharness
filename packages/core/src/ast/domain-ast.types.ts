import type { AgentNode } from './agent-node.js';
import type { ScopeCapabilityTier } from './base/base-domain-ast.types.js';
import type { CommandNode } from './command-node.js';
import type { CustomDomainAST } from './custom-domain-ast.types.js';
import type { ClaudeAccountSeatNode } from './domain/claude-account-seat-node.js';
import type { ClaudeModelNode } from './domain/claude-model-node.js';
import type { FsAllowOnlyGuardNode } from './domain/fs-allow-only-guard-node.js';
import type { FsBoundaryGuardNode } from './domain/fs-boundary-guard-node.js';
import type { FsEditToolNode } from './domain/fs-edit-tool-node.js';
import type { FsGlobMatcherNode } from './domain/fs-glob-matcher-node.js';
import type { FsGlobSourceNode } from './domain/fs-glob-source-node.js';
import type { FsGlobToolNode } from './domain/fs-glob-tool-node.js';
import type { FsGrepToolNode } from './domain/fs-grep-tool-node.js';
import type { FsJsonlLessonStoreNode } from './domain/fs-jsonl-lesson-store-node.js';
import type { FsPartitionMapNode } from './domain/fs-partition-map-node.js';
import type { FsProtectGuardNode } from './domain/fs-protect-guard-node.js';
import type { FsQuotaTripwireNode } from './domain/fs-quota-tripwire-node.js';
import type { FsReadOnlyGuardNode } from './domain/fs-read-only-guard-node.js';
import type { FsReadToolNode } from './domain/fs-read-tool-node.js';
import type { FsRegexCheckNode } from './domain/fs-regex-check-node.js';
import type { FsRequireReadBeforeWriteGuardNode } from './domain/fs-require-read-before-write-guard-node.js';
import type { FsScopedWriteGuardNode } from './domain/fs-scoped-write-guard-node.js';
import type { FsSecretLiteralsGuardNode } from './domain/fs-secret-literals-guard-node.js';
import type { FsTelemetryCollectorNode } from './domain/fs-telemetry-collector-node.js';
import type { FsTextSourceNode } from './domain/fs-text-source-node.js';
import type { FsWriteGuardNode } from './domain/fs-write-guard-node.js';
import type { FsWriteToolNode } from './domain/fs-write-tool-node.js';
import type { GeminiAccountSeatNode } from './domain/gemini-account-seat-node.js';
import type { GeminiModelNode } from './domain/gemini-model-node.js';
import type { GitCandidateComparisonToolNode } from './domain/git-candidate-comparison-tool-node.js';
import type { GitCleanWorkingTreeNode } from './domain/git-clean-working-tree-node.js';
import type { GitCommitAndPushNode } from './domain/git-commit-and-push-node.js';
import type { GitCowWorktreeNode } from './domain/git-cow-worktree-node.js';
import type { GitDiscardBranchNode } from './domain/git-discard-branch-node.js';
import type { GitKeepWorktreeNode } from './domain/git-keep-worktree-node.js';
import type { GitMergeQueueNode } from './domain/git-merge-queue-node.js';
import type { GitPatchEquivalenceNode } from './domain/git-patch-equivalence-node.js';
import type { GitPublicSurfaceCrossTesterNode } from './domain/git-public-surface-cross-tester-node.js';
import type { GitRefReaderToolNode } from './domain/git-ref-reader-tool-node.js';
import type { GitSnapshotAndResetNode } from './domain/git-snapshot-and-reset-node.js';
import type { GithubCreateOrUpdatePrNode } from './domain/github-create-or-update-pr-node.js';
import type { GithubIssuesTrackerNode } from './domain/github-issues-tracker-node.js';
import type { GithubWebhookStreamNode } from './domain/github-webhook-stream-node.js';
import type { LocalCommandCheckNode } from './domain/local-command-check-node.js';
import type { LocalCommandNode } from './domain/local-command-node.js';
import type { LocalCommandToolNode } from './domain/local-command-tool-node.js';
import type { LocalServiceNode } from './domain/local-service-node.js';
import type { LocalServiceToolNode } from './domain/local-service-tool-node.js';
import type { LocalStreamCheckNode } from './domain/local-stream-check-node.js';
import type { LocalStreamCheckToolNode } from './domain/local-stream-check-tool-node.js';
import type { MarkdownFrontmatterSourceNode } from './domain/markdown-frontmatter-source-node.js';
import type { MarkdownSectionSourceNode } from './domain/markdown-section-source-node.js';
import type { NodeAllowBinariesNode } from './domain/node-allow-binaries-node.js';
import type { NodeDenyNetworkNode } from './domain/node-deny-network-node.js';
import type { NodeHttpControlPlaneNode } from './domain/node-http-control-plane-node.js';
import type { NodeMcpSseNode } from './domain/node-mcp-sse-node.js';
import type { NodeMcpStdioNode } from './domain/node-mcp-stdio-node.js';
import type { NodeRunnerNode } from './domain/node-runner-node.js';
import type { OpenAiAccountSeatNode } from './domain/openai-account-seat-node.js';
import type { OpenAiModelNode } from './domain/openai-model-node.js';
import type { PostgresLedgerNode } from './domain/postgres-ledger-node.js';
import type { PostgresLessonsNode } from './domain/postgres-lessons-node.js';
import type { PostgresRulesSourceNode } from './domain/postgres-rules-source-node.js';
import type { PostgresTopologyNode } from './domain/postgres-topology-node.js';
import type { SlackApproverNode } from './domain/slack-approver-node.js';
import type { SlackNotifierNode } from './domain/slack-notifier-node.js';
import type { SqliteLedgerNode } from './domain/sqlite-ledger-node.js';
import type { SqliteLessonsNode } from './domain/sqlite-lessons-node.js';
import type { SqliteRulesSourceNode } from './domain/sqlite-rules-source-node.js';
import type { SqliteTopologyNode } from './domain/sqlite-topology-node.js';
import type { LoopNode } from './loop-node.js';

/**
 * Workspace-wide discriminated union of isolation scope AST nodes.
 * @template THandle  Isolation scope runtime handle type.
 * @template TReceipt Validated scope inspection receipt shape.
 * @template TSync    Validated scope synchronization receipt shape.
 * @template TTier    Static capability tier (`'scope' | 'checkpointable' | 'branchable'`).
 */
export type IsolationScopeASTNode<
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TSync extends Record<string, unknown> = Record<string, unknown>,
  TTier extends ScopeCapabilityTier = ScopeCapabilityTier,
> = (GitCowWorktreeNode<THandle, TReceipt, TSync> & { readonly capabilityTier: TTier }) | CustomDomainAST<'scope'>;
/**
 * Workspace-wide discriminated union of adapter-supplied domain step AST nodes.
 * @template TIn     Step input payload type.
 * @template TOut    Step output payload type.
 * @template THandle Isolation scope handle type.
 */
export type DomainStepASTNode<TIn = unknown, TOut = unknown, THandle = unknown> =
  | LocalCommandNode<TIn, TOut, THandle> | LocalStreamCheckNode<THandle> | GitCommitAndPushNode<TIn>
  | GitMergeQueueNode<TIn, TOut> | GithubCreateOrUpdatePrNode<TIn, TOut, THandle> | CustomDomainAST<'step'>;
/**
 * Workspace-wide discriminated union of all executable step AST nodes (`AgentNode`, `LoopNode`, `CommandNode`, and `DomainStepASTNode`).
 * @template TIn     Step input payload type.
 * @template TOut    Step output payload type.
 * @template THandle Isolation scope handle type.
 */
export type StepASTNode<TIn = unknown, TOut = unknown, THandle = unknown> =
  | AgentNode<TIn, TOut, THandle> | LoopNode<TIn, TOut, THandle, string>
  | CommandNode<TIn, TOut, THandle> | DomainStepASTNode<TIn, TOut, THandle>;
/**
 * Built-in tool AST node union across `@harness-dsl/{fs,node,git}`.
 * @template THandle Isolation scope handle type.
 */
export type BuiltInToolASTNode<THandle = unknown> =
  | FsReadToolNode<THandle> | FsEditToolNode<THandle> | FsWriteToolNode<THandle>
  | FsGlobToolNode<THandle> | FsGrepToolNode<THandle> | LocalCommandToolNode<THandle>
  | LocalStreamCheckToolNode<THandle> | LocalServiceToolNode<THandle>
  | GitRefReaderToolNode<THandle> | GitCandidateComparisonToolNode<THandle>;
/**
 * Workspace-wide discriminated union of tool AST nodes (`BuiltInToolASTNode` and `CustomDomainAST<'tool'>`).
 * @template THandle Isolation scope handle type.
 */
export type ToolASTNode<THandle = unknown> = BuiltInToolASTNode<THandle> | CustomDomainAST<'tool'>;
/**
 * Built-in deterministic check AST node union across `@harness-dsl/{node,fs,git}`.
 * @template THandle Isolation scope handle type.
 */
export type BuiltInCheckASTNode<THandle = unknown> =
  | LocalStreamCheckNode<THandle> | LocalCommandCheckNode<THandle> | FsRegexCheckNode<THandle> | GitCleanWorkingTreeNode;
/**
 * Workspace-wide discriminated union of deterministic check AST nodes.
 * @template THandle Isolation scope handle type.
 */
export type CheckASTNode<THandle = unknown> = BuiltInCheckASTNode<THandle> | CustomDomainAST<'check'> | CustomDomainAST<'evaluator'>;
/**
 * Alias for `CheckASTNode<THandle>`.
 * @template THandle Isolation scope handle type.
 */
export type EvaluatorASTNode<THandle = unknown> = CheckASTNode<THandle>;
/**
 * Workspace-wide discriminated union of background daemon service AST nodes.
 * @template THandle Isolation scope handle type.
 */
export type ServiceASTNode<THandle = unknown> = LocalServiceNode | CustomDomainAST<'service'> | (THandle extends never ? never : never);
/** Built-in policy guard AST node union across `@harness-dsl/{fs,node}`. */
export type BuiltInGuardASTNode =
  | FsProtectGuardNode | FsReadOnlyGuardNode | FsAllowOnlyGuardNode
  | FsRequireReadBeforeWriteGuardNode | FsScopedWriteGuardNode | FsSecretLiteralsGuardNode
  | FsWriteGuardNode | FsBoundaryGuardNode | NodeAllowBinariesNode | NodeDenyNetworkNode;
/**
 * Workspace-wide discriminated union of policy guard AST nodes.
 * @template THandle Isolation scope handle type.
 */
export type GuardASTNode<THandle = unknown> =
  | BuiltInGuardASTNode | CustomDomainAST<'guard'> | CustomDomainAST<'policyGuard'> | (THandle extends never ? never : never);
/** Alias for `GuardASTNode`. */
export type PolicyGuardASTNode = GuardASTNode;
/** Workspace-wide discriminated union of quantitative quota tripwire AST nodes. */
export type QuotaTripwireASTNode = FsQuotaTripwireNode | CustomDomainAST<'quotaTripwire'> | CustomDomainAST<'tripwire'>;
/**
 * Workspace-wide discriminated union of custom telemetry collector AST nodes.
 * @template TMetrics Custom telemetry metrics record shape.
 */
export type TelemetryCollectorASTNode<TMetrics extends Record<string, unknown> = Record<string, unknown>> =
  | FsTelemetryCollectorNode | CustomDomainAST<'telemetryCollector'> | CustomDomainAST<'telemetry'> | (TMetrics extends never ? never : never);
/**
 * Workspace-wide discriminated union of scope abort hook AST nodes.
 * @template THandle    Isolation scope handle type.
 * @template TAbortMeta Validated abort metadata record shape.
 */
export type AbortHookASTNode<THandle = unknown, TAbortMeta extends Record<string, unknown> = Record<string, unknown>> =
  | GitSnapshotAndResetNode | CustomDomainAST<'abortHook'> | (THandle extends never ? never : never) | (TAbortMeta extends never ? never : never);
/**
 * Workspace-wide discriminated union of scope rewind hook AST nodes.
 * @template THandle Isolation scope handle type.
 */
export type ScopeRewindHookASTNode<THandle = unknown> =
  | GitKeepWorktreeNode | GitDiscardBranchNode | CustomDomainAST<'rewindHook'> | (THandle extends never ? never : never);
/**
 * Workspace-wide discriminated union of patch-equivalence cross-verifier AST nodes.
 * @template TCrossReport Validated cross-verification report type.
 */
export type PatchEquivalenceASTNode<TCrossReport = unknown> = GitPatchEquivalenceNode<TCrossReport> | CustomDomainAST<'patchEquivalence'>;
/**
 * Workspace-wide discriminated union of public-surface cross-tester AST nodes.
 * @template TCrossReport Validated cross-verification report type.
 */
export type CrossTesterASTNode<TCrossReport = unknown> = GitPublicSurfaceCrossTesterNode<TCrossReport> | CustomDomainAST<'crossTester'>;
/**
 * Workspace-wide discriminated union of speculative cross-verifier AST nodes.
 * @template THandle      Isolation scope handle type.
 * @template TReceipt     Inspected scope receipt record shape.
 * @template TCrossReport Validated cross-verification report type.
 */
export type CrossVerifierASTNode<
  THandle = unknown,
  TReceipt extends Record<string, unknown> = Record<string, unknown>,
  TCrossReport = unknown,
> =
  | PatchEquivalenceASTNode<TCrossReport> | CrossTesterASTNode<TCrossReport> | CustomDomainAST<'crossVerifier'>
  | (THandle extends never ? never : never) | (TReceipt extends never ? never : never);
/**
 * Workspace-wide discriminated union of grounding, rule, and skill source AST nodes.
 * @template T Resolved source content payload type.
 */
export type SourceASTNode<T = unknown> =
  | FsTextSourceNode | FsGlobSourceNode | MarkdownFrontmatterSourceNode<T> | MarkdownSectionSourceNode<T>
  | SqliteRulesSourceNode | PostgresRulesSourceNode | CustomDomainAST<'source'>;
/** Workspace-wide discriminated union of LLM provider account seat AST nodes. */
export type AccountSeatASTNode = ClaudeAccountSeatNode | OpenAiAccountSeatNode | GeminiAccountSeatNode | CustomDomainAST<'accountSeat'>;
/** Workspace-wide discriminated union of LLM model AST nodes. */
export type ModelASTNode = ClaudeModelNode | OpenAiModelNode | GeminiModelNode | CustomDomainAST<'model'>;
/** Workspace-wide discriminated union of durable ledger store AST nodes. */
export type LedgerStoreASTNode = SqliteLedgerNode | PostgresLedgerNode | CustomDomainAST<'ledger'>;
/** Workspace-wide discriminated union of relational topology store AST nodes. */
export type TopologyStoreASTNode = SqliteTopologyNode | PostgresTopologyNode | CustomDomainAST<'topology'>;
/** Workspace-wide discriminated union of empirical lesson store AST nodes. */
export type LessonStoreASTNode = FsJsonlLessonStoreNode | SqliteLessonsNode | PostgresLessonsNode | CustomDomainAST<'lessons'>;
/**
 * Workspace-wide discriminated union of external issue tracker AST nodes.
 * @template TExternal      Raw external issue payload type.
 * @template TExternalState External tracker state string union.
 */
export type TrackerASTNode<TExternal = unknown, TExternalState extends string = string> =
  | GithubIssuesTrackerNode<TExternal, TExternalState> | CustomDomainAST<'tracker'>;
/**
 * Workspace-wide discriminated union of inbound event stream source AST nodes.
 * @template TEvent Raw inbound stream event payload type.
 */
export type StreamSourceASTNode<TEvent = unknown> = GithubWebhookStreamNode<TEvent> | CustomDomainAST<'streamSource'>;
/**
 * Workspace-wide discriminated union of human channel AST nodes filtered by `interactionMode`.
 * @template TMode Interaction mode filter (`'bidirectional' | 'notify-only'`).
 */
export type HumanChannelASTNode<TMode extends 'bidirectional' | 'notify-only' = 'bidirectional' | 'notify-only'> =
  Extract<SlackApproverNode | SlackNotifierNode | CustomDomainAST<'humanChannel'>, { readonly interactionMode: TMode }>;
/** Workspace-wide discriminated union of inbound control-plane AST nodes. */
export type ControlPlaneASTNode =
  | NodeMcpStdioNode | NodeMcpSseNode | NodeHttpControlPlaneNode | SlackApproverNode | CustomDomainAST<'controlPlane'>;
/** Workspace-wide discriminated union of capability lease effect matcher AST nodes. */
export type EffectMatcherASTNode = FsGlobMatcherNode | CustomDomainAST<'effectMatcher'>;
/** Workspace-wide discriminated union of OS runner pool AST nodes. */
export type RunnerPoolASTNode = NodeRunnerNode | CustomDomainAST<'runner'>;
/** Complete union of all adapter-supplied passive domain AST nodes. */
export type DomainASTNode =
  | IsolationScopeASTNode | DomainStepASTNode | ToolASTNode | CheckASTNode | ServiceASTNode
  | PolicyGuardASTNode | QuotaTripwireASTNode | TelemetryCollectorASTNode | AbortHookASTNode
  | ScopeRewindHookASTNode | CrossVerifierASTNode | SourceASTNode | AccountSeatASTNode
  | ModelASTNode | LedgerStoreASTNode | TopologyStoreASTNode | LessonStoreASTNode
  | TrackerASTNode | StreamSourceASTNode | HumanChannelASTNode | ControlPlaneASTNode
  | EffectMatcherASTNode | RunnerPoolASTNode | FsPartitionMapNode;
