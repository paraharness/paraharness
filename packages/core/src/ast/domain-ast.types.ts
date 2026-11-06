import type { AgentNode } from './agent-node.js';
import type { ScopeCapabilityTier } from './base/base-domain-ast.types.js';
import type { CommandNode } from './command-node.js';
import type { CustomDomainAST } from './custom-domain-ast.types.js';
import type {
  ClaudeAccountSeatNode, ClaudeModelNode, FsAllowOnlyGuardNode, FsBoundaryGuardNode, FsEditToolNode,
  FsGlobMatcherNode, FsGlobSourceNode, FsGlobToolNode, FsGrepToolNode, FsJsonlLessonStoreNode,
  FsPartitionMapNode, FsProtectGuardNode, FsQuotaTripwireNode, FsReadOnlyGuardNode, FsReadToolNode,
  FsRegexCheckNode, FsRequireReadBeforeWriteGuardNode, FsScopedWriteGuardNode, FsSecretLiteralsGuardNode,
  FsTelemetryCollectorNode, FsTextSourceNode, FsWriteGuardNode, FsWriteToolNode, GeminiAccountSeatNode,
  GeminiModelNode, GitCandidateComparisonToolNode, GitCleanWorkingTreeNode, GitCommitAndPushNode,
  GitCowWorktreeNode, GitDiscardBranchNode, GitKeepWorktreeNode, GitMergeQueueNode,
  GitPatchEquivalenceNode, GitPublicSurfaceCrossTesterNode, GitRefReaderToolNode,
  GitSnapshotAndResetNode, GithubCreateOrUpdatePrNode, GithubIssuesTrackerNode, GithubWebhookStreamNode,
  LocalCommandCheckNode, LocalCommandNode, LocalCommandToolNode, LocalServiceNode, LocalServiceToolNode,
  LocalStreamCheckNode, LocalStreamCheckToolNode, MarkdownFrontmatterSourceNode, MarkdownSectionSourceNode,
  NodeAllowBinariesNode, NodeDenyNetworkNode, NodeHttpControlPlaneNode, NodeMcpSseNode, NodeMcpStdioNode,
  NodeRunnerNode, OpenAiAccountSeatNode, OpenAiModelNode, PostgresLedgerNode, PostgresLessonsNode,
  PostgresRulesSourceNode, PostgresTopologyNode, SlackApproverNode, SlackNotifierNode, SqliteLedgerNode,
  SqliteLessonsNode, SqliteRulesSourceNode, SqliteTopologyNode,
} from './domain/index.js';
import type { LoopNode } from './loop-node.js';

export type { CoreASTNode } from './core-ast-node.types.js';

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
export type CheckASTNode<THandle = unknown> =
  | BuiltInCheckASTNode<THandle> | CustomDomainAST<'check'> | CustomDomainAST<'evaluator'>;

/**
 * Alias for `CheckASTNode<THandle>`.
 * @template THandle Isolation scope handle type.
 */
export type EvaluatorASTNode<THandle = unknown> = CheckASTNode<THandle>;

/**
 * Workspace-wide discriminated union of background daemon service AST nodes.
 * @template THandle Isolation scope handle type.
 */
export type ServiceASTNode<THandle = unknown> =
  | LocalServiceNode | CustomDomainAST<'service'> | (THandle extends never ? never : never);

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
export type QuotaTripwireASTNode =
  | FsQuotaTripwireNode | CustomDomainAST<'quotaTripwire'> | CustomDomainAST<'tripwire'>;

/**
 * Workspace-wide discriminated union of custom telemetry collector AST nodes.
 * @template TMetrics Custom telemetry metrics record shape.
 */
export type TelemetryCollectorASTNode<TMetrics extends Record<string, unknown> = Record<string, unknown>> =
  | FsTelemetryCollectorNode | CustomDomainAST<'telemetryCollector'> | CustomDomainAST<'telemetry'>
  | (TMetrics extends never ? never : never);

/**
 * Workspace-wide discriminated union of scope abort hook AST nodes.
 * @template THandle    Isolation scope handle type.
 * @template TAbortMeta Validated abort metadata record shape.
 */
export type AbortHookASTNode<THandle = unknown, TAbortMeta extends Record<string, unknown> = Record<string, unknown>> =
  | GitSnapshotAndResetNode | CustomDomainAST<'abortHook'>
  | (THandle extends never ? never : never) | (TAbortMeta extends never ? never : never);

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
export type PatchEquivalenceASTNode<TCrossReport = unknown> =
  | GitPatchEquivalenceNode<TCrossReport> | CustomDomainAST<'patchEquivalence'>;

/**
 * Workspace-wide discriminated union of public-surface cross-tester AST nodes.
 * @template TCrossReport Validated cross-verification report type.
 */
export type CrossTesterASTNode<TCrossReport = unknown> =
  | GitPublicSurfaceCrossTesterNode<TCrossReport> | CustomDomainAST<'crossTester'>;

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
export type AccountSeatASTNode =
  | ClaudeAccountSeatNode | OpenAiAccountSeatNode | GeminiAccountSeatNode | CustomDomainAST<'accountSeat'>;

/** Workspace-wide discriminated union of LLM model AST nodes. */
export type ModelASTNode =
  | ClaudeModelNode | OpenAiModelNode | GeminiModelNode | CustomDomainAST<'model'>;

/** Workspace-wide discriminated union of durable ledger store AST nodes. */
export type LedgerStoreASTNode = SqliteLedgerNode | PostgresLedgerNode | CustomDomainAST<'ledger'>;

/** Workspace-wide discriminated union of relational topology store AST nodes. */
export type TopologyStoreASTNode = SqliteTopologyNode | PostgresTopologyNode | CustomDomainAST<'topology'>;

/** Workspace-wide discriminated union of empirical lesson store AST nodes. */
export type LessonStoreASTNode =
  | FsJsonlLessonStoreNode | SqliteLessonsNode | PostgresLessonsNode | CustomDomainAST<'lessons'>;

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
export type StreamSourceASTNode<TEvent = unknown> =
  | GithubWebhookStreamNode<TEvent> | CustomDomainAST<'streamSource'>;

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
