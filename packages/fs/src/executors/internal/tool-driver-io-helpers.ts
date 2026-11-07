import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ToolEffect, ToolExecutionResult } from '@harness-dsl/core';
import { createFsWriteEffect } from './create-fs-tool-effects.js';
import { enumerateWorkspaceFiles } from './enumerate-workspace-files.js';
import {
  checkPathsExistAtBaseRef,
  extractWorktreeRootAndBaseRef,
  resolveJailedWorktreePath,
} from './jail-and-glob-helpers.js';

/**
 * Searches workspace files matching `parsed.glob` against `parsed.pattern` and formats `path:line:text` matches.
 *
 * Enforces `resolveJailedWorktreePath` on every candidate file before reading.
 *
 * @param {unknown}                                                                       scopeHandle - Active isolation scope handle.
 * @param {{ readonly pattern: string; readonly glob?: string; readonly flags?: string }} parsed      - Validated grep arguments (`pattern`, optional `glob` and `flags`).
 *
 * @returns {Promise<string>} Newline-joined `path:lineNumber:lineText` match strings.
 */
export async function grepWorkspaceFiles(
  scopeHandle: unknown,
  parsed: { readonly pattern: string; readonly glob?: string; readonly flags?: string },
): Promise<string> {
  const { rootPath } = extractWorktreeRootAndBaseRef(scopeHandle);
  const candidateFiles = await enumerateWorkspaceFiles(rootPath, parsed.glob ?? '**/*');
  const regex = new RegExp(parsed.pattern, (parsed.flags ?? '').replace(/g/g, ''));
  const matches: string[] = [];
  for (const relPath of candidateFiles) {
    const { absolutePath } = resolveJailedWorktreePath(scopeHandle, relPath, false);
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

/**
 * Computes the synchronous pre-flight `FsToolEffect` write descriptor for `edit_file`.
 *
 * Populates `existingPathsAtBaseRef` and `proposedContent` after applying `oldString -> newString`.
 *
 * @param {unknown} scopeHandle - Active isolation scope handle.
 * @param {unknown} args        - Raw tool call arguments.
 *
 * @returns {readonly ToolEffect[]} Frozen single-element array containing the write `FsToolEffect`.
 */
export function describeFsEditEffects(
  scopeHandle: unknown,
  args: unknown,
): readonly ToolEffect[] {
  const rec =
    (args as { readonly path?: string; readonly oldString?: string; readonly newString?: string } | null | undefined) ?? {};
  const { normalizedRelPath, absolutePath } = resolveJailedWorktreePath(
    scopeHandle,
    rec.path ?? '',
    true,
  );
  const currentContent = existsSync(absolutePath) ? readFileSync(absolutePath, 'utf8') : '';
  const oldStr = rec.oldString ?? '';
  const newStr = rec.newString ?? '';
  const nextContent =
    oldStr.length > 0 && currentContent.includes(oldStr)
      ? currentContent.replace(oldStr, () => newStr)
      : `${currentContent}${newStr}`;
  const existingAtBase = checkPathsExistAtBaseRef(scopeHandle, [normalizedRelPath]);
  return Object.freeze([
    createFsWriteEffect([normalizedRelPath], existingAtBase, {
      [normalizedRelPath]: nextContent,
    }),
  ]);
}

/**
 * Executes a jailed `edit_file` string replacement inside `scopeHandle`.
 *
 * Verifies that `parsed.oldString` exists in the target file before writing the updated UTF-8 text.
 *
 * @param {unknown}                                                                           scopeHandle - Active isolation scope handle.
 * @param {{ readonly path: string; readonly oldString: string; readonly newString: string }} parsed      - Validated edit arguments (`path`, `oldString`, `newString`).
 *
 * @returns {Promise<ToolExecutionResult>} Frozen tool execution result.
 */
export async function executeFsEditOperation(
  scopeHandle: unknown,
  parsed: { readonly path: string; readonly oldString: string; readonly newString: string },
): Promise<ToolExecutionResult> {
  const { normalizedRelPath, absolutePath } = resolveJailedWorktreePath(
    scopeHandle,
    parsed.path,
    true,
  );
  const currentContent = await readFile(absolutePath, 'utf8');
  if (!currentContent.includes(parsed.oldString)) {
    throw new Error(
      `fs:edit failed on '${normalizedRelPath}': target oldString was not found in file.`,
    );
  }
  const updatedContent = currentContent.replace(parsed.oldString, () => parsed.newString);
  await writeFile(absolutePath, updatedContent, 'utf8');
  return Object.freeze<ToolExecutionResult>({ content: `Edited ${normalizedRelPath}` });
}

/**
 * Executes a jailed `write_file` operation inside `scopeHandle`.
 *
 * Creates parent directories if needed, re-verifies symlink jailing, and writes UTF-8 text.
 *
 * @param {unknown}                                             scopeHandle - Active isolation scope handle.
 * @param {{ readonly path: string; readonly content: string }} parsed      - Validated write arguments (`path`, `content`).
 *
 * @returns {Promise<ToolExecutionResult>} Frozen tool execution result.
 */
export async function executeFsWriteOperation(
  scopeHandle: unknown,
  parsed: { readonly path: string; readonly content: string },
): Promise<ToolExecutionResult> {
  const { normalizedRelPath, absolutePath } = resolveJailedWorktreePath(
    scopeHandle,
    parsed.path,
    true,
  );
  await mkdir(path.dirname(absolutePath), { recursive: true });
  resolveJailedWorktreePath(scopeHandle, normalizedRelPath, true);
  await writeFile(absolutePath, parsed.content, 'utf8');
  return Object.freeze<ToolExecutionResult>({ content: `Wrote ${normalizedRelPath}` });
}
