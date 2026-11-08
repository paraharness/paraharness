import type {
  FsAllowOnlyGuardNode,
  FsBoundaryGuardNode,
  FsEditToolNode,
  FsGlobMatcherNode,
  FsGlobSourceNode,
  FsGlobToolNode,
  FsGrepToolNode,
  FsJsonlLessonStoreNode,
  FsPartitionMapNode,
  FsPartitionPathMapping,
  FsProtectGuardNode,
  FsQuotaTripwireNode,
  FsReadOnlyGuardNode,
  FsReadToolNode,
  FsRegexCheckNode,
  FsRequireReadBeforeWriteGuardNode,
  FsScopedWriteGuardNode,
  FsSecretLiteralsGuardNode,
  FsTelemetryCollectorNode,
  FsTextSourceNode,
  FsWriteGuardNode,
  FsWriteToolNode,
  LeaseDelta,
  MaybeBuilder,
  NodeRunnerNode,
  ScopePredicate,
  TopologyNode,
} from '@paraharness/core';
import type { FsJsonlLessonStoreOptions } from './create-fs-jsonl-lesson-store-builder.js';
import type { FsRegexCheckOptions } from './create-fs-regex-check-builder.js';
import type { FsWriteGuardOptions } from './create-fs-write-guard-builder.js';

/**
 * Declarative builder namespace (`fs.*`) for `@paraharness/fs` sources, partition maps, guards, tools, and stores.
 *
 * Every method returns a passive, frozen AST node or serializable `LeaseDelta` / `ScopePredicate`
 * with zero import-time or declaration-time filesystem I/O.
 */
export interface FsNamespace {
  /**
   * Compiles a passive `FsTextSourceNode` loading UTF-8 text from `filePath`.
   *
   * Resolves against the host repository root or active `ResolutionContext.scopeHandle`.
   * @param {string} filePath - Repository-relative path to the UTF-8 file.
   * @returns {FsTextSourceNode} Frozen `FsTextSourceNode` descriptor.
   */
  text(filePath: string): FsTextSourceNode;
  /**
   * Compiles a passive `FsGlobSourceNode` loading all UTF-8 files matching `globPattern`.
   *
   * Resolves matching files in deterministic lexicographical order with a SHA-256 digest.
   * @param {string} globPattern - POSIX glob pattern matched against the repository root.
   * @returns {FsGlobSourceNode} Frozen `FsGlobSourceNode` descriptor.
   */
  glob(globPattern: string): FsGlobSourceNode;
  /**
   * Compiles a passive `FsGlobMatcherNode` matching `FsToolEffect` paths against `globs`.
   *
   * Matches both exact normalized file paths and POSIX glob patterns.
   * @param {readonly string[]}        globs          - Glob patterns or exact file paths.
   * @param {'read' | 'write' | 'any'} [mode='write'] - Access mode filter.
   * @returns {FsGlobMatcherNode} Frozen `FsGlobMatcherNode` descriptor.
   */
  matchGlobs(globs: readonly string[], mode?: 'read' | 'write' | 'any'): FsGlobMatcherNode;
  /**
   * Compiles a passive `FsPartitionMapNode` mapping logical `topology` partitions to file globs.
   *
   * Binds each partition to its implementation `globs` and public `boundaryGlobs`.
   * @template TPartition Literal union of partition identifiers in `topology`.
   * @param {MaybeBuilder<TopologyNode<TPartition>>}               topology - Relational topology AST node or builder.
   * @param {Readonly<Record<TPartition, FsPartitionPathMapping>>} mapping  - Per-partition glob mapping.
   * @returns {FsPartitionMapNode<TPartition>} Frozen `FsPartitionMapNode` descriptor.
   */
  partitionMap<TPartition extends string = string>(
    topology: MaybeBuilder<TopologyNode<TPartition>>,
    mapping: Readonly<Record<TPartition, FsPartitionPathMapping>>,
  ): FsPartitionMapNode<TPartition>;
  /**
   * Builds a `ScopePredicate` scoping rules or skills to `partitionId` in `partitionMap`.
   *
   * Combines Turn-0 `partitions: [partitionId]` with reactive `'any'`-mode `effects` matching.
   * @template TPartition Literal union of partition identifiers in `partitionMap`.
   * @param {FsPartitionMapNode<TPartition>} partitionMap - Filesystem partition map AST node.
   * @param {TPartition}                     partitionId  - Target partition identifier.
   * @returns {ScopePredicate} Frozen `ScopePredicate` record.
   */
  inPartition<TPartition extends string = string>(
    partitionMap: FsPartitionMapNode<TPartition>,
    partitionId: TPartition,
  ): ScopePredicate;
  /**
   * Compiles a passive `FsBoundaryGuardNode` blocking unleased writes to partition `boundaryGlobs`.
   *
   * Projects `violatedEffects` strictly to the violating boundary file paths.
   * @template TPartition Literal union of partition identifiers in `partitionMap`.
   * @param {FsPartitionMapNode<TPartition>} partitionMap - Filesystem partition map AST node.
   * @returns {FsBoundaryGuardNode} Frozen `FsBoundaryGuardNode` descriptor.
   */
  boundaryGuard<TPartition extends string = string>(
    partitionMap: FsPartitionMapNode<TPartition>,
  ): FsBoundaryGuardNode;
  /**
   * Compiles a passive `FsWriteGuardNode` enforcing glob-based write allow/deny rules.
   *
   * Supports `onlyExistingAtBaseRef: true` to block edits to existing files while allowing new files.
   * @param {FsWriteGuardOptions} options - Write guard configuration options.
   * @returns {FsWriteGuardNode} Frozen `FsWriteGuardNode` descriptor.
   */
  writeGuard(options: FsWriteGuardOptions): FsWriteGuardNode;
  /**
   * Compiles a passive `FsProtectGuardNode` protecting `globs` from unleased write mutations.
   *
   * Projects `violatedEffects` strictly to the protected paths touched by a write effect.
   * @param {readonly string[]} globs - Protected file glob patterns.
   * @returns {FsProtectGuardNode} Frozen `FsProtectGuardNode` descriptor.
   */
  protect(globs: readonly string[]): FsProtectGuardNode;
  /**
   * Compiles a passive `FsReadOnlyGuardNode` rejecting all unleased filesystem write mutations.
   *
   * Enforces read-only access across declared and post-flight-diffed tools.
   * @returns {FsReadOnlyGuardNode} Frozen `FsReadOnlyGuardNode` descriptor.
   */
  readOnly(): FsReadOnlyGuardNode;
  /**
   * Compiles a passive `FsAllowOnlyGuardNode` restricting writes strictly to `globs`.
   *
   * Blocks any write path outside `globs` unless covered by an active lease.
   * @param {readonly string[]} globs - Allowed write glob patterns.
   * @returns {FsAllowOnlyGuardNode} Frozen `FsAllowOnlyGuardNode` descriptor.
   */
  allowOnly(globs: readonly string[]): FsAllowOnlyGuardNode;
  /**
   * Compiles a passive `FsRequireReadBeforeWriteGuardNode` requiring existing files to be read before mutation.
   *
   * Verifies that any target file existing at `baseRef` was previously read in `observedEffects`.
   * @returns {FsRequireReadBeforeWriteGuardNode} Frozen `FsRequireReadBeforeWriteGuardNode` descriptor.
   */
  requireReadBeforeWrite(): FsRequireReadBeforeWriteGuardNode;
  /**
   * Compiles a passive `FsScopedWriteGuardNode` restricting writes to `ctx.activePartitions`.
   *
   * Rejects write mutations outside the member `globs` of the actor's active partitions.
   * @template TPartition Literal union of partition identifiers in `partitionMap`.
   * @param {FsPartitionMapNode<TPartition>} partitionMap - Filesystem partition map AST node.
   * @returns {FsScopedWriteGuardNode} Frozen `FsScopedWriteGuardNode` descriptor.
   */
  scopedWrite<TPartition extends string = string>(
    partitionMap: FsPartitionMapNode<TPartition>,
  ): FsScopedWriteGuardNode;
  /**
   * Compiles a passive `FsSecretLiteralsGuardNode` scanning proposed file writes for secret literals.
   *
   * Evaluates built-in high-entropy credential patterns plus optional custom regex `patterns`.
   * @param {readonly string[]} [patterns] - Optional custom secret regex pattern strings.
   * @returns {FsSecretLiteralsGuardNode} Frozen `FsSecretLiteralsGuardNode` descriptor.
   */
  secretLiterals(patterns?: readonly string[]): FsSecretLiteralsGuardNode;
  /**
   * Creates a serializable `LeaseDelta` unlocking write access to `globs`.
   *
   * Matches both exact normalized file paths (including bracketed paths) and POSIX globs.
   * @param {readonly string[]} globs - Exact file paths or glob patterns to unlock.
   * @returns {LeaseDelta} Frozen `LeaseDelta` record.
   */
  allowWriteGlobs(globs: readonly string[]): LeaseDelta;
  /**
   * Compiles a passive `FsQuotaTripwireNode` tripping when distinct mutated files exceed `count`.
   *
   * Evaluated post-flight after each allowed tool call via `RuntimeExecutorRegistry.quotaTripwires`.
   * @param {number} count - Maximum distinct mutated files allowed.
   * @returns {FsQuotaTripwireNode} Frozen `FsQuotaTripwireNode` descriptor.
   */
  maxFilesMutated(count: number): FsQuotaTripwireNode;
  /**
   * Compiles the 5-tool workspace-jailed coding bundle (`read_file`, `edit_file`, `write_file`, `glob_files`, `grep_files`).
   *
   * Enforces `realpath` symlink jailing and `node_modules` write denial at runtime.
   * @template THandle Runtime handle type of the active isolation scope.
   * @param {MaybeBuilder<NodeRunnerNode>} runner - Runner pool AST node or builder.
   * @returns {readonly [FsReadToolNode<THandle>, FsEditToolNode<THandle>, FsWriteToolNode<THandle>, FsGlobToolNode<THandle>, FsGrepToolNode<THandle>]} Frozen 5-tuple of coding tools.
   */
  codingTools<THandle = unknown>(
    runner: MaybeBuilder<NodeRunnerNode>,
  ): readonly [
    FsReadToolNode<THandle>,
    FsEditToolNode<THandle>,
    FsWriteToolNode<THandle>,
    FsGlobToolNode<THandle>,
    FsGrepToolNode<THandle>,
  ];
  /**
   * Compiles the 3-tool workspace-jailed read-only bundle (`read_file`, `glob_files`, `grep_files`).
   *
   * Emits read-only `FsToolEffect` records with `mutatesScope: false`.
   * @template THandle Runtime handle type of the active isolation scope.
   * @param {MaybeBuilder<NodeRunnerNode>} runner - Runner pool AST node or builder.
   * @returns {readonly [FsReadToolNode<THandle>, FsGlobToolNode<THandle>, FsGrepToolNode<THandle>]} Frozen 3-tuple of read-only tools.
   */
  readOnlyTools<THandle = unknown>(
    runner: MaybeBuilder<NodeRunnerNode>,
  ): readonly [FsReadToolNode<THandle>, FsGlobToolNode<THandle>, FsGrepToolNode<THandle>];
  /**
   * Compiles a passive `FsTelemetryCollectorNode` collecting `filesRead` and `filesMutated`.
   *
   * Folds observed `FsToolEffect` records into `UniversalStepTelemetry.custom`.
   * @returns {FsTelemetryCollectorNode} Frozen `FsTelemetryCollectorNode` descriptor.
   */
  telemetry(): FsTelemetryCollectorNode;
  /**
   * Compiles a passive `FsRegexCheckNode` scanning mutated files matching `options.targetGlobs`.
   *
   * Evaluates `options.forbidPattern` strictly over files mutated during the session or since `baseRef`.
   * @template THandle Runtime handle type of the active isolation scope.
   * @param {string}              id      - Unique check identifier.
   * @param {FsRegexCheckOptions} options - Regex check options.
   * @returns {FsRegexCheckNode<THandle>} Frozen `FsRegexCheckNode` descriptor.
   */
  regexCheck<THandle = unknown>(id: string, options: FsRegexCheckOptions): FsRegexCheckNode<THandle>;
  /**
   * Compiles a passive `FsJsonlLessonStoreNode` configuring the crash-safe hybrid lesson store.
   *
   * Resolves `definitionsDir`, `statsPath`, and `lockFile` against the immutable host repository root.
   * @param {FsJsonlLessonStoreOptions} options - Lesson store host-root path options.
   * @returns {FsJsonlLessonStoreNode} Frozen `FsJsonlLessonStoreNode` descriptor.
   */
  jsonlLessonStore(options: FsJsonlLessonStoreOptions): FsJsonlLessonStoreNode;
}
