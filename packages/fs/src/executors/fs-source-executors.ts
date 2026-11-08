import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type {
  FsGlobSourceNode,
  FsTextSourceNode,
  ResolutionContext,
  ResolvedSourceArtifact,
} from '@paraharness/core';
import { enumerateWorkspaceFiles } from './internal/enumerate-workspace-files.js';
import { extractWorktreeRootAndBaseRef } from './internal/extract-worktree-root-and-base-ref.js';
import { resolveJailedWorktreePath } from './internal/resolve-jailed-worktree-path.js';

/**
 * Loads UTF-8 text and computes a SHA-256 hex digest for an `FsTextSourceNode` (`fs:text-source`).
 *
 * Resolves `node.path` against the immutable host repository root when `ctx.scopeHandle` is
 * omitted, or against `ctx.scopeHandle.worktreePath` when computing in-run grounding diffs (`SPEC.md` §4.3).
 *
 * @param {FsTextSourceNode}  node   - Passive text source AST node.
 * @param {void}              _input - Unused source executor input parameter.
 * @param {ResolutionContext} ctx    - Source resolution context with optional `scopeHandle`.
 *
 * @returns {Promise<ResolvedSourceArtifact<string>>} UTF-8 file text paired with its SHA-256 digest.
 */
export async function executeFsTextSource(
  node: FsTextSourceNode,
  _input: void,
  ctx: ResolutionContext,
): Promise<ResolvedSourceArtifact<string>> {
  const { absolutePath } = resolveJailedWorktreePath(ctx.scopeHandle, node.path, 'read');
  const content = await readFile(absolutePath, 'utf8');
  const digest = createHash('sha256').update(content, 'utf8').digest('hex');
  return Object.freeze<ResolvedSourceArtifact<string>>({
    content,
    digest,
  });
}

/**
 * Loads all UTF-8 files matching `node.pattern` in lexicographical order for an `FsGlobSourceNode` (`fs:glob-source`).
 *
 * Resolves against the host repository root when `ctx.scopeHandle` is omitted, or against
 * `ctx.scopeHandle.worktreePath` when computing in-run grounding diffs (`SPEC.md` §4.3).
 *
 * @param {FsGlobSourceNode}  node   - Passive glob source AST node.
 * @param {void}              _input - Unused source executor input parameter.
 * @param {ResolutionContext} ctx    - Source resolution context with optional `scopeHandle`.
 *
 * @returns {Promise<ResolvedSourceArtifact<ReadonlyArray<{ readonly path: string; readonly content: string }>>>} Matched `{ path, content }` records paired with their combined SHA-256 digest.
 */
export async function executeFsGlobSource(
  node: FsGlobSourceNode,
  _input: void,
  ctx: ResolutionContext,
): Promise<
  ResolvedSourceArtifact<ReadonlyArray<{ readonly path: string; readonly content: string }>>
> {
  const { rootPath } = extractWorktreeRootAndBaseRef(ctx.scopeHandle);
  const matchedRelPaths = await enumerateWorkspaceFiles(rootPath, node.pattern);
  const entries: Array<{ readonly path: string; readonly content: string }> = [];
  const hash = createHash('sha256');
  for (const relPath of matchedRelPaths) {
    const { absolutePath } = resolveJailedWorktreePath(ctx.scopeHandle, relPath, 'read');
    const content = await readFile(absolutePath, 'utf8');
    entries.push(Object.freeze({ path: relPath, content }));
    hash.update(`${relPath}\0${content}\0`, 'utf8');
  }
  return Object.freeze({
    content: Object.freeze(entries),
    digest: hash.digest('hex'),
  });
}
