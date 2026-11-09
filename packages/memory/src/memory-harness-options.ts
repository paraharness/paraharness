import type { MemoryDistillerRunner } from './memory-distiller-runner.js';

/**
 * Initialization options for `MemoryHarness`.
 */
export interface MemoryHarnessOptions {
  /** Absolute path to the repository workspace root. */
  readonly workspaceRoot: string;
  /** Optional explicit path to `memory.config.json` (overrides `.agents/` and `.claude/` discovery). */
  readonly configPath?: string;
  /** Optional injected Distiller runner (used for `'claude-cli'` or in-process `'subagent'` execution). */
  readonly distillerRunner?: MemoryDistillerRunner;
  /** Optional clock override returning current UTC epoch milliseconds (defaults to `Date.now`). */
  readonly nowMs?: () => number;
}
