import { readFile } from 'node:fs/promises';
import { enumerateWorkspaceFiles } from './enumerate-workspace-files.js';
import { extractWorktreeRootAndBaseRef } from './extract-worktree-root-and-base-ref.js';
import { resolveJailedWorktreePath } from './resolve-jailed-worktree-path.js';

/**
 * Validated grep arguments for {@link grepWorkspaceFiles}.
 */
export interface GrepWorkspaceFilesParams {
  /** Regular expression pattern string to search for. */
  readonly pattern: string;

  /** Optional POSIX glob filter for candidate files. */
  readonly glob?: string;

  /** Optional regular expression flags. */
  readonly flags?: string;
}

/**
 * Searches workspace files matching `params.glob` against `params.pattern` and formats `path:line:text` matches.
 *
 * Enforces `resolveJailedWorktreePath` on every candidate file before reading.
 *
 * @param {unknown}                  scopeHandle - Active isolation scope handle.
 * @param {GrepWorkspaceFilesParams} params      - Validated grep arguments (`pattern`, optional `glob` and `flags`).
 *
 * @returns {Promise<string>} Newline-joined `path:lineNumber:lineText` match strings.
 */
export async function grepWorkspaceFiles(
  scopeHandle: unknown,
  params: GrepWorkspaceFilesParams,
): Promise<string> {
  const { rootPath } = extractWorktreeRootAndBaseRef(scopeHandle);
  const candidateFiles = await enumerateWorkspaceFiles(rootPath, params.glob ?? '**/*');
  const regex = new RegExp(params.pattern, (params.flags ?? '').replace(/g/g, ''));
  const matches: string[] = [];
  for (const relPath of candidateFiles) {
    const { absolutePath } = resolveJailedWorktreePath(scopeHandle, relPath, 'read');
    const text = await readFile(absolutePath, 'utf8');
    const lines = text.split(/\r?\n/);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const line = lines[idx];
      if (line !== undefined && regex.test(line)) {
        matches.push(`${relPath}:${String(idx + 1)}:${line}`);
      }
    }
  }
  return matches.join('\n');
}
