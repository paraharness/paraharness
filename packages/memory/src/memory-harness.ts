import path from 'node:path';
import { executeFileInteractionHook } from './internal/execute-file-interaction-hook.js';
import { executeMemoryCommit } from './internal/execute-memory-commit.js';
import { executeMemoryDrainNotes } from './internal/execute-memory-drain-notes.js';
import { executeMemoryInit } from './internal/execute-memory-init.js';
import { executeMemoryLoadScoped } from './internal/execute-memory-load-scoped.js';
import { executeMemoryPropose } from './internal/execute-memory-propose.js';
import { loadMemoryConfig } from './internal/load-memory-config.js';
import type { LoadedMemoryConfig } from './internal/loaded-memory-config.js';
import type { MemoryDistillerRunner } from './memory-distiller-runner.js';
import type { MemoryHarnessContract } from './memory-harness-contract.js';
import type { MemoryHarnessOptions } from './memory-harness-options.js';
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
 * Stateful coordinator implementing `MemoryHarnessContract` (`getConfig`, `init`, `loadScoped`,
 * `propose`, `commit`, `drainNotes`, and `handleFileInteractionHook`) per §9.1.
 *
 * Delegates each domain tool and hook workflow to focused `src/internal/*` phase coordinators while
 * managing configuration discovery (`loadMemoryConfig`), injectable clock (`nowMs`), and Distiller
 * runner injection (`distillerRunner`).
 */
export class MemoryHarness implements MemoryHarnessContract {
  /** Resolved absolute path to the repository workspace root. */
  private readonly workspaceRoot: string;

  /** Optional explicit path to `memory.config.json`. */
  private readonly configPath: string | undefined;

  /** Optional injected Distiller runner override. */
  private readonly distillerRunner: MemoryDistillerRunner | undefined;

  /** Clock function returning current UTC epoch milliseconds. */
  private readonly nowMs: () => number;

  /**
   * Creates a new `MemoryHarness` instance bound to `options.workspaceRoot`.
   *
   * @param {MemoryHarnessOptions} options - Workspace root, optional config path, Distiller runner, and clock.
   */
  constructor(options: MemoryHarnessOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.configPath = options.configPath;
    this.distillerRunner = options.distillerRunner;
    this.nowMs = options.nowMs ?? Date.now;
  }

  /**
   * Returns the loaded and validated `MemoryConfig` for this workspace (§2.1, §9.1).
   *
   * @returns {MemoryConfig} Validated unified memory configuration object.
   *
   * @throws {MemoryHarnessError} With `'CONFIG_NOT_FOUND'` or `'CONFIG_VALIDATION_FAILED'`.
   */
  getConfig(): MemoryConfig {
    return this.resolveLoadedConfig().config;
  }

  /**
   * Executes `memory_init` at session start and after context compaction, returning the config-adapted
   * protocol and all unscoped `'general'` and `<role>` rules, lessons, and active notes (§6.2).
   *
   * @param {MemoryInitInput} input - Session role and optional session identifier.
   *
   * @returns {Promise<MemoryInitOutput>} Protocol markdown and ordered unscoped memories.
   *
   * @throws {MemoryHarnessError} With `'CONFIG_NOT_FOUND'`, `'CONFIG_VALIDATION_FAILED'`, `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, or `'GIT_SYNC_FAILED'`.
   */
  async init(input: MemoryInitInput): Promise<MemoryInitOutput> {
    const loaded = this.resolveLoadedConfig();
    return executeMemoryInit({
      workspaceRoot: this.workspaceRoot,
      config: loaded.config,
      input,
      nowMs: this.nowMs(),
    });
  }

  /**
   * Executes `memory_load_scoped` for specific file paths, directories, or glob patterns (§6.3).
   *
   * @param {MemoryLoadScopedInput} input - Target role, paths/globs to match, and optional session identifier.
   *
   * @returns {Promise<MemoryLoadScopedOutput>} Normalized query paths and matching scoped rules, lessons, and notes.
   *
   * @throws {MemoryHarnessError} With `'CONFIG_NOT_FOUND'`, `'CONFIG_VALIDATION_FAILED'`, `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, or `'GIT_SYNC_FAILED'`.
   */
  async loadScoped(input: MemoryLoadScopedInput): Promise<MemoryLoadScopedOutput> {
    const loaded = this.resolveLoadedConfig();
    return executeMemoryLoadScoped({
      workspaceRoot: this.workspaceRoot,
      config: loaded.config,
      input,
      nowMs: this.nowMs(),
    });
  }

  /**
   * Executes `memory_propose` to format, deduplicate, and evaluate capacity for a rule or lesson candidate (§6.4).
   *
   * @param {MemoryProposeInput} input - Candidate rule or lesson payload and optional scope/incident context.
   *
   * @returns {Promise<MemoryProposeOutput>} Resolved Distiller proposal choices or subagent delegation payload.
   *
   * @throws {MemoryHarnessError} With `'CONFIG_NOT_FOUND'`, `'CONFIG_VALIDATION_FAILED'`, `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, `'LESSON_FORMAT_INVALID'`, `'RULE_PROTECTION_VIOLATION'`, `'DISTILLER_EXECUTION_FAILED'`, or `'GIT_SYNC_FAILED'`.
   */
  async propose(input: MemoryProposeInput): Promise<MemoryProposeOutput> {
    const loaded = this.resolveLoadedConfig();
    return executeMemoryPropose({
      workspaceRoot: this.workspaceRoot,
      config: loaded.config,
      compiledForbidRegexes: loaded.compiledForbidRegexes,
      input,
      distillerRunner: this.distillerRunner,
      nowMs: this.nowMs(),
    });
  }

  /**
   * Executes `memory_commit` to atomically add, update, or remove a record in `memory.jsonl` (§6.5).
   *
   * @param {MemoryCommitInput} input - Discriminated `'add' | 'update' | 'remove'` mutation payload.
   *
   * @returns {Promise<MemoryCommitOutput>} Committed/previous record snapshots, post-commit bucket status, and Git sync flags.
   *
   * @throws {MemoryHarnessError} With `'CONFIG_NOT_FOUND'`, `'CONFIG_VALIDATION_FAILED'`, `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, `'LESSON_FORMAT_INVALID'`, `'CAP_EXCEEDED'`, `'RECORD_NOT_FOUND'`, `'RULE_PROTECTION_VIOLATION'`, or `'GIT_SYNC_FAILED'`.
   */
  async commit(input: MemoryCommitInput): Promise<MemoryCommitOutput> {
    const loaded = this.resolveLoadedConfig();
    return executeMemoryCommit({
      workspaceRoot: this.workspaceRoot,
      config: loaded.config,
      compiledForbidRegexes: loaded.compiledForbidRegexes,
      input,
      nowMs: this.nowMs(),
    });
  }

  /**
   * Executes `memory_drain_notes` in dry-run preview or destructive bulk-drain mode (§6.6).
   *
   * @param {MemoryDrainNotesInput} input - Lifecycle mode selectors, optional role/path/ID filters, and `dryRun` flag.
   *
   * @returns {Promise<MemoryDrainNotesOutput>} Matched note records, drained IDs, and Git sync flags.
   *
   * @throws {MemoryHarnessError} With `'CONFIG_NOT_FOUND'`, `'CONFIG_VALIDATION_FAILED'`, `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, or `'GIT_SYNC_FAILED'`.
   */
  async drainNotes(input: MemoryDrainNotesInput): Promise<MemoryDrainNotesOutput> {
    const loaded = this.resolveLoadedConfig();
    return executeMemoryDrainNotes({
      workspaceRoot: this.workspaceRoot,
      config: loaded.config,
      input,
      nowMs: this.nowMs(),
    });
  }

  /**
   * Evaluates a file or directory tool interaction and returns unseen scoped memories for the active compaction epoch (§7.1–§7.2).
   *
   * @param {FileInteractionHookInput} input - Session ID, touched paths/globs, and optional role and transcript path.
   *
   * @returns {Promise<FileInteractionHookOutput>} Injection status, compaction epoch ID, formatted context, and newly injected records.
   *
   * @throws {MemoryHarnessError} With `'CONFIG_NOT_FOUND'`, `'CONFIG_VALIDATION_FAILED'`, `'INVALID_ROLE'`, `'VALIDATION_FAILED'`, or `'GIT_SYNC_FAILED'`.
   */
  async handleFileInteractionHook(
    input: FileInteractionHookInput,
  ): Promise<FileInteractionHookOutput> {
    const loaded = this.resolveLoadedConfig();
    return executeFileInteractionHook({
      workspaceRoot: this.workspaceRoot,
      config: loaded.config,
      input,
      nowMs: this.nowMs(),
    });
  }

  /**
   * Discovers, parses, and validates `memory.config.json` and pre-compiles `forbidRegexes` (§2.1).
   *
   * @returns {LoadedMemoryConfig} Validated configuration bundle.
   *
   * @throws {MemoryHarnessError} With `'CONFIG_NOT_FOUND'` or `'CONFIG_VALIDATION_FAILED'`.
   */
  private resolveLoadedConfig(): LoadedMemoryConfig {
    return loadMemoryConfig(this.workspaceRoot, this.configPath);
  }
}
