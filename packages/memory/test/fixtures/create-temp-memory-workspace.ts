import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TempMemoryWorkspaceHandle } from './temp-memory-workspace-handle.js';

/**
 * Initialization options for `createTempMemoryWorkspace`.
 */
export interface TempMemoryWorkspaceOptions {
  /** Optional raw configuration object written to `.agents/memory.config.json` (or `.claude/memory.config.json`). */
  readonly config?: Readonly<Record<string, unknown>> | null;
  /** Which discovery location to populate when `config` is provided (`defaults to 'agents'`). */
  readonly configLocation?: 'agents' | 'claude';
  /** Optional map of workspace-relative POSIX file paths to UTF-8 contents seeded on creation. */
  readonly files?: Readonly<Record<string, string>>;
}

/**
 * Creates a real temporary workspace directory on disk with optional `.agents/memory.config.json`
 * (or `.claude/memory.config.json`) and seeded workspace files.
 *
 * @param {TempMemoryWorkspaceOptions} [options={}] - Optional configuration and file seed settings.
 *
 * @returns {Promise<TempMemoryWorkspaceHandle>} Handle exposing helper paths, writers, and `cleanup()`.
 */
export async function createTempMemoryWorkspace(
  options: TempMemoryWorkspaceOptions = {},
): Promise<TempMemoryWorkspaceHandle> {
  const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'paraharness-memory-test-'));
  const agentsConfigPath = path.join(workspaceRoot, '.agents', 'memory.config.json');
  const claudeConfigPath = path.join(workspaceRoot, '.claude', 'memory.config.json');
  const ledgerPath = path.join(workspaceRoot, '.memory', 'memory.jsonl');
  const metaPath = path.join(workspaceRoot, '.memory', 'memory.meta.json');
  const sessionStateDir = path.join(workspaceRoot, '.memory', '.session-state');

  const writeConfig = async (
    configJson: Readonly<Record<string, unknown>>,
    location: 'agents' | 'claude' = 'agents',
  ): Promise<string> => {
    const targetPath = location === 'claude' ? claudeConfigPath : agentsConfigPath;
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, `${JSON.stringify(configJson, null, 2)}\n`, 'utf8');
    return targetPath;
  };

  const writeWorkspaceFile = async (relativePath: string, content: string): Promise<string> => {
    const fullPath = path.join(workspaceRoot, relativePath);
    await mkdir(path.dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
    return fullPath;
  };

  const cleanup = async (): Promise<void> => {
    await rm(workspaceRoot, { recursive: true, force: true });
  };

  if (options.config !== null) {
    const defaultConfig: Readonly<Record<string, unknown>> = options.config ?? {
      repoId: 'test-repo',
      allowedRoles: ['general', 'builder', 'reviewer', 'verifier', 'head'],
    };
    await writeConfig(defaultConfig, options.configLocation ?? 'agents');
  }

  if (options.files !== undefined) {
    for (const [relPath, fileContent] of Object.entries(options.files)) {
      await writeWorkspaceFile(relPath, fileContent);
    }
  }

  return Object.freeze<TempMemoryWorkspaceHandle>({
    workspaceRoot,
    agentsConfigPath,
    claudeConfigPath,
    ledgerPath,
    metaPath,
    sessionStateDir,
    writeConfig,
    writeWorkspaceFile,
    cleanup,
  });
}
