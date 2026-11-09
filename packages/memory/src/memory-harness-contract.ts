import type { MemoryConfig } from './schemas/memory-config.schema.js';
import type {
  FileInteractionHookInput,
  FileInteractionHookOutput,
  MemoryCommitInput,
  MemoryCommitOutput,
  MemoryDrainNotesInput,
  MemoryDrainNotesOutput,
  MemoryInitInput,
  MemoryInitOutput,
  MemoryLoadScopedInput,
  MemoryLoadScopedOutput,
  MemoryProposeInput,
  MemoryProposeOutput,
} from './schemas/memory-tools.schema.js';

/**
 * Public programmatic contract of the Unified Memory Harness (`MemoryHarness`).
 */
export interface MemoryHarnessContract {
  /**
   * Returns the loaded and validated `MemoryConfig` for this workspace.
   *
   * @returns {MemoryConfig} Validated unified memory configuration object.
   */
  getConfig(): MemoryConfig;

  /**
   * Executes `memory_init` at session start and after context compaction, returning the config-adapted
   * protocol and all unscoped `'general'` and `<role>` rules, lessons, and active notes.
   *
   * @param {MemoryInitInput} input - Session role and optional session identifier.
   *
   * @returns {Promise<MemoryInitOutput>} Protocol markdown and ordered unscoped memories.
   *
   * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, or `'GIT_SYNC_FAILED'`.
   */
  init(input: MemoryInitInput): Promise<MemoryInitOutput>;

  /**
   * Executes `memory_load_scoped` for specific file paths, directories, or glob patterns.
   *
   * @param {MemoryLoadScopedInput} input - Target role, paths/globs to match, and optional session identifier.
   *
   * @returns {Promise<MemoryLoadScopedOutput>} Normalized query paths and matching scoped rules, lessons, and notes.
   *
   * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, or `'GIT_SYNC_FAILED'`.
   */
  loadScoped(input: MemoryLoadScopedInput): Promise<MemoryLoadScopedOutput>;

  /**
   * Executes `memory_propose` to format, deduplicate, and evaluate capacity for a rule or lesson candidate.
   *
   * @param {MemoryProposeInput} input - Candidate rule or lesson payload and optional scope/incident context.
   *
   * @returns {Promise<MemoryProposeOutput>} Resolved Distiller proposal choices or subagent delegation payload.
   *
   * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, `'LESSON_FORMAT_INVALID'`, `'RULE_PROTECTION_VIOLATION'`, `'DISTILLER_EXECUTION_FAILED'`, or `'GIT_SYNC_FAILED'`.
   */
  propose(input: MemoryProposeInput): Promise<MemoryProposeOutput>;

  /**
   * Executes `memory_commit` to atomically add, update, or remove a record in `memory.jsonl`.
   *
   * @param {MemoryCommitInput} input - Discriminated `'add' | 'update' | 'remove'` mutation payload.
   *
   * @returns {Promise<MemoryCommitOutput>} Committed/previous record snapshots, post-commit bucket status, and Git sync flags.
   *
   * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, `'LESSON_FORMAT_INVALID'`, `'CAP_EXCEEDED'`, `'RECORD_NOT_FOUND'`, `'RULE_PROTECTION_VIOLATION'`, or `'GIT_SYNC_FAILED'`.
   */
  commit(input: MemoryCommitInput): Promise<MemoryCommitOutput>;

  /**
   * Executes `memory_drain_notes` in dry-run preview or destructive bulk-drain mode.
   *
   * @param {MemoryDrainNotesInput} input - Lifecycle mode selectors, optional role/path/ID filters, and `dryRun` flag.
   *
   * @returns {Promise<MemoryDrainNotesOutput>} Matched note records, drained IDs, and Git sync flags.
   *
   * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, or `'GIT_SYNC_FAILED'`.
   */
  drainNotes(input: MemoryDrainNotesInput): Promise<MemoryDrainNotesOutput>;

  /**
   * Evaluates a file or directory tool interaction and returns unseen scoped memories for the active compaction epoch.
   *
   * @param {FileInteractionHookInput} input - Session ID, touched paths/globs, and optional role and transcript path.
   *
   * @returns {Promise<FileInteractionHookOutput>} Injection status, compaction epoch ID, formatted context, and newly injected records.
   *
   * @throws {MemoryHarnessError} With `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, or `'GIT_SYNC_FAILED'`.
   */
  handleFileInteractionHook(input: FileInteractionHookInput): Promise<FileInteractionHookOutput>;
}
