import type {
  GitCandidateComparisonToolNode,
  GitRefReaderToolNode,
  GitWorktreeHandle,
  StepExecutionContext,
  ToolExecutionResult,
} from '@harness-dsl/core';
import { runGitCommand } from './git-cli-runner.js';
import { runEvalCommandInSandboxedCandidate } from './git-tool-and-verifier-helpers.js';

/**
 * Resolves the git ref or commit SHA for a speculative candidate branch index.
 *
 * Prefers `refs/harness/candidates/<runId>/<branchIndex>` when pinned on the host repo, falling back to `candidateHandles`.
 *
 * @param {number}                                  branchIndex - Zero-based speculative candidate branch index.
 * @param {StepExecutionContext<GitWorktreeHandle>} ctx         - Active step execution context.
 *
 * @returns {Promise<string>} Resolved git ref or commit SHA for `branchIndex`.
 */
async function resolveCandidateBranchRef(
  branchIndex: number,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<string> {
  const pinnedRef = `refs/harness/candidates/${ctx.runId}/${String(branchIndex)}`;
  const check = await runGitCommand({
    cwd: ctx.scopeHandle.worktreePath,
    args: ['rev-parse', '--verify', pinnedRef],
    allowNonZeroExit: true,
  });
  if (check.exitCode === 0 && check.stdout.trim().length > 0) {
    return check.stdout.trim();
  }
  const handle = ctx.candidateHandles?.get(branchIndex);
  if (handle !== undefined) return handle.headRef ?? handle.baseRef;
  return pinnedRef;
}

/**
 * Dispatches a `GitRefReaderToolNode` invocation (`readRefFile`, `diffRefs`, `listRefFiles`) against the object store.
 *
 * Runs read-only `git show`, `git diff`, or `git ls-tree` inside `node.runner` concurrency slots.
 *
 * @param {GitRefReaderToolNode<GitWorktreeHandle>} node    - Ref-reader tool AST node.
 * @param {unknown}                                 rawArgs - Unvalidated tool input arguments.
 * @param {StepExecutionContext<GitWorktreeHandle>} ctx     - Active step execution context.
 *
 * @returns {Promise<ToolExecutionResult>} Serialized git output.
 */
export async function dispatchRefReaderToolCall(
  node: GitRefReaderToolNode<GitWorktreeHandle>,
  rawArgs: unknown,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<ToolExecutionResult> {
  const parsed = node.inputSchema.parse(rawArgs) as Record<string, unknown>;
  const cwd = ctx.scopeHandle.worktreePath;
  const runCmd = async (): Promise<ToolExecutionResult> => {
    if (node.name === 'readRefFile') {
      const res = await runGitCommand({ cwd, args: ['show', `${String(parsed['ref'])}:${String(parsed['path'])}`] });
      return { content: res.stdout };
    }
    if (node.name === 'diffRefs') {
      const paths = Array.isArray(parsed['paths']) ? (parsed['paths'] as string[]) : [];
      const args = ['diff', String(parsed['fromRef']), String(parsed['toRef']), ...(paths.length > 0 ? ['--', ...paths] : [])];
      const res = await runGitCommand({ cwd, args });
      return { content: res.stdout };
    }
    const prefix = typeof parsed['prefix'] === 'string' && parsed['prefix'].length > 0 ? parsed['prefix'] : undefined;
    const args = ['ls-tree', '-r', '--name-only', String(parsed['ref']), ...(prefix !== undefined ? ['--', prefix] : [])];
    const res = await runGitCommand({ cwd, args });
    return { content: res.stdout };
  };
  if (node.runner !== undefined && typeof ctx.getRunner === 'function') {
    return ctx.getRunner(node.runner).withSlot(runCmd, ctx.signal);
  }
  return runCmd();
}

/**
 * Dispatches a `GitCandidateComparisonToolNode` invocation (`diffCandidates`, `readCandidateFile`, `evalInCandidates`).
 *
 * Wraps `evalInCandidates` benchmark runs in `serializeCheckpoint` + `try / finally { restoreCheckpoint }`.
 *
 * @param {GitCandidateComparisonToolNode<GitWorktreeHandle>} node    - Candidate comparison tool AST node.
 * @param {unknown}                                           rawArgs - Unvalidated tool input arguments.
 * @param {StepExecutionContext<GitWorktreeHandle>}           ctx     - Active step execution context.
 *
 * @returns {Promise<ToolExecutionResult>} Serialized candidate comparison or benchmark output.
 */
export async function dispatchCandidateComparisonToolCall(
  node: GitCandidateComparisonToolNode<GitWorktreeHandle>,
  rawArgs: unknown,
  ctx: StepExecutionContext<GitWorktreeHandle>,
): Promise<ToolExecutionResult> {
  const parsed = node.inputSchema.parse(rawArgs) as Record<string, unknown>;
  const cwd = ctx.scopeHandle.worktreePath;
  const runCmd = async (): Promise<ToolExecutionResult> => {
    if (node.name === 'diffCandidates') {
      const leftRef = await resolveCandidateBranchRef(Number(parsed['fromBranchIndex']), ctx);
      const rightRef = await resolveCandidateBranchRef(Number(parsed['toBranchIndex']), ctx);
      const paths = Array.isArray(parsed['paths']) ? (parsed['paths'] as string[]) : [];
      const args = ['diff', leftRef, rightRef, ...(paths.length > 0 ? ['--', ...paths] : [])];
      return { content: (await runGitCommand({ cwd, args })).stdout };
    }
    if (node.name === 'readCandidateFile') {
      const ref = await resolveCandidateBranchRef(Number(parsed['branchIndex']), ctx);
      return { content: (await runGitCommand({ cwd, args: ['show', `${ref}:${String(parsed['path'])}`] })).stdout };
    }
    const branchIndices: readonly number[] = Array.isArray(parsed['branchIndices'])
      ? (parsed['branchIndices'] as number[])
      : typeof parsed['branchIndex'] === 'number' ? [parsed['branchIndex']] : ctx.candidateHandles !== undefined ? [...ctx.candidateHandles.keys()] : [0];
    const rawCmd = parsed['argv'] ?? parsed['command'];
    const command: string | readonly string[] = Array.isArray(rawCmd) ? (rawCmd as string[]) : String(rawCmd ?? '');
    const outcomes: Array<Record<string, unknown>> = [];
    for (const branchIndex of branchIndices) {
      const candidateHandle = ctx.candidateHandles?.get(branchIndex) ?? ctx.scopeHandle;
      const result = await runEvalCommandInSandboxedCandidate(candidateHandle, command, ctx);
      outcomes.push({ branchIndex, ...result });
    }
    return { content: JSON.stringify(outcomes) };
  };
  if (node.runner !== undefined && typeof ctx.getRunner === 'function') {
    return ctx.getRunner(node.runner).withSlot(runCmd, ctx.signal);
  }
  return runCmd();
}
