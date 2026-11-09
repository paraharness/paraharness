/**
 * Handle to a real temporary workspace directory created by `createTempMemoryWorkspace`.
 */
export interface TempMemoryWorkspaceHandle {
  /** Absolute path to the temporary workspace root directory. */
  readonly workspaceRoot: string;
  /** Absolute path to `.agents/memory.config.json` inside the temporary workspace. */
  readonly agentsConfigPath: string;
  /** Absolute path to `.claude/memory.config.json` inside the temporary workspace. */
  readonly claudeConfigPath: string;
  /** Absolute path to `.memory/memory.jsonl` inside the temporary workspace. */
  readonly ledgerPath: string;
  /** Absolute path to `.memory/memory.meta.json` inside the temporary workspace. */
  readonly metaPath: string;
  /** Absolute path to `.memory/.session-state` inside the temporary workspace. */
  readonly sessionStateDir: string;

  /**
   * Writes a JSON configuration payload to `.agents/memory.config.json` (or `.claude/memory.config.json` when `location === 'claude'`).
   *
   * @param {Readonly<Record<string, unknown>>} configJson           - Raw configuration JSON object to serialize.
   * @param {'agents' | 'claude'}               [location='agents']  - Target config directory location.
   *
   * @returns {Promise<string>} Resolved absolute path of the written configuration file.
   */
  writeConfig(
    configJson: Readonly<Record<string, unknown>>,
    location?: 'agents' | 'claude',
  ): Promise<string>;

  /**
   * Writes a UTF-8 file at `relativePath` inside `workspaceRoot`, creating parent directories automatically.
   *
   * @param {string} relativePath - Workspace-relative POSIX file path.
   * @param {string} content      - UTF-8 file contents to write.
   *
   * @returns {Promise<string>} Resolved absolute path of the written file.
   */
  writeWorkspaceFile(relativePath: string, content: string): Promise<string>;

  /**
   * Recursively removes the temporary workspace directory.
   *
   * @returns {Promise<void>} Resolves once the temporary workspace directory has been removed.
   */
  cleanup(): Promise<void>;
}
